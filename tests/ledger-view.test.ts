import { describe, expect, test } from "bun:test";
import type {
  LedgerRecord,
  LedgerSnapshot,
  ReportFilter,
} from "../src/shared/report";
import {
  createLedgerView,
  withUsdVariants,
  selectUsdView,
  type ViewQuery,
} from "../src/shared/ledger-view";
import { createDemoLedger } from "../src/web/demo/ledger";
import {
  aggregateReport,
  filterRecords,
  series,
  summarize,
  tokenFieldSummary,
} from "../src/web/lib/report";

const defaultFilter: ReportFilter = {
  days: 7,
  model: "all",
  account: "all",
  search: "",
};

function query(overrides: Partial<ViewQuery> = {}): ViewQuery {
  return {
    filter: defaultFilter,
    unit: "usd",
    granularity: "day",
    dimension: "day",
    page: 0,
    pageSize: 12,
    sort: "",
    desc: false,
    ...overrides,
  };
}

function record(
  id: string,
  overrides: Partial<LedgerRecord> = {},
): LedgerRecord {
  return {
    id,
    occurredAt: "2026-09-07T12:00:00.000Z",
    accountId: "account-a",
    model: "model-a",
    input: 10,
    cacheRead: 20,
    cacheWrite: 30,
    output: 40,
    usd: "0.10",
    credits: "1.00",
    tier: "standard",
    quality: "estimated",
    priceVersion: "test-v1",
    ...overrides,
  };
}

function snapshot(
  records: LedgerRecord[],
  accounts: LedgerSnapshot["accounts"] = [],
): LedgerSnapshot {
  return {
    mode: "live",
    asOf: "2026-09-08T00:00:00.000Z",
    accounts,
    records,
    resets: [],
  };
}

describe("shared ledger view", () => {
  test("USD presentations preserve each basis summary and sorted page", () => {
    const q = query({ sort: "usd", desc: false, pageSize: 1 });
    const subscription = createLedgerView(
      snapshot([record("a", { usd: "1" }), record("b", { usd: "2" })]),
      q,
    );
    const api = createLedgerView(
      snapshot([record("a", { usd: "3" }), record("b", { usd: "2" })]),
      q,
    );
    const bundle = withUsdVariants(subscription, api, "subscription");
    const selectedApi = selectUsdView(bundle, "api");
    const selectedSubscription = selectUsdView(bundle, "subscription");
    expect(selectedApi.records[0]?.id).toBe("b");
    expect(selectedSubscription.records[0]?.id).toBe("a");
    expect(selectedApi.view.usdSummary.value).toBe(5);
    expect(selectedSubscription.view.usdSummary.value).toBe(3);
    expect(selectedApi.view.accountUsage?.["account-a"]?.usd).toBe("5");
    expect(selectedSubscription.view.accountUsage?.["account-a"]?.usd).toBe(
      "3",
    );
    expect(selectedApi.view.creditsSummary).toEqual(
      selectedSubscription.view.creditsSummary,
    );
    expect(selectedApi.usdBasis).toBe("api");
    expect(bundle.usdVariants?.api).not.toHaveProperty("usdVariants");
  });
  test("returns all chart units with consistent partial-value semantics", () => {
    const source = snapshot([
      record("complete"),
      record("partial", { model: "model-b", input: null, usd: null }),
    ]);
    for (const granularity of ["hour", "day", "week"] as const) {
      const result = createLedgerView(source, query({ granularity }));
      for (const unit of ["usd", "credits", "tokens"] as const) {
        const view = result.view.units[unit];
        expect(view.totalSummary).toEqual(summarize(source.records, unit));
        expect(view.points).toEqual(series(source.records, granularity, unit));
        for (const row of view.breakdown) {
          const records = source.records.filter(
            (record) => record.model === row.model,
          );
          expect(row.count).toBe(records.length);
          expect(row.summary).toEqual(summarize(records, unit));
        }
      }
    }
  });
  test("matches the existing report functions for every view output", () => {
    const source = createDemoLedger("api");
    const filter: ReportFilter = {
      ...defaultFilter,
      dateRange: { from: "2026-09-02", to: "2026-09-04" },
      model: "gpt-6-astra",
      account: "personal",
      search: "demo-",
    };
    const view = createLedgerView(
      source,
      query({
        filter,
        unit: "credits",
        granularity: "week",
        dimension: "account",
        sort: "output",
        desc: true,
      }),
    );
    const current = filterRecords(source.records, filter, source.asOf);
    const previous = filterRecords(source.records, filter, source.asOf, true);
    expect(view.view.models).toEqual(
      [...new Set(source.records.map((row) => row.model))].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expect(view.view.count).toBe(current.length);
    expect(view.view.totalSummary).toEqual(summarize(current, "credits"));
    expect(view.view.usdSummary).toEqual(summarize(current, "usd"));
    expect(view.view.creditsSummary).toEqual(summarize(current, "credits"));
    expect(view.view.tokenSummary).toEqual(summarize(current, "tokens"));
    expect(view.view.previousUsdSummary).toEqual(summarize(previous, "usd"));
    expect(view.view.cacheSummary).toEqual(
      tokenFieldSummary(current, "cacheRead"),
    );
    expect(view.view.points).toEqual(series(current, "week", "credits"));
    expect(view.view.reportRows).toEqual(aggregateReport(current, "account"));
    expect(
      view.view.breakdown.map((item) => item.count).reduce((a, b) => a + b, 0),
    ).toBe(current.length);
    expect(view).toMatchObject({ mode: source.mode, asOf: source.asOf });

    for (const unit of ["usd", "credits", "tokens"] as const) {
      for (const granularity of ["hour", "day", "week"] as const) {
        for (const dimension of [
          "hour",
          "day",
          "week",
          "model",
          "account",
        ] as const) {
          const checked = createLedgerView(
            source,
            query({ filter, unit, granularity, dimension }),
          );
          expect(checked.view.totalSummary).toEqual(summarize(current, unit));
          expect(checked.view.points).toEqual(
            series(current, granularity, unit),
          );
          expect(checked.view.reportRows).toEqual(
            aggregateReport(current, dimension),
          );
        }
      }
    }
  });

  test("uses raw models for filters while summaries retain unknown semantics", () => {
    const rows = [
      record("known", { model: "model-a", usd: "0.10" }),
      record("unknown", {
        model: "model-b",
        accountId: "account-b",
        input: null,
        cacheRead: 5,
        cacheWrite: null,
        output: null,
        usd: null,
        credits: null,
        tier: "unknown",
        quality: "unpriced",
      }),
      record("outside-model", {
        occurredAt: "2026-08-01T12:00:00.000Z",
        model: "model-outside",
      }),
    ];
    const view = createLedgerView(
      snapshot(rows),
      query({ filter: { ...defaultFilter, model: "model-b" } }),
    );
    expect(view.view.models).toEqual(["model-a", "model-b", "model-outside"]);
    expect(view.view.count).toBe(1);
    expect(view.view.usdSummary).toEqual({
      value: 0,
      hasKnown: false,
      knownRows: 0,
      incompleteRows: 1,
    });
    expect(view.view.tokenSummary).toEqual({
      value: 5,
      hasKnown: true,
      knownRows: 1,
      incompleteRows: 1,
    });
    expect(view.view.cacheSummary).toEqual({
      value: 5,
      hasKnown: true,
      knownRows: 1,
      incompleteRows: 0,
    });
    expect(view.view.completeCacheCount).toBe(0);
    expect(view.view.cacheRate).toBeNull();
    expect(view.view.unknownTier).toBe(1);
    expect(view.view.breakdown).toEqual([
      {
        model: "model-a",
        summary: summarize([], "usd"),
        count: 0,
      },
      {
        model: "model-b",
        summary: summarize([rows[1]!], "usd"),
        count: 1,
      },
      {
        model: "model-outside",
        summary: summarize([], "usd"),
        count: 0,
      },
    ]);
  });

  test("filters search/all, sorts supported columns, and paginates globally", () => {
    const rows = [
      record("same-b", {
        occurredAt: "2026-09-07T13:00:00.000Z",
        input: 1,
        cacheRead: 1,
        cacheWrite: 1,
        model: "model-b",
      }),
      record("same-a", {
        occurredAt: "2026-09-07T13:00:00.000Z",
        input: 2,
        cacheRead: 2,
        cacheWrite: 2,
        model: "model-a",
      }),
      record("high-input", {
        occurredAt: "2026-09-07T14:00:00.000Z",
        input: 9,
        cacheRead: 9,
        cacheWrite: 9,
        accountId: "target-account",
      }),
      record("unknown-input", {
        occurredAt: "2026-09-07T15:00:00.000Z",
        input: null,
        cacheRead: null,
        cacheWrite: null,
        accountId: "target-account",
        usd: null,
        tier: "unknown",
      }),
    ];
    const source = snapshot(rows);
    const defaultView = createLedgerView(source, query({ pageSize: 4 }));
    expect(defaultView.records.map((row) => row.id)).toEqual([
      "unknown-input",
      "high-input",
      "same-a",
      "same-b",
    ]);

    const filtered = createLedgerView(
      source,
      query({
        filter: {
          ...defaultFilter,
          model: "all",
          account: "all",
          search: "TARGET",
        },
        sort: "input",
        desc: true,
        page: 1,
        pageSize: 1,
      }),
    );
    expect(filtered.view.count).toBe(2);
    expect(filtered.records.map((row) => row.id)).toEqual(["unknown-input"]);
    expect(filtered.view.unknownTier).toBe(1);

    const accountFiltered = createLedgerView(
      source,
      query({
        filter: { ...defaultFilter, account: "target-account" },
        sort: "input",
        desc: false,
        page: 0,
        pageSize: 2,
      }),
    );
    expect(accountFiltered.records.map((row) => row.id)).toEqual([
      "unknown-input",
      "high-input",
    ]);
  });

  test("aggregates current account usage independently of pages and keeps known empty accounts", () => {
    const accounts = [
      { id: "account-a", name: "A", plan: "", kind: "unknown" as const, sampledAt: null, fiveHour: null, sevenDay: null },
      { id: "account-b", name: "B", plan: "", kind: "unknown" as const, sampledAt: null, fiveHour: null, sevenDay: null },
      { id: "account-c", name: "C", plan: "", kind: "unknown" as const, sampledAt: null, fiveHour: null, sevenDay: null },
    ];
    const source = snapshot(
      [
        record("match-a", {
          occurredAt: "2026-09-07T23:00:00.000Z",
          accountId: "account-a",
          model: "model-target",
          input: 1,
          cacheRead: 2,
          cacheWrite: 3,
          output: 4,
          usd: "1.10",
        }),
        record("page-a", {
          occurredAt: "2026-09-07T22:00:00.000Z",
          accountId: "account-a",
          model: "model-target",
          input: 10,
          cacheRead: 20,
          cacheWrite: 30,
          output: 40,
          usd: "2.20",
        }),
        record("other-b", {
          occurredAt: "2026-09-07T21:00:00.000Z",
          accountId: "account-b",
          model: "model-other",
          usd: "4.40",
        }),
        record("missing-c", {
          occurredAt: "2026-09-07T20:00:00.000Z",
          accountId: "account-c",
          model: "model-target",
          input: null,
          cacheRead: null,
          cacheWrite: null,
          output: null,
          usd: null,
        }),
        record("outside", {
          occurredAt: "2026-09-06T23:00:00.000Z",
          accountId: "account-b",
          usd: "8.80",
        }),
      ],
      accounts,
    );
    const filter = {
      ...defaultFilter,
      dateRange: { from: "2026-09-08", to: "2026-09-08" },
    };
    const firstPage = createLedgerView(
      source,
      query({ filter, page: 0, pageSize: 1 }),
    );
    const laterPage = createLedgerView(
      source,
      query({ filter, page: 10, pageSize: 1 }),
    );

    expect(firstPage.view.accountUsage).toEqual({
      "account-a": {
        count: 2,
        tokens: 110,
        usd: "3.3",
        incompleteTokens: 0,
        incompleteUsd: 0,
      },
      "account-b": {
        count: 1,
        tokens: 100,
        usd: "4.4",
        incompleteTokens: 0,
        incompleteUsd: 0,
      },
      "account-c": {
        count: 1,
        tokens: null,
        usd: null,
        incompleteTokens: 1,
        incompleteUsd: 1,
      },
    });
    expect(laterPage.view.accountUsage).toEqual(firstPage.view.accountUsage);

    const filtered = createLedgerView(
      source,
      query({
        filter: {
          ...filter,
          model: "model-target",
          account: "account-a",
          search: "match",
        },
      }),
    );
    expect(filtered.view.accountUsage).toEqual({
      "account-a": {
        count: 1,
        tokens: 10,
        usd: "1.1",
        incompleteTokens: 0,
        incompleteUsd: 0,
      },
      "account-b": {
        count: 0,
        tokens: 0,
        usd: "0",
        incompleteTokens: 0,
        incompleteUsd: 0,
      },
      "account-c": {
        count: 0,
        tokens: 0,
        usd: "0",
        incompleteTokens: 0,
        incompleteUsd: 0,
      },
    });
  });

  test("keeps a 250,000-row snapshot out of the response body", () => {
    const rows = Array.from({ length: 250_000 }, (_, index) =>
      record(`row-${index}`, {
        model: `model-${index % 3}`,
        accountId: `account-${index % 2}`,
        occurredAt: `2026-09-07T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const source = snapshot(rows);
    const view = createLedgerView(
      source,
      query({ pageSize: 12, sort: "", desc: false }),
    );
    const sourceSize = JSON.stringify(source).length;
    const viewSize = JSON.stringify(view).length;
    expect(view.records).toHaveLength(12);
    expect(view.view.count).toBe(250_000);
    expect(viewSize).toBeLessThan(sourceSize / 10);
  }, 30_000);
});
