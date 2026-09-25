import { describe, expect, test } from "bun:test";
import {
  allTimeRange,
  dateRangeSchema,
  reportBounds,
  shanghaiDate,
} from "../src/shared/date-range";

const day = 86_400_000;

describe("date range contract", () => {
  test("rejects malformed, impossible, and descending dates", () => {
    for (const value of [
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-2-03", to: "2026-03-01" },
      { from: "2026-03-02", to: "2026-03-01" },
      { from: "2026-03-01", to: "2026-03-01\n" },
    ]) {
      expect(dateRangeSchema.safeParse(value).success).toBe(false);
    }
    expect(
      dateRangeSchema.safeParse({
        from: "2026-03-01",
        to: "2026-03-02",
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("accepts same-day and cross-month real dates", () => {
    expect(
      dateRangeSchema.parse({ from: "2026-02-28", to: "2026-02-28" }),
    ).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(
      dateRangeSchema.parse({ from: "2026-01-31", to: "2026-02-02" }),
    ).toEqual({ from: "2026-01-31", to: "2026-02-02" });
  });

  test("keeps preset boundaries and adjacent comparison periods", () => {
    const asOf = "2026-09-08T12:00:00.000Z";
    const current = reportBounds({ days: 7 }, asOf);
    const previous = reportBounds({ days: 7 }, asOf, true);
    expect(current).toEqual({
      start: Date.parse(asOf) - 7 * day,
      end: Date.parse(asOf),
      endInclusive: true,
    });
    expect(previous).toEqual({
      start: Date.parse(asOf) - 14 * day,
      end: Date.parse(asOf) - 7 * day,
      endInclusive: true,
    });
    expect(previous.end).toBe(current.start);
  });

  test("uses Shanghai natural-day bounds across a month boundary", () => {
    const current = reportBounds(
      {
        days: 1,
        dateRange: { from: "2026-01-31", to: "2026-02-02" },
      },
      "2026-09-08T12:00:00.000Z",
    );
    const previous = reportBounds(
      {
        days: 1,
        dateRange: { from: "2026-01-31", to: "2026-02-02" },
      },
      "2026-09-08T12:00:00.000Z",
      true,
    );
    expect(current).toEqual({
      start: Date.parse("2026-01-31T00:00:00+08:00"),
      end: Date.parse("2026-02-03T00:00:00+08:00"),
      endInclusive: false,
    });
    expect(previous).toEqual({
      start: Date.parse("2026-01-28T00:00:00+08:00"),
      end: Date.parse("2026-01-31T00:00:00+08:00"),
      endInclusive: false,
    });
    expect(previous.end).toBe(current.start);
  });
});

describe("all-history range", () => {
  test("spans Shanghai natural days from the first record to the sample day", () => {
    expect(shanghaiDate("2026-08-14T16:30:00.000Z")).toBe("2026-08-15");
    expect(
      allTimeRange("2026-08-14T16:30:00.000Z", "2026-09-25T20:00:00.000Z"),
    ).toEqual({ from: "2026-08-15", to: "2026-09-26" });
    const bounds = reportBounds(
      {
        days: 30,
        dateRange: allTimeRange(
          "2026-08-14T16:30:00.000Z",
          "2026-09-25T20:00:00.000Z",
        ),
      },
      "2026-09-25T20:00:00.000Z",
    );
    expect(bounds.start).toBe(Date.parse("2026-08-15T00:00:00+08:00"));
    expect(bounds.end).toBe(Date.parse("2026-09-27T00:00:00+08:00"));
  });

  test("never produces a descending range when the clock trails the ledger", () => {
    expect(
      allTimeRange("2026-09-26T03:00:00.000Z", "2026-09-25T03:00:00.000Z"),
    ).toEqual({ from: "2026-09-25", to: "2026-09-25" });
  });
});
