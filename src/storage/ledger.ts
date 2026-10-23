import { Database } from "bun:sqlite";
import {
  DATABASE_BASELINE_REVISION,
  DATABASE_OTEL_ATTRIBUTION_REVISION,
  DATABASE_REQUEST_ACCOUNTS_REVISION,
  DATABASE_SCHEMA_REVISION,
  assertReadableSchema,
  migrateSchema,
} from "./schema";
import { subjectKeyFrom } from "../shared/account-subject";
import type { OtelRequestAccount } from "../shared/otel";
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
import {
  createAccountResolver,
  ref,
  type AccountMergeState,
} from "../domain/account-merge";
import {
  planRelation,
  quotaPlanHistoryKey,
  type QuotaPlanObservation,
} from "../domain/quota-plan";
import { quotaHistoryStart } from "../domain/quota";

/** toISOString 的固定宽度格式，同格式的时间按文本比较即按时间先后。 */
const isoTimestampGlob =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";

/**
 * 请求归属记录的保留期。Claude Code 默认保留 30 天会话记录，采集器离线补推也不会
 * 晚于这个窗口；归属结论已写进用量事实，过期记录只影响尚未到达的历史重放。
 */
export const REQUEST_ACCOUNT_RETENTION_DAYS = 30;
const REQUEST_ACCOUNT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** 超过这个行数才分批删除，避免一次长事务阻塞写入。 */
const REQUEST_ACCOUNT_BULK_THRESHOLD = 10_000;
const REQUEST_ACCOUNT_DELETE_BATCH = 5_000;

/**
 * 维护窗口内让估值触发器跳过变更日志的标记。维护代码在同一个事务里插入、删除，
 * 其他连接只能看到事务提交后的状态，永远不会观察到这个键。触发器定义中的键名
 * 必须与这里保持一致。
 */
export const CHANGE_LOG_SUPPRESSION_KEY = "maintenance:suppressChangeLog";
/** 每批删除的估值行数；事务保持短小，避免长时间占住写锁。 */
const VALUATION_DELETE_BATCH = 5_000;
/** 每批删除的变更日志行数。 */
const CHANGE_LOG_DELETE_BATCH = 5_000;

export interface LedgerStoreOptions {
  readonly?: boolean;
  /** 清理过期请求归属记录后的回调，只传删除条数。 */
  onRequestAccountsExpired?: (removed: number) => void;
}

/** 一个来源账户窗口的最新读数；同一采样时刻可能有多条。 */
interface ReportQuotaWindow {
  sourceId: string;
  accountId: string;
  window: string;
  /** 全部采样时间均为标准 UTC 格式时才能按文本截取。 */
  comparable: boolean;
  latest: QuotaFact[];
}

/**
 * 某一时刻读取的报表额度候选。行按 quotas() 的顺序排列，覆盖该时刻截取点之后的全部快照；
 * 只能用于同一账本版本、不早于 now 的时刻。
 */
export interface ReportQuotaCandidates {
  readonly now: string;
  readonly windows: ReadonlyMap<string, ReportQuotaWindow>;
  readonly rows: readonly {
    window: ReportQuotaWindow;
    sampledAt: string | null;
    quota: StoredQuota;
  }[];
}

/** 每个窗口按最新读数求截取点；无法比较或缺少读数时为空串，即保留全部历史。 */
function reportQuotaBounds(
  windows: ReadonlyMap<string, ReportQuotaWindow>,
  now: string,
): Map<ReportQuotaWindow, string> {
  const bounds = new Map<ReportQuotaWindow, string>();
  for (const window of windows.values()) {
    let since: string | null = null;
    if (!window.comparable || !window.latest.length) since = "";
    // 同一采样时刻可能有多条读数，取最早的截取点。
    for (const fact of since === null ? window.latest : []) {
      const start = quotaHistoryStart(fact, now);
      const bound = Number.isFinite(start) ? new Date(start).toISOString() : "";
      if (since === null || bound < since) since = bound;
    }
    bounds.set(window, since ?? "");
  }
  return bounds;
}

/**
 * 按 now 截取候选，结果与在同一账本上直接调用 reportQuotas(now) 相同。截取点随时间单调后移，
 * 所以较早读取的候选是较晚结果的超集；now 早于候选时刻时返回 null，调用方需重新读取。
 */
export function selectReportQuotas(
  candidates: ReportQuotaCandidates,
  now: string,
): StoredQuota[] | null {
  if (!(Date.parse(now) >= Date.parse(candidates.now))) return null;
  return filterReportQuotas(candidates, now);
}

function filterReportQuotas(candidates: ReportQuotaCandidates, now: string) {
  const bounds = reportQuotaBounds(candidates.windows, now);
  return candidates.rows
    .filter(
      (row) =>
        row.sampledAt === null || row.sampledAt >= bounds.get(row.window)!,
    )
    .map((row) => row.quota);
}

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
  planHistory?: readonly QuotaPlanObservation[];
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
/** 只有两个已知且确实不同的套餐才构成变化；未知、改名与细化都不是。 */
function isPlanChange(previous: string | null, next: string | null) {
  return planRelation(previous, next) === "change";
}

export class LedgerStore {
  readonly db: Database;
  private reportChangeLogAvailable: boolean | undefined;
  /** 进程内节流；重启后第一次写入会重新检查一次过期记录。 */
  private lastRequestAccountCleanupMs = 0;
  private readonly onRequestAccountsExpired?: (removed: number) => void;
  constructor(
    path: string,
    readonly book: PriceBook,
    options: LedgerStoreOptions = {},
  ) {
    this.onRequestAccountsExpired = options.onRequestAccountsExpired;
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
        revision: DATABASE_BASELINE_REVISION,
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
      {
        revision: DATABASE_REQUEST_ACCOUNTS_REVISION,
        downRevision: DATABASE_BASELINE_REVISION,
        apply: (db) =>
          db.exec(`
      CREATE TABLE IF NOT EXISTS request_accounts (
        source_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        account_uuid TEXT,
        organization_uuid TEXT,
        session_id TEXT,
        model TEXT,
        occurred_at TEXT,
        received_at TEXT NOT NULL,
        PRIMARY KEY (source_id, request_id)
      );
    `),
      },
      {
        revision: DATABASE_OTEL_ATTRIBUTION_REVISION,
        downRevision: DATABASE_REQUEST_ACCOUNTS_REVISION,
        // 归属结论改由用量事实自身保存，请求归属表只需保留一个短窗口。
        apply: (db) =>
          db.exec(`
      CREATE INDEX IF NOT EXISTS request_accounts_received_at
        ON request_accounts(received_at);
      UPDATE usage_facts
         SET payload = json_set(payload, '$.metadata.attribution', 'otel')
       WHERE instr(external_id, ':') > 0
         AND external_id NOT LIKE 'nr:%'
         AND EXISTS (
           SELECT 1 FROM request_accounts ra
            WHERE ra.source_id = usage_facts.source_id
              AND ra.request_id = substr(
                usage_facts.external_id,
                1,
                instr(usage_facts.external_id, ':') - 1
              )
              AND ra.account_uuid = usage_facts.account_id
         );
    `),
      },
      {
        revision: DATABASE_SCHEMA_REVISION,
        downRevision: DATABASE_OTEL_ATTRIBUTION_REVISION,
        // 维护性删除旧价格表估值时不能制造索引变更；抑制标记只在一个事务内可见。
        apply: (db) =>
          db.exec(`
      DROP TRIGGER IF EXISTS valuations_report_insert;
      CREATE TRIGGER valuations_report_insert
      AFTER INSERT ON valuations
      WHEN NOT EXISTS (
        SELECT 1 FROM sync_state WHERE key='${CHANGE_LOG_SUPPRESSION_KEY}'
      )
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
      DROP TRIGGER IF EXISTS valuations_report_update;
      CREATE TRIGGER valuations_report_update
      AFTER UPDATE ON valuations
      WHEN NOT EXISTS (
        SELECT 1 FROM sync_state WHERE key='${CHANGE_LOG_SUPPRESSION_KEY}'
      )
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
      DROP TRIGGER IF EXISTS valuations_report_delete;
      CREATE TRIGGER valuations_report_delete
      AFTER DELETE ON valuations
      WHEN NOT EXISTS (
        SELECT 1 FROM sync_state WHERE key='${CHANGE_LOG_SUPPRESSION_KEY}'
      )
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
  /** 值未变时不改写行，避免周期性同步状态在空闲时持续产生 WAL 写入。 */
  setState(key: string, value: unknown) {
    this.db
      .query(
        "INSERT INTO sync_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE sync_state.value IS NOT excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  /** 归档是本地展示状态，独立于上游账户快照和历史账单，不受同步覆盖。 */
  archivedAccounts(): string[] {
    return this.getState<string[]>("local:archived-accounts") ?? [];
  }

  accountMerges(): Record<string, string> {
    return this.getState<Record<string, string>>("local:account-merges") ?? {};
  }

  accountMergeVersion(): number {
    return this.getState<number>("local:account-merge-version") ?? 0;
  }

  accountMergeState(): AccountMergeState {
    const accounts = this.accounts();
    const base = createAccountResolver(accounts);
    const root = createAccountResolver(accounts, this.accountMerges());
    const aliases = this.accountAliases();
    return {
      writable: true,
      accounts: accounts
        .filter(
          (a) =>
            base(a.sourceId, a.externalId) === ref(a.sourceId, a.externalId),
        )
        .map((a) => ({
          id: ref(a.sourceId, a.externalId),
          name: aliases[ref(a.sourceId, a.externalId)] ?? a.name,
          sourceId: a.sourceId,
        })),
      links: Object.entries(this.accountMerges()).map(([id, targetId]) => {
        const account = accounts.find(
          (a) => ref(a.sourceId, a.externalId) === id,
        );
        return {
          id,
          targetId,
          rootId: account
            ? root(account.sourceId, account.externalId)
            : targetId,
        };
      }),
    };
  }

  /** 只保存可撤销的归属关系；采集事实、游标和去重键不变。 */
  setAccountMerge(id: string, targetId: string | null): AccountMergeState {
    return this.db.transaction(() => {
      const merges = { ...this.accountMerges() };
      if (targetId !== null && merges[id] === targetId)
        return this.accountMergeState();
      if (targetId === null) delete merges[id];
      else {
        const accounts = this.accountMergeState().accounts;
        if (
          !accounts.some((a) => a.id === id) ||
          !accounts.some((a) => a.id === targetId)
        )
          throw new Error("账户不存在或不是独立账户");
        if (id === targetId) throw new Error("不能合并到自身");
        if (Object.hasOwn(merges, id)) throw new Error("请先解除该账户的合并");
        if (Object.hasOwn(merges, targetId))
          throw new Error("请选择尚未合并的目标账户");
        if (
          this.accountMergeState().links.some(
            (link) => link.id === targetId && link.rootId === id,
          )
        )
          throw new Error("不能循环合并账户");
        merges[id] = targetId;
      }
      if (JSON.stringify(merges) !== JSON.stringify(this.accountMerges())) {
        this.setState("local:account-merges", merges);
        this.setState(
          "local:account-merge-version",
          this.accountMergeVersion() + 1,
        );
        this.bumpRevision();
      }
      return this.accountMergeState();
    })();
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

  /** 用户为账户指定的套餐，键为来源账户标识。 */
  accountPlans(): Record<string, string> {
    return this.getState<Record<string, string>>("local:account-plans") ?? {};
  }

  /**
   * plan 为 null 时恢复自动识别。指定套餐会改变报表中的套餐和额度预估依据，
   * 因此推进账本版本使缓存的报表重新计算。
   */
  setAccountPlan(id: string, plan: string | null): Record<string, string> {
    return this.db.transaction(() => {
      const previous = this.accountPlans();
      const plans = { ...previous };
      if (plan === null) delete plans[id];
      else plans[id] = plan;
      if (previous[id] !== plans[id]) {
        this.setState("local:account-plans", plans);
        this.bumpRevision();
      }
      return plans;
    })();
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

  /** 请求来自事件键 `${requestId}:${messageId}`；`nr:` 开头的没有请求 ID。 */
  private static requestIdOf(externalId: string): string | null {
    if (externalId.startsWith("nr:")) return null;
    const colon = externalId.indexOf(":");
    return colon > 0 ? externalId.slice(0, colon) : null;
  }

  private requestAccount(sourceId: string, requestId: string) {
    return this.db
      .query<
        { account_uuid: string | null; organization_uuid: string | null },
        [string, string]
      >(
        "SELECT account_uuid, organization_uuid FROM request_accounts WHERE source_id=? AND request_id=?",
      )
      .get(sourceId, requestId);
  }

  /**
   * OTEL 只证明请求属于哪个账户，因此覆盖按请求生效：模型映射（attribution=model）
   * 是用户明确指定的归属，优先于 OTEL。账户尚不存在时补一条占位资料，
   * 采集器之后推来的真实资料会覆盖它。
   */
  private ensureRequestAccount(
    sourceId: string,
    accountUuid: string,
    organizationUuid: string | null,
  ): boolean {
    const write = this.db
      .query(
        `INSERT INTO accounts (source_id, external_id, payload) VALUES (?, ?, ?)
         ON CONFLICT(source_id, external_id) DO NOTHING`,
      )
      .run(
        sourceId,
        accountUuid,
        JSON.stringify({
          sourceId,
          externalId: accountUuid,
          name: "Claude Code",
          platform: "anthropic",
          kind: "unknown",
          plan: null,
          parentExternalId: null,
          subjectKey: subjectKeyFrom(accountUuid, organizationUuid),
        } satisfies SourceAccount),
      );
    return write.changes > 0;
  }

  /**
   * 为一条事实查找可覆盖的 OTEL 账户；不能覆盖时返回 null。账户与传入值相同也返回，
   * 因为调用方需要把 otel 归属写进事实，才能在请求归属记录过期后继续保留结论。
   * 补写占位账户时置 created，即使事实本身是重放，账户资料的变化也要推进账本版本。
   */
  private accountOverride(
    sourceId: string,
    fact: UsageFact,
    cache: Map<
      string,
      { account_uuid: string | null; organization_uuid: string | null } | null
    >,
    state: { created: boolean },
  ): string | null {
    if (fact.metadata.attribution === "model") return null;
    const requestId = LedgerStore.requestIdOf(fact.externalId);
    if (!requestId) return null;
    if (!cache.has(requestId))
      cache.set(requestId, this.requestAccount(sourceId, requestId) ?? null);
    const mapping = cache.get(requestId);
    if (!mapping?.account_uuid) return null;
    if (
      this.ensureRequestAccount(
        sourceId,
        mapping.account_uuid,
        mapping.organization_uuid,
      )
    )
      state.created = true;
    return mapping.account_uuid;
  }

  /** 已存事实的 otel 归属；请求归属记录过期后由它保持账户不再翻转。 */
  private storedOtelAccount(
    sourceId: string,
    externalId: string,
  ): string | null {
    const row = this.db
      .query<{ account_id: string; payload: string }, [string, string]>(
        "SELECT account_id, payload FROM usage_facts WHERE source_id=? AND external_id=?",
      )
      .get(sourceId, externalId);
    if (!row) return null;
    const fact = JSON.parse(row.payload) as UsageFact;
    return fact.metadata.attribution === "otel" ? row.account_id : null;
  }

  /** 事实与当前价格表估值同步写入；内容未变的重放不产生变更。调用方负责事务。 */
  private writeFacts(
    sourceId: string,
    facts: readonly UsageFact[],
    now: string,
  ): boolean {
    let changed = false;
    const requestAccounts = new Map<
      string,
      { account_uuid: string | null; organization_uuid: string | null } | null
    >();
    const accounts = { created: false };
    for (const original of facts) {
      if (original.sourceId !== sourceId)
        throw new Error("Connector returned a foreign source record");
      let fact = original;
      const override = this.accountOverride(
        sourceId,
        original,
        requestAccounts,
        accounts,
      );
      if (override !== null) {
        fact = {
          ...original,
          accountExternalId: override,
          metadata: { ...original.metadata, attribution: "otel" },
        };
      } else if (original.metadata.attribution !== "model") {
        // 没有新映射时沿用已存结论，采集器补推旧用量不会把账户改回登录时间线。
        const stored = this.storedOtelAccount(sourceId, original.externalId);
        if (stored !== null)
          fact = {
            ...original,
            accountExternalId: stored,
            metadata: { ...original.metadata, attribution: "otel" },
          };
      }
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
    return changed || accounts.created;
  }

  /**
   * 在已有历史上记录一次套餐观测，返回历史是否改变。只有真实的套餐变化才追加边界；
   * 改名或细化改写最后一次观测的标签并保留其时间。最后一次是旧版留下的未知观测时，
   * 新套餐与它之前的已知套餐相同就去掉这条未知，恢复连续区间；不同才在当前时刻追加边界。
   */
  private observePlan(
    history: QuotaPlanObservation[],
    plan: string | null,
    observedAt: string,
  ) {
    const last = history.at(-1)!;
    if (plan === null) return false;
    if (last.plan === null) {
      const prior = history.at(-2);
      if (!prior) {
        history[history.length - 1] = { ...last, plan };
        return true;
      }
      if (isPlanChange(prior.plan, plan)) {
        history.push({ plan, observedAt, changed: true });
        return true;
      }
      history.pop();
      if (planRelation(prior.plan, plan) === "refine")
        history[history.length - 1] = { ...prior, plan };
      return true;
    }
    const relation = planRelation(last.plan, plan);
    if (relation === "refine") {
      history[history.length - 1] = { ...last, plan };
      return true;
    }
    if (relation === "change") {
      history.push({ plan, observedAt, changed: true });
      return true;
    }
    return false;
  }

  /**
   * 账户与套餐观测同事务写入；相同套餐不重复记录观测时间。
   * 只有两个不同的已知套餐之间才算套餐变化。未知不能证明套餐变了，不追加观测；
   * 从未知变为已知是补上一直成立的标签，直接改写最后一次观测，保留其时间，
   * 额度预估因此继续使用此前全部读数，不会从补上标签的时刻重新起算。
   */
  private writeAccount(account: SourceAccount, observedAt: string) {
    const key = quotaPlanHistoryKey(account.sourceId, account.externalId);
    const history = this.getState<QuotaPlanObservation[]>(key) ?? [];
    const previousObservation = history.at(-1);
    const previousRow = previousObservation
      ? null
      : this.db
          .query<{ payload: string }, [string, string]>(
            "SELECT payload FROM accounts WHERE source_id=? AND external_id=?",
          )
          .get(account.sourceId, account.externalId);
    const previousAccount = previousRow
      ? (JSON.parse(previousRow.payload) as SourceAccount)
      : null;
    const historyChanged = previousObservation
      ? this.observePlan(history, account.plan, observedAt)
      : (history.push({
          plan: account.plan,
          observedAt,
          changed: isPlanChange(previousAccount?.plan ?? null, account.plan),
        }),
        true);
    if (historyChanged) this.setState(key, history);
    // 更笼统的同一套餐不覆盖已知的具体套餐，例如凭据缺少倍数时徽标仍显示 Max 20x。
    const known = history.at(-1)?.plan ?? null;
    if (planRelation(known, account.plan) === "coarser")
      account = { ...account, plan: known };
    const write = this.db
      .query(
        "INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(source_id, external_id) DO UPDATE SET payload=excluded.payload WHERE accounts.payload IS NOT excluded.payload",
      )
      .run(account.sourceId, account.externalId, JSON.stringify(account));
    return historyChanged || write.changes > 0;
  }

  saveAccounts(
    accounts: SourceAccount[],
    observedAt = new Date().toISOString(),
  ) {
    this.db.transaction(() => {
      let changed = false;
      for (const account of accounts) {
        changed = this.writeAccount(account, observedAt) || changed;
      }
      if (changed) this.bumpRevision();
    })();
  }

  /** 在单一事务内提交来源账户快照；空快照也会删除该来源全部账户。 */
  saveAccountsSnapshot(
    sourceId: string,
    accounts: readonly SourceAccount[],
    observedAt = new Date().toISOString(),
  ) {
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
        changed = this.writeAccount(account, observedAt) || changed;
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
    const nowMs = Date.parse(now);
    const sampledByAccount = new Map<string, number>();
    for (const quota of batch.quotas) {
      const sampledMs = quota.sampledAt ? Date.parse(quota.sampledAt) : NaN;
      if (!Number.isFinite(sampledMs) || sampledMs > nowMs) continue;
      sampledByAccount.set(
        quota.accountExternalId,
        Math.max(
          sampledByAccount.get(quota.accountExternalId) ?? -Infinity,
          sampledMs,
        ),
      );
    }
    this.db.transaction(() => {
      let changed = false;
      for (const account of batch.accounts) {
        const sampledMs = sampledByAccount.get(account.externalId);
        if (
          sampledMs !== undefined &&
          this.isStalePlanChange(account, sampledMs, nowMs)
        )
          continue;
        changed = this.writeAccount(account, now) || changed;
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
    this.expireRequestAccounts(now);
  }

  /**
   * 记录 OTEL 请求到账户的映射，并把同一请求已经写入的用量改到该账户。
   * 同一请求重复到达时以先到的非空账户为准，空值只补缺，不覆盖已有值。
   */
  saveRequestAccounts(
    sourceId: string,
    records: readonly OtelRequestAccount[],
    receivedAt: string,
  ): { stored: number; rewritten: number } {
    let stored = 0;
    let rewritten = 0;
    this.db.transaction(() => {
      for (const record of records) {
        this.db
          .query(
            `INSERT INTO request_accounts
               (source_id, request_id, account_uuid, organization_uuid, session_id, model, occurred_at, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_id, request_id) DO UPDATE SET
               account_uuid = COALESCE(request_accounts.account_uuid, excluded.account_uuid),
               organization_uuid = COALESCE(request_accounts.organization_uuid, excluded.organization_uuid),
               session_id = COALESCE(request_accounts.session_id, excluded.session_id),
               model = COALESCE(request_accounts.model, excluded.model),
               occurred_at = COALESCE(request_accounts.occurred_at, excluded.occurred_at)`,
          )
          .run(
            sourceId,
            record.requestId,
            record.accountUuid,
            record.organizationUuid,
            record.sessionId,
            record.model,
            record.occurredAt,
            receivedAt,
          );
        stored += 1;
        // 后到的空值没有新信息，可能只是导出重试，不必再扫描已有事实。
        if (!record.accountUuid) continue;
        const mapping = this.requestAccount(sourceId, record.requestId);
        if (!mapping?.account_uuid) continue;
        rewritten += this.rewriteRequestFacts(
          sourceId,
          record.requestId,
          mapping.account_uuid,
          mapping.organization_uuid,
        );
      }
      if (rewritten > 0) this.bumpRevision();
    })();
    this.expireRequestAccounts(receivedAt);
    return { stored, rewritten };
  }

  /**
   * 删除超过保留期的请求归属记录。归属结论已经写进用量事实，删除只影响尚未到达的历史
   * 重放。每小时最多执行一次；大量过期行按 rowid 分批，每批使用自己的小事务。
   */
  private expireRequestAccounts(now: string) {
    const parsed = Date.parse(now);
    const currentMs = Number.isFinite(parsed) ? parsed : Date.now();
    if (
      currentMs - this.lastRequestAccountCleanupMs <
      REQUEST_ACCOUNT_CLEANUP_INTERVAL_MS
    )
      return;
    // 先记节流时间，清理失败或没有过期行时也不在下一批写入里反复扫描。
    this.lastRequestAccountCleanupMs = currentMs;
    const cutoff = new Date(
      currentMs - REQUEST_ACCOUNT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const count =
      this.db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM request_accounts WHERE received_at < ?",
        )
        .get(cutoff)?.count ?? 0;
    if (count === 0) return;
    let removed = 0;
    try {
      if (count <= REQUEST_ACCOUNT_BULK_THRESHOLD) {
        removed = this.db.transaction(
          () =>
            this.db
              .query("DELETE FROM request_accounts WHERE received_at < ?")
              .run(cutoff).changes,
        )();
      } else {
        const removeBatch = this.db.query(
          `DELETE FROM request_accounts WHERE rowid IN (
             SELECT rowid FROM request_accounts WHERE received_at < ?
             ORDER BY rowid LIMIT ?
           )`,
        );
        while (true) {
          const batch = this.db.transaction(
            () => removeBatch.run(cutoff, REQUEST_ACCOUNT_DELETE_BATCH).changes,
          )();
          removed += batch;
          if (batch < REQUEST_ACCOUNT_DELETE_BATCH) break;
        }
      }
    } catch {
      // 维护性清理失败不能影响已经写入的用量或遥测，留到下一小时再试。
      return;
    }
    if (removed > 0) this.onRequestAccountsExpired?.(removed);
  }

  /**
   * 删除非当前价格表版本的估值。读取路径只使用当前价格表，缺少估值时按事实现场计算，
   * 所以旧版本金额可以丢弃；价格表本身继续保留，回滚后仍能重新算出旧结果。
   *
   * 每批一个事务，并在事务内临时插入变更日志抑制标记：旧估值删除不应制造几十万条
   * 无意义的索引变更。批与批之间让出事件循环，避免长时间占用主线程和写锁。
   */
  async pruneStaleValuations(): Promise<number> {
    const version = priceBookKey(this.book);
    let removed = 0;
    for (;;) {
      const batch = this.db.transaction(() => {
        this.db
          .query(
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, '1')",
          )
          .run(CHANGE_LOG_SUPPRESSION_KEY);
        try {
          return this.db
            .query(
              `DELETE FROM valuations WHERE rowid IN (
                 SELECT rowid FROM valuations WHERE version <> ?
                 ORDER BY rowid LIMIT ?
               )`,
            )
            .run(version, VALUATION_DELETE_BATCH).changes;
        } finally {
          this.db
            .query("DELETE FROM sync_state WHERE key=?")
            .run(CHANGE_LOG_SUPPRESSION_KEY);
        }
      })();
      removed += batch;
      if (batch < VALUATION_DELETE_BATCH) return removed;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * 删除报表索引和累计索引都已消费的变更记录。上界取 consumedThrough 与当前最大序号
   * 的较小值，并严格删除小于它的行：最大的一行始终保留，索引不会把空日志误判成
   * “账本被清空”并触发全量重建。游标落在现存最小序号之前的情况由索引侧检测并重建。
   */
  async pruneUsageChangeLog(consumedThrough: number): Promise<number> {
    if (!Number.isFinite(consumedThrough)) return 0;
    const max =
      this.db
        .query<{ sequence: number | null }, []>(
          "SELECT MAX(change_id) AS sequence FROM usage_change_log",
        )
        .get()?.sequence ?? null;
    if (max === null) return 0;
    const upper = Math.min(Math.floor(consumedThrough), max);
    if (upper <= 0) return 0;
    let removed = 0;
    for (;;) {
      const batch = this.db.transaction(
        () =>
          this.db
            .query(
              `DELETE FROM usage_change_log WHERE change_id IN (
                 SELECT change_id FROM usage_change_log
                  WHERE change_id < ?
                  ORDER BY change_id LIMIT ?
               )`,
            )
            .run(upper, CHANGE_LOG_DELETE_BATCH).changes,
      )();
      removed += batch;
      if (batch < CHANGE_LOG_DELETE_BATCH) return removed;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** 变更日志现存的最小序号；游标落在它之前说明需要的变更已经被清理。 */
  reportUsageChangeFloor(): number | null {
    if (!this.hasReportChangeLog()) return null;
    const sequence = this.db
      .query<{ sequence: number | null }, []>(
        "SELECT MIN(change_id) AS sequence FROM usage_change_log",
      )
      .get()?.sequence;
    return sequence ?? null;
  }

  /** 请求先到、用量后到时由 writeFacts 覆盖；这里处理相反顺序。 */
  private rewriteRequestFacts(
    sourceId: string,
    requestId: string,
    accountUuid: string,
    organizationUuid: string | null,
  ): number {
    const prefix = `${requestId}:`;
    // advisor 子事件的键是 `${requestId}:${messageId}:advisor:${n}`，同一前缀即可覆盖。
    // 用主键前缀范围而不是 substr，避免每次 OTEL 事件扫描该来源的全部历史事实。
    const rows = this.db
      .query<
        { external_id: string; payload: string },
        [string, string, string]
      >(
        "SELECT external_id, payload FROM usage_facts WHERE source_id=? AND external_id>=? AND external_id<?",
      )
      .all(sourceId, prefix, `${prefix}\u{ffff}`);
    let rewritten = 0;
    for (const row of rows) {
      // `nr:` 事件按会话与消息去重，没有请求 ID 可与 OTEL 对应。
      if (row.external_id.startsWith("nr:")) continue;
      const fact = JSON.parse(row.payload) as UsageFact;
      if (fact.metadata.attribution === "model") continue;
      // 账户相同时也要补上 otel 标记，否则请求归属记录过期后会退回传入的账户。
      const payload = JSON.stringify({
        ...fact,
        accountExternalId: accountUuid,
        metadata: { ...fact.metadata, attribution: "otel" },
      });
      if (payload === row.payload) continue;
      this.ensureRequestAccount(sourceId, accountUuid, organizationUuid);
      this.db
        .query(
          "UPDATE usage_facts SET account_id=?, payload=? WHERE source_id=? AND external_id=?",
        )
        .run(accountUuid, payload, sourceId, row.external_id);
      rewritten += 1;
    }
    return rewritten;
  }

  /** 额度采样不得早于已观察的套餐边界或已有快照；未来日期不能充当水位。 */
  private isStalePlanChange(
    account: SourceAccount,
    sampledMs: number,
    nowMs: number,
  ) {
    const priorRow = this.db
      .query<{ payload: string }, [string, string]>(
        "SELECT payload FROM accounts WHERE source_id=? AND external_id=?",
      )
      .get(account.sourceId, account.externalId);
    if (
      !priorRow ||
      !isPlanChange(
        (JSON.parse(priorRow.payload) as SourceAccount).plan,
        account.plan,
      )
    )
      return false;
    const latestObservation = this.getState<QuotaPlanObservation[]>(
      quotaPlanHistoryKey(account.sourceId, account.externalId),
    )?.at(-1);
    const observedMs = latestObservation
      ? Date.parse(latestObservation.observedAt)
      : NaN;
    if (Number.isFinite(observedMs) && sampledMs <= observedMs) return true;
    const rows = this.db
      .query<{ sampled_at: string }, [string, string]>(
        "SELECT sampled_at FROM quota_snapshots WHERE source_id=? AND account_id=? AND sampled_at IS NOT NULL",
      )
      .all(account.sourceId, account.externalId);
    let latest = -Infinity;
    for (const row of rows) {
      const at = Date.parse(row.sampled_at);
      if (Number.isFinite(at) && at <= nowMs) latest = Math.max(latest, at);
    }
    return sampledMs <= latest;
  }

  /** 数据版本和事实同事务提交；相同页面重放不使报表缓存失效。 */
  revision(): number {
    return this.getState<number>("ledger:dataRevision") ?? 0;
  }

  /** 最近成功收到采集批次的时间，包含幂等重试；不代表用量发生时间或报表计算时间。 */
  lastIngestAt(): string | null {
    const rows = this.db
      .query<{ value: string }, []>(
        "SELECT value FROM sync_state WHERE key LIKE '%:ingest:last'",
      )
      .all();
    let latest: string | null = null;
    for (const row of rows) {
      const at: unknown = JSON.parse(row.value)?.at;
      if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) continue;
      if (latest === null || Date.parse(at) > Date.parse(latest)) latest = at;
    }
    return latest;
  }

  private bumpRevision() {
    const revision = this.revision() + 1;
    this.setState("ledger:dataRevision", revision);
    return revision;
  }

  private sourceAccounts(): SourceAccount[] {
    return this.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM accounts ORDER BY source_id, external_id",
      )
      .all()
      .map((row) => JSON.parse(row.payload) as SourceAccount);
  }

  /**
   * 报表使用的账户资料。用户为 Claude 账户指定的套餐覆盖上游套餐，指定套餐即说明是订阅账户；
   * 手动套餐只有 Claude 的取值，其他平台的账户不受影响。
   */
  accounts(): SourceAccount[] {
    const plans = this.accountPlans();
    return this.sourceAccounts().map((account) => {
      const plan =
        account.platform === "anthropic"
          ? plans[ref(account.sourceId, account.externalId)]
          : undefined;
      return plan
        ? {
            ...account,
            plan,
            kind: account.kind === "unknown" ? "subscription" : account.kind,
          }
        : account;
    });
  }
  quotas(): StoredQuota[] {
    return this.storedQuotas(
      this.db
        .query<{ payload: string; collected_at: string }, []>(
          "SELECT payload, collected_at FROM quota_snapshots ORDER BY sampled_at, collected_at, rowid",
        )
        .all(),
    );
  }

  /**
   * 报表额度视图需要的快照，顺序与 quotas() 相同。每个来源账户窗口按最新读数截取，
   * 更早的历史不影响结果，跳过后读取量不随采样持续增长。时间按文本比较，
   * 非标准 UTC 格式的采样时间无法比较，所在窗口保留全部历史。
   */
  reportQuotas(now: string): StoredQuota[] {
    return filterReportQuotas(this.reportQuotaCandidates(now), now);
  }

  /**
   * 读取 now 时刻截取点之后的额度快照，连同各窗口的最新读数，供 selectReportQuotas 按
   * 不早于 now 的时刻再次截取。截取点只会随时间后移，同一账本版本内候选可以重复使用。
   */
  reportQuotaCandidates(now: string): ReportQuotaCandidates {
    const groups = this.db
      .query<
        {
          source_id: string;
          account_id: string;
          window: string;
          odd: number | null;
          payload: string | null;
        },
        [string]
      >(
        `
        WITH latest AS (
          SELECT source_id, account_id, window, MAX(sampled_at) AS sampled_at,
            SUM(sampled_at NOT GLOB ?1) AS odd
          FROM quota_snapshots GROUP BY source_id, account_id, window
        )
        SELECT l.source_id, l.account_id, l.window, l.odd, q.payload FROM latest l
        LEFT JOIN quota_snapshots q ON q.source_id=l.source_id AND q.account_id=l.account_id
          AND q.window=l.window AND q.sampled_at=l.sampled_at
      `,
      )
      .all(isoTimestampGlob);
    const windows = new Map<string, ReportQuotaWindow>();
    for (const group of groups) {
      const key = JSON.stringify([
        group.source_id,
        group.account_id,
        group.window,
      ]);
      let window = windows.get(key);
      if (!window) {
        window = {
          sourceId: group.source_id,
          accountId: group.account_id,
          window: group.window,
          comparable: !group.odd,
          latest: [],
        };
        windows.set(key, window);
      }
      if (group.payload)
        window.latest.push(JSON.parse(group.payload) as QuotaFact);
    }
    const bounds = reportQuotaBounds(windows, now);
    const rows = this.db
      .query<
        {
          source_id: string;
          account_id: string;
          window: string;
          sampled_at: string | null;
          payload: string;
          collected_at: string;
        },
        [string]
      >(
        `
          WITH bound AS (
            SELECT json_extract(value, '$[0]') AS source_id,
              json_extract(value, '$[1]') AS account_id,
              json_extract(value, '$[2]') AS window,
              json_extract(value, '$[3]') AS since
            FROM json_each(?)
          )
          SELECT q.source_id, q.account_id, q.window, q.sampled_at, q.payload, q.collected_at
          FROM bound b
          JOIN quota_snapshots q ON q.source_id=b.source_id AND q.account_id=b.account_id
            AND q.window=b.window AND (q.sampled_at IS NULL OR q.sampled_at >= b.since)
          ORDER BY q.sampled_at, q.collected_at, q.rowid
        `,
      )
      .all(
        JSON.stringify(
          [...windows.values()].map((window) => [
            window.sourceId,
            window.accountId,
            window.window,
            bounds.get(window)!,
          ]),
        ),
      );
    const quotas = this.storedQuotas(rows);
    return {
      now,
      windows,
      rows: rows.map((row, index) => ({
        window: windows.get(
          JSON.stringify([row.source_id, row.account_id, row.window]),
        )!,
        sampledAt: row.sampled_at,
        quota: quotas[index]!,
      })),
    };
  }

  /**
   * 用户指定的套餐只填补未知的套餐观测，不改写已知套餐，也不新增观测：
   * 补上标签不构成套餐变化，额度预估继续使用全部读数；真实的套餐变化仍以上游观测为准。
   */
  private storedQuotas(
    rows: readonly { payload: string; collected_at: string }[],
  ): StoredQuota[] {
    const histories = new Map<string, QuotaPlanObservation[] | null>();
    const plans = this.accountPlans();
    // 合并后界面在目标账户上设置套餐，被合并账户的额度历史也按目标的设置补全。
    const root = Object.keys(plans).length
      ? createAccountResolver(this.sourceAccounts(), this.accountMerges())
      : null;
    return rows.map((row) => {
      const fact = JSON.parse(row.payload) as QuotaFact;
      const key = quotaPlanHistoryKey(fact.sourceId, fact.accountExternalId);
      if (!histories.has(key)) {
        const history = this.getState<QuotaPlanObservation[]>(key);
        const plan = root
          ? (plans[ref(fact.sourceId, fact.accountExternalId)] ??
            plans[root(fact.sourceId, fact.accountExternalId)])
          : undefined;
        histories.set(
          key,
          history && plan
            ? history.map((entry) =>
                entry.plan === null ? { ...entry, plan } : entry,
              )
            : history,
        );
      }
      const planHistory = histories.get(key);
      return {
        fact,
        collectedAt: row.collected_at,
        ...(planHistory ? { planHistory } : {}),
      };
    });
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
