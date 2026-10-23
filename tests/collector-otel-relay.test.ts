import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { collect } from "../src/collector/collect";
import type { CollectorConfig } from "../src/collector/config";
import { startOtelRelay, type OtelRelay } from "../src/collector/otel-relay";
import {
  OTEL_MAX_PUSH_RECORDS,
  pushOutbox,
  serializeOtelRequests,
} from "../src/collector/push";
import { CollectorState } from "../src/collector/state";
import {
  INGEST_BATCHES_PATH,
  ingestBatchSchema,
  type IngestBatch,
} from "../src/shared/ingest";
import {
  OTEL_BODY_LIMIT_BYTES,
  OTEL_LOGS_PATH,
  parseOtelRequestAccounts,
  type OtelRequestAccount,
} from "../src/shared/otel";

const fixtureRoot = join(import.meta.dir, "fixtures/claude-code");
const sources = {
  projectsDir: join(fixtureRoot, "projects"),
  claudeJson: join(fixtureRoot, "claude.json"),
};
const key = "mlk_test-key-for-otel-relay";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function trackRelay(relay: OtelRelay) {
  cleanup.push(() => void relay.stop());
  return relay;
}

function record(values: Record<string, string>): Record<string, unknown> {
  return {
    body: { stringValue: "claude_code.api_request" },
    attributes: Object.entries(values).map(([name, value]) => ({
      key: name,
      value: { stringValue: value },
    })),
  };
}

function otlp(records: unknown[]): unknown {
  return {
    resourceLogs: [{ scopeLogs: [{ logRecords: records }] }],
  };
}

function otelRecord(
  overrides: Partial<OtelRequestAccount> = {},
): OtelRequestAccount {
  return {
    requestId: "req_1",
    accountUuid: "account-1",
    organizationUuid: "org-1",
    sessionId: "session-1",
    model: "claude-opus-5-5",
    occurredAt: "2026-10-23T11:00:00.000Z",
    ...overrides,
  };
}

function config(server: string): CollectorConfig {
  return {
    server,
    sourceId: "claude-code-test",
    key,
    createdAt: "2026-09-01T00:00:00Z",
  };
}

function relayFor(state: CollectorState): OtelRelay {
  return trackRelay(startOtelRelay(state, { port: 0, log: () => {} }));
}

function post(
  relay: OtelRelay,
  body: string | unknown,
  options: {
    raw?: boolean;
    contentType?: string;
    encoding?: string;
    method?: string;
    path?: string;
    authorization?: string;
  } = {},
) {
  const raw: BodyInit = options.raw
    ? (body as string)
    : typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? (body as unknown as BodyInit)
        : JSON.stringify(body);
  return fetch(`http://127.0.0.1:${relay.port}${options.path ?? "/v1/logs"}`, {
    method: options.method ?? "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      ...(options.encoding ? { "content-encoding": options.encoding } : {}),
      ...(options.authorization
        ? { authorization: options.authorization }
        : {}),
    },
    body: options.method === "GET" ? undefined : raw,
  });
}

describe("本机 OTEL 中转", () => {
  test("gzip 与未压缩的 API 请求都写入 outbox，Authorization 头被忽略", async () => {
    const state = new CollectorState(":memory:");
    cleanup.push(() => state.close());
    const relay = relayFor(state);

    const plain = await post(
      relay,
      otlp([record({ request_id: "req_plain", "user.account_uuid": "a1" })]),
      { authorization: "Bearer ignored" },
    );
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({});

    const gzip = await post(
      relay,
      gzipSync(
        JSON.stringify(
          otlp([
            record({
              request_id: "req_gzip",
              "user.account_uuid": "a2",
              model: "claude-opus-5-5",
            }),
          ]),
        ),
      ),
      { encoding: "gzip" },
    );
    expect(gzip.status).toBe(200);

    const pending = state.pending<OtelRequestAccount>("otel", 10);
    expect(pending.map((item) => item.payload.requestId)).toEqual([
      "req_plain",
      "req_gzip",
    ]);
    expect(pending[1]!.payload).toMatchObject({
      accountUuid: "a2",
      model: "claude-opus-5-5",
      occurredAt: null,
    });
  });

  test("只接受 JSON 与 gzip，路径与方法受限", async () => {
    const state = new CollectorState(":memory:");
    cleanup.push(() => state.close());
    const relay = relayFor(state);
    const body = otlp([record({ request_id: "req_1" })]);

    expect(
      (await post(relay, body, { contentType: "text/plain" })).status,
    ).toBe(415);
    expect(
      (await post(relay, body, { contentType: "application/x-protobuf" }))
        .status,
    ).toBe(415);
    expect((await post(relay, body, { encoding: "br" })).status).toBe(415);
    expect((await post(relay, body, { path: "/other" })).status).toBe(404);
    expect((await post(relay, body, { method: "GET" })).status).toBe(405);
    expect(state.pendingCounts().otel).toBe(0);
  });

  test("请求体与解压后大小超过上限都返回 413", async () => {
    const state = new CollectorState(":memory:");
    cleanup.push(() => state.close());
    const relay = relayFor(state);

    const tooLarge = await post(relay, "x".repeat(OTEL_BODY_LIMIT_BYTES + 1), {
      raw: true,
    });
    expect(tooLarge.status).toBe(413);

    const compressed = gzipSync(
      JSON.stringify({
        resourceLogs: [],
        padding: "x".repeat(OTEL_BODY_LIMIT_BYTES),
      }),
    );
    expect(compressed.byteLength).toBeLessThan(OTEL_BODY_LIMIT_BYTES);
    const zipBomb = await post(relay, compressed, { encoding: "gzip" });
    expect(zipBomb.status).toBe(413);
    expect(state.pendingCounts().otel).toBe(0);
  });

  test("坏 JSON、缺少 resourceLogs 返回 400，非 API 请求被忽略", async () => {
    const state = new CollectorState(":memory:");
    cleanup.push(() => state.close());
    const relay = relayFor(state);

    expect((await post(relay, "{", { raw: true })).status).toBe(400);
    expect((await post(relay, { resourceLogs: 5 })).status).toBe(400);
    expect(
      (await post(relay, gzipSync("not gzip data"), { encoding: "gzip" }))
        .status,
    ).toBe(400);

    const ignored = await post(
      relay,
      otlp([
        { body: { stringValue: "other.event" }, attributes: [] },
        record({ request_id: "req_without_event_name" }),
      ]),
    );
    expect(ignored.status).toBe(200);
    // 第二条带 body 的 API 请求照常写入；第一条被忽略。
    expect(state.pendingCounts().otel).toBe(1);

    const ignored2 = await post(
      relay,
      otlp([
        {
          body: { stringValue: "other.event" },
          attributes: [
            { key: "request_id", value: { stringValue: "req_not_api" } },
          ],
        },
      ]),
    );
    expect(ignored2.status).toBe(200);
    expect(state.pendingCounts().otel).toBe(1);

    // 同一 requestId 后到版本覆盖先到版本。
    await post(relay, otlp([record({ request_id: "req_dup", model: "old" })]));
    await post(relay, otlp([record({ request_id: "req_dup", model: "new" })]));
    const duplicate = state
      .pending<OtelRequestAccount>("otel", 10)
      .filter((item) => item.payload.requestId === "req_dup");
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]!.payload.model).toBe("new");
  });

  test("写库失败返回 503，让 Claude Code 重试", async () => {
    const state = new CollectorState(":memory:");
    const relay = trackRelay(startOtelRelay(state, { port: 0, log: () => {} }));
    state.close();
    const response = await post(
      relay,
      otlp([record({ request_id: "req_closed" })]),
    );
    expect(response.status).toBe(503);
  });
});

interface FakeServer {
  url: string;
  paths: string[];
  otel: unknown[];
  batches: IngestBatch[];
  stop: () => void;
}

function fakeServer(status = 200, otelStatus = status): FakeServer {
  const paths: string[] = [];
  const otel: unknown[] = [];
  const batches: IngestBatch[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return new Response("invalid key", { status: 401 });
      if (path === OTEL_LOGS_PATH && otelStatus !== 200)
        return new Response("unavailable", { status: otelStatus });
      if (status !== 200) return new Response("unavailable", { status });
      if (path === OTEL_LOGS_PATH) {
        otel.push(await request.json());
        return Response.json({});
      }
      if (path === INGEST_BATCHES_PATH) {
        const parsed = ingestBatchSchema.safeParse(await request.json());
        if (!parsed.success) return new Response("bad", { status: 400 });
        batches.push(parsed.data);
        return Response.json({ batchId: parsed.data.batchId, accepted: {} });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const fake = {
    url: `http://127.0.0.1:${server.port}`,
    paths,
    otel,
    batches,
    stop: () => server.stop(true),
  };
  cleanup.push(fake.stop);
  return fake;
}

function usageState() {
  const state = new CollectorState(":memory:");
  cleanup.push(() => state.close());
  collect(state, sources, new Date("2026-09-01T11:00:00Z"));
  return state;
}

describe("推送 OTEL 请求归属", () => {
  test("序列化后经共享解析器还原出相同记录", () => {
    const records = [
      otelRecord(),
      otelRecord({
        requestId: "req_2",
        accountUuid: null,
        organizationUuid: null,
        sessionId: null,
        model: null,
        occurredAt: null,
      }),
    ];
    const payload = JSON.parse(JSON.stringify(serializeOtelRequests(records)));
    expect(parseOtelRequestAccounts(payload)).toEqual(records);
  });

  test("先推 OTEL 再推用量，2xx 后确认", async () => {
    const server = fakeServer();
    const state = usageState();
    state.enqueueOtel([otelRecord()]);

    const result = await pushOutbox(state, config(server.url));
    expect(result.error).toBeNull();
    expect(result.otel).toBe(1);
    expect(result.usage).toBe(5);
    expect(server.paths).toEqual([OTEL_LOGS_PATH, INGEST_BATCHES_PATH]);
    expect(parseOtelRequestAccounts(server.otel[0])).toEqual([otelRecord()]);
    expect(state.pendingCounts()).toEqual({
      usage: 0,
      account: 0,
      quota: 0,
      otel: 0,
    });
  });

  test("网络错误、5xx 与 4xx 都保留 OTEL 项；只有 4xx 时仍尝试推用量", async () => {
    for (const status of [503, 401]) {
      const state = usageState();
      const server = fakeServer(status);
      state.enqueueOtel([otelRecord()]);
      const before = state.pendingCounts();
      const result = await pushOutbox(state, config(server.url));
      expect(result.error?.kind).toBe(status === 503 ? "server" : "rejected");
      expect(result.usage).toBe(0);
      expect(server.paths).toEqual(
        status === 503
          ? [OTEL_LOGS_PATH]
          : [OTEL_LOGS_PATH, INGEST_BATCHES_PATH],
      );
      expect(state.pendingCounts()).toEqual(before);
    }

    const state = usageState();
    state.enqueueOtel([otelRecord()]);
    const closed = fakeServer();
    closed.stop();
    const result = await pushOutbox(state, config(closed.url), {
      timeoutMs: 2000,
    });
    expect(result.error?.kind).toBe("network");
    expect(state.pendingCounts().otel).toBe(1);
    expect(state.pendingCounts().usage).toBeGreaterThan(0);
  });

  test("服务端拒收 OTEL 时用量照常推送，归属记录留待补发", async () => {
    const state = usageState();
    const server = fakeServer(200, 404);
    state.enqueueOtel([otelRecord()]);
    const result = await pushOutbox(state, config(server.url));
    expect(result.error?.kind).toBe("rejected");
    expect(result.usage).toBe(5);
    expect(server.paths).toEqual([OTEL_LOGS_PATH, INGEST_BATCHES_PATH]);
    expect(state.pendingCounts()).toMatchObject({ usage: 0, otel: 1 });
  });

  test(`超过 ${OTEL_MAX_PUSH_RECORDS} 条分多批发送`, async () => {
    const server = fakeServer();
    const state = new CollectorState(":memory:");
    cleanup.push(() => state.close());
    const records = Array.from(
      { length: OTEL_MAX_PUSH_RECORDS + 5 },
      (_, index) => otelRecord({ requestId: `req_${index}` }),
    );
    state.enqueueOtel(records);

    const result = await pushOutbox(state, config(server.url));
    expect(result.error).toBeNull();
    expect(result.otel).toBe(records.length);
    expect(result.batches).toBe(2);
    expect(
      server.otel.map((payload) => parseOtelRequestAccounts(payload)?.length),
    ).toEqual([OTEL_MAX_PUSH_RECORDS, 5]);
    expect(state.pendingCounts().otel).toBe(0);
  });

  test("接收进程写入期间运行 sync 不出现 SQLITE_BUSY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meterleaf-otel-relay-busy-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "state.sqlite");
    const relayState = new CollectorState(path);
    cleanup.push(() => relayState.close());
    const syncState = new CollectorState(path);
    cleanup.push(() => syncState.close());
    collect(syncState, sources, new Date("2026-09-01T11:00:00Z"));

    const server = fakeServer();
    const relay = relayFor(relayState);
    const writes: Promise<Response>[] = [];
    const racingFetch: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        writes.push(
          ...Array.from({ length: 30 }, (_, index) =>
            post(relay, otlp([record({ request_id: `req_busy_${index}` })])),
          ),
        );
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );

    const result = await pushOutbox(syncState, config(server.url), {
      fetch: racingFetch,
    });
    const responses = await Promise.all(writes);
    expect(result.error).toBeNull();
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(relayState.pendingCounts().otel).toBe(30);
  });
});
