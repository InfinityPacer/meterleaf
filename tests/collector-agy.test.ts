import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agyAccountsForLabel,
  agyQuotaSnapshot,
  decodeAgyGenMetadata,
  decodeAgyStepMetadata,
  extractAgyTokens,
  maybeRefreshAgyQuota,
  maybeRefreshOmpAgyQuota,
  normalizeAgyModel,
  readAgy,
  readAgyCurrentAccount,
  readAgyQuotaFile,
  refreshAgyQuota,
  type AgyReaderReport,
} from "../src/collector/agy";
import type { CollectorConfig } from "../src/collector/config";
import { readNewSources } from "../src/collector/main";
import { CollectorState } from "../src/collector/state";
import type { UsageFact } from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { valueUsage } from "../src/domain/pricing";
import { quotaModelScope, quotaView } from "../src/domain/quota";
import { ingestToDomain } from "../src/server/ingest";
import type {
  IngestAccount,
  IngestQuota,
  IngestUsage,
} from "../src/shared/ingest";
import { LedgerStore } from "../src/storage/ledger";

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

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
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

function varintField(fieldNumber: number, value: number | bigint): Uint8Array {
  return concatBytes(encodeTag(fieldNumber, 0), encodeVarint(value));
}

function bytesField(fieldNumber: number, payload: Uint8Array): Uint8Array {
  return concatBytes(
    encodeTag(fieldNumber, 2),
    encodeVarint(payload.length),
    payload,
  );
}

function stringField(fieldNumber: number, text: string): Uint8Array {
  return bytesField(fieldNumber, new TextEncoder().encode(text));
}

function timestampMessage(seconds: number, nanos = 0): Uint8Array {
  return concatBytes(
    varintField(1, seconds),
    nanos > 0 ? varintField(2, nanos) : new Uint8Array(0),
  );
}

function buildGenMetadataFixture(options: {
  modelEnum?: number;
  responseModel?: string;
  modelDisplayName?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  apiProvider?: number;
  messageId?: string;
  thinkingOutputTokens?: number;
  responseOutputTokens?: number;
  serviceTier?: string;
  createdAtSeconds?: number;
  stepIndices?: number[];
  executionId?: string;
  error?: string;
}): string {
  const usageChunks: Uint8Array[] = [];
  if (options.modelEnum !== undefined)
    usageChunks.push(varintField(1, options.modelEnum));
  if (options.inputTokens !== undefined)
    usageChunks.push(varintField(2, options.inputTokens));
  if (options.outputTokens !== undefined)
    usageChunks.push(varintField(3, options.outputTokens));
  if (options.cacheWriteTokens !== undefined)
    usageChunks.push(varintField(4, options.cacheWriteTokens));
  if (options.cacheReadTokens !== undefined)
    usageChunks.push(varintField(5, options.cacheReadTokens));
  if (options.apiProvider !== undefined)
    usageChunks.push(varintField(6, options.apiProvider));
  if (options.messageId !== undefined)
    usageChunks.push(stringField(7, options.messageId));
  if (options.thinkingOutputTokens !== undefined)
    usageChunks.push(varintField(9, options.thinkingOutputTokens));
  if (options.responseOutputTokens !== undefined)
    usageChunks.push(varintField(10, options.responseOutputTokens));
  if (options.serviceTier !== undefined)
    usageChunks.push(stringField(13, options.serviceTier));

  const chatChunks: Uint8Array[] = [];
  if (options.modelEnum !== undefined)
    chatChunks.push(varintField(3, options.modelEnum));
  if (usageChunks.length > 0)
    chatChunks.push(bytesField(4, concatBytes(...usageChunks)));
  if (options.createdAtSeconds !== undefined) {
    const startMeta = bytesField(
      4,
      timestampMessage(options.createdAtSeconds, 250_000_000),
    );
    chatChunks.push(bytesField(9, startMeta));
  }
  if (options.responseModel !== undefined)
    chatChunks.push(stringField(19, options.responseModel));
  if (options.modelDisplayName !== undefined)
    chatChunks.push(stringField(21, options.modelDisplayName));

  const rootChunks: Uint8Array[] = [];
  if (chatChunks.length > 0)
    rootChunks.push(bytesField(1, concatBytes(...chatChunks)));
  for (const idx of options.stepIndices ?? []) {
    rootChunks.push(varintField(2, idx));
  }
  if (options.executionId !== undefined)
    rootChunks.push(stringField(4, options.executionId));
  if (options.error !== undefined)
    rootChunks.push(stringField(5, options.error));
  return Buffer.from(concatBytes(...rootChunks)).toString("base64");
}

function buildStepMetadataFixture(options: {
  createdAtSeconds?: number;
  finishedAtSeconds?: number;
  completedAtSeconds?: number;
  executionId?: string;
}): string {
  const chunks: Uint8Array[] = [];
  if (options.createdAtSeconds !== undefined) {
    chunks.push(
      bytesField(1, timestampMessage(options.createdAtSeconds, 100_000_000)),
    );
  }
  if (options.finishedAtSeconds !== undefined) {
    chunks.push(
      bytesField(7, timestampMessage(options.finishedAtSeconds, 500_000_000)),
    );
  }
  if (options.completedAtSeconds !== undefined) {
    chunks.push(
      bytesField(8, timestampMessage(options.completedAtSeconds, 900_000_000)),
    );
  }
  if (options.executionId !== undefined) {
    chunks.push(stringField(12, options.executionId));
  }
  return Buffer.from(concatBytes(...chunks)).toString("base64");
}

test("readAgyQuotaFile parses Gemini and Claude/GPT pools, expired windows, unknowns, and plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-agy-quota-"));
  try {
    const file = join(dir, "quota-alice.tsv");
    writeFileSync(
      file,
      [
        "gemini_5h\t22\t1793409600",
        "gemini_weekly\t15\t1793841600",
        "3p_5h\t19\t1793320000",
        "3p_weekly\t-\t1793841600",
        "plan\tGoogle AI Ultra\t-",
        "unknown_window\t50\t1793409600",
        "bad_row\t1001\t1793409600",
        "both_unknown\t-\t-",
      ].join("\n") + "\n",
    );
    const sampleDate = new Date("2026-10-30T14:00:00.000Z"); // 1793368800
    utimesSync(file, sampleDate, sampleDate);

    const parsed = readAgyQuotaFile(
      file,
      "alice",
      new Date("2026-10-30T14:05:00.000Z"),
    )!;
    expect(parsed.label).toBe("alice");
    expect(parsed.sampledAt).toBe("2026-10-30T14:00:00.000Z");
    expect(parsed.plan).toBe("Google AI Ultra");
    expect(parsed.ignoredLines).toBe(3);

    const byKey = new Map(parsed.entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("gemini_5h")).toEqual({
      key: "gemini_5h",
      pool: "gemini",
      accountExternalId: "agy-alice",
      window: "five-hour",
      windowMinutes: 300,
      percent: 22,
      resetsAt: "2026-10-31T01:20:00.000Z",
      expired: false,
    });
    expect(byKey.get("gemini_weekly")).toEqual({
      key: "gemini_weekly",
      pool: "gemini",
      accountExternalId: "agy-alice",
      window: "seven-day",
      windowMinutes: 10080,
      percent: 15,
      resetsAt: "2026-11-05T01:20:00.000Z",
      expired: false,
    });
    // 3p_5h reset (1793320000) is before file mtime (1793368800), so it is expired and percent is cleared to null
    expect(byKey.get("3p_5h")).toEqual({
      key: "3p_5h",
      pool: "3p",
      accountExternalId: "agy-alice",
      window: "five-hour-3p",
      windowMinutes: 300,
      percent: null,
      resetsAt: "2026-10-30T00:26:40.000Z",
      expired: true,
    });
    // 3p_weekly had "-" for percent and valid future reset
    expect(byKey.get("3p_weekly")).toEqual({
      key: "3p_weekly",
      pool: "3p",
      accountExternalId: "agy-alice",
      window: "seven-day-3p",
      windowMinutes: 10080,
      percent: null,
      resetsAt: "2026-11-05T01:20:00.000Z",
      expired: false,
    });

    const accounts = agyAccountsForLabel("alice", parsed.plan);
    expect(accounts.account).toEqual({
      externalId: "agy-alice",
      name: "Antigravity (alice)",
      platform: "google",
      kind: "subscription",
      plan: "Google AI Ultra",
      subjectKey: null,
    });
    // 早期按池拆开的两个账户指向合并后的账户，名下历史随之归过去。
    expect(
      accounts.legacy.map((a) => [a.externalId, a.parentExternalId]),
    ).toEqual([
      ["agy-alice-gemini", "agy-alice"],
      ["agy-alice-3p", "agy-alice"],
    ]);

    const snapshot = agyQuotaSnapshot(parsed);
    expect(snapshot.quotas).toHaveLength(4);
    const expiredQuota = snapshot.quotas.find(
      (q) => q.window === "five-hour-3p",
    )!;
    expect(expiredQuota.percent).toBeNull();
    const expiredView = quotaView(
      [
        {
          fact: {
            sourceId: "mac-test",
            externalId: "agy-alice:five-hour-3p",
            ...expiredQuota,
          },
          collectedAt: "2026-10-30T14:05:00.000Z",
        },
      ],
      () => ({ usd: null, credits: null }),
      "2026-10-30T14:05:00.000Z",
    )!;
    expect(expiredView.state).toBe("expired");
    expect(expiredView.startsAt).toBeNull();
    expect(expiredView.estimate.reason).toBe("expired");

    const unknownPercentQuota = snapshot.quotas.find(
      (q) => q.window === "seven-day-3p",
    )!;
    expect(unknownPercentQuota.percent).toBeNull();
    const unknownPercentView = quotaView(
      [
        {
          fact: {
            sourceId: "mac-test",
            externalId: "agy-alice:seven-day-3p",
            ...unknownPercentQuota,
          },
          collectedAt: "2026-10-30T14:05:00.000Z",
        },
      ],
      () => ({ usd: null, credits: null }),
      "2026-10-30T14:05:00.000Z",
    )!;
    expect(unknownPercentView.percent).toBeNull();
    expect(unknownPercentView.estimate.reason).toBe("percent-unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decodeAgyGenMetadata decodes wire fields, mutually exclusive buckets, and unknown values", () => {
  const b64 = buildGenMetadataFixture({
    modelEnum: 1008,
    responseModel: "gemini-4-argon",
    modelDisplayName: "Gemini 4 Argon (High)",
    inputTokens: 12_500,
    outputTokens: 1_500,
    cacheWriteTokens: 0,
    cacheReadTokens: 80_000,
    apiProvider: 24,
    messageId: "bot-exec-1",
    thinkingOutputTokens: 900,
    responseOutputTokens: 600,
    serviceTier: "standard",
    createdAtSeconds: 1_793_368_800,
    stepIndices: [5, 6],
    executionId: "11111111-2222-3333-4444-555555555555",
  });

  const decoded = decodeAgyGenMetadata(b64);
  expect(decoded.executionId).toBe("11111111-2222-3333-4444-555555555555");
  expect(decoded.stepIndices).toEqual([5, 6]);
  expect(decoded.chatModel?.responseModel).toBe("gemini-4-argon");
  expect(decoded.chatModel?.modelDisplayName).toBe("Gemini 4 Argon (High)");
  expect(decoded.chatModel?.createdAt).toBe("2026-10-30T14:00:00.250Z");

  const extracted = extractAgyTokens(decoded);
  expect(extracted).toEqual({
    kind: "usage",
    tier: "standard",
    tokens: {
      input: 12_500,
      cacheRead: 80_000,
      cacheWrite: 0,
      output: 1_500,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: 900,
    },
  });

  // Missing fields must remain null (never zero-filled)
  const partialB64 = buildGenMetadataFixture({
    responseModel: "claude-opus-5-5-medium",
    outputTokens: 400,
  });
  const partialDecoded = decodeAgyGenMetadata(partialB64);
  expect(extractAgyTokens(partialDecoded)).toEqual({
    kind: "usage",
    tier: null,
    tokens: {
      input: null,
      cacheRead: null,
      cacheWrite: null,
      output: 400,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
  });

  // When responseOutputTokens is present and equals outputTokens while thinkingOutputTokens is omitted (0), reasoning is 0
  const zeroThinkingB64 = buildGenMetadataFixture({
    responseModel: "gemini-3.8-flash-n",
    inputTokens: 1_000,
    outputTokens: 250,
    responseOutputTokens: 250,
  });
  const zeroThinkingDecoded = decodeAgyGenMetadata(zeroThinkingB64);
  expect(extractAgyTokens(zeroThinkingDecoded)).toEqual({
    kind: "usage",
    tier: null,
    tokens: {
      input: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 250,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: 0,
    },
  });
});

test("normalizeAgyModel maps all Antigravity models and prices them through defaultPriceBook", () => {
  expect(
    normalizeAgyModel({
      responseModel: "gemini-4-hydrogen-xhigh",
      modelDisplayName: "Gemini 4 Hydrogen (XHigh)",
      modelEnum: 1528,
    }),
  ).toEqual({
    model: "gemini-4-hydrogen",
    upstreamModel: "gemini-4-hydrogen-xhigh",
    reasoningEffort: "xhigh",
  });
  expect(
    normalizeAgyModel({
      responseModel: null,
      modelDisplayName: "Gemini 4 Hydrogen (Low)",
      modelEnum: null,
    }),
  ).toEqual({
    model: "gemini-4-hydrogen",
    upstreamModel: null,
    reasoningEffort: "low",
  });
  expect(
    normalizeAgyModel({
      responseModel: null,
      modelDisplayName: null,
      modelEnum: 1526,
    }),
  ).toEqual({
    model: "gemini-4-hydrogen",
    upstreamModel: null,
    reasoningEffort: "medium",
  });
  expect(
    normalizeAgyModel({
      responseModel: "gemini-3.8-flash-tiered",
      modelDisplayName: null,
      modelEnum: 1322,
    }),
  ).toEqual({
    model: "gemini-3.8-flash",
    upstreamModel: "gemini-3.8-flash-tiered",
    reasoningEffort: "high",
  });
  expect(
    normalizeAgyModel({
      responseModel: "gemini-4-carbon-medium",
      modelDisplayName: "Gemini 4 Carbon (Medium)",
      modelEnum: 1437,
    }),
  ).toEqual({
    model: "gemini-4-carbon",
    upstreamModel: "gemini-4-carbon-medium",
    reasoningEffort: "medium",
  });
  expect(
    normalizeAgyModel({
      responseModel: null,
      modelDisplayName: "Gemini 4 Carbon (High)",
      modelEnum: null,
    }),
  ).toEqual({
    model: "gemini-4-carbon",
    upstreamModel: null,
    reasoningEffort: "high",
  });
  expect(
    normalizeAgyModel({
      responseModel: null,
      modelDisplayName: null,
      modelEnum: 1438,
    }),
  ).toEqual({
    model: "gemini-4-carbon",
    upstreamModel: null,
    reasoningEffort: "low",
  });
  expect(
    normalizeAgyModel({
      responseModel: "gemini-4-argon",
      modelDisplayName: "Gemini 4 Argon (High)",
      modelEnum: 1008,
    }),
  ).toEqual({
    model: "gemini-4-argon",
    upstreamModel: null,
    reasoningEffort: "high",
  });
  expect(
    normalizeAgyModel({
      responseModel: "gemini-3.8-flash-n",
      modelDisplayName: "Gemini 3.8 Flash",
      modelEnum: 1018,
    }),
  ).toEqual({
    model: "gemini-3.8-flash",
    upstreamModel: "gemini-3.8-flash-n",
    reasoningEffort: "none",
  });
  expect(
    normalizeAgyModel({
      responseModel: "claude-opus-5-5-medium",
      modelDisplayName: "Claude Opus 5.5 (Medium)",
      modelEnum: 1043,
    }),
  ).toEqual({
    model: "claude-opus-5-5",
    upstreamModel: "claude-opus-5-5-medium",
    reasoningEffort: "medium",
  });
  expect(
    normalizeAgyModel({
      responseModel: "claude-sonnet-5-5-low",
      modelDisplayName: "Claude Sonnet 5.5 (Low)",
      modelEnum: 1045,
    }),
  ).toEqual({
    model: "claude-sonnet-5-5",
    upstreamModel: "claude-sonnet-5-5-low",
    reasoningEffort: "low",
  });
  expect(
    normalizeAgyModel({
      responseModel: "gpt-oss-120b",
      modelDisplayName: "GPT-OSS 120B (Medium)",
      modelEnum: 342,
    }),
  ).toEqual({
    model: "gpt-oss-120b",
    upstreamModel: null,
    reasoningEffort: "medium",
  });
  expect(
    normalizeAgyModel({
      responseModel: "claude-opus-4-6-thinking",
      modelDisplayName: "Claude Opus 4.6 (Thinking)",
      modelEnum: 1026,
    }),
  ).toEqual({
    model: "claude-opus-4-6",
    upstreamModel: "claude-opus-4-6-thinking",
    reasoningEffort: null,
  });
  expect(
    normalizeAgyModel({
      responseModel: null,
      modelDisplayName: null,
      modelEnum: 1008,
    }),
  ).toEqual({
    model: "gemini-4-argon",
    upstreamModel: null,
    reasoningEffort: "high",
  });

  // 合并后的账户里，Gemini 池窗口只计 Gemini 模型，第三方池窗口只计其余模型。
  const gemini = quotaModelScope("seven-day", true)!;
  const thirdParty = quotaModelScope("seven-day-3p")!;
  for (const model of [
    "gemini-4-hydrogen",
    "gemini-4-carbon",
    "gemini-4-argon",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
  ]) {
    expect([gemini(model), thirdParty(model)]).toEqual([true, false]);
  }
  for (const model of [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "gpt-oss-120b",
  ]) {
    expect([gemini(model), thirdParty(model)]).toEqual([false, true]);
  }
  // 没有第三方池的账户，5 小时与周窗口仍覆盖全部请求。
  expect(quotaModelScope("seven-day")).toBeNull();

  for (const model of [
    "gemini-4-hydrogen",
    "gemini-4-carbon",
    "gemini-4-argon",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-opus-4-6",
    "gpt-oss-120b",
  ]) {
    const fact: UsageFact = {
      sourceId: "mac-test",
      externalId: `test-${model}`,
      accountExternalId: "agy-alice",
      occurredAt: "2026-10-30T14:00:00.000Z",
      model,
      upstreamModel: null,
      tier: "standard",
      tokens: {
        input: 100_000,
        cacheRead: model === "gpt-oss-120b" ? 0 : 50_000,
        cacheWrite: 0,
        output: 20_000,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: 5_000,
      },
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
      metadata: { origin: "agy_local" },
    };
    const valuation = valueUsage(fact, defaultPriceBook);
    expect(valuation.subscriptionUsd.basis).toBe("estimated");
    expect(valuation.subscriptionUsd.amount).not.toBeNull();
    expect(valuation.apiUsd.basis).toBe("estimated");
    expect(valuation.apiUsd.amount).not.toBeNull();
  }
});

test("readAgy ingests quota and SQLite conversations idempotently and attributes pools", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-agy-e2e-"));
  const convDir = join(dir, "conversations");
  const statusDir = join(dir, "statusline");
  try {
    mkdirSync(convDir, { recursive: true });
    mkdirSync(statusDir, { recursive: true });

    writeFileSync(join(statusDir, "current-account"), "alice\n");
    const quotaPath = join(statusDir, "quota-alice.tsv");
    writeFileSync(
      quotaPath,
      [
        "gemini_5h\t14\t1793409600",
        "gemini_weekly\t8\t1793841600",
        "3p_5h\t25\t1793409600",
        "3p_weekly\t11\t1793841600",
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );
    const sampleDate = new Date("2026-10-30T14:00:00.000Z");
    utimesSync(quotaPath, sampleDate, sampleDate);

    const dbPath = join(convDir, "conv-1.db");
    const db = new Database(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        type TEXT,
        status TEXT,
        metadata TEXT
      );
      CREATE TABLE gen_metadata (
        idx INTEGER,
        execution_id TEXT,
        data TEXT
      );
    `);

    const execGemini = "aaaa1111-2222-3333-4444-555555555555";
    const execClaude = "bbbb1111-2222-3333-4444-555555555555";
    const stepMetaGemini = buildStepMetadataFixture({
      createdAtSeconds: 1_793_368_800,
      finishedAtSeconds: 1_793_368_805,
      completedAtSeconds: 1_793_368_806,
      executionId: execGemini,
    });
    const stepMetaClaude = buildStepMetadataFixture({
      createdAtSeconds: 1_793_368_900,
      finishedAtSeconds: 1_793_368_910,
      completedAtSeconds: 1_793_368_912,
      executionId: execClaude,
    });
    db.query(
      "INSERT INTO steps (idx, type, status, metadata) VALUES (?1, ?2, ?3, ?4)",
    ).run(1, "CORTEX_STEP_TYPE_PLANNER_RESPONSE", "DONE", stepMetaGemini);
    db.query(
      "INSERT INTO steps (idx, type, status, metadata) VALUES (?1, ?2, ?3, ?4)",
    ).run(2, "CORTEX_STEP_TYPE_PLANNER_RESPONSE", "DONE", stepMetaClaude);

    const genGemini = buildGenMetadataFixture({
      modelEnum: 1008,
      responseModel: "gemini-4-argon",
      modelDisplayName: "Gemini 4 Argon (High)",
      inputTokens: 10_000,
      outputTokens: 1_200,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 0,
      thinkingOutputTokens: 700,
      responseOutputTokens: 500,
      messageId: "bot-gemini-1",
      executionId: execGemini,
      stepIndices: [1],
    });
    const genClaude = buildGenMetadataFixture({
      modelEnum: 1043,
      responseModel: "claude-opus-5-5-medium",
      modelDisplayName: "Claude Opus 5.5 (Medium)",
      inputTokens: 4_000,
      outputTokens: 800,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 1_500,
      thinkingOutputTokens: 300,
      responseOutputTokens: 500,
      messageId: "bot-claude-1",
      executionId: execClaude,
      stepIndices: [2],
    });

    db.query(
      "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (?1, ?2, ?3)",
    ).run(1, execGemini, genGemini);
    db.query(
      "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (?1, ?2, ?3)",
    ).run(2, execClaude, genClaude);

    // Keep db open in WAL mode to simulate agy running while collector reads
    const state = new CollectorState(":memory:");
    try {
      expect(readAgyCurrentAccount(statusDir)).toBe("alice");
      expect(decodeAgyStepMetadata(stepMetaGemini).completedAt).toBe(
        "2026-10-30T14:00:06.900Z",
      );

      const sources = {
        conversationsDir: convDir,
        statuslineDir: statusDir,
        start: "2026-09-20T00:00:00.000Z",
      };
      const first = readAgy(
        state,
        sources,
        new Date("2026-10-30T14:05:00.000Z"),
      );
      expect(first).toEqual({
        source: "agy",
        read: 2,
        recorded: 2,
        skipped: {},
        invalid: 0,
        filesRead: 1,
        beforeStart: 0,
        unreadable: 0,
        quotas: 4,
        quotaIgnoredLines: 0,
        activeAccount: "alice",
        quotaRefreshed: false,
        quotaRefreshError: null,
      });

      const pendingCounts = state.pendingCounts();
      expect(pendingCounts.account).toBe(3);
      expect(pendingCounts.quota).toBe(4);
      expect(pendingCounts.usage).toBe(2);
      expect(state.sourcePendingCounts().agy).toBe(2);

      // Re-running without changes is a no-op (idempotent)
      const second = readAgy(
        state,
        sources,
        new Date("2026-10-30T14:06:00.000Z"),
      );
      expect(second.read).toBe(0);
      expect(second.recorded).toBe(0);
      expect(state.pendingCounts().usage).toBe(2);

      // Even if agy_files cursor is cleared, re-reading produces identical deterministic IDs and does not duplicate outbox items
      state.db.exec("DELETE FROM agy_files");
      const third = readAgy(
        state,
        sources,
        new Date("2026-10-30T14:07:00.000Z"),
      );
      expect(third.read).toBe(2);
      expect(third.recorded).toBe(0);
      expect(state.pendingCounts().usage).toBe(2);

      const store = new LedgerStore(":memory:", defaultPriceBook);
      try {
        const accounts = state
          .pending<IngestAccount>("account", 10)
          .map((item) => item.payload);
        const quotas = state
          .pending<IngestQuota>("quota", 10)
          .map((item) => item.payload);
        const usage = state
          .pending<IngestUsage>("usage", 10)
          .map((item) => item.payload);

        expect(accounts.map((a) => a.externalId).sort()).toEqual([
          "agy-alice",
          "agy-alice-3p",
          "agy-alice-gemini",
        ]);
        const geminiEvent = usage.find((u) => u.model === "gemini-4-argon")!;
        expect(geminiEvent.accountExternalId).toBe("agy-alice");
        expect(geminiEvent.tokens).toEqual({
          input: 10_000,
          cacheRead: 50_000,
          cacheWrite: 0,
          output: 1_200,
          cacheWrite5m: null,
          cacheWrite1h: null,
          reasoning: 700,
        });
        const claudeEvent = usage.find((u) => u.model === "claude-opus-5-5")!;
        expect(claudeEvent.accountExternalId).toBe("agy-alice");
        expect(claudeEvent.tokens).toEqual({
          input: 4_000,
          cacheRead: 20_000,
          cacheWrite: 1_500,
          output: 800,
          cacheWrite5m: null,
          cacheWrite1h: null,
          reasoning: 300,
        });

        const domainBatch = ingestToDomain("mac-test", {
          schemaVersion: 1,
          sourceId: "mac-test",
          batchId: "00000000-0000-4000-8000-000000000001",
          collector: { name: "meterleaf-collector", version: "0.1.0" },
          accounts,
          quotas,
          usage,
        });
        store.saveIngestBatch(
          "mac-test",
          domainBatch,
          "2026-10-30T14:08:00.000Z",
        );
        const metricsAfterFirst = store.reportUsageMetrics();
        expect(metricsAfterFirst).toHaveLength(2);
        expect(
          metricsAfterFirst.every(
            (m) => m.subscriptionUsd !== null && m.apiUsd !== null,
          ),
        ).toBe(true);

        // Re-ingesting the same batch into LedgerStore is idempotent
        store.saveIngestBatch(
          "mac-test",
          domainBatch,
          "2026-10-30T14:09:00.000Z",
        );
        expect(store.reportUsageMetrics()).toHaveLength(2);
      } finally {
        store.close();
      }
    } finally {
      state.close();
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 额度按需刷新 ----

const usageJson = (fractions: Record<string, number>) =>
  JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            buckets: Object.entries(fractions).map(([id, remaining]) => ({
              id,
              remaining_fraction: remaining,
              reset_time: "2100-01-01T00:00:00Z",
            })),
          },
        ],
      },
    },
  });

/** 替身 agy：记录被调用次数，把给定内容当作 /usage 输出，并按需往 --log-file 写登录日志。 */
function fakeAgy(
  dir: string,
  behaviour: {
    output?: string;
    exitCode?: number;
    loggedInAs?: string;
    hang?: boolean;
  },
) {
  const marker = join(dir, "calls");
  const script = join(dir, "agy");
  const outputFile = join(dir, "fake-output.json");
  writeFileSync(outputFile, behaviour.output ?? "");
  writeFileSync(
    script,
    `#!/bin/sh
echo run >> '${marker}'
while [ $# -gt 0 ]; do
  [ "$1" = "--log-file" ] && log="$2"
  shift
done
${behaviour.loggedInAs ? `echo "I OAuth: authenticated successfully as ${behaviour.loggedInAs}" > "$log"` : ""}
${behaviour.hang ? "sleep 30" : `cat '${outputFile}'`}
exit ${behaviour.exitCode ?? 0}
`,
    { mode: 0o755 },
  );
  return {
    script,
    calls: () => {
      try {
        return readFileSync(marker, "utf8").trim().split("\n").length;
      } catch {
        return 0;
      }
    },
  };
}

function refreshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-agy-refresh-"));
  const statuslineDir = join(dir, "statusline");
  const scratch = join(dir, "tmp");
  mkdirSync(statuslineDir);
  mkdirSync(scratch);
  const quota = join(statuslineDir, "quota-alice.tsv");
  return {
    dir,
    statuslineDir,
    scratch,
    quota,
    sources: {
      conversationsDir: join(dir, "none"),
      statuslineDir,
      start: "2026-09-20T00:00:00.000Z",
    },
  };
}
const longAgo = new Date("2026-10-30T00:00:00.000Z");
const staleQuota = [
  "gemini_5h\t90\t1793409600",
  "gemini_weekly\t80\t1793841600",
  "3p_5h\t10\t1793409600",
  "3p_weekly\t5\t1793841600",
  "plan\tGoogle AI Ultra\t-",
].join("\n");

test("maybeRefreshAgyQuota runs agy, keeps the plan row, and replaces only refreshed windows atomically", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    writeFileSync(w.quota, staleQuota + "\n");
    utimesSync(w.quota, longAgo, longAgo);
    writeFileSync(join(w.statuslineDir, "current-account"), "alice\n");
    const agy = fakeAgy(w.dir, {
      output: usageJson({
        "gemini-5h": 0.885,
        "gemini-weekly": 0.7355,
        "3p-weekly": 0.9884,
      }),
      loggedInAs: "Alice@example.com",
    });
    const now = new Date("2026-10-31T12:00:00.000Z");
    process.env.TMPDIR = w.scratch;
    const result = await maybeRefreshAgyQuota(state, w.sources, now, {
      agyBin: agy.script,
    });
    expect(result).toMatchObject({
      attempted: true,
      refreshed: true,
      label: "alice",
      error: null,
    });
    expect(agy.calls()).toBe(1);
    // 没刷到的 3p_5h 与 plan 行原样保留，刷到的窗口换成新值（已用百分比取整）。
    expect(readFileSync(w.quota, "utf8")).toBe(
      [
        "gemini_5h\t12\t4102444800",
        "gemini_weekly\t26\t4102444800",
        "3p_5h\t10\t1793409600",
        "3p_weekly\t1\t4102444800",
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );
    expect(readdirSync(w.statuslineDir).sort()).toEqual([
      "current-account",
      "quota-alice.tsv",
    ]);
    expect(readdirSync(w.scratch)).toEqual([]);
    expect(state.getMeta("agy_quota_refresh_at")).toBe(now.toISOString());

    // 5 分钟内即使仍有新用量也不再启动 agy。
    const soon = new Date(now.getTime() + 4 * 60_000);
    utimesSync(w.quota, longAgo, longAgo);
    expect(
      await maybeRefreshAgyQuota(state, w.sources, soon, {
        agyBin: agy.script,
      }),
    ).toMatchObject({ attempted: false, refreshed: false });
    expect(agy.calls()).toBe(1);
    const later = new Date(now.getTime() + 5 * 60_000);
    expect(
      (
        await maybeRefreshAgyQuota(state, w.sources, later, {
          agyBin: agy.script,
        })
      ).refreshed,
    ).toBe(true);
    expect(agy.calls()).toBe(2);
  } finally {
    delete process.env.TMPDIR;
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("maybeRefreshAgyQuota skips when the status line just wrote the cache", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    const now = new Date("2026-10-31T12:00:00.000Z");
    writeFileSync(w.quota, staleQuota + "\n");
    writeFileSync(join(w.statuslineDir, "current-account"), "alice\n");
    const fresh = new Date(now.getTime() - 2 * 60_000);
    utimesSync(w.quota, fresh, fresh);
    const agy = fakeAgy(w.dir, { output: usageJson({ "gemini-5h": 0.5 }) });
    expect(
      await maybeRefreshAgyQuota(state, w.sources, now, {
        agyBin: agy.script,
      }),
    ).toMatchObject({ attempted: false });
    expect(agy.calls()).toBe(0);
    // 跳过不算一次尝试，之后缓存变旧就能刷新。
    expect(state.getMeta("agy_quota_refresh_at")).toBeNull();
    const stale = new Date(now.getTime() + 4 * 60_000);
    expect(
      (
        await maybeRefreshAgyQuota(state, w.sources, stale, {
          agyBin: agy.script,
        })
      ).refreshed,
    ).toBe(true);
  } finally {
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("a failed probe leaves the cache untouched, leaves no temp files, and backs off for 5 minutes", async () => {
  const failures: { name: string; behaviour: Parameters<typeof fakeAgy>[1] }[] =
    [
      { name: "exit", behaviour: { exitCode: 1, output: "" } },
      { name: "not json", behaviour: { output: "oops" } },
      {
        name: "not success",
        behaviour: { output: JSON.stringify({ status: "ERROR" }) },
      },
      {
        name: "no usable bucket",
        behaviour: { output: usageJson({ "gemini-5h": 1.5, other: 0.5 }) },
      },
      {
        name: "unknown account",
        behaviour: { output: usageJson({ "gemini-5h": 0.5 }) },
      },
    ];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  for (const [index, { name, behaviour }] of failures.entries()) {
    const w = refreshWorkspace();
    const state = new CollectorState(":memory:");
    try {
      if (name !== "unknown account") {
        writeFileSync(w.quota, staleQuota + "\n");
        writeFileSync(join(w.statuslineDir, "current-account"), "alice\n");
        utimesSync(w.quota, longAgo, longAgo);
      }
      const agy = fakeAgy(w.dir, behaviour);
      process.env.TMPDIR = w.scratch;
      const now = new Date("2026-10-31T12:00:00.000Z");
      const result = await maybeRefreshAgyQuota(state, w.sources, now, {
        agyBin: agy.script,
      });
      expect(result.refreshed, name).toBe(false);
      expect(result.error, name).not.toBeNull();
      if (name !== "unknown account")
        expect(readFileSync(w.quota, "utf8"), name).toBe(staleQuota + "\n");
      expect(readdirSync(w.scratch), name).toEqual([]);
      expect(state.getMeta("agy_quota_refresh_at"), name).toBe(
        now.toISOString(),
      );
      await maybeRefreshAgyQuota(
        state,
        w.sources,
        new Date(now.getTime() + 60_000),
        { agyBin: agy.script },
      );
      expect(agy.calls(), name).toBe(1);
      // 同一个错误只记一行日志。
      expect(logged, name).toHaveBeenCalledTimes(index + 1);
    } finally {
      delete process.env.TMPDIR;
      state.close();
      rmSync(w.dir, { recursive: true, force: true });
    }
  }
  logged.mockRestore();
});

test("a probe that hangs is killed at the deadline and a missing agy is reported", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    writeFileSync(w.quota, staleQuota + "\n");
    writeFileSync(join(w.statuslineDir, "current-account"), "alice\n");
    utimesSync(w.quota, longAgo, longAgo);
    const agy = fakeAgy(w.dir, { hang: true });
    const started = Date.now();
    const hung = await refreshAgyQuota(w.sources, {
      agyBin: agy.script,
      timeoutMs: 300,
    });
    expect(hung.error).toContain("超时");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readFileSync(w.quota, "utf8")).toBe(staleQuota + "\n");

    const missing = await refreshAgyQuota(w.sources, {
      agyBin: join(w.dir, "absent"),
    });
    expect(missing).toMatchObject({ attempted: false, refreshed: false });
    expect(missing.error).toContain("agy");
  } finally {
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

/** 一个 omp 会话文件，里面有一条新的 Antigravity 请求。 */
function ompSession(dir: string, id: string) {
  const sessionsDir = join(dir, "omp");
  mkdirSync(join(sessionsDir, "-work"), { recursive: true });
  const path = join(sessionsDir, "-work", "s.jsonl");
  const event = {
    type: "message",
    id,
    timestamp: "2026-10-30T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: "google-antigravity",
      model: "gemini-4-argon",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    },
  };
  appendFileSync(path, JSON.stringify(event) + "\n");
  return sessionsDir;
}

function syncConfig(w: ReturnType<typeof refreshWorkspace>, omp: string) {
  return {
    server: "https://meterleaf.example.com",
    sourceId: "claude-code-mac",
    key: "mlk_test",
    createdAt: "2026-10-30T00:00:00Z",
    codex: { enabled: false },
    opencode: { enabled: false },
    agy: {
      enabled: true,
      conversationsDir: w.sources.conversationsDir,
      statuslineDir: w.statuslineDir,
    },
    omp: { enabled: true, sessionsDir: omp },
  } as CollectorConfig;
}

test("sync refreshes quota through omp when omp brings new Antigravity usage, uploads both together, and scan never does", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    writeFileSync(w.quota, staleQuota + "\n");
    writeFileSync(join(w.statuslineDir, "current-account"), "alice\n");
    utimesSync(w.quota, longAgo, longAgo);
    const agy = fakeAgy(w.dir, { output: usageJson({ "gemini-5h": 0.9 }) });
    const omp = fakeOmp(
      w.dir,
      JSON.stringify({
        reports: [ompReport("alice@example.com", { "gemini-5h": 0.5 })],
      }),
    );
    process.env.AGY_BIN = agy.script;
    process.env.OMP_BIN = omp.script;
    const config = syncConfig(w, ompSession(w.dir, "m1"));

    // scan 只读：有新用量也不运行 agy 或 omp。
    const scanState = new CollectorState(":memory:");
    try {
      await readNewSources(scanState, config, { allowQuotaRefresh: false });
      expect(agy.calls()).toBe(0);
      expect(omp.calls()).toEqual([]);
    } finally {
      scanState.close();
    }

    const reports = await readNewSources(state, config, {
      allowQuotaRefresh: true,
    });
    // omp 的用量只经 omp 刷新，agy 留给它自己的会话。
    expect(omp.calls()).toEqual(["--json"]);
    expect(agy.calls()).toBe(0);
    const agyReport = reports.find((item) => item.source === "agy") as
      AgyReaderReport | undefined;
    expect(agyReport).toMatchObject({
      quotaRefreshed: true,
      quotaRefreshError: null,
    });
    // 刷出的新额度和这批 omp 用量在同一轮进入待发送队列。
    expect(state.sourcePendingCounts().omp).toBe(1);
    const quotas = state
      .pending<IngestQuota>("quota", 100)
      .map((item) => item.payload);
    expect(quotas.filter((q) => q.window === "five-hour").at(-1)?.percent).toBe(
      50,
    );
    expect(readFileSync(w.quota, "utf8")).toContain("plan\tGoogle AI Ultra\t-");

    // 之后又有新用量，但距上次尝试不足 5 分钟，不再运行 omp。
    ompSession(w.dir, "m2");
    await readNewSources(state, config, { allowQuotaRefresh: true });
    expect(omp.calls()).toEqual(["--json"]);
    expect(state.sourcePendingCounts().omp).toBe(2);
  } finally {
    delete process.env.AGY_BIN;
    delete process.env.OMP_BIN;
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("sync does not run omp or agy when nothing new from Antigravity arrived", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    writeFileSync(w.quota, staleQuota + "\n");
    writeFileSync(join(w.statuslineDir, "current-account"), "alice\n");
    utimesSync(w.quota, longAgo, longAgo);
    const agy = fakeAgy(w.dir, { output: usageJson({ "gemini-5h": 0.5 }) });
    const omp = fakeOmp(
      w.dir,
      JSON.stringify({
        reports: [ompReport("alice@example.com", { "gemini-5h": 0.5 })],
      }),
    );
    process.env.AGY_BIN = agy.script;
    process.env.OMP_BIN = omp.script;
    const config = syncConfig(w, ompSession(w.dir, "m1"));
    // 第一轮把用量读完并刷新，第二轮没有新请求，即使节流时间已过也不运行。
    await readNewSources(state, config, { allowQuotaRefresh: true });
    expect(omp.calls()).toEqual(["--json"]);
    state.setMeta(
      "omp_agy_quota_refresh_at",
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );
    await readNewSources(state, config, { allowQuotaRefresh: true });
    expect(omp.calls()).toEqual(["--json"]);
    expect(agy.calls()).toBe(0);
  } finally {
    delete process.env.AGY_BIN;
    delete process.env.OMP_BIN;
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("a first-time omp Antigravity request is held until the refresh reveals the account, then recorded in the same round", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    const agy = fakeAgy(w.dir, {
      output: usageJson({ "gemini-5h": 0.5, "3p-5h": 0.9 }),
      loggedInAs: "Bob@example.com",
    });
    // omp 账号库不可用时只能靠 agy 补上 current-account。
    const fakeOmpBin = fakeOmp(w.dir, JSON.stringify({ reports: [] }));
    process.env.AGY_BIN = agy.script;
    process.env.OMP_BIN = fakeOmpBin.script;
    const config = syncConfig(w, ompSession(w.dir, "m1"));
    const reports = await readNewSources(state, config, {
      allowQuotaRefresh: true,
    });
    expect(agy.calls()).toBe(1);
    expect(readFileSync(join(w.statuslineDir, "current-account"), "utf8")).toBe(
      "bob\n",
    );
    expect(readFileSync(join(w.statuslineDir, "quota-bob.tsv"), "utf8")).toBe(
      "gemini_5h\t50\t4102444800\n3p_5h\t10\t4102444800\n",
    );
    const omp = reports.find((item) => item.source === "omp")!;
    expect(omp).toMatchObject({ read: 1, recorded: 1, skipped: {} });
    expect(
      state.pending<IngestUsage>("usage", 10)[0]?.payload.accountExternalId,
    ).toBe("agy-bob");
    expect(
      state
        .pending<IngestQuota>("quota", 10)
        .map((item) => item.payload.window),
    ).toEqual(["five-hour", "five-hour-3p"]);
  } finally {
    delete process.env.AGY_BIN;
    delete process.env.OMP_BIN;
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

/** 仿 omp：记录每次调用的子命令，usage --json 时输出给定的报告。 */
function fakeOmp(dir: string, output: string) {
  const marker = join(dir, "omp-calls");
  const script = join(dir, "fake-omp");
  const outputFile = join(dir, "omp-output.json");
  writeFileSync(outputFile, output);
  writeFileSync(
    script,
    `#!/bin/sh
echo "$2" >> '${marker}'
[ "$2" = "--json" ] && cat '${outputFile}'
exit 0
`,
    { mode: 0o755 },
  );
  return {
    script,
    calls: () => {
      try {
        return readFileSync(marker, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
  };
}

function ompReport(email: string, used: Record<string, number>) {
  return {
    provider: "google-antigravity",
    fetchedAt: 1793702034369,
    metadata: { email, projectId: "p" },
    limits: Object.entries(used).flatMap(([bucket, fraction]) =>
      // 第三方池在 omp 里按 anthropic 与 openai 各列一次，数值相同。
      (bucket.startsWith("3p") ? ["anthropic", "openai"] : ["google"]).map(
        (family) => ({
          id: `google-antigravity:${family}:default:${bucket}`,
          window: { resetsAt: 4102444800000 },
          amount: { remainingFraction: 1 - fraction },
        }),
      ),
    ),
  };
}

test("maybeRefreshOmpAgyQuota writes every Google account omp holds and reads live after a 429", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    writeFileSync(w.quota, staleQuota + "\n");
    const omp = fakeOmp(
      w.dir,
      JSON.stringify({
        generatedAt: 1793702335550,
        reports: [
          ompReport("Alice@example.com", {
            "gemini-5h": 0.115,
            "gemini-weekly": 1,
            "3p-weekly": 0.0116,
          }),
          ompReport("bob@example.com", { "gemini-5h": 0.02 }),
          { provider: "anthropic", metadata: { email: "c@example.com" } },
        ],
      }),
    );
    process.env.TMPDIR = w.scratch;
    const now = new Date("2026-10-31T12:00:00.000Z");
    const result = await maybeRefreshOmpAgyQuota(
      state,
      w.sources,
      { exhausted: false },
      now,
      { ompBin: omp.script },
    );
    expect(result).toMatchObject({
      attempted: true,
      refreshed: true,
      labels: ["alice", "bob"],
      error: null,
    });
    // 平时读 omp 自己的缓存，不让它重新请求。
    expect(omp.calls()).toEqual(["--json"]);
    expect(readFileSync(w.quota, "utf8")).toBe(
      [
        "gemini_5h\t12\t4102444800",
        "gemini_weekly\t100\t4102444800",
        "3p_5h\t10\t1793409600",
        "3p_weekly\t1\t4102444800",
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );
    expect(readFileSync(join(w.statuslineDir, "quota-bob.tsv"), "utf8")).toBe(
      "gemini_5h\t2\t4102444800\n",
    );
    // omp 刷新不改 agy 的 current-account。
    expect(readdirSync(w.statuslineDir).sort()).toEqual([
      "quota-alice.tsv",
      "quota-bob.tsv",
    ]);
    expect(readdirSync(w.scratch)).toEqual([]);

    // 普通用量 5 分钟内不再调用；额度用完的 429 一分钟后就丢弃缓存读实时值。
    const soon = new Date(now.getTime() + 60_000);
    expect(
      (
        await maybeRefreshOmpAgyQuota(
          state,
          w.sources,
          { exhausted: false },
          soon,
          {
            ompBin: omp.script,
          },
        )
      ).attempted,
    ).toBe(false);
    const halfMinute = new Date(now.getTime() + 30_000);
    expect(
      (
        await maybeRefreshOmpAgyQuota(
          state,
          w.sources,
          { exhausted: true },
          halfMinute,
          { ompBin: omp.script },
        )
      ).attempted,
    ).toBe(false);
    expect(
      (
        await maybeRefreshOmpAgyQuota(
          state,
          w.sources,
          { exhausted: true },
          soon,
          {
            ompBin: omp.script,
          },
        )
      ).refreshed,
    ).toBe(true);
    expect(omp.calls()).toEqual(["--json", "invalidate", "--json"]);
  } finally {
    delete process.env.TMPDIR;
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("maybeRefreshOmpAgyQuota reports an unusable omp answer and leaves the caches alone", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    writeFileSync(w.quota, staleQuota + "\n");
    const omp = fakeOmp(w.dir, JSON.stringify({ reports: [] }));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await maybeRefreshOmpAgyQuota(
        state,
        w.sources,
        { exhausted: true },
        new Date("2026-10-31T12:00:00.000Z"),
        { ompBin: omp.script },
      );
      expect(result).toMatchObject({ refreshed: false });
      expect(result.error).toContain("没有可用的 Antigravity 额度");
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
    expect(readFileSync(w.quota, "utf8")).toBe(staleQuota + "\n");
  } finally {
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("readAgy and maybeRefreshAgyQuota discover extra antigravity-cli-<name> profiles, isolate accounts, and preserve agy_files across instances", async () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-multi-"));
  const geminiDir = join(root, ".gemini");
  const defaultConvDir = join(geminiDir, "antigravity-cli", "conversations");
  const tideAppDir = join(geminiDir, "antigravity-cli-tide");
  const tideConvDir = join(tideAppDir, "conversations");
  const emptyAppDir = join(geminiDir, "antigravity-cli-unauthenticated");
  const emptyConvDir = join(emptyAppDir, "conversations");
  const statusDir = join(root, "statusline");
  mkdirSync(defaultConvDir, { recursive: true });
  mkdirSync(tideConvDir, { recursive: true });
  mkdirSync(emptyConvDir, { recursive: true });
  mkdirSync(statusDir, { recursive: true });

  // 默认实例通过 current-account 识别为 alice；tide 实例通过 antigravity-oauth-token 的 id_token_email 识别为 tidewren。
  writeFileSync(join(statusDir, "current-account"), "alice\n");
  writeFileSync(
    join(tideAppDir, "antigravity-oauth-token"),
    JSON.stringify({
      auth_method: "oauth",
      id_token_email: "Tidewren@gmail.com",
      token: "secret",
    }),
  );

  function writeConvDb(
    dbPath: string,
    executionId: string,
    messageId: string,
    inputTokens: number,
  ) {
    const db = new Database(dbPath);
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
        "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
    );
    const stepMeta = buildStepMetadataFixture({
      createdAtSeconds: 1_793_368_800,
      finishedAtSeconds: 1_793_368_805,
      completedAtSeconds: 1_793_368_806,
      executionId,
    });
    const genMeta = buildGenMetadataFixture({
      modelEnum: 1008,
      responseModel: "gemini-4-argon",
      modelDisplayName: "Gemini 4 Argon (High)",
      inputTokens,
      outputTokens: 500,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
      thinkingOutputTokens: 200,
      responseOutputTokens: 300,
      messageId,
      executionId,
      stepIndices: [1],
    });
    db.query(
      "INSERT INTO steps (idx, type, status, metadata) VALUES (?1, ?2, ?3, ?4)",
    ).run(1, "CORTEX_STEP_TYPE_PLANNER_RESPONSE", "DONE", stepMeta);
    db.query(
      "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (?1, ?2, ?3)",
    ).run(1, executionId, genMeta);
    db.close();
  }

  writeConvDb(join(defaultConvDir, "conv-alice.db"), "exec-a", "msg-a", 3_000);
  writeConvDb(join(tideConvDir, "conv-tide.db"), "exec-t", "msg-t", 7_000);
  writeConvDb(join(emptyConvDir, "conv-empty.db"), "exec-e", "msg-e", 1_000);

  const state = new CollectorState(":memory:");
  try {
    const sources = {
      conversationsDir: defaultConvDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
    };
    const first = readAgy(state, sources, new Date("2026-10-30T15:00:00.000Z"));
    // alice 与 tidewren 各入账 1 条；未登录的 empty 实例跳过且绝不串号到默认账户 alice。
    expect(first).toMatchObject({
      read: 3,
      recorded: 2,
      skipped: { "(缺失账户)": 1 },
      filesRead: 3,
      activeAccount: "alice",
    });
    const usages = state
      .pending<IngestUsage>("usage", 10)
      .map((item) => item.payload);
    expect(
      usages
        .map((u) => [u.accountExternalId, u.tokens.input])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ["agy-alice", 3_000],
      ["agy-tidewren", 7_000],
    ]);

    // 第二轮再读：已归账的 alice 与 tidewren 的 agy_files 均保留，不会互相清空重读。
    const second = readAgy(
      state,
      sources,
      new Date("2026-10-30T15:01:00.000Z"),
    );
    expect(second.filesRead).toBe(1); // 只有缺少账户的 conv-empty.db 重试读取
    expect(second.recorded).toBe(0);

    // 验证额外实例按需刷新：默认实例的 quota-alice.tsv 刚刷新过，只对 tide 实例触发带 --app_data_dir 与 WSL_INTEROP=1 的探测。
    const now = new Date("2026-10-30T15:02:00.000Z");
    const aliceQuota = join(statusDir, "quota-alice.tsv");
    writeFileSync(aliceQuota, staleQuota + "\n");
    utimesSync(aliceQuota, now, now);

    const callArgsFile = join(root, "agy-args.txt");
    const agyScript = join(root, "fake-agy-multi");
    const outJson = join(root, "out.json");
    writeFileSync(outJson, usageJson({ "gemini-5h": 0.6, "3p-weekly": 0.8 }));
    writeFileSync(
      agyScript,
      `#!/bin/sh
printf 'WSL=%s args=%s\\n' "\${WSL_INTEROP:-}" "$*" >> '${callArgsFile}'
while [ $# -gt 0 ]; do
  [ "$1" = "--log-file" ] && log="$2"
  shift
done
echo "I OAuth: authenticated successfully as tidewren@gmail.com" > "$log"
cat '${outJson}'
exit 0
`,
      { mode: 0o755 },
    );

    const refreshRes = await maybeRefreshAgyQuota(state, sources, now, {
      agyBin: agyScript,
      profiles: [null, "tide"],
    });
    expect(refreshRes).toMatchObject({
      attempted: true,
      refreshed: true,
      label: "tidewren",
      error: null,
    });
    const invocations = readFileSync(callArgsFile, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain("WSL=1");
    expect(invocations[0]).toContain("--app_data_dir antigravity-cli-tide");
    expect(readFileSync(join(statusDir, "current-account"), "utf8")).toBe(
      "alice\n",
    );
    expect(readFileSync(join(statusDir, "current-account-tide"), "utf8")).toBe(
      "tidewren\n",
    );
    expect(readFileSync(join(statusDir, "quota-tidewren.tsv"), "utf8")).toBe(
      "gemini_5h\t40\t4102444800\n3p_weekly\t20\t4102444800\n",
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
