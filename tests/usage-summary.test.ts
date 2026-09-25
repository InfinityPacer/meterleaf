import { expect, test } from "bun:test";
import { createLedgerView } from "../src/shared/ledger-view";
import { createDemoLedger } from "../src/web/demo/ledger";
import {
  spanDays,
  summaryFromLifetime,
  summaryFromView,
  trendInsights,
} from "../src/web/lib/usage-summary";
import { percentChange } from "../src/web/components/UsageSummary";
import { cacheHitRate } from "../src/web/components/ReportTable";
import type { LifetimeTotals } from "../src/shared/ledger-view";

const lifetime: LifetimeTotals = {
  asOf: "2026-09-25T20:00:00.000Z",
  from: "2026-08-14T16:30:00.000Z",
  to: "2026-09-25T19:59:00.000Z",
  count: 1000,
  tokens: {
    input: 100,
    cacheRead: 880,
    cacheWrite: 20,
    output: 50,
    total: 1050,
    incomplete: 0,
  },
  usd: "430.5",
  apiUsd: "500",
  subscriptionUsd: "430.5",
  credits: null,
  incomplete: { usd: 0, apiUsd: 0, subscriptionUsd: 0, credits: 0 },
  usdBasis: "subscription",
  priceVersion: "test",
};

test("lifetime summary uses the input side for the cache hit rate", () => {
  const summary = summaryFromLifetime(lifetime, "订阅等价");
  expect(summary.cacheRate).toBeCloseTo(88);
  expect(summary.change).toBeNull();
  expect(summary.credits).toBeNull();
  // 08/15 至 09/26 共 43 个上海自然日。
  expect(spanDays(lifetime.from!, lifetime.asOf)).toBe(43);
  expect(summary.dailyUsd).toBeCloseTo(430.5 / 43);
});

test("unknown lifetime buckets stay unknown instead of becoming zero", () => {
  const summary = summaryFromLifetime(
    {
      ...lifetime,
      from: null,
      usd: null,
      tokens: { ...lifetime.tokens, cacheWrite: null, total: null },
    },
    "订阅等价",
  );
  expect(summary.cacheRate).toBeNull();
  expect(summary.usd).toBeNull();
  expect(summary.dailyUsd).toBeNull();
  expect(summary.dailyTokens).toBeNull();
  expect(summary.composition.cacheWrite).toBeNull();
});

test("range summary compares with the previous period and sums composition", () => {
  const view = createLedgerView(createDemoLedger(), {
    filter: { days: 7, model: "all", account: "all", search: "" },
    unit: "usd",
    granularity: "day",
    dimension: "model",
    page: 0,
    pageSize: 1,
    sort: "occurredAt",
    desc: true,
  }).view;
  const summary = summaryFromView(view, "订阅等价", null);
  expect(summary.requests).toBe(view.count);
  expect(summary.change?.requests).toBeCloseTo(
    (view.count / view.previousCount! - 1) * 100,
  );
  const input = view.reportRows.reduce((sum, row) => sum + (row.input ?? 0), 0);
  expect(summary.composition.input).toBe(input);
  expect(summary.dailyUsd).toBeNull();
});

test("percent change needs a positive previous value", () => {
  expect(percentChange(12, 10)).toBeCloseTo(20);
  expect(percentChange(12, 0)).toBeNull();
  expect(percentChange(12, null)).toBeNull();
  expect(percentChange(null, 10)).toBeNull();
});

test("trend insights ignore unknown points and count active buckets", () => {
  const insights = trendInsights(
    [
      { at: 1, value: 5, count: 2, incomplete: 0 },
      { at: 2, value: null, count: 1, incomplete: 1 },
      { at: 3, value: 9, count: 3, incomplete: 0 },
    ],
    14,
    7,
  );
  expect(insights.peak).toEqual({ at: 3, value: 9 });
  expect(insights.activeBuckets).toBe(3);
  expect(insights.perRequest).toBe(2);
  expect(trendInsights([], null, 0).perRequest).toBeNull();
});

test("report cache hit rate needs every input-side bucket", () => {
  expect(cacheHitRate({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe(80);
  expect(cacheHitRate({ input: 10, cacheRead: 80, cacheWrite: null })).toBe(
    null,
  );
  expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
});
