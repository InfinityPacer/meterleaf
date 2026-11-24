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

test("plan upgrade reported after the upstream reset starts from the zero reading", () => {
  // 升级后上游当即清零，账户资料要等 Claude Code 刷新后才上报新套餐。
  const plans = [
    ...known,
    { plan: "max", observedAt: iso(8, 2), changed: true },
  ];
  const spend = [900, 900, 900, 920, 960];
  const reader: QuotaChargeReader = (_, end) => ({
    usd: String(spend[Math.min(new Date(end).getUTCHours(), 4)]),
    credits: null,
  });
  const readings = [sample(8, 0, 90), sample(8, 1, 0), sample(8, 3, 1)].map(
    (s) => ({ ...s, planHistory: plans }),
  );
  const result = quotaView(readings, reader, iso(8, 3))!;
  expect(result.percent).toBe(1);
  // 首次到达 1% 实际约为 0.5%，清零后花费 20 对应整周 4000。
  expect(fullWeekEstimate(result)).toBe("4000");
  expect(result.estimate.methods?.usd).toBe("rough");
});

test("a reset before the previous plan observation is not the new plan's start", () => {
  const plans = [
    ...known,
    { plan: "max", observedAt: iso(8, 2), changed: true },
    { plan: "pro", observedAt: iso(8, 4), changed: true },
  ];
  const spend = [900, 900, 900, 920, 960, 1000];
  const reader: QuotaChargeReader = (_, end) => ({
    usd: String(spend[Math.min(new Date(end).getUTCHours(), 5)]),
    credits: null,
  });
  const readings = [
    sample(8, 0, 90),
    sample(8, 1, 0),
    sample(8, 3, 1),
    sample(8, 5, 2),
  ].map((s) => ({ ...s, planHistory: plans }));
  const result = quotaView(readings, reader, iso(8, 5))!;
  // 只有 hour 5 一个新套餐读数，不能借用 hour 1 的清零点外推。
  expect(result.estimate.usd).toBeNull();
});

test("early zero-rebound spikes use the final stable crossing without lowering displayed percent", () => {
  // 复现上游 1% 瞬时预扣回弹：0%→1%($1.04)→0%($2.78)→1%($8.80)→0%($11.77)→1%($12.30)→1%($19.32)
  const trajectory = [
    [0, 0.19],
    [1, 1.04],
    [0, 2.78],
    [1, 8.8],
    [0, 11.77],
    [1, 12.3],
    [1, 19.32],
  ] as const;
  const readings = trajectory.map(([percent], hour) =>
    sample(8, hour, percent, []),
  );
  const spendReader: QuotaChargeReader = (_, end) => {
    const hour = Math.min(new Date(end).getUTCHours(), trajectory.length - 1);
    return { usd: String(trajectory[hour]![1]), credits: null };
  };
  const result = quotaView(readings, spendReader, iso(8, 6))!;
  expect(result.percent).toBe(1);
  expect(result.estimate.methods?.usd).toBe("rough");
  // 最后一次稳定跨上 1%（约 0.5%）时累计花费 12.30，对应整周 2460，不再被 1.04 锁死在 ~224。
  expect(fullWeekEstimate(result)).toBe("2460");
  expect(Number(result.estimate.usd)).toBeGreaterThan(2400);
  expect(Number(result.estimate.usd)).toBeLessThan(2500);

  // 回落回 0% 且尚未再次跨上 1% 时，展示保持 1%，但不输出被证伪的瞬时尖峰估值。
  const dipped = quotaView(readings.slice(0, 3), spendReader, iso(8, 2))!;
  expect(dipped.percent).toBe(1);
  expect(dipped.estimate.usd).toBeNull();
  expect(dipped.estimate.reason).toBe("percent-unavailable");
});

test("plateau lower bound rescues rough estimates even when intermediate zero dips were missed", () => {
  const trajectory = [
    [0, 0.2],
    [1, 1.04],
    [1, 19.32],
  ] as const;
  const readings = trajectory.map(([percent], hour) =>
    sample(8, hour, percent, []),
  );
  const spendReader: QuotaChargeReader = (_, end) => {
    const hour = Math.min(new Date(end).getUTCHours(), trajectory.length - 1);
    return { usd: String(trajectory[hour]![1]), credits: null };
  };
  const result = quotaView(readings, spendReader, iso(8, 2))!;
  expect(result.percent).toBe(1);
  expect(result.estimate.methods?.usd).toBe("rough");
  // 未采到中间 0% 回落时，下界兜底保证整周估值不低于 19.32 / 1.5% = 1288。
  expect(fullWeekEstimate(result)).toBe("1288");
  expect(Number(result.estimate.usd)).toBeGreaterThanOrEqual(1288);
});

test("rebound before 2% converges smoothly to the true quota across the 2% crossing", () => {
  const trajectory = [
    [0, 0.32],
    [1, 3.89],
    [0, 4.53],
    [1, 6.67],
    [2, 36.34],
  ] as const;
  const readings = trajectory.map(([percent], hour) =>
    sample(8, hour, percent, []),
  );
  const spendReader: QuotaChargeReader = (_, end) => {
    const hour = Math.min(new Date(end).getUTCHours(), trajectory.length - 1);
    return { usd: String(trajectory[hour]![1]), credits: null };
  };
  const result = quotaView(readings, spendReader, iso(8, 4))!;
  expect(result.percent).toBe(2);
  expect(result.estimate.methods?.usd).toBe("rough");
  expect(Number(fullWeekEstimate(result))).toBeCloseTo(2313.8, 1);
  expect(Number(result.estimate.usd)).toBeGreaterThan(2300);
  expect(Number(result.estimate.usd)).toBeLessThan(2400);
});

test("steady non-rebounding growth keeps a stable rough estimate across repeated plateau samples", () => {
  const trajectory = [
    [0, 0],
    [1, 10],
    [1, 18],
  ] as const;
  const readings = trajectory.map(([percent], hour) =>
    sample(8, hour, percent, []),
  );
  const spendReader: QuotaChargeReader = (_, end) => {
    const hour = Math.min(new Date(end).getUTCHours(), trajectory.length - 1);
    return { usd: String(trajectory[hour]![1]), credits: null };
  };
  const first = quotaView(readings.slice(0, 2), spendReader, iso(8, 1))!;
  const second = quotaView(readings, spendReader, iso(8, 2))!;
  expect(fullWeekEstimate(first)).toBe("2000");
  expect(fullWeekEstimate(second)).toBe("2000");
});

test("small high-percent stale dips with slight spend growth do not shift crossings or disturb segments", () => {
  // 多会话缓存回落 30→29→30、40→39 且期间花费略增，仍保持原穿越点与 segments 精度。
  const trajectory = [
    [0, 0],
    [10, 100],
    [20, 200],
    [30, 300],
    [29, 302],
    [30, 305],
    [25, 306],
    [40, 400],
    [39, 404],
  ] as const;
  const readings = trajectory.map(([percent], hour) =>
    sample(8, hour, percent),
  );
  const spendReader: QuotaChargeReader = (_, end) => {
    const hour = Math.min(new Date(end).getUTCHours(), trajectory.length - 1);
    return { usd: String(trajectory[hour]![1]), credits: null };
  };
  const result = quotaView(readings, spendReader, iso(8, 8))!;
  expect(result.percent).toBe(40);
  expect(result.estimate.methods?.usd).toBe("segments");
  expect(fullWeekEstimate(result)).toBe("1000");
});

test("low-tier dip after a mid-cycle plan change keeps the plan baseline and missing-price guard", () => {
  const plans = [
    ...known,
    { plan: "max", observedAt: iso(8, 1), changed: true },
  ];
  const readings = [
    sample(8, 1, 1, plans),
    sample(8, 2, 0, plans),
    sample(8, 3, 1, plans),
    sample(8, 4, 2, plans),
  ];
  // 切换边界首点（1%）缺价时，后续 1→0 回落不能移动基准绕过缺价保护。
  const missingBaselineReader: QuotaChargeReader = (_, end) => {
    const hour = new Date(end).getUTCHours();
    const amounts: Record<number, string | null> = {
      1: null,
      2: "20",
      3: "25",
      4: "35",
    };
    return { usd: amounts[hour] ?? null, credits: null };
  };
  expect(
    quotaView(readings, missingBaselineReader, iso(8, 4))!.estimate.usd,
  ).toBeNull();

  // 切换边界首点（1%）有价时，基准固定在切换边界（10），不丢失回落前花费。
  const pricedBaselineReader: QuotaChargeReader = (_, end) => {
    const hour = new Date(end).getUTCHours();
    const amounts: Record<number, string> = {
      1: "10",
      2: "20",
      3: "25",
      4: "35",
    };
    return { usd: amounts[hour] ?? "0", credits: null };
  };
  const priced = quotaView(readings, pricedBaselineReader, iso(8, 4))!;
  expect(priced.percent).toBe(2);
  expect(priced.estimate.methods?.usd).toBe("rough");
  expect(fullWeekEstimate(priced)).toBe("2500");

  // 周期内真实清零重置到 0% 后，锚点固定在清零点，后续 0→1→0→1 回弹仍正常去抖。
  const resetRebound = [
    sample(8, 0, 90, plans),
    sample(8, 1, 0, plans),
    sample(8, 2, 1, plans),
    sample(8, 3, 0, plans),
    sample(8, 4, 1, plans),
  ];
  const resetReader: QuotaChargeReader = (_, end) => {
    const hour = new Date(end).getUTCHours();
    const amounts: Record<number, string> = {
      0: "900",
      1: "900",
      2: "901",
      3: "902",
      4: "912",
    };
    return { usd: amounts[hour] ?? "900", credits: null };
  };
  const rebounded = quotaView(resetRebound, resetReader, iso(8, 4))!;
  expect(rebounded.percent).toBe(1);
  expect(fullWeekEstimate(rebounded)).toBe("2400");

  // 非零锚点之后若先到达更高档位（2%）再发生 2→0 低档回落，保留锚点同时撤销被推翻的旧 2% 首点。
  const postAnchorSpike = [
    sample(8, 1, 1, plans),
    sample(8, 2, 2, plans),
    sample(8, 3, 0, plans),
    sample(8, 4, 1, plans),
    sample(8, 5, 2, plans),
  ];
  const spikeReader: QuotaChargeReader = (_, end) => {
    const hour = new Date(end).getUTCHours();
    const amounts: Record<number, string> = {
      1: "10",
      2: "11",
      3: "12",
      4: "14",
      5: "35",
    };
    return { usd: amounts[hour] ?? "0", credits: null };
  };
  const recovered = quotaView(postAnchorSpike, spikeReader, iso(8, 5))!;
  expect(recovered.percent).toBe(2);
  expect(recovered.estimate.methods?.usd).toBe("rough");
  expect(fullWeekEstimate(recovered)).toBe("2500");

  // 同一轨迹下若锚点缺价，仍保持基准缺价保护，返回 null。
  const missingSpikeReader: QuotaChargeReader = (_, end) => {
    const hour = new Date(end).getUTCHours();
    return hour === 1
      ? { usd: null, credits: null }
      : spikeReader(_, end, null);
  };
  expect(
    quotaView(postAnchorSpike, missingSpikeReader, iso(8, 5))!.estimate.usd,
  ).toBeNull();
});
