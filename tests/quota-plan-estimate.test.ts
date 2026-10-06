import { expect, test } from "bun:test";
import {
  quotaView,
  type CollectedQuota,
  type QuotaChargeReader,
} from "../src/domain/quota";
import type { QuotaPlanObservation } from "../src/domain/quota-plan";
import { fullWeekEstimate } from "./quota-projection";

const iso = (day: number, hour = 0) =>
  new Date(Date.UTC(2026, 8, day, hour)).toISOString();
const known: QuotaPlanObservation[] = [
  { plan: "pro", observedAt: iso(1), changed: false },
];
function sample(
  day: number,
  hour: number,
  percent: number,
  plans = known,
): CollectedQuota {
  return {
    fact: {
      sourceId: "test",
      externalId: `${day}-${hour}`,
      accountExternalId: "a",
      window: "seven-day",
      percent,
      sampledAt: iso(day, hour),
      resetsAt: iso(day < 8 ? 8 : 15),
      windowMinutes: 10080,
    },
    collectedAt: iso(day, hour),
    planHistory: plans,
  };
}
const prior = [sample(1, 0, 0), sample(1, 1, 10), sample(1, 2, 20)];
const read: QuotaChargeReader = (start, end) => {
  const t = Date.parse(end);
  const rows = [
    [iso(1, 0), 0],
    [iso(1, 1), 10],
    [iso(1, 2), 20],
    [iso(8, 0), 50],
    [iso(8, 1), 70],
    [iso(8, 2), 72],
    [iso(8, 3), 82],
    [iso(8, 4), 92],
  ] as const;
  const value =
    rows
      .filter(
        ([at]) => Date.parse(at) >= Date.parse(start) && Date.parse(at) <= t,
      )
      .at(-1)?.[1] ?? 0;
  return { usd: String(value), credits: String(value * 10) };
};

test("legacy and unknown plans never borrow previous-period estimates", () => {
  for (const planHistory of [
    undefined,
    [{ plan: null, observedAt: iso(1), changed: false }],
    [{ plan: "pro", observedAt: iso(8, 2), changed: false }],
  ]) {
    const samples = [...prior, sample(8, 0, 1)].map((s) => ({
      ...s,
      planHistory,
    }));
    const result = quotaView(samples, read, iso(8, 4))!;
    expect(result.estimate.methods?.usd).toBe("rough");
    expect(fullWeekEstimate(result)).toBe("5000");
  }
});

test("same known continuous plan retains early historical reference", () => {
  const result = quotaView([...prior, sample(8, 0, 1)], read, iso(8, 4))!;
  expect(result.estimate.methods?.usd).toBe("previous-period");
  expect(fullWeekEstimate(result)).toBe("100");
});

test("cross-cycle plan changes reject previous plan and keep current-cycle rough", () => {
  const plans = [...known, { plan: "max", observedAt: iso(8), changed: true }];
  const samples = [...prior, sample(8, 1, 1)].map((s) => ({
    ...s,
    planHistory: plans,
  }));
  const result = quotaView(samples, read, iso(8, 4))!;
  expect(result.estimate.methods?.usd).toBe("rough");
  expect(fullWeekEstimate(result)).toBe("7000");
});

test("mid-cycle plan change with increasing percentages rebases both money and percent", () => {
  const plans = [
    ...known,
    { plan: "max", observedAt: iso(8, 1), changed: true },
  ];
  const current = [
    sample(8, 0, 20),
    sample(8, 1, 30),
    sample(8, 2, 31),
    sample(8, 3, 36),
    sample(8, 4, 41),
  ];
  for (const [count, expected] of [
    [1, null],
    [2, null],
    [3, "200"],
    [4, "200"],
    [5, "200"],
  ] as const) {
    const samples = [...prior, ...current.slice(0, count)].map((s) => ({
      ...s,
      planHistory: plans,
    }));
    const result = quotaView(samples, read, iso(8, 4))!;
    expect(fullWeekEstimate(result)).toBe(expected);
    expect(result.periodUsd).toBe("92");
    expect(result.estimate.methods?.usd).not.toBe("previous-period");
    expect(result.estimate.methods?.usd).not.toBe("blended");
  }
});

test("returning to same plan after unknown or another plan cannot reconnect old history", () => {
  for (const middle of [null, "max"]) {
    const plans = [
      ...known,
      { plan: middle, observedAt: iso(7), changed: true },
      { plan: "pro", observedAt: iso(8, 1), changed: true },
    ];
    const samples = [...prior, sample(8, 1, 30), sample(8, 2, 31)].map((s) => ({
      ...s,
      planHistory: plans,
    }));
    const result = quotaView(samples, read, iso(8, 4))!;
    expect(result.estimate.methods?.usd).toBe("rough");
    expect(fullWeekEstimate(result)).toBe("200");
  }
});

test("percent rollback without plan metadata also isolates money and disables prior", () => {
  const current = [sample(8, 0, 40), sample(8, 1, 10), sample(8, 2, 11)];
  const result = quotaView([...prior, ...current], read, iso(8, 4))!;
  expect(result.estimate.methods?.usd).toBe("rough");
  expect(fullWeekEstimate(result)).toBe("200");
});

test("missing baseline pricing and saturated new-plan samples never fabricate an estimate", () => {
  const plans = [
    ...known,
    { plan: "max", observedAt: iso(8, 1), changed: true },
  ];
  const samples = [sample(8, 1, 30, plans), sample(8, 2, 100, plans)];
  expect(quotaView(samples, read, iso(8, 4))!.estimate.usd).toBeNull();
  const normal = [sample(8, 1, 30, plans), sample(8, 2, 31, plans)];
  expect(
    quotaView(
      normal,
      (_, end) => ({ usd: end === iso(8, 1) ? null : "72", credits: null }),
      iso(8, 4),
    )!.estimate.usd,
  ).toBeNull();
});

test("stale lower readings within one cycle neither rebase estimates nor lower the shown percent", () => {
  // 多个会话轮流写入额度缓存时，较早的读数会让百分比暂时回落 1 至 5 个点。
  const percents = [10, 20, 30, 29, 30, 25, 40, 39];
  const current = percents.map((percent, hour) => sample(8, hour, percent));
  const linear: QuotaChargeReader = (_, end) => {
    const hour = new Date(end).getUTCHours();
    const highest = Math.max(...percents.slice(0, hour + 1));
    return { usd: String(highest * 10), credits: null };
  };
  const result = quotaView(current, linear, iso(8, 7))!;
  expect(result.percent).toBe(40);
  expect(result.estimate).toMatchObject({
    usd: "1000",
    methods: { usd: "segments" },
  });
});

test("millisecond reset jitter stays in the same cycle", () => {
  const current = [0, 10, 20, 30].map((percent, hour) =>
    sample(8, hour, percent),
  );
  const jittered = sample(8, 4, 40);
  jittered.fact.resetsAt = new Date(Date.parse(iso(15)) - 30).toISOString();
  const linear: QuotaChargeReader = (_, end) => ({
    usd: String(new Date(end).getUTCHours() * 100),
    credits: null,
  });
  expect(
    quotaView([...current, jittered], linear, iso(8, 4))!.estimate,
  ).toMatchObject({ usd: "1000", methods: { usd: "segments" } });
});

test("estimates add the remaining share to actual spend and converge to it when exhausted", () => {
  // 前半段每 1% 花 15，后半段每 1% 花 10；整周外推值不变时，已花占比越高越接近实际。
  const spentAt = (percent: number) =>
    percent <= 50 ? percent * 15 : 750 + (percent - 50) * 10;
  const percents = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const current = percents.map((percent, hour) => sample(8, hour, percent));
  const reader: QuotaChargeReader = (_, end) => {
    const hour = Math.min(new Date(end).getUTCHours(), percents.length - 1);
    return { usd: String(spentAt(percents[hour]!)), credits: null };
  };
  const late = quotaView(current, reader, iso(8, 9))!;
  expect(late.periodUsd).toBe("1150");
  // 只用整周外推会停在 1300；按后半段花费继续用满实际为 1250。
  expect(fullWeekEstimate(late)).toBe("1300");
  expect(late.estimate.usd).toBe("1280");

  const exhausted = [...current, sample(8, 10, 100)];
  const full = quotaView(exhausted, reader, iso(8, 10))!;
  expect(full.estimate.usd).toBe(full.periodUsd);
});
