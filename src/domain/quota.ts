import Decimal from "decimal.js";
import type { QuotaPlanObservation } from "./quota-plan";
import {
  estimateQuotaSegments,
  roughQuotaEstimate,
  type QuotaEstimateAmounts,
} from "./quota-estimate";
import type { QuotaFact } from "./connector";
import type { UsageFact } from "./connector";
import type { Valuation } from "./pricing";

export type QuotaEstimateMethod =
  "segments" | "blended" | "previous-period" | "rough";

export interface PricedUsage {
  fact: UsageFact;
  valuation: Valuation;
}
export interface CollectedQuota {
  fact: QuotaFact;
  collectedAt: string;
  planHistory?: readonly QuotaPlanObservation[];
}

/** modelScope 非空时只汇总满足条件的模型；读取器必须遵守，否则按模型计量的窗口会混入其他请求。 */
export type QuotaChargeReader = (
  startInclusive: string,
  endInclusive: string,
  modelScope: ((model: string) => boolean) | null,
) => {
  usd: string | null;
  credits: string | null;
  count?: number;
  tokens?: number | null;
};

/**
 * 按模型单独计量的额度窗口只累计对应模型的请求；返回 null 表示窗口覆盖账户全部请求。
 * Fable 周额度与账户整体周额度分开消耗，混入其他模型会高估本期费用和推算额度。
 */
export function quotaModelScope(
  window: QuotaFact["window"],
): ((model: string) => boolean) | null {
  if (window === "seven-day-fable")
    return (model) => model.startsWith("claude-fable-");
  return null;
}

/** 到期等待新快照时仅展示已重置状态，旧百分比不能带入下一周期。 */
export interface QuotaView {
  window: QuotaFact["window"];
  percent: number | null;
  sampledAt: string | null;
  resetsAt: string | null;
  startsAt: string | null;
  state: "active" | "expired" | "unknown";
  stale: boolean;
  periodUsd: string | null;
  periodCredits: string | null;
  /** 当前窗口起点至查询时刻的请求数与不重复 token 桶；到期后清空。 */
  periodRequests: number | null;
  periodTokens: number | null;
  estimate: {
    usd: string | null;
    credits: string | null;
    deltaPercent: number | null;
    /** 每个计价单位独立选择依据；旧报表可能没有该字段。 */
    methods?: {
      usd: QuotaEstimateMethod | null;
      credits: QuotaEstimateMethod | null;
    };
    reason:
      | "eligible"
      | "window-unknown"
      | "expired"
      | "percent-unavailable"
      | "unpriced";
  };
}

/** 上游重置时间带毫秒级抖动，按最接近的整分钟归组，同一周期不能因抖动拆成两个。 */
function cycleResetKey(resetsAt: string | null) {
  const value = resetsAt ? Date.parse(resetsAt) : NaN;
  return Number.isFinite(value) ? Math.round(value / 60_000) * 60_000 : NaN;
}

/**
 * 同一周期、同一套餐内已用百分比只增不减。多个 Claude Code 会话会轮流写入各自较早看到的额度，
 * 小幅回落是过时读数，忽略后保留此前最高值；至少回落 5 个百分点且不高于此前最高值一半时，
 * 才视为上游重新计数，从回落点重新起算。
 */
function stableReadings<T extends { percent: number }>(readings: readonly T[]) {
  let kept: T[] = [];
  let rebased = false;
  for (const reading of readings) {
    const highest = kept.at(-1)?.percent;
    if (highest !== undefined && reading.percent < highest) {
      if (highest - reading.percent < 5 || reading.percent > highest / 2)
        continue;
      kept = [];
      rebased = true;
    }
    kept.push(reading);
  }
  return { readings: kept, rebased };
}

function sumCharges(rows: readonly PricedUsage[], unit: "usd" | "credits") {
  // 周期费用累计可计价部分；只有有请求且全部缺价时金额才未知。
  const priced = rows.filter((row) => row.valuation[unit].amount !== null);
  if (rows.length > 0 && priced.length === 0) return null;
  return priced
    .reduce(
      (total, row) => total.add(row.valuation[unit].amount!),
      new Decimal(0),
    )
    .toString();
}

function rowsChargeReader(rows: readonly PricedUsage[]): QuotaChargeReader {
  return (startInclusive, endInclusive, modelScope) => {
    const start = Date.parse(startInclusive);
    const end = Date.parse(endInclusive);
    const selected = rows.filter((row) => {
      const occurredAt = Date.parse(row.fact.occurredAt);
      return (
        occurredAt >= start &&
        occurredAt <= end &&
        (!modelScope || modelScope(row.fact.model))
      );
    });
    return {
      usd: sumCharges(selected, "usd"),
      credits: sumCharges(selected, "credits"),
      count: selected.length,
      tokens: selected.some((row) =>
        (["input", "cacheRead", "cacheWrite", "output"] as const).some(
          (field) => row.fact.tokens[field] === null,
        ),
      )
        ? null
        : selected.reduce(
            (total, row) =>
              total +
              (row.fact.tokens.input ?? 0) +
              (row.fact.tokens.cacheRead ?? 0) +
              (row.fact.tokens.cacheWrite ?? 0) +
              (row.fact.tokens.output ?? 0),
            0,
          ),
    };
  };
}

/** 百分比为整个上游账号，费用只覆盖本连接器；推算是条件性观测值而非订阅承诺额度。 */
export function quotaView(
  history: CollectedQuota[],
  rowsOrSumReader: readonly PricedUsage[] | QuotaChargeReader,
  now: string,
): QuotaView | null {
  if (!history.length) return null;
  const ordered = [...history].sort(
    (a, b) =>
      Date.parse(a.fact.sampledAt ?? a.collectedAt) -
      Date.parse(b.fact.sampledAt ?? b.collectedAt),
  );
  const latest = ordered.at(-1)!;
  const fact = latest.fact;
  const reset = cycleResetKey(fact.resetsAt);
  const sampled = fact.sampledAt ? Date.parse(fact.sampledAt) : NaN;
  const time = Date.parse(now);
  const expired = Number.isFinite(reset) && reset <= time;
  const known =
    Number.isFinite(reset) &&
    Number.isFinite(sampled) &&
    sampled <= time &&
    fact.windowMinutes !== null &&
    fact.windowMinutes > 0;
  const startsAt = known
    ? new Date(reset - fact.windowMinutes! * 60_000).toISOString()
    : null;
  const start = startsAt ? Date.parse(startsAt) : NaN;
  const modelScope = quotaModelScope(fact.window);
  const readSource =
    typeof rowsOrSumReader === "function"
      ? rowsOrSumReader
      : rowsChargeReader(rowsOrSumReader);
  const readCharges = (startInclusive: string, endInclusive: string) =>
    readSource(startInclusive, endInclusive, modelScope);
  const periodCharges =
    known && !expired
      ? start <= time
        ? readCharges(startsAt!, now)
        : { usd: "0", credits: "0", count: 0, tokens: 0 }
      : null;
  // 合并账户可能同时持有多个采样来源，只用最新来源比较百分比。
  const sameSource = ordered.filter(
    ({ fact: sample }) =>
      sample.sourceId === fact.sourceId &&
      sample.accountExternalId === fact.accountExternalId &&
      sample.window === fact.window &&
      sample.windowMinutes === fact.windowMinutes,
  );
  const plan = [...(latest.planHistory ?? [])]
    .filter((entry) => Date.parse(entry.observedAt) <= time)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    .at(-1);
  const planStart = plan ? Date.parse(plan.observedAt) : NaN;
  const duration = (fact.windowMinutes ?? 0) * 60_000;
  /** 返回某周期内同一来源、同一已知套餐区间的有效读数，过时回落已剔除。 */
  const cycleReadings = (cycleReset: number, until: number) => {
    const cycleStart = cycleReset - duration;
    // 已发现套餐变化后不能使用变化前的点。初次建立历史不冒充过去的套餐证明。
    const boundary =
      plan && (plan.changed || cycleReset !== reset)
        ? Math.max(cycleStart, planStart)
        : cycleStart;
    const observations = sameSource.flatMap(({ fact: sample }) => {
      const at = Date.parse(sample.sampledAt ?? "");
      if (
        cycleResetKey(sample.resetsAt) !== cycleReset ||
        sample.percent === null ||
        !Number.isFinite(sample.percent) ||
        sample.percent < 0 ||
        !Number.isFinite(at) ||
        at < boundary ||
        at > until ||
        at >= cycleReset
      )
        return [];
      return [{ percent: sample.percent, sampledAt: sample.sampledAt! }];
    });
    const stable = stableReadings(observations);
    return {
      observations: stable.readings,
      rebased: stable.rebased || boundary > cycleStart,
    };
  };
  // 展示的百分比同样忽略过时回落，避免进度在相邻两个值之间来回跳。
  const displayPercent =
    known && !expired && fact.percent !== null && fact.percent >= 0
      ? (cycleReadings(reset, sampled).observations.at(-1)?.percent ??
        fact.percent)
      : fact.percent;
  const result: QuotaView = {
    window: fact.window,
    percent: expired ? 0 : displayPercent,
    sampledAt: fact.sampledAt,
    resetsAt: fact.resetsAt,
    startsAt: expired ? null : startsAt,
    state: expired ? "expired" : known ? "active" : "unknown",
    stale:
      !Number.isFinite(sampled) ||
      time - sampled > 5 * 60_000 ||
      sampled > time,
    periodUsd: periodCharges?.usd ?? null,
    periodCredits: periodCharges?.credits ?? null,
    periodRequests: periodCharges?.count ?? null,
    periodTokens: periodCharges?.tokens ?? null,
    estimate: {
      usd: null,
      credits: null,
      deltaPercent: null,
      reason: expired
        ? "expired"
        : !known
          ? "window-unknown"
          : "percent-unavailable",
    },
  };
  if (
    !known ||
    expired ||
    fact.percent === null ||
    fact.percent < 0 ||
    fact.window === "five-hour"
  )
    return result;
  const estimateCycle = (cycleReset: number, until: number) => {
    const cycleStart = cycleReset - duration;
    const readings = cycleReadings(cycleReset, until);
    const rebased = readings.rebased;
    const observations = readings.observations.filter(
      (entry) => entry.percent < 100,
    );
    const baseline = rebased ? observations[0] : undefined;
    const charges = new Map<string, QuotaEstimateAmounts>();
    const read = (at: string) => {
      let value = charges.get(at);
      if (!value) {
        value =
          cycleReset === reset && Date.parse(at) === time
            ? periodCharges!
            : readCharges(new Date(cycleStart).toISOString(), at);
        charges.set(at, value);
      }
      return value;
    };
    // 消费和百分比同时平移，套餐中途变化或百分比回退时不混入旧区间消费。
    const baselineCharges = baseline ? read(baseline.sampledAt) : null;
    const estimateRead = (at: string): QuotaEstimateAmounts => {
      const amount = read(at);
      if (!baselineCharges) return amount;
      const difference = (unit: "usd" | "credits") =>
        amount[unit] === null || baselineCharges[unit] === null
          ? null
          : new Decimal(amount[unit]!).sub(baselineCharges[unit]!).toString();
      return { usd: difference("usd"), credits: difference("credits") };
    };
    const estimateObservations = baseline
      ? observations.map((entry) => ({
          ...entry,
          percent: new Decimal(entry.percent).sub(baseline.percent).toNumber(),
        }))
      : observations;
    // 上游百分比为四舍五入整数。重新起算的基准点落在平台期中段，相对百分比的取整偏差无法确定，不做校正。
    const roundedPercent = !rebased;
    const segments = estimateQuotaSegments(
      estimateObservations,
      estimateRead,
      roundedPercent,
    );
    const rough = roughQuotaEstimate(
      estimateObservations,
      estimateRead,
      cycleReset === reset ? 0 : 10,
      roundedPercent,
    );
    return { segments, rough, observations, rebased };
  };
  const current = estimateCycle(reset, sampled);
  // 只借用紧邻的上一周期；缺少上一周期或长时间停用后，不沿用久远额度。
  const previousReset = sameSource.reduce((latestReset, { fact: sample }) => {
    const candidate = cycleResetKey(sample.resetsAt);
    return candidate <= start &&
      candidate > start - duration &&
      candidate > latestReset
      ? candidate
      : latestReset;
  }, -Infinity);
  // 只有当前已知套餐区间内的历史才有资格参考，未知和旧版本快照不能证明套餐相同。
  const previous =
    plan?.plan &&
    Number.isFinite(previousReset) &&
    previousReset > planStart &&
    !current.rebased
      ? estimateCycle(previousReset, previousReset)
      : null;
  const methods: NonNullable<QuotaView["estimate"]["methods"]> = {
    usd: null,
    credits: null,
  };
  for (const unit of ["usd", "credits"] as const) {
    const segments = current.segments[unit];
    const rough = current.rough[unit];
    const currentAmount = segments ?? rough;
    // 历史单点也可能很粗糙，至少已有 10% 的有效观测才用于下一周期。
    const prior = previous?.segments[unit] ?? previous?.rough[unit];
    if (prior !== null && prior !== undefined) {
      // 有历史时不混入早期粗估，避免单点偏移在多段算法可用时造成反向跳变。
      // 多段观测充分后，随本周期跨度增加逐步减少历史权重。
      const weight =
        segments !== null
          ? Math.min(1, Math.max(0, current.segments.deltaPercent ?? 0) / 20) **
            2
          : 0;
      result.estimate[unit] =
        currentAmount !== null
          ? new Decimal(prior)
              .mul(1 - weight)
              .add(new Decimal(currentAmount).mul(weight))
              .toString()
          : prior;
      methods[unit] =
        currentAmount === null || weight === 0
          ? "previous-period"
          : weight === 1
            ? segments !== null
              ? "segments"
              : "rough"
            : "blended";
    } else {
      result.estimate[unit] = currentAmount;
      methods[unit] =
        currentAmount === null
          ? null
          : segments !== null
            ? "segments"
            : "rough";
    }
  }
  result.estimate.deltaPercent = current.segments.deltaPercent;
  result.estimate.methods = methods;
  result.estimate.reason =
    result.estimate.usd !== null || result.estimate.credits !== null
      ? "eligible"
      : fact.percent === 0
        ? "percent-unavailable"
        : "unpriced";
  return result;
}
