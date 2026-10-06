import { expect, test } from "bun:test";
import Decimal from "decimal.js";
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
  liveSnapshot,
  ref,
  toLedgerRecord,
} from "../src/server/snapshot";
import type { SyncStatus } from "../src/server/sync";
import { LedgerStore, type StoredUsage } from "../src/storage/ledger";
import { ReportIndex } from "../src/storage/report-index";
import { fullWeekEstimate } from "./quota-projection";

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
  return {
    fact,
    collectedAt: sampledAt,
    planHistory: [
      {
        plan: "pro",
        observedAt: "2026-08-01T00:00:00.000Z",
        changed: false,
      },
    ],
  };
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
      cacheWrite5m: 4,
      cacheWrite1h: 0,
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

function quotaHistory(window: QuotaFact["window"] = "seven-day", step = 5) {
  return [0, 6, 12].map((hour, index) =>
    quota(window, index * step, {
      sampledAt: `2026-09-08T${String(hour).padStart(2, "0")}:00:00.000Z`,
      windowMinutes: 10080,
    }),
  );
}

function sampledCharges(endInclusive: string) {
  const hours =
    (Date.parse(endInclusive) - Date.parse("2026-09-08T00:00:00.000Z")) /
    3_600_000;
  return endInclusive === now
    ? { usd: "3", credits: "6" }
    : {
        usd: new Decimal(hours).div(12).toString(),
        credits: new Decimal(hours).div(6).toString(),
      };
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
    return sampledCharges(endInclusive);
  };
  const history = quotaHistory();
  const view = quotaView(history, reader, now)!;

  expect(view.periodUsd).toBe("3");
  expect(view.periodCredits).toBe("6");
  expect(fullWeekEstimate(view)).toBe("10");
  expect(fullWeekEstimate(view, "credits")).toBe("20");
  expect(calls).toContainEqual(["2026-09-08T00:00:00.000Z", now]);
  for (const sample of history)
    expect(calls).toContainEqual([
      "2026-09-08T00:00:00.000Z",
      sample.fact.sampledAt!,
    ]);
  expect(
    calls.every(
      ([start, end]) =>
        start === "2026-09-08T00:00:00.000Z" &&
        (end === now || Date.parse(end) <= Date.parse(sampledAt)),
    ),
  ).toBe(true);
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
      quotas: () => quotaHistory(),
    },
    { status: () => syncStatus },
    now,
    "subscription",
    (accountId, startInclusive, endInclusive, basis) => {
      calls.push([accountId, startInclusive, endInclusive, basis]);
      return sampledCharges(endInclusive);
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
  });
  expect(fullWeekEstimate(snapshot.accounts[0]!.sevenDay!)).toBe("10");
  expect(fullWeekEstimate(snapshot.accounts[0]!.sevenDay!, "credits")).toBe(
    "20",
  );
  expect(snapshot.accounts[1]).toMatchObject({
    name: "Account deleted",
    plan: "未提供",
    kind: "unknown",
    fiveHour: null,
    sevenDay: null,
  });
  expect(calls).toContainEqual([
    "test:root",
    "2026-09-08T00:00:00.000Z",
    now,
    "subscription",
  ]);
  for (const sample of quotaHistory())
    expect(calls).toContainEqual([
      "test:root",
      "2026-09-08T00:00:00.000Z",
      sample.fact.sampledAt!,
      "subscription",
    ]);
  expect(
    calls.every(
      ([id, start, , basis]) =>
        id === "test:root" &&
        start === "2026-09-08T00:00:00.000Z" &&
        basis === "subscription",
    ),
  ).toBe(true);
  expect(snapshot.pricing).toEqual({
    version: `${defaultPriceBook.id}@${defaultPriceBook.version}`,
    publishedAt: defaultPriceBook.publishedAt,
    sources: defaultPriceBook.sources,
  });
});

test("the Fable weekly window reads only Fable usage and still estimates its budget", () => {
  const scopes: (((model: string) => boolean) | null)[] = [];
  const reader: QuotaChargeReader = (_start, end, modelScope) => {
    scopes.push(modelScope);
    return {
      usd: new Decimal(sampledCharges(end).usd).mul(2).toString(),
      credits: null,
    };
  };
  const view = quotaView(quotaHistory("seven-day-fable", 10), reader, now)!;
  expect(scopes.every((scope) => scope !== null)).toBe(true);
  expect(scopes[0]!("claude-fable-5-1")).toBe(true);
  expect(scopes[0]!("claude-fable-5")).toBe(true);
  expect(scopes[0]!("claude-opus-5")).toBe(false);
  expect(view.estimate.reason).toBe("eligible");
  expect(fullWeekEstimate(view)).toBe("10");

  quotaView([quota("seven-day", 20)], reader, now);
  expect(scopes.at(-1)).toBeNull();
});

test("row-based quota views exclude other models from the Fable window", () => {
  const priced = (model: string, hour: number) => {
    const base = usage();
    const fact = {
      ...base.fact,
      externalId: `${model}-${hour}`,
      model,
      occurredAt: `2026-09-08T${String(hour).padStart(2, "0")}:00:00.000Z`,
    };
    return { fact, valuation: valueUsage(fact, defaultPriceBook) };
  };
  const rows = [2, 8, 13].flatMap((hour) => [
    priced("claude-fable-5-1", hour),
    priced("claude-opus-5", hour),
  ]);
  const fable = quotaView(quotaHistory("seven-day-fable", 10), rows, now)!;
  const week = quotaView(quotaHistory("seven-day", 10), rows, now)!;
  const fableUsd = priced("claude-fable-5-1", 2).valuation.usd.amount!;
  const opusUsd = priced("claude-opus-5", 2).valuation.usd.amount!;
  expect(fable.periodRequests).toBe(3);
  expect(week.periodRequests).toBe(6);
  expect(fable.periodUsd).toBe(new Decimal(fableUsd).mul(3).toString());
  expect(fullWeekEstimate(fable)).toBe(
    new Decimal(fableUsd).mul(10).toString(),
  );
  expect(fullWeekEstimate(week)).toBe(
    new Decimal(fableUsd).add(opusUsd).mul(10).toString(),
  );
});

test("same-cycle estimates isolate the latest source, account, window and duration", () => {
  const history = quotaHistory();
  const baseline = quotaView(
    history,
    (_start, end) => sampledCharges(end),
    now,
  )!;
  for (const overrides of [
    { sourceId: "other-source" },
    { accountExternalId: "other-account" },
    { window: "seven-day-fable" as const },
    { windowMinutes: 9000 },
  ]) {
    const foreign = [1, 7, 11].map((hour, index) =>
      quota("seven-day", 40 + index * 10, {
        sampledAt: `2026-09-08T${String(hour).padStart(2, "0")}:00:00.000Z`,
        ...overrides,
      }),
    );
    expect(
      quotaView(
        [...history, ...foreign],
        (_start, end) => sampledCharges(end),
        now,
      ),
    ).toEqual(baseline);
  }
});

test("a new cycle or percent rollback estimates only its current monotonic segment", () => {
  const history = quotaHistory().map((sample, index) => ({
    ...sample,
    fact: {
      ...sample.fact,
      sampledAt: `2026-09-08T${String(6 + index * 3).padStart(2, "0")}:00:00.000Z`,
    },
  }));
  const baseline = quotaView(
    history,
    (_start, end) => sampledCharges(end),
    now,
  )!;
  const priorCycle = [0, 6, 12].map((hour, index) =>
    quota("seven-day", 50 + index * 10, {
      sampledAt: `2026-09-07T${String(hour).padStart(2, "0")}:00:00.000Z`,
      resetsAt: "2026-09-14T00:00:00.000Z",
    }),
  );
  expect(fullWeekEstimate(baseline)).toBe("5");
  const beforeRollback = priorCycle.map((sample, index) => ({
    ...sample,
    fact: {
      ...sample.fact,
      sampledAt: `2026-09-08T0${index * 2}:00:00.000Z`,
      resetsAt: resetAt,
    },
  }));
  for (const older of [priorCycle, beforeRollback]) {
    expect(
      quotaView(
        [...older, ...history],
        (_start, end) => sampledCharges(end),
        now,
      ),
    ).toEqual(baseline);
  }
});

test("real indexed and row snapshots agree on multi-point weekly and Fable estimates in both USD bases", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const index = new ReportIndex(":memory:");
  try {
    store.saveAccounts([account("root"), account("child", "root")]);
    const records = [2, 8, 13].flatMap((hour) =>
      ["claude-fable-5-1", "claude-opus-5"].map((model) => ({
        ...usage().fact,
        externalId: `${model}-${hour}`,
        model,
        occurredAt: `2026-09-08T${String(hour).padStart(2, "0")}:00:00.000Z`,
      })),
    );
    store.savePage(
      "test",
      "incremental",
      { records, nextCursor: "6", hasMore: false },
      now,
    );
    store.saveQuotas(
      [
        ...quotaHistory("seven-day", 10),
        ...quotaHistory("seven-day-fable", 10),
      ].map((sample) => sample.fact),
      now,
    );
    const resolver = createAccountResolver(store.accounts());
    index.replace(store.usage().map((row) => toLedgerRecord(row, resolver)));
    for (const basis of ["subscription", "api"] as const) {
      const rows = liveSnapshot(
        store,
        { status: () => syncStatus },
        7,
        now,
        basis,
      );
      const indexed = indexedSnapshot(
        store,
        { status: () => syncStatus },
        now,
        basis,
        (accountId, start, end, selectedBasis, scope) =>
          index.sumWindow(accountId, start, end, selectedBasis, scope),
      );
      const rowAccount = rows.accounts.find((item) => item.id === "test:root")!;
      const indexedAccount = indexed.accounts.find(
        (item) => item.id === "test:root",
      )!;
      expect(indexedAccount.sevenDay).toEqual(rowAccount.sevenDay);
      expect(indexedAccount.sevenDayFable).toEqual(rowAccount.sevenDayFable);
      const valuation = valueUsage(records[0]!, defaultPriceBook);
      const charge =
        basis === "api" ? valuation.apiUsd : valuation.subscriptionUsd;
      expect(fullWeekEstimate(indexedAccount.sevenDayFable!)).toBe(
        new Decimal(charge.amount!).mul(10).toString(),
      );
      expect(indexedAccount.sevenDayFable?.periodUsd).toBe(
        new Decimal(charge.amount!).mul(3).toString(),
      );
      expect(indexedAccount.sevenDayFable?.periodRequests).toBe(3);
      expect(indexedAccount.sevenDay?.periodRequests).toBe(6);
    }
  } finally {
    index.close();
    store.close();
  }
});

test("previous weekly estimate stabilizes early usage and yields gradually to the current period", () => {
  const previous = [0, 10, 20].map((percent, index) =>
    quota("seven-day", percent, {
      sampledAt: `2026-09-01T0${index}:00:00.000Z`,
      resetsAt: "2026-09-08T00:00:00.000Z",
    }),
  );
  const current = [1, 6, 11, 21].map((percent, index) =>
    quota("seven-day", percent, {
      sampledAt: `2026-09-08T0${index * 2}:00:00.000Z`,
    }),
  );
  const all = [...previous, ...current];
  const reader: QuotaChargeReader = (start, end) => {
    const sample = all.find((item) => item.fact.sampledAt === end);
    const percent = sample?.fact.percent ?? 21;
    const factor = start === "2026-09-01T00:00:00.000Z" ? 1 : 2;
    return {
      usd: String(percent! * factor),
      credits: String(percent! * factor * 10),
    };
  };
  for (const [count, expected, method] of [
    [1, "100", "previous-period"],
    [2, "100", "previous-period"],
    [3, "125", "blended"],
    [4, "200", "segments"],
  ] as const) {
    const result = quotaView(
      [...previous, ...current.slice(0, count)],
      reader,
      now,
    )!;
    expect(fullWeekEstimate(result)).toBe(expected);
    expect(fullWeekEstimate(result, "credits")).toBe(
      new Decimal(expected).mul(10).toString(),
    );
    expect(result.estimate.methods).toEqual({ usd: method, credits: method });
    expect(result.periodUsd).toBe("42");
    expect(result.percent).toBe(current[count - 1]!.fact.percent);
  }
});

test("historical fallback never crosses sources or reuses a distant or too-small prior cycle", () => {
  const current = quota("seven-day", 1);
  const prior = quota("seven-day", 10, {
    sampledAt: "2026-09-01T12:00:00.000Z",
    resetsAt: "2026-09-08T00:00:00.000Z",
  });
  const reader: QuotaChargeReader = (start) =>
    start === "2026-09-08T00:00:00.000Z"
      ? { usd: "2", credits: "20" }
      : { usd: "10", credits: "100" };
  const borrowed = quotaView([prior, current], reader, now)!;
  expect(borrowed.estimate.methods?.usd).toBe("previous-period");
  expect(fullWeekEstimate(borrowed)).toBe("100");
  for (const overrides of [
    { sourceId: "other" },
    { accountExternalId: "other" },
    { window: "seven-day-fable" as const },
    { windowMinutes: 9000 },
    { percent: 9 },
    {
      sampledAt: "2026-08-24T12:00:00.000Z",
      resetsAt: "2026-08-31T00:00:00.000Z",
    },
  ]) {
    const incompatible = { ...prior, fact: { ...prior.fact, ...overrides } };
    expect(
      quotaView([incompatible, current], reader, now)!.estimate,
    ).toMatchObject({
      usd: "200",
      credits: "2000",
      methods: { usd: "rough", credits: "rough" },
    });
  }
});

test("row and indexed snapshots read the previous cycle outside the selected report range", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const index = new ReportIndex(":memory:");
  try {
    store.saveAccounts([account("child")], "2026-08-01T00:00:00.000Z");
    const priorHistory = [0, 10, 20].map((percent, hour) =>
      quota("seven-day", percent, {
        externalId: `prior-${hour}`,
        sampledAt: `2026-08-31T0${hour}:00:00.000Z`,
        resetsAt: "2026-09-07T00:00:00.000Z",
      }),
    );
    const current = quota("seven-day", 1);
    const records = [
      "2026-08-31T00:30:00.000Z",
      "2026-08-31T01:30:00.000Z",
      "2026-09-08T01:00:00.000Z",
    ].map((occurredAt, index) => ({
      ...usage().fact,
      externalId: `period-${index}`,
      occurredAt,
    }));
    store.savePage(
      "test",
      "incremental",
      { records, nextCursor: "3", hasMore: false },
      now,
    );
    store.saveQuotas(
      [...priorHistory, current].map((sample) => sample.fact),
      now,
    );
    const resolver = createAccountResolver(store.accounts());
    index.replace(store.usage().map((row) => toLedgerRecord(row, resolver)));
    for (const basis of ["subscription", "api"] as const) {
      const rows = liveSnapshot(
        store,
        { status: () => syncStatus },
        1,
        now,
        basis,
      );
      const indexed = indexedSnapshot(
        store,
        { status: () => syncStatus },
        now,
        basis,
        (accountId, start, end, selectedBasis, scope) =>
          index.sumWindow(accountId, start, end, selectedBasis, scope),
      );
      expect(indexed.accounts[0]!.sevenDay).toEqual(rows.accounts[0]!.sevenDay);
      const valued = valueUsage(records[0]!, defaultPriceBook);
      const charge = basis === "api" ? valued.apiUsd : valued.subscriptionUsd;
      expect(rows.accounts[0]!.sevenDay).toMatchObject({
        periodUsd: charge.amount,
        periodRequests: 1,
        estimate: { methods: { usd: "previous-period" } },
      });
      expect(fullWeekEstimate(rows.accounts[0]!.sevenDay!)).toBe(
        new Decimal(charge.amount!).mul(10).toString(),
      );
      expect(rows.records).toHaveLength(1);
    }
  } finally {
    index.close();
    store.close();
  }
});

test("historical reference is not pulled toward noisy rough usage before multi-segment evidence", () => {
  const previous = [0, 10, 20].map((percent, index) =>
    quota("seven-day", percent, {
      sampledAt: `2026-09-01T0${index}:00:00.000Z`,
      resetsAt: "2026-09-08T00:00:00.000Z",
    }),
  );
  const current = [1, 6, 11].map((percent, index) =>
    quota("seven-day", percent, {
      sampledAt: `2026-09-08T0${index}:00:00.000Z`,
    }),
  );
  const samples = [...previous, ...current];
  const read: QuotaChargeReader = (start, end) => {
    const percent =
      samples.find((sample) => sample.fact.sampledAt === end)?.fact.percent ??
      11;
    return {
      usd: String(percent! * 10 + (start.startsWith("2026-09-08") ? 500 : 0)),
      credits: null,
    };
  };
  for (let count = 1; count <= 3; count++) {
    expect(
      fullWeekEstimate(
        quotaView([...previous, ...current.slice(0, count)], read, now)!,
      ),
    ).toBe("1000");
  }
});
