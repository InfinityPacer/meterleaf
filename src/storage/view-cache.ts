import { Database } from "bun:sqlite";
import {
  DATABASE_SCHEMA_REVISION,
  assertReadableSchema,
  migrateSchema,
} from "./schema";
import type { LedgerView, ViewQuery } from "../shared/ledger-view";
import type { UsdBasis } from "../shared/report";

/** 最近成功的完整展示结果；lastUsed 由服务提供，缓存不自行决定过期时间。 */
export interface CachedReport {
  key: string;
  query: ViewQuery;
  basis: UsdBasis;
  value: LedgerView;
  lastUsed: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireShape(valid: unknown): asserts valid {
  if (!valid) throw new TypeError("Invalid cached report shape");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 只校验展示容器，不重解释金额、价格版本或可选领域字段。 */
function validateVariant(value: unknown) {
  requireShape(object(value));
  requireShape(Array.isArray(value.records) && value.records.every(object));
  requireShape(Array.isArray(value.accounts) && value.accounts.every(object));
  const view = value.view;
  requireShape(object(view));
  requireShape(
    finite(view.count) && finite(view.page) && finite(view.pageSize),
  );
  requireShape(
    Array.isArray(view.models) &&
      view.models.every((v) => typeof v === "string"),
  );
  for (const field of ["breakdown", "points", "reportRows"])
    requireShape(Array.isArray(view[field]));
  for (const field of [
    "totalSummary",
    "usdSummary",
    "creditsSummary",
    "tokenSummary",
    "previousUsdSummary",
    "cacheSummary",
  ])
    requireShape(object(view[field]));
  requireShape(object(view.units));
  for (const unit of ["usd", "credits", "tokens"]) {
    const item = view.units[unit];
    requireShape(object(item) && object(item.totalSummary));
    requireShape(Array.isArray(item.breakdown) && Array.isArray(item.points));
  }
  if (value.lifetimeTotals !== undefined)
    requireShape(object(value.lifetimeTotals));
}

function validate(entry: unknown): asserts entry is CachedReport {
  requireShape(object(entry));
  requireShape(typeof entry.key === "string" && finite(entry.lastUsed));
  requireShape(entry.basis === "api" || entry.basis === "subscription");
  const query = entry.query;
  requireShape(object(query) && object(query.filter));
  requireShape(finite(query.filter.days));
  for (const field of ["model", "account", "search"])
    requireShape(typeof query.filter[field] === "string");
  if (query.filter.dateRange !== undefined) {
    const range = query.filter.dateRange;
    requireShape(
      object(range) &&
        typeof range.from === "string" &&
        typeof range.to === "string",
    );
  }
  for (const field of ["unit", "granularity", "dimension", "sort"])
    requireShape(typeof query[field] === "string");
  requireShape(
    finite(query.page) &&
      finite(query.pageSize) &&
      typeof query.desc === "boolean",
  );
  const value = entry.value;
  requireShape(object(value));
  requireShape(value.mode === "live" || value.mode === "demo");
  requireShape(typeof value.asOf === "string");
  requireShape(Array.isArray(value.resets) && value.resets.every(object));
  validateVariant(value);
  if (value.pricing !== undefined) {
    requireShape(
      object(value.pricing) && typeof value.pricing.version === "string",
    );
    requireShape(
      typeof value.pricing.publishedAt === "string" &&
        Array.isArray(value.pricing.sources),
    );
  }
  if (value.sync !== undefined) requireShape(object(value.sync));
  if (value.usdVariants !== undefined) {
    requireShape(object(value.usdVariants));
    validateVariant(value.usdVariants.api);
    validateVariant(value.usdVariants.subscription);
  }
  if (value.reportStatus !== undefined) {
    requireShape(object(value.reportStatus));
    requireShape(
      value.reportStatus.refreshing === false &&
        value.reportStatus.lastError === null,
    );
  }
}

/** 独立派生 SQLite 缓存；namespace 包含格式、来源身份和 book.id，不包含价格版本。 */
export class ViewCache {
  private readonly db: Database;

  constructor(path: string, namespace: string) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      assertReadableSchema(this.db, "view-cache");
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      migrateSchema(this.db, "view-cache", [
        {
          revision: DATABASE_SCHEMA_REVISION,
          downRevision: null,
          apply: (db) =>
            db.exec(`
          CREATE TABLE IF NOT EXISTS view_cache_namespace (
            id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS view_cache (
            key TEXT PRIMARY KEY, last_used REAL NOT NULL, payload TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS view_cache_recency ON view_cache(last_used DESC, key);
        `),
        },
      ]);
      this.db.transaction(() => {
        const prior = this.db
          .query<{ namespace: string }, []>(
            "SELECT namespace FROM view_cache_namespace WHERE id=1",
          )
          .get();
        if (prior?.namespace !== namespace) {
          this.db.exec("DELETE FROM view_cache");
          this.db
            .query(
              "INSERT INTO view_cache_namespace VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET namespace=excluded.namespace",
            )
            .run(namespace);
        }
      })();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** 损坏数据直接交由服务记录和降级，不补默认值或静默跳过。 */
  load(): CachedReport[] {
    return this.db
      .query<{ key: string; last_used: number; payload: string }, []>(
        "SELECT key, last_used, payload FROM view_cache ORDER BY last_used DESC, key ASC LIMIT 16",
      )
      .all()
      .map((row) => {
        const entry: unknown = JSON.parse(row.payload);
        validate(entry);
        requireShape(entry.key === row.key && entry.lastUsed === row.last_used);
        return entry;
      });
  }

  /** 成功结果和容量裁剪同时提交；运行态刷新标记不持久化。 */
  save(entry: CachedReport): void {
    validate(entry);
    const { reportStatus: _status, ...value } = entry.value;
    const payload = JSON.stringify({ ...entry, value });
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO view_cache VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_used=excluded.last_used, payload=excluded.payload",
        )
        .run(entry.key, entry.lastUsed, payload);
      this.db.exec(`DELETE FROM view_cache WHERE key NOT IN (
        SELECT key FROM view_cache ORDER BY last_used DESC, key ASC LIMIT 16
      )`);
    })();
  }

  close(): void {
    this.db.close();
  }
}
