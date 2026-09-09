import { expect, test } from "bun:test";
import {
  readReportPreference,
  saveReportPreference,
} from "../src/web/lib/report-preferences";
const defaults = { days: 7, model: "all", account: "all" };

test("tab selections are independent and never copy a legacy shared account filter", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  saveReportPreference({ ...defaults, account: "legacy" }, storage);
  expect(readReportPreference(storage, "reports")).toEqual(defaults);
  saveReportPreference({ ...defaults, days: 1, account: "api" }, storage, "ledger");
  saveReportPreference({ ...defaults, days: 30, model: "model-a" }, storage, "reports");
  expect(readReportPreference(storage, "overview")).toEqual(defaults);
  expect(readReportPreference(storage, "ledger")).toEqual({ ...defaults, days: 1, account: "api" });
  expect(readReportPreference(storage, "reports")).toEqual({ ...defaults, days: 30, model: "model-a" });
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
