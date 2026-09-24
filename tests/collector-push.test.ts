import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collect } from "../src/collector/collect";
import type { CollectorConfig } from "../src/collector/config";
import { pushOutbox } from "../src/collector/push";
import { CollectorState } from "../src/collector/state";
import {
  INGEST_BATCHES_PATH,
  INGEST_MAX_USAGE,
  ingestBatchSchema,
  type IngestBatch,
} from "../src/shared/ingest";
import { assistantLine } from "./fixtures/claude-code/lines";
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
  stop: () => void;
}

const servers: FakeServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function fakeServer(status = 200): FakeServer {
  const batches: IngestBatch[] = [];
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== INGEST_BATCHES_PATH || request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      if (request.headers.get("authorization") !== `Bearer ${key}`) {
        return Response.json({ error: "invalid key" }, { status: 401 });
      }
      if (status !== 200) return new Response("unavailable", { status });
      const body = await request.text();
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
    expect(state.pendingCounts()).toEqual({ usage: 0, account: 0, quota: 0 });
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
