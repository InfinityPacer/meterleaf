import { expect, test } from "bun:test";
import type { AccountWindow } from "../src/shared/report";
import {
  estimateAmount,
  quotaLabel,
  quotaPercent,
  quotaState,
  nextQuotaRefreshDelay,
  showQuotaEstimate,
  visibleQuotaWindows,
  accountQuotaExhausted,
} from "../src/web/lib/quota-display";

type QuotaEstimate = NonNullable<AccountWindow["estimate"]>;

function quotaEstimate(overrides: Partial<QuotaEstimate> = {}): QuotaEstimate {
  return {
    usd: "1481.58",
    credits: "37039.57",
    deltaPercent: null,
    reason: "eligible",
    ...overrides,
  };
}

const now = "2026-09-08T12:00:00Z";
const window = {
  percent: 100,
  sampledAt: "2026-09-08T11:22:00Z",
  resetsAt: "2026-09-15T01:22:00Z",
  state: "active" as const,
  stale: true,
};

test("missing or expired quota displays N/A, never a current zero", () => {
  expect(quotaLabel(null, now)).toBe("N/A");
  expect(quotaLabel({ ...window, percent: null }, now)).toBe("N/A");
  const expired = { ...window, resetsAt: now };
  expect(quotaState(expired, now)).toBe("expired");
  expect(quotaPercent(expired, now)).toBeNull();
  expect(quotaLabel(expired, now)).toBe("N/A");
});

test("old sample keeps concise usage without claiming synchronization failure", () => {
  expect(quotaLabel(window, now)).toBe("已用 100%");
  expect(quotaLabel({ ...window, stale: false }, now)).toBe(
    quotaLabel(window, now),
  );
});

test("formats an eligible estimate in the requested unit", () => {
  const quota = { ...window, estimate: quotaEstimate() };

  expect(estimateAmount(quota, "usd", now)).toBe("$1,481.58");
  expect(estimateAmount(quota, "credits", now)).toBe("37,039.6");
});

test("missing, ineligible, and expired estimates display N/A", () => {
  expect(estimateAmount(window, "usd", now)).toBe("N/A");
  expect(
    estimateAmount(
      { ...window, estimate: quotaEstimate({ reason: "unpriced" }) },
      "usd",
      now,
    ),
  ).toBe("N/A");
  expect(
    estimateAmount(
      { ...window, resetsAt: now, estimate: quotaEstimate() },
      "usd",
      now,
    ),
  ).toBe("N/A");
});

test("shows estimates only for active quota windows below 100%", () => {
  expect(showQuotaEstimate({ ...window, percent: 99 }, now)).toBe(true);
  expect(showQuotaEstimate(window, now)).toBe(false);
  expect(showQuotaEstimate({ ...window, percent: 101 }, now)).toBe(false);
  expect(
    showQuotaEstimate({ ...window, percent: null, state: "unknown" }, now),
  ).toBe(false);
  expect(showQuotaEstimate({ ...window, resetsAt: now }, now)).toBe(false);
  expect(showQuotaEstimate(null, now)).toBe(false);
});

test("formats a large eligible estimate with grouped currency", () => {
  expect(
    estimateAmount(
      {
        ...window,
        estimate: quotaEstimate({ usd: "9876543210.126" }),
      },
      "usd",
      now,
    ),
  ).toBe("$9,876,543,210.13");
});

test("weekly exhaustion hides five-hour quota across all account entry points", () => {
  const account = { fiveHour: { ...window, percent: 75 }, sevenDay: window };
  expect(visibleQuotaWindows(account, now).map((item) => item.key)).toEqual([
    "sevenDay",
  ]);
  expect(accountQuotaExhausted(account, now)).toBe(true);
  expect(
    visibleQuotaWindows(
      { ...account, sevenDay: { ...window, percent: 99 } },
      now,
    ).map((item) => item.key),
  ).toEqual(["fiveHour", "sevenDay"]);
});

test("missing and expired five-hour windows do not occupy quota layout", () => {
  for (const fiveHour of [
    null,
    { ...window, percent: null },
    { ...window, resetsAt: now },
    { ...window, state: "unknown" as const },
  ]) {
    expect(
      visibleQuotaWindows(
        { fiveHour, sevenDay: { ...window, percent: 57 } },
        now,
      ).map((item) => item.key),
    ).toEqual(["sevenDay"]);
  }
  expect(visibleQuotaWindows({ fiveHour: null, sevenDay: null }, now)).toEqual(
    [],
  );
});

test("weekly reset restores five-hour visibility instead of keeping an expired exhausted state", () => {
  const account = {
    fiveHour: { ...window, percent: 75 },
    sevenDay: { ...window, resetsAt: now },
  };
  expect(visibleQuotaWindows(account, now).map((item) => item.key)).toEqual([
    "fiveHour",
  ]);
  expect(accountQuotaExhausted(account, now)).toBe(false);
});

test("quota timer catches a reset crossed before the effect starts", () => {
  const clock = Date.parse(now);
  const shortly = { ...window, resetsAt: new Date(clock + 5).toISOString() };
  expect(nextQuotaRefreshDelay([shortly], clock, clock + 10)).toBe(0);
  expect(nextQuotaRefreshDelay([shortly], clock, clock)).toBe(6);
  expect(
    nextQuotaRefreshDelay([shortly], clock + 10, clock + 10),
  ).toBeUndefined();
});

test("quota timer selects the earliest pending window and ignores unknown dates", () => {
  const clock = Date.parse(now);
  const early = { ...window, resetsAt: new Date(clock + 1000).toISOString() };
  expect(
    nextQuotaRefreshDelay(
      [window, null, early, { ...window, resetsAt: "invalid" }],
      clock,
      clock,
    ),
  ).toBe(1001);
  expect(nextQuotaRefreshDelay([null], clock, clock)).toBeUndefined();
  expect(
    nextQuotaRefreshDelay(
      [{ ...window, resetsAt: "2100-01-01T00:00:00Z" }],
      clock,
      clock,
    ),
  ).toBe(2_147_483_647);
});
