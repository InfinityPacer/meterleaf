import { expect, test } from "bun:test";
import {
  quotaLabel,
  quotaPercent,
  quotaState,
  nextQuotaRefreshDelay,
} from "../src/web/lib/quota-display";

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
