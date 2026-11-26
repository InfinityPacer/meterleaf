import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, emptyReport, ingestFile } from "../src/collector/collect";
import { UNATTRIBUTED_ACCOUNT_ID } from "../src/collector/claude-code/account";
import type { CollectorConfig } from "../src/collector/config";
import { pushOutbox, UNATTRIBUTED_HOLD_MS } from "../src/collector/push";
import { CollectorState, type FileObservation } from "../src/collector/state";
import {
  INGEST_BATCHES_PATH,
  INGEST_MAX_USAGE,
  ingestBatchSchema,
  ingestUsageSchema,
  type IngestBatch,
} from "../src/shared/ingest";
import { OTEL_LOGS_PATH } from "../src/shared/otel";
import {
  assistantLine,
  FIXTURE_ACCOUNT_UUID,
  type AssistantLineOptions,
} from "./fixtures/claude-code/lines";
import { parseLine } from "../src/collector/claude-code/usage";

const fixtureRoot = join(import.meta.dir, "fixtures/claude-code");
const sources = {
  projectsDir: join(fixtureRoot, "projects"),
  claudeJson: join(fixtureRoot, "claude.json"),
};
const key = "mlk_test-key-not-a-secret";

interface FakeServer {
  url: string;
  batches: IngestBatch[];
  bodies: string[];
  otelBodies: string[];
  stop: () => void;
}

const servers: FakeServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function fakeServer(status = 200): FakeServer {
  const batches: IngestBatch[] = [];
  const bodies: string[] = [];
  const otelBodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        (url.pathname !== INGEST_BATCHES_PATH &&
          url.pathname !== OTEL_LOGS_PATH)
      ) {
        return new Response("not found", { status: 404 });
      }
      if (request.headers.get("authorization") !== `Bearer ${key}`) {
        return Response.json({ error: "invalid key" }, { status: 401 });
      }
      if (status !== 200) return new Response("unavailable", { status });
      const body = await request.text();
      if (url.pathname === OTEL_LOGS_PATH) {
        otelBodies.push(body);
        return Response.json({ accepted: true });
      }
      const parsed = ingestBatchSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        return Response.json({ error: parsed.error.message }, { status: 400 });
      }
      bodies.push(body);
      batches.push(parsed.data);
      return Response.json({
        batchId: parsed.data.batchId,
        accepted: {
          usage: parsed.data.usage.length,
          accounts: parsed.data.accounts.length,
          quotas: parsed.data.quotas.length,
        },
      });
    },
  });
  const fake = {
    url: `http://127.0.0.1:${server.port}`,
    batches,
    bodies,
    otelBodies,
    stop: () => server.stop(true),
  };
  servers.push(fake);
  return fake;
}

function config(server: string, overrides: Partial<CollectorConfig> = {}) {
  return {
    server,
    sourceId: "claude-code-test",
    key,
    createdAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function fixtureState() {
  const state = new CollectorState(":memory:");
  collect(state, sources, new Date("2026-09-01T11:00:00Z"));
  return state;
}

describe("推送", () => {
  test("成功后清空待发送，批次通过协议校验且账户随批附带", async () => {
    const server = fakeServer();
    const state = fixtureState();
    const result = await pushOutbox(state, config(server.url));
    expect(result.error).toBeNull();
    expect(result.usage).toBe(5);
    expect(result.quotas).toBe(2);
    expect(state.pendingCounts()).toEqual({
      usage: 0,
      account: 0,
      quota: 0,
      otel: 0,
      scope: 0,
    });
    const batch = server.batches[0]!;
    expect(batch.collector.name).toBe("meterleaf-collector");
    const accountIds = new Set(batch.accounts.map((a) => a.externalId));
    for (const usage of batch.usage) {
      expect(accountIds.has(usage.accountExternalId)).toBe(true);
    }
    state.close();
  });

  test("推送内容不含路径、工作目录、对话或身份信息", async () => {
    const server = fakeServer();
    const state = fixtureState();
    await pushOutbox(state, config(server.url));
    const body = server.bodies.join("\n");
    for (const forbidden of [
      "cwd",
      "/Users/",
      "secret",
      "gitBranch",
      "person@example.com",
      "Test Person",
      "Secret Org",
      "sess-main.jsonl",
      key,
    ]) {
      expect(body).not.toContain(forbidden);
    }
    state.close();
  });

  test("只确认发送时的版本，推送期间写入的新版本保持待发送", async () => {
    const server = fakeServer();
    const state = fixtureState();
    const bigger = parseLine(
      assistantLine({
        requestId: "req_A",
        messageId: "msg_A",
        timestamp: "2026-09-01T10:00:05Z",
        input: 10,
        output: 9999,
        cacheRead: 1000,
        cacheWrite: 50,
      }),
    );
    if (bigger.kind !== "usage") throw new Error("fixture");
    const observation = bigger.observations[0]!;
    const racingFetch: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        state.applyFile(
          "/virtual",
          { identity: "v", offset: 0, fingerprint: "", mtimeMs: 0 },
          [
            {
              key: observation.key,
              firstTimestamp: observation.timestamp,
              total: observation.total,
              fact: observation.fact,
            },
          ],
        );
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const result = await pushOutbox(state, config(server.url), {
      fetch: racingFetch,
    });
    expect(result.error).toBeNull();
    // 第一批确认后，新版本在下一批发出。
    expect(server.batches).toHaveLength(2);
    expect(server.batches[1]!.usage).toHaveLength(1);
    expect(server.batches[1]!.usage[0]!.tokens.output).toBe(9999);
    expect(server.batches[1]!.usage[0]!.occurredAt).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    state.close();
  });

  test("401 保留全部待发送并报告服务端信息", async () => {
    const server = fakeServer();
    const state = fixtureState();
    const before = state.pendingCounts();
    const result = await pushOutbox(
      state,
      config(server.url, { key: "mlk_wrong" }),
    );
    expect(result.error?.kind).toBe("rejected");
    expect(result.error?.message).toContain("401");
    expect(result.error?.message).toContain("invalid key");
    expect(state.pendingCounts()).toEqual(before);
    state.close();
  });

  test("5xx 与网络错误停止并保留待发送", async () => {
    const server = fakeServer(503);
    const state = fixtureState();
    const before = state.pendingCounts();
    expect((await pushOutbox(state, config(server.url))).error?.kind).toBe(
      "server",
    );
    const closed = fakeServer();
    closed.stop();
    expect(
      (await pushOutbox(state, config(closed.url), { timeoutMs: 2000 })).error
        ?.kind,
    ).toBe("network");
    expect(state.pendingCounts()).toEqual(before);
    state.close();
  });

  test("按 INGEST_MAX_USAGE 分批", async () => {
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    const observations = [];
    for (let index = 0; index < INGEST_MAX_USAGE + 5; index += 1) {
      const parsed = parseLine(
        assistantLine({
          messageId: `m${index}`,
          timestamp: "2026-09-01T10:00:00Z",
          output: 1,
        }),
      );
      if (parsed.kind !== "usage") throw new Error("fixture");
      const observation = parsed.observations[0]!;
      observations.push({
        key: observation.key,
        firstTimestamp: observation.timestamp,
        total: observation.total,
        fact: observation.fact,
      });
    }
    state.applyFile(
      "/virtual",
      { identity: "v", offset: 0, fingerprint: "", mtimeMs: 0 },
      observations,
    );
    const result = await pushOutbox(state, config(server.url));
    expect(result.error).toBeNull();
    expect(server.batches.map((batch) => batch.usage.length)).toEqual([
      INGEST_MAX_USAGE,
      5,
    ]);
    expect(state.pendingCounts().usage).toBe(0);
    state.close();
  });
});

function usageObservation(options: AssistantLineOptions): FileObservation {
  const parsed = parseLine(assistantLine({ output: 10, ...options }));
  if (parsed.kind !== "usage") throw new Error("fixture");
  const observation = parsed.observations[0]!;
  return {
    key: observation.key,
    firstTimestamp: observation.timestamp,
    total: observation.total,
    fact: observation.fact,
  };
}

function enqueueObservations(
  state: CollectorState,
  observations: readonly FileObservation[],
) {
  state.applyFile(
    "/virtual",
    { identity: "v", offset: 0, fingerprint: "", mtimeMs: 0 },
    observations,
  );
}

describe("刚落盘未归属 Claude 用量暂扣", () => {
  const baseMs = Date.parse("2026-10-01T12:00:00.000Z");

  test("未满 30 秒且无同轮 OTEL 的未归属 timeline 条目暂扣，不附带 unattributed 账户，30 秒后放行", async () => {
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    enqueueObservations(state, [
      usageObservation({
        requestId: "req_fresh",
        messageId: "msg_fresh",
        timestamp: new Date(baseMs).toISOString(),
      }),
    ]);

    const held = await pushOutbox(state, config(server.url), {
      now: () => new Date(baseMs + UNATTRIBUTED_HOLD_MS - 1),
    });
    expect(held.error).toBeNull();
    expect(held.batches).toBe(0);
    expect(held.usage).toBe(0);
    expect(server.batches).toHaveLength(0);
    expect(state.pendingCounts().usage).toBe(1);

    const released = await pushOutbox(state, config(server.url), {
      now: () => new Date(baseMs + UNATTRIBUTED_HOLD_MS),
    });
    expect(released.error).toBeNull();
    expect(released.batches).toBe(1);
    expect(released.usage).toBe(1);
    expect(server.batches).toHaveLength(1);
    expect(server.batches[0]!.usage[0]!.externalId).toBe("req_fresh:msg_fresh");
    expect(server.batches[0]!.usage[0]!.accountExternalId).toBe(
      UNATTRIBUTED_ACCOUNT_ID,
    );
    expect(
      server.batches[0]!.accounts.some(
        (account) => account.externalId === UNATTRIBUTED_ACCOUNT_ID,
      ),
    ).toBe(true);
    expect(state.pendingCounts().usage).toBe(0);
    state.close();
  });

  test("同轮 OTEL 已成功推送对应 requestId 时，即使未满 30 秒也当轮立刻一并发出", async () => {
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    enqueueObservations(state, [
      usageObservation({
        requestId: "req_otel_ok",
        messageId: "msg_otel_ok",
        timestamp: new Date(baseMs).toISOString(),
      }),
    ]);
    state.enqueueOtel([
      {
        requestId: "req_otel_ok",
        accountUuid: FIXTURE_ACCOUNT_UUID,
        organizationUuid: null,
        sessionId: "sess-test",
        model: "claude-opus-5",
        occurredAt: new Date(baseMs).toISOString(),
      },
    ]);

    const result = await pushOutbox(state, config(server.url), {
      now: () => new Date(baseMs + 5_000),
    });
    expect(result.error).toBeNull();
    expect(result.otel).toBe(1);
    expect(result.usage).toBe(1);
    expect(server.otelBodies).toHaveLength(1);
    expect(server.batches).toHaveLength(1);
    expect(server.batches[0]!.usage[0]!.externalId).toBe(
      "req_otel_ok:msg_otel_ok",
    );
    expect(state.pendingCounts()).toEqual({
      usage: 0,
      account: 0,
      quota: 0,
      otel: 0,
      scope: 0,
    });
    state.close();
  });

  test("满 30 秒、未来时间戳、nr: 无请求 ID 及 attribution=model 条目均不暂扣", async () => {
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    state.setModelAccounts([
      {
        match: "claude-model-routed*",
        id: UNATTRIBUTED_ACCOUNT_ID,
        name: "模型路由",
        platform: "anthropic",
        kind: "unknown",
        plan: null,
      },
    ]);
    enqueueObservations(state, [
      usageObservation({
        requestId: "req_old",
        messageId: "msg_old",
        timestamp: new Date(baseMs - UNATTRIBUTED_HOLD_MS).toISOString(),
      }),
      usageObservation({
        requestId: "req_future",
        messageId: "msg_future",
        timestamp: new Date(baseMs + 5_000).toISOString(),
      }),
      usageObservation({
        requestId: null,
        messageId: "msg_no_req",
        timestamp: new Date(baseMs - 1_000).toISOString(),
      }),
      usageObservation({
        requestId: "req_model",
        messageId: "msg_model",
        model: "claude-model-routed-1",
        timestamp: new Date(baseMs - 1_000).toISOString(),
      }),
    ]);

    const result = await pushOutbox(state, config(server.url), {
      now: () => new Date(baseMs),
    });
    expect(result.error).toBeNull();
    expect(result.usage).toBe(4);
    expect(state.pendingCounts().usage).toBe(0);
    const sentIds = server.batches.flatMap((batch) =>
      batch.usage.map((item) => item.externalId),
    );
    expect(sentIds).toEqual([
      "req_old:msg_old",
      "req_future:msg_future",
      "nr:sess-test:msg_no_req",
      "req_model:msg_model",
    ]);
    state.close();
  });

  test("待发队列多页全部被扣时不空转、发出 0 次 ingest HTTP 请求", async () => {
    for (const totalHeld of [4, 5]) {
      const server = fakeServer();
      const state = new CollectorState(":memory:");
      const observations = Array.from({ length: totalHeld }, (_, index) =>
        usageObservation({
          requestId: `req_held_${index}`,
          messageId: `msg_held_${index}`,
          timestamp: new Date(baseMs - 2_000).toISOString(),
        }),
      );
      enqueueObservations(state, observations);

      const result = await pushOutbox(state, config(server.url), {
        limits: { usage: 2 },
        now: () => new Date(baseMs),
      });
      expect(result.error).toBeNull();
      expect(result.batches).toBe(0);
      expect(result.usage).toBe(0);
      expect(server.batches).toHaveLength(0);
      expect(state.pendingCounts().usage).toBe(totalHeld);
      state.close();
    }
  });

  test("被扣条目排在队列前面（含跨页）时，后面的普通用量仍正常发出并确认，且不附带 unattributed 账户", async () => {
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    enqueueObservations(state, [
      usageObservation({
        requestId: "req_front_1",
        messageId: "msg_front_1",
        timestamp: new Date(baseMs - 2_000).toISOString(),
      }),
      usageObservation({
        requestId: "req_front_2",
        messageId: "msg_front_2",
        timestamp: new Date(baseMs - 2_000).toISOString(),
      }),
      usageObservation({
        requestId: "req_front_3",
        messageId: "msg_front_3",
        timestamp: new Date(baseMs - 2_000).toISOString(),
      }),
    ]);
    state.observeAccount(
      FIXTURE_ACCOUNT_UUID,
      new Date(baseMs - 10_000).toISOString(),
    );
    state.observeAccount(FIXTURE_ACCOUNT_UUID, new Date(baseMs).toISOString());
    enqueueObservations(state, [
      usageObservation({
        requestId: "req_back_1",
        messageId: "msg_back_1",
        timestamp: new Date(baseMs - 1_000).toISOString(),
      }),
      usageObservation({
        requestId: "req_back_2",
        messageId: "msg_back_2",
        timestamp: new Date(baseMs - 1_000).toISOString(),
      }),
    ]);

    const result = await pushOutbox(state, config(server.url), {
      limits: { usage: 2 },
      now: () => new Date(baseMs),
    });
    expect(result.error).toBeNull();
    expect(result.usage).toBe(2);
    const sentIds = server.batches.flatMap((batch) =>
      batch.usage.map((item) => item.externalId),
    );
    expect(sentIds).toEqual(["req_back_1:msg_back_1", "req_back_2:msg_back_2"]);
    for (const batch of server.batches) {
      expect(
        batch.accounts.some(
          (account) => account.externalId === UNATTRIBUTED_ACCOUNT_ID,
        ),
      ).toBe(false);
    }
    expect(state.pendingCounts().usage).toBe(3);
    state.close();
  });

  test("被扣期间事件重新归属产生新 seq 与新账户后，下一轮立即以新账户发出", async () => {
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    const eventTime = new Date(baseMs - 5_000).toISOString();
    enqueueObservations(state, [
      usageObservation({
        requestId: "req_reattr",
        messageId: "msg_reattr",
        timestamp: eventTime,
      }),
    ]);

    const first = await pushOutbox(state, config(server.url), {
      now: () => new Date(baseMs),
    });
    expect(first.error).toBeNull();
    expect(first.usage).toBe(0);
    expect(server.batches).toHaveLength(0);
    const seqBefore = state.pending("usage", 10)[0]!.seq;

    state.observeAccount(
      FIXTURE_ACCOUNT_UUID,
      new Date(baseMs - 10_000).toISOString(),
    );
    state.observeAccount(FIXTURE_ACCOUNT_UUID, new Date(baseMs).toISOString());
    expect(state.reattribute(null)).toBe(1);
    const seqAfter = state.pending("usage", 10)[0]!.seq;
    expect(seqAfter).toBeGreaterThan(seqBefore);

    const second = await pushOutbox(state, config(server.url), {
      now: () => new Date(baseMs + 5_000),
    });
    expect(second.error).toBeNull();
    expect(second.usage).toBe(1);
    expect(server.batches).toHaveLength(1);
    expect(server.batches[0]!.usage[0]!.externalId).toBe(
      "req_reattr:msg_reattr",
    );
    expect(server.batches[0]!.usage[0]!.accountExternalId).toBe(
      FIXTURE_ACCOUNT_UUID,
    );
    expect(state.pendingCounts().usage).toBe(0);
    state.close();
  });

  test("长响应同轮解析（t=0 占位行 + t=40s 最终行）：t=41s 暂扣，t=71s 放行且剥离 _observedAt 并保留首行 occurredAt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meterleaf-push-hold-"));
    const file = join(dir, "session.jsonl");
    const t0 = new Date(baseMs).toISOString();
    const t40 = new Date(baseMs + 40_000).toISOString();
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    try {
      writeFileSync(
        file,
        `${assistantLine({
          requestId: "req_long_same",
          messageId: "msg_long_same",
          timestamp: t0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        })}\n${assistantLine({
          requestId: "req_long_same",
          messageId: "msg_long_same",
          timestamp: t40,
          input: 120,
          output: 240,
        })}\n`,
      );
      ingestFile(state, file, emptyReport());

      const held = await pushOutbox(state, config(server.url), {
        now: () => new Date(baseMs + 41_000),
      });
      expect(held.error).toBeNull();
      expect(held.batches).toBe(0);
      expect(held.usage).toBe(0);
      expect(server.batches).toHaveLength(0);
      expect(state.pendingCounts().usage).toBe(1);

      const released = await pushOutbox(state, config(server.url), {
        now: () => new Date(baseMs + 71_000),
      });
      expect(released.error).toBeNull();
      expect(released.usage).toBe(1);
      expect(server.batches).toHaveLength(1);
      expect(server.bodies[0]).not.toContain("_observedAt");
      expect(server.batches[0]!.usage[0]!.externalId).toBe(
        "req_long_same:msg_long_same",
      );
      expect(server.batches[0]!.usage[0]!.occurredAt).toBe(t0);
      expect(server.batches[0]!.usage[0]!.tokens.output).toBe(240);
      expect(state.pendingCounts().usage).toBe(0);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("长响应跨轮解析（先读 t=0 占位行，后读 t=40s 最终行）：t=41s 暂扣，OTEL 到达后放行且剥离 _observedAt 并保留首行 occurredAt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meterleaf-push-hold-"));
    const file = join(dir, "session.jsonl");
    const t0 = new Date(baseMs).toISOString();
    const t40 = new Date(baseMs + 40_000).toISOString();
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    try {
      writeFileSync(
        file,
        `${assistantLine({
          requestId: "req_long_cross",
          messageId: "msg_long_cross",
          timestamp: t0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        })}\n`,
      );
      ingestFile(state, file, emptyReport());
      expect(state.pendingCounts().usage).toBe(0);

      appendFileSync(
        file,
        `${assistantLine({
          requestId: "req_long_cross",
          messageId: "msg_long_cross",
          timestamp: t40,
          input: 150,
          output: 300,
        })}\n`,
      );
      ingestFile(state, file, emptyReport());
      expect(state.pendingCounts().usage).toBe(1);

      const held = await pushOutbox(state, config(server.url), {
        now: () => new Date(baseMs + 41_000),
      });
      expect(held.error).toBeNull();
      expect(held.batches).toBe(0);
      expect(held.usage).toBe(0);
      expect(server.batches).toHaveLength(0);
      expect(state.pendingCounts().usage).toBe(1);

      state.enqueueOtel([
        {
          requestId: "req_long_cross",
          accountUuid: FIXTURE_ACCOUNT_UUID,
          organizationUuid: null,
          sessionId: "sess-test",
          model: "claude-opus-5",
          occurredAt: t40,
        },
      ]);
      const released = await pushOutbox(state, config(server.url), {
        now: () => new Date(baseMs + 45_000),
      });
      expect(released.error).toBeNull();
      expect(released.otel).toBe(1);
      expect(released.usage).toBe(1);
      expect(server.batches).toHaveLength(1);
      expect(server.bodies[0]).not.toContain("_observedAt");
      expect(server.batches[0]!.usage[0]!.externalId).toBe(
        "req_long_cross:msg_long_cross",
      );
      expect(server.batches[0]!.usage[0]!.occurredAt).toBe(t0);
      expect(server.batches[0]!.usage[0]!.tokens.output).toBe(300);
      expect(state.pendingCounts().usage).toBe(0);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("回滚兼容性：outbox 表原始 payload 不含 _observedAt 等非协议字段，直接通过 ingestUsageSchema 校验", () => {
    const dir = mkdtempSync(join(tmpdir(), "meterleaf-push-hold-"));
    const file = join(dir, "session.jsonl");
    const t0 = new Date(baseMs).toISOString();
    const t40 = new Date(baseMs + 40_000).toISOString();
    const state = new CollectorState(":memory:");
    try {
      writeFileSync(
        file,
        `${assistantLine({
          requestId: "req_rollback",
          messageId: "msg_rollback",
          timestamp: t0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        })}\n${assistantLine({
          requestId: "req_rollback",
          messageId: "msg_rollback",
          timestamp: t40,
          input: 100,
          output: 200,
        })}\n`,
      );
      ingestFile(state, file, emptyReport());

      const rawRow = state.db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM outbox WHERE kind = 'usage' AND item_id = ?",
        )
        .get("req_rollback:msg_rollback");
      expect(rawRow).not.toBeNull();
      expect(rawRow!.payload).not.toContain("_observedAt");
      const parsed = ingestUsageSchema.parse(JSON.parse(rawRow!.payload));
      expect(parsed.externalId).toBe("req_rollback:msg_rollback");
      expect(parsed.occurredAt).toBe(t0);

      const pending = state.pending("usage", 10);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.observedAt).toBe(t40);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reattribute 移除模型规则回退为 unattributed 时保留观测时间，t=41s 仍暂扣，t=71s 放行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meterleaf-push-hold-"));
    const file = join(dir, "session.jsonl");
    const t0 = new Date(baseMs).toISOString();
    const t40 = new Date(baseMs + 40_000).toISOString();
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    try {
      state.setModelAccounts([
        {
          match: "claude-opus-5",
          id: "custom-model-acct",
          name: "自定义模型账户",
          platform: "anthropic",
          kind: "subscription",
          plan: null,
        },
      ]);
      writeFileSync(
        file,
        `${assistantLine({
          requestId: "req_model_drop",
          messageId: "msg_model_drop",
          timestamp: t0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        })}\n${assistantLine({
          requestId: "req_model_drop",
          messageId: "msg_model_drop",
          timestamp: t40,
          input: 110,
          output: 220,
        })}\n`,
      );
      ingestFile(state, file, emptyReport());
      // 模拟首次推送失败：移除模型规则并重新归属为 unattributed。
      state.setModelAccounts([]);
      expect(state.reattribute(null)).toBe(1);

      const held = await pushOutbox(state, config(server.url), {
        now: () => new Date(baseMs + 41_000),
      });
      expect(held.error).toBeNull();
      expect(held.usage).toBe(0);
      expect(state.pendingCounts().usage).toBe(1);
      for (const batch of server.batches) {
        expect(batch.usage).toHaveLength(0);
      }

      const released = await pushOutbox(state, config(server.url), {
        now: () => new Date(baseMs + 71_000),
      });
      expect(released.error).toBeNull();
      expect(released.usage).toBe(1);
      const usageBatches = server.batches.filter((b) => b.usage.length > 0);
      expect(usageBatches).toHaveLength(1);
      expect(usageBatches[0]!.usage[0]!.externalId).toBe(
        "req_model_drop:msg_model_drop",
      );
      expect(usageBatches[0]!.usage[0]!.accountExternalId).toBe(
        UNATTRIBUTED_ACCOUNT_ID,
      );
      expect(usageBatches[0]!.usage[0]!.occurredAt).toBe(t0);
      expect(state.pendingCounts().usage).toBe(0);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
