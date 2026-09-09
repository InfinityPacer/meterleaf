import { expect, test } from "bun:test";
import type {
  QuotaFact,
  SourceAccount,
  UsageFact,
} from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { quotaView, type QuotaChargeReader } from "../src/domain/quota";
import { valueUsage } from "../src/domain/pricing";
import {
  createAccountResolver,
  indexedSnapshot,
  ref,
  toLedgerRecord,
} from "../src/server/snapshot";
import type { SyncStatus } from "../src/server/sync";
import type { StoredUsage } from "../src/storage/ledger";

const now = "2026-09-09T01:00:00.000Z";
const sampledAt = "2026-09-08T12:00:00.000Z";
const resetAt = "2026-09-15T00:00:00.000Z";
const syncStatus: SyncStatus = {
  autoEnabled: false,
  running: false,
  phase: "idle",
  localRecords: 0,
  batchRecords: 0,
  batchPages: 0,
  hasSynced: true,
  lastAttempt: null,
  lastSuccess: now,
  error: null,
  quotaError: null,
  lastError: null,
  initialComplete: true,
  initialCompleteAt: now,
  lastSweep: now,
};

function account(
  externalId: string,
  parentExternalId: string | null = null,
): SourceAccount {
  return {
    sourceId: "test",
    externalId,
    name: externalId,
    platform: "fixture",
    kind: "subscription",
    plan: "pro",
    parentExternalId,
    subjectKey: null,
  };
}

function quota(
  window: QuotaFact["window"],
  percent: number | null,
  overrides: Partial<QuotaFact> = {},
) {
  const fact: QuotaFact = {
    sourceId: "test",
    externalId: `${window}-${sampledAt}`,
    accountExternalId: "child",
    window,
    percent,
    sampledAt,
    resetsAt: resetAt,
    windowMinutes: window === "seven-day" ? 10080 : 300,
    ...overrides,
  };
  return { fact, collectedAt: sampledAt };
}

function usage(): StoredUsage {
  const fact: UsageFact = {
    sourceId: "test",
    externalId: "usage-1",
    accountExternalId: "child",
    occurredAt: sampledAt,
    model: "gpt-6-astra",
    upstreamModel: "sent-model",
    tier: "auto",
    tokens: {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    gatewayCost: "9",
    gatewayBilled: "8",
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {
      requested_model: "requested-model",
      requested_reasoning_effort: "high",
      reasoning_effort: "xhigh",
      duration_ms: 11,
      first_token_ms: 4,
    },
  };
  return { fact, valuation: valueUsage(fact, defaultPriceBook) };
}

test("exports stable account identity and record projection helpers", () => {
  const resolver = createAccountResolver([
    account("root"),
    account("child", "root"),
    account("cycle-a", "cycle-b"),
    account("cycle-b", "cycle-a"),
  ]);
  expect(ref("source:with/slash", "external:id")).toBe(
    "source%3Awith%2Fslash:external%3Aid",
  );
  expect(resolver("test", "child")).toBe(ref("test", "root"));
  expect(resolver("test", "cycle-a")).toBe(ref("test", "cycle-a"));
  expect(resolver("test", "missing")).toBe(ref("test", "missing"));

  const record = toLedgerRecord(usage(), resolver, "api");
  expect(record).toMatchObject({
    id: "test:usage-1",
    accountId: "test:root",
    usd: "0.000253",
    credits: null,
    details: {
      requestedModel: "requested-model",
      sentModel: "sent-model",
      requestedReasoningEffort: "high",
      reasoningEffort: "xhigh",
      durationMs: 11,
      firstTokenMs: 4,
    },
  });
  expect(record.valuation?.usdBasis).toBe("api");
});

test("quota reader sums through now and estimates only through sampledAt", () => {
  const calls: [string, string][] = [];
  const reader: QuotaChargeReader = (startInclusive, endInclusive) => {
    calls.push([startInclusive, endInclusive]);
    return endInclusive === now
      ? { usd: "3", credits: "6" }
      : { usd: "1", credits: "2" };
  };
  const view = quotaView([quota("seven-day", 10)], reader, now)!;

  expect(view.periodUsd).toBe("3");
  expect(view.periodCredits).toBe("6");
  expect(view.estimate.usd).toBe("10");
  expect(view.estimate.credits).toBe("20");
  expect(calls).toEqual([
    ["2026-09-08T00:00:00.000Z", now],
    ["2026-09-08T00:00:00.000Z", sampledAt],
  ]);
});

test("quota reader is not called for unknown or expired windows", () => {
  let calls = 0;
  const reader: QuotaChargeReader = () => {
    calls += 1;
    return { usd: "1", credits: "1" };
  };
  expect(
    quotaView([quota("seven-day", 10, { resetsAt: null })], reader, now)!.state,
  ).toBe("unknown");
  expect(
    quotaView(
      [
        quota("seven-day", 10, {
          sampledAt: "2026-09-08T00:00:00.000Z",
          resetsAt: "2026-09-09T00:00:00.000Z",
        }),
      ],
      reader,
      now,
    )!.state,
  ).toBe("expired");
  expect(calls).toBe(0);
});

test("indexed snapshot aggregates child quotas without reading usage and keeps observed deleted accounts", () => {
  const calls: [string, string, string, string][] = [];
  const snapshot = indexedSnapshot(
    {
      book: defaultPriceBook,
      accounts: () => [account("root"), account("child", "root")],
      quotas: () => [quota("seven-day", 10)],
    },
    { status: () => syncStatus },
    now,
    "subscription",
    (accountId, startInclusive, endInclusive, basis) => {
      calls.push([accountId, startInclusive, endInclusive, basis]);
      return endInclusive === now
        ? { usd: "3", credits: "6" }
        : { usd: "1", credits: "2" };
    },
    [ref("test", "deleted")],
  );

  expect("records" in snapshot).toBe(false);
  expect(snapshot.accounts.map((item) => item.id)).toEqual([
    "test:root",
    "test:deleted",
  ]);
  expect(snapshot.accounts[0]!.sevenDay).toMatchObject({
    periodUsd: "3",
    periodCredits: "6",
    estimate: { usd: "10", credits: "20" },
  });
  expect(snapshot.accounts[1]).toMatchObject({
    name: "Account deleted",
    plan: "未提供",
    kind: "unknown",
    fiveHour: null,
    sevenDay: null,
  });
  expect(calls).toEqual([
    ["test:root", "2026-09-08T00:00:00.000Z", now, "subscription"],
    ["test:root", "2026-09-08T00:00:00.000Z", sampledAt, "subscription"],
  ]);
  expect(snapshot.pricing).toEqual({
    version: `${defaultPriceBook.id}@${defaultPriceBook.version}`,
    publishedAt: defaultPriceBook.publishedAt,
    sources: defaultPriceBook.sources,
  });
});
