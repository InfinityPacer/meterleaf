import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  DEFAULT_CHANNEL_ACCOUNTS,
  type ChannelAccountRule,
} from "../src/collector/channel-accounts";
import { readOpenCode } from "../src/collector/opencode";
import { SOURCE_START } from "../src/collector/config";
import { CollectorState } from "../src/collector/state";
import { createHash } from "node:crypto";
import type { IngestUsage } from "../src/shared/ingest";

const temporary: string[] = [];
const opened: CollectorState[] = [];
const minuteMs = 60_000;

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-opencode-"));
  temporary.push(root);
  const database = join(root, "opencode.db");
  const db = new Database(database, { create: true });
  db.exec(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  return { root, database, db };
}

function externalId(rowId: string) {
  return "opencode-" + createHash("sha256").update(rowId).digest("hex");
}

function assistantRow(
  db: Database,
  options: {
    id: string;
    completedAt: Date;
    updatedAfterMinutes?: number;
    provider?: string | null;
    model?: string;
    variant?: string | null;
    tokens?: Record<string, unknown>;
    withCompleted?: boolean;
  },
) {
  const { id, completedAt, updatedAfterMinutes = 0 } = options;
  const data: Record<string, unknown> = {
    agent: "build",
    model: {
      id: options.model ?? "glm-5.3-flash",
      ...(options.provider !== null
        ? { providerID: options.provider ?? "opencode-go" }
        : {}),
      ...(options.variant ? { variant: options.variant } : {}),
    },
    finish: "stop",
    cost: 0,
    tokens: options.tokens ?? {
      input: 1000,
      output: 200,
      reasoning: 50,
      cache: { read: 300, write: 0 },
    },
    time: {
      created: completedAt.getTime() - minuteMs,
      ...(options.withCompleted === false
        ? {}
        : { completed: completedAt.getTime() }),
    },
  };
  db.run(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, 'ses-x', 'assistant', ?, ?, ?, ?)",
    [
      id,
      completedAt.getTime() / minuteMs,
      completedAt.getTime(),
      completedAt.getTime() + updatedAfterMinutes * minuteMs,
      JSON.stringify(data),
    ],
  );
}

function item() {
  const fresh = new CollectorState(":memory:");
  opened.push(fresh);
  return fresh;
}
const read = (
  state: CollectorState,
  database: string,
  channelAccounts: readonly ChannelAccountRule[] = DEFAULT_CHANNEL_ACCOUNTS,
) => readOpenCode(state, { database, start: SOURCE_START, channelAccounts });
const byExternalId = (state: CollectorState) =>
  new Map(
    state
      .pending<IngestUsage>("usage", 1000)
      .map((entry) => [entry.payload.externalId, entry.payload]),
  );
const pendingUsage = (state: CollectorState) => [
  ...byExternalId(state).values(),
];

test("assistant messages become one request with output including reasoning", () => {
  const w = workspace();
  try {
    assistantRow(w.db, {
      id: "msg-a",
      completedAt: new Date("2026-10-05T10:00:00Z"),
    });
    w.db.close();
    const state = item();
    const report = read(state, w.database);
    expect(report).toMatchObject({ read: 1, recorded: 1, invalid: 0 });
    const usage = byExternalId(state).get(externalId("msg-a"))!;
    expect(usage.accountExternalId).toBe("opencode-go");
    expect(usage.model).toBe("glm-5.3-flash");
    expect(usage.occurredAt).toBe("2026-10-05T10:00:00.000Z");
    expect(usage.tokens).toEqual({
      input: 1000,
      output: 250,
      cacheRead: 300,
      cacheWrite: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: 50,
    });
    expect(usage.metadata).toEqual({
      origin: "opencode_local",
      reasoning_effort: null,
    });
    expect(JSON.stringify(usage)).not.toContain("ses-x");
    expect(JSON.stringify(usage)).not.toContain("ignored");
    // 账户资料随读取建立，未变时不重复入队。
    expect(state.account("opencode-go")).toMatchObject({
      name: "OpenCode Go",
      platform: "opencode-go",
      kind: "subscription",
      plan: "go",
    });
  } finally {
    w.db.close();
  }
});

test("missing token parts stay unknown instead of being completed to zero", () => {
  const w = workspace();
  try {
    const at = new Date("2026-10-05T10:10:00Z");
    assistantRow(w.db, {
      id: "msg-no-reasoning",
      completedAt: at,
      model: "model-a",
      tokens: {
        input: 100,
        output: 30,
        reasoning: null,
        cache: { read: 5, write: 0 },
      },
    });
    assistantRow(w.db, {
      id: "msg-no-visible",
      completedAt: at,
      model: "model-b",
      tokens: { input: 50, output: null, reasoning: 12, cache: { write: 0 } },
    });
    assistantRow(w.db, {
      id: "msg-no-input",
      completedAt: at,
      model: "model-c",
      tokens: { output: 9, reasoning: 0, cache: {} },
    });
    w.db.close();
    const state = item();
    expect(read(state, w.database).recorded).toBe(3);
    const usage = new Map(
      [...byExternalId(state).values()].map((entry) => [entry.model, entry]),
    );
    expect(usage.get("model-a")!.tokens).toMatchObject({
      input: 100,
      output: null,
      reasoning: null,
      cacheRead: 5,
      cacheWrite: 0,
    });
    expect(usage.get("model-b")!.tokens).toMatchObject({
      input: 50,
      output: null,
      reasoning: 12,
      cacheRead: null,
      cacheWrite: 0,
    });
    expect(usage.get("model-c")!.tokens).toMatchObject({
      input: null,
      output: 9,
      reasoning: 0,
      cacheRead: null,
      cacheWrite: null,
    });
  } finally {
    w.db.close();
  }
});

test("the model variant is recorded as reasoning effort, not as a pricing tier", () => {
  const w = workspace();
  try {
    assistantRow(w.db, {
      id: "msg-variant",
      completedAt: new Date("2026-10-05T10:20:00Z"),
      variant: "max",
    });
    w.db.close();
    const state = item();
    expect(read(state, w.database).recorded).toBe(1);
    const usage = byExternalId(state).get(externalId("msg-variant"))!;
    expect(usage.model).toBe("glm-5.3-flash");
    expect(usage.tier).toBeNull();
    expect(usage.metadata.reasoning_effort).toBe("max");
  } finally {
    w.db.close();
  }
});

test("unfinished assistant messages never become requests", () => {
  const w = workspace();
  try {
    assistantRow(w.db, {
      id: "msg-incomplete",
      completedAt: new Date("2026-10-05T11:00:00Z"),
      withCompleted: false,
    });
    w.db.close();
    const state = item();
    const report = read(state, w.database);
    expect(report).toMatchObject({ read: 0, recorded: 0 });
    expect(pendingUsage(state)).toHaveLength(0);
    expect(state.opencodeCursor()).toBeNull();
  } finally {
    w.db.close();
  }
});

test("free channels and missing providers are skipped and counted", () => {
  const w = workspace();
  try {
    const at = new Date("2026-10-05T12:00:00Z");
    assistantRow(w.db, {
      id: "msg-free",
      completedAt: at,
      provider: "opencode",
      model: "deepseek-v4.1-flash-free",
    });
    assistantRow(w.db, {
      id: "msg-no-provider",
      completedAt: new Date(at.getTime() + minuteMs),
      provider: null,
    });
    w.db.close();
    const state = item();
    const report = read(state, w.database);
    expect(report.read).toBe(2);
    expect(report.recorded).toBe(0);
    expect(report.skipped).toEqual({ opencode: 1, "(缺失)": 1 });
    expect(pendingUsage(state)).toHaveLength(0);
  } finally {
    w.db.close();
  }
});

test("custom channelAccounts replace the built-in defaults entirely", () => {
  const w = workspace();
  try {
    const at = new Date("2026-10-05T13:00:00Z");
    assistantRow(w.db, { id: "msg-go", completedAt: at });
    assistantRow(w.db, {
      id: "msg-enterprise",
      completedAt: new Date(at.getTime() + minuteMs),
      provider: "enterprise",
      model: "kimi-k3",
    });
    w.db.close();
    const state = item();
    const report = read(state, w.database, [
      {
        source: "opencode",
        channel: "enterprise",
        id: "kimi",
        name: "Kimi",
        platform: "moonshot",
        kind: "api",
        plan: null,
      },
    ]);
    // 未配置 opencode-go 规则时默认通道整体被替代，不再入账。
    expect(report.recorded).toBe(1);
    const [usage] = [...byExternalId(state).values()];
    expect(usage!.accountExternalId).toBe("kimi");
    expect(state.account("kimi")).toMatchObject({
      name: "Kimi",
      platform: "moonshot",
      kind: "api",
    });
  } finally {
    w.db.close();
  }
});

test("messages completed before the fixed start are dropped", () => {
  const w = workspace();
  try {
    assistantRow(w.db, {
      id: "msg-old",
      completedAt: new Date("2026-08-01T00:00:00Z"),
    });
    w.db.close();
    const state = item();
    const report = read(state, w.database);
    expect(report.read).toBe(1);
    expect(report.recorded).toBe(0);
    expect(pendingUsage(state)).toHaveLength(0);
    // 游标照常推进，避免每轮重复扫描旧记录。
    expect(state.opencodeCursor()).toBe(Date.parse("2026-08-01T00:00:00Z"));
  } finally {
    w.db.close();
  }
});

test("overlapped cursor runs deduplicate through external ids", () => {
  const w = workspace();
  try {
    const at = new Date("2026-10-05T14:00:00Z");
    assistantRow(w.db, { id: "msg-1", completedAt: at });
    assistantRow(w.db, {
      id: "msg-2",
      completedAt: new Date(at.getTime() + minuteMs),
      tokens: {
        input: 2,
        output: 4,
        reasoning: 1,
        cache: { read: 0, write: 0 },
      },
    });
    w.db.close();
    const state = item();
    const first = read(state, w.database);
    expect(first.recorded).toBe(2);
    // 回看覆盖到上一游标之前，已完成读过的行不重复入账。
    const second = read(state, w.database);
    // 回看窗口从上一游标减 10 分钟起，已读过的行靠唯一标识去重。
    expect(second.fromCursor).toBe(at.getTime() + minuteMs - 10 * minuteMs);
    expect(second.recorded).toBe(0);
    expect(byExternalId(state).size).toBe(2);
    expect(state.opencodeCursor()).toBe(at.getTime() + minuteMs);
    // 新增行按增量读取，游标与入账同时推进。
    const db = new Database(w.database, { create: true });
    try {
      assistantRow(db, {
        id: "msg-3",
        completedAt: new Date(at.getTime() + 2 * minuteMs),
      });
    } finally {
      db.close();
    }
    const third = read(state, w.database);
    expect(third.recorded).toBe(1);
    expect(state.pending("usage", 1000)).toHaveLength(3);
    expect(state.opencodeCursor()).toBe(at.getTime() + 2 * minuteMs);
  } finally {
    w.db.close();
  }
});

test("a failure inside the reader transaction rolls the round back entirely", () => {
  const w = workspace();
  try {
    const at = new Date("2026-10-05T15:00:00Z");
    assistantRow(w.db, { id: "msg-1", completedAt: at });
    assistantRow(w.db, {
      id: "msg-2",
      completedAt: new Date(at.getTime() + minuteMs),
    });
    w.db.close();
    const state = item();
    // 用第二条的入队失败模拟同步中途被打断。
    state.db.exec(
      `CREATE TRIGGER fail_usage BEFORE INSERT ON outbox
       WHEN NEW.item_id = '${externalId("msg-2")}'
       BEGIN SELECT RAISE(ABORT, 'planned-failure'); END`,
    );
    expect(() => read(state, w.database)).toThrow("planned-failure");
    state.db.exec("DROP TRIGGER fail_usage");
    expect(pendingUsage(state)).toHaveLength(0);
    expect(state.sourcePendingCounts().opencode).toBe(0);
    expect(state.opencodeCursor()).toBeNull();
    // 整体回滚后重跑一次，结果与直接成功完全一致。
    expect(read(state, w.database).recorded).toBe(2);
    expect(byExternalId(state).size).toBe(2);
    expect(state.opencodeCursor()).toBe(at.getTime() + minuteMs);
  } finally {
    w.db.close();
  }
});

test("state advanced by a previous run keeps channel accounts when reattributing", () => {
  const w = workspace();
  try {
    assistantRow(w.db, {
      id: "msg-a",
      completedAt: new Date("2026-10-05T16:00:00Z"),
    });
    w.db.close();
    const state = item();
    expect(read(state, w.database).recorded).toBe(1);
    // 新来源不进入事件表，重新归属和重发不会改写其账户。
    expect(state.reattribute(null)).toBe(0);
    state.requeueUsage();
    const usage = byExternalId(state).get(externalId("msg-a"))!;
    expect(usage.accountExternalId).toBe("opencode-go");
    // 已入账的用量不会重复计入。
    expect(
      state.recordSourceUsage("opencode", {
        externalId: externalId("msg-a"),
        occurredAt: usage.occurredAt,
        accountExternalId: usage.accountExternalId,
        model: usage.model,
        tier: null,
        tokens: usage.tokens,
        metadata: {},
      }),
    ).toBe(false);
  } finally {
    w.db.close();
  }
});
