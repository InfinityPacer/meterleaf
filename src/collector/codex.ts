import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ingestUsageSchema,
  ingestQuotaSchema,
  type IngestBatch,
  type IngestQuota,
  type IngestUsage,
} from "../shared/ingest";
import type { CollectorConfig } from "./config";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");

export interface CodexContext {
  session: string;
  model: string;
  effort: string | null;
  total: string | null;
  discarding?: boolean;
}

export function emptyContext(): CodexContext {
  return { session: "", model: "", effort: null, total: null };
}

function token(tokens: RecordValue, key: string): number | null {
  const value = tokens[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid_token_count");
  }
  return value;
}

/** Quota notifications are independent of token usage, including info:null and repeated totals. */
export function codexSnapshot(
  raw: unknown,
): { sampledAt: string; plan: string | null; quotas: IngestQuota[] } | null {
  const event = object(raw);
  const payload = object(event?.payload);
  if (event?.type !== "event_msg" || payload?.type !== "token_count")
    return null;
  const limits = object(payload.rate_limits);
  if (!limits || (limits.limit_id != null && limits.limit_id !== "codex"))
    return null;
  if (
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp))
  )
    return null;
  const sampledAt = new Date(event.timestamp).toISOString();
  const plan =
    typeof limits.plan_type === "string" &&
    limits.plan_type !== "unknown" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(limits.plan_type)
      ? limits.plan_type
      : null;
  const quotas: IngestQuota[] = [];
  for (const name of ["primary", "secondary"]) {
    const bucket = object(limits[name]);
    if (!bucket) continue;
    const minutes = bucket.window_minutes;
    const window =
      minutes === 300 ? "five-hour" : minutes === 10080 ? "seven-day" : null;
    if (!window) continue;
    const reset =
      typeof bucket.resets_at === "number" &&
      Number.isSafeInteger(bucket.resets_at) &&
      bucket.resets_at > 0 &&
      bucket.resets_at < 8640000000000
        ? new Date(bucket.resets_at * 1000).toISOString()
        : null;
    const parsed = ingestQuotaSchema.safeParse({
      accountExternalId: "codex-local",
      window,
      percent: bucket.used_percent,
      sampledAt,
      resetsAt: reset,
      windowMinutes: minutes,
    });
    if (parsed.success && reset) quotas.push(parsed.data);
  }
  return plan || quotas.length ? { sampledAt, plan, quotas } : null;
}

/** Only inspect session identity, model context and token events, never message bodies. */
export function codexEvent(
  raw: unknown,
  context: CodexContext,
): IngestUsage | null {
  const event = object(raw);
  const payload = object(event?.payload);
  if (!event || !payload) return null;
  if (event.type === "session_meta") {
    if (typeof payload.id === "string") context.session = payload.id;
    return null;
  }
  if (event.type === "turn_context") {
    context.model = typeof payload.model === "string" ? payload.model : "";
    context.effort =
      typeof payload.effort === "string" && payload.effort.length <= 32
        ? payload.effort
        : null;
    return null;
  }
  if (event.type !== "event_msg" || payload.type !== "token_count") return null;
  const info = object(payload.info);
  const last = object(info?.last_token_usage);
  if (!last) return null;
  const total = object(info?.total_token_usage);
  const fields = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ];
  // Rate-limit-only notifications repeat the cumulative counters. Do not turn them into requests.
  const signature = total
    ? JSON.stringify(fields.map((key) => token(total, key)))
    : null;
  if (signature && signature === context.total) return null;
  if (!context.session || !context.model)
    throw new Error("missing_session_or_model");
  const input = token(last, "input_tokens");
  const cached = token(last, "cached_input_tokens");
  const write = token(last, "cache_write_input_tokens");
  const output = token(last, "output_tokens");
  const reasoning = token(last, "reasoning_output_tokens");
  // Older Codex logs omit cache-write usage; keep it unknown without subtracting a guessed amount.
  const uncached =
    input !== null && cached !== null ? input - cached - (write ?? 0) : null;
  if (
    (uncached !== null && uncached < 0) ||
    (reasoning !== null && output !== null && reasoning > output)
  ) {
    throw new Error("inconsistent_token_breakdown");
  }
  if (
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp))
  ) {
    throw new Error("invalid_timestamp");
  }
  const usage = ingestUsageSchema.parse({
    externalId:
      "codex-" +
      hash(
        JSON.stringify([
          context.session,
          event.timestamp,
          fields.map((key) => token(last, key)),
          signature,
        ]),
      ),
    occurredAt: new Date(event.timestamp).toISOString(),
    accountExternalId: "codex-local",
    model: context.model,
    tier: null,
    tokens: {
      input: uncached,
      output,
      cacheRead: cached,
      cacheWrite: write,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning,
    },
    metadata: { origin: "codex_local", reasoning_effort: context.effort },
  });
  context.total = signature;
  return usage;
}

interface FileState {
  offset: number;
  inode: string;
  tail: string;
  context: string;
  size: number;
  modified: number;
}
interface Pending {
  id: string;
  payload: string;
}
interface SnapshotRow {
  key: string;
  sampled_at: string;
  payload: string;
  sent: number;
}

export class CodexCollector {
  readonly db: Database;
  constructor(stateFile: string) {
    this.db = new Database(stateFile, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, offset INTEGER, inode TEXT, tail TEXT, context TEXT, size INTEGER, modified REAL);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS snapshots(key TEXT PRIMARY KEY, sampled_at TEXT NOT NULL, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS diagnostics(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // Replay old offsets once to discover metadata that older collectors never parsed.
    // Stable usage IDs and sent flags remain untouched; replay still uses the 64 MiB budget.
    this.db.transaction(() => {
      if (
        !this.db
          .query("SELECT 1 FROM diagnostics WHERE key='quota_reader_v1'")
          .get()
      ) {
        this.db.exec("DELETE FROM files");
        this.db
          .query("INSERT INTO diagnostics VALUES ('quota_reader_v1','1')")
          .run();
      }
    })();
  }

  private saveSnapshot(raw: unknown) {
    const snapshot = codexSnapshot(raw);
    if (!snapshot) return;
    const rows: [string, unknown][] = snapshot.quotas.map((quota) => [
      quota.window,
      quota,
    ]);
    if (snapshot.plan) rows.push(["plan", snapshot.plan]);
    const save = this.db
      .query(`INSERT INTO snapshots(key,sampled_at,payload,sent) VALUES (?,?,?,0)
      ON CONFLICT(key) DO UPDATE SET sampled_at=excluded.sampled_at,payload=excluded.payload,sent=0
      WHERE excluded.sampled_at > snapshots.sampled_at`);
    for (const [key, payload] of rows)
      save.run(key, snapshot.sampledAt, JSON.stringify(payload));
  }

  scanFile(
    path: string,
    maxBytes = Number.POSITIVE_INFINITY,
  ): { bytes: number; events: number; invalid: number } {
    const stats = statSync(path);
    const saved = this.db
      .query<FileState, [string]>(
        "SELECT offset,inode,tail,context,size,modified FROM files WHERE path=?",
      )
      .get(path);
    if (
      saved &&
      saved.offset === stats.size &&
      saved.inode === String(stats.ino) &&
      saved.size === stats.size &&
      saved.modified === stats.mtimeMs
    ) {
      return { bytes: 0, events: 0, invalid: 0 };
    }
    const fd = openSync(path, "r");
    const tailAt = (offset: number) => {
      const size = Math.min(offset, 256);
      const bytes = Buffer.alloc(size);
      const n = readSync(fd, bytes, 0, size, offset - size);
      return hash(bytes.subarray(0, n));
    };
    try {
      const resume =
        saved &&
        saved.inode === String(stats.ino) &&
        saved.offset <= stats.size &&
        saved.tail === tailAt(saved.offset);
      let offset = resume ? saved.offset : 0;
      const context: CodexContext = resume
        ? JSON.parse(saved.context)
        : emptyContext();
      const initial = offset;
      const limit = Math.min(stats.size, initial + maxBytes);
      let position = offset;
      let fragment = Buffer.alloc(0);
      let oversized = context.discarding ?? false;
      let events = 0;
      let invalid = 0;
      const block = Buffer.alloc(1024 * 1024);
      const insert = this.db.query(
        "INSERT OR IGNORE INTO usage(id,payload) VALUES (?,?)",
      );
      this.db.transaction(() => {
        while (position < limit) {
          const n = readSync(
            fd,
            block,
            0,
            Math.min(block.length, limit - position),
            position,
          );
          if (!n) break;
          let start = 0;
          for (
            let end = block.indexOf(10, start);
            end >= 0 && end < n;
            end = block.indexOf(10, start)
          ) {
            if (!oversized) {
              const line = Buffer.concat([
                fragment,
                block.subarray(start, end),
              ]).toString("utf8");
              if (/"(?:session_meta|turn_context|token_count)"/.test(line)) {
                try {
                  const raw: unknown = JSON.parse(line);
                  this.saveSnapshot(raw);
                  const usage = codexEvent(raw, context);
                  if (usage)
                    events += insert.run(
                      usage.externalId,
                      JSON.stringify(usage),
                    ).changes;
                } catch {
                  invalid++;
                }
              }
            }
            fragment = Buffer.alloc(0);
            oversized = false;
            offset = position + end + 1;
            start = end + 1;
          }
          if (!oversized)
            fragment = Buffer.concat([fragment, block.subarray(start, n)]);
          if (fragment.length > 16 * 1024 * 1024) {
            fragment = Buffer.alloc(0);
            oversized = true;
            invalid++;
          }
          position += n;
        }
        // Skip oversized message lines across bounded cycles without retaining their content.
        context.discarding = oversized;
        if (oversized) offset = position;
        // Persist only complete lines: a writer may still be appending the last JSON record.
        this.db
          .query("INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?)")
          .run(
            path,
            offset,
            String(stats.ino),
            tailAt(offset),
            JSON.stringify(context),
            stats.size,
            stats.mtimeMs,
          );
      })();
      return { bytes: position - initial, events, invalid };
    } finally {
      closeSync(fd);
    }
  }

  async scan(root: string, maxBytes = 64 * 1024 * 1024) {
    const report = {
      files: 0,
      bytes: 0,
      events: 0,
      invalid: 0,
      unreadable: 0,
      deferred: false,
    };
    const paths: { path: string; modified: number }[] = [];
    for (const directory of ["sessions", "archived_sessions"]) {
      const cwd = join(root, directory);
      if (!existsSync(cwd)) continue;
      for await (const file of new Bun.Glob("**/*.jsonl").scan({
        cwd,
        followSymlinks: false,
      })) {
        try {
          paths.push({
            path: join(cwd, file),
            modified: statSync(join(cwd, file)).mtimeMs,
          });
        } catch {
          report.unreadable++;
        }
      }
    }
    paths.sort(
      (a, b) => b.modified - a.modified || a.path.localeCompare(b.path),
    );
    for (const { path } of paths) {
      if (report.bytes >= maxBytes) {
        report.deferred = true;
        break;
      }
      try {
        const result = this.scanFile(path, maxBytes - report.bytes);
        report.files++;
        report.bytes += result.bytes;
        report.events += result.events;
        report.invalid += result.invalid;
      } catch {
        report.unreadable++;
      }
    }
    return report;
  }

  async push(
    config: CollectorConfig,
    send: (batch: IngestBatch) => Promise<unknown> = async (batch) => {
      const response = await fetch(config.server + "/api/ingest/v1/batches", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`ingest_http_${response.status}`);
      return response.json();
    },
  ) {
    let sent = 0;
    while (true) {
      const rows = this.db
        .query<Pending, []>(
          "SELECT id,payload FROM usage WHERE sent=0 ORDER BY rowid LIMIT 500",
        )
        .all();
      const snapshots = this.db
        .query<SnapshotRow, []>("SELECT * FROM snapshots WHERE sent=0")
        .all();
      if (!rows.length && !snapshots.length) break;
      const planRow = this.db
        .query<SnapshotRow, []>("SELECT * FROM snapshots WHERE key='plan'")
        .get();
      const plan: string | null = planRow ? JSON.parse(planRow.payload) : null;
      const quotas: IngestQuota[] = snapshots
        .filter((row) => row.key !== "plan")
        .map((row) => JSON.parse(row.payload));
      const batch: IngestBatch = {
        schemaVersion: 1,
        sourceId: config.sourceId,
        batchId: crypto.randomUUID(),
        collector: { name: "meterleaf-codex-collector", version: "0.2.0" },
        accounts: [
          {
            externalId: "codex-local",
            name: "Codex 本机",
            platform: "openai",
            kind: plan ? "subscription" : "unknown",
            plan,
            subjectKey: null,
          },
        ],
        usage: rows.map((row) => JSON.parse(row.payload)),
        quotas,
      };
      const result = object(await send(batch));
      const accepted = object(result?.accepted);
      if (
        result?.batchId !== batch.batchId ||
        accepted?.usage !== rows.length ||
        accepted?.accounts !== 1 ||
        accepted?.quotas !== quotas.length
      ) {
        throw new Error("invalid_ingest_acknowledgement");
      }
      this.db.transaction(() => {
        const update = this.db.query("UPDATE usage SET sent=1 WHERE id=?");
        for (const row of rows) update.run(row.id);
        const mark = this.db.query(
          "UPDATE snapshots SET sent=1 WHERE key=? AND sampled_at=? AND payload=?",
        );
        for (const row of snapshots)
          mark.run(row.key, row.sampled_at, row.payload);
        this.db
          .query("INSERT OR REPLACE INTO diagnostics VALUES ('last_success',?)")
          .run(new Date().toISOString());
      })();
      sent += rows.length;
    }
    return sent;
  }

  status() {
    const plan = this.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM snapshots WHERE key='plan'",
      )
      .get();
    return {
      files: this.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM files")
        .get()!.n,
      events: this.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM usage")
        .get()!.n,
      pending: this.db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM usage WHERE sent=0",
        )
        .get()!.n,
      pendingSnapshots: this.db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM snapshots WHERE sent=0",
        )
        .get()!.n,
      plan: plan ? (JSON.parse(plan.payload) as string) : null,
      lastSuccess:
        this.db
          .query<{ value: string }, []>(
            "SELECT value FROM diagnostics WHERE key='last_success'",
          )
          .get()?.value ?? null,
    };
  }
}
