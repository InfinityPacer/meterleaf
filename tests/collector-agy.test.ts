import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agyAccountsForLabel,
  agyPoolOfModel,
  agyQuotaSnapshot,
  decodeAgyGenMetadata,
  decodeAgyStepMetadata,
  extractAgyTokens,
  normalizeAgyModel,
  readAgy,
  readAgyCurrentAccount,
  readAgyQuotaFile,
} from "../src/collector/agy";
import { CollectorState } from "../src/collector/state";
import type { UsageFact } from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { valueUsage } from "../src/domain/pricing";
import { quotaView } from "../src/domain/quota";
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
      accountExternalId: "agy-alice-gemini",
      window: "five-hour",
      windowMinutes: 300,
      percent: 22,
      resetsAt: "2026-10-31T01:20:00.000Z",
      expired: false,
    });
    expect(byKey.get("gemini_weekly")).toEqual({
      key: "gemini_weekly",
      pool: "gemini",
      accountExternalId: "agy-alice-gemini",
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
      accountExternalId: "agy-alice-3p",
      window: "five-hour",
      windowMinutes: 300,
      percent: null,
      resetsAt: "2026-10-30T00:26:40.000Z",
      expired: true,
    });
    // 3p_weekly had "-" for percent and valid future reset
    expect(byKey.get("3p_weekly")).toEqual({
      key: "3p_weekly",
      pool: "3p",
      accountExternalId: "agy-alice-3p",
      window: "seven-day",
      windowMinutes: 10080,
      percent: null,
      resetsAt: "2026-11-05T01:20:00.000Z",
      expired: false,
    });

    const accounts = agyAccountsForLabel("alice", parsed.plan);
    expect(accounts.gemini).toEqual({
      externalId: "agy-alice-gemini",
      name: "Antigravity (alice) · Gemini",
      platform: "google",
      kind: "subscription",
      plan: "Google AI Ultra",
      subjectKey: null,
    });
    expect(accounts.thirdParty).toEqual({
      externalId: "agy-alice-3p",
      name: "Antigravity (alice) · Claude/GPT",
      platform: "google",
      kind: "subscription",
      plan: "Google AI Ultra",
      subjectKey: null,
    });

    const snapshot = agyQuotaSnapshot(parsed);
    expect(snapshot.quotas).toHaveLength(4);
    const expiredQuota = snapshot.quotas.find(
      (q) => q.accountExternalId === "agy-alice-3p" && q.window === "five-hour",
    )!;
    expect(expiredQuota.percent).toBeNull();
    const expiredView = quotaView(
      [
        {
          fact: {
            sourceId: "mac-test",
            externalId: "agy-alice-3p:five-hour",
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
      (q) => q.accountExternalId === "agy-alice-3p" && q.window === "seven-day",
    )!;
    expect(unknownPercentQuota.percent).toBeNull();
    const unknownPercentView = quotaView(
      [
        {
          fact: {
            sourceId: "mac-test",
            externalId: "agy-alice-3p:seven-day",
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

  expect(agyPoolOfModel("gemini-4-argon")).toBe("gemini");
  expect(agyPoolOfModel("gemini-3.8-flash")).toBe("gemini");
  expect(agyPoolOfModel("claude-opus-5-5")).toBe("3p");
  expect(agyPoolOfModel("claude-sonnet-5-5")).toBe("3p");
  expect(agyPoolOfModel("gpt-oss-120b")).toBe("3p");

  for (const model of [
    "gemini-4-argon",
    "gemini-3.8-flash",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-opus-4-6",
    "gpt-oss-120b",
  ]) {
    const fact: UsageFact = {
      sourceId: "mac-test",
      externalId: `test-${model}`,
      accountExternalId: `agy-alice-${agyPoolOfModel(model)}`,
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
      });

      const pendingCounts = state.pendingCounts();
      expect(pendingCounts.account).toBe(2);
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
          "agy-alice-3p",
          "agy-alice-gemini",
        ]);
        const geminiEvent = usage.find((u) => u.model === "gemini-4-argon")!;
        expect(geminiEvent.accountExternalId).toBe("agy-alice-gemini");
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
        expect(claudeEvent.accountExternalId).toBe("agy-alice-3p");
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
