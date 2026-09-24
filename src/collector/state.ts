import { Database } from "bun:sqlite";
import type { IngestAccount, IngestUsage } from "../shared/ingest";
import {
  attribute,
  type AccountSegment,
  type HistoryBinding,
} from "./attribution";
import {
  UNATTRIBUTED_ACCOUNT_ID,
  unattributedAccount,
} from "./claude-code/account";
import type { QuotaSnapshot } from "./claude-code/quota";
import type { UsageFact } from "./claude-code/usage";

/**
 * 文件读取进度。offset 只推进到最后一个完整行之后；fingerprint 是 offset 之前一小段字节的摘要，
 * 文件被截断或原地重写时与之不符，采集器会从头重读。重读无害，因为事件按键去重。
 */
export interface FileCursor {
  identity: string;
  offset: number;
  fingerprint: string;
  mtimeMs: number;
}

/** 单个文件本轮读到的某个事件：首行时间与四桶合计最大的一行。 */
export interface FileObservation {
  key: string;
  firstTimestamp: string;
  total: number;
  fact: UsageFact;
}

export type OutboxKind = "usage" | "account" | "quota";

export interface OutboxItem<T> {
  seq: number;
  payload: T;
}

export interface UsageTotals {
  model: string;
  events: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

interface EventRow {
  key: string;
  occurred_at: string;
  total: number;
  account: string;
  observation: string;
}

const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  offset INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  mtime_ms REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  key TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  total INTEGER NOT NULL,
  account TEXT NOT NULL,
  observation TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_occurred_at ON events (occurred_at);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uuid TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (external_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (kind, item_id)
);
`;

/**
 * 采集器本地状态。outbox 每项只保留最新版本，seq 单调递增且不复用：
 * 推送成功只删除当时发送的 seq，推送期间写入的新版本保持待发送。
 */
export class CollectorState {
  readonly db: Database;
  private segmentCache: AccountSegment[] | null = null;
  private bindingCache: HistoryBinding | null | undefined;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    }
    this.db.exec(schema);
  }

  close() {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?",
      )
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  cursor(path: string): FileCursor | null {
    const row = this.db
      .query<
        {
          identity: string;
          offset: number;
          fingerprint: string;
          mtime_ms: number;
        },
        [string]
      >(
        "SELECT identity, offset, fingerprint, mtime_ms FROM files WHERE path = ?",
      )
      .get(path);
    return row
      ? {
          identity: row.identity,
          offset: row.offset,
          fingerprint: row.fingerprint,
          mtimeMs: row.mtime_ms,
        }
      : null;
  }

  cursors(): { path: string; offset: number }[] {
    return this.db
      .query<{ path: string; offset: number }, []>(
        "SELECT path, offset FROM files ORDER BY path",
      )
      .all();
  }

  /** 文件消失只清理读取进度；已记录的事件与待发送内容保留。 */
  forgetMissingFiles(present: ReadonlySet<string>): number {
    let removed = 0;
    const remove = this.db.query("DELETE FROM files WHERE path = ?");
    for (const { path } of this.cursors()) {
      if (!present.has(path)) {
        remove.run(path);
        removed += 1;
      }
    }
    return removed;
  }

  /** 事件合并与读取进度在同一事务提交，崩溃后不会出现进度前移而事件缺失。 */
  applyFile(
    path: string,
    cursor: FileCursor,
    observations: readonly FileObservation[],
  ): number {
    let changed = 0;
    this.db.transaction(() => {
      for (const observation of observations) {
        if (this.mergeObservation(observation)) changed += 1;
      }
      this.db
        .query(
          `INSERT INTO files (path, identity, offset, fingerprint, mtime_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET identity = excluded.identity, offset = excluded.offset,
             fingerprint = excluded.fingerprint, mtime_ms = excluded.mtime_ms`,
        )
        .run(
          path,
          cursor.identity,
          cursor.offset,
          cursor.fingerprint,
          cursor.mtimeMs,
        );
    })();
    return changed;
  }

  /**
   * 同一键只在四桶合计严格变大时替换所选行，不按字段取最大值；首次出现时间一经记录不再改变。
   * 全零事件也记录，以便后续真实行沿用首行时间，但不发送。
   */
  private mergeObservation(observation: FileObservation): boolean {
    const existing = this.db
      .query<EventRow, [string]>(
        "SELECT key, occurred_at, total, account, observation FROM events WHERE key = ?",
      )
      .get(observation.key);
    const serialized = JSON.stringify(observation.fact);
    if (!existing) {
      const account = attribute(
        observation.firstTimestamp,
        this.segments(),
        this.binding(),
      );
      this.db
        .query(
          "INSERT INTO events (key, occurred_at, total, account, observation) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          observation.key,
          observation.firstTimestamp,
          observation.total,
          account,
          serialized,
        );
      if (observation.total > 0) {
        this.enqueueUsage(
          observation.fact,
          observation.firstTimestamp,
          account,
        );
        return true;
      }
      return false;
    }
    if (observation.total <= existing.total) return false;
    this.db
      .query("UPDATE events SET total = ?, observation = ? WHERE key = ?")
      .run(observation.total, serialized, observation.key);
    this.enqueueUsage(observation.fact, existing.occurred_at, existing.account);
    return true;
  }

  private enqueueUsage(fact: UsageFact, occurredAt: string, account: string) {
    if (account === UNATTRIBUTED_ACCOUNT_ID) {
      this.upsertAccount(unattributedAccount);
    }
    const payload: IngestUsage = {
      externalId: fact.externalId,
      occurredAt,
      accountExternalId: account,
      model: fact.model,
      tier: fact.tier,
      tokens: fact.tokens,
      metadata: fact.metadata,
    };
    this.enqueue("usage", fact.externalId, payload);
  }

  private enqueue(kind: OutboxKind, itemId: string, payload: unknown) {
    this.db.transaction(() => {
      this.db
        .query("DELETE FROM outbox WHERE kind = ? AND item_id = ?")
        .run(kind, itemId);
      this.db
        .query("INSERT INTO outbox (kind, item_id, payload) VALUES (?, ?, ?)")
        .run(kind, itemId, JSON.stringify(payload));
    })();
  }

  /** 账户资料变化才进入待发送；返回是否有变化。 */
  upsertAccount(account: IngestAccount): boolean {
    const serialized = JSON.stringify(account);
    const existing = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM accounts WHERE external_id = ?",
      )
      .get(account.externalId);
    if (existing?.payload === serialized) return false;
    this.db
      .query(
        "INSERT INTO accounts (external_id, payload) VALUES (?, ?) ON CONFLICT (external_id) DO UPDATE SET payload = excluded.payload",
      )
      .run(account.externalId, serialized);
    this.enqueue("account", account.externalId, account);
    return true;
  }

  account(externalId: string): IngestAccount | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM accounts WHERE external_id = ?",
      )
      .get(externalId);
    return row ? (JSON.parse(row.payload) as IngestAccount) : null;
  }

  segments(): AccountSegment[] {
    this.segmentCache ??= this.db
      .query<AccountSegment, []>(
        "SELECT account_uuid AS accountUuid, first_seen AS firstSeen, last_seen AS lastSeen FROM timeline ORDER BY id",
      )
      .all();
    return this.segmentCache;
  }

  binding(): HistoryBinding | null {
    if (this.bindingCache === undefined) {
      const raw = this.getMeta("history_binding");
      this.bindingCache = raw ? (JSON.parse(raw) as HistoryBinding) : null;
    }
    return this.bindingCache;
  }

  /**
   * 记录一次运行时观察到的登录账户，返回需要重新归属的起点：
   * 同账户延长区间时，只有上次观察之后的事件可能改变归属。
   */
  observeAccount(accountUuid: string, now: string): string {
    const segments = this.segments();
    const last = segments.at(-1);
    this.segmentCache = null;
    if (last && last.accountUuid === accountUuid) {
      if (now > last.lastSeen) {
        this.db
          .query(
            "UPDATE timeline SET last_seen = ? WHERE id = (SELECT MAX(id) FROM timeline)",
          )
          .run(now);
      }
      return last.lastSeen;
    }
    this.db
      .query(
        "INSERT INTO timeline (account_uuid, first_seen, last_seen) VALUES (?, ?, ?)",
      )
      .run(accountUuid, now, now);
    return last?.lastSeen ?? now;
  }

  setBinding(binding: HistoryBinding) {
    this.setMeta("history_binding", JSON.stringify(binding));
    this.bindingCache = binding;
  }

  /** 按当前时间线重新计算归属；归属变化的非零事件重新进入待发送。since 为 null 时处理全部事件。 */
  reattribute(since: string | null): number {
    const segments = this.segments();
    const binding = this.binding();
    const rows =
      since === null
        ? this.db
            .query<EventRow, []>(
              "SELECT key, occurred_at, total, account, observation FROM events",
            )
            .all()
        : this.db
            .query<EventRow, [string]>(
              "SELECT key, occurred_at, total, account, observation FROM events WHERE occurred_at >= ?",
            )
            .all(since);
    let changed = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const account = attribute(row.occurred_at, segments, binding);
        if (account === row.account) continue;
        this.db
          .query("UPDATE events SET account = ? WHERE key = ?")
          .run(account, row.key);
        if (row.total > 0) {
          this.enqueueUsage(
            JSON.parse(row.observation) as UsageFact,
            row.occurred_at,
            account,
          );
          changed += 1;
        }
      }
    })();
    return changed;
  }

  /** 同一次上游采样只上报一次；每次采样各自保留，离线期间的历史采样不会被覆盖。 */
  /** 每个额度来源分别记住最近一次上报的内容，同一采样重复读取时不再入队。 */
  recordQuota(
    snapshot: QuotaSnapshot,
    source: "claude-json" | "statusline" = "claude-json",
  ): boolean {
    const metaKey =
      source === "claude-json"
        ? "last_quota_hash"
        : `last_quota_hash:${source}`;
    if (this.getMeta(metaKey) === snapshot.hash) return false;
    this.db.transaction(() => {
      for (const quota of snapshot.quotas) {
        this.enqueue(
          "quota",
          `${quota.accountExternalId}:${quota.window}:${quota.sampledAt}`,
          quota,
        );
      }
      this.setMeta(metaKey, snapshot.hash);
    })();
    return true;
  }

  pending<T>(kind: OutboxKind, limit: number): OutboxItem<T>[] {
    return this.db
      .query<{ seq: number; payload: string }, [string, number]>(
        "SELECT seq, payload FROM outbox WHERE kind = ? ORDER BY seq LIMIT ?",
      )
      .all(kind, limit)
      .map((row) => ({ seq: row.seq, payload: JSON.parse(row.payload) as T }));
  }

  pendingCounts(): Record<OutboxKind, number> {
    const counts: Record<OutboxKind, number> = {
      usage: 0,
      account: 0,
      quota: 0,
    };
    for (const row of this.db
      .query<{ kind: OutboxKind; count: number }, []>(
        "SELECT kind, COUNT(*) AS count FROM outbox GROUP BY kind",
      )
      .all()) {
      counts[row.kind] = row.count;
    }
    return counts;
  }

  /** 只确认实际发送的版本；同一条目若已有更新版本，其 seq 不同，不会被删除。 */
  acknowledge(seqs: readonly number[]) {
    const remove = this.db.query("DELETE FROM outbox WHERE seq = ?");
    this.db.transaction(() => {
      for (const seq of seqs) remove.run(seq);
    })();
  }

  /** 非零事件按模型汇总，供 scan 与 status 对账。 */
  usageTotals(): UsageTotals[] {
    return this.db
      .query<UsageTotals, []>(
        `SELECT json_extract(observation, '$.model') AS model,
           COUNT(*) AS events,
           COALESCE(SUM(json_extract(observation, '$.tokens.input')), 0) AS input,
           COALESCE(SUM(json_extract(observation, '$.tokens.output')), 0) AS output,
           COALESCE(SUM(json_extract(observation, '$.tokens.cacheRead')), 0) AS cacheRead,
           COALESCE(SUM(json_extract(observation, '$.tokens.cacheWrite')), 0) AS cacheWrite,
           COALESCE(SUM(json_extract(observation, '$.tokens.reasoning')), 0) AS reasoning
         FROM events WHERE total > 0 GROUP BY model ORDER BY model`,
      )
      .all();
  }

  eventsByAccount(): { account: string; events: number }[] {
    return this.db
      .query<{ account: string; events: number }, []>(
        "SELECT account, COUNT(*) AS events FROM events WHERE total > 0 GROUP BY account ORDER BY account",
      )
      .all();
  }
}
