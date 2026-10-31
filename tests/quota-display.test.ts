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
  quotaWaitingReset,
  accountQuotaExhausted,
  withFableQuotaWindow,
  withExtraQuotaWindows,
  quotaResetMinute,
  accountQuotaWindows,
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

test("rough, historical and blended estimates display plain amounts without a prefix", () => {
  for (const method of ["rough", "previous-period", "blended"] as const) {
    const quota = {
      ...window,
      estimate: quotaEstimate({
        methods: { usd: method, credits: "segments" },
      }),
    };
    expect(estimateAmount(quota, "usd", now)).toBe("$1,481.58");
    expect(estimateAmount(quota, "credits", now)).toBe("37,039.6");
  }
  const missing = {
    ...window,
    estimate: quotaEstimate({
      usd: null,
      methods: { usd: "rough", credits: "previous-period" },
    }),
  };
  expect(estimateAmount(missing, "usd", now)).toBe("N/A");
  expect(estimateAmount(missing, "credits", now)).toBe("37,039.6");
  expect(estimateAmount({ ...missing, resetsAt: now }, "credits", now)).toBe(
    "N/A",
  );
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
  expect(
    visibleQuotaWindows(account, now, false).map((item) => item.key),
  ).toEqual(["fiveHour", "sevenDay"]);
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

test("an account with two quota pools lists each pool and is exhausted only when both are", () => {
  const exhaustedGemini = {
    fiveHour: { ...window, percent: 40 },
    sevenDay: window,
    fiveHourThirdParty: { ...window, percent: 30 },
    sevenDayThirdParty: { ...window, percent: 60 },
  };
  // Gemini 周额度用尽只收起 Gemini 的 5h，Claude 池照常显示。
  expect(
    accountQuotaWindows(exhaustedGemini, now).map(({ key, label }) => [
      key,
      label,
    ]),
  ).toEqual([
    ["sevenDay", "Gemini 7d"],
    ["fiveHourThirdParty", "Claude 5h"],
    ["sevenDayThirdParty", "Claude 7d"],
  ]);
  expect(accountQuotaExhausted(exhaustedGemini, now)).toBe(false);
  expect(
    accountQuotaExhausted(
      { ...exhaustedGemini, sevenDayThirdParty: window },
      now,
    ),
  ).toBe(true);
  // 只有一个池的账户不加池名。
  expect(
    accountQuotaWindows({ fiveHour: null, sevenDay: window }, now).map(
      ({ label }) => label,
    ),
  ).toEqual(["7d"]);
});

test("a reported five-hour window keeps its place while waiting for a new sample", () => {
  const week = { ...window, percent: 57 };
  expect(
    visibleQuotaWindows({ fiveHour: null, sevenDay: week }, now).map(
      (item) => item.key,
    ),
  ).toEqual(["sevenDay"]);
  for (const fiveHour of [
    { ...window, percent: null },
    { ...window, resetsAt: now },
    { ...window, state: "unknown" as const, percent: 100 },
  ]) {
    const visible = visibleQuotaWindows({ fiveHour, sevenDay: week }, now);
    expect(visible.map((item) => [item.key, item.waiting ?? false])).toEqual([
      ["fiveHour", true],
      ["sevenDay", false],
    ]);
    // 占位窗口不带旧百分比，也不能让账户显示为已用满。
    expect(accountQuotaExhausted({ fiveHour, sevenDay: week }, now)).toBe(
      false,
    );
  }
  const expiredFiveHour = { ...window, resetsAt: now };
  expect(
    visibleQuotaWindows(
      { fiveHour: expiredFiveHour, sevenDay: { ...window, percent: 100 } },
      now,
      false,
    ).map((item) => item.key),
  ).toEqual(["sevenDay"]);
  expect(
    visibleQuotaWindows(
      { fiveHour: expiredFiveHour, sevenDay: { ...window, resetsAt: now } },
      now,
    ),
  ).toEqual([]);
  expect(quotaWaitingReset(expiredFiveHour, now)).toMatch(
    /^\d{2}:\d{2} 已重置$/,
  );
  expect(visibleQuotaWindows({ fiveHour: null, sevenDay: null }, now)).toEqual(
    [],
  );
});

test("a just-reset weekly window waits beside an active five-hour window", () => {
  // 周额度 4 小时前重置，5h 已用满，账户发不出请求，新的周快照还没到。
  const expiredWeek = {
    ...window,
    percent: 93,
    resetsAt: "2026-09-08T08:00:00Z",
  };
  const fiveHour = { ...window, percent: 100 };
  const shown = (sevenDay: AccountWindow | null, five = fiveHour) =>
    visibleQuotaWindows({ fiveHour: five, sevenDay }, now).map((item) => [
      item.key,
      item.waiting ?? false,
    ]);
  expect(shown(expiredWeek)).toEqual([
    ["fiveHour", false],
    ["sevenDay", true],
  ]);
  // 占位周额度不带旧百分比，账户是否用满只看有效的 5h。
  expect(
    accountQuotaExhausted(
      { fiveHour: { ...window, percent: 40 }, sevenDay: expiredWeek },
      now,
    ),
  ).toBe(false);
  // 上一周期结束超过一周、上游从未报过周额度，或 5h 也无效时，都不占位。
  expect(shown({ ...expiredWeek, resetsAt: "2026-08-31T08:00:00Z" })).toEqual([
    ["fiveHour", false],
  ]);
  expect(shown(null)).toEqual([["fiveHour", false]]);
  expect(shown(expiredWeek, { ...window, resetsAt: now })).toEqual([]);
  // Fable 占位依赖有效的共享周额度，周额度本身在等待时不再叠加 Fable 占位。
  expect(
    withFableQuotaWindow(
      visibleQuotaWindows({ fiveHour, sevenDay: expiredWeek }, now),
      { sevenDayFable: expiredWeek },
      now,
    ).map((item) => item.key),
  ).toEqual(["fiveHour", "sevenDay"]);
});

test("an expired Fable window waits for a new sample instead of disappearing", () => {
  const week = { ...window, percent: 10 };
  const shown = (sevenDayFable: AccountWindow, sevenDay = week) =>
    withFableQuotaWindow(
      visibleQuotaWindows({ fiveHour: null, sevenDay }, now),
      { sevenDayFable },
      now,
    ).map((item) => [item.key, item.waiting ?? false]);
  // Fable 快照在 4 小时前到期，Claude Code 尚未刷新用量缓存。
  const expired = { ...window, percent: 0, resetsAt: "2026-09-08T08:00:00Z" };
  expect(shown(expired)).toEqual([
    ["sevenDay", false],
    ["sevenDayFable", true],
  ]);
  expect(shown({ ...window, percent: 3 })).toEqual([
    ["sevenDay", false],
    ["sevenDayFable", false],
  ]);
  // 上一周期结束超过一周仍无新快照，或共享周额度本身无效时，不再占位。
  expect(shown({ ...expired, resetsAt: "2026-08-31T08:00:00Z" })).toEqual([
    ["sevenDay", false],
  ]);
  expect(shown(expired, { ...week, resetsAt: now })).toEqual([]);
});

test("a monthly window follows the weekly ones and yields to an exhausted week", () => {
  const month = { ...window, percent: 40, resetsAt: "2026-09-23T00:00:00Z" };
  const shown = (sevenDay: AccountWindow, monthly: AccountWindow) =>
    withExtraQuotaWindows(
      visibleQuotaWindows(
        { fiveHour: { ...window, percent: 5 }, sevenDay },
        now,
      ),
      { monthly },
      now,
    ).map((item) => item.key);
  expect(shown({ ...window, percent: 10 }, month)).toEqual([
    "fiveHour",
    "sevenDay",
    "monthly",
  ]);
  // 周额度用尽时紧凑视图只留周额度；月额度过期或缺值时不占位。
  expect(shown(window, month)).toEqual(["sevenDay"]);
  expect(
    shown({ ...window, percent: 10 }, { ...month, resetsAt: now }),
  ).toEqual(["fiveHour", "sevenDay"]);
  expect(
    shown({ ...window, percent: 10 }, { ...month, percent: null }),
  ).toEqual(["fiveHour", "sevenDay"]);
});

test("weekly reset restores five-hour visibility instead of keeping an expired exhausted state", () => {
  const account = {
    fiveHour: { ...window, percent: 75 },
    sevenDay: { ...window, resetsAt: now },
  };
  // 重置后的周额度只留不带旧百分比的占位，等新快照到达。
  expect(
    visibleQuotaWindows(account, now).map((item) => [
      item.key,
      item.waiting ?? false,
    ]),
  ).toEqual([
    ["fiveHour", false],
    ["sevenDay", true],
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

test("reset times round to the nearest minute so sub-second jitter shows one value", () => {
  expect(quotaResetMinute("2026-10-18T07:59:59.568Z")).toBe(
    Date.parse("2026-10-18T08:00:00.000Z"),
  );
  expect(quotaResetMinute("2026-10-18T08:00:00Z")).toBe(
    Date.parse("2026-10-18T08:00:00.000Z"),
  );
  expect(quotaResetMinute(null)).toBeNull();
  expect(quotaResetMinute("invalid")).toBeNull();
});
