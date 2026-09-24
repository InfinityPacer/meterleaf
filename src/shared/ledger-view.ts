import type {
  AccountLifetime,
  Granularity,
  LedgerRecord,
  LedgerSnapshot,
  ReportFilter,
  ReportUnit,
  UsdBasis,
} from "./report";
import {
  aggregateReport,
  bucketTime,
  filterRecords,
  isKnownNumber,
  numericAmount,
  series,
  summarize,
  tokenFieldSummary,
  type MetricSummary,
  type ReportDimension,
} from "../web/lib/report";

export type { MetricSummary, ReportDimension } from "../web/lib/report";

export interface ViewQuery {
  filter: ReportFilter;
  unit: ReportUnit;
  granularity: Granularity;
  dimension: ReportDimension;
  page: number;
  pageSize: number;
  sort: string;
  desc: boolean;
}

/**
 * 全历史累计独立于当前日期、账户、模型和分页筛选；金额保持精确十进制文本。
 * token 桶按已知值分别累加，incomplete 记录缺少至少一个 token 桶的行数；
 * amount incomplete 记录对应金额不可用的行数，count 始终是全历史请求数。
 */
/**
 * /api/view 以 202 返回：报表首次计算、账本被替换或旧索引无法沿用时正在后台建立，
 * 暂时没有结果。客户端稍后重读，不应展示为失败或补零。
 */
export interface ReportBuilding {
  status: "building";
  /** 本次后台计算开始的时间。 */
  since: string;
}

export interface LifetimeTotals {
  asOf: string;
  from: string | null;
  to: string | null;
  count: number;
  tokens: {
    input: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    total: number | null;
    incomplete: number;
  };
  usd: string | null;
  apiUsd: string | null;
  subscriptionUsd: string | null;
  credits: string | null;
  incomplete: {
    usd: number;
    apiUsd: number;
    subscriptionUsd: number;
    credits: number;
  };
  usdBasis: UsdBasis;
  priceVersion: string;
}

export interface LedgerView extends Omit<LedgerSnapshot, "records"> {
  /** 两套美元口径共享采样时刻；每套保留独立的金额、额度与排序后分页。 */
  usdVariants?: Record<UsdBasis, UsdViewVariant>;
  /** 刷新失败时数据仍是最近成功快照，状态不应令前端丢弃可用账本。 */
  reportStatus?: {
    refreshing: boolean;
    /** 报表索引正在后台重建，当前结果来自重建前的索引，可能按旧价格表计算。 */
    rebuilding?: boolean;
    lastError: { kind: string; code?: string } | null;
  };
  records: LedgerRecord[];
  view: {
    /** 单位只决定展示；同一范围的三种聚合同时返回，切换不再查询账本。 */
    units: Record<ReportUnit, UnitView>;
    models: string[];
    count: number;
    totalSummary: MetricSummary;
    usdSummary: MetricSummary;
    creditsSummary: MetricSummary;
    tokenSummary: MetricSummary;
    previousUsdSummary: MetricSummary;
    cacheSummary: MetricSummary;
    cacheRate: number | null;
    completeCacheCount: number;
    unknownTier: number;
    breakdown: {
      model: string;
      summary: MetricSummary;
      count: number;
    }[];
    points: ReturnType<typeof series>;
    reportRows: ReturnType<typeof aggregateReport>;
    /** 当前报表筛选集按账户聚合；无请求的已知账户保留零值。 */
    accountUsage?: Record<string, AccountLifetime>;
    page: number;
    pageSize: number;
  };
  /** worker 维护的全历史累计；演示或无索引来源可以暂不提供。 */
  lifetimeTotals?: LifetimeTotals;
}

export type UsdViewVariant = Pick<
  LedgerView,
  "accounts" | "records" | "view" | "lifetimeTotals"
>;

/** 只封装有界展示结果，不递归复制 variants 或带入原始账单集合。 */
export function withUsdVariants(
  subscription: LedgerView,
  api: LedgerView,
  basis: UsdBasis,
): LedgerView {
  const pick = (value: LedgerView): UsdViewVariant => ({
    accounts: value.accounts,
    records: value.records,
    view: value.view,
    ...(value.lifetimeTotals ? { lifetimeTotals: value.lifetimeTotals } : {}),
  });
  return {
    ...(basis === "api" ? api : subscription),
    usdBasis: basis,
    usdVariants: { subscription: pick(subscription), api: pick(api) },
  };
}

/** 单位和美元口径均只选择已返回的展示结果；旧响应缺少分支时不伪造金额。 */
export function selectUsdView(value: LedgerView, basis: UsdBasis): LedgerView {
  const variant = value.usdVariants?.[basis];
  return variant ? { ...value, ...variant, usdBasis: basis } : value;
}

export interface UnitView {
  totalSummary: MetricSummary;
  breakdown: { model: string; summary: MetricSummary; count: number }[];
  points: ReturnType<typeof series>;
}

type SortKey =
  | "occurredAt"
  | "model"
  | "accountId"
  | "input"
  | "cacheRead"
  | "output"
  | "usd";
type SortValue = number | string | null;

const sortKeys = new Set<SortKey>([
  "occurredAt",
  "model",
  "accountId",
  "input",
  "cacheRead",
  "output",
  "usd",
]);

function inputValue(row: LedgerRecord) {
  const values = [row.input, row.cacheRead, row.cacheWrite];
  return values.every(isKnownNumber)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

function sortValue(row: LedgerRecord, key: SortKey): SortValue {
  switch (key) {
    case "occurredAt":
      return Date.parse(row.occurredAt);
    case "model":
    case "accountId":
      return row[key];
    case "input":
      return inputValue(row);
    case "cacheRead":
    case "output":
      return row[key];
    case "usd":
      return numericAmount(row.usd);
  }
}

function compareValues(left: SortValue, right: SortValue) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number")
    return left < right ? -1 : 1;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : 1;
}

function sortedRecords(
  records: LedgerRecord[],
  requestedSort: string,
  requestedDesc: boolean,
) {
  const isDefault = requestedSort === "";
  const key: SortKey = isDefault
    ? "occurredAt"
    : sortKeys.has(requestedSort as SortKey)
      ? (requestedSort as SortKey)
      : "occurredAt";
  const desc = isDefault ? true : requestedDesc;
  const decorated = records.map((record, index) => ({
    record,
    index,
    value: sortValue(record, key),
  }));
  decorated.sort((left, right) => {
    const result = compareValues(left.value, right.value);
    if (result) return desc ? -result : result;
    const idResult =
      left.record.id < right.record.id
        ? -1
        : left.record.id > right.record.id
          ? 1
          : 0;
    return idResult || left.index - right.index;
  });
  return decorated.map(({ record }) => record);
}

/** 按模型和时间各分组一次，生成有界的多指标结果，不向前端发送原始分组记录。 */
function unitViews(
  records: LedgerRecord[],
  models: string[],
  granularity: Granularity,
  totals: Record<ReportUnit, MetricSummary>,
) {
  const grouped = new Map<string, LedgerRecord[]>();
  const buckets = new Map<number, LedgerRecord[]>();
  for (const row of records) {
    const rows = grouped.get(row.model) ?? [];
    rows.push(row);
    grouped.set(row.model, rows);
    const at = bucketTime(row.occurredAt, granularity);
    const bucket = buckets.get(at) ?? [];
    bucket.push(row);
    buckets.set(at, bucket);
  }
  const result = {} as Record<ReportUnit, UnitView>;
  const orderedBuckets = [...buckets].sort(([left], [right]) => left - right);
  for (const unit of ["usd", "credits", "tokens"] as const) {
    const breakdown = models
      .map((model) => {
        const rows = grouped.get(model) ?? [];
        return { model, summary: summarize(rows, unit), count: rows.length };
      })
      .sort(
        (left, right) =>
          (right.summary.hasKnown
            ? right.summary.value
            : Number.NEGATIVE_INFINITY) -
          (left.summary.hasKnown
            ? left.summary.value
            : Number.NEGATIVE_INFINITY),
      );
    result[unit] = {
      totalSummary: totals[unit],
      breakdown,
      points: orderedBuckets.map(([at, rows]) => {
        const summary = summarize(rows, unit);
        return {
          at,
          value: summary.hasKnown ? summary.value : null,
          count: rows.length,
          incomplete: summary.incompleteRows,
        };
      }),
    };
  }
  return result;
}

function emptyAccountLifetime(): AccountLifetime {
  return {
    count: 0,
    tokens: 0,
    usd: "0",
    incompleteTokens: 0,
    incompleteUsd: 0,
  };
}

function accountUsageFromRows(
  accounts: readonly LedgerSnapshot["accounts"][number][],
  rows: ReturnType<typeof aggregateReport>,
): Record<string, AccountLifetime> {
  const usage = new Map<string, AccountLifetime>(
    accounts.map((account) => [account.id, emptyAccountLifetime()]),
  );
  for (const row of rows) {
    usage.set(row.key, {
      count: row.requests,
      tokens: row.tokens,
      usd: row.usd,
      incompleteTokens: row.incompleteTokens,
      incompleteUsd: row.unpricedUsd,
    });
  }
  return Object.fromEntries(usage);
}

/** 统计基于完整筛选集，明细仅传输当前排序后的单页记录。 */
export function createLedgerView(
  snapshot: LedgerSnapshot,
  query: ViewQuery,
): LedgerView {
  const current = filterRecords(snapshot.records, query.filter, snapshot.asOf);
  const previous = filterRecords(
    snapshot.records,
    query.filter,
    snapshot.asOf,
    true,
  );
  const models = [...new Set(snapshot.records.map((row) => row.model))].sort(
    (left, right) => left.localeCompare(right),
  );
  const completeCacheRows = current.filter((row) =>
    [row.input, row.cacheRead, row.cacheWrite].every(isKnownNumber),
  );
  const allInput = completeCacheRows.reduce(
    (total, row) => total + row.input! + row.cacheRead! + row.cacheWrite!,
    0,
  );
  const cache = completeCacheRows.reduce(
    (total, row) => total + row.cacheRead!,
    0,
  );
  const page = Math.max(0, Math.trunc(query.page));
  const pageSize = Math.max(0, Math.trunc(query.pageSize));
  const ordered = sortedRecords(current, query.sort, query.desc);
  const records = pageSize
    ? ordered.slice(page * pageSize, (page + 1) * pageSize)
    : [];
  const totals = {
    usd: summarize(current, "usd"),
    credits: summarize(current, "credits"),
    tokens: summarize(current, "tokens"),
  };
  const units = unitViews(current, models, query.granularity, totals);
  const reportRows = aggregateReport(current, query.dimension);
  const accountRows =
    query.dimension === "account"
      ? reportRows
      : aggregateReport(current, "account");

  return {
    ...snapshot,
    records,
    view: {
      units,
      models,
      count: current.length,
      totalSummary: totals[query.unit],
      usdSummary: totals.usd,
      creditsSummary: totals.credits,
      tokenSummary: totals.tokens,
      previousUsdSummary: summarize(previous, "usd"),
      cacheSummary: tokenFieldSummary(current, "cacheRead"),
      cacheRate: allInput ? (cache / allInput) * 100 : null,
      completeCacheCount: completeCacheRows.length,
      unknownTier: current.filter((row) => row.tier === "unknown").length,
      breakdown: units[query.unit].breakdown,
      points: units[query.unit].points,
      reportRows,
      accountUsage: accountUsageFromRows(snapshot.accounts, accountRows),
      page,
      pageSize,
    },
  };
}
