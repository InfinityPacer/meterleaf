import { expect, test } from "bun:test";
import {
  preferenceSchemas,
  readStoredPreference,
  writeStoredPreference,
} from "../src/web/lib/preferences";
import {
  readReportPreference,
  saveReportPreference,
} from "../src/web/lib/report-preferences";
import { ref } from "../src/domain/account-merge";
const defaults = { days: 7, model: "all", account: "all" };

test("tab selections are independent and never copy a legacy shared account filter", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  saveReportPreference({ ...defaults, account: "legacy" }, storage);
  expect(readReportPreference(storage, "reports")).toEqual(defaults);
  saveReportPreference(
    { ...defaults, days: 1, account: "api" },
    storage,
    "ledger",
  );
  saveReportPreference(
    { ...defaults, days: 30, model: "model-a" },
    storage,
    "reports",
  );
  expect(readReportPreference(storage, "overview")).toEqual({
    ...defaults,
    days: 1,
  });
  expect(readReportPreference(storage, "ledger")).toEqual({
    ...defaults,
    days: 1,
    account: "api",
  });
  expect(readReportPreference(storage, "reports")).toEqual({
    ...defaults,
    days: 30,
    model: "model-a",
  });
});

test("restores dates and identities without persisting search", () => {
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
  expect(readReportPreference(storage)).toEqual(defaults);
  const selection = {
    days: 7,
    model: "gpt-6-astra",
    account: "test-account",
    dateRange: { from: "2026-08-01", to: "2026-08-31" },
  };
  const filter = { ...selection, search: "private search" };
  saveReportPreference(filter, storage);
  expect(readReportPreference(storage)).toEqual(selection);
  expect(value).not.toContain("private search");
  expect(value).not.toContain("search");
  saveReportPreference({ ...selection, days: 14 }, storage);
  expect(readReportPreference(storage)).toEqual({ ...selection, days: 14 });
  saveReportPreference({ ...defaults, days: 30 }, storage);
  expect(readReportPreference(storage)).toEqual({ ...defaults, days: 30 });
  saveReportPreference(
    { ...defaults, dateRange: { from: "invalid", to: "2026-08-31" } },
    storage,
  );
  expect(readReportPreference(storage)).toEqual({ ...defaults, days: 30 });
  saveReportPreference(defaults, storage);
  expect(readReportPreference(storage)).toEqual(defaults);
});

test("invalid and unavailable storage falls back without blocking reports", () => {
  for (const value of [
    "{",
    "null",
    JSON.stringify({ ...defaults, days: -1 }),
    JSON.stringify({ ...defaults, model: {} }),
    JSON.stringify({
      ...defaults,
      dateRange: { from: "2026-02-30", to: "2026-03-01" },
    }),
    JSON.stringify({
      ...defaults,
      dateRange: { from: "2026-03-02", to: "2026-03-01" },
    }),
  ]) {
    expect(readReportPreference({ getItem: () => value })).toEqual(defaults);
  }
  expect(
    readReportPreference({
      getItem: () => {
        throw Error("disabled");
      },
    }),
  ).toEqual(defaults);
  expect(() =>
    saveReportPreference(defaults, {
      setItem: () => {
        throw Error("disabled");
      },
    }),
  ).not.toThrow();
});

test("home opens on all history and keeps it as a symbolic range", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  expect(readReportPreference(storage, "home")).toEqual({
    ...defaults,
    days: 30,
    all: true,
  });
  saveReportPreference({ ...defaults, days: 7 }, storage, "home");
  expect(readReportPreference(storage, "home")).toEqual(defaults);
  saveReportPreference(
    { ...defaults, days: 30, all: true },
    storage,
    "reports",
  );
  // 保存的是「历史至今」本身，而不是某一天换算出的固定日期。
  expect(values.get("meterleaf-report-filter-reports")).not.toContain("from");
  expect(readReportPreference(storage, "reports")).toEqual({
    ...defaults,
    days: 30,
    all: true,
  });
  values.set(
    "meterleaf-report-filter-reports",
    JSON.stringify({
      ...defaults,
      all: true,
      dateRange: { from: "2026-08-01", to: "2026-08-31" },
    }),
  );
  expect(readReportPreference(storage, "reports")).toEqual(defaults);
});

test("accountGrouping preference persists booleans and falls back to false on invalid storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const key = "meterleaf-pref-account-grouping";

  expect(
    readStoredPreference(
      key,
      preferenceSchemas.accountGrouping,
      false,
      storage,
    ),
  ).toBe(false);

  writeStoredPreference(key, preferenceSchemas.accountGrouping, true, storage);
  expect(
    readStoredPreference(
      key,
      preferenceSchemas.accountGrouping,
      false,
      storage,
    ),
  ).toBe(true);

  writeStoredPreference(key, preferenceSchemas.accountGrouping, false, storage);
  expect(
    readStoredPreference(
      key,
      preferenceSchemas.accountGrouping,
      false,
      storage,
    ),
  ).toBe(false);

  for (const raw of ["{", "null", '"true"', "1", "{}", "[]"]) {
    expect(
      readStoredPreference(key, preferenceSchemas.accountGrouping, false, {
        getItem: () => raw,
      }),
    ).toBe(false);
  }
  expect(
    readStoredPreference(key, preferenceSchemas.accountGrouping, false, {
      getItem: () => {
        throw Error("disabled");
      },
    }),
  ).toBe(false);
});

test("accountOrder persists encoded long UTF-8 account ids and rejects empty or oversized entries", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const key = "meterleaf-pref-account-order";
  const medium = ref("collector", "汉".repeat(60));
  const longest = ref("collector", "汉".repeat(256));
  expect(medium.length).toBeGreaterThan(512);
  expect(longest.length).toBeGreaterThan(2300);
  const order = ["a1", medium, "o1", longest, "o2"];

  writeStoredPreference(key, preferenceSchemas.accountOrder, order, storage);
  expect(
    readStoredPreference(key, preferenceSchemas.accountOrder, [], storage),
  ).toEqual(order);

  for (const corrupt of [
    ["a1", ""],
    ["a1", "x".repeat(4097)],
  ]) {
    values.clear();
    writeStoredPreference(
      key,
      preferenceSchemas.accountOrder,
      corrupt,
      storage,
    );
    expect(values.has(key)).toBe(false);
    values.set(key, JSON.stringify(corrupt));
    expect(
      readStoredPreference(key, preferenceSchemas.accountOrder, [], storage),
    ).toEqual([]);
  }
});

test("accountOrder stores complete orders at and beyond 10,000 short ids and still rejects corrupt storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const key = "meterleaf-pref-account-order";

  for (const size of [10_000, 10_001]) {
    const order = Array.from({ length: size }, (_, index) => `e${index}`);
    values.clear();
    writeStoredPreference(key, preferenceSchemas.accountOrder, order, storage);
    expect(values.has(key)).toBe(true);
    const reloaded = readStoredPreference(
      key,
      preferenceSchemas.accountOrder,
      [],
      storage,
    );
    expect(reloaded).toHaveLength(size);
    expect(reloaded).toEqual(order);
  }

  const large = Array.from({ length: 10_001 }, (_, index) => `e${index}`);
  for (const corrupt of [
    [...large, ""],
    [...large, "x".repeat(4097)],
  ]) {
    values.clear();
    writeStoredPreference(
      key,
      preferenceSchemas.accountOrder,
      corrupt,
      storage,
    );
    expect(values.has(key)).toBe(false);
    values.set(key, JSON.stringify(corrupt));
    expect(
      readStoredPreference(key, preferenceSchemas.accountOrder, [], storage),
    ).toEqual([]);
  }

  for (const raw of [
    JSON.stringify({ 0: "e0" }),
    JSON.stringify("e0"),
    JSON.stringify(null),
    "{not json",
  ]) {
    values.set(key, raw);
    expect(
      readStoredPreference(key, preferenceSchemas.accountOrder, [], storage),
    ).toEqual([]);
  }
});
