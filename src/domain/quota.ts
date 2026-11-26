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
import type { AccountCredits } from "../shared/report";

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
  /** 缓存读取占输入侧三个桶的百分比，只统计三个桶都已知的请求；没有这类请求时为 null。 */
  cacheRate?: number | null;
};

/**
 * 按模型单独计量的额度窗口只累计对应模型的请求；返回 null 表示窗口覆盖账户全部请求。
 * Fable 周额度与账户整体周额度分开消耗，混入其他模型会高估本期费用和推算额度。
 * Antigravity 账户有两个额度池：带 -3p 的窗口只计 Claude、GPT 等第三方模型；账户上报了
 * 第三方池（pooled）时，它的 5 小时与周窗口属于 Gemini 池，只计 Gemini 模型。
 */
export function quotaModelScope(
  window: QuotaFact["window"],
  pooled = false,
): ((model: string) => boolean) | null {
  if (window === "seven-day-fable") return fableModelScope;
  if (window === "five-hour-3p" || window === "seven-day-3p")
    return thirdPartyModelScope;
  if (pooled && (window === "five-hour" || window === "seven-day"))
    return geminiModelScope;
  return null;
}

/** 账户的额度历史里出现第三方池窗口，说明它的 5 小时与周窗口只属于 Gemini 池。 */
export function hasThirdPartyPool(history: readonly CollectedQuota[]) {
  return history.some(
    (row) =>
      row.fact.window === "five-hour-3p" || row.fact.window === "seven-day-3p",
  );
}

// 固定函数身份，报表索引按身份复用同一窗口的汇总。
const fableModelScope = (model: string) => model.startsWith("claude-fable-");
// 与采集器按模型名分池的规则一致：gemini- 开头的归 Gemini 池，其余归第三方池。
const geminiModelScope = (model: string) => model.startsWith("gemini-");
const thirdPartyModelScope = (model: string) => !model.startsWith("gemini-");

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
  periodCacheRate: number | null;
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
 * quotaView 只用到最新读数所在周期和紧邻的上一周期，返回同一来源窗口需要保留的最早采样时刻。
 * 读数的重置时间不会晚于采样时刻一个窗口，上一周期的读数因此都晚于本周期重置前三个窗口，
 * 另留一小时吸收重置时间抖动。周期未知或已到期时只需最新读数。
 */
export function quotaHistoryStart(latest: QuotaFact, now: string): number {
  const sampled = latest.sampledAt ? Date.parse(latest.sampledAt) : NaN;
  const reset = cycleResetKey(latest.resetsAt);
  const duration = (latest.windowMinutes ?? 0) * 60_000;
  if (!Number.isFinite(reset) || duration <= 0 || reset <= Date.parse(now))
    return sampled;
  return Math.min(sampled, reset - 3 * duration - 3_600_000);
}

/** 至少回落 5 个百分点且不高于此前峰值一半，才视为上游重新计数。 */
function isRebaseDrop(peak: number, percent: number) {
  return peak - percent >= 5 && percent <= peak / 2;
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
      if (!isRebaseDrop(highest, reading.percent)) continue;
      kept = [];
      rebased = true;
    }
    kept.push(reading);
  }
  return { readings: kept, rebased };
}

/**
 * 估算使用的单调读数：与展示层共用同一重新计数边界，但低档位回落至少一半（如 1%→0%→1%、
 * 2%→1%→2% 的上游瞬时预扣回弹）会撤销被回落推翻的更高档位首点，改用后续稳定重跨时刻，
 * 且不视为重新计数（费用仍从周期起点累计）；较高档位的小幅回落仍作为过时读数忽略。
 */
function estimationReadings<T extends { percent: number }>(
  readings: readonly T[],
  anchorFirst = false,
) {
  let kept: T[] = [];
  let peak: number | undefined;
  let rebased = false;
  for (const reading of readings) {
    if (
      peak !== undefined &&
      reading.percent < peak &&
      isRebaseDrop(peak, reading.percent)
    ) {
      kept = [reading];
      peak = reading.percent;
      rebased = true;
      continue;
    }
    const top = kept.at(-1)?.percent;
    if (top !== undefined && reading.percent < top) {
      if (reading.percent > top / 2) continue;
      const anchored = anchorFirst || rebased;
      const minKeep = anchored ? 1 : 0;
      while (kept.length > minKeep && kept.at(-1)!.percent > reading.percent) {
        kept.pop();
      }
      // 低于重新起算锚点的回落不入列，保留锚点作为费用与百分比平移基准，但仍撤销锚点之后被推翻的高档首点。
      if (anchored && reading.percent < kept[0]!.percent) {
        continue;
      }
    }
    kept.push(reading);
    if (peak === undefined || reading.percent > peak) peak = reading.percent;
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
    let cacheInput = 0;
    let cacheRead = 0;
    let tokenTotal = 0;
    let hasKnownTokens = false;
    for (const { fact } of selected) {
      const { input, cacheRead: read, cacheWrite, output } = fact.tokens;
      for (const value of [input, read, cacheWrite, output]) {
        if (value === null) continue;
        tokenTotal += value;
        hasKnownTokens = true;
      }
      if (input === null || read === null || cacheWrite === null) continue;
      cacheInput += input + read + cacheWrite;
      cacheRead += read;
    }
    return {
      usd: sumCharges(selected, "usd"),
      credits: sumCharges(selected, "credits"),
      count: selected.length,
      // 与报表汇总一致：单条缺失个别桶不抹除同周期已统计的 token，全未知时仍保留 null。
      tokens: selected.length === 0 ? 0 : hasKnownTokens ? tokenTotal : null,
      cacheRate: cacheInput ? (cacheRead / cacheInput) * 100 : null,
    };
  };
}

/**
 * 个别平台的额度语义与默认不同时传入；省略时行为与其他平台一致。
 * - allowPercentDrop：展示当前周期最新读数，允许百分比真实下降（例如充值后剩余额度变多）。
 * - disableEstimate：不按百分比外推整周期额度，周期内的本地费用、请求数、Tokens 与命中率照常统计。
 * - roundedPercent：上游百分比是否为四舍五入整数；为 false 时不做整数到达与下界校正。
 */
export interface QuotaViewOptions {
  allowPercentDrop?: boolean;
  disableEstimate?: boolean;
  roundedPercent?: boolean;
}

/**
 * 百分比为整个上游账号，费用只覆盖本连接器；推算是条件性观测值而非订阅承诺额度。
 * 七天与月度窗口与其他账户一样按百分比外推：同一周期会更换或混用模型，
 * 按单一模型上限推算没有可靠依据。
 */
export function quotaView(
  history: CollectedQuota[],
  rowsOrSumReader: readonly PricedUsage[] | QuotaChargeReader,
  now: string,
  pooled = false,
  options: QuotaViewOptions = {},
): QuotaView | null {
  if (!history.length) return null;
  // 每条读数只解析一次时间，历史较长时排序和逐周期筛选不再重复解析。
  const ordered = history
    .map((row) => ({
      row,
      order: Date.parse(row.fact.sampledAt ?? row.collectedAt),
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ row }) => row);
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
  const modelScope = quotaModelScope(fact.window, pooled);
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
        : { usd: "0", credits: "0", count: 0, tokens: 0, cacheRate: null }
      : null;
  // 合并账户可能同时持有多个采样来源，只用最新来源比较百分比。
  const sameSource = ordered
    .filter(
      ({ fact: sample }) =>
        sample.sourceId === fact.sourceId &&
        sample.accountExternalId === fact.accountExternalId &&
        sample.window === fact.window &&
        sample.windowMinutes === fact.windowMinutes,
    )
    .map(({ fact: sample }) => ({
      sample,
      at: Date.parse(sample.sampledAt ?? ""),
      cycle: cycleResetKey(sample.resetsAt),
    }));
  const plans = [...(latest.planHistory ?? [])]
    .filter((entry) => Date.parse(entry.observedAt) <= time)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const plan = plans.at(-1);
  const planStart = plan ? Date.parse(plan.observedAt) : NaN;
  const priorPlanStart =
    plans.length > 1 ? Date.parse(plans.at(-2)!.observedAt) : -Infinity;
  const duration = (fact.windowMinutes ?? 0) * 60_000;
  /** 周期内同一来源的有效读数，过时回落、负值和缺值已剔除。 */
  const readingsBetween = (cycleReset: number, from: number, until: number) =>
    sameSource.flatMap(({ sample, at, cycle }) => {
      if (
        cycle !== cycleReset ||
        sample.percent === null ||
        !Number.isFinite(sample.percent) ||
        sample.percent < 0 ||
        !Number.isFinite(at) ||
        at < from ||
        at > until ||
        at >= cycleReset
      )
        return [];
      return [{ percent: sample.percent, sampledAt: sample.sampledAt!, at }];
    });
  /** 返回某周期内同一来源、同一已知套餐区间的有效读数，过时回落已剔除。 */
  const cycleReadings = (cycleReset: number, until: number) => {
    const cycleStart = cycleReset - duration;
    // 已发现套餐变化后不能使用变化前的点。初次建立历史不冒充过去的套餐证明。
    let boundary =
      plan && (plan.changed || cycleReset !== reset)
        ? Math.max(cycleStart, planStart)
        : cycleStart;
    // 套餐要等 Claude Code 刷新账户资料才上报，上游往往更早已按新套餐重新计数。
    // 观察到变化前、上一次套餐观察后的最后一次重新计数就是新套餐的起点，
    // 从这里起算才能保留清零读数，使百分比与费用都从真实起点累计。
    if (plan?.changed && boundary > cycleStart) {
      const lead = stableReadings(
        readingsBetween(
          cycleReset,
          Math.max(cycleStart, priorPlanStart),
          boundary,
        ),
      );
      const restart = lead.readings[0];
      if (lead.rebased && restart && restart.at < boundary)
        boundary = restart.at;
    }
    const observations = readingsBetween(cycleReset, boundary, until).map(
      ({ percent, sampledAt }) => ({ percent, sampledAt }),
    );
    const stable = stableReadings(observations);
    const estimate = estimationReadings(observations, boundary > cycleStart);
    return {
      observations: stable.readings,
      estimateObservations: estimate.readings,
      rebased: stable.rebased || boundary > cycleStart,
    };
  };
  // 展示的百分比同样忽略过时回落，避免进度在相邻两个值之间来回跳。
  const displayPercent =
    known &&
    !expired &&
    fact.percent !== null &&
    fact.percent >= 0 &&
    !options.allowPercentDrop
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
    periodCacheRate: periodCharges?.cacheRate ?? null,
    estimate: {
      usd: null,
      credits: null,
      deltaPercent: null,
      // 停用估值的窗口（Command Code）不会给出估值，周期未知也报 percent-unavailable，
      // 不让页面误以为补上周期就能估算；已过期仍报 expired。
      reason: expired
        ? "expired"
        : !known && !options.disableEstimate
          ? "window-unknown"
          : "percent-unavailable",
    },
  };
  if (
    !known ||
    expired ||
    fact.percent === null ||
    fact.percent < 0 ||
    fact.window === "five-hour" ||
    options.disableEstimate
  )
    return result;
  const estimateCycle = (cycleReset: number, until: number) => {
    const cycleStart = cycleReset - duration;
    const readings = cycleReadings(cycleReset, until);
    const rebased = readings.rebased;
    const observations = readings.estimateObservations.filter(
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
    // 上游百分比为四舍五入整数。重新起算的基准点落在平台期中段时，相对百分比的取整偏差无法确定，
    // 不做校正；基准点是清零后的 0%，相对百分比就是上游读数，仍按首次到达校正。
    const roundedPercent =
      options.roundedPercent !== false && (!baseline || baseline.percent === 0);
    const segments = estimateQuotaSegments(
      estimateObservations,
      estimateRead,
      roundedPercent,
    );
    const rough = roughQuotaEstimate(
      estimateObservations,
      estimateRead,
      cycleReset === reset ? 0 : 5,
      roundedPercent,
    );
    return { segments, rough, observations, rebased };
  };
  const current = estimateCycle(reset, sampled);
  // 只借用紧邻的上一周期；缺少上一周期或长时间停用后，不沿用久远额度。
  // Google 与 Codex 提前重置后从重置时刻重新起算整窗，被截断的上一周期原定重置晚于本周期起点，
  // 因此按本周期起点前最后一个有用量的周期认定，而不是按原定重置时间。Google 在 0% 未使用时
  // 不开始计时，每次读数的重置时间都随采样后移，这些只有 0% 的周期不算上一周期。
  // 紧邻周期用量不足以估算时不再向更早周期借用，旧周期的模型组合和套餐可能已不同。
  const previousReset = sameSource.reduce(
    (latestReset, { sample, at, cycle }) =>
      cycle > start - duration &&
      cycle < reset &&
      cycle > latestReset &&
      sample.percent !== null &&
      sample.percent > 0 &&
      at < start &&
      at < cycle
        ? cycle
        : latestReset,
    -Infinity,
  );
  // 上一周期可能被提前重置截断，读数和费用都只取到本周期起点之前，不混入本周期消费。
  const previousEnd = Math.min(previousReset, start - 1);
  // 只有当前已知套餐区间内的历史才有资格参考，未知和旧版本快照不能证明套餐相同。
  const previous =
    plan?.plan &&
    Number.isFinite(previousReset) &&
    previousEnd > planStart &&
    !current.rebased
      ? estimateCycle(previousReset, previousEnd)
      : null;
  const methods: NonNullable<QuotaView["estimate"]["methods"]> = {
    usd: null,
    credits: null,
  };
  for (const unit of ["usd", "credits"] as const) {
    const segments = current.segments[unit];
    const rough = current.rough[unit];
    const currentAmount = segments ?? rough;
    // 历史单点也可能很粗糙，至少已有 5% 的有效观测才用于下一周期。
    const prior = previous?.segments[unit] ?? previous?.rough[unit];
    if (prior !== null && prior !== undefined) {
      // 本周期每 1% 花费在个位数百分比时噪声很大，2% 以内完全沿用上一周期；
      // 之后每用 1 个百分点本周期权重增加 10%，用到 12% 起完全按本周期，粗估同样参与混合。
      // 进度取最新读数而不是首尾跨度，Google 在 0% 时不留读数，首条读数可能已是数个百分点。
      const weight = Math.min(1, Math.max(0, ((result.percent ?? 0) - 2) / 10));
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
  // 上面得到的是按每 1% 花费外推的整周价值，只用来估计剩余部分。已花金额确定，
  // 剩余比例越小估值越接近已花，用满时正好相等。套餐中途变化时已花包含变化前消费，该周期估值偏高。
  const remaining = new Decimal(100)
    .sub(Math.min(Math.max(result.percent ?? 0, 0), 100))
    .div(100);
  for (const unit of ["usd", "credits"] as const) {
    const quota = result.estimate[unit];
    const spent = unit === "usd" ? result.periodUsd : result.periodCredits;
    result.estimate[unit] =
      quota === null || spent === null
        ? null
        : new Decimal(spent).add(new Decimal(quota).mul(remaining)).toString();
    if (result.estimate[unit] === null) methods[unit] = null;
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

/**
 * 返回账户最新的额外 Credits 余额快照（例如 Codex 订阅额度耗尽后可继续扣减的余额）。
 * 排序规则与 quotaView 一致；最新采样明确表示无可用余额（hasCredits=false 且非不限量）时返回 null。
 */
export function accountCreditsView(
  history: readonly CollectedQuota[],
): AccountCredits | null {
  let latest: {
    credits: NonNullable<QuotaFact["credits"]>;
    sampledAt: string | null;
    order: number;
  } | null = null;
  for (const row of history) {
    if (row.fact.window !== "credits" || !row.fact.credits) continue;
    const order = Date.parse(row.fact.sampledAt ?? row.collectedAt);
    if (!Number.isFinite(order)) continue;
    if (!latest || order >= latest.order) {
      latest = {
        credits: row.fact.credits,
        sampledAt: row.fact.sampledAt,
        order,
      };
    }
  }
  if (!latest) return null;
  const { hasCredits, unlimited, balance } = latest.credits;
  if (!hasCredits && !unlimited) return null;
  return {
    hasCredits,
    unlimited,
    balance: unlimited ? null : balance,
    sampledAt: latest.sampledAt,
  };
}
