import Decimal from "decimal.js";
import { reportBounds } from "../../shared/date-range";
import type {
  Granularity,
  LedgerRecord,
  ReportFilter,
  ReportUnit,
  UsdBasis,
} from "../../shared/report";

/** 内置价格表中的模型使用固定且互不相同的颜色，跨图表和页面保持一致。 */
export const modelColors: Record<string, string> = {
  "gpt-6-astra": "#3779d5",
  "gpt-6-sol": "#4f8fe0",
  "gpt-6-luna": "#7ba7e8",
  "gpt-5.6-sol": "#15998c",
  "gpt-5.6-terra": "#bb8b42",
  "gpt-5.6-luna": "#9b6fa5",
  "gpt-5.4": "#5f7a91",
  "gpt-5.4-mini": "#8a9bab",
  "claude-opus-5-5": "#d9704f",
  "claude-opus-5": "#c84c61",
  "claude-opus-4-8": "#b0508f",
  "claude-fable-5-1": "#e0a13a",
  "claude-sonnet-5": "#2aa3c7",
  "claude-haiku-4-5": "#5a9e4b",
  "claude-haiku-4-5-20251001": "#5a9e4b",
};
const fallbackModelColors = [
  "#3779d5",
  "#15998c",
  "#bb8b42",
  "#9b6fa5",
  "#d9704f",
  "#c84c61",
  "#5f7a91",
  "#5a9e4b",
  "#2aa3c7",
  "#b0508f",
];
const tokenFields = ["input", "cacheRead", "cacheWrite", "output"] as const;
export type TokenField = (typeof tokenFields)[number];

export interface MetricSummary {
  value: number;
  hasKnown: boolean;
  knownRows: number;
  incompleteRows: number;
}

export function isKnownNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/** 颜色按模型名称稳定分配，未知模型也必须有可见的图例颜色。 */
export function modelColor(model: string) {
  const known = modelColors[model];
  if (known) return known;
  let hash = 0;
  for (const character of model)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return fallbackModelColors[Math.abs(hash) % fallbackModelColors.length]!;
}

export function modelLabel(model: string) {
  return model
    .replace("gpt-", "GPT ")
    .replace(
      /-(astra|sol|terra|luna)$/,
      (_, name: string) => ` ${name[0]!.toUpperCase()}${name.slice(1)}`,
    );
}

export function compact(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

export function amount(value: number | null, unit: ReportUnit) {
  if (value === null || !Number.isFinite(value)) return "N/A";
  if (unit === "usd")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  return unit === "tokens"
    ? compact(value)
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
        value,
      );
}

function decimalValue(value: string | null) {
  // Decimal 的字符串输出可使用科学计数法；很小的已知金额不能因此被标记为未知。
  if (value === null || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  const amount = new Decimal(value);
  return amount.isFinite() && Number.isFinite(amount.toNumber()) ? amount : null;
}

/** 返回字符串金额的数值表示；未知或非法金额保持未知，不能变成 NaN。 */
export function numericAmount(value: string | null) {
  const parsed = decimalValue(value);
  if (!parsed) return null;
  const number = parsed.toNumber();
  return Number.isFinite(number) ? number : null;
}

export function knownTokenValue(row: LedgerRecord) {
  return tokenFields.reduce(
    (total, field) => total + (isKnownNumber(row[field]) ? row[field] : 0),
    0,
  );
}

export function recordValue(row: LedgerRecord, unit: ReportUnit) {
  if (unit === "tokens") {
    return tokenFields.every((field) => isKnownNumber(row[field]))
      ? knownTokenValue(row)
      : null;
  }
  return numericAmount(row[unit]);
}

export function tokenFieldSummary(
  records: LedgerRecord[],
  field: TokenField,
): MetricSummary {
  let value = 0;
  let hasKnown = false;
  let knownRows = 0;
  for (const row of records) {
    if (!isKnownNumber(row[field])) continue;
    value += row[field];
    hasKnown = true;
    knownRows += 1;
  }
  return {
    value,
    hasKnown,
    knownRows,
    incompleteRows: records.length - knownRows,
  };
}

/** 汇总只累加已知值，完整性计数保留在数据中，不影响已有金额的展示。 */
export function summarize(
  records: LedgerRecord[],
  unit: ReportUnit,
): MetricSummary {
  if (unit === "tokens") {
    let value = 0;
    let hasKnown = false;
    let knownRows = 0;
    let incompleteRows = 0;
    for (const row of records) {
      const known = tokenFields.filter((field) => isKnownNumber(row[field]));
      if (known.length !== tokenFields.length) incompleteRows += 1;
      if (!known.length) continue;
      knownRows += 1;
      hasKnown = true;
      value += known.reduce((total, field) => total + row[field]!, 0);
    }
    return { value, hasKnown, knownRows, incompleteRows };
  }

  let value = new Decimal(0);
  let hasKnown = false;
  let knownRows = 0;
  for (const row of records) {
    const parsed = decimalValue(row[unit]);
    if (!parsed) continue;
    value = value.add(parsed);
    hasKnown = true;
    knownRows += 1;
  }
  return {
    value: value.toNumber(),
    hasKnown,
    knownRows,
    incompleteRows: records.length - knownRows,
  };
}

export function sum(records: LedgerRecord[], unit: ReportUnit) {
  return summarize(records, unit).value;
}

/** 所有报表与导出使用同一时间和筛选口径，结束点包含采样时刻。 */
export function filterRecords(
  records: LedgerRecord[],
  filter: ReportFilter,
  asOf: string,
  previous = false,
) {
  const { start, end, endInclusive } = reportBounds(filter, asOf, previous);
  const needle = filter.search.trim().toLowerCase();
  return records.filter((row) => {
    const time = Date.parse(row.occurredAt);
    return (
      (endInclusive
        ? time > start && time <= end
        : time >= start && time < end) &&
      (filter.model === "all" || row.model === filter.model) &&
      (filter.account === "all" || row.accountId === filter.account) &&
      (!needle ||
        `${row.id} ${row.model} ${row.accountId}`
          .toLowerCase()
          .includes(needle))
    );
  });
}

/** 上海时区没有夏令时；自然周从周一开始，不与订阅七天窗口混用。 */
export function bucketTime(timestamp: string, granularity: Granularity) {
  const shifted = new Date(Date.parse(timestamp) + 8 * 3600000);
  if (granularity === "hour") shifted.setUTCMinutes(0, 0, 0);
  else {
    shifted.setUTCHours(0, 0, 0, 0);
    if (granularity === "week")
      shifted.setUTCDate(
        shifted.getUTCDate() - ((shifted.getUTCDay() + 6) % 7),
      );
  }
  return shifted.getTime() - 8 * 3600000;
}

export function series(
  records: LedgerRecord[],
  granularity: Granularity,
  unit: ReportUnit,
) {
  const buckets = new Map<number, LedgerRecord[]>();
  for (const row of records) {
    const key = bucketTime(row.occurredAt, granularity);
    const entries = buckets.get(key) ?? [];
    entries.push(row);
    buckets.set(key, entries);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([at, rows]) => {
      const summary = summarize(rows, unit);
      return {
        at,
        value: summary.hasKnown ? summary.value : null,
        count: rows.length,
        incomplete: summary.incompleteRows,
      };
    });
}

export function localTime(
  iso: string | number | null | undefined,
  options: Intl.DateTimeFormatOptions = {},
) {
  if (iso === null || iso === undefined) return "未知";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    ...options,
  }).format(date);
}

/** 报表维度不改变筛选范围；时间桶使用与趋势图相同的上海时区边界。 */
export type ReportDimension = Granularity | "model" | "account";

export function aggregateReport(
  records: LedgerRecord[],
  dimension: ReportDimension,
) {
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of records) {
    const key =
      dimension === "model"
        ? record.model
        : dimension === "account"
          ? record.accountId
          : new Date(bucketTime(record.occurredAt, dimension)).toISOString();
    const rows = groups.get(key) ?? [];
    rows.push(record);
    groups.set(key, rows);
  }
  const sumTokenFieldValue = (rows: LedgerRecord[], field: TokenField) => {
    const summary = tokenFieldSummary(rows, field);
    return summary.hasKnown ? summary.value : null;
  };
  const sumAmount = (rows: LedgerRecord[], unit: "usd" | "credits") => {
    const summary = summarize(rows, unit);
    if (!summary.hasKnown) return null;
    return rows
      .reduce(
        (total, row) => total.add(decimalValue(row[unit]) ?? 0),
        new Decimal(0),
      )
      .toString();
  };
  const sumUsdBasis = (rows: LedgerRecord[], basis: UsdBasis) => {
    const values = rows.flatMap((row) => {
      const charge =
        basis === "api"
          ? row.valuation?.apiUsd
          : row.valuation?.subscriptionUsd;
      return charge?.amount ? [charge.amount] : [];
    });
    if (!values.length) return null;
    return values
      .reduce((total, value) => total.add(new Decimal(value)), new Decimal(0))
      .toString();
  };
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => ({
      key,
      requests: rows.length,
      input: sumTokenFieldValue(rows, "input"),
      cacheRead: sumTokenFieldValue(rows, "cacheRead"),
      cacheWrite: sumTokenFieldValue(rows, "cacheWrite"),
      output: sumTokenFieldValue(rows, "output"),
      tokens: summarize(rows, "tokens").hasKnown
        ? summarize(rows, "tokens").value
        : null,
      incompleteTokens: summarize(rows, "tokens").incompleteRows,
      unpricedUsd: summarize(rows, "usd").incompleteRows,
      unpricedCredits: summarize(rows, "credits").incompleteRows,
      unknownTier: rows.filter((row) => row.tier === "unknown").length,
      // 十进制金额保留为字符串，CSV 不经过展示层的四舍五入。
      usd: sumAmount(rows, "usd"),
      apiUsd: sumUsdBasis(rows, "api"),
      subscriptionUsd: sumUsdBasis(rows, "subscription"),
      credits: sumAmount(rows, "credits"),
    }));
}

export function reportCsv(
  records: LedgerRecord[],
  dimension: ReportDimension,
  usdBasis: UsdBasis = "subscription",
) {
  return encodeCsv([
    [
      "usd_basis",
      dimension,
      "requests",
      "input",
      "cache_read",
      "cache_write",
      "output",
      "tokens",
      "usd_estimate",
      "api_usd_estimate",
      "subscription_usd_estimate",
      "credits_estimate",
      "unpriced_usd",
      "unpriced_credits",
      "incomplete_tokens",
    ],
    ...aggregateReport(records, dimension).map((row) => {
      return [
        usdBasis,
        row.key,
        row.requests,
        row.input,
        row.cacheRead,
        row.cacheWrite,
        row.output,
        row.tokens,
        row.usd,
        row.apiUsd,
        row.subscriptionUsd,
        row.credits,
        row.unpricedUsd,
        row.unpricedCredits,
        row.incompleteTokens,
      ];
    }),
  ]);
}

/** CSV 防止外部名称被电子表格解释为公式；数值仍使用未本地化十进制文本。 */
function encodeCsv(rows: (string | number | null)[][]) {
  const escape = (value: string | number | null) => {
    if (value === null) return '""';
    let text = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text))
      text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n");
}

export function csv(
  records: LedgerRecord[],
  usdBasis: UsdBasis = "subscription",
) {
  const header = [
    "usd_basis",
    "id",
    "occurred_at",
    "account",
    "model",
    "input",
    "cache_read",
    "cache_write",
    "output",
    "usd_estimate",
    "api_usd_estimate",
    "subscription_usd_estimate",
    "credits_estimate",
    "tier",
    "quality",
    "price_version",
    "source_id",
    "source_record_id",
    "gateway_cost",
    "gateway_billed",
  ];
  return encodeCsv([
    header,
    ...records.map((r) => [
      usdBasis,
      r.id,
      r.occurredAt,
      r.accountId,
      r.model,
      r.input,
      r.cacheRead,
      r.cacheWrite,
      r.output,
      r.usd,
      r.valuation?.apiUsd.amount ?? (usdBasis === "api" ? r.usd : null),
      r.valuation?.subscriptionUsd.amount ??
        (usdBasis === "subscription" ? r.usd : null),
      r.credits,
      r.tier,
      r.quality,
      r.priceVersion,
      r.sourceId ?? null,
      r.sourceRecordId ?? null,
      r.gatewayCost ?? null,
      r.gatewayBilled ?? null,
    ]),
  ]);
}

/**
 * 没有有效额度窗口时的说明。快照过期仍给出最近一次采样时刻，让人判断数据
 * 停在哪里；从未采样过则说明上游尚未提供，不暗示存在旧值。
 */
export function quotaUnavailableNote(account: { sampledAt: string | null }) {
  return account.sampledAt
    ? `额度快照已过期，最近一次采样 ${localTime(account.sampledAt, { hour: "2-digit", minute: "2-digit", hour12: false })}`
    : "上游暂未提供额度";
}
