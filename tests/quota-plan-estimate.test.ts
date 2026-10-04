import { expect, test } from "bun:test";
import {
  quotaView,
  type CollectedQuota,
  type QuotaChargeReader,
} from "../src/domain/quota";
import type { QuotaPlanObservation } from "../src/domain/quota-plan";

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
    expect(quotaView(samples, read, iso(8, 4))!.estimate).toMatchObject({
      usd: "5000",
      methods: { usd: "rough" },
    });
  }
});

test("same known continuous plan retains early historical reference", () => {
  expect(
    quotaView([...prior, sample(8, 0, 1)], read, iso(8, 4))!.estimate,
  ).toMatchObject({ usd: "100", methods: { usd: "previous-period" } });
});

test("cross-cycle plan changes reject previous plan and keep current-cycle rough", () => {
  const plans = [...known, { plan: "max", observedAt: iso(8), changed: true }];
  const samples = [...prior, sample(8, 1, 1)].map((s) => ({
    ...s,
    planHistory: plans,
  }));
  expect(quotaView(samples, read, iso(8, 4))!.estimate).toMatchObject({
    usd: "7000",
    methods: { usd: "rough" },
  });
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
    expect(result.estimate.usd).toBe(expected);
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
    expect(quotaView(samples, read, iso(8, 4))!.estimate).toMatchObject({
      usd: "200",
      methods: { usd: "rough" },
    });
  }
});

test("percent rollback without plan metadata also isolates money and disables prior", () => {
  const current = [sample(8, 0, 40), sample(8, 1, 10), sample(8, 2, 11)];
  const result = quotaView([...prior, ...current], read, iso(8, 4))!;
  expect(result.estimate).toMatchObject({
    usd: "200",
    methods: { usd: "rough" },
  });
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
