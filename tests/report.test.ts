import { describe, expect, test } from "bun:test";
import type { LedgerRecord } from "../src/shared/report";
import { createDemoLedger } from "../src/web/demo/ledger";
import { datePresets } from "../src/web/components/DateRangePicker";
import {
  bucketTime,
  csv,
  filterRecords,
  series,
  sum,
  aggregateReport,
  reportCsv,
  recordValue,
  numericAmount,
  summarize,
} from "../src/web/lib/report";

const snapshot = createDemoLedger();
const filter = { days: 7, model: "all", account: "all", search: "" };

describe("prototype report contract", () => {
  test("scientific decimal amounts remain known and aggregate without binary rounding", () => {
    const rows = ["1e-7", "2E-7", "0.0000003"].map(usd => ({ ...snapshot.records[0]!, usd }));
    expect(summarize(rows, "usd")).toEqual({ value: 6e-7, hasKnown: true, knownRows: 3, incompleteRows: 0 });
    expect(numericAmount("1e-7")).toBe(1e-7);
    expect(numericAmount("-1e-7")).toBeNull();
    expect(numericAmount("1e9999")).toBeNull();
    expect(numericAmount("Infinity")).toBeNull();
    expect(aggregateReport(rows, "model")[0]!.usd).toBe("6e-7");
  });
  test("custom calendar dates include both selected days without overlapping comparison", () => {
    const rows = [
      "2026-09-01T15:59:59.999Z",
      "2026-09-01T16:00:00.000Z",
      "2026-09-04T15:59:59.999Z",
      "2026-09-04T16:00:00.000Z",
    ].map((occurredAt, index) => ({
      ...snapshot.records[0]!,
      id: String(index),
      occurredAt,
    }));
    const custom = {
      ...filter,
      dateRange: { from: "2026-09-02", to: "2026-09-04" },
    };
    const current = filterRecords(rows, custom, snapshot.asOf);
    expect(current.map((row) => row.id)).toEqual(["1", "2"]);
    expect(
      filterRecords(rows, custom, snapshot.asOf, true).map((row) => row.id),
    ).toEqual(["0"]);
    expect(series(current, "day", "usd")).toHaveLength(2);
    expect(aggregateReport(current, "model")[0]!.requests).toBe(2);
    expect(csv(current).split("\r\n")).toHaveLength(3);
  });
  test("calendar presets use Shanghai midnight and handle previous-year months", () => {
    const presets = datePresets("2026-12-31T17:00:00.000Z");
    expect(presets.find((preset) => preset.id === "today")!.dateRange).toEqual({
      from: "2027-01-01",
      to: "2027-01-01",
    });
    expect(
      presets.find((preset) => preset.id === "last-month")!.dateRange,
    ).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(
      presets.find((preset) => preset.id === "1")!.dateRange,
    ).toBeUndefined();
  });
  test("group reports preserve filtered totals across every dimension", () => {
    const records = filterRecords(snapshot.records, filter, snapshot.asOf);
    for (const dimension of [
      "hour",
      "day",
      "week",
      "model",
      "account",
    ] as const) {
      const groups = aggregateReport(records, dimension);
      expect(groups.reduce((total, row) => total + row.requests, 0)).toBe(
        records.length,
      );
      expect(groups.reduce((total, row) => total + row.tokens!, 0)).toBe(
        sum(records, "tokens"),
      );
      expect(
        groups.reduce((total, row) => total + Number(row.usd), 0),
      ).toBeCloseTo(sum(records, "usd"), 8);
      expect(reportCsv(records, dimension).split("\r\n")).toHaveLength(
        groups.length + 1,
      );
    }
    expect(aggregateReport(records, "model")).toHaveLength(4);
    expect(aggregateReport(records, "account")).toHaveLength(3);
    expect(aggregateReport([], "week")).toEqual([]);
  });
  test("group CSV preserves exact decimals and escapes external group names", () => {
    const rows = [0, 1].map((i) => ({
      ...snapshot.records[i]!,
      model: "=external",
      usd: i ? "0.2" : "0.1",
    }));
    expect(aggregateReport(rows, "model")[0]!.usd).toBe("0.3");
    expect(reportCsv(rows, "model")).toContain("'=external");
  });
  test("demo is explicit and deterministic", () => {
    expect(snapshot).toEqual(createDemoLedger());
    expect(snapshot.mode).toBe("demo");
    expect(new Set(snapshot.records.map((row) => row.id)).size).toBe(
      snapshot.records.length,
    );
  });
  test("current and comparison periods do not overlap", () => {
    const current = filterRecords(snapshot.records, filter, snapshot.asOf);
    const previous = filterRecords(
      snapshot.records,
      filter,
      snapshot.asOf,
      true,
    );
    const previousIds = new Set(previous.map((row) => row.id));
    expect(current.length).toBeGreaterThan(0);
    expect(current.some((row) => previousIds.has(row.id))).toBe(false);
  });
  test("all filters compose", () => {
    const records = filterRecords(
      snapshot.records,
      { ...filter, model: "gpt-6-astra", account: "personal", search: "DEMO-" },
      snapshot.asOf,
    );
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.every(
        (row) => row.model === "gpt-6-astra" && row.accountId === "personal",
      ),
    ).toBe(true);
  });
  test("chart buckets preserve decimal totals", () => {
    const records = filterRecords(snapshot.records, filter, snapshot.asOf);
    for (const granularity of ["hour", "day", "week"] as const) {
      const buckets = series(records, granularity, "usd");
      expect(
        buckets.reduce((total, bucket) => total + bucket.value!, 0),
      ).toBeCloseTo(sum(records, "usd"), 8);
    }
  });
  test("natural week starts Monday in Shanghai", () => {
    expect(bucketTime("2026-09-06T16:00:00Z", "week")).toBe(
      Date.parse("2026-09-07T00:00:00+08:00"),
    );
    expect(bucketTime("2026-09-06T15:59:59Z", "week")).toBe(
      Date.parse("2026-08-31T00:00:00+08:00"),
    );
  });
  test("CSV includes all filtered rows and neutralizes spreadsheet formulas", () => {
    const records = filterRecords(snapshot.records, filter, snapshot.asOf);
    const result = csv(records);
    expect(result.split("\r\n").length).toBe(records.length + 1);
    expect(result).toContain("usd_estimate");
    expect(csv([{ ...records[0]!, model: '=HYPERLINK("test")' }])).toContain(
      "'=HYPERLINK",
    );
  });
  test("unknown nullable values remain unknown and only known subtotals are summed", () => {
    const row: LedgerRecord = {
      ...snapshot.records[0]!,
      id: "unknown-live-1",
      sourceId: "live-source",
      sourceRecordId: "external-1",
      input: null,
      cacheRead: 100,
      cacheWrite: null,
      output: 10,
      usd: null,
      credits: null,
      tier: "unknown",
      quality: "unpriced",
      priceVersion: "live-v1",
      gatewayCost: null,
      gatewayBilled: "0.2",
      valuation: {
        version: "live-v1",
        usdBasis: "subscription",
        usd: {
          amount: null,
          basis: "unpriced",
          reason: "missing-or-invalid-token-bucket",
          assumedStandard: true,
        },
        apiUsd: {
          amount: null,
          basis: "unpriced",
          reason: "missing-or-invalid-token-bucket",
          assumedStandard: true,
        },
        subscriptionUsd: {
          amount: null,
          basis: "unpriced",
          reason: "missing-or-invalid-token-bucket",
          assumedStandard: true,
        },
        credits: {
          amount: null,
          basis: "unpriced",
          reason: "missing-or-invalid-token-bucket",
          assumedStandard: true,
        },
      },
    };
    const grouped = aggregateReport([row], "model")[0]!;
    expect(recordValue(row, "tokens")).toBeNull();
    expect(grouped.tokens).toBe(110);
    expect(grouped.incompleteTokens).toBe(1);
    expect(grouped.usd).toBeNull();
    expect(grouped.credits).toBeNull();
    expect(series([row], "day", "usd")[0]!.value).toBeNull();
    const exported = csv([row], "api");
    expect(exported).toContain("usd_basis");
    expect(exported).toContain("quality");
    expect(exported).toContain("live-v1");
    expect(exported).toContain('""');
  });
  test("USD basis changes only the selected USD estimate, not records or periods", () => {
    const subscription = createDemoLedger("subscription");
    const api = createDemoLedger("api");
    expect(subscription.usdBasis).toBe("subscription");
    expect(api.usdBasis).toBe("api");
    expect(api.records.map((row) => row.id)).toEqual(
      subscription.records.map((row) => row.id),
    );
    expect(api.records.map((row) => row.occurredAt)).toEqual(
      subscription.records.map((row) => row.occurredAt),
    );
    const longSubscription = subscription.records.find(
      (row) => (row.input ?? 0) + (row.cacheRead ?? 0) > 272_000,
    )!;
    const longApi = api.records.find((row) => row.id === longSubscription.id)!;
    expect(longApi.usd).not.toBe(longSubscription.usd);
    expect(longApi.credits).toBe(longSubscription.credits);
    expect(longApi.valuation?.apiUsd.amount).not.toBe(
      longApi.valuation?.subscriptionUsd.amount,
    );
    expect(
      filterRecords(api.records, filter, api.asOf).map((row) => row.id),
    ).toEqual(
      filterRecords(subscription.records, filter, subscription.asOf).map(
        (row) => row.id,
      ),
    );
    expect(reportCsv(api.records, "model", "api")).toContain('"api"');
    expect(reportCsv(api.records, "model", "api")).toContain(
      "credits_estimate",
    );
  });
});
