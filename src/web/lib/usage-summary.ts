import type { LedgerView, LifetimeTotals } from "../../shared/ledger-view";
import { shanghaiDate } from "../../shared/date-range";
import type { Granularity, ReportUnit } from "../../shared/report";
import type { UsageSummaryData } from "../components/UsageSummary";
import { percentChange } from "../components/UsageSummary";
import { numericAmount } from "./report";

const DAY_MS = 86_400_000;

/** 历史至今覆盖的上海自然日数，含首尾两天。 */
export function spanDays(firstAt: string, asOf: string) {
  const from = Date.parse(`${shanghaiDate(firstAt)}T00:00:00Z`);
  const to = Date.parse(`${shanghaiDate(asOf)}T00:00:00Z`);
  return Math.max(1, Math.round((to - from) / DAY_MS) + 1);
}

function inputSideRate(
  input: number | null,
  cacheRead: number | null,
  cacheWrite: number | null,
) {
  if (input === null || cacheRead === null || cacheWrite === null) return null;
  const total = input + cacheRead + cacheWrite;
  return total > 0 ? (cacheRead / total) * 100 : null;
}

function perDay(value: number | null, days: number | null) {
  return value === null || !days ? null : value / days;
}

/** 首页历史至今直接读全历史累计，不等待区间报表，也不受筛选影响。 */
export function summaryFromLifetime(
  totals: LifetimeTotals,
  usdNote: string,
): UsageSummaryData {
  const { input, cacheRead, cacheWrite, output, total } = totals.tokens;
  const usd = numericAmount(totals.usd);
  const credits = numericAmount(totals.credits);
  const days = totals.from ? spanDays(totals.from, totals.asOf) : null;
  return {
    tokens: total,
    usd,
    credits: credits ? credits : null,
    requests: totals.count,
    cacheRate: inputSideRate(input, cacheRead, cacheWrite),
    composition: { input, cacheRead, cacheWrite, output },
    change: null,
    since: totals.from,
    dailyUsd: perDay(usd, days),
    dailyTokens: perDay(total, days),
    usdNote,
  };
}

/** 报表区间摘要；构成由完整分组行求和，与表格使用同一份聚合。 */
export function summaryFromView(
  view: LedgerView["view"],
  usdNote: string,
  all: { since: string | null; asOf: string } | null,
): UsageSummaryData {
  const field = (key: "input" | "cacheRead" | "cacheWrite" | "output") => {
    let known = false;
    let sum = 0;
    for (const row of view.reportRows) {
      const value = row[key];
      if (value === null) continue;
      known = true;
      sum += value;
    }
    return known ? sum : null;
  };
  const tokens = view.tokenSummary.hasKnown ? view.tokenSummary.value : null;
  const usd = view.usdSummary.hasKnown ? view.usdSummary.value : null;
  const days = all?.since ? spanDays(all.since, all.asOf) : null;
  return {
    tokens,
    usd,
    credits:
      view.creditsSummary.hasKnown && view.creditsSummary.value
        ? view.creditsSummary.value
        : null,
    requests: view.count,
    cacheRate: view.cacheRate,
    composition: {
      input: field("input"),
      cacheRead: field("cacheRead"),
      cacheWrite: field("cacheWrite"),
      output: field("output"),
    },
    change: all
      ? null
      : {
          tokens: percentChange(
            tokens,
            view.previousTokenSummary?.hasKnown
              ? view.previousTokenSummary.value
              : null,
          ),
          usd: percentChange(
            usd,
            view.previousUsdSummary.hasKnown
              ? view.previousUsdSummary.value
              : null,
          ),
          requests: percentChange(view.count, view.previousCount),
        },
    since: all?.since ?? null,
    dailyUsd: perDay(usd, days),
    dailyTokens: perDay(tokens, days),
    usdNote,
  };
}

export interface TrendInsights {
  peak: { at: number; value: number } | null;
  activeBuckets: number;
  perRequest: number | null;
}

/**
 * 趋势点只包含有请求的时间桶，所以活跃数就是点数；峰值取当前单位的最大已知值。
 * 单次平均用区间总量除以请求数，未知金额不计入分子也不补零。
 */
export function trendInsights(
  points: LedgerView["view"]["points"],
  total: number | null,
  count: number,
): TrendInsights {
  let peak: TrendInsights["peak"] = null;
  let activeBuckets = 0;
  for (const point of points) {
    if (point.count > 0) activeBuckets += 1;
    if (point.value === null || !Number.isFinite(point.value)) continue;
    if (!peak || point.value > peak.value)
      peak = { at: point.at, value: point.value };
  }
  return {
    peak,
    activeBuckets,
    perRequest: total !== null && count > 0 ? total / count : null,
  };
}

export const bucketNames: Record<Granularity, string> = {
  hour: "小时",
  day: "天",
  week: "周",
};

export const unitNames: Record<ReportUnit, string> = {
  usd: "费用",
  credits: "Credits",
  tokens: "Tokens",
};
