import { expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  estimateQuotaSegments,
  roughQuotaEstimate,
  type QuotaEstimateAmounts,
  type QuotaEstimateObservation,
} from "../src/domain/quota-estimate";

function observations(percents: readonly number[]): QuotaEstimateObservation[] {
  return percents.map((percent, index) => ({
    percent,
    sampledAt: new Date(Date.UTC(2026, 9, 4, 0, index)).toISOString(),
  }));
}

function estimate(
  percents: readonly number[],
  charges: readonly QuotaEstimateAmounts[],
) {
  const samples = observations(percents);
  const byTime = new Map(
    samples.map((sample, index) => [sample.sampledAt, charges[index]!]),
  );
  return estimateQuotaSegments(samples, (sampledAt) => byTime.get(sampledAt)!);
}

function linearCharges(
  percents: readonly number[],
  usdTotal = "1000",
  creditsTotal = "25000",
  offset = "0",
): QuotaEstimateAmounts[] {
  return percents.map((percent) => ({
    usd: new Decimal(usdTotal).mul(percent).div(100).add(offset).toString(),
    credits: new Decimal(creditsTotal)
      .mul(percent)
      .div(100)
      .add(offset)
      .toString(),
  }));
}

test("early 1%, 2%, and 3% observations stay insufficient without fee reads", () => {
  for (const percents of [[], [1], [1, 2], [1, 2, 3]]) {
    let reads = 0;
    const result = estimateQuotaSegments(observations(percents), () => {
      reads++;
      return { usd: "100", credits: "2500" };
    });
    expect(result.reason).toBe("insufficient-data");
    expect(result.usd).toBeNull();
    expect(result.credits).toBeNull();
    expect(reads).toBe(0);
  }
});

test("requires three positive pairs spanning at least five percentage points", () => {
  const two = [0, 10];
  expect(estimate(two, linearCharges(two)).reason).toBe("insufficient-data");
  const three = [0, 5, 10];
  const result = estimate(three, linearCharges(three));
  expect(result.usd).toBe("1000");
  expect(result.credits).toBe("25000");
  expect(result.deltaPercent).toBe(10);
  expect(result.units.usd.positivePairCount).toBe(3);
});

test("linear quota estimates cancel constant initial cumulative offsets", () => {
  const percents = [10, 20, 35, 60];
  const result = estimate(
    percents,
    linearCharges(percents, "2000", "50000", "91.75"),
  );
  expect(result.reason).toBe("eligible");
  expect(result.usd).toBe("2000");
  expect(result.credits).toBe("50000");
});

test("uses Decimal for fractional percentages and cumulative charges", () => {
  const percents = [0.1, 5.1, 10.1];
  const result = estimate(
    percents,
    linearCharges(percents, "0.3", "0.7", "0.1"),
  );
  expect(result.usd).toBe("0.3");
  expect(result.credits).toBe("0.7");
  expect(result.units.usd.positivePairCount).toBe(3);
});

test("the median resists one monotonic distorted point among six points", () => {
  const percents = [0, 10, 20, 30, 40, 50];
  const charges = linearCharges(percents);
  charges[2] = { usd: "240", credits: "6000" };
  const result = estimate(percents, charges);
  expect(result.usd).toBe("1000");
  expect(result.credits).toBe("25000");
  expect(result.units.usd.positivePairCount).toBe(15);
});

test("repeated plateaus keep only their first arrival and do not add weight", () => {
  const percents = [0, 0, 10, 10, 20, 20];
  const charges = linearCharges(percents);
  charges[1] = { usd: "90", credits: "2250" };
  charges[3] = { usd: "190", credits: "4750" };
  charges[5] = { usd: "290", credits: "7250" };
  const result = estimate(percents, charges);
  expect(result.usd).toBe("1000");
  expect(result.credits).toBe("25000");
  expect(result.units.usd.positivePairCount).toBe(3);
});

test("a percent rollback discards the older segment", () => {
  const percents = [0, 10, 20, 5, 15, 25];
  const charges = [
    ...linearCharges(percents.slice(0, 3), "1000", "25000"),
    ...linearCharges(percents.slice(3), "2000", "50000", "300"),
  ];
  const result = estimate(percents, charges);
  expect(result.usd).toBe("2000");
  expect(result.credits).toBe("50000");
  expect(result.deltaPercent).toBe(20);
  expect(estimate([0, 10, 20, 5], charges.slice(0, 4)).reason).toBe(
    "insufficient-data",
  );
});

test("ignores invalid and saturated points while saturated rollbacks reset history", () => {
  const percents = [NaN, -1, 0, Infinity, 10, 20, 100, 101];
  const samples = observations(percents);
  const readTimes: string[] = [];
  const result = estimateQuotaSegments(samples, (sampledAt) => {
    readTimes.push(sampledAt);
    const percent = samples.find(
      (sample) => sample.sampledAt === sampledAt,
    )!.percent;
    return { usd: String(percent * 10), credits: String(percent * 250) };
  });
  expect(result.usd).toBe("1000");
  expect(readTimes).toEqual([
    samples[2]!.sampledAt,
    samples[4]!.sampledAt,
    samples[5]!.sampledAt,
  ]);
  const rollback = [0, 10, 20, 100, 30];
  expect(estimate(rollback, linearCharges(rollback)).reason).toBe(
    "insufficient-data",
  );
});

test("null prices never become zero and do not prevent the other unit estimate", () => {
  const percents = [0, 10, 20];
  const charges = linearCharges(percents).map((charge) => ({
    ...charge,
    usd: null,
  }));
  const result = estimate(percents, charges);
  expect(result.usd).toBeNull();
  expect(result.credits).toBe("25000");
  expect(result.units.usd.reason).toBe("unpriced");
  expect(result.reason).toBe("eligible");
  const partial = linearCharges(percents);
  partial[0]!.usd = null;
  expect(estimate(percents, partial).usd).toBeNull();
  const recoverable = [0, 10, 20, 30];
  const moreCharges = linearCharges(recoverable);
  moreCharges[0]!.usd = null;
  expect(estimate(recoverable, moreCharges).usd).toBe("1000");
});

test("zero costs do not produce a zero quota or count as positive pairs", () => {
  const percents = [0, 10, 20, 30];
  const zero = percents.map(() => ({ usd: "0", credits: "0" }));
  const result = estimate(percents, zero);
  expect(result.usd).toBeNull();
  expect(result.credits).toBeNull();
  expect(result.reason).toBe("unpriced");
  expect(result.units.usd.positivePairCount).toBe(0);
  expect(
    estimate(
      [0, 10, 20],
      [
        { usd: "0", credits: "0" },
        { usd: "0", credits: "0" },
        { usd: "10", credits: "10" },
      ],
    ).usd,
  ).toBeNull();
});

test("any negative cumulative difference invalidates that unit rather than biasing it upward", () => {
  const percents = [0, 10, 20, 30];
  const charges = linearCharges(percents);
  charges[2]!.usd = "90";
  const result = estimate(percents, charges);
  expect(result.usd).toBeNull();
  expect(result.units.usd.reason).toBe("non-monotonic");
  expect(result.credits).toBe("25000");
  const narrow = [0, 2, 10, 20];
  const narrowCharges = linearCharges(narrow);
  narrowCharges[1]!.usd = "-1";
  expect(estimate(narrow, narrowCharges).units.usd.reason).toBe(
    "non-monotonic",
  );
});

test("reads at most 32 real representative points spread across percent range including endpoints", () => {
  const percents = [
    ...Array.from({ length: 5000 }, (_, index) => index / 1000),
    ...Array.from({ length: 95 }, (_, index) => index + 5),
  ];
  const samples = observations(percents);
  const byTime = new Map(
    samples.map((sample) => [sample.sampledAt, sample.percent]),
  );
  const selected: number[] = [];
  const result = estimateQuotaSegments(samples, (sampledAt) => {
    const percent = byTime.get(sampledAt)!;
    selected.push(percent);
    return { usd: String(percent * 10), credits: String(percent * 250) };
  });
  expect(result.usd).toBe("1000");
  expect(selected.length).toBeLessThanOrEqual(32);
  expect(selected[0]).toBe(0);
  expect(selected.at(-1)).toBe(99);
  expect(new Set(selected).size).toBe(selected.length);
  expect(selected.filter((percent) => percent < 5).length).toBeLessThanOrEqual(
    3,
  );
});

test("rough estimates cover early 1%, 2%, and 3% without an artificial baseline", () => {
  for (const percents of [[1], [1, 2], [1, 2, 3]]) {
    const samples = observations(percents);
    const charges = linearCharges(percents);
    const byTime = new Map(
      samples.map((sample, index) => [sample.sampledAt, charges[index]!]),
    );
    expect(
      roughQuotaEstimate(samples, (sampledAt) => byTime.get(sampledAt)!),
    ).toEqual({
      usd: "1000",
      credits: "25000",
    });
  }
});

test("rough estimates use the origin-weighted slope instead of averaging point estimates", () => {
  const samples = observations([1, 2, 3]);
  const byTime = new Map(
    samples.map((sample, index) => [
      sample.sampledAt,
      {
        usd: ["10", "30", "60"][index]!,
        credits: ["100", "300", "600"][index]!,
      },
    ]),
  );
  const result = roughQuotaEstimate(samples, (sampledAt) =>
    byTime.get(sampledAt)!,
  );
  expect(result.usd).toBe("1785.7142857142857143");
  expect(result.credits).toBe("17857.142857142857143");
});

test("rough estimates ignore plateau repeats and use only the current monotonic segment", () => {
  const samples = observations([10, 20, 1, 1, 2, 2, 3, 3]);
  const charges = [
    { usd: "1000", credits: "1000" },
    { usd: "2000", credits: "2000" },
    { usd: "10", credits: "250" },
    { usd: "19", credits: "475" },
    { usd: "20", credits: "500" },
    { usd: "29", credits: "725" },
    { usd: "30", credits: "750" },
    { usd: "39", credits: "975" },
  ];
  const byTime = new Map(
    samples.map((sample, index) => [sample.sampledAt, charges[index]!]),
  );
  const reads: string[] = [];
  expect(
    roughQuotaEstimate(samples, (sampledAt) => {
      reads.push(sampledAt);
      return byTime.get(sampledAt)!;
    }),
  ).toEqual({ usd: "1000", credits: "25000" });
  expect(reads).toEqual([
    samples[2]!.sampledAt,
    samples[4]!.sampledAt,
    samples[6]!.sampledAt,
  ]);
});

test("rough units independently skip null amounts and reject zeros and negative cumulative differences", () => {
  const samples = observations([1, 2, 3]);
  const charges: QuotaEstimateAmounts[] = [
    { usd: null, credits: "0" },
    { usd: "20", credits: "0" },
    { usd: "30", credits: "0" },
  ];
  const byTime = new Map(
    samples.map((sample, index) => [sample.sampledAt, charges[index]!]),
  );
  const read = (sampledAt: string) => byTime.get(sampledAt)!;
  expect(roughQuotaEstimate(samples, read)).toEqual({
    usd: "1000",
    credits: null,
  });
  charges[2]!.usd = "19";
  expect(roughQuotaEstimate(samples, read)).toEqual({
    usd: null,
    credits: null,
  });
  const none = roughQuotaEstimate(
    observations([0, NaN, -1, 100, Infinity]),
    () => {
      throw new Error("No fee reads for unusable percentages");
    },
  );
  expect(none).toEqual({ usd: null, credits: null });
});

test("rough and multi-segment helpers share at most 32 representative fee reads with a memo reader", () => {
  const samples = observations(
    Array.from({ length: 990 }, (_, index) => index / 10),
  );
  const byTime = new Map(
    samples.map((sample) => [sample.sampledAt, sample.percent]),
  );
  const memo = new Map<string, QuotaEstimateAmounts>();
  const read = (sampledAt: string) => {
    if (!memo.has(sampledAt)) {
      const percent = byTime.get(sampledAt)!;
      memo.set(sampledAt, linearCharges([percent])[0]!);
    }
    return memo.get(sampledAt)!;
  };
  expect(roughQuotaEstimate(samples, read).usd).toBe("1000");
  expect(estimateQuotaSegments(samples, read).usd).toBe("1000");
  expect(memo.size).toBeLessThanOrEqual(32);
});

test("historical rough eligibility uses priced observations in the current monotonic segment", () => {
  const points = observations([50, 1]);
  expect(
    roughQuotaEstimate(points, () => ({ usd: "5", credits: "10" }), 10),
  ).toEqual({ usd: null, credits: null });
  const split = observations([1, 10]);
  expect(
    roughQuotaEstimate(
      split,
      (at) =>
        at === split[0]!.sampledAt
          ? { usd: "5", credits: "10" }
          : { usd: null, credits: "100" },
      10,
    ),
  ).toEqual({ usd: null, credits: "1000" });
});

test("a zero-cost first plateau does not hide later positive rough usage", () => {
  const points = observations([1, 1]);
  expect(
    roughQuotaEstimate(points, (at) =>
      at === points[0]!.sampledAt
        ? { usd: "0", credits: null }
        : { usd: "10", credits: "20" },
    ),
  ).toEqual({ usd: "1000", credits: "2000" });
});

test("rounded integer percents treat adjacent first arrivals as half-point crossings", () => {
  // 上游四舍五入时，紧接 k-1 后首次出现 k 的时刻实际约为 k-0.5。
  const percents = [0, 1, 2, 3];
  const samples = observations(percents);
  const byTime = new Map(
    samples.map((sample, index) => {
      const crossed = Math.max(0, percents[index]! - 0.5);
      return [
        sample.sampledAt,
        { usd: String(crossed * 10), credits: String(crossed * 250) },
      ];
    }),
  );
  const reader = (sampledAt: string) => byTime.get(sampledAt)!;
  expect(roughQuotaEstimate(samples, reader, 0, true)).toEqual({
    usd: "1000",
    credits: "25000",
  });
  // 未声明取整时保持原百分比，结果明显偏低。
  expect(Number(roughQuotaEstimate(samples, reader).usd)).toBeLessThan(900);
});

test("rounded correction skips jumped arrivals and fractional readings", () => {
  for (const percents of [
    [0, 10],
    [0, 0.4, 1.4],
  ]) {
    const samples = observations(percents);
    const charges = linearCharges(percents);
    const byTime = new Map(
      samples.map((sample, index) => [sample.sampledAt, charges[index]!]),
    );
    expect(
      roughQuotaEstimate(samples, (at) => byTime.get(at)!, 0, true).usd,
    ).toBe("1000");
  }
});

test("rounded correction keeps segment estimates continuous with early rough estimates", () => {
  const percents = [0, 1, 2, 3, 4, 5, 6, 7];
  const samples = observations(percents);
  const byTime = new Map(
    samples.map((sample, index) => {
      const crossed = Math.max(0, percents[index]! - 0.5);
      return [
        sample.sampledAt,
        { usd: String(crossed * 10), credits: String(crossed * 250) },
      ];
    }),
  );
  const result = estimateQuotaSegments(samples, (at) => byTime.get(at)!, true);
  expect(result.usd).toBe("1000");
  expect(result.credits).toBe("25000");
});
