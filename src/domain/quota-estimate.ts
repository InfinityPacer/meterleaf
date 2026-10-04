import Decimal from "decimal.js";

export interface QuotaEstimateObservation {
  percent: number;
  sampledAt: string;
}

export interface QuotaEstimateAmounts {
  usd: string | null;
  credits: string | null;
}

/** 金额必须累计自同一窗口起点并截止到给定采样时刻，缺价保留 null。 */
export type QuotaEstimateChargeReader = (
  sampledAt: string,
) => QuotaEstimateAmounts;

type UnitEstimateReason =
  "eligible" | "insufficient-data" | "unpriced" | "non-monotonic";

export interface QuotaSegmentEstimate extends QuotaEstimateAmounts {
  /** 当前单调段的百分比跨度，不表示独立样本数量或统计置信度。 */
  deltaPercent: number | null;
  reason: "eligible" | "insufficient-data" | "unpriced";
  units: Record<
    "usd" | "credits",
    { reason: UnitEstimateReason; positivePairCount: number }
  >;
}

const maxObservations = 32;
const minDeltaPercent = 5;
const minPositivePairs = 3;

function currentSegment(observations: readonly QuotaEstimateObservation[]) {
  let previousPercent: number | null = null;
  let segment: QuotaEstimateObservation[] = [];
  for (const observation of observations) {
    const { percent } = observation;
    if (!Number.isFinite(percent) || percent < 0) continue;
    if (previousPercent !== null && percent < previousPercent) segment = [];
    previousPercent = percent;
    // 饱和点不能外推，但从饱和值下降仍是单调段的边界。
    if (percent >= 100) continue;
    // 平台期只保留首次到达时刻，避免采样频率改变点对权重。
    if (segment.at(-1)?.percent === percent) continue;
    segment.push(observation);
  }
  return segment;
}

function representativePoints(
  observations: readonly QuotaEstimateObservation[],
): readonly QuotaEstimateObservation[] {
  if (observations.length <= maxObservations) return observations;
  const first = observations[0]!;
  const last = observations.at(-1)!;
  const selected = new Set<number>([0, observations.length - 1]);
  let index = 0;
  // 在百分比范围均匀取目标值，使用最近的真实观测，不插值费用或伪造样本。
  for (let targetIndex = 1; targetIndex < maxObservations - 1; targetIndex++) {
    const target =
      first.percent +
      ((last.percent - first.percent) * targetIndex) / (maxObservations - 1);
    while (
      index + 1 < observations.length &&
      observations[index + 1]!.percent <= target
    ) {
      index++;
    }
    const next = Math.min(index + 1, observations.length - 1);
    selected.add(
      target - observations[index]!.percent <=
        observations[next]!.percent - target
        ? index
        : next,
    );
  }
  return [...selected]
    .sort((a, b) => a - b)
    .map((selectedIndex) => observations[selectedIndex]!);
}

function monotonicAmounts(
  amounts: readonly (string | null)[],
): (Decimal | null)[] | null {
  const cumulative = amounts.map((amount) => {
    if (amount === null) return null;
    const value = new Decimal(amount);
    return value.isFinite() ? value : null;
  });
  let previous: Decimal | null = null;
  for (const amount of cumulative) {
    if (amount === null) continue;
    // 累计费用下降使该单位不可外推，不能丢弃负差后仅采用正差。
    if (previous !== null && amount.lt(previous)) {
      return null;
    }
    previous = amount;
  }
  return cumulative;
}

function estimateUnit(
  amounts: readonly (string | null)[],
  pairs: readonly { from: number; to: number; delta: Decimal }[],
): {
  amount: string | null;
  reason: UnitEstimateReason;
  positivePairCount: number;
} {
  if (pairs.length < minPositivePairs) {
    return { amount: null, reason: "insufficient-data", positivePairCount: 0 };
  }
  const cumulative = monotonicAmounts(amounts);
  if (cumulative === null) {
    return { amount: null, reason: "non-monotonic", positivePairCount: 0 };
  }
  const estimates: Decimal[] = [];
  for (const pair of pairs) {
    const from = cumulative[pair.from]!;
    const to = cumulative[pair.to]!;
    if (from === null || to === null) continue;
    const difference = to.sub(from);
    if (difference.gt(0)) estimates.push(difference.mul(100).div(pair.delta));
  }
  if (estimates.length < minPositivePairs) {
    return {
      amount: null,
      reason: "unpriced",
      positivePairCount: estimates.length,
    };
  }
  estimates.sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(estimates.length / 2);
  const median =
    estimates.length % 2 === 0
      ? estimates[middle - 1]!.add(estimates[middle]!).div(2)
      : estimates[middle]!;
  return {
    amount: median.toString(),
    reason: "eligible",
    positivePairCount: estimates.length,
  };
}

/**
 * 数据尚不足以形成多段估算时，按真实观测做过原点加权粗估。
 * 权重为百分比平方，缺价点不参与对应单位的分子或分母。
 * 调用方筛选窗口并排序，使用与多段估算相同的缓存读取器可复用费用查询。
 */
export function roughQuotaEstimate(
  observations: readonly QuotaEstimateObservation[],
  readCumulativeCharges: QuotaEstimateChargeReader,
  minimumObservedPercent = 0,
): QuotaEstimateAmounts {
  const selected = representativePoints(currentSegment(observations)).filter(
    (observation) => observation.percent > 0,
  );
  const charges = selected.map((observation) =>
    readCumulativeCharges(observation.sampledAt),
  );
  const roughUnit = (unit: "usd" | "credits") => {
    const amounts = monotonicAmounts(charges.map((charge) => charge[unit]));
    if (amounts === null) return null;
    let numerator = new Decimal(0);
    let denominator = new Decimal(0);
    let enoughObservedPercent = false;
    for (let index = 0; index < selected.length; index++) {
      const amount = amounts[index]!;
      if (amount === null) continue;
      if (amount.gt(0) && selected[index]!.percent >= minimumObservedPercent)
        enoughObservedPercent = true;
      const percent = new Decimal(selected[index]!.percent);
      numerator = numerator.add(percent.mul(amount));
      denominator = denominator.add(percent.mul(percent));
    }
    // 首次平台观测可能早于本地费用到达，仅无正值时用最新平台费用补上粗估。
    // 正常已有估值的平台仍固定首次点，避免每次推送都改变估值。
    if (!numerator.gt(0)) {
      const latest = observations.at(-1);
      if (
        latest &&
        latest.percent > 0 &&
        latest.percent < 100 &&
        latest.percent >= minimumObservedPercent
      ) {
        const latestAmount = readCumulativeCharges(latest.sampledAt)[unit];
        if (latestAmount !== null) {
          const value = new Decimal(latestAmount);
          if (value.isFinite() && value.gt(0))
            return value.mul(100).div(latest.percent).toString();
        }
      }
    }
    return enoughObservedPercent && numerator.gt(0) && denominator.gt(0)
      ? numerator.mul(100).div(denominator).toString()
      : null;
  };
  return { usd: roughUnit("usd"), credits: roughUnit("credits") };
}

/**
 * 调用方先筛选同一来源和当前窗口，并按 sampledAt 升序传入观测。
 * 点对费用差抵消窗口初始偏移，点对中位数只是条件性估算，不是承诺额度。
 * 每单位至少需要三个正值点对，百分比差不足 5 个百分点不参与外推。
 */
export function estimateQuotaSegments(
  observations: readonly QuotaEstimateObservation[],
  readCumulativeCharges: QuotaEstimateChargeReader,
): QuotaSegmentEstimate {
  const segment = currentSegment(observations);
  const selected = representativePoints(segment);
  const deltaPercent = segment.length
    ? new Decimal(segment.at(-1)!.percent).sub(segment[0]!.percent).toNumber()
    : null;
  const pairs: { from: number; to: number; delta: Decimal }[] = [];
  for (let from = 0; from < selected.length; from++) {
    for (let to = from + 1; to < selected.length; to++) {
      const delta = new Decimal(selected[to]!.percent).sub(
        selected[from]!.percent,
      );
      if (delta.gte(minDeltaPercent)) pairs.push({ from, to, delta });
    }
  }
  // 百分比变化尚不足时无需查询累计费用。
  const charges =
    pairs.length >= minPositivePairs
      ? selected.map((observation) =>
          readCumulativeCharges(observation.sampledAt),
        )
      : [];
  const usd = estimateUnit(
    charges.map((charge) => charge.usd),
    pairs,
  );
  const credits = estimateUnit(
    charges.map((charge) => charge.credits),
    pairs,
  );
  return {
    usd: usd.amount,
    credits: credits.amount,
    deltaPercent,
    reason:
      usd.reason === "eligible" || credits.reason === "eligible"
        ? "eligible"
        : pairs.length < minPositivePairs
          ? "insufficient-data"
          : "unpriced",
    units: {
      usd: { reason: usd.reason, positivePairCount: usd.positivePairCount },
      credits: {
        reason: credits.reason,
        positivePairCount: credits.positivePairCount,
      },
    },
  };
}
