import Decimal from "decimal.js";
import type { QuotaFact } from "./connector";
import type { UsageFact } from "./connector";
import type { Valuation } from "./pricing";

export interface PricedUsage {
  fact: UsageFact;
  valuation: Valuation;
}
export interface CollectedQuota {
  fact: QuotaFact;
  collectedAt: string;
}

export type QuotaChargeReader = (
  startInclusive: string,
  endInclusive: string,
) => { usd: string | null; credits: string | null; count?: number; tokens?: number | null };

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
    reason:
      | "eligible"
      | "window-unknown"
      | "expired"
      | "percent-unavailable"
      | "unpriced";
  };
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
  return (startInclusive, endInclusive) => {
    const start = Date.parse(startInclusive);
    const end = Date.parse(endInclusive);
    const selected = rows.filter((row) => {
      const occurredAt = Date.parse(row.fact.occurredAt);
      return occurredAt >= start && occurredAt <= end;
    });
    return {
      usd: sumCharges(selected, "usd"),
      credits: sumCharges(selected, "credits"),
      count: selected.length,
      tokens: selected.some(row => (["input", "cacheRead", "cacheWrite", "output"] as const).some(field => row.fact.tokens[field] === null))
        ? null
        : selected.reduce((total, row) => total + (row.fact.tokens.input ?? 0) + (row.fact.tokens.cacheRead ?? 0) + (row.fact.tokens.cacheWrite ?? 0) + (row.fact.tokens.output ?? 0), 0),
    };
  };
}

function estimateCharge(amount: string | null, percent: number): string | null {
  if (amount === null) return null;
  const value = new Decimal(amount);
  return value.gt(0) ? value.mul(100).div(percent).toString() : null;
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
  const reset = fact.resetsAt ? Date.parse(fact.resetsAt) : NaN;
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
  const readCharges =
    typeof rowsOrSumReader === "function"
      ? rowsOrSumReader
      : rowsChargeReader(rowsOrSumReader);
  const periodCharges =
    known && !expired
      ? start <= time
        ? readCharges(startsAt!, now)
        : { usd: "0", credits: "0", count: 0, tokens: 0 }
      : null;
  const result: QuotaView = {
    window: fact.window,
    percent: expired ? 0 : fact.percent,
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
    fact.percent <= 0 ||
    fact.window !== "seven-day"
  )
    return result;
  // 单点按本周期累计消费外推；分子截止到百分比的采样时刻，不能混入采样后的费用。
  const sampleCharges =
    sampled === time
      ? periodCharges!
      : sampled >= start
        ? readCharges(startsAt!, fact.sampledAt!)
        : { usd: "0", credits: "0" };
  // 无本地消耗或缺价时不输出零额度；外部入口消费无法反推本地账单。
  result.estimate.usd = estimateCharge(sampleCharges.usd, fact.percent);
  result.estimate.credits = estimateCharge(sampleCharges.credits, fact.percent);
  result.estimate.reason =
    result.estimate.usd !== null || result.estimate.credits !== null
      ? "eligible"
      : "unpriced";
  return result;
}
