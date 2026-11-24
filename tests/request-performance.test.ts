import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgyGenMetadata, readAgy } from "../src/collector/agy";
import { collect } from "../src/collector/collect";
import { ompMessage, readOmp } from "../src/collector/omp";
import { CollectorState } from "../src/collector/state";
import { defaultPriceBook } from "../src/domain/default-prices";
import { ReportProjection } from "../src/server/report-projection";
import { liveSnapshot } from "../src/server/snapshot";
import type { IngestUsage } from "../src/shared/ingest";
import { createLedgerView } from "../src/shared/ledger-view";
import { LedgerStore } from "../src/storage/ledger";
import { ReportIndex } from "../src/storage/report-index";
import {
  formatLatencyMs,
  formatTps,
  performanceAvgDurationMs,
  performanceAvgFirstTokenMs,
  performanceTps,
  recordTps,
} from "../src/web/lib/report";

function encodeVarint(value: number | bigint): Uint8Array {
  let v = BigInt(value);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function varintField(field: number, value: number | bigint): Uint8Array {
  return concatBytes(encodeVarint((field << 3) | 0), encodeVarint(value));
}

function bytesField(field: number, payload: Uint8Array): Uint8Array {
  return concatBytes(
    encodeVarint((field << 3) | 2),
    encodeVarint(payload.length),
    payload,
  );
}

function stringField(field: number, text: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(text));
}

function durationMessage(seconds: number, nanos = 0): Uint8Array {
  return concatBytes(
    seconds > 0 ? varintField(1, seconds) : new Uint8Array(0),
    nanos > 0 ? varintField(2, nanos) : new Uint8Array(0),
  );
}

function agyFixture(options: {
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  createdAtSec: number;
  ttft?: [number, number];
  streaming?: [number, number];
  executionId: string;
}): string {
  const usage = concatBytes(
    varintField(2, options.inputTokens),
    varintField(3, options.outputTokens),
  );
  const chatStart = bytesField(4, durationMessage(options.createdAtSec));
  const chatChunks: Uint8Array[] = [
    bytesField(4, usage),
    bytesField(9, chatStart),
    stringField(19, options.responseModel),
  ];
  if (options.ttft) {
    chatChunks.push(
      bytesField(11, durationMessage(options.ttft[0], options.ttft[1])),
    );
  }
  if (options.streaming) {
    chatChunks.push(
      bytesField(
        12,
        durationMessage(options.streaming[0], options.streaming[1]),
      ),
    );
  }
  const top = concatBytes(
    bytesField(1, concatBytes(...chatChunks)),
    stringField(4, options.executionId),
  );
  return Buffer.from(top).toString("base64");
}

test("Antigravity collector decodes TTFT and streaming duration into first_token_ms and duration_ms", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-perf-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const convDir = join(root, "antigravity-cli", "conversations");
    const statusDir = join(root, "statusline");
    mkdirSync(convDir, { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, "current-account"), "alice\n");

    const withLatency = agyFixture({
      responseModel: "gemini-4-neon",
      inputTokens: 1200,
      outputTokens: 600,
      createdAtSec: Math.floor(Date.parse("2026-11-20T10:00:00.000Z") / 1000),
      ttft: [1, 800_000_000],
      streaming: [4, 200_000_000],
      executionId: "exec-1",
    });
    const withoutLatency = agyFixture({
      responseModel: "gemini-4-neon",
      inputTokens: 500,
      outputTokens: 200,
      createdAtSec: Math.floor(Date.parse("2026-11-20T10:01:00.000Z") / 1000),
      executionId: "exec-2",
    });

    const decoded = decodeAgyGenMetadata(withLatency);
    expect(decoded.chatModel?.ttftMs).toBe(1800);
    expect(decoded.chatModel?.streamingMs).toBe(4200);

    const convDb = new Database(join(convDir, "conv-1.db"), { create: true });
    convDb.exec(
      "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data TEXT)",
    );
    convDb.run("INSERT INTO gen_metadata (idx, data) VALUES (0, ?), (1, ?)", [
      withLatency,
      withoutLatency,
    ]);
    convDb.close();

    const report = readAgy(
      state,
      {
        conversationsDir: convDir,
        statuslineDir: statusDir,
        start: "2026-11-01T00:00:00.000Z",
      },
      new Date("2026-11-20T10:05:00.000Z"),
    );
    expect(report.recorded).toBe(2);

    const queued = state
      .pending<IngestUsage>("usage", 10)
      .map((item) => item.payload);
    expect(queued).toHaveLength(2);
    expect(queued[0]!.metadata.first_token_ms).toBe(1800);
    expect(queued[0]!.metadata.duration_ms).toBe(6000);
    expect(queued[1]!.metadata.first_token_ms).toBeUndefined();
    expect(queued[1]!.metadata.duration_ms).toBeUndefined();
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("omp collector captures duration_ms and first_token_ms and drops inconsistent ttft", async () => {
  const inconsistent = ompMessage(
    {
      type: "message",
      id: "m-bad",
      message: {
        role: "assistant",
        provider: "google-antigravity",
        model: "gemini-4-neon",
        completedAt: Date.parse("2026-11-20T10:00:00.000Z"),
        duration: 1000,
        ttft: 1500,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
    },
    { effort: null, tier: null },
  );
  expect(inconsistent?.durationMs).toBe(1000);
  expect(inconsistent?.firstTokenMs).toBeNull();

  const root = mkdtempSync(join(tmpdir(), "meterleaf-omp-perf-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const sessionsDir = join(root, "sessions");
    const statusDir = join(root, "statusline");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, "current-account"), "alice\n");
    writeFileSync(
      join(sessionsDir, "s1.jsonl"),
      JSON.stringify({
        type: "message",
        id: "m-1",
        message: {
          role: "assistant",
          provider: "google-antigravity",
          model: "gemini-4-neon",
          completedAt: Date.parse("2026-11-20T10:00:10.000Z"),
          duration: 12345.6,
          ttft: 987.4,
          usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 },
        },
      }) + "\n",
    );

    const report = await readOmp(state, {
      sessionsDir,
      credentialsDb: join(root, "missing.db"),
      statuslineDir: statusDir,
      start: "2026-11-01T00:00:00.000Z",
      channelAccounts: [],
    });
    expect(report.recorded).toBe(1);
    const queued = state.pending<IngestUsage>("usage", 10);
    expect(queued[0]!.payload.metadata.duration_ms).toBe(12346);
    expect(queued[0]!.payload.metadata.first_token_ms).toBe(987);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Code collector computes duration_ms from api-request to final assistant block across incremental reads", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-cc-perf-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const projectsDir = join(root, "projects", "demo");
    mkdirSync(projectsDir, { recursive: true });
    const claudeJson = join(root, ".claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({
        oauthAccount: { accountUuid: "acc-1", organizationUuid: "org-1" },
      }),
    );
    const sessionFile = join(projectsDir, "sess.jsonl");
    const firstChunk =
      [
        JSON.stringify({
          type: "api-request",
          id: "ref-1",
          timestamp: "2026-11-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          requestId: "req-1",
          requestRef: "ref-1",
          sessionId: "s-1",
          timestamp: "2026-11-20T10:00:03.000Z",
          message: {
            id: "msg-1",
            model: "claude-opus-5-5",
            usage: {
              input_tokens: 1000,
              output_tokens: 600,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              iterations: [
                {
                  type: "advisor_message",
                  model: "claude-sonnet-5-5",
                  input_tokens: 200,
                  output_tokens: 100,
                },
              ],
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          requestId: "req-no-ref",
          sessionId: "s-1",
          timestamp: "2026-11-20T10:01:00.000Z",
          message: {
            id: "msg-2",
            model: "claude-opus-5-5",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ].join("\n") + "\n";
    writeFileSync(sessionFile, firstChunk);

    const now1 = new Date("2026-11-20T10:02:00.000Z");
    collect(state, { projectsDir, claudeJson }, now1);
    const queued1 = state
      .pending<IngestUsage>("usage", 10)
      .map((item) => item.payload);
    const primary1 = queued1.find((u) => u.externalId === "req-1:msg-1")!;
    const advisor = queued1.find(
      (u) => u.externalId === "req-1:msg-1:advisor:0",
    )!;
    const noRef = queued1.find((u) => u.externalId === "req-no-ref:msg-2")!;
    expect(primary1.metadata.duration_ms).toBe(3000);
    expect(primary1.metadata.first_token_ms).toBeUndefined();
    expect(advisor.metadata.duration_ms).toBeUndefined();
    expect(noRef.metadata.duration_ms).toBeUndefined();

    // 增量追加同一响应的后续内容块（相同 token 合计但更晚的时间戳），通过向前回看找到 api-request 并更新为最终总耗时。
    appendFileSync(
      sessionFile,
      JSON.stringify({
        type: "assistant",
        requestId: "req-1",
        requestRef: "ref-1",
        sessionId: "s-1",
        timestamp: "2026-11-20T10:00:10.000Z",
        message: {
          id: "msg-1",
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 1000,
            output_tokens: 600,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) + "\n",
    );
    const now2 = new Date("2026-11-20T10:03:00.000Z");
    const report2 = collect(state, { projectsDir, claudeJson }, now2);
    expect(report2.rewound).toBe(0);
    const primary2 = state
      .pending<IngestUsage>("usage", 10)
      .map((item) => item.payload)
      .find((u) => u.externalId === "req-1:msg-1")!;
    expect(primary2.metadata.duration_ms).toBe(10000);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ReportIndex and createLedgerView aggregate weighted TPS and latency identically and upgrade format-2 indexes", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-perf-index-"));
  const ledgerPath = join(root, "ledger.sqlite");
  const indexPath = join(root, "report-index.sqlite");
  const store = new LedgerStore(ledgerPath, defaultPriceBook);
  const now = "2026-11-20T12:00:00.000Z";
  try {
    store.saveAccounts([
      {
        sourceId: "local",
        externalId: "acc-1",
        name: "Local",
        platform: "google",
        kind: "subscription",
        plan: null,
        parentExternalId: null,
        subjectKey: null,
      },
    ]);
    store.savePage(
      "local",
      "incremental",
      {
        records: [
          {
            sourceId: "local",
            externalId: "r-1",
            occurredAt: "2026-11-20T10:10:00.000Z",
            accountExternalId: "acc-1",
            model: "gemini-4-neon",
            upstreamModel: null,
            tier: "standard",
            tokens: {
              input: 1000,
              output: 1000,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: null,
              cacheWrite1h: null,
              reasoning: null,
            },
            gatewayCost: null,
            gatewayBilled: null,
            upstreamUsd: null,
            upstreamCredits: null,
            metadata: { duration_ms: 10_000, first_token_ms: 2_000 },
          },
          {
            sourceId: "local",
            externalId: "r-2",
            occurredAt: "2026-11-20T11:10:00.000Z",
            accountExternalId: "acc-1",
            model: "gemini-4-neon",
            upstreamModel: null,
            tier: "standard",
            tokens: {
              input: 500,
              output: 200,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: null,
              cacheWrite1h: null,
              reasoning: null,
            },
            gatewayCost: null,
            gatewayBilled: null,
            upstreamUsd: null,
            upstreamCredits: null,
            metadata: { duration_ms: 2_000 },
          },
          {
            sourceId: "local",
            externalId: "r-3",
            occurredAt: "2026-11-20T11:20:00.000Z",
            accountExternalId: "acc-1",
            model: "gemini-4-neon",
            upstreamModel: null,
            tier: "standard",
            tokens: {
              input: 500,
              output: 300,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: null,
              cacheWrite1h: null,
              reasoning: null,
            },
            gatewayCost: null,
            gatewayBilled: null,
            upstreamUsd: null,
            upstreamCredits: null,
            metadata: {},
          },
        ],
        nextCursor: "r-3",
        hasMore: false,
      },
      now,
    );

    const snapshot = liveSnapshot(store, null, 7, now, "subscription");
    const query = {
      filter: { days: 7, model: "all", account: "all", search: "" },
      unit: "usd" as const,
      granularity: "day" as const,
      dimension: "model" as const,
      page: 0,
      pageSize: 12,
      sort: "occurredAt",
      desc: true,
    };
    const direct = createLedgerView(snapshot, query);
    const projection = new ReportProjection(store, ledgerPath, indexPath);
    projection.ensure();
    const indexed = projection.index.read(snapshot, query);

    expect(indexed.view.reportRows).toEqual(direct.view.reportRows);
    const perf = indexed.view.reportRows[0]!.performance;
    expect(perf).toEqual({
      durationKnown: 2,
      durationSumMs: 12_000,
      firstTokenKnown: 1,
      firstTokenSumMs: 2_000,
      tpsKnown: 2,
      tpsOutputSum: 1200,
      tpsDurationSumMs: 12_000,
    });
    expect(performanceAvgFirstTokenMs(perf)).toBe(2000);
    expect(performanceAvgDurationMs(perf)).toBe(6000);
    // 加权速度 = (1000 + 200) / ((10000 + 2000) / 1000) = 100 tok/s
    expect(performanceTps(perf)).toBe(100);
    expect(recordTps(1000, 10_000)).toBe(100);
    expect(recordTps(0, 10_000)).toBeNull();
    expect(formatLatencyMs(0)).toBe("0 s");
    expect(formatLatencyMs(3)).toBe("<0.01 s");
    expect(formatLatencyMs(850)).toBe("0.85 s");
    expect(formatLatencyMs(1850)).toBe("1.85 s");
    expect(formatLatencyMs(12_340)).toBe("12.34 s");
    expect(formatTps(100)).toBe("100 tok/s");
    expect(formatTps(64.24)).toBe("64.2 tok/s");
    expect(formatTps(4.56)).toBe("4.56 tok/s");
    projection.close();

    // 模拟旧格式 2 索引：降级检查点后重新打开，应自动重建并保持相同性能汇总。
    const raw = new ReportIndex(indexPath);
    const cpRow = raw.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM projection_checkpoint WHERE id=1",
      )
      .get()!;
    raw.db
      .query("UPDATE projection_checkpoint SET payload=? WHERE id=1")
      .run(JSON.stringify({ ...JSON.parse(cpRow.payload), format: 2 }));
    raw.close();

    const upgraded = new ReportProjection(store, ledgerPath, indexPath);
    expect(upgraded.ensure()).toBe(true);
    expect(
      upgraded.index.read(snapshot, query).view.reportRows[0]!.performance,
    ).toEqual(perf);
    upgraded.close();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
