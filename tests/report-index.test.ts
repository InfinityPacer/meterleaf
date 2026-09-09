import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Charge, Valuation, UsdBasis } from "../src/domain/pricing";
import type {
  LedgerRecord,
  LedgerSnapshot,
  ReportFilter,
} from "../src/shared/report";
import { createLedgerView, type ViewQuery } from "../src/shared/ledger-view";
import { ReportIndex } from "../src/storage/report-index";

const asOf = "2026-09-09T04:37:00.000Z";
const emptyFilter: ReportFilter = {
  days: 1,
  model: "all",
  account: "all",
  search: "",
};

test("account lifetime uses cached hour aggregates and invalidates revisions, moves and deletions", () => {
  const index = new ReportIndex(":memory:");
  try {
    const a = row("a", "2026-08-01T00:00:00Z");
    const b = row("b", "2026-09-01T00:00:00Z", { accountId: "account-b" });
    index.replace([a, b]);
    expect(index.accountLifetime("account-a", "subscription")).toMatchObject({ count: 1, tokens: 100, usd: "0.1" });
    expect(index.accountLifetime("account-b", "api").usd).toBe("0.2");
    const queries = spyOn(index.db, "query");
    index.accountLifetime("account-a", "api");
    expect(queries.mock.calls.some(([sql]) => sql.includes("FROM report_hours") || sql.includes("FROM report_records"))).toBe(false);
    queries.mockRestore();
    index.apply([{ ...a, accountId: "account-b", input: 110 }], []);
    expect(index.accountLifetime("account-a", "subscription")).toMatchObject({ count: 0, tokens: 0, usd: "0" });
    expect(index.accountLifetime("account-b", "subscription")).toMatchObject({ count: 2, tokens: 300, usd: "0.2" });
    index.apply([], ["b"]);
    expect(index.accountLifetime("account-b", "subscription").count).toBe(1);
    index.replace([]);
    expect(index.accountLifetime("account-b", "subscription").count).toBe(0);
  } finally { index.close(); }
});

test("account lifetime preserves unknown token and price boundaries", () => {
  const index = new ReportIndex(":memory:");
  try {
    index.replace([row("unknown", "2026-09-01T00:00:00Z", {
      input: null, cacheRead: null, cacheWrite: null, output: null,
      usd: null, valuation: undefined,
    })]);
    expect(index.accountLifetime("account-a", "subscription")).toMatchObject({ count: 1, tokens: null, usd: null, incompleteTokens: 1, incompleteUsd: 1 });
  } finally { index.close(); }
});

test("quota boundaries seek hours instead of scanning the account period", () => {
  const index = new ReportIndex(":memory:");
  try {
    index.replace([
      row("before", "2026-09-02T01:14:59.999Z"),
      row("start", "2026-09-02T01:15:00.000Z"),
      row("middle", "2026-09-05T12:00:00.000Z"),
      row("end", "2026-09-09T01:15:00.000Z"),
      row("after", "2026-09-09T01:15:00.001Z"),
      row("other", "2026-09-02T01:15:00.000Z", { accountId: "account-b" }),
    ]);
    const queries = spyOn(index.db, "query");
    try {
      for (const basis of ["subscription", "api"] as const) {
        expect(
          index.sumWindow(
            "account-a",
            "2026-09-02T01:15:00.000Z",
            "2026-09-09T01:15:00.000Z",
            basis,
          ),
        ).toEqual({
          count: 3,
          tokens: 300,
          usd: basis === "api" ? "0.6" : "0.3",
          credits: "3",
        });
      }
      const boundaries = queries.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.includes("FROM report_records r"));
      expect(boundaries).toHaveLength(2);
      for (const sql of boundaries)
        expect(sql).toContain("INDEXED BY report_records_hour");
    } finally {
      queries.mockRestore();
    }
  } finally {
    index.close();
  }
});

test("replays write nothing and evidence-only updates preserve hour aggregates", () => {
  const index = new ReportIndex(":memory:");
  const original = row("evidence", "2026-09-09T01:00:00.000Z");
  const writes = () =>
    index.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  try {
    index.replace([original]);
    const before = writes();
    const hours = index.db.query("SELECT * FROM report_hours").all();
    index.apply([original], []);
    expect(writes()).toBe(before);
    const corrected = { ...original, gatewayCost: "123" };
    index.apply([corrected], []);
    expect(writes() - before).toBe(1);
    expect(index.db.query("SELECT * FROM report_hours").all()).toEqual(hours);
    expect(index.read(metadata(), query()).records[0]?.gatewayCost).toBe("123");
    index.apply([{ ...corrected, input: null, accountId: "account-b" }], []);
    expect(index.read(metadata(), query()).records[0]).toMatchObject({
      input: null,
      accountId: "account-b",
    });
    expect(index.db.query("SELECT * FROM report_hours").all()).not.toEqual(
      hours,
    );
  } finally {
    index.close();
  }
});

test("new usage updates only affected hour groups without rereading their details", () => {
  const index = new ReportIndex(":memory:");
  const reference = new ReportIndex(":memory:");
  const original = Array.from({ length: 1000 }, (_, i) =>
    row(`existing-${i}`, "2026-09-09T01:00:00.000Z"),
  );
  const additions = [
    row("new-a", "2026-09-09T01:30:00.000Z"),
    row("new-b", "2026-09-09T01:35:00.000Z", { input: null, tier: "unknown" }),
    row("new-c", "2026-09-09T01:35:00.000Z", { accountId: "other" }),
    row("new-d", "2026-09-09T02:35:00.000Z", { model: "other" }),
  ];
  try {
    index.replace(original);
    reference.replace([...original, ...additions]);
    const queries = spyOn(index.db, "query");
    try {
      index.apply(additions, []);
      expect(
        queries.mock.calls.some(([sql]) =>
          /FROM report_records\s+WHERE hour_start=/.test(sql),
        ),
      ).toBe(false);
    } finally {
      queries.mockRestore();
    }
    expect(
      index.db
        .query(
          "SELECT * FROM report_hours ORDER BY hour_start, account_id, model",
        )
        .all(),
    ).toEqual(
      reference.db
        .query(
          "SELECT * FROM report_hours ORDER BY hour_start, account_id, model",
        )
        .all(),
    );
  } finally {
    index.close();
    reference.close();
  }
});

test("search aggregates use a covering filter index with unchanged results", () => {
  const index = new ReportIndex(":memory:");
  const records = [
    row("matching", "2026-09-09T01:00:00.000Z"),
    row("other", "2026-09-09T02:00:00.000Z"),
    row("matching-old", "2026-09-07T02:00:00.000Z"),
  ];
  try {
    index.replace(records);
    const reads = spyOn(index.db, "query");
    try {
      for (const search of ["MATCHING", "not-present", "matching%"]) {
        const current = query({ filter: { ...emptyFilter, search, account: "account-a" } });
        for (const basis of ["subscription", "api"] as const) {
          const actual = index.read(metadata(basis), current);
          const expected = createLedgerView({ ...metadata(basis), records: records.map(record => basisRecord(record, basis)) }, current);
          expect(actual.view).toEqual(expected.view);
          expect(actual.records.map(record => record.id)).toEqual(expected.records.map(record => record.id));
        }
      }
      const scans = reads.mock.calls.map(([sql]) => sql).filter(sql => sql.includes("instr(r.search_text" ) && !sql.includes("r.payload"));
      expect(scans.length).toBeGreaterThan(0);
      for (const sql of scans) expect(sql).toContain("INDEXED BY report_records_search_time");
    } finally { reads.mockRestore(); }
  } finally { index.close(); }
});

test("empty searches and pages do not scan the detail sort index", () => {
  const index = new ReportIndex(":memory:");
  try {
    index.replace([row("present", "2026-09-09T01:00:00.000Z")]);
    for (const current of [
      query({ filter: { ...emptyFilter, search: "not-present" } }),
      query({ page: 10 }),
    ]) {
      const prepared = index.prepare(metadata(), current);
      const reads = spyOn(index.db, "query");
      try {
        for (const basis of ["subscription", "api"] as const)
          expect(index.materialize(prepared, basis).records).toEqual([]);
        expect(reads.mock.calls).toEqual([]);
      } finally {
        reads.mockRestore();
      }
    }
  } finally {
    index.close();
  }
});

test("mixed inserts corrections and deletions match rebuilding including repeated IDs", () => {
  const index = new ReportIndex(":memory:");
  const reference = new ReportIndex(":memory:");
  const original = row("original", "2026-09-09T01:00:00.000Z");
  const inserted = row("inserted", "2026-09-09T01:20:00.000Z");
  const moved = {
    ...inserted,
    occurredAt: "2026-09-09T03:00:00.000Z",
    accountId: "other",
    input: null,
  };
  const temporary = row("temporary", "2026-09-09T04:00:00.000Z");
  const survivor = row("survivor", "2026-09-09T01:20:00.000Z");
  try {
    index.replace([original]);
    index.applyChanges([
      { id: inserted.id, record: inserted },
      { id: inserted.id, record: moved },
      { id: temporary.id, record: temporary },
      { id: temporary.id, record: null },
      { id: survivor.id, record: survivor },
      { id: original.id, record: null },
    ]);
    reference.replace([moved, survivor]);
    const hours = () =>
      index.db
        .query(
          "SELECT * FROM report_hours ORDER BY hour_start, account_id, model",
        )
        .all();
    expect(hours()).toEqual(
      reference.db
        .query(
          "SELECT * FROM report_hours ORDER BY hour_start, account_id, model",
        )
        .all(),
    );
    const before = hours();
    const records = index.db
      .query("SELECT * FROM report_records ORDER BY id")
      .all();
    expect(() =>
      index.applyChanges(
        (function* () {
          yield { id: temporary.id, record: temporary };
          throw new Error("source stream failed");
        })(),
      ),
    ).toThrow("source stream failed");
    expect(hours()).toEqual(before);
    expect(
      index.db.query("SELECT * FROM report_records ORDER BY id").all(),
    ).toEqual(records);
    index.apply([], [moved.id, survivor.id]);
    expect(hours()).toEqual([]);
  } finally {
    index.close();
    reference.close();
  }
});

function charge(amount: string | null): Charge {
  return {
    amount,
    basis: amount === null ? "unpriced" : "estimated",
    reason: amount === null ? "fixture-missing" : "fixture",
    assumedStandard: false,
  };
}

function row(
  id: string,
  occurredAt: string,
  overrides: Partial<LedgerRecord> = {},
): LedgerRecord {
  const subscriptionUsd = overrides.valuation?.subscriptionUsd.amount ?? "0.10";
  const apiUsd = overrides.valuation?.apiUsd.amount ?? "0.20";
  const credits = overrides.valuation?.credits.amount ?? "1.00";
  const valuation: Valuation = overrides.valuation ?? {
    version: "test-v1",
    usdBasis: "subscription",
    usd: charge(subscriptionUsd),
    apiUsd: charge(apiUsd),
    subscriptionUsd: charge(subscriptionUsd),
    credits: charge(credits),
  };
  return {
    id,
    occurredAt,
    accountId: "account-a",
    model: "model-a",
    input: 10,
    cacheRead: 20,
    cacheWrite: 30,
    output: 40,
    usd: subscriptionUsd,
    credits,
    tier: "standard",
    quality:
      subscriptionUsd === null || credits === null ? "unpriced" : "estimated",
    priceVersion: "test-v1",
    valuation,
    ...overrides,
  };
}

function metadata(
  usdBasis: UsdBasis = "subscription",
  accounts: LedgerSnapshot["accounts"] = [],
): Omit<LedgerSnapshot, "records"> {
  return {
    mode: "live",
    asOf,
    accounts,
    resets: [],
    usdBasis,
  };
}

function query(overrides: Partial<ViewQuery> = {}): ViewQuery {
  return {
    filter: emptyFilter,
    unit: "usd",
    granularity: "day",
    dimension: "day",
    page: 0,
    pageSize: 20,
    sort: "",
    desc: false,
    ...overrides,
  };
}

function basisRecord(record: LedgerRecord, basis: UsdBasis): LedgerRecord {
  const usd =
    basis === "api"
      ? (record.valuation?.apiUsd.amount ?? null)
      : (record.valuation?.subscriptionUsd.amount ?? record.usd);
  const valuation = record.valuation
    ? {
        ...record.valuation,
        usdBasis: basis,
        usd:
          basis === "api"
            ? record.valuation.apiUsd
            : record.valuation.subscriptionUsd,
      }
    : undefined;
  return {
    ...record,
    usd,
    ...(valuation ? { valuation } : {}),
    quality: usd === null || record.credits === null ? "unpriced" : "estimated",
  };
}

function fixtureRows(): LedgerRecord[] {
  const values = [
    ["2026-09-07T04:38:00.000Z", "model-a", "account-a"],
    ["2026-09-07T08:00:00.000Z", "model-b", "account-b"],
    ["2026-09-07T12:15:00.000Z", "model-c", "account-a"],
    ["2026-09-07T16:37:00.000Z", "model-a", "account-b"],
    ["2026-09-07T20:59:59.999Z", "model-b", "account-a"],
    ["2026-09-08T00:00:00.000Z", "model-c", "account-c"],
    ["2026-09-08T04:36:59.999Z", "model-a", "account-a"],
    ["2026-09-08T04:37:00.000Z", "model-b", "account-b"],
    ["2026-09-08T05:00:00.000Z", "model-c", "account-c"],
    ["2026-09-08T12:30:00.000Z", "model-a", "account-a"],
    ["2026-09-08T16:00:00.000Z", "model-b", "account-b"],
    ["2026-09-08T23:59:59.999Z", "model-c", "account-a"],
    ["2026-09-09T04:37:00.000Z", "model-a", "account-b"],
  ] as const;
  return values.map(([occurredAt, model, accountId], index) => {
    const missing = index % 6;
    return row(`fixture-${String(index).padStart(2, "0")}`, occurredAt, {
      model,
      accountId,
      input: missing === 1 || missing === 5 ? null : 10 + index,
      cacheRead: missing === 2 || missing === 5 ? null : 20 + index,
      cacheWrite: missing === 3 || missing === 5 ? null : 30 + index,
      output: missing === 4 || missing === 5 ? null : 40 + index,
      usd: missing === 5 ? null : `${index + 1}.0000000000000000001`,
      credits: missing === 4 ? null : `${index + 2}.0000000000000000002`,
      tier: index % 4 === 0 ? "unknown" : "standard",
      quality: missing === 5 || missing === 4 ? "unpriced" : "estimated",
      valuation: {
        version: "test-v1",
        usdBasis: "subscription",
        usd: charge(missing === 5 ? null : `${index + 1}.0000000000000000001`),
        apiUsd: charge(
          missing === 2 ? null : `${index + 2}.0000000000000000003`,
        ),
        subscriptionUsd: charge(
          missing === 5 ? null : `${index + 1}.0000000000000000001`,
        ),
        credits: charge(
          missing === 4 ? null : `${index + 2}.0000000000000000002`,
        ),
      },
    });
  });
}

describe("ReportIndex", () => {
  test("prepares shared contributions once and materializes independent USD pages", () => {
    const index = new ReportIndex(":memory:");
    try {
      index.replace([
        row("subscription-first", "2026-09-09T01:00:00.000Z", {
          usd: "0.10",
          valuation: {
            version: "test-v1",
            usdBasis: "subscription",
            usd: charge("0.10"),
            apiUsd: charge("0.40"),
            subscriptionUsd: charge("0.10"),
            credits: charge("1"),
          },
        }),
        row("api-first", "2026-09-09T02:00:00.000Z", {
          usd: "0.20",
          valuation: {
            version: "test-v1",
            usdBasis: "subscription",
            usd: charge("0.20"),
            apiUsd: charge("0.30"),
            subscriptionUsd: charge("0.20"),
            credits: charge("1"),
          },
        }),
      ]);
      const loadContributions = spyOn(
        index as unknown as {
          loadContributions: (...args: unknown[]) => unknown;
        },
        "loadContributions",
      );
      const accountLifetime = spyOn(index, "accountLifetime");
      const prepared = index.prepare(
        metadata(),
        query({ sort: "usd", pageSize: 1 }),
      );
      const subscription = index.materialize(prepared, "subscription");
      const api = index.materialize(prepared, "api");

      expect(loadContributions).toHaveBeenCalledTimes(2);
      expect(subscription.records.map((record) => record.id)).toEqual([
        "subscription-first",
      ]);
      expect(api.records.map((record) => record.id)).toEqual(["api-first"]);
      expect(accountLifetime).not.toHaveBeenCalled();
      expect(subscription.view.accountUsage?.["account-a"]?.usd).toBe("0.3");
      expect(api.view.accountUsage?.["account-a"]?.usd).toBe("0.7");
    } finally {
      index.close();
    }
  });

  test("account usage follows date filters, ignores pagination, and keeps USD variants", () => {
    const index = new ReportIndex(":memory:");
    const accounts = [
      { id: "account-a", name: "A", plan: "", kind: "unknown" as const, sampledAt: null, fiveHour: null, sevenDay: null },
      { id: "account-b", name: "B", plan: "", kind: "unknown" as const, sampledAt: null, fiveHour: null, sevenDay: null },
      { id: "account-c", name: "C", plan: "", kind: "unknown" as const, sampledAt: null, fiveHour: null, sevenDay: null },
    ];
    const records = [
      row("current-a-1", "2026-09-08T00:00:00.000Z", {
        accountId: "account-a",
        model: "model-target",
        usd: "0.10",
        valuation: {
          version: "test-v1",
          usdBasis: "subscription",
          usd: charge("0.10"),
          apiUsd: charge("0.40"),
          subscriptionUsd: charge("0.10"),
          credits: charge("1"),
        },
      }),
      row("current-a-2", "2026-09-08T01:00:00.000Z", {
        accountId: "account-a",
        model: "model-target",
        usd: "0.20",
        valuation: {
          version: "test-v1",
          usdBasis: "subscription",
          usd: charge("0.20"),
          apiUsd: charge("0.50"),
          subscriptionUsd: charge("0.20"),
          credits: charge("1"),
        },
      }),
      row("current-b", "2026-09-08T02:00:00.000Z", {
        accountId: "account-b",
        model: "model-other",
        usd: "0.30",
        valuation: {
          version: "test-v1",
          usdBasis: "subscription",
          usd: charge("0.30"),
          apiUsd: charge("0.60"),
          subscriptionUsd: charge("0.30"),
          credits: charge("1"),
        },
      }),
      row("outside", "2026-09-07T12:00:00.000Z", {
        accountId: "account-a",
        usd: "9.00",
      }),
    ];
    const filter = {
      ...emptyFilter,
      dateRange: { from: "2026-09-08", to: "2026-09-08" },
    };
    try {
      index.replace(records);
      const subscription = index.read(
        metadata("subscription", accounts),
        query({ filter, page: 0, pageSize: 1 }),
      );
      const secondPage = index.read(
        metadata("subscription", accounts),
        query({ filter, page: 1, pageSize: 1 }),
      );
      const api = index.read(
        metadata("api", accounts),
        query({ filter, page: 0, pageSize: 1 }),
      );

      expect(subscription.records).toHaveLength(1);
      expect(secondPage.records).toHaveLength(1);
      expect(secondPage.view.accountUsage).toEqual(
        subscription.view.accountUsage,
      );
      expect(subscription.view.accountUsage).toEqual({
        "account-a": {
          count: 2,
          tokens: 200,
          usd: "0.3",
          incompleteTokens: 0,
          incompleteUsd: 0,
        },
        "account-b": {
          count: 1,
          tokens: 100,
          usd: "0.3",
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
      expect(api.view.accountUsage).toEqual({
        "account-a": {
          count: 2,
          tokens: 200,
          usd: "0.9",
          incompleteTokens: 0,
          incompleteUsd: 0,
        },
        "account-b": {
          count: 1,
          tokens: 100,
          usd: "0.6",
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
    } finally {
      index.close();
    }
  });

  test("persists more than 50000 records and applies corrections without truncating summaries", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "meterleaf-report-scale-"),
    );
    const path = join(directory, "index.sqlite");
    let index = new ReportIndex(path);
    const count = 50_001;
    const at = "2026-09-08T12:00:00.000Z";
    const currentQuery = query({
      filter: {
        ...emptyFilter,
        dateRange: { from: "2026-09-08", to: "2026-09-08" },
      },
      pageSize: 12,
      sort: "occurredAt",
    });
    try {
      index.replace(
        (function* () {
          for (let id = 0; id < count; id++)
            yield row(`scale-${String(id).padStart(5, "0")}`, at);
        })(),
      );
      index.close();
      index = new ReportIndex(path);
      const first = index.read(metadata(), currentQuery);
      const second = index.read(metadata(), { ...currentQuery, page: 1 });
      expect(first.view.count).toBe(count);
      expect(first.records).toHaveLength(12);
      expect(
        new Set(
          [...first.records, ...second.records].map((record) => record.id),
        ).size,
      ).toBe(24);
      expect(index.sumWindow("account-a", at, at, "subscription")).toEqual({
        count: 50_001,
        tokens: 5_000_100,
        usd: "5000.1",
        credits: "50001",
      });
      expect(index.sumWindow("account-a", at, at, "api")).toEqual({
        count: 50_001,
        tokens: 5_000_100,
        usd: "10000.2",
        credits: "50001",
      });
      const correction = row("scale-00000", at, { accountId: "account-b" });
      index.apply([correction], ["scale-00001"]);
      index.apply([correction], ["scale-00001"]);
      expect(index.read(metadata(), currentQuery).view.count).toBe(count - 1);
      expect(index.sumWindow("account-a", at, at, "subscription")).toEqual({
        count: 49_999,
        tokens: 4_999_900,
        usd: "4999.9",
        credits: "49999",
      });
      expect(index.sumWindow("account-b", at, at, "subscription")).toEqual({
        count: 1,
        tokens: 100,
        usd: "0.1",
        credits: "1",
      });
    } finally {
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("matches createLedgerView across filters, nulls, units, dimensions, bases and pages", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "meterleaf-report-index-"),
    );
    const index = new ReportIndex(join(directory, "index.sqlite"));
    const records = fixtureRows();
    try {
      function* source() {
        for (const record of records) yield record;
      }
      index.replace(source());
      for (const basis of ["subscription", "api"] as const) {
        for (const filter of [
          emptyFilter,
          { ...emptyFilter, model: "model-b" },
          { ...emptyFilter, account: "account-a" },
          { ...emptyFilter, search: "FIXTURE-0" },
          {
            ...emptyFilter,
            dateRange: { from: "2026-09-08", to: "2026-09-08" },
          },
        ]) {
          for (const unit of ["usd", "credits", "tokens"] as const) {
            for (const granularity of ["hour", "day", "week"] as const) {
              for (const dimension of [
                "hour",
                "day",
                "week",
                "model",
                "account",
              ] as const) {
                for (const sort of [
                  "",
                  "model",
                  "accountId",
                  "input",
                  "cacheRead",
                  "output",
                  "usd",
                ]) {
                  for (const desc of [false, true]) {
                    const currentQuery = query({
                      filter,
                      unit,
                      granularity,
                      dimension,
                      sort,
                      desc,
                      page: 1,
                      pageSize: 2,
                    });
                    const expectedSnapshot = {
                      ...metadata(basis),
                      records: records.map((record) =>
                        basisRecord(record, basis),
                      ),
                    };
                    const expected = createLedgerView(
                      expectedSnapshot,
                      currentQuery,
                    );
                    const actual = index.read(metadata(basis), currentQuery);
                    expect(actual.view).toEqual(expected.view);
                    expect(actual.records).toEqual(expected.records);
                  }
                }
              }
            }
          }
        }
      }
    } finally {
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("uses current and previous ranges for models and handles custom date boundaries", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "meterleaf-report-index-models-"),
    );
    const index = new ReportIndex(join(directory, "index.sqlite"));
    const records = [
      row("previous", "2026-09-07T12:00:00.000Z", { model: "previous-model" }),
      row("current", "2026-09-08T12:00:00.000Z", { model: "current-model" }),
      row("outside", "2026-09-06T15:59:59.999Z", { model: "outside-model" }),
    ];
    try {
      index.replace(records);
      const filter = {
        days: 1,
        dateRange: { from: "2026-09-08", to: "2026-09-08" },
        model: "all",
        account: "all",
        search: "",
      };
      const result = index.read(
        metadata(),
        query({ filter, pageSize: 10, dimension: "model" }),
      );
      expect(result.view.models).toEqual(["current-model", "previous-model"]);
      expect(result.view.count).toBe(1);
      expect(result.records.map((record) => record.id)).toEqual(["current"]);
      expect(result.view.reportRows.map((reportRow) => reportRow.key)).toEqual([
        "current-model",
      ]);
    } finally {
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("applies generator rebuilds and idempotent changes inside an outer transaction", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "meterleaf-report-index-apply-"),
    );
    const index = new ReportIndex(join(directory, "index.sqlite"));
    const initial = row("same", "2026-09-08T01:00:00.000Z", {
      accountId: "old-account",
    });
    const updated = row("same", "2026-09-08T03:00:00.000Z", {
      accountId: "new-account",
      model: "new-model",
      usd: "2.0000000000000000001",
      valuation: {
        version: "test-v1",
        usdBasis: "subscription",
        usd: charge("2.0000000000000000001"),
        apiUsd: charge("4.0000000000000000002"),
        subscriptionUsd: charge("2.0000000000000000001"),
        credits: charge("3.0000000000000000003"),
      },
    });
    try {
      index.replace([initial]);
      index.db.transaction(() => {
        index.apply([updated], ["missing-id"]);
        index.setMeta("checkpoint", { revision: 2 });
      })();
      expect(index.accountIds()).toEqual(["new-account"]);
      expect(index.getMeta<{ revision: number }>("checkpoint")).toEqual({
        revision: 2,
      });
      const applied = index.read(
        metadata(),
        query({ filter: { ...emptyFilter, days: 2 }, pageSize: 10 }),
      );
      expect(applied.records.map((record) => record.id)).toEqual(["same"]);
      expect(applied.records[0]?.accountId).toBe("new-account");

      expect(() =>
        index.db.transaction(() => {
          index.apply([initial], ["same"]);
          index.setMeta("checkpoint", { revision: 3 });
          throw new Error("rollback outer transaction");
        })(),
      ).toThrow("rollback outer transaction");
      expect(index.accountIds()).toEqual(["new-account"]);
      expect(index.getMeta<{ revision: number }>("checkpoint")).toEqual({
        revision: 2,
      });
    } finally {
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("sums inclusive arbitrary account windows exactly and preserves unknowns", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "meterleaf-report-index-window-"),
    );
    const index = new ReportIndex(join(directory, "index.sqlite"));
    const complete = (
      id: string,
      at: string,
      sub: string,
      api: string,
      credits: string,
    ) =>
      row(id, at, {
        accountId: "quota-account",
        usd: sub,
        credits,
        valuation: {
          version: "test-v1",
          usdBasis: "subscription",
          usd: charge(sub),
          apiUsd: charge(api),
          subscriptionUsd: charge(sub),
          credits: charge(credits),
        },
      });
    try {
      index.replace([
        complete("start", "2026-09-08T00:00:00.000Z", "0.1", "0.2", "1.1"),
        complete("middle", "2026-09-08T01:30:00.000Z", "0.2", "0.4", "2.2"),
        complete("end", "2026-09-08T03:00:00.000Z", "0.3", "0.6", "3.3"),
        row("missing", "2026-09-08T02:30:00.000Z", {
          accountId: "quota-account",
          input: null,
          usd: null,
          credits: "4.4",
          valuation: {
            version: "test-v1",
            usdBasis: "subscription",
            usd: charge(null),
            apiUsd: charge("0.8"),
            subscriptionUsd: charge(null),
            credits: charge("4.4"),
          },
        }),
      ]);
      expect(
        index.sumWindow(
          "quota-account",
          "2026-09-08T00:00:00.000Z",
          "2026-09-08T03:00:00.000Z",
          "subscription",
        ),
      ).toEqual({
        count: 4,
        tokens: null,
        usd: null,
        credits: "11",
      });
      expect(
        index.sumWindow(
          "quota-account",
          "2026-09-08T00:00:00.000Z",
          "2026-09-08T03:00:00.000Z",
          "api",
        ),
      ).toEqual({
        count: 4,
        tokens: null,
        usd: "2",
        credits: "11",
      });
      expect(
        index.sumWindow(
          "other-account",
          "2026-09-08T00:00:00.000Z",
          "2026-09-08T03:00:00.000Z",
          "subscription",
        ),
      ).toEqual({ count: 0, tokens: 0, usd: "0", credits: "0" });
    } finally {
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("includes non-hour-aligned start and end rows in inclusive account windows", async () => {
    const directory = await mkdtemp(
      join(
        process.env.TMPDIR ?? "/tmp",
        "meterleaf-report-index-window-boundary-",
      ),
    );
    const index = new ReportIndex(join(directory, "index.sqlite"));
    const complete = (id: string, at: string) =>
      row(id, at, {
        accountId: "quota-account",
        usd: "1",
        credits: "1",
        valuation: {
          version: "test-v1",
          usdBasis: "subscription",
          usd: charge("1"),
          apiUsd: charge("1"),
          subscriptionUsd: charge("1"),
          credits: charge("1"),
        },
      });
    try {
      index.replace([
        complete("at-start", "2026-09-08T00:30:00.000Z"),
        complete("middle", "2026-09-08T00:31:00.000Z"),
        complete("at-end", "2026-09-08T01:30:00.000Z"),
      ]);
      expect(
        index.sumWindow(
          "quota-account",
          "2026-09-08T00:30:00.000Z",
          "2026-09-08T01:30:00.000Z",
          "subscription",
        ),
      ).toEqual({ count: 3, tokens: 300, usd: "3", credits: "3" });
    } finally {
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
