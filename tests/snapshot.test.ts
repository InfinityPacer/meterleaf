import { expect, test } from "bun:test";
import type {
  QuotaFact,
  UsageConnector,
  UsageFact,
} from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { LedgerStore } from "../src/storage/ledger";
import { ReportIndex } from "../src/storage/report-index";
import {
  createAccountResolver,
  liveSnapshot,
  toLedgerRecord,
} from "../src/server/snapshot";
import { SyncRunner } from "../src/server/sync";

test("live snapshot preserves full quota periods across report ranges and USD branches", async () => {
  const now = "2026-09-14T01:00:00.000Z";
  const fact: UsageFact = {
    sourceId: "test",
    externalId: "1",
    accountExternalId: "child",
    occurredAt: "2026-09-08T00:00:00.000Z",
    model: "gpt-6-astra",
    upstreamModel: null,
    tier: "auto",
    tokens: {
      input: 300000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1000,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    gatewayCost: "999",
    gatewayBilled: "888",
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
  let quota: QuotaFact = {
    sourceId: "test",
    externalId: "seven-day",
    accountExternalId: "root",
    window: "seven-day",
    percent: 80,
    sampledAt: now,
    resetsAt: "2026-09-15T00:00:00.000Z",
    windowMinutes: 10080,
  };
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const connector: UsageConnector = {
    sourceId: "test",
    readAccounts: async () =>
      ["root", "child"].map((id) => ({
        sourceId: "test",
        externalId: id,
        name: id,
        kind: "subscription",
        platform: "openai",
        plan: "pro",
        parentExternalId: id === "child" ? "root" : null,
        subjectKey: null,
      })),
    readQuotas: async () => [quota],
    readUsage: async (cursor) => ({
      records: cursor ? [] : [fact],
      nextCursor: "1",
      hasMore: false,
    }),
    close: async () => {},
  };
  const sync = new SyncRunner(connector, store);
  try {
    await sync.poll(now);
    const subscription = liveSnapshot(store, sync, 1, now);
    const api = liveSnapshot(store, sync, 1, now, "api");
    expect(subscription.records).toHaveLength(0);
    expect(subscription.accounts).toHaveLength(1);
    expect(subscription.accounts[0]!.sevenDay!.periodUsd).toBe("3.05");
    expect(subscription.accounts[0]!.sevenDay!.periodRequests).toBe(1);
    expect(subscription.accounts[0]!.sevenDay!.periodTokens).toBe(
      fact.tokens.input! +
        fact.tokens.cacheRead! +
        fact.tokens.cacheWrite! +
        fact.tokens.output!,
    );
    expect(subscription.accounts[0]!.sevenDay!.periodCacheRate).toBe(0);
    expect(api.accounts[0]!.sevenDay!.periodUsd).toBe("6.075");
    expect(api.accounts[0]!.sevenDay!.periodCredits).toBeNull();
    expect(subscription.accounts[0]!.sevenDay!.periodCredits).toBeNull();
    const rows = liveSnapshot(store, sync, 7, now).records;
    expect(rows[0]!.tier).toBe("standard");
    expect(rows[0]!.quality).toBe("estimated");
    const resetTime = "2026-09-15T00:01:00.000Z";
    const expired = liveSnapshot(store, sync, 1, resetTime);
    expect(expired.accounts[0]!.sevenDay!.state).toBe("expired");
    expect(expired.accounts[0]!.sevenDay!.periodUsd).toBeNull();
    expect(expired.accounts[0]!.sevenDay!.periodRequests).toBeNull();
    expect(expired.accounts[0]!.sevenDay!.periodTokens).toBeNull();
    expect(expired.accounts[0]!.sevenDay!.periodCacheRate).toBeNull();
    quota = {
      ...quota,
      percent: 0,
      sampledAt: resetTime,
      resetsAt: "2026-09-22T00:00:00.000Z",
    };
    await sync.poll(resetTime);
    const reset = liveSnapshot(store, sync, 1, resetTime);
    expect(reset.accounts[0]!.sevenDay!.percent).toBe(0);
    expect(reset.accounts[0]!.sevenDay!.periodUsd).toBe("0");
    expect(reset.accounts[0]!.sevenDay!.periodRequests).toBe(0);
    expect(reset.accounts[0]!.sevenDay!.periodTokens).toBe(0);
    // 新周期还没有请求，命中率没有分母，不能显示成 0%。
    expect(reset.accounts[0]!.sevenDay!.periodCacheRate).toBeNull();
    expect(store.usage()).toHaveLength(1);
  } finally {
    await sync.stop();
    store.close();
  }
});

test("custom ranges include early current and comparison requests without truncating quota periods", async () => {
  const now = "2026-09-14T01:00:00.000Z";
  const fact = (externalId: string, occurredAt: string): UsageFact => ({
    sourceId: "test",
    externalId,
    accountExternalId: "root",
    occurredAt,
    model: "gpt-6-astra",
    upstreamModel: null,
    tier: "auto",
    tokens: {
      input: 300000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1000,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  });
  const currentPeriodFact = fact("current-period", "2026-09-08T00:00:00.000Z");
  const historicalFacts = [
    fact("previous", "2026-06-29T16:00:00.000Z"),
    fact("current-start", "2026-06-30T16:00:00.000Z"),
    fact("current", "2026-07-01T16:00:00.000Z"),
    fact("current-end", "2026-07-02T16:00:00.000Z"),
  ];
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const connector: UsageConnector = {
    sourceId: "test",
    readAccounts: async () => [
      {
        sourceId: "test",
        externalId: "root",
        name: "root",
        kind: "subscription",
        platform: "openai",
        plan: "pro",
        parentExternalId: null,
        subjectKey: null,
      },
    ],
    readQuotas: async () => [
      {
        sourceId: "test",
        externalId: "seven-day",
        accountExternalId: "root",
        window: "seven-day",
        percent: 80,
        sampledAt: now,
        resetsAt: "2026-09-15T00:00:00.000Z",
        windowMinutes: 10080,
      },
    ],
    readUsage: async (cursor) => ({
      records: cursor ? [] : [currentPeriodFact, ...historicalFacts],
      nextCursor: "1",
      hasMore: false,
    }),
    close: async () => {},
  };
  const sync = new SyncRunner(connector, store);
  try {
    await sync.poll(now);
    const snapshot = liveSnapshot(store, sync, 1, now, "subscription", {
      from: "2026-07-01",
      to: "2026-07-02",
    });
    expect(snapshot.records.map((row) => row.id)).toEqual([
      "test:current",
      "test:current-start",
      "test:previous",
    ]);
    expect(snapshot.records.some((row) => row.id === "test:current-end")).toBe(
      false,
    );
    expect(snapshot.accounts[0]!.sevenDay!.periodUsd).toBe("3.05");
  } finally {
    await sync.stop();
    store.close();
  }
});

test("live snapshot projects bounded request details without changing pricing fields", async () => {
  const now = "2026-09-14T01:00:00.000Z";
  const base = (externalId: string, occurredAt: string): UsageFact => ({
    sourceId: "test",
    externalId,
    accountExternalId: "root",
    occurredAt,
    model: "fallback-model",
    upstreamModel: null,
    tier: "auto",
    tokens: {
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  });
  const rich = base("rich", "2026-09-14T00:03:00.000Z");
  rich.model = "effective-model";
  rich.upstreamModel = "sent-model";
  rich.metadata = {
    requested_model: "requested-model",
    stored_model: "stored-model",
    upstream_response_model: "response-model",
    upstream_model_mismatch: false,
    requested_reasoning_effort: "high",
    reasoning_effort: "xhigh",
    duration_ms: 0,
    first_token_ms: 12,
    private_detail: "must-not-leak",
  };
  const storedOnly = base("stored-only", "2026-09-14T00:02:00.000Z");
  storedOnly.model = "effective-stored-model";
  storedOnly.metadata = { stored_model: "stored-model" };
  const fallback = base("fallback", "2026-09-14T00:01:00.000Z");
  fallback.metadata = { duration_ms: -1, first_token_ms: -2 };

  const store = new LedgerStore(":memory:", defaultPriceBook);
  const connector: UsageConnector = {
    sourceId: "test",
    readAccounts: async () => [
      {
        sourceId: "test",
        externalId: "root",
        name: "root",
        kind: "subscription",
        platform: "openai",
        plan: "pro",
        parentExternalId: null,
        subjectKey: null,
      },
    ],
    readQuotas: async () => [],
    readUsage: async (cursor) => ({
      records: cursor ? [] : [rich, storedOnly, fallback],
      nextCursor: "1",
      hasMore: false,
    }),
    close: async () => {},
  };
  const sync = new SyncRunner(connector, store);
  try {
    await sync.poll(now);
    const records = liveSnapshot(store, sync, 1, now).records;
    const richRecord = records.find(
      (record) => record.sourceRecordId === "rich",
    )!;
    expect(richRecord.model).toBe("effective-model");
    expect(richRecord.details).toEqual({
      requestedModel: "requested-model",
      sentModel: "sent-model",
      responseModel: "response-model",
      responseModelMismatch: false,
      requestedReasoningEffort: "high",
      reasoningEffort: "xhigh",
      durationMs: 0,
      firstTokenMs: 12,
    });
    expect(Object.keys(richRecord.details!)).toEqual([
      "requestedModel",
      "sentModel",
      "responseModel",
      "responseModelMismatch",
      "requestedReasoningEffort",
      "reasoningEffort",
      "durationMs",
      "firstTokenMs",
    ]);
    expect(
      (richRecord as unknown as { metadata?: unknown }).metadata,
    ).toBeUndefined();

    expect(
      records.find((record) => record.sourceRecordId === "stored-only")!
        .details,
    ).toEqual({
      requestedModel: "stored-model",
      sentModel: "effective-stored-model",
      responseModel: null,
      responseModelMismatch: null,
      requestedReasoningEffort: null,
      reasoningEffort: null,
      durationMs: null,
      firstTokenMs: null,
    });
    expect(
      records.find((record) => record.sourceRecordId === "fallback")!.details,
    ).toEqual({
      requestedModel: "fallback-model",
      sentModel: "fallback-model",
      responseModel: null,
      responseModelMismatch: null,
      requestedReasoningEffort: null,
      reasoningEffort: null,
      durationMs: null,
      firstTokenMs: null,
    });
  } finally {
    await sync.stop();
    store.close();
  }
});

test("ReportIndex windowSum keeps known period tokens when a request misses one bucket", async () => {
  const now = "2026-11-19T02:00:00.000Z";
  const makeFact = (
    externalId: string,
    occurredAt: string,
    tokens: UsageFact["tokens"],
  ): UsageFact => ({
    sourceId: "test",
    externalId,
    accountExternalId: "agy-alice",
    occurredAt,
    model: "gemini-4-carbon",
    upstreamModel: null,
    tier: "standard",
    tokens,
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  });
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const index = new ReportIndex(":memory:");
  try {
    store.saveAccounts([
      {
        sourceId: "test",
        externalId: "agy-alice",
        name: "Antigravity (alice)",
        kind: "subscription",
        platform: "google",
        plan: "Google AI Ultra",
        parentExternalId: null,
        subjectKey: null,
      },
    ]);
    store.savePage(
      "test",
      "incremental",
      {
        records: [
          makeFact("complete", "2026-11-18T14:54:08.000Z", {
            input: 2_305,
            cacheRead: 218_014,
            cacheWrite: 0,
            output: 4_703,
            cacheWrite5m: null,
            cacheWrite1h: null,
            reasoning: 1_980,
          }),
          makeFact("missing-output", "2026-11-18T14:54:09.000Z", {
            input: 45_479,
            cacheRead: 202_732,
            cacheWrite: 0,
            output: null,
            cacheWrite5m: null,
            cacheWrite1h: null,
            reasoning: null,
          }),
        ],
        nextCursor: "1",
        hasMore: false,
      },
      now,
    );
    const resolver = createAccountResolver(store.accounts());
    index.replace(store.usage().map((row) => toLedgerRecord(row, resolver)));
    const mixed = index.sumWindow(
      "test:agy-alice",
      "2026-11-18T02:22:00.000Z",
      now,
      "subscription",
    );
    expect(mixed.count).toBe(2);
    expect(mixed.tokens).toBe(2_305 + 218_014 + 4_703 + 45_479 + 202_732);
    expect(mixed.usd).not.toBeNull();

    // 全四个桶都未知的窗口仍保留 null，不补零。
    store.savePage(
      "test",
      "incremental",
      {
        records: [
          makeFact("all-null", "2026-11-19T01:00:00.000Z", {
            input: null,
            cacheRead: null,
            cacheWrite: null,
            output: null,
            cacheWrite5m: null,
            cacheWrite1h: null,
            reasoning: null,
          }),
        ],
        nextCursor: "2",
        hasMore: false,
      },
      now,
    );
    index.replace(store.usage().map((row) => toLedgerRecord(row, resolver)));
    const allNull = index.sumWindow(
      "test:agy-alice",
      "2026-11-19T00:00:00.000Z",
      now,
      "subscription",
    );
    expect(allNull.count).toBe(1);
    expect(allNull.tokens).toBeNull();
  } finally {
    index.close();
    store.close();
  }
});
