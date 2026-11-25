import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agyAccountsForLabel,
  agyAllowedQuotaLabels,
  agyInstanceAccounts,
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
import { loadConfig, type CollectorConfig } from "../src/collector/config";
import {
  formatAgyRefreshLines,
  formatAgySourceDesc,
  readNewSources,
} from "../src/collector/main";
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
      responseModel: "gemini-4-neon-xhigh",
      modelDisplayName: "Gemini 4 Neon (XHigh)",
      modelEnum: 1532,
    }),
  ).toEqual({
    model: "gemini-4-neon",
    upstreamModel: "gemini-4-neon-xhigh",
    reasoningEffort: "xhigh",
  });
  expect(
    normalizeAgyModel({
      responseModel: null,
      modelDisplayName: "Gemini 4 Neon (Low)",
      modelEnum: null,
    }),
  ).toEqual({
    model: "gemini-4-neon",
    upstreamModel: null,
    reasoningEffort: "low",
  });
  expect(
    normalizeAgyModel({
      responseModel: null,
      modelDisplayName: null,
      modelEnum: 1532,
    }),
  ).toEqual({
    model: "gemini-4-neon",
    upstreamModel: null,
    reasoningEffort: "high",
  });
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
    "gemini-4-neon",
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
    "gemini-4-neon",
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
        missingQuotaProfiles: 0,
        skippedOutOfScopeShared: 0,
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
          ompReport("bob@example.com", {
            "gemini-5h": 0.02,
            // 剩余不足 1% 时上游已拒绝请求，按用满计；剩余 1.2% 仍按四舍五入显示 99%。
            "gemini-weekly": 0.9919,
            "3p-5h": 0.988,
          }),
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
      "gemini_5h\t2\t4102444800\ngemini_weekly\t100\t4102444800\n3p_5h\t99\t4102444800\n",
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
  const workAppDir = join(geminiDir, "antigravity-cli-work");
  const workConvDir = join(workAppDir, "conversations");
  const emptyAppDir = join(geminiDir, "antigravity-cli-unauthenticated");
  const emptyConvDir = join(emptyAppDir, "conversations");
  const statusDir = join(root, "statusline");
  mkdirSync(defaultConvDir, { recursive: true });
  mkdirSync(workConvDir, { recursive: true });
  mkdirSync(emptyConvDir, { recursive: true });
  mkdirSync(statusDir, { recursive: true });

  // 默认实例通过 current-account 识别为 alice；work 实例通过 antigravity-oauth-token 的 id_token_email 识别为 bob。
  writeFileSync(join(statusDir, "current-account"), "alice\n");
  writeFileSync(
    join(workAppDir, "antigravity-oauth-token"),
    JSON.stringify({
      auth_method: "oauth",
      id_token_email: "Bob@example.com",
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
  writeConvDb(join(workConvDir, "conv-work.db"), "exec-t", "msg-t", 7_000);
  writeConvDb(join(emptyConvDir, "conv-empty.db"), "exec-e", "msg-e", 1_000);

  const state = new CollectorState(":memory:");
  try {
    const sources = {
      conversationsDir: defaultConvDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
    };
    const first = readAgy(state, sources, new Date("2026-10-30T15:00:00.000Z"));
    // alice 与 bob 各入账 1 条；缺少 antigravity-oauth-token 的未登录额外目录直接忽略，不扫描也不串号到默认账户 alice。
    expect(first).toMatchObject({
      read: 2,
      recorded: 2,
      skipped: {},
      filesRead: 2,
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
      ["agy-bob", 7_000],
    ]);

    // 第二轮再读：已归账的 alice 与 bob 的 agy_files 均保留，不会互相清空重读。
    const second = readAgy(
      state,
      sources,
      new Date("2026-10-30T15:01:00.000Z"),
    );
    expect(second.filesRead).toBe(0);
    expect(second.recorded).toBe(0);

    // 验证额外实例按需刷新：默认实例的 quota-alice.tsv 刚刷新过，只对 work 实例触发带 --app_data_dir 与 WSL_INTEROP=1 的探测。
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
echo "I OAuth: authenticated successfully as bob@example.com" > "$log"
cat '${outJson}'
exit 0
`,
      { mode: 0o755 },
    );

    const refreshRes = await maybeRefreshAgyQuota(state, sources, now, {
      agyBin: agyScript,
      profiles: [null, "work"],
    });
    expect(refreshRes).toMatchObject({
      attempted: true,
      refreshed: true,
      label: "bob",
      error: null,
    });
    const invocations = readFileSync(callArgsFile, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain("WSL=1");
    expect(invocations[0]).toContain("--app_data_dir antigravity-cli-work");
    expect(readFileSync(join(statusDir, "current-account"), "utf8")).toBe(
      "alice\n",
    );
    expect(readFileSync(join(statusDir, "current-account-work"), "utf8")).toBe(
      "bob\n",
    );
    expect(readFileSync(join(statusDir, "quota-bob.tsv"), "utf8")).toBe(
      "gemini_5h\t40\t4102444800\n3p_weekly\t20\t4102444800\n",
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readAgyQuotaFile, refreshAgyQuota, and maybeRefreshOmpAgyQuota preserve unopened 0/0 windows", async () => {
  const w = refreshWorkspace();
  const state = new CollectorState(":memory:");
  try {
    writeFileSync(join(w.statuslineDir, "current-account"), "alice\n");
    writeFileSync(w.quota, "plan\tGoogle AI Ultra\t-\n");
    utimesSync(w.quota, longAgo, longAgo);

    const agy = fakeAgy(w.dir, {
      output: JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                buckets: [
                  {
                    id: "gemini-weekly",
                    remaining_fraction: 1,
                    reset_time: null,
                  },
                  { id: "3p-weekly", remaining_fraction: 1 },
                  // 已用额度非 0 但缺少 reset_time 的异常桶仍丢弃
                  { id: "gemini-5h", remaining_fraction: 0.5 },
                ],
              },
            ],
          },
        },
      }),
      loggedInAs: "alice@example.com",
    });

    const refreshed = await refreshAgyQuota(w.sources, { agyBin: agy.script });
    expect(refreshed).toMatchObject({
      attempted: true,
      refreshed: true,
      label: "alice",
      error: null,
    });
    expect(readFileSync(w.quota, "utf8")).toBe(
      [
        "gemini_weekly\t0\t0",
        "3p_weekly\t0\t0",
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );

    const parsed = readAgyQuotaFile(
      w.quota,
      "alice",
      new Date("2026-10-31T12:00:00.000Z"),
    )!;
    expect(parsed.ignoredLines).toBe(0);
    expect(parsed.entries).toEqual([
      {
        key: "gemini_weekly",
        pool: "gemini",
        accountExternalId: "agy-alice",
        window: "seven-day",
        windowMinutes: 10080,
        percent: 0,
        resetsAt: null,
        expired: false,
      },
      {
        key: "3p_weekly",
        pool: "3p",
        accountExternalId: "agy-alice",
        window: "seven-day-3p",
        windowMinutes: 10080,
        percent: 0,
        resetsAt: null,
        expired: false,
      },
    ]);

    // 确认非 0 百分比配 resetEpoch 0 仍作为无效行忽略
    const badFile = join(w.statuslineDir, "quota-bad.tsv");
    writeFileSync(badFile, "gemini_weekly\t50\t0\n3p_weekly\t0\t0\n");
    const parsedBad = readAgyQuotaFile(
      badFile,
      "bad",
      new Date("2026-10-31T12:00:00.000Z"),
    )!;
    expect(parsedBad.ignoredLines).toBe(1);
    expect(parsedBad.entries.map((e) => e.key)).toEqual(["3p_weekly"]);

    // omp usage --json 返回 remainingFraction === 1 且无 resetsAt 时同样保留为 0\t0
    const omp = fakeOmp(
      w.dir,
      JSON.stringify({
        reports: [
          {
            provider: "google-antigravity",
            fetchedAt: 1793702034369,
            metadata: { email: "bob@example.com", projectId: "p" },
            limits: [
              {
                id: "google-antigravity:anthropic:default:3p-weekly",
                window: { resetsAt: 0 },
                amount: { remainingFraction: 1 },
              },
            ],
          },
        ],
      }),
    );
    const ompRes = await maybeRefreshOmpAgyQuota(
      state,
      w.sources,
      { exhausted: false },
      new Date("2026-10-31T12:00:00.000Z"),
      { ompBin: omp.script },
    );
    expect(ompRes).toMatchObject({ refreshed: true, labels: ["bob"] });
    expect(readFileSync(join(w.statuslineDir, "quota-bob.tsv"), "utf8")).toBe(
      "3p_weekly\t0\t0\n",
    );
  } finally {
    state.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("shared symlinked conversations deduplicate DB scans, attribute cross-account turns via acp logs, skip unauthenticated backup dirs, and clear SSH_CONNECTION on refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-shared-"));
  const geminiDir = join(root, ".gemini");
  const defaultAppDir = join(geminiDir, "antigravity-cli");
  const defaultConvDir = join(defaultAppDir, "conversations");
  const defaultLogDir = join(defaultAppDir, "log");
  const acct2AppDir = join(geminiDir, "antigravity-cli-acct2");
  const acct2LogDir = join(acct2AppDir, "log");
  const backupAppDir = join(geminiDir, "antigravity-cli-backup-20261123");
  const backupConvDir = join(backupAppDir, "conversations");
  const statusDir = join(root, "statusline");

  mkdirSync(defaultConvDir, { recursive: true });
  mkdirSync(defaultLogDir, { recursive: true });
  mkdirSync(acct2LogDir, { recursive: true });
  mkdirSync(backupConvDir, { recursive: true });
  mkdirSync(statusDir, { recursive: true });
  symlinkSync(defaultConvDir, join(acct2AppDir, "conversations"));

  writeFileSync(join(statusDir, "current-account"), "alice\n");
  writeFileSync(
    join(acct2AppDir, "antigravity-oauth-token"),
    JSON.stringify({
      auth_method: "oauth",
      id_token_email: "Bob@example.com",
      token: "secret",
    }),
  );

  const convId = "c1818814-2a2b-4254-b8e8-20e5a18674b7";
  // 构造两个相邻轮次（本地时间 2026-11-23 00:13:35 与 00:13:46），分别由 alice 与 bob 发起。
  const turn1Local = new Date(2026, 10, 23, 0, 13, 35, 0);
  const turn2Local = new Date(2026, 10, 23, 0, 13, 46, 0);
  const turn1Sec = Math.floor(turn1Local.getTime() / 1000);
  const turn2Sec = Math.floor(turn2Local.getTime() / 1000);

  const convPath = join(defaultConvDir, `${convId}.db`);
  const db = new Database(convPath);
  db.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
      "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
  );
  const insertTurn = (
    idx: number,
    sec: number,
    execId: string,
    msgId: string,
    inputTokens: number,
  ) => {
    db.query(
      "INSERT INTO steps (idx, type, status, metadata) VALUES (?1, ?2, ?3, ?4)",
    ).run(
      idx,
      "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      "DONE",
      buildStepMetadataFixture({
        createdAtSeconds: sec - 2,
        finishedAtSeconds: sec - 1,
        completedAtSeconds: sec,
        executionId: execId,
      }),
    );
    db.query(
      "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (?1, ?2, ?3)",
    ).run(
      idx,
      execId,
      buildGenMetadataFixture({
        modelEnum: 1532,
        responseModel: "gemini-4-neon",
        modelDisplayName: "Gemini 4 Neon (High)",
        inputTokens,
        outputTokens: 200,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
        thinkingOutputTokens: 50,
        responseOutputTokens: 150,
        messageId: msgId,
        executionId: execId,
        stepIndices: [idx],
      }),
    );
  };
  insertTurn(1, turn1Sec, "exec-turn-1", "msg-turn-1", 4_000);
  insertTurn(2, turn2Sec, "exec-turn-2", "msg-turn-2", 9_000);
  db.close();
  utimesSync(convPath, turn2Local, turn2Local);

  // 备份目录里放一个同名库，确认不会触发扫描或缺失账户计数。
  const backupDb = new Database(join(backupConvDir, "old-backup.db"));
  backupDb.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
      "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
  );
  backupDb.close();

  const aliceLog = join(defaultLogDir, "acp-server-20261123_001330-100.log");
  writeFileSync(
    aliceLog,
    [
      "I1123 00:13:30.100000 1 server_oauth.go:226] OAuth: authenticated successfully as alice@example.com",
      `I1123 00:13:31.200000 1 server.go:1269] Created conversation ${convId} (backend=BACKEND_TYPE_UNSPECIFIED)`,
      `I1123 00:13:31.500000 1 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  utimesSync(aliceLog, turn1Local, turn1Local);

  const bobLog = join(acct2LogDir, "acp-server-20261123_001338-200.log");
  writeFileSync(
    bobLog,
    [
      "I1123 00:13:38.776000 1 server_oauth.go:226] OAuth: authenticated successfully as bob@example.com",
      `I1123 00:13:40.854000 1 session_handlers.go:461] Loading/Resuming session: ${convId}, cwd: /tmp`,
      `I1123 00:13:40.963000 1 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  utimesSync(bobLog, turn2Local, turn2Local);

  const state = new CollectorState(":memory:");
  const prevSsh = process.env.SSH_CONNECTION;
  const prevWsl = process.env.WSL_INTEROP;
  try {
    const sources = {
      conversationsDir: defaultConvDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
    };

    // backup 目录不出现在实例列表中。
    expect(agyInstanceAccounts(sources).map((i) => i.profile)).toEqual([
      null,
      "acct2",
    ]);

    const report = readAgy(state, sources, turn2Local);
    // 软链共享目录只扫一次（filesRead = 1），两轮分别归给 alice 与 bob，且未建缓存的 acct2 计入 missingQuotaProfiles。
    expect(report).toMatchObject({
      filesRead: 1,
      read: 2,
      recorded: 2,
      skipped: {},
      missingQuotaProfiles: 1,
    });
    const usages = state
      .pending<IngestUsage>("usage", 10)
      .map((item) => [
        item.payload.accountExternalId,
        item.payload.tokens.input,
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(usages).toEqual([
      ["agy-alice", 4_000],
      ["agy-bob", 9_000],
    ]);
    const dirty = JSON.parse(state.getMeta("agy_dirty_profiles") ?? "[]") as (
      string | null
    )[];
    expect(dirty).toContain(null);
    expect(dirty).toContain("acct2");

    // 即使父进程环境带 SSH_CONNECTION=paseo 与 WSL_INTEROP=1，refreshAgyQuota 也会按实例类型精确清理。
    process.env.SSH_CONNECTION = "paseo";
    process.env.WSL_INTEROP = "1";
    const envLog = join(root, "probe-env.txt");
    const fakeBin = join(root, "fake-agy-env");
    const outJson = join(root, "usage.json");
    writeFileSync(outJson, usageJson({ "gemini-5h": 0.9 }));
    writeFileSync(
      fakeBin,
      `#!/bin/sh
printf 'SSH=%s WSL=%s args=%s\\n' "\${SSH_CONNECTION:-}" "\${WSL_INTEROP:-}" "$*" >> '${envLog}'
while [ $# -gt 0 ]; do
  [ "$1" = "--log-file" ] && log="$2"
  shift
done
echo "I OAuth: authenticated successfully as bob@example.com" > "$log"
cat '${outJson}'
exit 0
`,
      { mode: 0o755 },
    );

    const defRes = await refreshAgyQuota(sources, { agyBin: fakeBin });
    expect(defRes.refreshed).toBe(true);
    const extRes = await refreshAgyQuota(sources, {
      agyBin: fakeBin,
      profileName: "acct2",
      geminiDir,
      appDataDir: acct2AppDir,
    });
    expect(extRes.refreshed).toBe(true);
    const lines = readFileSync(envLog, "utf8").trim().split("\n");
    expect(lines[0]).toStartWith("SSH= WSL= ");
    expect(lines[1]).toStartWith("SSH= WSL=1 ");
    expect(lines[1]).toContain("--app_data_dir antigravity-cli-acct2");
  } finally {
    if (prevSsh === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = prevSsh;
    if (prevWsl === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = prevWsl;
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unauthenticated extra profile (e.g. antigravity-cli-acct5 without non-empty antigravity-oauth-token) never invokes agy", async () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-no-token-"));
  const geminiDir = join(root, ".gemini");
  const defaultConvDir = join(geminiDir, "antigravity-cli", "conversations");
  const acct5AppDir = join(geminiDir, "antigravity-cli-acct5");
  const acct6EmptyTokenDir = join(geminiDir, "antigravity-cli-acct6");
  const statusDir = join(root, "statusline");
  mkdirSync(defaultConvDir, { recursive: true });
  mkdirSync(join(acct5AppDir, "conversations"), { recursive: true });
  mkdirSync(join(acct6EmptyTokenDir, "conversations"), { recursive: true });
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, "current-account"), "alice\n");
  // acct6 存在 0 字节空文件，同样不能视为有效登录令牌。
  writeFileSync(join(acct6EmptyTokenDir, "antigravity-oauth-token"), "");

  const callMarker = join(root, "agy-called.txt");
  const fakeAgyBin = join(root, "fake-agy-never-call");
  writeFileSync(
    fakeAgyBin,
    `#!/bin/sh
echo "CALLED $*" >> '${callMarker}'
exit 0
`,
    { mode: 0o755 },
  );

  const state = new CollectorState(":memory:");
  try {
    const sources = {
      conversationsDir: defaultConvDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
    };

    // 第一道防线：discoverAgyInstances 忽略 acct5（无令牌）和 acct6（空令牌）。
    expect(agyInstanceAccounts(sources).map((i) => i.profile)).toEqual([null]);

    const now = new Date("2026-11-23T01:00:00.000Z");
    const maybeRes = await maybeRefreshAgyQuota(state, sources, now, {
      agyBin: fakeAgyBin,
      profiles: ["acct5", "acct6"],
    });
    expect(maybeRes).toMatchObject({
      attempted: false,
      refreshed: false,
      error: null,
    });

    // 第二道防线：即使直接调用 refreshAgyQuota，缺少非空普通文件 antigravity-oauth-token 时也严禁拉起 agy。
    const directMissing = await refreshAgyQuota(sources, {
      agyBin: fakeAgyBin,
      profileName: "acct5",
      geminiDir,
      appDataDir: acct5AppDir,
    });
    expect(directMissing.attempted).toBe(false);
    expect(directMissing.refreshed).toBe(false);
    expect(directMissing.error).toContain("antigravity-oauth-token");

    const directEmpty = await refreshAgyQuota(sources, {
      agyBin: fakeAgyBin,
      profileName: "acct6",
      geminiDir,
      appDataDir: acct6EmptyTokenDir,
    });
    expect(directEmpty.attempted).toBe(false);
    expect(directEmpty.refreshed).toBe(false);
    expect(directEmpty.error).toContain("antigravity-oauth-token");

    // 符号链接令牌、目录型令牌与带有效令牌的 backup 命名目录都必须被拒绝。
    const acctSymlinkDir = join(geminiDir, "antigravity-cli-acct7");
    const acctDirTokenDir = join(geminiDir, "antigravity-cli-acct8");
    const acctBackupValidDir = join(geminiDir, "antigravity-cli-backup-2026");
    const externalToken = join(root, "real-token.json");
    writeFileSync(
      externalToken,
      JSON.stringify({ id_token_email: "symlinked@example.com" }),
    );
    mkdirSync(join(acctSymlinkDir, "conversations"), { recursive: true });
    symlinkSync(externalToken, join(acctSymlinkDir, "antigravity-oauth-token"));
    mkdirSync(join(acctDirTokenDir, "conversations"), { recursive: true });
    mkdirSync(join(acctDirTokenDir, "antigravity-oauth-token"), {
      recursive: true,
    });
    mkdirSync(join(acctBackupValidDir, "conversations"), { recursive: true });
    writeFileSync(
      join(acctBackupValidDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "backup@example.com" }),
    );

    expect(agyInstanceAccounts(sources).map((i) => i.profile)).toEqual([null]);
    for (const [profileName, appDataDir] of [
      ["acct7", acctSymlinkDir],
      ["acct8", acctDirTokenDir],
    ] as const) {
      const res = await refreshAgyQuota(sources, {
        agyBin: fakeAgyBin,
        profileName,
        geminiDir,
        appDataDir,
      });
      expect(res.attempted).toBe(false);
      expect(res.refreshed).toBe(false);
      expect(res.error).toContain("antigravity-oauth-token");
    }

    // 参数错配（appDataDir 指向有令牌的目录，而 geminiDir + profileName 指向缺失令牌的目录）必须拒绝。
    const acctValidDir = join(geminiDir, "antigravity-cli-acct9");
    mkdirSync(join(acctValidDir, "conversations"), { recursive: true });
    writeFileSync(
      join(acctValidDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "valid9@example.com" }),
    );
    const mismatchRes = await refreshAgyQuota(sources, {
      agyBin: fakeAgyBin,
      profileName: "acct5",
      geminiDir,
      appDataDir: acctValidDir,
    });
    expect(mismatchRes.attempted).toBe(false);
    expect(mismatchRes.refreshed).toBe(false);
    expect(mismatchRes.error).toContain("不一致");

    // 确认 fake agy 一次也没有被执行。
    expect(() => readFileSync(callMarker, "utf8")).toThrow();

    // 传入相对路径时，令牌校验与子进程 --gemini_dir 均必须归一化为同一绝对路径（不受子进程 cwd 切换影响）。
    const { relative } = await import("node:path");
    const relGeminiDir = relative(process.cwd(), geminiDir);
    const relAppDataDir = relative(process.cwd(), acctValidDir);
    const argvDump = join(root, "rel-argv.txt");
    const fakeAgyRel = join(root, "fake-agy-rel");
    writeFileSync(
      fakeAgyRel,
      `#!/bin/sh
printf '%s\n' "$@" > '${argvDump}'
printf '%s\n' '${usageJson({ "gemini-5h": 0.9 })}'
exit 0
`,
      { mode: 0o755 },
    );
    const relRes = await refreshAgyQuota(sources, {
      agyBin: fakeAgyRel,
      profileName: "acct9",
      geminiDir: relGeminiDir,
      appDataDir: relAppDataDir,
    });
    expect(relRes.refreshed).toBe(true);
    const dumpedArgs = readFileSync(argvDump, "utf8").trim().split("\n");
    const gIdx = dumpedArgs.indexOf("--gemini_dir");
    expect(gIdx).toBeGreaterThanOrEqual(0);
    expect(dumpedArgs[gIdx + 1]).toBe(geminiDir);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared conversation attribution keeps active turn sender over concurrent session open and reads older logs", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-shared-overlap-"));
  const geminiDir = join(root, ".gemini");
  const primaryAppDir = join(geminiDir, "antigravity-cli");
  const acct2AppDir = join(geminiDir, "antigravity-cli-acct2");
  const primaryConvDir = join(primaryAppDir, "conversations");
  const statusDir = join(root, "statusline");
  mkdirSync(primaryConvDir, { recursive: true });
  mkdirSync(join(primaryAppDir, "log"), { recursive: true });
  mkdirSync(join(acct2AppDir, "log"), { recursive: true });
  mkdirSync(statusDir, { recursive: true });
  symlinkSync(primaryConvDir, join(acct2AppDir, "conversations"));

  writeFileSync(join(statusDir, "current-account"), "alice\n");
  writeFileSync(
    join(acct2AppDir, "antigravity-oauth-token"),
    JSON.stringify({ id_token_email: "bob@example.com" }),
  );

  const convId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const dbPath = join(primaryConvDir, `${convId}.db`);
  const convDb = new Database(dbPath);
  convDb.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
      "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
  );
  const insertTurn = (
    idx: number,
    sec: number,
    execId: string,
    msgId: string,
    inputTokens: number,
  ) => {
    convDb
      .query(
        "INSERT INTO steps (idx, type, status, metadata) VALUES (?1, ?2, ?3, ?4)",
      )
      .run(
        idx,
        "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        "DONE",
        buildStepMetadataFixture({
          createdAtSeconds: sec - 2,
          finishedAtSeconds: sec - 1,
          completedAtSeconds: sec,
          executionId: execId,
        }),
      );
    convDb
      .query(
        "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (?1, ?2, ?3)",
      )
      .run(
        idx,
        execId,
        buildGenMetadataFixture({
          modelEnum: 1532,
          responseModel: "gemini-4-neon",
          modelDisplayName: "Gemini 4 Neon (High)",
          inputTokens,
          outputTokens: 200,
          cacheReadTokens: 1_000,
          cacheWriteTokens: 0,
          thinkingOutputTokens: 50,
          responseOutputTokens: 150,
          messageId: msgId,
          executionId: execId,
          stepIndices: [idx],
        }),
      );
  };

  // 轮次 1：3 天前由 bob 发起；轮次 2：今天 10:00:00 由 alice 发起，10:00:02 bob 仅被动打开同一会话，10:00:05 完成。
  const oldStepDate = new Date(2026, 10, 19, 10, 0, 5, 0);
  const overlapStepDate = new Date(2026, 10, 22, 10, 0, 5, 0);
  insertTurn(
    1,
    Math.floor(oldStepDate.getTime() / 1000),
    "exec-old-bob",
    "msg-old-bob",
    3_000,
  );
  insertTurn(
    2,
    Math.floor(overlapStepDate.getTime() / 1000),
    "exec-overlap-alice",
    "msg-overlap-alice",
    7_000,
  );
  convDb.close();
  utimesSync(dbPath, overlapStepDate, overlapStepDate);

  const oldLogPath = join(
    acct2AppDir,
    "log",
    "acp-server-20261119_095900-100.log",
  );
  writeFileSync(
    oldLogPath,
    [
      "I1119 09:59:50.000000 100 server_oauth.go:226] OAuth: authenticated successfully as bob@example.com",
      `I1119 10:00:00.000000 100 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  const oldLogDate = new Date(2026, 10, 19, 10, 1, 0);
  utimesSync(oldLogPath, oldLogDate, oldLogDate);

  const aliceLogPath = join(
    primaryAppDir,
    "log",
    "acp-server-20261122_095900-101.log",
  );
  writeFileSync(
    aliceLogPath,
    [
      "I1122 09:59:50.000000 101 server_oauth.go:226] OAuth: authenticated successfully as alice@example.com",
      `I1122 10:00:00.000000 101 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  utimesSync(aliceLogPath, overlapStepDate, overlapStepDate);

  const bobOpenLogPath = join(
    acct2AppDir,
    "log",
    "acp-server-20261122_100001-102.log",
  );
  writeFileSync(
    bobOpenLogPath,
    [
      "I1122 10:00:01.000000 102 server_oauth.go:226] OAuth: authenticated successfully as bob@example.com",
      `I1122 10:00:02.000000 102 session_handlers.go:461] Loading/Resuming session: ${convId}, cwd: /tmp`,
      // buildStepMetadataFixture 固定写入 .900s 纳秒（10:00:05.900），模拟同毫秒内稍晚（10:00:05.900900）
      // 及结束后 200ms（10:00:06.100）bob 发起下一轮，均不得抢占 alice 的上一轮归属。
      `I1122 10:00:05.900900 102 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
      `I1122 10:00:06.100000 102 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  utimesSync(bobOpenLogPath, overlapStepDate, overlapStepDate);

  const state = new CollectorState(":memory:");
  try {
    const report = readAgy(state, {
      conversationsDir: primaryConvDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
    });
    expect(report.filesRead).toBe(1);
    expect(report.recorded).toBe(2);
    const items = state.pending<IngestUsage>("usage", 10);
    const byInput = new Map(
      items.map((item) => [
        item.payload.tokens.input,
        item.payload.accountExternalId,
      ]),
    );
    expect(byInput.get(3_000)).toBe("agy-bob");
    expect(byInput.get(7_000)).toBe("agy-alice");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readAgy 在夏令时回拨重复小时不会让回拨后发送覆盖先前轮次，并能凭文件单调性收窄跨回拨日志", () => {
  const prevTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-dst-fallback-"));
  const geminiRoot = join(root, ".gemini");
  const primaryAppDir = join(geminiRoot, "antigravity-cli");
  const primaryConvDir = join(primaryAppDir, "conversations");
  const acct2AppDir = join(geminiRoot, "antigravity-cli-work");
  const statusDir = join(root, "statusline");
  mkdirSync(primaryConvDir, { recursive: true });
  mkdirSync(join(primaryAppDir, "log"), { recursive: true });
  mkdirSync(join(acct2AppDir, "log"), { recursive: true });
  mkdirSync(statusDir, { recursive: true });
  symlinkSync(primaryConvDir, join(acct2AppDir, "conversations"));

  const jwtFor = (email: string): string => {
    const header = Buffer.from('{"alg":"RS256"}').toString("base64url");
    const payload = Buffer.from(JSON.stringify({ email })).toString(
      "base64url",
    );
    return `${header}.${payload}.sig`;
  };
  writeFileSync(
    join(primaryAppDir, "antigravity-oauth-token"),
    JSON.stringify({ id_token: jwtFor("alice@example.com") }),
  );
  writeFileSync(
    join(acct2AppDir, "antigravity-oauth-token"),
    JSON.stringify({ id_token: jwtFor("bob@example.com") }),
  );

  const convId = "33333333-4444-5555-6666-777777777777";
  const dbPath = join(primaryConvDir, `${convId}.db`);
  const convDb = new Database(dbPath);
  convDb.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
      "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
  );
  const insertTurn = (
    idx: number,
    completedSec: number,
    execId: string,
    msgId: string,
    inputTokens: number,
  ): void => {
    convDb
      .query(
        "INSERT INTO steps (idx, type, status, metadata) VALUES (?1, ?2, ?3, ?4)",
      )
      .run(
        idx,
        "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        "DONE",
        buildStepMetadataFixture({
          createdAtSeconds: completedSec - 2,
          finishedAtSeconds: completedSec - 1,
          completedAtSeconds: completedSec,
          executionId: execId,
        }),
      );
    convDb
      .query(
        "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (?1, ?2, ?3)",
      )
      .run(
        idx,
        execId,
        buildGenMetadataFixture({
          modelEnum: 1532,
          responseModel: "gemini-4-neon",
          modelDisplayName: "Gemini 4 Neon (High)",
          inputTokens,
          outputTokens: 200,
          cacheReadTokens: 1_000,
          cacheWriteTokens: 0,
          thinkingOutputTokens: 50,
          responseOutputTokens: 150,
          messageId: msgId,
          executionId: execId,
          stepIndices: [idx],
        }),
      );
  };

  // America/New_York 2026-11-01 夏令时回拨：01:00 EDT = 05:00Z，01:00 EST = 06:00Z。
  // 每轮交替切换 alice/bob，确保任意一处收窄失效或回退都会让断言直接失败：
  // 轮次 1（04:50:05.900Z）：alice 在回拨前 00:50:00 EDT（非重复小时）发起；
  // 轮次 2（05:00:01.900Z）：bob 在首个 01:00:00 EDT 发起，单轮文件在 05:00:05Z 关闭（仅凭读后 mtime 上界收窄，且不得被 alice 回拨后 01:00:00.900 EST 抢占）；
  // 轮次 3（05:05:01.900Z）：alice 在首个 01:05:00 EDT 发起，单轮文件在 05:05:05Z 关闭；
  // 轮次 4（05:10:01.900Z）：bob 在首个 01:10:00 EDT 发起，其日志跨回拨持续到 01:05:05 EST（凭文件内前后行单调性收窄）；
  // 轮次 5（06:00:02.900Z）：alice 在回拨后第二个 01:00:00.900 EST 发起（晚近 1 小时，赢得轮次 5 但不抢占轮次 2）；
  // 轮次 6（06:05:10.900Z）：bob 在同一跨回拨日志中于回拨后 01:05:05 EST 发起。
  insertTurn(
    1,
    Math.floor(Date.UTC(2026, 10, 1, 4, 50, 5) / 1000),
    "exec-dst-1-alice",
    "msg-dst-1-alice",
    3_000,
  );
  insertTurn(
    2,
    Math.floor(Date.UTC(2026, 10, 1, 5, 0, 1) / 1000),
    "exec-dst-2-bob-mtime",
    "msg-dst-2-bob-mtime",
    4_000,
  );
  insertTurn(
    3,
    Math.floor(Date.UTC(2026, 10, 1, 5, 5, 1) / 1000),
    "exec-dst-3-alice-mtime",
    "msg-dst-3-alice-mtime",
    5_000,
  );
  insertTurn(
    4,
    Math.floor(Date.UTC(2026, 10, 1, 5, 10, 1) / 1000),
    "exec-dst-4-bob-mono",
    "msg-dst-4-bob-mono",
    6_000,
  );
  insertTurn(
    5,
    Math.floor(Date.UTC(2026, 10, 1, 6, 0, 2) / 1000),
    "exec-dst-5-alice-est",
    "msg-dst-5-alice-est",
    8_000,
  );
  insertTurn(
    6,
    Math.floor(Date.UTC(2026, 10, 1, 6, 5, 10) / 1000),
    "exec-dst-6-bob-est",
    "msg-dst-6-bob-est",
    9_000,
  );
  convDb.close();
  const dbMtime = new Date("2026-11-01T06:05:11.000Z");
  utimesSync(dbPath, dbMtime, dbMtime);

  const alicePrePath = join(
    primaryAppDir,
    "log",
    "acp-server-20261101_005000-200.log",
  );
  writeFileSync(
    alicePrePath,
    [
      "I1101 00:49:55.000000 200 server_oauth.go:226] OAuth: authenticated successfully as alice@example.com",
      `I1101 00:50:00.000000 200 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  const alicePreMtime = new Date("2026-11-01T04:50:10.000Z");
  utimesSync(alicePrePath, alicePreMtime, alicePreMtime);

  const bobFirstHourOnlyPath = join(
    acct2AppDir,
    "log",
    "acp-server-20261101_010000-201.log",
  );
  writeFileSync(
    bobFirstHourOnlyPath,
    [
      "I1101 01:00:00.000000 201 server_oauth.go:226] OAuth: authenticated successfully as bob@example.com",
      `I1101 01:00:00.000000 201 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  const bobFirstHourMtime = new Date("2026-11-01T05:00:05.000Z");
  utimesSync(bobFirstHourOnlyPath, bobFirstHourMtime, bobFirstHourMtime);

  const aliceFirstHourOnlyPath = join(
    primaryAppDir,
    "log",
    "acp-server-20261101_010500-202.log",
  );
  writeFileSync(
    aliceFirstHourOnlyPath,
    [
      "I1101 01:05:00.000000 202 server_oauth.go:226] OAuth: authenticated successfully as alice@example.com",
      `I1101 01:05:00.000000 202 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  const aliceFirstHourMtime = new Date("2026-11-01T05:05:05.000Z");
  utimesSync(aliceFirstHourOnlyPath, aliceFirstHourMtime, aliceFirstHourMtime);

  const bobCrossRollbackPath = join(
    acct2AppDir,
    "log",
    "acp-server-20261101_011000-203.log",
  );
  writeFileSync(
    bobCrossRollbackPath,
    [
      "I1101 01:10:00.000000 203 server_oauth.go:226] OAuth: authenticated successfully as bob@example.com",
      `I1101 01:10:00.000000 203 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
      "I1101 01:55:00.000000 203 server.go:189] heartbeat before fallback",
      `I1101 01:05:05.000000 203 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  const bobCrossMtime = new Date("2026-11-01T06:05:06.000Z");
  utimesSync(bobCrossRollbackPath, bobCrossMtime, bobCrossMtime);

  const aliceSecondHourPath = join(
    primaryAppDir,
    "log",
    "acp-server-20261101_010000-204.log",
  );
  // 模拟读取竞态：枚举与打开文件时 mtime 仍停在回拨前的 05:55:00Z，
  // 在 readFileSync 读取正文瞬间才并发追加回拨后的 01:00:00.900 EST 发送行并将 mtime 推到 06:00:05Z。
  // 若生产代码错用读前 mtime（05:55Z），会误删 06:00:00.900Z 候选，导致轮次 2 被 alice 抢占而断言失败。
  writeFileSync(
    aliceSecondHourPath,
    "I1101 01:00:00.800000 204 server_oauth.go:226] OAuth: authenticated successfully as alice@example.com\n",
  );
  const alicePreAppendMtime = new Date("2026-11-01T05:55:00.000Z");
  const alicePostAppendMtime = new Date("2026-11-01T06:00:05.000Z");
  utimesSync(aliceSecondHourPath, alicePreAppendMtime, alicePreAppendMtime);

  let targetFd: number | null = null;
  let appendedDuringRead = false;
  const state = new CollectorState(":memory:");
  try {
    const report = readAgy(
      state,
      {
        conversationsDir: primaryConvDir,
        statuslineDir: statusDir,
        start: "2026-09-20T00:00:00.000Z",
      },
      new Date(),
      {
        openSync(path, flags) {
          const fd = openSync(path, flags);
          if (path === aliceSecondHourPath) targetFd = fd;
          return fd;
        },
        readFileSync(fd, encoding) {
          if (fd === targetFd && !appendedDuringRead) {
            appendedDuringRead = true;
            appendFileSync(
              aliceSecondHourPath,
              `I1101 01:00:00.900000 204 server.go:1883] Sending user message to conversation ${convId} (items=1, media=0)\n`,
            );
            utimesSync(
              aliceSecondHourPath,
              alicePostAppendMtime,
              alicePostAppendMtime,
            );
          }
          return readFileSync(fd, encoding);
        },
      },
    );
    expect(appendedDuringRead).toBe(true);
    expect(report.filesRead).toBe(1);
    expect(report.recorded).toBe(6);
    const items = state.pending<IngestUsage>("usage", 10);
    const byInput = new Map(
      items.map((item) => [
        item.payload.tokens.input,
        item.payload.accountExternalId,
      ]),
    );
    expect(byInput.get(3_000)).toBe("agy-alice");
    expect(byInput.get(4_000)).toBe("agy-bob");
    expect(byInput.get(5_000)).toBe("agy-alice");
    expect(byInput.get(6_000)).toBe("agy-bob");
    expect(byInput.get(8_000)).toBe("agy-alice");
    expect(byInput.get(9_000)).toBe("agy-bob");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
    if (prevTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = prevTz;
    }
  }
});

test("shared conversation log cache skips unchanged logs across rounds, saves watermark when primary is unauthenticated, and normalizes relative conversationsDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-log-cache-"));
  const geminiDir = join(root, ".gemini");
  const primaryAppDir = join(geminiDir, "antigravity-cli");
  const primaryConvDir = join(primaryAppDir, "conversations");
  const acct2AppDir = join(geminiDir, "antigravity-cli-acct2");
  const statusDir = join(root, "statusline");
  mkdirSync(primaryConvDir, { recursive: true });
  mkdirSync(join(primaryAppDir, "log"), { recursive: true });
  mkdirSync(join(acct2AppDir, "log"), { recursive: true });
  mkdirSync(statusDir, { recursive: true });
  symlinkSync(primaryConvDir, join(acct2AppDir, "conversations"));

  // 默认实例故意不写 current-account/token（模拟默认账号未登录，仅副账号 acct2 登录）。
  writeFileSync(
    join(acct2AppDir, "antigravity-oauth-token"),
    JSON.stringify({ id_token_email: "bob@example.com" }),
  );

  const conv1 = "11111111-2222-4333-8444-555555555551";
  const conv2 = "11111111-2222-4333-8444-555555555552";
  const t1 = new Date(2026, 10, 22, 12, 0, 10, 0);
  const t2 = new Date(2026, 10, 22, 12, 5, 10, 0);

  const writeConvDb = (
    convId: string,
    when: Date,
    execId: string,
    inputTokens: number,
  ) => {
    const dbPath = join(primaryConvDir, `${convId}.db`);
    const db = new Database(dbPath);
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
        "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
    );
    const sec = Math.floor(when.getTime() / 1000);
    db.query(
      "INSERT INTO steps (idx, type, status, metadata) VALUES (1, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', 'DONE', ?1)",
    ).run(
      buildStepMetadataFixture({
        createdAtSeconds: sec - 2,
        finishedAtSeconds: sec - 1,
        completedAtSeconds: sec,
        executionId: execId,
      }),
    );
    db.query(
      "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (1, ?1, ?2)",
    ).run(
      execId,
      buildGenMetadataFixture({
        modelEnum: 1532,
        responseModel: "gemini-4-neon",
        modelDisplayName: "Gemini 4 Neon (High)",
        inputTokens,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingOutputTokens: 0,
        responseOutputTokens: 100,
        messageId: `msg-${execId}`,
        executionId: execId,
        stepIndices: [1],
      }),
    );
    db.close();
    utimesSync(dbPath, when, when);
  };

  writeConvDb(conv1, t1, "exec-1", 4_200);
  const oldLog = join(acct2AppDir, "log", "acp-server-20261122_120000-300.log");
  writeFileSync(
    oldLog,
    [
      "I1122 12:00:01.000000 300 server_oauth.go:226] OAuth: authenticated successfully as bob@example.com",
      `I1122 12:00:05.000000 300 server.go:1883] Sending user message to conversation ${conv1} (items=1, media=0)`,
    ].join("\n") + "\n",
  );
  utimesSync(oldLog, t1, t1);

  const openedLogs: string[] = [];
  const trackingOps = {
    openSync(path: string, flags: string) {
      openedLogs.push(path);
      return openSync(path, flags);
    },
  };

  const state = new CollectorState(":memory:");
  try {
    const { relative } = await import("node:path");
    const relConvDir = relative(process.cwd(), primaryConvDir);
    // 相对路径经 discoverAgyInstances 归一化后也能发现额外实例。
    expect(
      agyInstanceAccounts({
        conversationsDir: relConvDir,
        statuslineDir: statusDir,
      }).map((item) => item.profile),
    ).toEqual([null, "acct2"]);

    const sources = {
      conversationsDir: relConvDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
    };

    const first = readAgy(state, sources, t1, trackingOps);
    expect(first.filesRead).toBe(1);
    expect(first.recorded).toBe(1);
    expect(first.skipped).toEqual({});
    expect(openedLogs).toEqual([oldLog]);

    // 默认实例虽未登录，但所有记录已通过共享日志归属，水位应已保存，第二轮不再重扫 conv1.db。
    openedLogs.length = 0;
    const second = readAgy(state, sources, t1, trackingOps);
    expect(second.filesRead).toBe(0);
    expect(second.recorded).toBe(0);
    expect(openedLogs).toEqual([]);

    // 新增会话 conv2 与新日志 newLog；旧日志 oldLog 未变动，不得再次打开读取。
    writeConvDb(conv2, t2, "exec-2", 6_300);
    const newLog = join(
      acct2AppDir,
      "log",
      "acp-server-20261122_120500-301.log",
    );
    writeFileSync(
      newLog,
      [
        "I1122 12:05:01.000000 301 server_oauth.go:226] OAuth: authenticated successfully as bob@example.com",
        `I1122 12:05:05.000000 301 server.go:1883] Sending user message to conversation ${conv2} (items=1, media=0)`,
      ].join("\n") + "\n",
    );
    utimesSync(newLog, t2, t2);

    const third = readAgy(state, sources, t2, trackingOps);
    expect(third.filesRead).toBe(1);
    expect(third.recorded).toBe(1);
    expect(openedLogs).toEqual([newLog]);
    const accounts = state
      .pending<IngestUsage>("usage", 10)
      .map((item) => item.payload.accountExternalId);
    expect(accounts).toEqual(["agy-bob", "agy-bob"]);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("poolAccountsFile collects only enabled ready non-default pool directories and prunes excluded instances", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-pool-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const acct3Dir = join(geminiDir, "antigravity-cli-acct3");
    const poolADir = join(geminiDir, "antigravity-cli-pool-p-aaaa1111");
    const poolBDir = join(geminiDir, "antigravity-cli-pool-p-bbbb2222");
    const poolDisabledDir = join(geminiDir, "antigravity-cli-pool-p-cccc3333");
    for (const dir of [
      defaultDir,
      acct3Dir,
      poolADir,
      poolBDir,
      poolDisabledDir,
    ]) {
      mkdirSync(join(dir, "conversations"), { recursive: true });
    }
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      join(defaultDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "defaultuser@example.com" }),
    );
    writeFileSync(
      join(acct3Dir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "acct3user@example.com" }),
    );
    writeFileSync(
      join(poolADir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "poola@example.com" }),
    );
    writeFileSync(
      join(poolBDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "poolb@example.com" }),
    );
    writeFileSync(
      join(poolDisabledDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "disabled@example.com" }),
    );

    const writeDb = (dir: string, name: string, execId: string) => {
      const db = new Database(join(dir, "conversations", `${name}.db`));
      db.exec(
        "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, data BLOB);",
      );
      const t = Math.floor(Date.parse("2026-11-24T10:00:00.000Z") / 1000);
      db.query("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(
        buildGenMetadataFixture({
          responseModel: "gemini-4-neon",
          inputTokens: 1000,
          outputTokens: 200,
          createdAtSeconds: t,
          executionId: execId,
        }),
      );
      db.close();
    };
    writeDb(defaultDir, "conv-default", "exec-default");
    writeDb(acct3Dir, "conv-acct3", "exec-acct3");
    writeDb(poolADir, "conv-pool-a", "exec-pool-a");
    writeDb(poolBDir, "conv-pool-b", "exec-pool-b");
    writeDb(poolDisabledDir, "conv-disabled", "exec-disabled");

    const poolAccountsFile = join(root, "accounts.json");
    writeFileSync(
      poolAccountsFile,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "acct-1",
            kind: "default",
            appDataDir: "antigravity-cli",
            enabled: true,
            status: "ready",
          },
          {
            id: "p-aaaa1111",
            kind: "managed",
            appDataDir: "antigravity-cli-pool-p-aaaa1111",
            enabled: true,
            status: "ready",
          },
          {
            id: "p-bbbb2222",
            kind: "managed",
            appDataDir: "antigravity-cli-pool-p-bbbb2222",
            enabled: true,
            status: "ready",
          },
          {
            id: "p-cccc3333",
            kind: "managed",
            appDataDir: "antigravity-cli-pool-p-cccc3333",
            enabled: false,
            status: "ready",
          },
        ],
      }),
    );

    // 预置旧默认实例与非池实例的刷新状态和跟踪文件，验证切换池模式后会被自动清理。
    state.setMeta("agy_quota_refresh_at", "2026-11-24T09:00:00.000Z");
    state.setMeta("agy_quota_refresh_status", "ok:defaultuser");
    state.setMeta("agy_quota_refresh_at:acct3", "2026-11-24T09:00:00.000Z");
    state.setMeta("agy_quota_refresh_status:acct3", "ok:acct3user");
    state.setMeta(
      "agy_quota_refresh_at:pool-p-aaaa1111",
      "2026-11-24T09:00:00.000Z",
    );

    const sources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      poolAccountsFile,
    };

    const accounts = agyInstanceAccounts(sources);
    expect(accounts.map((a) => a.profile)).toEqual([
      "pool-p-aaaa1111",
      "pool-p-bbbb2222",
    ]);
    expect(accounts.map((a) => a.account)).toEqual(["agy-poola", "agy-poolb"]);

    const report = readAgy(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(report.filesRead).toBe(2);
    expect(report.recorded).toBe(2);
    expect(state.agyFilePaths()).toEqual([
      join(realpathSync(poolADir), "conversations", "conv-pool-a.db"),
      join(realpathSync(poolBDir), "conversations", "conv-pool-b.db"),
    ]);
    expect(state.getMeta("agy_quota_refresh_at")).toBeNull();
    expect(state.getMeta("agy_quota_refresh_status")).toBeNull();
    expect(state.getMeta("agy_quota_refresh_at:acct3")).toBeNull();
    expect(state.getMeta("agy_quota_refresh_status:acct3")).toBeNull();
    expect(state.getMeta("agy_quota_refresh_at:pool-p-aaaa1111")).toBe(
      "2026-11-24T09:00:00.000Z",
    );

    const usageAccounts = state
      .pending<IngestUsage>("usage", 10)
      .map((item) => item.payload.accountExternalId)
      .sort();
    expect(usageAccounts).toEqual(["agy-poola", "agy-poolb"]);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("appDataDirs explicit list excludes default antigravity-cli, supports empty array, and missing/corrupt poolAccountsFile returns empty set", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-explicit-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const alphaDir = join(geminiDir, "antigravity-cli-alpha");
    const betaDir = join(geminiDir, "antigravity-cli-beta");
    for (const dir of [defaultDir, alphaDir, betaDir]) {
      mkdirSync(join(dir, "conversations"), { recursive: true });
    }
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      join(defaultDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "defaultuser@example.com" }),
    );
    writeFileSync(
      join(alphaDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "alpha@example.com" }),
    );
    writeFileSync(
      join(betaDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "beta@example.com" }),
    );

    const writeDb = (dir: string, name: string, execId: string) => {
      const db = new Database(join(dir, "conversations", `${name}.db`));
      db.exec(
        "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, data BLOB);",
      );
      const t = Math.floor(Date.parse("2026-11-24T10:00:00.000Z") / 1000);
      db.query("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(
        buildGenMetadataFixture({
          responseModel: "gemini-4-neon",
          inputTokens: 1000,
          outputTokens: 200,
          createdAtSeconds: t,
          executionId: execId,
        }),
      );
      db.close();
    };
    writeDb(defaultDir, "conv-default", "exec-default");
    writeDb(alphaDir, "conv-alpha", "exec-alpha");
    writeDb(betaDir, "conv-beta", "exec-beta");

    const now = new Date("2026-11-24T10:05:00.000Z");
    const baseSources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
    };

    // 1. 显式 appDataDirs 包含默认目录 antigravity-cli 时，默认目录仍被排除，仅采集列出的非默认实例。
    const explicitSources = {
      ...baseSources,
      appDataDirs: [defaultDir, alphaDir],
    };
    expect(agyInstanceAccounts(explicitSources).map((a) => a.profile)).toEqual([
      "alpha",
    ]);
    const explicitReport = readAgy(state, explicitSources, now);
    expect(explicitReport.filesRead).toBe(1);
    expect(explicitReport.recorded).toBe(1);
    expect(state.agyFilePaths()).toEqual([
      join(realpathSync(alphaDir), "conversations", "conv-alpha.db"),
    ]);

    // 2. 空数组 appDataDirs: [] 显式不采集任何实例，并清理既有跟踪文件与刷新状态。
    state.setMeta("agy_quota_refresh_at:alpha", "2026-11-24T09:00:00.000Z");
    state.setMeta("agy_quota_refresh_status:alpha", "ok:alpha");
    const emptySources = {
      ...baseSources,
      appDataDirs: [] as string[],
    };
    expect(agyInstanceAccounts(emptySources)).toEqual([]);
    const emptyReport = readAgy(state, emptySources, now);
    expect(emptyReport.filesRead).toBe(0);
    expect(emptyReport.recorded).toBe(0);
    expect(state.agyFilePaths()).toEqual([]);
    expect(state.getMeta("agy_quota_refresh_at:alpha")).toBeNull();
    expect(state.getMeta("agy_quota_refresh_status:alpha")).toBeNull();

    // 3. poolAccountsFile 缺失或损坏时返回空集合，不回退到默认自动发现。
    const missingPoolSources = {
      ...baseSources,
      poolAccountsFile: join(root, "does-not-exist.json"),
    };
    expect(agyInstanceAccounts(missingPoolSources)).toEqual([]);
    const missingReport = readAgy(state, missingPoolSources, now);
    expect(missingReport.filesRead).toBe(0);
    expect(missingReport.recorded).toBe(0);

    const corruptPoolFile = join(root, "corrupt-accounts.json");
    writeFileSync(corruptPoolFile, "{not valid json");
    const corruptPoolSources = {
      ...baseSources,
      poolAccountsFile: corruptPoolFile,
    };
    expect(agyInstanceAccounts(corruptPoolSources)).toEqual([]);
    const corruptReport = readAgy(state, corruptPoolSources, now);
    expect(corruptReport.filesRead).toBe(0);
    expect(corruptReport.recorded).toBe(0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit scope excludes symlink aliases to default antigravity-cli and deduplicates symlink aliases to the same directory", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-symlink-scope-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const workDir = join(geminiDir, "antigravity-cli-work");
    const defaultAlias = join(geminiDir, "antigravity-cli-default-alias");
    const workAlias = join(geminiDir, "antigravity-cli-work-alias");

    mkdirSync(join(defaultDir, "conversations"), { recursive: true });
    mkdirSync(join(workDir, "conversations"), { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    symlinkSync(defaultDir, defaultAlias);
    symlinkSync(workDir, workAlias);

    writeFileSync(
      join(defaultDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "defaultuser@example.com" }),
    );
    writeFileSync(
      join(workDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "worker@example.com" }),
    );

    const poolAccountsFile = join(root, "accounts.json");
    writeFileSync(
      poolAccountsFile,
      JSON.stringify([
        {
          kind: "managed",
          appDataDir: defaultAlias,
          enabled: true,
          status: "ready",
        },
        {
          kind: "managed",
          appDataDir: workAlias,
          enabled: true,
          status: "ready",
        },
      ]),
    );

    const sources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [defaultAlias, workDir, workAlias],
      poolAccountsFile,
    };

    const accounts = agyInstanceAccounts(sources);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({
      appDataDir: realpathSync(workDir),
      profile: "work",
      key: "work",
      account: "agy-worker",
    });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("config validation rejects invalid appDataDirs basenames and valid antigravity-cli-work passes discovery and probe end-to-end", async () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-config-probe-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const baseConfig = {
      server: "https://meterleaf.example.com",
      sourceId: "mac-test",
      key: "mlk_test_key_1234567890",
      createdAt: "2026-11-24T00:00:00.000Z",
    };

    for (const badDir of [
      "/profiles/work",
      "/profiles/work.eu",
      "/x/antigravity-cli",
    ]) {
      const cfgPath = join(root, "bad-config.json");
      writeFileSync(
        cfgPath,
        JSON.stringify({ ...baseConfig, agy: { appDataDirs: [badDir] } }),
      );
      expect(() => loadConfig(cfgPath)).toThrow(/antigravity-cli-<名称>/);
    }

    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const workDir = join(geminiDir, "antigravity-cli-work");
    mkdirSync(join(defaultDir, "conversations"), { recursive: true });
    mkdirSync(join(workDir, "conversations"), { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      join(workDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "worker@example.com" }),
    );

    const validCfgPath = join(root, "valid-config.json");
    writeFileSync(
      validCfgPath,
      JSON.stringify({ ...baseConfig, agy: { appDataDirs: [workDir] } }),
    );
    const loaded = loadConfig(validCfgPath);
    expect(loaded?.agy?.appDataDirs).toEqual([workDir]);

    const fakeAgy = join(root, "fake-agy.sh");
    const resetIso = "2026-11-25T15:00:00.000Z";
    writeFileSync(
      fakeAgy,
      [
        "#!/bin/sh",
        'app_data=""',
        'log_file=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --app_data_dir) app_data="$2"; shift 2 ;;',
        '    --log-file) log_file="$2"; shift 2 ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'if [ "$app_data" != "antigravity-cli-work" ]; then exit 9; fi',
        'if [ -n "$log_file" ]; then',
        '  echo "I1124 10:00:01.000000 1 oauth.go:1] authenticated successfully as worker@example.com" > "$log_file"',
        "fi",
        `printf '{"status":"SUCCESS","command":{"data":{"groups":[{"buckets":[{"id":"gemini-5h","remaining_fraction":0.8,"reset_time":"${resetIso}"}]}]}}}'`,
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgy, 0o755);

    const sources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [workDir],
    };
    const report = readAgy(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(report.missingQuotaProfiles).toBe(1);

    const refreshed = await maybeRefreshAgyQuota(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
      { agyBin: fakeAgy },
    );
    expect(refreshed.attempted).toBe(true);
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.label).toBe("worker");
    expect(existsSync(join(statusDir, "quota-worker.tsv"))).toBe(true);
    expect(readAgyCurrentAccount(statusDir, "work")).toBe("worker");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-basename instances in different parent directories isolate refresh meta and current-account files", async () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-same-basename-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const defaultGeminiDir = join(root, ".gemini");
    const defaultDir = join(defaultGeminiDir, "antigravity-cli");
    const statusDir = join(root, "statusline");
    const dirA = join(root, "parent-a", "antigravity-cli-work");
    const dirB = join(root, "parent-b", "antigravity-cli-work");

    for (const dir of [defaultDir, dirA, dirB]) {
      mkdirSync(join(dir, "conversations"), { recursive: true });
    }
    mkdirSync(statusDir, { recursive: true });
    // 不含 id_token_email 的非空令牌，验证账号标签按隔离后的 current-account-<key> 解析且绝不串号。
    writeFileSync(join(dirA, "antigravity-oauth-token"), "{}");
    writeFileSync(join(dirB, "antigravity-oauth-token"), "{}");

    const bothSources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [dirA, dirB],
    };
    const bothAccounts = agyInstanceAccounts(bothSources);
    expect(bothAccounts).toHaveLength(2);
    const keyA = bothAccounts.find(
      (item) => item.appDataDir === realpathSync(dirA),
    )!.key!;
    const keyB = bothAccounts.find(
      (item) => item.appDataDir === realpathSync(dirB),
    )!.key!;
    expect(keyA).toMatch(/^work\.[0-9a-f]{12}$/);
    expect(keyB).toMatch(/^work\.[0-9a-f]{12}$/);
    expect(keyA).not.toBe(keyB);

    const fakeAgy = join(root, "fake-agy-multi.sh");
    const resetIso = "2026-11-25T15:00:00.000Z";
    writeFileSync(
      fakeAgy,
      [
        "#!/bin/sh",
        'gemini_dir=""',
        'log_file=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --gemini_dir) gemini_dir="$2"; shift 2 ;;',
        '    --log-file) log_file="$2"; shift 2 ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'case "$gemini_dir" in',
        '  *parent-a) email="worka@example.com" ;;',
        '  *parent-b) email="workb@example.com" ;;',
        "  *) exit 8 ;;",
        "esac",
        'if [ -n "$log_file" ]; then',
        '  echo "I1124 10:00:01.000000 1 oauth.go:1] authenticated successfully as $email" > "$log_file"',
        "fi",
        `printf '{"status":"SUCCESS","command":{"data":{"groups":[{"buckets":[{"id":"gemini-5h","remaining_fraction":0.75,"reset_time":"${resetIso}"}]}]}}}'`,
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgy, 0o755);

    const refreshRes = await maybeRefreshAgyQuota(
      state,
      bothSources,
      new Date("2026-11-24T10:05:00.000Z"),
      { agyBin: fakeAgy, profiles: [keyA, keyB] },
    );
    expect(refreshRes.refreshed).toBe(true);
    expect(readAgyCurrentAccount(statusDir, keyA)).toBe("worka");
    expect(readAgyCurrentAccount(statusDir, keyB)).toBe("workb");
    expect(state.getMeta(`agy_quota_refresh_status:${keyA}`)).toBe("ok:worka");
    expect(state.getMeta(`agy_quota_refresh_status:${keyB}`)).toBe("ok:workb");

    // 移除 parent-a 后重扫：清理 keyA 元信息，保留 keyB 元信息，且 parent-b 仍准确解析为 workb。
    const onlyBSources = {
      ...bothSources,
      appDataDirs: [dirB],
    };
    readAgy(state, onlyBSources, new Date("2026-11-24T10:06:00.000Z"));
    expect(state.getMeta(`agy_quota_refresh_at:${keyA}`)).toBeNull();
    expect(state.getMeta(`agy_quota_refresh_status:${keyA}`)).toBeNull();
    expect(state.getMeta(`agy_quota_refresh_at:${keyB}`)).not.toBeNull();
    expect(state.getMeta(`agy_quota_refresh_status:${keyB}`)).toBe("ok:workb");
    expect(agyInstanceAccounts(onlyBSources)).toEqual([
      {
        appDataDir: realpathSync(dirB),
        profile: "work",
        key: keyB,
        account: "agy-workb",
      },
    ]);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit scope filters out-of-scope quota files in readAgy and enforces allowedLabels in maybeRefreshOmpAgyQuota", async () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-omp-scope-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const bobDir = join(geminiDir, "antigravity-cli-bob");
    mkdirSync(join(defaultDir, "conversations"), { recursive: true });
    mkdirSync(join(bobDir, "conversations"), { recursive: true });
    mkdirSync(statusDir, { recursive: true });

    writeFileSync(
      join(bobDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "bob@example.com" }),
    );
    writeFileSync(
      join(statusDir, "quota-alice.tsv"),
      "gemini_5h\t20\t1796000000\n",
    );
    writeFileSync(
      join(statusDir, "quota-bob.tsv"),
      "gemini_5h\t35\t1796000000\n",
    );

    const sources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [bobDir],
    };
    const allowed = agyAllowedQuotaLabels(sources)!;
    expect([...allowed]).toEqual(["bob"]);

    const report = readAgy(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(report.quotas).toBe(1);
    const pendingQuotas = state.pending<IngestQuota>("quota", 10);
    expect(pendingQuotas.map((q) => q.payload.accountExternalId)).toEqual([
      "agy-bob",
    ]);

    // 构造只返回范围外账号（alice）的假 omp 脚本：不得写出新 quota-carol.tsv，也不得虚报成功。
    const fakeOmp = join(root, "fake-omp.sh");
    writeFileSync(
      fakeOmp,
      [
        "#!/bin/sh",
        'printf \'{"reports":[{"provider":"google-antigravity","metadata":{"email":"carol@example.com"},"limits":[{"id":"google-antigravity:google:default:gemini-5h","amount":{"remainingFraction":0.5},"window":{"resetsAt":1796000000000}}]}]}\'',
        "",
      ].join("\n"),
    );
    chmodSync(fakeOmp, 0o755);

    const ompRes = await maybeRefreshOmpAgyQuota(
      state,
      { statuslineDir: statusDir },
      { exhausted: false },
      new Date("2026-11-24T10:05:00.000Z"),
      { ompBin: fakeOmp, allowedLabels: allowed },
    );
    expect(ompRes.attempted).toBe(true);
    expect(ompRes.refreshed).toBe(false);
    expect(ompRes.labels).toEqual([]);
    expect(ompRes.error).toContain("不在当前 Antigravity 采集范围内");
    expect(existsSync(join(statusDir, "quota-carol.tsv"))).toBe(false);

    // allowedLabels 为空集合时直接跳过，不启动 omp 子进程。
    const skippedRes = await maybeRefreshOmpAgyQuota(
      state,
      { statuslineDir: statusDir },
      { exhausted: false },
      new Date("2026-11-24T10:15:00.000Z"),
      { ompBin: fakeOmp, allowedLabels: new Set() },
    );
    expect(skippedRes).toEqual({
      attempted: false,
      refreshed: false,
      labels: [],
      error: null,
    });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared log cache prunes removed member immediately when DB is unchanged, and default mode preserves refresh backoff when extra token disappears", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-prune-backoff-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const sharedConvDir = join(defaultDir, "conversations");
    const dirA = join(geminiDir, "antigravity-cli-a");
    const dirB = join(geminiDir, "antigravity-cli-b");
    const dirC = join(geminiDir, "antigravity-cli-c");

    mkdirSync(sharedConvDir, { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    for (const [dir, email] of [
      [dirA, "aa@example.com"],
      [dirB, "bb@example.com"],
      [dirC, "cc@example.com"],
    ] as const) {
      mkdirSync(join(dir, "log"), { recursive: true });
      symlinkSync(sharedConvDir, join(dir, "conversations"));
      writeFileSync(
        join(dir, "antigravity-oauth-token"),
        JSON.stringify({ id_token_email: email }),
      );
    }

    const convId = "33333333-4444-4555-8666-777777777777";
    const t1 = new Date(2026, 10, 24, 11, 0, 10, 0);
    const db = new Database(join(sharedConvDir, `${convId}.db`));
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
        "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
    );
    const sec = Math.floor(t1.getTime() / 1000);
    db.query(
      "INSERT INTO steps (idx, type, status, metadata) VALUES (1, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', 'DONE', ?1)",
    ).run(
      buildStepMetadataFixture({
        createdAtSeconds: sec - 2,
        finishedAtSeconds: sec - 1,
        completedAtSeconds: sec,
        executionId: "exec-a-1",
      }),
    );
    db.query(
      "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (1, 'exec-a-1', ?1)",
    ).run(
      buildGenMetadataFixture({
        responseModel: "gemini-4-neon",
        inputTokens: 1000,
        outputTokens: 100,
        executionId: "exec-a-1",
        stepIndices: [1],
      }),
    );
    db.close();

    const logA = join(dirA, "log", "acp-server-20261124_110000-1.log");
    const logB = join(dirB, "log", "acp-server-20261124_110000-2.log");
    const logC = join(dirC, "log", "acp-server-20261124_110000-3.log");
    writeFileSync(
      logA,
      `I1124 11:00:05.000000 1 server.go:1] Sending user message to conversation ${convId}\n`,
    );
    writeFileSync(logB, "I1124 11:00:01.000000 2 server.go:1] idle\n");
    writeFileSync(logC, "I1124 11:00:01.000000 3 server.go:1] idle\n");

    const baseSources = {
      conversationsDir: sharedConvDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
    };

    // 第一轮（默认模式，包含 A/B/C）：写入三个共享日志缓存条目。
    readAgy(state, baseSources, t1);
    expect(state.agySharedLog(logA)).not.toBeNull();
    expect(state.agySharedLog(logB)).not.toBeNull();
    expect(state.agySharedLog(logC)).not.toBeNull();

    // 预置 C 的 5 分钟刷新退避记录，然后临时移除 C 的 token 文件（模拟默认模式下短暂缺令牌）。
    state.setMeta("agy_quota_refresh_at:c", "2026-11-24T11:00:00.000Z");
    state.setMeta("agy_quota_refresh_status:c", "error:temp");
    rmSync(join(dirC, "antigravity-oauth-token"));

    // 第二轮（默认模式，DB 未变化）：C 的共享日志缓存应立即清理，但默认模式必须保留 C 的 5 分钟刷新退避。
    const second = readAgy(state, baseSources, t1);
    expect(second.filesRead).toBe(0);
    expect(state.agySharedLog(logA)).not.toBeNull();
    expect(state.agySharedLog(logB)).not.toBeNull();
    expect(state.agySharedLog(logC)).toBeNull();
    expect(state.getMeta("agy_quota_refresh_at:c")).toBe(
      "2026-11-24T11:00:00.000Z",
    );
    expect(state.getMeta("agy_quota_refresh_status:c")).toBe("error:temp");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("status formatting shows both poolAccountsFile and appDataDirs and filters refresh lines to active explicit scope", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-status-fmt-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const alphaDir = join(geminiDir, "antigravity-cli-alpha");
    const betaDir = join(geminiDir, "antigravity-cli-beta");
    for (const dir of [defaultDir, alphaDir, betaDir]) {
      mkdirSync(join(dir, "conversations"), { recursive: true });
    }
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      join(alphaDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "alpha@example.com" }),
    );
    writeFileSync(
      join(betaDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "beta@example.com" }),
    );

    const poolAccountsFile = join(root, "accounts.json");
    writeFileSync(
      poolAccountsFile,
      JSON.stringify({
        accounts: [
          {
            kind: "managed",
            appDataDir: "antigravity-cli-alpha",
            enabled: true,
            status: "ready",
          },
        ],
      }),
    );

    const combinedSources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      poolAccountsFile,
      appDataDirs: [betaDir],
    };
    const desc = formatAgySourceDesc(combinedSources);
    expect(desc).toContain(`池 ${poolAccountsFile}`);
    expect(desc).toContain("显式目录 (1)");
    expect(desc).toContain("2 个实例");
    expect(desc).toContain("alpha");
    expect(desc).toContain("beta");

    // 预置默认实例与 alpha/beta 的旧刷新记录，未跑 sync 直接切换为 appDataDirs: [] 时，status 立即隐藏已移出实例。
    state.setMeta("agy_quota_refresh_at", "2026-11-24T09:00:00.000Z");
    state.setMeta("agy_quota_refresh_status", "ok:defaultuser");
    state.setMeta("agy_quota_refresh_at:alpha", "2026-11-24T09:00:00.000Z");
    state.setMeta("agy_quota_refresh_status:alpha", "ok:alpha");
    state.setMeta("agy_quota_refresh_at:beta", "2026-11-24T09:00:00.000Z");
    state.setMeta("agy_quota_refresh_status:beta", "ok:beta");

    const activeLines = formatAgyRefreshLines(state, {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [betaDir],
    });
    expect(activeLines).toHaveLength(1);
    expect(activeLines[0]).toContain("(beta)");

    const emptyLines = formatAgyRefreshLines(state, {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [],
    });
    expect(emptyLines).toEqual([]);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1' explicit set-difference skips shared conversations dir with out-of-scope default instance without reading its token and reports count in status", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-a1p-dir-shared-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  const defaultTokenPath = join(
    root,
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token",
  );
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const sharedConvDir = join(defaultDir, "conversations");
    const dirA = join(geminiDir, "antigravity-cli-a");

    mkdirSync(sharedConvDir, { recursive: true });
    mkdirSync(dirA, { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    symlinkSync(sharedConvDir, join(dirA, "conversations"));

    // 默认目录令牌不可读，验证 A1' 集合差绝不读取范围外实例令牌或日志。
    writeFileSync(
      defaultTokenPath,
      JSON.stringify({ id_token_email: "secret-default@example.com" }),
    );
    chmodSync(defaultTokenPath, 0o000);
    writeFileSync(
      join(dirA, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "usera@example.com" }),
    );

    const db = new Database(join(sharedConvDir, "conv-shared.db"));
    db.exec(
      "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, data BLOB);",
    );
    db.query("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(
      buildGenMetadataFixture({
        responseModel: "gemini-4-neon",
        inputTokens: 1_500,
        outputTokens: 200,
        createdAtSeconds: Math.floor(
          Date.parse("2026-11-24T10:00:00.000Z") / 1000,
        ),
        executionId: "exec-shared-1",
      }),
    );
    db.close();

    const sources = {
      conversationsDir: sharedConvDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [dirA],
    };

    const report = readAgy(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(report.filesRead).toBe(0);
    expect(report.recorded).toBe(0);
    expect(report.skippedOutOfScopeShared).toBe(1);
    expect(report.skipped["(范围外共享库)"]).toBe(1);
    expect(state.pending<IngestUsage>("usage", 10)).toEqual([]);
    expect(formatAgySourceDesc(sources)).toContain("跳过范围外共享库 1 个");
  } finally {
    try {
      chmodSync(defaultTokenPath, 0o600);
    } catch {
      // 忽略清理异常。
    }
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1' explicit set-difference skips forward and reverse single-.db symlinks while collecting independent DBs", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-a1p-single-db-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const externalDir = join(root, "elsewhere");
    const dirA = join(geminiDir, "antigravity-cli-a");
    const dirOutB = join(geminiDir, "antigravity-cli-outb");

    for (const dir of [defaultDir, dirA, dirOutB]) {
      mkdirSync(join(dir, "conversations"), { recursive: true });
    }
    mkdirSync(externalDir, { recursive: true });
    mkdirSync(statusDir, { recursive: true });

    writeFileSync(
      join(dirA, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "usera@example.com" }),
    );
    writeFileSync(
      join(dirOutB, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "outb@example.com" }),
    );

    const writeDb = (dbPath: string, execId: string, inputTokens: number) => {
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, data BLOB);",
      );
      db.query("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(
        buildGenMetadataFixture({
          responseModel: "gemini-4-neon",
          inputTokens,
          outputTokens: 100,
          createdAtSeconds: Math.floor(
            Date.parse("2026-11-24T10:00:00.000Z") / 1000,
          ),
          executionId: execId,
        }),
      );
      db.close();
    };

    // (b) 正向单文件软链接：A 分别软链到默认目录与外部任意目录的 .db。
    const defaultDb = join(defaultDir, "conversations", "from-default.db");
    const externalDb = join(externalDir, "from-external.db");
    writeDb(defaultDb, "exec-default", 1_100);
    writeDb(externalDb, "exec-external", 2_200);
    symlinkSync(defaultDb, join(dirA, "conversations", "from-default.db"));
    symlinkSync(externalDb, join(dirA, "conversations", "from-external.db"));

    // (c) 反向单文件软链接：范围外 outB 软链到 A 的 one.db；A 另有独立 two.db。
    const oneDb = join(dirA, "conversations", "one.db");
    const twoDb = join(dirA, "conversations", "two.db");
    writeDb(oneDb, "exec-one-shared", 3_300);
    writeDb(twoDb, "exec-two-own", 4_400);
    symlinkSync(oneDb, join(dirOutB, "conversations", "one.db"));

    const sources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [dirA],
    };

    const report = readAgy(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(report.filesRead).toBe(1);
    expect(report.recorded).toBe(1);
    expect(report.skippedOutOfScopeShared).toBe(3);
    expect(report.skipped["(范围外共享库)"]).toBe(3);
    const usage = state.pending<IngestUsage>("usage", 10);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.payload.accountExternalId).toBe("agy-usera");
    expect(usage[0]!.payload.tokens.input).toBe(4_400);
    expect(formatAgySourceDesc(sources)).toContain("跳过范围外共享库 3 个");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1' per-file grouping splits in-scope shared single DB via logs while collecting sibling independent DB directly without logs", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-a1p-inscope-file-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const dirA = join(geminiDir, "antigravity-cli-a");
    const dirB = join(geminiDir, "antigravity-cli-b");

    for (const dir of [defaultDir, dirA, dirB]) {
      mkdirSync(join(dir, "conversations"), { recursive: true });
    }
    mkdirSync(join(dirA, "log"), { recursive: true });
    mkdirSync(join(dirB, "log"), { recursive: true });
    mkdirSync(statusDir, { recursive: true });

    writeFileSync(
      join(dirA, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "usera@example.com" }),
    );
    writeFileSync(
      join(dirB, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "userb@example.com" }),
    );

    const sharedConvId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const t1 = new Date(2026, 10, 24, 10, 0, 10, 0);
    const t2 = new Date(2026, 10, 24, 10, 2, 10, 0);

    // 仅范围内 A 与 B 共享单个文件 sharedConvId.db（存于 B，A 软链指向它）。
    const sharedDbPath = join(dirB, "conversations", `${sharedConvId}.db`);
    const sharedDb = new Database(sharedDbPath);
    sharedDb.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
        "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
    );
    for (const [idx, when, execId, tokens] of [
      [1, t1, "exec-a-1", 1_000],
      [2, t2, "exec-b-1", 2_000],
    ] as const) {
      const sec = Math.floor(when.getTime() / 1000);
      sharedDb
        .query(
          "INSERT INTO steps (idx, type, status, metadata) VALUES (?1, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', 'DONE', ?2)",
        )
        .run(
          idx,
          buildStepMetadataFixture({
            createdAtSeconds: sec - 2,
            finishedAtSeconds: sec - 1,
            completedAtSeconds: sec,
            executionId: execId,
          }),
        );
      sharedDb
        .query(
          "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (?1, ?2, ?3)",
        )
        .run(
          idx,
          execId,
          buildGenMetadataFixture({
            responseModel: "gemini-4-neon",
            inputTokens: tokens,
            outputTokens: 100,
            executionId: execId,
            stepIndices: [idx],
          }),
        );
    }
    sharedDb.close();
    symlinkSync(
      sharedDbPath,
      join(dirA, "conversations", `${sharedConvId}.db`),
    );

    // B 另有独立 two.db（无任何发送日志），应按单实例直采归 B，不受 sharedConvId.db 共享牵连。
    const ownDbPath = join(dirB, "conversations", "two.db");
    const ownDb = new Database(ownDbPath);
    ownDb.exec(
      "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, data BLOB);",
    );
    ownDb.query("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(
      buildGenMetadataFixture({
        responseModel: "gemini-4-neon",
        inputTokens: 5_000,
        outputTokens: 100,
        createdAtSeconds: Math.floor(t2.getTime() / 1000),
        executionId: "exec-b-own",
      }),
    );
    ownDb.close();

    const logA = join(dirA, "log", "acp-server-20261124_100000-1.log");
    writeFileSync(
      logA,
      [
        "I1124 10:00:01.000000 1 server_oauth.go:226] OAuth: authenticated successfully as usera@example.com",
        `I1124 10:00:05.000000 1 server.go:1883] Sending user message to conversation ${sharedConvId} (items=1, media=0)`,
      ].join("\n") + "\n",
    );
    utimesSync(logA, t1, t1);

    const logB = join(dirB, "log", "acp-server-20261124_100200-2.log");
    writeFileSync(
      logB,
      [
        "I1124 10:02:01.000000 2 server_oauth.go:226] OAuth: authenticated successfully as userb@example.com",
        `I1124 10:02:05.000000 2 server.go:1883] Sending user message to conversation ${sharedConvId} (items=1, media=0)`,
      ].join("\n") + "\n",
    );
    utimesSync(logB, t2, t2);

    const sources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [dirA, dirB],
    };

    const report = readAgy(state, sources, new Date(2026, 10, 24, 10, 5, 0, 0));
    expect(report.filesRead).toBe(2);
    expect(report.recorded).toBe(3);
    expect(report.skippedOutOfScopeShared).toBe(0);
    const byTokens = new Map(
      state
        .pending<IngestUsage>("usage", 10)
        .map((item) => [
          item.payload.tokens.input,
          item.payload.accountExternalId,
        ]),
    );
    expect(byTokens.get(1_000)).toBe("agy-usera");
    expect(byTokens.get(2_000)).toBe("agy-userb");
    expect(byTokens.get(5_000)).toBe("agy-userb");
    expect(formatAgySourceDesc(sources)).not.toContain("跳过范围外共享库");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1' explicit set-difference covers defaultGeminiDir even when conversationsDir is overridden to a custom path", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-a1p-custom-conv-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const defaultGeminiDir = join(root, ".gemini");
    const customConvDir = join(
      root,
      "custom",
      "antigravity-cli",
      "conversations",
    );
    const profilesDir = join(root, "profiles");
    const dirA = join(profilesDir, "antigravity-cli-a");
    const dirB = join(defaultGeminiDir, "antigravity-cli-b");
    const statusDir = join(root, "statusline");

    mkdirSync(customConvDir, { recursive: true });
    mkdirSync(join(dirA, "conversations"), { recursive: true });
    mkdirSync(join(dirB, "conversations"), { recursive: true });
    mkdirSync(statusDir, { recursive: true });

    writeFileSync(
      join(dirA, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "usera@example.com" }),
    );
    writeFileSync(
      join(dirB, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "userb@example.com" }),
    );

    const oneDb = join(dirA, "conversations", "one.db");
    const db = new Database(oneDb);
    db.exec(
      "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, data BLOB);",
    );
    db.query("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(
      buildGenMetadataFixture({
        responseModel: "gemini-4-neon",
        inputTokens: 2_345,
        outputTokens: 100,
        createdAtSeconds: Math.floor(
          Date.parse("2026-11-24T10:00:00.000Z") / 1000,
        ),
        executionId: "exec-custom-conv-1",
      }),
    );
    db.close();

    // 位于 defaultGeminiDir 下的范围外 B 反向软链到外部 profiles/ 下 A 的 one.db。
    symlinkSync(oneDb, join(dirB, "conversations", "one.db"));

    const sources = {
      conversationsDir: customConvDir,
      defaultGeminiDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [dirA],
    };

    const report = readAgy(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(report.filesRead).toBe(0);
    expect(report.recorded).toBe(0);
    expect(report.skippedOutOfScopeShared).toBe(1);
    expect(report.skipped["(范围外共享库)"]).toBe(1);
    expect(state.pending<IngestUsage>("usage", 10)).toEqual([]);
    expect(formatAgySourceDesc(sources)).toContain("跳过范围外共享库 1 个");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1' explicit set-difference fails closed when an out-of-scope conversations dir is unreadable (chmod 0o111)", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-a1p-unreadable-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  const outBConvDir = join(
    root,
    ".gemini",
    "antigravity-cli-b",
    "conversations",
  );
  try {
    const geminiDir = join(root, ".gemini");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const dirA = join(geminiDir, "antigravity-cli-a");
    const statusDir = join(root, "statusline");

    mkdirSync(join(defaultDir, "conversations"), { recursive: true });
    mkdirSync(join(dirA, "conversations"), { recursive: true });
    mkdirSync(outBConvDir, { recursive: true });
    mkdirSync(statusDir, { recursive: true });

    writeFileSync(
      join(dirA, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "usera@example.com" }),
    );

    const oneDb = join(dirA, "conversations", "one.db");
    const db = new Database(oneDb);
    db.exec(
      "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, data BLOB);",
    );
    db.query("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(
      buildGenMetadataFixture({
        responseModel: "gemini-4-neon",
        inputTokens: 3_456,
        outputTokens: 100,
        createdAtSeconds: Math.floor(
          Date.parse("2026-11-24T10:00:00.000Z") / 1000,
        ),
        executionId: "exec-unreadable-1",
      }),
    );
    db.close();

    symlinkSync(oneDb, join(outBConvDir, "one.db"));
    // 0o111：可遍历但 readdirSync 返回 EACCES，验证 fail-closed 暂缓而不放行。
    chmodSync(outBConvDir, 0o111);

    const sources = {
      conversationsDir: join(defaultDir, "conversations"),
      defaultGeminiDir: geminiDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [dirA],
    };

    const report = readAgy(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(report.filesRead).toBe(0);
    expect(report.recorded).toBe(0);
    expect(report.unreadable).toBeGreaterThan(0);
    expect(report.skippedOutOfScopeShared).toBe(1);
    expect(report.skipped["(目录不可读，已暂缓)"]).toBe(1);
    expect(state.pending<IngestUsage>("usage", 10)).toEqual([]);
    expect(formatAgySourceDesc(sources)).toContain("目录不可读，已暂缓 1 个库");
  } finally {
    try {
      chmodSync(outBConvDir, 0o755);
    } catch {
      // 忽略清理异常。
    }
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1' explicit set-difference fails closed when an in-scope sibling conversations dir is unreadable (chmod 0o111) and preserves cursors and shared log cache", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-a1p-inscope-eacces-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  const dirBConvDir = join(
    root,
    ".gemini",
    "antigravity-cli-b",
    "conversations",
  );
  try {
    const geminiDir = join(root, ".gemini");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const dirA = join(geminiDir, "antigravity-cli-a");
    const dirB = join(geminiDir, "antigravity-cli-b");
    const statusDir = join(root, "statusline");

    mkdirSync(join(defaultDir, "conversations"), { recursive: true });
    mkdirSync(join(dirA, "conversations"), { recursive: true });
    mkdirSync(dirBConvDir, { recursive: true });
    mkdirSync(statusDir, { recursive: true });

    writeFileSync(
      join(dirA, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "usera@example.com" }),
    );
    writeFileSync(
      join(dirB, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "userb@example.com" }),
    );

    const oneDb = join(dirA, "conversations", "one.db");
    const db = new Database(oneDb);
    db.exec(
      "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, data BLOB);",
    );
    db.query("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(
      buildGenMetadataFixture({
        responseModel: "gemini-4-neon",
        inputTokens: 4_567,
        outputTokens: 100,
        createdAtSeconds: Math.floor(
          Date.parse("2026-11-24T10:00:00.000Z") / 1000,
        ),
        executionId: "exec-inscope-eacces-1",
      }),
    );
    db.close();

    symlinkSync(oneDb, join(dirBConvDir, "one.db"));
    // 预置既有游标与共享日志缓存，验证瞬时目录不可读期间不会被误清。
    const savedCursorPath = join(
      realpathSync(dirA),
      "conversations",
      "prev.db",
    );
    state.saveAgyFile({
      path: savedCursorPath,
      inode: "1",
      size: 10,
      modified: 1000,
      walSize: 0,
      walModified: 0,
      account: "usera",
    });
    const savedLogPath = join(realpathSync(dirA), "log", "acp-server-prev.log");
    state.saveAgySharedLog({
      path: savedLogPath,
      inode: "2",
      size: 20,
      modified: 1000,
      defaultLabel: "a\0usera",
      events: "[]",
    });

    // B 同样在范围内，但 B 的 conversations/ 设为 0o111（readdirSync 返回 EACCES），不得把 one.db 当作 A 独占库入账。
    chmodSync(dirBConvDir, 0o111);

    const sources = {
      conversationsDir: join(defaultDir, "conversations"),
      defaultGeminiDir: geminiDir,
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [dirA, dirB],
    };

    const report = readAgy(
      state,
      sources,
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(report.filesRead).toBe(0);
    expect(report.recorded).toBe(0);
    expect(report.unreadable).toBeGreaterThan(0);
    expect(report.skippedOutOfScopeShared).toBe(1);
    expect(report.skipped["(目录不可读，已暂缓)"]).toBe(1);
    expect(state.pending<IngestUsage>("usage", 10)).toEqual([]);
    expect(state.agyFile(savedCursorPath)).not.toBeNull();
    expect(state.agySharedLog(savedLogPath)).not.toBeNull();
    expect(formatAgySourceDesc(sources)).toContain("目录不可读，已暂缓 1 个库");
  } finally {
    try {
      chmodSync(dirBConvDir, 0o755);
    } catch {
      // 忽略清理异常。
    }
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("external parent dir instance keys use disjoint dot namespace and never collide with default parent dir profiles", () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-r3-disjoint-keys-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  try {
    const defaultGeminiDir = join(root, ".gemini");
    const defaultDir = join(defaultGeminiDir, "antigravity-cli");
    const statusDir = join(root, "statusline");
    const extWorkDir = join(root, "external", "antigravity-cli-work");
    mkdirSync(join(defaultDir, "conversations"), { recursive: true });
    mkdirSync(join(extWorkDir, "conversations"), { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      join(extWorkDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "extwork@example.com" }),
    );

    const extKey = agyInstanceAccounts({
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      appDataDirs: [extWorkDir],
    })[0]!.key!;
    expect(extKey).toMatch(/^work\.[0-9a-f]{12}$/);

    // 在默认父目录下故意构造带有旧 `--` 格式或与外部后缀同名的目录，验证命名空间数学不相交。
    const defaultSameSuffix = join(
      defaultGeminiDir,
      `antigravity-cli-work--${extKey.slice("work.".length, "work.".length + 8)}`,
    );
    mkdirSync(join(defaultSameSuffix, "conversations"), { recursive: true });
    writeFileSync(
      join(defaultSameSuffix, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "defwork@example.com" }),
    );

    const bothSources = {
      conversationsDir: join(defaultDir, "conversations"),
      statuslineDir: statusDir,
      start: "2026-09-20T00:00:00.000Z",
      appDataDirs: [extWorkDir, defaultSameSuffix],
    };
    const accounts = agyInstanceAccounts(bothSources);
    expect(accounts).toHaveLength(2);
    const keys = accounts.map((a) => a.key!);
    expect(new Set(keys).size).toBe(2);
    const defKey = accounts.find(
      (a) => a.appDataDir === realpathSync(defaultSameSuffix),
    )!.key!;
    expect(defKey).not.toContain(".");
    expect(extKey).toContain(".");

    state.setMeta(`agy_quota_refresh_at:${extKey}`, "2026-11-24T09:00:00.000Z");
    state.setMeta(`agy_quota_refresh_at:${defKey}`, "2026-11-24T09:00:00.000Z");

    // 移除外部实例后，仅清理 extKey，保留 defKey。
    readAgy(
      state,
      { ...bothSources, appDataDirs: [defaultSameSuffix] },
      new Date("2026-11-24T10:05:00.000Z"),
    );
    expect(state.getMeta(`agy_quota_refresh_at:${extKey}`)).toBeNull();
    expect(state.getMeta(`agy_quota_refresh_at:${defKey}`)).toBe(
      "2026-11-24T09:00:00.000Z",
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readNewSources recomputes allowedLabels after agy probe writes current-account so same-round omp 429 refresh succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-agy-r3-same-round-omp-"));
  const state = new CollectorState(join(root, "state.sqlite"));
  const prevAgyBin = process.env.AGY_BIN;
  const prevOmpBin = process.env.OMP_BIN;
  try {
    const geminiDir = join(root, ".gemini");
    const statusDir = join(root, "statusline");
    const defaultDir = join(geminiDir, "antigravity-cli");
    const workDir = join(geminiDir, "antigravity-cli-work");
    const ompSessionsDir = join(root, "omp", "sessions");
    const ompProjectDir = join(ompSessionsDir, "proj-1");

    mkdirSync(join(defaultDir, "conversations"), { recursive: true });
    mkdirSync(join(workDir, "conversations"), { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    mkdirSync(ompProjectDir, { recursive: true });

    // 初始仅含无邮箱非空令牌且无 current-account-work，初始 agyAllowedQuotaLabels 为空集合。
    writeFileSync(join(workDir, "antigravity-oauth-token"), "{}");

    // work 实例有一条待归属用量，触发 agyMissing → maybeRefreshAgyQuota。
    const db = new Database(join(workDir, "conversations", "conv-work.db"));
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, type TEXT, status TEXT, metadata TEXT);" +
        "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, execution_id TEXT, data TEXT);",
    );
    const tSec = Math.floor(Date.parse("2026-11-24T10:00:00.000Z") / 1000);
    db.query(
      "INSERT INTO gen_metadata (idx, execution_id, data) VALUES (1, 'exec-work-1', ?1)",
    ).run(
      buildGenMetadataFixture({
        responseModel: "gemini-4-neon",
        inputTokens: 1_200,
        outputTokens: 200,
        createdAtSeconds: tSec,
        executionId: "exec-work-1",
      }),
    );
    db.close();

    // omp 会话出现 google-antigravity 429，触发同轮 omp 实时刷新。
    writeFileSync(
      join(ompProjectDir, "session-1.jsonl"),
      JSON.stringify({
        type: "message",
        id: "msg-429",
        timestamp: "2026-11-24T10:01:00.000Z",
        message: {
          role: "assistant",
          provider: "google-antigravity",
          model: "gemini-4-neon",
          stopReason: "error",
          errorStatus: 429,
          errorMessage: "429 RESOURCE_EXHAUSTED: quota exceeded",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          timestamp: Date.parse("2026-11-24T10:01:00.000Z"),
        },
      }) + "\n",
    );

    const fakeAgy = join(root, "fake-agy.sh");
    writeFileSync(
      fakeAgy,
      [
        "#!/bin/sh",
        'log_file=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --log-file) log_file="$2"; shift 2 ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'if [ -n "$log_file" ]; then',
        '  echo "I1124 10:00:01.000000 1 oauth.go:1] authenticated successfully as freshworker@example.com" > "$log_file"',
        "fi",
        'printf \'{"status":"SUCCESS","command":{"data":{"groups":[{"buckets":[{"id":"gemini-5h","remaining_fraction":0.9,"reset_time":"2026-11-25T15:00:00.000Z"}]}]}}}"\' | sed \'s/"$//\'',
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgy, 0o755);

    const ompInvokedFile = join(root, "omp-invoked.txt");
    const fakeOmp = join(root, "fake-omp.sh");
    writeFileSync(
      fakeOmp,
      [
        "#!/bin/sh",
        `echo "$@" >> "${ompInvokedFile}"`,
        'if [ "$2" = "invalidate" ]; then exit 0; fi',
        'printf \'{"reports":[{"provider":"google-antigravity","metadata":{"email":"freshworker@example.com"},"limits":[{"id":"google-antigravity:google:default:gemini-5h","amount":{"remainingFraction":0.0},"window":{"resetsAt":1796000000000}}]}]}\'',
        "",
      ].join("\n"),
    );
    chmodSync(fakeOmp, 0o755);

    process.env.AGY_BIN = fakeAgy;
    process.env.OMP_BIN = fakeOmp;

    const config: CollectorConfig = {
      server: "https://meterleaf.example.com",
      sourceId: "mac-test",
      key: "mlk_test_key_1234567890",
      createdAt: "2026-11-24T00:00:00.000Z",
      codex: { enabled: false },
      opencode: { enabled: false },
      agy: {
        enabled: true,
        conversationsDir: join(defaultDir, "conversations"),
        statuslineDir: statusDir,
        appDataDirs: [workDir],
      },
      omp: {
        enabled: true,
        sessionsDir: ompSessionsDir,
      },
    };

    expect(
      agyAllowedQuotaLabels({
        conversationsDir: join(defaultDir, "conversations"),
        statuslineDir: statusDir,
        appDataDirs: [workDir],
      })!.size,
    ).toBe(0);

    const reports = await readNewSources(state, config, {
      allowQuotaRefresh: true,
    });
    const agyReport = reports.find(
      (r) => r.source === "agy",
    ) as AgyReaderReport;
    expect(agyReport.quotaRefreshed).toBe(true);
    expect(readAgyCurrentAccount(statusDir, "work")).toBe("freshworker");
    // 同轮重算 allowedLabels 后，omp 应被触发并成功写入 freshworker 的 429 实时额度（100%）。
    expect(existsSync(ompInvokedFile)).toBe(true);
    expect(state.getMeta("omp_agy_quota_refresh_status")).toBe(
      "ok:freshworker",
    );
    const quotaContent = readFileSync(
      join(statusDir, "quota-freshworker.tsv"),
      "utf8",
    );
    expect(quotaContent).toContain("gemini_5h\t100\t1796000000");
  } finally {
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    if (prevOmpBin === undefined) delete process.env.OMP_BIN;
    else process.env.OMP_BIN = prevOmpBin;
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
