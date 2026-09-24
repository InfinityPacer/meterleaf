import { Database } from "bun:sqlite";
import {
  DATABASE_SCHEMA_REVISION,
  assertReadableSchema,
  migrateSchema,
} from "./schema";
import Decimal from "decimal.js";
import { createHash } from "node:crypto";
import type {
  QuotaFact,
  SourceAccount,
  UsageFact,
  UsagePage,
} from "../domain/connector";
import {
  priceBookKey,
  valueUsage,
  type PriceBook,
  type Valuation,
} from "../domain/pricing";
import { withSub2ApiImageUsage } from "../connectors/sub2api-usage";

export interface StoredUsage {
  fact: UsageFact;
  valuation: Valuation;
}

/** 派生索引消费事实最终状态；删除事件保留身份，不能由空查询结果推断整库删除。 */
export interface StoredUsageChanges {
  tracked: boolean;
  lastSequence: number;
  changes: {
    sourceId: string;
    externalId: string;
    usage: StoredUsage | null;
  }[];
}
/** 必须在同一个来源只读事务内创建并耗尽流，使记录与检查点属于同一快照。 */
export interface StoredUsageChangeStream extends Omit<
  StoredUsageChanges,
  "changes"
> {
  changes: Iterable<StoredUsageChanges["changes"][number]>;
}
export interface StoredQuota {
  fact: QuotaFact;
  collectedAt: string;
}

/** 报表索引使用的稳定 primitive；金额继续以十进制字符串跨线程传递。 */
export interface ReportUsageMetric {
  sourceId: string;
  externalId: string;
  occurredAt: string;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  apiUsd: string | null;
  subscriptionUsd: string | null;
  credits: string | null;
}

export interface ReportUsageChange {
  sequence: number;
  sourceId: string;
  externalId: string;
  metric: ReportUsageMetric | null;
}

export interface ReportUsageChanges {
  tracked: boolean;
  lastSequence: number;
  changes: ReportUsageChange[];
}
/** 累计索引逐行消费计量修订，避免为历史回扫保留全部事实对象。 */
export interface ReportUsageChangeStream extends Omit<
  ReportUsageChanges,
  "changes"
> {
  changes: Iterable<ReportUsageChange>;
}

interface ReportMetricRow {
  source_id: string;
  external_id: string;
  occurred_at: string;
  payload: string | null;
  input: number | string | null;
  cache_read: number | string | null;
  cache_write: number | string | null;
  output: number | string | null;
  api_usd: string | number | null;
  subscription_usd: string | number | null;
  credits: string | number | null;
  has_fact: number;
  has_valuation: number;
}

interface ReportChangeRow extends ReportMetricRow {
  change_id: number;
}

function reportToken(value: number | string | null) {
  if (value === null) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function reportAmount(value: string | number | null) {
  if (value === null) return null;
  const text = String(value);
  if (!/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return null;
  try {
    const amount = new Decimal(text);
    return amount.isFinite() ? amount.toString() : null;
  } catch {
    return null;
  }
}

/** 单一 SQLite 所有者保证批次事实、独立费用与游标同时可见。金额始终保存为十进制字符串。 */
export class LedgerStore {
  readonly db: Database;
  private reportChangeLogAvailable: boolean | undefined;
  constructor(
    path: string,
    readonly book: PriceBook,
    options: { readonly?: boolean } = {},
  ) {
    if (options.readonly) {
      this.db = new Database(path, { readonly: true, strict: true });
      assertReadableSchema(this.db, "ledger");
      this.db.exec("PRAGMA busy_timeout=5000;");
      return;
    }
    this.db = new Database(path, { create: true, strict: true });
    assertReadableSchema(this.db, "ledger");
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    migrateSchema(this.db, "ledger", [
      {
        revision: DATABASE_SCHEMA_REVISION,
        downRevision: null,
        apply: (db) =>
          db.exec(`
      CREATE TABLE IF NOT EXISTS price_books (version TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_facts (
        source_id TEXT NOT NULL, external_id TEXT NOT NULL, account_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL, payload TEXT NOT NULL, first_seen TEXT NOT NULL,
        PRIMARY KEY (source_id, external_id));
      CREATE INDEX IF NOT EXISTS usage_time ON usage_facts(occurred_at, source_id, external_id);
      CREATE INDEX IF NOT EXISTS usage_account ON usage_facts(source_id, account_id, occurred_at);
      CREATE TABLE IF NOT EXISTS valuations (
        source_id TEXT NOT NULL, external_id TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (source_id, external_id, version),
        FOREIGN KEY (source_id, external_id) REFERENCES usage_facts(source_id, external_id));
      CREATE TABLE IF NOT EXISTS accounts (source_id TEXT NOT NULL, external_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source_id, external_id));
      CREATE TABLE IF NOT EXISTS quota_snapshots (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, account_id TEXT NOT NULL, window TEXT NOT NULL, sampled_at TEXT, payload TEXT NOT NULL, collected_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS quota_account ON quota_snapshots(source_id, account_id, window, sampled_at);
      CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_change_log (
        change_id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_change_revision ON usage_change_log(change_id, revision);
      CREATE TRIGGER IF NOT EXISTS usage_facts_report_insert
      AFTER INSERT ON usage_facts
      BEGIN
        INSERT INTO usage_change_log (revision, source_id, external_id)
        VALUES (
          COALESCE(
            (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='ledger:dataRevision'),
            0
          ),
          NEW.source_id,
          NEW.external_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS usage_facts_report_update
      AFTER UPDATE OF account_id, occurred_at, payload ON usage_facts
      BEGIN
        INSERT INTO usage_change_log (revision, source_id, external_id)
        VALUES (
          COALESCE(
            (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='ledger:dataRevision'),
            0
          ),
          NEW.source_id,
          NEW.external_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS usage_facts_report_delete
      AFTER DELETE ON usage_facts
      BEGIN
        INSERT INTO usage_change_log (revision, source_id, external_id)
        VALUES (
          COALESCE(
            (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='ledger:dataRevision'),
            0
          ),
          OLD.source_id,
          OLD.external_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS valuations_report_insert
      AFTER INSERT ON valuations
      BEGIN
        INSERT INTO usage_change_log (revision, source_id, external_id)
        VALUES (
          COALESCE(
            (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='ledger:dataRevision'),
            0
          ),
          NEW.source_id,
          NEW.external_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS valuations_report_update
      AFTER UPDATE ON valuations
      BEGIN
        INSERT INTO usage_change_log (revision, source_id, external_id)
        VALUES (
          COALESCE(
            (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='ledger:dataRevision'),
            0
          ),
          NEW.source_id,
          NEW.external_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS valuations_report_delete
      AFTER DELETE ON valuations
      BEGIN
        INSERT INTO usage_change_log (revision, source_id, external_id)
        VALUES (
          COALESCE(
            (SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='ledger:dataRevision'),
            0
          ),
          OLD.source_id,
          OLD.external_id
        );
      END;
    `),
      },
    ]);
    const existing = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM price_books WHERE version=?",
      )
      .get(priceBookKey(book));
    const payload = JSON.stringify(book);
    if (existing && existing.payload !== payload) {
      this.db.close();
      throw new Error("Price book contents changed without a new version");
    }
    this.db
      .query("INSERT OR IGNORE INTO price_books VALUES (?, ?)")
      .run(priceBookKey(book), payload);
  }

  /** 账本记录过的价格表原文；只用于标注旧结果，不参与重新计价。 */
  storedPriceBook(key: string): PriceBook | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM price_books WHERE version=?",
      )
      .get(key);
    return row ? (JSON.parse(row.payload) as PriceBook) : null;
  }

  getState<T>(key: string): T | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM sync_state WHERE key=?",
      )
      .get(key);
    return row ? (JSON.parse(row.value) as T) : null;
  }
  setState(key: string, value: unknown) {
    this.db
      .query(
        "INSERT INTO sync_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  /** 归档是本地展示状态，独立于上游账户快照和历史账单，不受同步覆盖。 */
  archivedAccounts(): string[] {
    return this.getState<string[]>("local:archived-accounts") ?? [];
  }

  /** 删除展示只保存稳定 ID，账单、额度历史与上游账户均不删除。 */
  hiddenAccounts(): string[] {
    return this.getState<string[]>("local:hidden-accounts") ?? [];
  }

  hideAccount(id: string): string[] {
    return this.db.transaction(() => {
      const ids = [...new Set([...this.hiddenAccounts(), id])];
      this.setState("local:hidden-accounts", ids);
      return ids;
    })();
  }

  /** 用户设置的账户别名，只影响展示；上游账户名称仍按同步结果保存。 */
  accountAliases(): Record<string, string> {
    return this.getState<Record<string, string>>("local:account-aliases") ?? {};
  }

  /** alias 为 null 时恢复上游名称。 */
  setAccountAlias(id: string, alias: string | null): Record<string, string> {
    return this.db.transaction(() => {
      const aliases = { ...this.accountAliases() };
      if (alias === null) delete aliases[id];
      else aliases[id] = alias;
      this.setState("local:account-aliases", aliases);
      return aliases;
    })();
  }

  setAccountArchived(id: string, archived: boolean): string[] {
    return this.db.transaction(() => {
      const ids = new Set(this.archivedAccounts());
      if (archived) ids.add(id);
      else ids.delete(id);
      const result = [...ids];
      this.setState("local:archived-accounts", result);
      return result;
    })();
  }

  savePage(
    sourceId: string,
    mode: "incremental" | "sweep",
    page: UsagePage,
    now: string,
  ) {
    this.db.transaction(() => {
      const changed = this.writeFacts(sourceId, page.records, now);
      if (changed) {
        this.bumpRevision();
      }
      this.setState(`${sourceId}:${mode}:cursor`, page.nextCursor);
      this.setState(`${sourceId}:${mode}:caughtUp`, !page.hasMore);
    })();
  }

  /** 事实与当前价格表估值同步写入；内容未变的重放不产生变更。调用方负责事务。 */
  private writeFacts(
    sourceId: string,
    facts: readonly UsageFact[],
    now: string,
  ): boolean {
    let changed = false;
    for (const fact of facts) {
      if (fact.sourceId !== sourceId)
        throw new Error("Connector returned a foreign source record");
      const factWrite = this.db
        .query(
          `INSERT INTO usage_facts VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, external_id) DO UPDATE SET account_id=excluded.account_id, occurred_at=excluded.occurred_at, payload=excluded.payload WHERE usage_facts.payload<>excluded.payload`,
        )
        .run(
          sourceId,
          fact.externalId,
          fact.accountExternalId,
          fact.occurredAt,
          JSON.stringify(fact),
          now,
        );
      const valuationWrite = this.db
        .query(
          `INSERT INTO valuations VALUES (?, ?, ?, ?) ON CONFLICT(source_id, external_id, version) DO UPDATE SET payload=excluded.payload WHERE valuations.payload<>excluded.payload`,
        )
        .run(
          sourceId,
          fact.externalId,
          priceBookKey(this.book),
          JSON.stringify(valueUsage(withSub2ApiImageUsage(fact), this.book)),
        );
      if (factWrite.changes > 0 || valuationWrite.changes > 0) {
        changed = true;
      }
    }
    return changed;
  }

  saveAccounts(accounts: SourceAccount[]) {
    this.db.transaction(() => {
      let changed = false;
      for (const account of accounts) {
        const write = this.db
          .query(
            "INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(source_id, external_id) DO UPDATE SET payload=excluded.payload WHERE accounts.payload<>excluded.payload",
          )
          .run(account.sourceId, account.externalId, JSON.stringify(account));
        changed ||= write.changes > 0;
      }
      if (changed) this.bumpRevision();
    })();
  }

  /** 在单一事务内提交来源账户快照；空快照也会删除该来源全部账户。 */
  saveAccountsSnapshot(sourceId: string, accounts: readonly SourceAccount[]) {
    for (const account of accounts) {
      if (account.sourceId !== sourceId)
        throw new Error("Connector returned a foreign source account");
    }

    this.db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS account_snapshot_ids (external_id TEXT PRIMARY KEY)",
    );
    this.db.transaction(() => {
      this.db.query("DELETE FROM account_snapshot_ids").run();
      let changed = false;
      for (const account of accounts) {
        const write = this.db
          .query(
            "INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(source_id, external_id) DO UPDATE SET payload=excluded.payload WHERE accounts.payload<>excluded.payload",
          )
          .run(account.sourceId, account.externalId, JSON.stringify(account));
        changed ||= write.changes > 0;
        this.db
          .query("INSERT OR IGNORE INTO account_snapshot_ids VALUES (?)")
          .run(account.externalId);
      }
      const removed = this.db
        .query(
          `DELETE FROM accounts
           WHERE source_id=?
             AND NOT EXISTS (
               SELECT 1 FROM account_snapshot_ids
               WHERE account_snapshot_ids.external_id=accounts.external_id
             )`,
        )
        .run(sourceId);
      changed ||= removed.changes > 0;
      if (changed) this.bumpRevision();
    })();
  }

  saveQuotas(quotas: QuotaFact[], collectedAt: string) {
    this.db.transaction(() => {
      if (this.writeQuotas(quotas, collectedAt)) this.bumpRevision();
    })();
  }

  /** 快照按内容寻址，重复上报同一采样只保留一份。调用方负责事务。 */
  private writeQuotas(quotas: readonly QuotaFact[], collectedAt: string) {
    let changed = false;
    for (const fact of quotas) {
      const id = createHash("sha256")
        .update(JSON.stringify(fact))
        .digest("hex");
      const write = this.db
        .query(
          "INSERT OR IGNORE INTO quota_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          fact.sourceId,
          fact.accountExternalId,
          fact.window,
          fact.sampledAt,
          JSON.stringify(fact),
          collectedAt,
        );
      changed ||= write.changes > 0;
    }
    return changed;
  }

  /**
   * 推送来源的一个批次在单一事务内提交：账户按条更新（不是完整快照，不删除旧账户），
   * 用量与估值按 externalId 幂等写入，额度快照按内容去重。成功返回后采集器才可确认送达。
   */
  saveIngestBatch(
    sourceId: string,
    batch: {
      batchId: string;
      collector: { name: string; version: string };
      accounts: readonly SourceAccount[];
      usage: readonly UsageFact[];
      quotas: readonly QuotaFact[];
    },
    now: string,
  ) {
    for (const item of [...batch.accounts, ...batch.quotas])
      if (item.sourceId !== sourceId)
        throw new Error("Ingest batch contains a foreign source item");
    this.db.transaction(() => {
      let changed = false;
      for (const account of batch.accounts) {
        const write = this.db
          .query(
            "INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(source_id, external_id) DO UPDATE SET payload=excluded.payload WHERE accounts.payload<>excluded.payload",
          )
          .run(sourceId, account.externalId, JSON.stringify(account));
        changed ||= write.changes > 0;
      }
      changed = this.writeFacts(sourceId, batch.usage, now) || changed;
      changed = this.writeQuotas(batch.quotas, now) || changed;
      this.setState(`${sourceId}:ingest:last`, {
        at: now,
        batchId: batch.batchId,
        collector: batch.collector,
      });
      if (changed) this.bumpRevision();
    })();
  }

  /** 数据版本和事实同事务提交；相同页面重放不使报表缓存失效。 */
  revision(): number {
    return this.getState<number>("ledger:dataRevision") ?? 0;
  }

  private bumpRevision() {
    const revision = this.revision() + 1;
    this.setState("ledger:dataRevision", revision);
    return revision;
  }

  accounts(): SourceAccount[] {
    return this.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM accounts ORDER BY source_id, external_id",
      )
      .all()
      .map((row) => JSON.parse(row.payload) as SourceAccount);
  }
  quotas(): StoredQuota[] {
    return this.db
      .query<{ payload: string; collected_at: string }, []>(
        "SELECT payload, collected_at FROM quota_snapshots ORDER BY sampled_at, collected_at",
      )
      .all()
      .map((row) => ({
        fact: JSON.parse(row.payload) as QuotaFact,
        collectedAt: row.collected_at,
      }));
  }

  /** 返回已落盘的来源事实数量；不把额度快照或本地估值重复计入。 */
  countUsage(sourceId: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM usage_facts WHERE source_id=?",
      )
      .get(sourceId);
    return row?.count ?? 0;
  }

  /** 时间下界包含周期起点；缺少新价格版本时读取估值，不覆盖已有版本账单。 */
  usage(from?: string, to?: string): StoredUsage[] {
    return this.db
      .query<
        { payload: string; valuation: string | null },
        [string, string, string]
      >(
        `SELECT u.payload, v.payload AS valuation FROM usage_facts u LEFT JOIN valuations v ON v.source_id=u.source_id AND v.external_id=u.external_id AND v.version=? WHERE u.occurred_at>=? AND u.occurred_at<=? ORDER BY u.occurred_at DESC, u.external_id DESC`,
      )
      .all(priceBookKey(this.book), from ?? "", to ?? "9999")
      .map((row) => {
        const fact = JSON.parse(row.payload) as UsageFact;
        return {
          fact,
          valuation: row.valuation
            ? (JSON.parse(row.valuation) as Valuation)
            : valueUsage(withSub2ApiImageUsage(fact), this.book),
        };
      });
  }

  /** 初次构建派生索引逐行解析，调用者在只读事务内消费以固定事实与游标边界。 */
  *reportUsages(): Generator<StoredUsage> {
    const statement = this.db.prepare<
      { payload: string; valuation: string | null },
      [string]
    >(
      `
      SELECT u.payload, v.payload AS valuation FROM usage_facts u
      LEFT JOIN valuations v ON v.source_id=u.source_id AND v.external_id=u.external_id AND v.version=?
      ORDER BY u.source_id, u.external_id
    `,
    );
    try {
      for (const row of statement.iterate(priceBookKey(this.book)))
        yield this.storedUsage(row);
    } finally {
      statement.finalize();
    }
  }

  private storedUsage(row: {
    payload: string;
    valuation: string | null;
  }): StoredUsage {
    const fact = JSON.parse(row.payload) as UsageFact;
    return {
      fact,
      valuation: row.valuation
        ? (JSON.parse(row.valuation) as Valuation)
        : valueUsage(withSub2ApiImageUsage(fact), this.book),
    };
  }

  /** 同一事实的多次变更合并为最终状态，包含估值修订与删除，不依赖来源自增 ID。 */
  storedUsageChanges(afterSequence: number): StoredUsageChanges {
    const stream = this.storedUsageChangeStream(afterSequence);
    return { ...stream, changes: [...stream.changes] };
  }

  /** 变更身份由 SQL 合并，最终事实逐行解码；调用者负责来源快照事务。 */
  storedUsageChangeStream(afterSequence: number): StoredUsageChangeStream {
    if (!this.hasReportChangeLog())
      return { tracked: false, lastSequence: 0, changes: [] };
    const state = this.reportUsageChangeState();
    // 中断迭代会结束底层语句；流独占 prepare 句柄，不能污染 db.query 的复用缓存。
    const statement = this.db.prepare<
      {
        source_id: string;
        external_id: string;
        payload: string | null;
        valuation: string | null;
      },
      [number, number, string]
    >(
      `
      WITH changed AS (
        SELECT source_id, external_id FROM usage_change_log WHERE change_id>? AND change_id<=?
        GROUP BY source_id, external_id
      )
      SELECT c.source_id, c.external_id, u.payload, v.payload AS valuation
      FROM changed c LEFT JOIN usage_facts u ON u.source_id=c.source_id AND u.external_id=c.external_id
      LEFT JOIN valuations v ON v.source_id=c.source_id AND v.external_id=c.external_id AND v.version=?
    `,
    );
    const store = this;
    return {
      ...state,
      changes: (function* () {
        try {
          for (const row of statement.iterate(
            afterSequence,
            state.lastSequence,
            priceBookKey(store.book),
          ))
            yield {
              sourceId: row.source_id,
              externalId: row.external_id,
              usage:
                row.payload === null
                  ? null
                  : store.storedUsage({
                      payload: row.payload,
                      valuation: row.valuation,
                    }),
            };
        } finally {
          statement.finalize();
        }
      })(),
    };
  }

  private hasReportChangeLog() {
    if (this.reportChangeLogAvailable !== undefined)
      return this.reportChangeLogAvailable;
    this.reportChangeLogAvailable = Boolean(
      this.db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get("usage_change_log"),
    );
    return this.reportChangeLogAvailable;
  }

  private reportMetricFromRow(row: ReportMetricRow): ReportUsageMetric {
    let apiUsd = reportAmount(row.api_usd);
    let subscriptionUsd = reportAmount(row.subscription_usd);
    let credits = reportAmount(row.credits);
    // 自定义价格版本可能还没有为历史事实落盘估值，只解析这条缺失估值的事实。
    if (!row.has_valuation && row.payload) {
      const fact = JSON.parse(row.payload) as UsageFact;
      const valuation = valueUsage(withSub2ApiImageUsage(fact), this.book);
      apiUsd = valuation.apiUsd.amount;
      subscriptionUsd = valuation.subscriptionUsd.amount;
      credits = valuation.credits.amount;
    }
    return {
      sourceId: row.source_id,
      externalId: row.external_id,
      occurredAt: row.occurred_at,
      input: reportToken(row.input),
      cacheRead: reportToken(row.cache_read),
      cacheWrite: reportToken(row.cache_write),
      output: reportToken(row.output),
      apiUsd,
      subscriptionUsd,
      credits,
    };
  }

  private reportMetricSelect(
    source = "u.source_id",
    external = "u.external_id",
  ) {
    return `
      ${source} AS source_id,
      ${external} AS external_id,
      u.occurred_at,
      CASE WHEN u.source_id IS NOT NULL AND v.source_id IS NULL
        THEN u.payload ELSE NULL END AS payload,
      json_extract(u.payload, '$.tokens.input') AS input,
      json_extract(u.payload, '$.tokens.cacheRead') AS cache_read,
      json_extract(u.payload, '$.tokens.cacheWrite') AS cache_write,
      json_extract(u.payload, '$.tokens.output') AS output,
      json_extract(v.payload, '$.apiUsd.amount') AS api_usd,
      json_extract(v.payload, '$.subscriptionUsd.amount') AS subscription_usd,
      json_extract(v.payload, '$.credits.amount') AS credits,
      CASE WHEN u.source_id IS NOT NULL THEN 1 ELSE 0 END AS has_fact,
      CASE WHEN v.source_id IS NOT NULL THEN 1 ELSE 0 END AS has_valuation`;
  }

  /** 首次建立全历史指标时只提取 primitive，不把每行事实 JSON 解析成领域对象。 */
  reportUsageMetrics(): ReportUsageMetric[] {
    return [...this.reportUsageMetricStream()];
  }

  /** 计量行按来源快照逐条返回，允许累计索引边读取边累加和落盘。 */
  *reportUsageMetricStream(): Generator<ReportUsageMetric> {
    const version = priceBookKey(this.book);
    const statement = this.db.prepare<ReportMetricRow, [string]>(
      `SELECT ${this.reportMetricSelect()}
         FROM usage_facts u
         LEFT JOIN valuations v
           ON v.source_id=u.source_id
          AND v.external_id=u.external_id
          AND v.version=?
         ORDER BY u.occurred_at, u.source_id, u.external_id`,
    );
    try {
      for (const row of statement.iterate(version))
        yield this.reportMetricFromRow(row);
    } finally {
      statement.finalize();
    }
  }

  /** 使用 SQLite 跨连接版本号校验账本是否改变，不扫描或解析 payload。 */
  reportFingerprint() {
    const row = this.db
      .query<{ data_version: number }, []>("PRAGMA data_version")
      .get();
    return String(row?.data_version ?? 0);
  }

  /** 返回变更日志是否可用及当前游标，不扫描事实或估值内容。 */
  reportUsageChangeState(): Pick<
    ReportUsageChanges,
    "tracked" | "lastSequence"
  > {
    if (!this.hasReportChangeLog()) return { tracked: false, lastSequence: 0 };
    const sequence = this.db
      .query<{ sequence: number | null }, []>(
        "SELECT MAX(change_id) AS sequence FROM usage_change_log",
      )
      .get()?.sequence;
    return { tracked: true, lastSequence: sequence ?? 0 };
  }

  /** 返回上次序号之后每个事实的最终状态，修正可先移除旧指标再写入新指标。 */
  reportUsageChanges(afterSequence: number): ReportUsageChanges {
    const stream = this.reportUsageChangeStream(afterSequence);
    return { ...stream, changes: [...stream.changes] };
  }

  /** 检查点先固定，调用者在来源事务内消费指标流和提交派生索引。 */
  reportUsageChangeStream(afterSequence: number): ReportUsageChangeStream {
    if (!this.hasReportChangeLog())
      return { tracked: false, lastSequence: 0, changes: [] };
    const state = this.reportUsageChangeState();
    const statement = this.db.prepare<
      ReportChangeRow,
      [number, number, string]
    >(
      `WITH changed AS (
           SELECT source_id, external_id, MAX(change_id) AS change_id
           FROM usage_change_log
           WHERE change_id>? AND change_id<=?
           GROUP BY source_id, external_id
         )
         SELECT changed.change_id,
                ${this.reportMetricSelect(
                  "changed.source_id",
                  "changed.external_id",
                )}
         FROM changed
         LEFT JOIN usage_facts u
           ON u.source_id=changed.source_id
          AND u.external_id=changed.external_id
         LEFT JOIN valuations v
           ON v.source_id=u.source_id
          AND v.external_id=u.external_id
          AND v.version=?
         ORDER BY changed.change_id`,
    );
    const store = this;
    return {
      ...state,
      changes: (function* () {
        try {
          for (const row of statement.iterate(
            afterSequence,
            state.lastSequence,
            priceBookKey(store.book),
          ))
            yield {
              sequence: row.change_id,
              sourceId: row.source_id,
              externalId: row.external_id,
              metric: row.has_fact ? store.reportMetricFromRow(row) : null,
            };
        } finally {
          statement.finalize();
        }
      })(),
    };
  }

  close() {
    this.db.close();
  }
}
