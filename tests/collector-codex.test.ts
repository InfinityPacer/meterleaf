import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexEvent,
  codexSnapshot,
  emptyContext,
  readCodex,
} from "../src/collector/codex";
import { DEFAULT_CHANNEL_ACCOUNTS } from "../src/collector/channel-accounts";
import { SOURCE_START } from "../src/collector/config";
import { CollectorState } from "../src/collector/state";
import type { IngestUsage } from "../src/shared/ingest";

const temporary: string[] = [];
const opened: CollectorState[] = [];
const start = SOURCE_START;

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const meta = {
  type: "session_meta",
  payload: {
    id: "session-example",
    cwd: "/private/workspace",
    instructions: "private",
    model_provider: "openai",
  },
};
const model = {
  type: "turn_context",
  payload: { model: "gpt-5.5", effort: "high" },
};
function usage(n = 1) {
  const last = {
    input_tokens: 100,
    cached_input_tokens: 60,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120,
  };
  return {
    timestamp: `2026-10-02T10:00:${String(n).padStart(2, "0")}.000Z`,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: Object.fromEntries(
          Object.entries(last).map(([key, value]) => [key, value * n]),
        ),
      },
    },
  };
}
const lines = (...events: unknown[]) =>
  events.map((item) => JSON.stringify(item) + "\n").join("");
function context() {
  const ctx = emptyContext();
  codexEvent(meta, ctx);
  codexEvent(model, ctx);
  return ctx;
}

function quotaEvent(
  timestamp: string,
  plan: string | null,
  percent = 70,
): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: "codex",
        plan_type: plan,
        primary: {
          used_percent: percent,
          window_minutes: 10080,
          resets_at: Math.round(Date.parse("2026-10-15T00:00:00Z") / 1000),
        },
        secondary: {
          used_percent: 12,
          window_minutes: 300,
          resets_at: Math.round(Date.parse("2026-10-02T15:00:00Z") / 1000),
        },
        credits: { has_credits: true, balance: "62500" },
      },
    },
  };
}

function codexRoot() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-codex-reader-"));
  temporary.push(root);
  mkdirSync(join(root, "sessions"), { recursive: true });
  return root;
}
function openState() {
  const item = new CollectorState(":memory:");
  opened.push(item);
  return item;
}
function pendingUsage(item: CollectorState): Map<string, IngestUsage> {
  return new Map(
    item
      .pending<IngestUsage>("usage", 1000)
      .map((entry) => [entry.payload.externalId, entry.payload]),
  );
}
const read = async (item: CollectorState, root: string, maxBytes?: number) =>
  readCodex(
    item,
    { home: root, start, channelAccounts: DEFAULT_CHANNEL_ACCOUNTS },
    maxBytes,
  );

test("Codex reads per-request usage, separates cache and keeps reasoning inside output", () => {
  const ctx = context();
  const first = codexEvent(usage(1), ctx)!;
  const second = codexEvent(usage(2), ctx)!;
  expect(first.tokens).toEqual({
    input: 40,
    output: 20,
    cacheRead: 60,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: 5,
  });
  expect(second.tokens).toEqual(first.tokens);
  expect(second.externalId).not.toBe(first.externalId);
  expect(JSON.stringify(first)).not.toContain("private");
  expect(JSON.stringify(first)).not.toContain("session-example");
});

test("Codex carries the session provider and follows model changes", () => {
  const ctx = context();
  expect(ctx).toMatchObject({
    session: "session-example",
    provider: "openai",
  });
  codexEvent(usage(4), ctx);
  codexEvent({ type: "turn_context", payload: { model: "gpt-6-astra" } }, ctx);
  const next = codexEvent(usage(1), ctx)!;
  expect(next.model).toBe("gpt-6-astra");
  expect(next.tokens.input).toBe(40);
});

test("Codex ignores repeated rate-limit snapshots, including changed notification timestamps", () => {
  const ctx = context();
  codexEvent(usage(), ctx);
  const repeat = usage();
  repeat.timestamp = "2026-10-02T10:01:00Z";
  expect(codexEvent(repeat, ctx)).toBeNull();
});

test("Codex does not guess a missing model or inconsistent token counters", () => {
  expect(() => codexEvent(usage(), emptyContext())).toThrow(
    "missing_session_or_model",
  );
  const row = usage();
  row.payload.info.last_token_usage.cached_input_tokens = 101;
  expect(() => codexEvent(row, context())).toThrow("inconsistent");
});

test("Codex quota windows follow duration, not primary/secondary position", () => {
  const snapshot = codexSnapshot(
    quotaEvent("2026-10-02T12:00:00.000Z", "pro"),
  )!;
  expect(snapshot.plan).toBe("pro");
  expect(
    snapshot.quotas.map((bucket) => [bucket.window, bucket.percent]),
  ).toEqual([
    ["seven-day", 70],
    ["five-hour", 12],
  ]);
  expect(snapshot.quotas[0]!.sampledAt).toBe("2026-10-02T12:00:00.000Z");
  expect(JSON.stringify(snapshot)).not.toContain("62500");
});

test("Codex ignores model-scoped buckets and invalid percentages without guessing", () => {
  const row = quotaEvent("2026-10-02T12:00:00.000Z", "plus") as {
    payload: {
      rate_limits: {
        limit_id: string;
        primary: { used_percent: number };
        secondary: { used_percent: number; window_minutes: number };
      };
    };
  };
  row.payload.rate_limits.limit_id = "codex_other";
  expect(codexSnapshot(row)).toBeNull();
  row.payload.rate_limits.limit_id = "codex";
  row.payload.rate_limits.primary.used_percent = -1;
  row.payload.rate_limits.secondary.window_minutes = 15;
  expect(codexSnapshot(row)!.quotas).toEqual([]);
  expect(codexSnapshot({ ...row, timestamp: "bad" })).toBeNull();
});

test("openai channel usage routes to the codex account", async () => {
  const root = codexRoot();
  writeFileSync(
    join(root, "sessions", "rollout.jsonl"),
    lines(meta, model, usage()),
  );
  const item = openState();
  const report = await read(item, root);
  expect(report).toMatchObject({ read: 1, recorded: 1 });
  expect([...pendingUsage(item).values()][0]!.accountExternalId).toBe("codex");
  expect(item.account("codex")).toMatchObject({
    name: "Codex",
    platform: "openai",
    kind: "subscription",
    plan: null,
  });
});

test("an observed plan_type overrides the rule plan and the windows upload once", async () => {
  const root = codexRoot();
  writeFileSync(
    join(root, "sessions", "rollout.jsonl"),
    lines(meta, model, usage(), quotaEvent("2026-10-02T12:00:00.000Z", "plus")),
  );
  const item = openState();
  const report = await read(item, root);
  expect(item.account("codex")!.plan).toBe("plus");
  expect(report.quotas).toBe(2);
  expect(
    item
      .pending<{ accountExternalId: string; window: string }>("quota", 1000)
      .map((entry) => [entry.payload.accountExternalId, entry.payload.window]),
  ).toEqual([
    ["codex", "five-hour"],
    ["codex", "seven-day"],
  ]);
  // 补送账号信息与额度不消耗待发送的用量计数；重复读取不再入队。
  expect((await read(item, root)).quotas).toBe(0);
  expect(item.pending("quota", 1000)).toHaveLength(2);
});

test("go channel usage routes to the OpenCode Go account without quota or plan changes", async () => {
  const root = codexRoot();
  const goMeta = {
    type: "session_meta",
    payload: { id: "go-session", model_provider: "go" },
  };
  writeFileSync(
    join(root, "sessions", "go.jsonl"),
    lines(
      goMeta,
      model,
      usage(),
      quotaEvent("2026-10-02T12:00:00.000Z", "pro"),
    ),
  );
  const item = openState();
  const report = await read(item, root);
  expect(report).toMatchObject({ read: 2, recorded: 1, quotas: 0 });
  expect([...pendingUsage(item).values()][0]!.accountExternalId).toBe(
    "opencode-go",
  );
  expect(item.pending("quota", 1000)).toHaveLength(0);
  expect(item.account("opencode-go")!.plan).toBe("go");
});

test("bo channel and missing provider are skipped by channel and never billed", async () => {
  const root = codexRoot();
  const boMeta = {
    type: "session_meta",
    payload: { id: "bo-session", model_provider: "bo" },
  };
  writeFileSync(
    join(root, "sessions", "bo.jsonl"),
    lines(
      boMeta,
      model,
      usage(),
      quotaEvent("2026-10-02T12:00:00.000Z", "enterprise"),
    ),
  );
  writeFileSync(
    join(root, "sessions", "missing.jsonl"),
    lines(
      { type: "session_meta", payload: { id: "no-provider" } },
      model,
      usage(2),
    ),
  );
  const item = openState();
  const report = await read(item, root);
  expect(report).toMatchObject({ read: 3, recorded: 0, invalid: 0 });
  expect(report.skipped).toEqual({ bo: 2, "(缺失)": 1 });
  expect(item.pending("usage", 1000)).toHaveLength(0);
  // bo 会话的额度属于网关后面的账户，不能写入 codex。
  expect(item.pending("quota", 1000)).toHaveLength(0);
});

/** 旧记录的事件时间：起点之前的样本不会入账。 */
function oldUsage(n = 1) {
  const row = usage(n);
  row.timestamp = `2026-09-01T10:00:00.000Z`;
  return row;
}

test("usage and quota samples before the fixed start date are dropped", async () => {
  const root = codexRoot();
  const file = join(root, "sessions", "old.jsonl");
  writeFileSync(
    file,
    lines(
      meta,
      model,
      oldUsage(2),
      quotaEvent("2026-09-01T12:00:00.000Z", "pro"),
    ),
  );
  // 真实文件按归档时间组装，修改时间晚于起点，但记录本身更早。
  utimesSync(
    file,
    new Date("2026-10-03T00:00:00Z"),
    new Date("2026-10-03T00:00:00Z"),
  );
  const item = openState();
  const report = await read(item, root);
  expect(report.read).toBe(2);
  expect(report.recorded).toBe(0);
  expect(report.beforeStart).toBe(1);
  expect(item.pending("usage", 1000)).toHaveLength(0);
  expect(item.pending("quota", 1000)).toHaveLength(0);
  expect(item.sourcePendingCounts().codex).toBe(0);
});

test("a session read as .jsonl is not billed again after compression to .jsonl.zst", async () => {
  const root = codexRoot();
  const file = join(root, "sessions", "rollout.jsonl");
  writeFileSync(file, lines(meta, model, usage(), usage(2)));
  const item = openState();
  expect((await read(item, root)).recorded).toBe(2);
  const sent = pendingUsage(item);
  // Codex 会话写完后压缩：内容相同、路径换成压缩后缀。
  const compressed = Bun.zstdCompressSync(readFileSync(file));
  rmSync(file);
  writeFileSync(join(root, "sessions", "rollout.jsonl.zst"), compressed);
  const report = await read(item, root, 1);
  expect(report.read).toBe(2);
  expect(report.recorded).toBe(0);
  expect(pendingUsage(item)).toEqual(sent);
  expect(item.sourcePendingCounts().codex).toBe(2);
});

test("compressed backfill respects the budget and resumes across rounds", async () => {
  const root = codexRoot();
  const goMeta = {
    type: "session_meta",
    payload: { id: "go-session", model_provider: "go" },
  };
  writeFileSync(
    join(root, "sessions", "old.jsonl.zst"),
    Bun.zstdCompressSync(Buffer.from(lines(meta, model, usage()))),
  );
  writeFileSync(
    join(root, "sessions", "new.jsonl.zst"),
    Bun.zstdCompressSync(Buffer.from(lines(goMeta, model, usage(2)))),
  );
  const item = openState();
  // 最近修改的文件先读；预算只允许一个文件，其余顺延。
  const report = await read(item, root, 1);
  expect(report.filesRead).toBe(1);
  expect(report.deferred).toBe(true);
  expect(item.pending("usage", 1000)).toHaveLength(1);
  const continuing = await read(item, root, 1);
  expect(continuing.filesRead).toBe(1);
  expect(item.pending("usage", 1000)).toHaveLength(2);
});

test("quota samples newer than the previous observation are the only ones uploaded", async () => {
  const root = codexRoot();
  writeFileSync(
    join(root, "sessions", "new.jsonl"),
    lines(
      meta,
      model,
      usage(),
      quotaEvent("2026-10-06T12:00:00.000Z", "pro", 40),
    ),
  );
  utimesSync(
    join(root, "sessions", "new.jsonl"),
    new Date("2026-10-06T12:10:00Z"),
    new Date("2026-10-06T12:10:00Z"),
  );
  const item = openState();
  await read(item, root);
  const sent = item.pending("quota", 1000);
  // 修改时间更早的会话补采：其旧读数不覆盖新观察，也不因重读而重复入队。
  const older = join(root, "sessions", "old.jsonl");
  writeFileSync(
    older,
    lines(
      meta,
      model,
      usage(2),
      quotaEvent("2026-10-01T12:00:00.000Z", "pro", 20),
    ),
  );
  utimesSync(
    older,
    new Date("2026-10-04T00:00:00Z"),
    new Date("2026-10-04T00:00:00Z"),
  );
  expect((await read(item, root)).quotas).toBe(0);
  expect(item.pending("quota", 1000)).toEqual(sent);
  // 同账户同一窗口出现更新的采样时照常上传。
  writeFileSync(
    join(root, "sessions", "fresh.jsonl"),
    lines(
      meta,
      model,
      usage(3),
      quotaEvent("2026-10-07T12:00:00.000Z", "pro", 50),
    ),
  );
  utimesSync(
    join(root, "sessions", "fresh.jsonl"),
    new Date("2026-10-07T12:10:00Z"),
    new Date("2026-10-07T12:10:00Z"),
  );
  expect((await read(item, root)).quotas).toBe(2);
});

test("reattribute and requeueUsage only scan the event table, so channel accounts stay", async () => {
  const root = codexRoot();
  writeFileSync(
    join(root, "sessions", "rollout.jsonl"),
    lines(meta, model, usage()),
  );
  const item = openState();
  await read(item, root);
  expect(item.reattribute(null)).toBe(0);
  item.requeueUsage();
  expect([...pendingUsage(item).values()][0]!.accountExternalId).toBe("codex");
});

test("Codex only reads complete lines in live files and resumes after partial appends", async () => {
  const root = codexRoot();
  const file = join(root, "sessions", "rollout.jsonl");
  writeFileSync(file, lines(meta, model, usage()));
  const item = openState();
  const partial = JSON.stringify(usage(2));
  appendFileSync(file, partial.slice(0, 30));
  expect((await read(item, root)).recorded).toBe(1);
  appendFileSync(file, partial.slice(30) + "\n");
  expect((await read(item, root)).read).toBe(1);
  expect((await read(item, root)).read).toBe(0);
  expect(item.pending("usage", 1000)).toHaveLength(2);
});

test("malformed token records in one file do not block later sessions", async () => {
  const root = codexRoot();
  writeFileSync(
    join(root, "sessions", "a.jsonl"),
    lines(meta, model, usage()) + '{"token_count":bad}\n',
  );
  writeFileSync(
    join(root, "sessions", "b.jsonl"),
    lines(meta, model, usage(2)),
  );
  const item = openState();
  const report = await read(item, root);
  expect(report.invalid).toBe(1);
  // 同一会话里损坏行之后的完整请求照常入账。
  expect(item.pending("usage", 1000)).toHaveLength(2);
});

test("a quota-only session still creates the account, and the plan survives later rounds", async () => {
  const root = codexRoot();
  const file = join(root, "sessions", "quota-only.jsonl");
  writeFileSync(
    file,
    lines(meta, model, quotaEvent("2026-10-02T10:00:00Z", "plus")),
  );
  const item = openState();
  await read(item, root);
  expect(item.account("codex")?.plan).toBe("plus");
  expect(item.pending("quota", 100)).toHaveLength(2);
  // 下一轮只有新用量、没有套餐通知时沿用已观察到的套餐，不退回规则值。
  appendFileSync(file, lines(usage(1)));
  await read(item, root);
  expect(item.account("codex")?.plan).toBe("plus");
  expect([...pendingUsage(item).values()]).toHaveLength(1);
});

test("the newest sample wins across files regardless of file modification order", async () => {
  const root = codexRoot();
  const older = join(root, "sessions", "older-sample.jsonl");
  const newer = join(root, "sessions", "newer-sample.jsonl");
  writeFileSync(
    older,
    lines(meta, model, quotaEvent("2026-10-01T10:00:00Z", "plus", 10)),
  );
  writeFileSync(
    newer,
    lines(meta, model, quotaEvent("2026-10-06T10:00:00Z", "pro", 60)),
  );
  // 旧会话刚被改写，修改时间反而更晚。
  utimesSync(
    newer,
    new Date("2026-10-06T11:00:00Z"),
    new Date("2026-10-06T11:00:00Z"),
  );
  utimesSync(
    older,
    new Date("2026-10-07T11:00:00Z"),
    new Date("2026-10-07T11:00:00Z"),
  );
  const item = openState();
  await read(item, root);
  expect(item.account("codex")?.plan).toBe("pro");
  const weekly = item
    .pending<{ window: string; percent: number; sampledAt: string }>(
      "quota",
      100,
    )
    .map((entry) => entry.payload)
    .filter((quota) => quota.window === "seven-day");
  expect(weekly.at(-1)?.percent).toBe(60);
  expect(
    weekly.some(
      (quota) => quota.percent === 10 && quota.sampledAt > "2026-10-06",
    ),
  ).toBe(false);
});

test("a failure while recording quota rolls back the file so the retry restores it", async () => {
  const root = codexRoot();
  writeFileSync(
    join(root, "sessions", "retry.jsonl"),
    lines(meta, model, usage(1), quotaEvent("2026-10-02T10:01:00Z", "plus")),
  );
  const item = openState();
  const original = item.recordQuota.bind(item);
  item.recordQuota = () => {
    throw new Error("disk full");
  };
  await expect(read(item, root)).rejects.toThrow("disk full");
  expect(item.pending("usage", 100)).toHaveLength(0);
  item.recordQuota = original;
  await read(item, root);
  expect(item.pending("usage", 100)).toHaveLength(1);
  expect(item.pending("quota", 100)).toHaveLength(2);
});

test("a compressed file that does not fit the remaining budget waits for the next round", async () => {
  const root = codexRoot();
  const body = Buffer.from(lines(meta, model, usage(1)));
  for (const [name, at] of [
    ["first.jsonl.zst", "2026-10-03T00:00:00Z"],
    ["second.jsonl.zst", "2026-10-02T00:00:00Z"],
  ] as const) {
    const path = join(root, "sessions", name);
    writeFileSync(path, Bun.zstdCompressSync(body));
    utimesSync(path, new Date(at), new Date(at));
  }
  const item = openState();
  const first = await read(item, root, body.length + 1);
  expect(first.filesRead).toBe(1);
  expect(first.deferred).toBe(true);
  const second = await read(item, root, body.length + 1);
  expect(second.filesRead).toBe(1);
});

test("a deferred archive goes first next round even when a newer file never finishes", async () => {
  const root = codexRoot();
  const busy = join(root, "sessions", "busy.jsonl");
  writeFileSync(busy, '{"type":"partial'); // 没有换行，每轮都读不完
  utimesSync(
    busy,
    new Date("2026-10-04T00:00:00Z"),
    new Date("2026-10-04T00:00:00Z"),
  );
  const body = Buffer.from(lines(meta, model, usage(1)));
  const archive = join(root, "sessions", "archive.jsonl.zst");
  writeFileSync(archive, Bun.zstdCompressSync(body));
  utimesSync(
    archive,
    new Date("2026-10-03T00:00:00Z"),
    new Date("2026-10-03T00:00:00Z"),
  );
  const item = openState();
  const first = await read(item, root, body.length);
  expect(first.deferred).toBe(true);
  expect(pendingUsage(item).size).toBe(0);
  await read(item, root, body.length);
  expect(pendingUsage(item).size).toBe(1);
});

test("a plan saved by an earlier version as a bare name is kept", async () => {
  const root = codexRoot();
  writeFileSync(
    join(root, "sessions", "legacy.jsonl"),
    lines(meta, model, usage(1)),
  );
  const item = openState();
  item.setMeta("codex_plans", JSON.stringify({ codex: "pro" }));
  await read(item, root);
  expect(item.account("codex")?.plan).toBe("pro");
});
