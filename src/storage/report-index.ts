import { Database } from "bun:sqlite";
import {
  DATABASE_SCHEMA_REVISION,
  assertReadableSchema,
  migrateSchema,
} from "./schema";
import Decimal from "decimal.js";
import { reportBounds } from "../shared/date-range";
import type { LedgerView, ViewQuery } from "../shared/ledger-view";
import type {
  AccountLifetime,
  LedgerRecord,
  LedgerSnapshot,
} from "../shared/report";
import {
  bucketTime,
  type MetricSummary,
  type ReportDimension,
} from "../web/lib/report";
import type { UsdBasis } from "../domain/pricing";

const HOUR_MS = 3_600_000;
const TOKEN_FIELDS = ["input", "cacheRead", "cacheWrite", "output"] as const;
const AMOUNT_PATTERN = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const SORT_KEYS = new Set([
  "occurredAt",
  "model",
  "accountId",
  "input",
  "cacheRead",
  "output",
  "usd",
]);

type SqlParam = string | number | null;

interface ReportBounds {
  start: number;
  end: number;
  startInclusive: boolean;
  endInclusive: boolean;
}

interface StoredRecord {
  id: string;
  occurredAt: string;
  occurredMs: number;
  hourStart: number;
  dayStart: number;
  weekStart: number;
  accountId: string;
  model: string;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  inputTotal: number | null;
  apiUsd: string | null;
  subscriptionUsd: string | null;
  credits: string | null;
  apiSort: string | null;
  subscriptionSort: string | null;
  tier: LedgerRecord["tier"];
  payload: string;
}

interface MetricSqlRow {
  hour_start: number;
  day_start: number;
  week_start: number;
  account_id: string;
  model: string;
  input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
  input_total: number | null;
  api_usd: string | null;
  subscription_usd: string | null;
  credits: string | null;
  tier: string;
}

interface HourSqlRow {
  hour_start: number;
  day_start: number;
  week_start: number;
  account_id: string;
  model: string;
  requests: number;
  input_sum: number;
  input_known: number;
  cache_read_sum: number;
  cache_read_known: number;
  cache_write_sum: number;
  cache_write_known: number;
  output_sum: number;
  output_known: number;
  token_sum: number;
  token_known: number;
  token_incomplete: number;
  complete_cache_count: number;
  complete_cache_input_sum: number;
  complete_cache_read_sum: number;
  unknown_tier: number;
  api_usd_sum: string;
  api_usd_known: number;
  subscription_usd_sum: string;
  subscription_usd_known: number;
  credits_sum: string;
  credits_known: number;
}

interface PageSqlRow {
  payload: string;
}

interface MutableNumberSummary {
  value: number;
  knownRows: number;
}

interface MutableAmountSummary {
  value: Decimal;
  knownRows: number;
}

interface Aggregate {
  count: number;
  input: MutableNumberSummary;
  cacheRead: MutableNumberSummary;
  cacheWrite: MutableNumberSummary;
  output: MutableNumberSummary;
  tokenValue: number;
  tokenKnownRows: number;
  tokenIncompleteRows: number;
  completeCacheCount: number;
  completeCacheInput: number;
  completeCacheRead: number;
  unknownTier: number;
  apiUsd: MutableAmountSummary;
  subscriptionUsd: MutableAmountSummary;
  credits: MutableAmountSummary;
}

interface Contribution {
  hourStart: number;
  dayStart: number;
  weekStart: number;
  accountId: string;
  model: string;
  aggregate: Aggregate;
}

/** 报表共享准备结果；不绑定 USD 口径，也不包含按口径排序的明细页。 */
interface PreparedReport {
  snapshot: Omit<LedgerSnapshot, "records">;
  query: ViewQuery;
  currentTotal: Aggregate;
  previousTotal: Aggregate;
  currentByModel: Map<string, Aggregate>;
  currentByAccount: Map<string, Aggregate>;
  currentByPoint: Map<string, Aggregate>;
  currentByReport: Map<string, Aggregate>;
  models: string[];
}

interface FilterSql {
  clauses: string[];
  params: SqlParam[];
}

function emptyNumberSummary(): MutableNumberSummary {
  return { value: 0, knownRows: 0 };
}

function emptyAmountSummary(): MutableAmountSummary {
  return { value: new Decimal(0), knownRows: 0 };
}

function emptyAggregate(): Aggregate {
  return {
    count: 0,
    input: emptyNumberSummary(),
    cacheRead: emptyNumberSummary(),
    cacheWrite: emptyNumberSummary(),
    output: emptyNumberSummary(),
    tokenValue: 0,
    tokenKnownRows: 0,
    tokenIncompleteRows: 0,
    completeCacheCount: 0,
    completeCacheInput: 0,
    completeCacheRead: 0,
    unknownTier: 0,
    apiUsd: emptyAmountSummary(),
    subscriptionUsd: emptyAmountSummary(),
    credits: emptyAmountSummary(),
  };
}

function finiteNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function amountText(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !AMOUNT_PATTERN.test(value))
    return null;
  try {
    const amount = new Decimal(value);
    return amount.isFinite() && !amount.isNegative() ? amount.toString() : null;
  } catch {
    return null;
  }
}

/** 仅用于 SQLite 文本排序；金额本身始终以 Decimal 字符串累计。 */
function amountSortKey(value: string | null): string | null {
  const normalized = amountText(value);
  if (normalized === null) return null;
  const amount = new Decimal(normalized);
  if (amount.isZero()) return "00000000000000000000:0";
  const exponential = amount.toExponential();
  const [coefficient, exponentText] = exponential.split("e");
  const exponent = BigInt(exponentText ?? "0");
  const magnitude = exponent < 0n ? -exponent : exponent;
  const width = 20;
  const max = 10n ** BigInt(width) - 1n;
  if (magnitude > max) throw new RangeError("amount exponent is too large");
  const encodedExponent =
    exponent < 0n
      ? (max - magnitude).toString().padStart(width, "0")
      : magnitude.toString().padStart(width, "0");
  const digits = (coefficient ?? "").replace(".", "");
  return `${exponent < 0n ? "0" : "1"}${encodedExponent}:${digits}`;
}

function valueForUsd(record: LedgerRecord, basis: UsdBasis): string | null {
  return amountText(
    basis === "api"
      ? record.valuation?.apiUsd.amount
      : (record.valuation?.subscriptionUsd.amount ?? record.usd),
  );
}

function valueForCredits(record: LedgerRecord): string | null {
  return amountText(record.valuation?.credits.amount ?? record.credits);
}

function storedRecord(record: LedgerRecord): StoredRecord {
  const occurredMs = Date.parse(record.occurredAt);
  if (!Number.isFinite(occurredMs))
    throw new RangeError(`Invalid occurredAt for record ${record.id}`);
  const input = finiteNumber(record.input);
  const cacheRead = finiteNumber(record.cacheRead);
  const cacheWrite = finiteNumber(record.cacheWrite);
  const output = finiteNumber(record.output);
  const inputTotal =
    input !== null && cacheRead !== null && cacheWrite !== null
      ? input + cacheRead + cacheWrite
      : null;
  const subscriptionUsd = valueForUsd(record, "subscription");
  const apiUsd = valueForUsd(record, "api");
  const credits = valueForCredits(record);
  return {
    id: record.id,
    occurredAt: record.occurredAt,
    occurredMs,
    hourStart: bucketTime(record.occurredAt, "hour"),
    dayStart: bucketTime(record.occurredAt, "day"),
    weekStart: bucketTime(record.occurredAt, "week"),
    accountId: record.accountId,
    model: record.model,
    input,
    cacheRead,
    cacheWrite,
    output,
    inputTotal,
    apiUsd,
    subscriptionUsd,
    credits,
    apiSort: amountSortKey(apiUsd),
    subscriptionSort: amountSortKey(subscriptionUsd),
    tier: record.tier,
    payload: JSON.stringify(record),
  };
}

function recordMetric(value: StoredRecord): MetricSqlRow {
  return {
    hour_start: value.hourStart,
    day_start: value.dayStart,
    week_start: value.weekStart,
    account_id: value.accountId,
    model: value.model,
    input: value.input,
    cache_read: value.cacheRead,
    cache_write: value.cacheWrite,
    output: value.output,
    input_total: value.inputTotal,
    api_usd: value.apiUsd,
    subscription_usd: value.subscriptionUsd,
    credits: value.credits,
    tier: value.tier,
  };
}

function hourGroupKey(row: MetricSqlRow): string {
  return JSON.stringify([row.hour_start, row.account_id, row.model]);
}

function addNumber(
  target: MutableNumberSummary,
  value: number,
  knownRows: number,
) {
  target.value += value;
  target.knownRows += knownRows;
}

function addAmount(
  target: MutableAmountSummary,
  value: string,
  knownRows: number,
) {
  if (!knownRows) return;
  target.value = target.value.add(value);
  target.knownRows += knownRows;
}

function addAggregate(target: Aggregate, source: Aggregate) {
  target.count += source.count;
  addNumber(target.input, source.input.value, source.input.knownRows);
  addNumber(
    target.cacheRead,
    source.cacheRead.value,
    source.cacheRead.knownRows,
  );
  addNumber(
    target.cacheWrite,
    source.cacheWrite.value,
    source.cacheWrite.knownRows,
  );
  addNumber(target.output, source.output.value, source.output.knownRows);
  target.tokenValue += source.tokenValue;
  target.tokenKnownRows += source.tokenKnownRows;
  target.tokenIncompleteRows += source.tokenIncompleteRows;
  target.completeCacheCount += source.completeCacheCount;
  target.completeCacheInput += source.completeCacheInput;
  target.completeCacheRead += source.completeCacheRead;
  target.unknownTier += source.unknownTier;
  addAmount(
    target.apiUsd,
    source.apiUsd.value.toString(),
    source.apiUsd.knownRows,
  );
  addAmount(
    target.subscriptionUsd,
    source.subscriptionUsd.value.toString(),
    source.subscriptionUsd.knownRows,
  );
  addAmount(
    target.credits,
    source.credits.value.toString(),
    source.credits.knownRows,
  );
}

function detailAggregate(row: MetricSqlRow): Aggregate {
  const result = emptyAggregate();
  result.count = 1;
  const tokens = [row.input, row.cache_read, row.cache_write, row.output];
  const knownTokens = tokens.filter((value) => value !== null);
  addNumber(result.input, row.input ?? 0, row.input === null ? 0 : 1);
  addNumber(
    result.cacheRead,
    row.cache_read ?? 0,
    row.cache_read === null ? 0 : 1,
  );
  addNumber(
    result.cacheWrite,
    row.cache_write ?? 0,
    row.cache_write === null ? 0 : 1,
  );
  addNumber(result.output, row.output ?? 0, row.output === null ? 0 : 1);
  if (knownTokens.length) {
    result.tokenKnownRows = 1;
    result.tokenValue = knownTokens.reduce((total, value) => total + value!, 0);
  }
  if (knownTokens.length !== TOKEN_FIELDS.length)
    result.tokenIncompleteRows = 1;
  if (row.input_total !== null) {
    result.completeCacheCount = 1;
    result.completeCacheInput = row.input_total;
    result.completeCacheRead = row.cache_read!;
  }
  result.unknownTier = row.tier === "unknown" ? 1 : 0;
  addAmount(result.apiUsd, row.api_usd ?? "0", row.api_usd === null ? 0 : 1);
  addAmount(
    result.subscriptionUsd,
    row.subscription_usd ?? "0",
    row.subscription_usd === null ? 0 : 1,
  );
  addAmount(result.credits, row.credits ?? "0", row.credits === null ? 0 : 1);
  return result;
}

function hourAggregate(row: HourSqlRow): Aggregate {
  const result = emptyAggregate();
  result.count = Number(row.requests);
  result.input = {
    value: Number(row.input_sum),
    knownRows: Number(row.input_known),
  };
  result.cacheRead = {
    value: Number(row.cache_read_sum),
    knownRows: Number(row.cache_read_known),
  };
  result.cacheWrite = {
    value: Number(row.cache_write_sum),
    knownRows: Number(row.cache_write_known),
  };
  result.output = {
    value: Number(row.output_sum),
    knownRows: Number(row.output_known),
  };
  result.tokenValue = Number(row.token_sum);
  result.tokenKnownRows = Number(row.token_known);
  result.tokenIncompleteRows = Number(row.token_incomplete);
  result.completeCacheCount = Number(row.complete_cache_count);
  result.completeCacheInput = Number(row.complete_cache_input_sum);
  result.completeCacheRead = Number(row.complete_cache_read_sum);
  result.unknownTier = Number(row.unknown_tier);
  result.apiUsd = {
    value: new Decimal(row.api_usd_sum),
    knownRows: Number(row.api_usd_known),
  };
  result.subscriptionUsd = {
    value: new Decimal(row.subscription_usd_sum),
    knownRows: Number(row.subscription_usd_known),
  };
  result.credits = {
    value: new Decimal(row.credits_sum),
    knownRows: Number(row.credits_known),
  };
  return result;
}

function addDetailToHour(target: Aggregate, row: MetricSqlRow) {
  addAggregate(target, detailAggregate(row));
}

function metricSummary(
  aggregate: Aggregate,
  unit: "usd" | "credits" | "tokens",
  basis: UsdBasis,
): MetricSummary {
  if (unit === "tokens") {
    return {
      value: aggregate.tokenValue,
      hasKnown: aggregate.tokenKnownRows > 0,
      knownRows: aggregate.tokenKnownRows,
      incompleteRows: aggregate.tokenIncompleteRows,
    };
  }
  const amount =
    unit === "credits"
      ? aggregate.credits
      : basis === "api"
        ? aggregate.apiUsd
        : aggregate.subscriptionUsd;
  return {
    value: amount.value.toNumber(),
    hasKnown: amount.knownRows > 0,
    knownRows: amount.knownRows,
    incompleteRows: aggregate.count - amount.knownRows,
  };
}

function summaryAmount(
  aggregate: Aggregate,
  basis: UsdBasis,
): MutableAmountSummary {
  return basis === "api" ? aggregate.apiUsd : aggregate.subscriptionUsd;
}

function amountString(value: MutableAmountSummary): string | null {
  return value.knownRows ? value.value.toString() : null;
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

function accountLifetimeFromAggregate(
  aggregate: Aggregate,
  basis: UsdBasis,
): AccountLifetime {
  const amount = summaryAmount(aggregate, basis);
  return {
    count: aggregate.count,
    tokens:
      aggregate.count === 0
        ? 0
        : aggregate.tokenKnownRows
          ? aggregate.tokenValue
          : null,
    usd: aggregate.count === 0 ? "0" : amountString(amount),
    incompleteTokens: aggregate.tokenIncompleteRows,
    incompleteUsd: aggregate.count - amount.knownRows,
  };
}

function accountUsage(
  accounts: readonly LedgerSnapshot["accounts"][number][],
  groups: Map<string, Aggregate>,
  basis: UsdBasis,
): Record<string, AccountLifetime> {
  const result = new Map<string, AccountLifetime>(
    accounts.map((account) => [account.id, emptyAccountLifetime()]),
  );
  for (const [accountId, aggregate] of groups)
    result.set(accountId, accountLifetimeFromAggregate(aggregate, basis));
  return Object.fromEntries(result);
}

function reportKey(
  contribution: Contribution,
  dimension: ReportDimension,
): string {
  if (dimension === "model") return contribution.model;
  if (dimension === "account") return contribution.accountId;
  const at =
    dimension === "hour"
      ? contribution.hourStart
      : dimension === "day"
        ? contribution.dayStart
        : contribution.weekStart;
  return new Date(at).toISOString();
}

function sortedSummaryRows(
  models: string[],
  groups: Map<string, Aggregate>,
  unit: "usd" | "credits" | "tokens",
  basis: UsdBasis,
) {
  return models
    .map((model) => {
      const aggregate = groups.get(model) ?? emptyAggregate();
      return {
        model,
        summary: metricSummary(aggregate, unit, basis),
        count: aggregate.count,
      };
    })
    .sort(
      (left, right) =>
        (right.summary.hasKnown
          ? right.summary.value
          : Number.NEGATIVE_INFINITY) -
        (left.summary.hasKnown ? left.summary.value : Number.NEGATIVE_INFINITY),
    );
}

function predicateForBounds(
  bounds: ReportBounds,
  column: string,
): { sql: string; params: SqlParam[] } {
  return {
    sql: `${column} ${bounds.startInclusive ? ">=" : ">"} ? AND ${column} ${bounds.endInclusive ? "<=" : "<"} ?`,
    params: [bounds.start, bounds.end],
  };
}

function fullHourPredicate(
  bounds: ReportBounds,
  column: string,
): { sql: string; params: SqlParam[] } {
  return {
    sql: `${column} ${bounds.startInclusive ? ">=" : ">"} ? AND ${column} + ? <= ?`,
    params: [bounds.start, HOUR_MS, bounds.end],
  };
}

function hourStart(time: number): number {
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

/** 边界明细最多落在起止两个小时；完整小时始终走 report_hours。 */
function boundaryHourStarts(bounds: ReportBounds): number[] {
  const hours = new Set<number>();
  const startHour = hourStart(bounds.start);
  const endHour = hourStart(bounds.end);
  if (!bounds.startInclusive || startHour !== bounds.start)
    hours.add(startHour);
  if (bounds.endInclusive || endHour !== bounds.end) hours.add(endHour);
  return [...hours].sort((left, right) => left - right);
}

function hourInPredicate(
  column: string,
  hours: number[],
): { sql: string; params: SqlParam[] } {
  return {
    sql: `${column} IN (${hours.map(() => "?").join(", ")})`,
    params: hours,
  };
}

function toReportBounds(bounds: ReturnType<typeof reportBounds>): ReportBounds {
  return {
    start: bounds.start,
    end: bounds.end,
    startInclusive: !bounds.endInclusive,
    endInclusive: bounds.endInclusive,
  };
}

function filterSql(filter: ViewQuery["filter"], alias: string): FilterSql {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.model !== "all") {
    clauses.push(`${alias}.model = ?`);
    params.push(filter.model);
  }
  if (filter.account !== "all") {
    clauses.push(`${alias}.account_id = ?`);
    params.push(filter.account);
  }
  const search = filter.search.trim().toLowerCase();
  if (search) {
    clauses.push(`instr(${alias}.search_text, ?) > 0`);
    params.push(search);
  }
  return { clauses, params };
}

const DETAIL_FIELDS = `
  r.hour_start,
  r.day_start,
  r.week_start,
  r.account_id,
  r.model,
  r.input,
  r.cache_read,
  r.cache_write,
  r.output,
  r.input_total,
  r.api_usd,
  r.subscription_usd,
  r.credits,
  r.tier`;

const HOUR_FIELDS = `
  h.hour_start,
  h.day_start,
  h.week_start,
  h.account_id,
  h.model,
  h.requests,
  h.input_sum,
  h.input_known,
  h.cache_read_sum,
  h.cache_read_known,
  h.cache_write_sum,
  h.cache_write_known,
  h.output_sum,
  h.output_known,
  h.token_sum,
  h.token_known,
  h.token_incomplete,
  h.complete_cache_count,
  h.complete_cache_input_sum,
  h.complete_cache_read_sum,
  h.unknown_tier,
  h.api_usd_sum,
  h.api_usd_known,
  h.subscription_usd_sum,
  h.subscription_usd_known,
  h.credits_sum,
  h.credits_known`;

/**
 * SQLite 派生报表索引。账单行以订阅口径作为 canonical 输入，索引同时保存 API
 * 口径；JSON 只在最终明细页读取，聚合和筛选都依赖结构化列。
 */
export class ReportIndex {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    assertReadableSchema(this.db, "report");
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const initializeSchema = () =>
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS report_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projection_checkpoint (
        id INTEGER PRIMARY KEY CHECK(id=1),
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS report_records (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        occurred_ms INTEGER NOT NULL,
        hour_start INTEGER NOT NULL,
        day_start INTEGER NOT NULL,
        week_start INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        model TEXT NOT NULL,
        id_lc TEXT NOT NULL,
        account_lc TEXT NOT NULL,
        model_lc TEXT NOT NULL,
        search_text TEXT NOT NULL,
        input REAL,
        cache_read REAL,
        cache_write REAL,
        output REAL,
        input_total REAL,
        api_usd TEXT,
        subscription_usd TEXT,
        credits TEXT,
        api_sort TEXT,
        subscription_sort TEXT,
        tier TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_records_time
        ON report_records (occurred_ms, id);
      CREATE INDEX IF NOT EXISTS report_records_search_time
        ON report_records (occurred_ms, search_text, model, account_id, id);
      CREATE INDEX IF NOT EXISTS report_records_hour
        ON report_records (hour_start, account_id, model);
      CREATE INDEX IF NOT EXISTS report_records_account_time
        ON report_records (account_id, occurred_ms, id);
      CREATE INDEX IF NOT EXISTS report_records_model_time
        ON report_records (model, occurred_ms, id);
      CREATE INDEX IF NOT EXISTS report_records_page_time
        ON report_records (occurred_ms DESC, id ASC);
      CREATE INDEX IF NOT EXISTS report_records_page_time_asc
        ON report_records (occurred_ms ASC, id ASC);
      CREATE INDEX IF NOT EXISTS report_records_page_model
        ON report_records (model ASC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_model_desc
        ON report_records (model DESC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_account
        ON report_records (account_id ASC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_account_desc
        ON report_records (account_id DESC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_input
        ON report_records (input_total ASC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_input_desc
        ON report_records (input_total DESC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_cache_read
        ON report_records (cache_read ASC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_cache_read_desc
        ON report_records (cache_read DESC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_output
        ON report_records (output ASC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_output_desc
        ON report_records (output DESC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_subscription_usd
        ON report_records (subscription_sort ASC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_subscription_usd_desc
        ON report_records (subscription_sort DESC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_api_usd
        ON report_records (api_sort ASC, id ASC, occurred_ms);
      CREATE INDEX IF NOT EXISTS report_records_page_api_usd_desc
        ON report_records (api_sort DESC, id ASC, occurred_ms);
      CREATE TABLE IF NOT EXISTS report_hours (
        hour_start INTEGER NOT NULL,
        day_start INTEGER NOT NULL,
        week_start INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        model TEXT NOT NULL,
        requests INTEGER NOT NULL,
        input_sum REAL NOT NULL,
        input_known INTEGER NOT NULL,
        cache_read_sum REAL NOT NULL,
        cache_read_known INTEGER NOT NULL,
        cache_write_sum REAL NOT NULL,
        cache_write_known INTEGER NOT NULL,
        output_sum REAL NOT NULL,
        output_known INTEGER NOT NULL,
        token_sum REAL NOT NULL,
        token_known INTEGER NOT NULL,
        token_incomplete INTEGER NOT NULL,
        complete_cache_count INTEGER NOT NULL,
        complete_cache_input_sum REAL NOT NULL,
        complete_cache_read_sum REAL NOT NULL,
        unknown_tier INTEGER NOT NULL,
        api_usd_sum TEXT NOT NULL,
        api_usd_known INTEGER NOT NULL,
        subscription_usd_sum TEXT NOT NULL,
        subscription_usd_known INTEGER NOT NULL,
        credits_sum TEXT NOT NULL,
        credits_known INTEGER NOT NULL,
        PRIMARY KEY (hour_start, account_id, model)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_hours_time
        ON report_hours (hour_start, account_id, model);
      CREATE INDEX IF NOT EXISTS report_hours_model_time
        ON report_hours (model, hour_start);
      CREATE INDEX IF NOT EXISTS report_hours_account_time
        ON report_hours (account_id, hour_start);
    `);
    migrateSchema(this.db, "report", [
      {
        revision: DATABASE_SCHEMA_REVISION,
        downRevision: null,
        apply: initializeSchema,
      },
    ]);
  }

  getMeta<T>(key: string): T | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM report_meta WHERE key=?",
      )
      .get(key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setMeta(key: string, value: unknown): void {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new TypeError("Report index metadata must be JSON serializable");
    this.db
      .query(
        "INSERT INTO report_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, serialized);
  }

  replace(records: Iterable<LedgerRecord>): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM report_records; DELETE FROM report_hours;");
      this.db.exec(
        "DELETE FROM report_meta WHERE key LIKE 'account-lifetime:%'",
      );
      for (const record of records) this.writeRecord(storedRecord(record));
      this.rebuildHours();
    })();
  }

  apply(records: Iterable<LedgerRecord>, deletedIds: Iterable<string>): void {
    this.applyChanges(
      (function* () {
        for (const id of deletedIds) yield { id, record: null };
        for (const record of records) yield { id: record.id, record };
      })(),
    );
  }

  /** 新请求直接累加小时指标；修订和删除局部重算，两者与明细流保持同一事务。 */
  applyChanges(
    changes: Iterable<{ id: string; record: LedgerRecord | null }>,
  ): void {
    this.db.transaction(() => {
      const affectedHours = new Set<number>();
      const additions = new Map<
        string,
        { row: MetricSqlRow; aggregate: Aggregate }
      >();
      for (const { id, record } of changes) {
        if (!record) {
          const previous = this.db
            .query<{ hour_start: number; account_id: string }, [string]>(
              "SELECT hour_start, account_id FROM report_records WHERE id=?",
            )
            .get(id);
          if (previous) {
            affectedHours.add(Number(previous.hour_start));
            this.invalidateAccountLifetime(previous.account_id);
          }
          this.db.query("DELETE FROM report_records WHERE id=?").run(id);
          continue;
        }
        if (record.id !== id)
          throw new Error("Report change identity mismatch");
        const value = storedRecord(record);
        const previous = this.db
          .query<
            MetricSqlRow & { occurred_at: string; payload: string },
            [string]
          >(
            `SELECT occurred_at, hour_start, day_start, week_start, account_id, model,
              input, cache_read, cache_write, output, input_total,
              api_usd, subscription_usd, credits, tier, payload
             FROM report_records WHERE id=?`,
          )
          .get(value.id);
        // 明细证据不参与汇总或排序；补齐证据时不能重写所有索引并重算整小时。
        if (
          previous &&
          previous.occurred_at === value.occurredAt &&
          previous.hour_start === value.hourStart &&
          previous.day_start === value.dayStart &&
          previous.week_start === value.weekStart &&
          previous.account_id === value.accountId &&
          previous.model === value.model &&
          previous.input === value.input &&
          previous.cache_read === value.cacheRead &&
          previous.cache_write === value.cacheWrite &&
          previous.output === value.output &&
          previous.input_total === value.inputTotal &&
          previous.api_usd === value.apiUsd &&
          previous.subscription_usd === value.subscriptionUsd &&
          previous.credits === value.credits &&
          previous.tier === value.tier
        ) {
          if (previous.payload !== value.payload)
            this.db
              .query("UPDATE report_records SET payload=? WHERE id=?")
              .run(value.payload, value.id);
          continue;
        }
        if (previous) {
          this.invalidateAccountLifetime(previous.account_id);
          affectedHours.add(Number(previous.hour_start));
          affectedHours.add(value.hourStart);
        } else {
          const metric = recordMetric(value);
          const key = hourGroupKey(metric);
          const group = additions.get(key);
          if (group) addDetailToHour(group.aggregate, metric);
          else
            additions.set(key, {
              row: metric,
              aggregate: detailAggregate(metric),
            });
        }
        this.invalidateAccountLifetime(value.accountId);
        this.writeRecord(value);
      }
      // 同批次的修订/删除可影响刚插入的行；重算小时已包含这些新增，不能再次累加。
      this.rebuildHours(affectedHours);
      for (const group of additions.values()) {
        if (affectedHours.has(group.row.hour_start)) continue;
        const previous = this.db
          .query<HourSqlRow, [number, string, string]>(
            "SELECT * FROM report_hours WHERE hour_start=? AND account_id=? AND model=?",
          )
          .get(group.row.hour_start, group.row.account_id, group.row.model);
        if (previous) addAggregate(group.aggregate, hourAggregate(previous));
        this.insertHourGroups([group]);
      }
    })();
  }

  accountIds(): string[] {
    return this.db
      .query<{ account_id: string }, []>(
        "SELECT DISTINCT account_id FROM report_records",
      )
      .all()
      .map((row) => row.account_id)
      .sort((left, right) => left.localeCompare(right));
  }

  /** 累计只读持久化小时汇总；修订仅使受影响账户失效，页面切换和重启复用已存结果。 */
  accountLifetime(accountId: string, basis: UsdBasis): AccountLifetime {
    const key = `account-lifetime:${accountId}`;
    let cached = this.getMeta<Record<UsdBasis, AccountLifetime>>(key);
    if (!cached) {
      const total = emptyAggregate();
      for (const row of this.db
        .query<HourSqlRow, [string]>(
          "SELECT * FROM report_hours WHERE account_id=?",
        )
        .iterate(accountId))
        addAggregate(total, hourAggregate(row));
      const value = (selected: UsdBasis): AccountLifetime => {
        const amount = summaryAmount(total, selected);
        return {
          count: total.count,
          tokens:
            total.count === 0
              ? 0
              : total.tokenKnownRows
                ? total.tokenValue
                : null,
          usd: total.count === 0 ? "0" : amountString(amount),
          incompleteTokens: total.tokenIncompleteRows,
          incompleteUsd: total.count - amount.knownRows,
        };
      };
      cached = { subscription: value("subscription"), api: value("api") };
      this.setMeta(key, cached);
    }
    return cached[basis];
  }

  private invalidateAccountLifetime(accountId: string) {
    this.db
      .query("DELETE FROM report_meta WHERE key=?")
      .run(`account-lifetime:${accountId}`);
  }

  sumWindow(
    accountId: string,
    startInclusive: string,
    endInclusive: string,
    usdBasis: UsdBasis,
  ): {
    count: number;
    tokens: number | null;
    usd: string | null;
    credits: string | null;
  } {
    const start = Date.parse(startInclusive);
    const end = Date.parse(endInclusive);
    if (!Number.isFinite(start) || !Number.isFinite(end))
      throw new RangeError("sumWindow bounds must be valid dates");
    if (start > end)
      throw new RangeError("sumWindow start must not exceed end");
    const aggregate = this.loadContributions(
      { start, end, startInclusive: true, endInclusive: true },
      { model: "all", account: accountId, search: "", days: 1 },
    ).reduce((total, contribution) => {
      addAggregate(total, contribution.aggregate);
      return total;
    }, emptyAggregate());
    if (!aggregate.count)
      return { count: 0, tokens: 0, usd: "0", credits: "0" };
    const usd = summaryAmount(aggregate, usdBasis);
    return {
      count: aggregate.count,
      tokens: aggregate.tokenIncompleteRows === 0 ? aggregate.tokenValue : null,
      usd: usd.knownRows === aggregate.count ? usd.value.toString() : null,
      credits:
        aggregate.credits.knownRows === aggregate.count
          ? aggregate.credits.value.toString()
          : null,
    };
  }

  /**
   * 读取一次与 USD 口径无关的贡献、边界汇总和分组；结果可物化为多个口径。
   * 准备阶段不读取明细页，因而不会替代各口径独立的金额排序分页查询。
   */
  prepare(
    snapshot: Omit<LedgerSnapshot, "records">,
    query: ViewQuery,
  ): PreparedReport {
    const currentBounds = toReportBounds(
      reportBounds(query.filter, snapshot.asOf),
    );
    const previousBounds = toReportBounds(
      reportBounds(query.filter, snapshot.asOf, true),
    );
    const current = this.loadContributions(currentBounds, query.filter);
    const previous = this.loadContributions(previousBounds, query.filter);
    const currentTotal = current.reduce((total, contribution) => {
      addAggregate(total, contribution.aggregate);
      return total;
    }, emptyAggregate());
    const previousTotal = previous.reduce((total, contribution) => {
      addAggregate(total, contribution.aggregate);
      return total;
    }, emptyAggregate());
    const currentByModel = this.groupContributions(
      current,
      (item) => item.model,
    );
    const currentByAccount = this.groupContributions(
      current,
      (item) => item.accountId,
    );
    const currentByPoint = this.groupContributions(current, (item) => {
      const at =
        query.granularity === "hour"
          ? item.hourStart
          : query.granularity === "day"
            ? item.dayStart
            : item.weekStart;
      return String(at);
    });
    const currentByReport = this.groupContributions(current, (item) =>
      reportKey(item, query.dimension),
    );
    const models = [
      ...new Set([
        ...this.modelsForBounds(currentBounds),
        ...this.modelsForBounds(previousBounds),
      ]),
    ].sort((left, right) => left.localeCompare(right));
    return {
      snapshot,
      query,
      currentTotal,
      previousTotal,
      currentByModel,
      currentByAccount,
      currentByPoint,
      currentByReport,
      models,
    };
  }

  /**
   * 物化单一 USD 口径；subscription/api 共用准备结果，但明细页仍按传入
   * basis 对应的金额排序列独立执行分页查询。可选 snapshot 用于保留该口径
   * 的账户与额度元数据，省略时沿用准备阶段的快照。
   */
  materialize(
    prepared: PreparedReport,
    basis: UsdBasis,
    snapshot: Omit<LedgerSnapshot, "records"> = prepared.snapshot,
  ): LedgerView {
    const {
      query,
      currentTotal,
      previousTotal,
      currentByModel,
      currentByAccount,
      currentByPoint,
      currentByReport,
      models,
    } = prepared;
    const totals = {
      usd: metricSummary(currentTotal, "usd", basis),
      credits: metricSummary(currentTotal, "credits", basis),
      tokens: metricSummary(currentTotal, "tokens", basis),
    };
    const units = {} as LedgerView["view"]["units"];
    for (const unit of ["usd", "credits", "tokens"] as const) {
      units[unit] = {
        totalSummary: totals[unit],
        breakdown: sortedSummaryRows(models, currentByModel, unit, basis),
        points: [...currentByPoint]
          .sort(([left], [right]) => Number(left) - Number(right))
          .map(([key, aggregate]) => ({
            at: Number(key),
            value: metricSummary(aggregate, unit, basis).hasKnown
              ? metricSummary(aggregate, unit, basis).value
              : null,
            count: aggregate.count,
            incomplete: metricSummary(aggregate, unit, basis).incompleteRows,
          })),
      };
    }
    const page = Math.max(0, Math.trunc(query.page));
    const pageSize = Math.max(0, Math.trunc(query.pageSize));
    // 汇总已证明该页为空时不再扫描排序索引，避免无匹配搜索重复读取整段明细。
    const records =
      pageSize && page * pageSize < currentTotal.count
        ? this.readPage(snapshot.asOf, query, basis, page, pageSize)
        : [];
    const reportRows = [...currentByReport]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, aggregate]) => this.reportRow(key, aggregate, basis));
    const selectedTotal = totals[query.unit];
    const breakdown = units[query.unit].breakdown;
    const points = units[query.unit].points;
    return {
      ...snapshot,
      ...(snapshot.usdBasis === undefined ? {} : { usdBasis: basis }),
      records,
      view: {
        units,
        models,
        count: currentTotal.count,
        totalSummary: selectedTotal,
        usdSummary: totals.usd,
        creditsSummary: totals.credits,
        tokenSummary: totals.tokens,
        previousUsdSummary: metricSummary(previousTotal, "usd", basis),
        cacheSummary: this.cacheSummary(currentTotal),
        cacheRate: currentTotal.completeCacheInput
          ? (currentTotal.completeCacheRead / currentTotal.completeCacheInput) *
            100
          : null,
        completeCacheCount: currentTotal.completeCacheCount,
        unknownTier: currentTotal.unknownTier,
        breakdown,
        points,
        reportRows,
        accountUsage: accountUsage(snapshot.accounts, currentByAccount, basis),
        page,
        pageSize,
      },
    };
  }

  /** 保持单口径读取契约；需要多个 USD 口径时应复用同一准备结果。 */
  read(
    snapshot: Omit<LedgerSnapshot, "records">,
    query: ViewQuery,
  ): LedgerView {
    const basis = snapshot.usdBasis ?? "subscription";
    return this.materialize(this.prepare(snapshot, query), basis);
  }

  close(): void {
    this.db.close();
  }

  private cacheSummary(aggregate: Aggregate): MetricSummary {
    return {
      value: aggregate.cacheRead.value,
      hasKnown: aggregate.cacheRead.knownRows > 0,
      knownRows: aggregate.cacheRead.knownRows,
      incompleteRows: aggregate.count - aggregate.cacheRead.knownRows,
    };
  }

  private groupContributions(
    contributions: Contribution[],
    key: (item: Contribution) => string,
  ): Map<string, Aggregate> {
    const groups = new Map<string, Aggregate>();
    for (const contribution of contributions) {
      const group = groups.get(key(contribution)) ?? emptyAggregate();
      addAggregate(group, contribution.aggregate);
      groups.set(key(contribution), group);
    }
    return groups;
  }

  private reportRow(key: string, aggregate: Aggregate, basis: UsdBasis) {
    const selectedUsd = summaryAmount(aggregate, basis);
    return {
      key,
      requests: aggregate.count,
      input: aggregate.input.knownRows ? aggregate.input.value : null,
      cacheRead: aggregate.cacheRead.knownRows
        ? aggregate.cacheRead.value
        : null,
      cacheWrite: aggregate.cacheWrite.knownRows
        ? aggregate.cacheWrite.value
        : null,
      output: aggregate.output.knownRows ? aggregate.output.value : null,
      tokens: aggregate.tokenKnownRows ? aggregate.tokenValue : null,
      incompleteTokens: aggregate.tokenIncompleteRows,
      unpricedUsd: aggregate.count - selectedUsd.knownRows,
      unpricedCredits: aggregate.count - aggregate.credits.knownRows,
      unknownTier: aggregate.unknownTier,
      usd: amountString(selectedUsd),
      apiUsd: amountString(aggregate.apiUsd),
      subscriptionUsd: amountString(aggregate.subscriptionUsd),
      credits: amountString(aggregate.credits),
    };
  }

  private writeRecord(value: StoredRecord): void {
    this.db
      .query<never, SqlParam[]>(
        `INSERT INTO report_records (
          id, occurred_at, occurred_ms, hour_start, day_start, week_start,
          account_id, model, id_lc, account_lc, model_lc, search_text,
          input, cache_read, cache_write, output, input_total,
          api_usd, subscription_usd, credits, api_sort, subscription_sort,
          tier, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          occurred_at=excluded.occurred_at,
          occurred_ms=excluded.occurred_ms,
          hour_start=excluded.hour_start,
          day_start=excluded.day_start,
          week_start=excluded.week_start,
          account_id=excluded.account_id,
          model=excluded.model,
          id_lc=excluded.id_lc,
          account_lc=excluded.account_lc,
          model_lc=excluded.model_lc,
          search_text=excluded.search_text,
          input=excluded.input,
          cache_read=excluded.cache_read,
          cache_write=excluded.cache_write,
          output=excluded.output,
          input_total=excluded.input_total,
          api_usd=excluded.api_usd,
          subscription_usd=excluded.subscription_usd,
          credits=excluded.credits,
          api_sort=excluded.api_sort,
          subscription_sort=excluded.subscription_sort,
          tier=excluded.tier,
          payload=excluded.payload`,
      )
      .run(
        value.id,
        value.occurredAt,
        value.occurredMs,
        value.hourStart,
        value.dayStart,
        value.weekStart,
        value.accountId,
        value.model,
        value.id.toLowerCase(),
        value.accountId.toLowerCase(),
        value.model.toLowerCase(),
        `${value.id} ${value.model} ${value.accountId}`.toLowerCase(),
        value.input,
        value.cacheRead,
        value.cacheWrite,
        value.output,
        value.inputTotal,
        value.apiUsd,
        value.subscriptionUsd,
        value.credits,
        value.apiSort,
        value.subscriptionSort,
        value.tier,
        value.payload,
      );
  }

  private rebuildHours(hours?: Set<number>): void {
    if (!hours) {
      this.db.exec("DELETE FROM report_hours");
      const rows = this.db.query<MetricSqlRow, []>(
        `SELECT hour_start, day_start, week_start, account_id, model,
           input, cache_read, cache_write, output, input_total,
           api_usd, subscription_usd, credits, tier
         FROM report_records
         ORDER BY hour_start, account_id, model, id`,
      );
      this.insertHourGroups(this.groupHourRows(rows.iterate()));
      return;
    }
    for (const hour of hours) {
      this.db.query("DELETE FROM report_hours WHERE hour_start=?").run(hour);
      const rows = this.db.query<MetricSqlRow, [number]>(
        `SELECT hour_start, day_start, week_start, account_id, model,
           input, cache_read, cache_write, output, input_total,
           api_usd, subscription_usd, credits, tier
         FROM report_records
         WHERE hour_start=?
         ORDER BY account_id, model, id`,
      );
      this.insertHourGroups(this.groupHourRows(rows.iterate(hour)));
    }
  }

  private groupHourRows(rows: Iterable<MetricSqlRow>) {
    const groups = new Map<
      string,
      { row: MetricSqlRow; aggregate: Aggregate }
    >();
    for (const row of rows) {
      const key = hourGroupKey(row);
      const group = groups.get(key);
      if (group) addDetailToHour(group.aggregate, row);
      else groups.set(key, { row, aggregate: detailAggregate(row) });
    }
    return [...groups.values()];
  }

  private insertHourGroups(
    groups: { row: MetricSqlRow; aggregate: Aggregate }[],
  ): void {
    for (const { row, aggregate } of groups) {
      this.db
        .query<never, SqlParam[]>(
          `INSERT OR REPLACE INTO report_hours (
            hour_start, day_start, week_start, account_id, model, requests,
            input_sum, input_known, cache_read_sum, cache_read_known,
            cache_write_sum, cache_write_known, output_sum, output_known,
            token_sum, token_known, token_incomplete, complete_cache_count,
            complete_cache_input_sum, complete_cache_read_sum, unknown_tier,
            api_usd_sum, api_usd_known,
            subscription_usd_sum, subscription_usd_known, credits_sum, credits_known
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.hour_start,
          row.day_start,
          row.week_start,
          row.account_id,
          row.model,
          aggregate.count,
          aggregate.input.value,
          aggregate.input.knownRows,
          aggregate.cacheRead.value,
          aggregate.cacheRead.knownRows,
          aggregate.cacheWrite.value,
          aggregate.cacheWrite.knownRows,
          aggregate.output.value,
          aggregate.output.knownRows,
          aggregate.tokenValue,
          aggregate.tokenKnownRows,
          aggregate.tokenIncompleteRows,
          aggregate.completeCacheCount,
          aggregate.completeCacheInput,
          aggregate.completeCacheRead,
          aggregate.unknownTier,
          aggregate.apiUsd.value.toString(),
          aggregate.apiUsd.knownRows,
          aggregate.subscriptionUsd.value.toString(),
          aggregate.subscriptionUsd.knownRows,
          aggregate.credits.value.toString(),
          aggregate.credits.knownRows,
        );
    }
  }

  private loadContributions(
    bounds: ReportBounds,
    filter: ViewQuery["filter"],
  ): Contribution[] {
    const search = filter.search.trim().toLowerCase();
    if (search) return this.loadDetailContributions(bounds, filter, false);

    const full = fullHourPredicate(bounds, "h.hour_start");
    const hourFilter = filterSql(filter, "h");
    const hourClauses = [full.sql, ...hourFilter.clauses];
    const hours = this.db
      .query<HourSqlRow, SqlParam[]>(
        `SELECT ${HOUR_FIELDS} FROM report_hours h WHERE ${hourClauses.join(" AND ")}`,
      )
      .all(...full.params, ...hourFilter.params)
      .map((row) => ({
        hourStart: Number(row.hour_start),
        dayStart: Number(row.day_start),
        weekStart: Number(row.week_start),
        accountId: row.account_id,
        model: row.model,
        aggregate: hourAggregate(row),
      }));
    return [...hours, ...this.loadDetailContributions(bounds, filter, true)];
  }

  private loadDetailContributions(
    bounds: ReportBounds,
    filter: ViewQuery["filter"],
    boundaryOnly: boolean,
  ): Contribution[] {
    const time = predicateForBounds(bounds, "r.occurred_ms");
    const detailFilter = filterSql(filter, "r");
    const clauses = [time.sql, ...detailFilter.clauses];
    const params: SqlParam[] = [...time.params, ...detailFilter.params];
    if (boundaryOnly) {
      const hours = boundaryHourStarts(bounds);
      if (!hours.length) return [];
      const boundary = hourInPredicate("r.hour_start", hours);
      clauses.push(boundary.sql);
      params.push(...boundary.params);
    }
    // 搜索过滤字段由索引覆盖；不匹配行无需读取含完整请求 payload 的主表页。
    const indexHint = boundaryOnly
      ? " INDEXED BY report_records_hour"
      : filter.search.trim()
        ? " INDEXED BY report_records_search_time"
        : "";
    const rows = this.db
      .query<MetricSqlRow, SqlParam[]>(
        // 边界最多两个小时；账户时间索引会先扫描整周期再过滤小时，放大额度查询的磁盘读取。
        `SELECT ${DETAIL_FIELDS} FROM report_records r${indexHint} WHERE ${clauses.join(" AND ")}`,
      )
      .all(...params);
    return rows.map((row) => ({
      hourStart: Number(row.hour_start),
      dayStart: Number(row.day_start),
      weekStart: Number(row.week_start),
      accountId: row.account_id,
      model: row.model,
      aggregate: detailAggregate(row),
    }));
  }

  private modelsForBounds(bounds: ReportBounds): string[] {
    const result = new Set<string>();
    const full = fullHourPredicate(bounds, "h.hour_start");
    this.db
      .query<{ model: string }, SqlParam[]>(
        `SELECT DISTINCT h.model FROM report_hours h WHERE ${full.sql}`,
      )
      .all(...full.params)
      .forEach((row) => result.add(row.model));
    const time = predicateForBounds(bounds, "r.occurred_ms");
    const boundary = hourInPredicate(
      "r.hour_start",
      boundaryHourStarts(bounds),
    );
    if (!boundary.params.length) return [...result];
    this.db
      .query<{ model: string }, SqlParam[]>(
        `SELECT DISTINCT r.model FROM report_records r
         WHERE ${time.sql} AND ${boundary.sql}`,
      )
      .all(...time.params, ...boundary.params)
      .forEach((row) => result.add(row.model));
    return [...result];
  }

  private readPage(
    asOf: string,
    query: ViewQuery,
    basis: UsdBasis,
    page: number,
    pageSize: number,
  ): LedgerRecord[] {
    const bounds = toReportBounds(reportBounds(query.filter, asOf));
    const time = predicateForBounds(bounds, "r.occurred_ms");
    const filter = filterSql(query.filter, "r");
    const clauses = [time.sql, ...filter.clauses];
    const params: SqlParam[] = [
      ...time.params,
      ...filter.params,
      pageSize,
      page * pageSize,
    ];
    const requestedSort =
      query.sort === "" || !SORT_KEYS.has(query.sort)
        ? "occurredAt"
        : query.sort;
    const descending =
      query.sort === "" || !SORT_KEYS.has(query.sort) ? true : query.desc;
    const sortInfo =
      requestedSort === "occurredAt"
        ? {
            column: "r.occurred_ms",
            asc: "report_records_page_time_asc",
            desc: "report_records_page_time",
          }
        : requestedSort === "model"
          ? {
              column: "r.model",
              asc: "report_records_page_model",
              desc: "report_records_page_model_desc",
            }
          : requestedSort === "accountId"
            ? {
                column: "r.account_id",
                asc: "report_records_page_account",
                desc: "report_records_page_account_desc",
              }
            : requestedSort === "input"
              ? {
                  column: "r.input_total",
                  asc: "report_records_page_input",
                  desc: "report_records_page_input_desc",
                }
              : requestedSort === "cacheRead"
                ? {
                    column: "r.cache_read",
                    asc: "report_records_page_cache_read",
                    desc: "report_records_page_cache_read_desc",
                  }
                : requestedSort === "output"
                  ? {
                      column: "r.output",
                      asc: "report_records_page_output",
                      desc: "report_records_page_output_desc",
                    }
                  : basis === "api"
                    ? {
                        column: "r.api_sort",
                        asc: "report_records_page_api_usd",
                        desc: "report_records_page_api_usd_desc",
                      }
                    : {
                        column: "r.subscription_sort",
                        asc: "report_records_page_subscription_usd",
                        desc: "report_records_page_subscription_usd_desc",
                      };
    const direction = descending ? "DESC" : "ASC";
    const rows = this.db
      .query<PageSqlRow, SqlParam[]>(
        `SELECT r.payload FROM report_records r INDEXED BY ${
          descending ? sortInfo.desc : sortInfo.asc
        }
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${sortInfo.column} ${direction}, r.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params);
    return rows.map((row) =>
      this.materializeRecord(JSON.parse(row.payload) as LedgerRecord, basis),
    );
  }

  private materializeRecord(
    record: LedgerRecord,
    basis: UsdBasis,
  ): LedgerRecord {
    const usd = valueForUsd(record, basis);
    const valuation = record.valuation
      ? {
          ...record.valuation,
          usdBasis: basis,
          usd:
            basis === "api"
              ? record.valuation.apiUsd
              : record.valuation.subscriptionUsd,
        }
      : undefined;
    return {
      ...record,
      usd,
      ...(valuation ? { valuation } : {}),
      quality:
        usd === null || record.credits === null ? "unpriced" : "estimated",
    };
  }
}
