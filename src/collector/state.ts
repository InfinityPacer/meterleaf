import { Database } from "bun:sqlite";
import type {
  IngestAccount,
  IngestManagedScope,
  IngestUsage,
} from "../shared/ingest";
import type { CodexOtelEvent, OtelRequestAccount } from "../shared/otel";
import {
  attribute,
  type AccountSegment,
  type HistoryBinding,
  type LoginHint,
} from "./attribution";
import {
  UNATTRIBUTED_ACCOUNT_ID,
  unattributedAccount,
} from "./claude-code/account";
import type { QuotaSnapshot } from "./claude-code/quota";
import type { UsageFact } from "./claude-code/usage";
import {
  modelAccountsDigest,
  routeModel,
  type ModelAccountRule,
} from "./model-accounts";
import type { SourceName } from "./sources";

/**
 * 文件读取进度。offset 只推进到最后一个完整行之后；fingerprint 是 offset 之前一小段字节的摘要，
 * 文件被截断或原地重写时与之不符，采集器会从头重读。重读无害，因为事件按键去重。
 */
export interface FileCursor {
  identity: string;
  offset: number;
  fingerprint: string;
  mtimeMs: number;
}

/** 单个文件本轮读到的某个事件：首行时间、当前所选行观测时间与四桶合计最大的一行。 */
export interface FileObservation {
  key: string;
  firstTimestamp: string;
  observedAt?: string;
  total: number;
  fact: UsageFact;
}

export type OutboxKind = "usage" | "account" | "quota" | "otel" | "scope";

/** Command Code 套餐缓存（账户 id → planId），只在规则未写死套餐时采用。 */
export const COMMAND_CODE_PLANS_META = "commandcode_plans";

/** 某个 Command Code 账户已绑定的主体摘要（sha256:<hex>），不含明文组织或登录名。 */
export function commandCodeIdentityMetaKey(accountId: string) {
  return `commandcode_identity_hash:${accountId}`;
}

/**
 * 只在本机待发送队列里使用的采样身份：Command Code 额度入队时冻结当时的平台与主体摘要，
 * 推送前据此核对账户资料，发出前剥离，不进入 ingest 协议。
 */
export interface QuotaIdentity {
  platform: "commandcode";
  subjectKey: string;
}

/** 待发送的请求归属记录上限；超出时丢弃最早的。 */
export const OTEL_QUEUE_LIMIT = 50_000;

export interface OutboxItem<T> {
  seq: number;
  payload: T;
  /** 本机队列附带的最近观测时间（不进入 wire payload），供推送暂扣判断长响应完成时刻。 */
  observedAt?: string;
}

export interface UsageTotals {
  model: string;
  events: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

interface EventRow {
  key: string;
  occurred_at: string;
  total: number;
  account: string;
  observation: string;
  attribution: string | null;
}

const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  offset INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  mtime_ms REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  key TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  total INTEGER NOT NULL,
  account TEXT NOT NULL,
  observation TEXT NOT NULL,
  attribution TEXT
);
CREATE INDEX IF NOT EXISTS events_occurred_at ON events (occurred_at);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uuid TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_hints (
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (at, source)
);
CREATE TABLE IF NOT EXISTS accounts (external_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (kind, item_id)
);
CREATE TABLE IF NOT EXISTS codex_files (
  path TEXT PRIMARY KEY,
  offset INTEGER,
  inode TEXT,
  tail TEXT,
  context TEXT,
  size INTEGER,
  modified REAL
);
CREATE TABLE IF NOT EXISTS omp_files (
  path TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  inode TEXT NOT NULL,
  tail TEXT NOT NULL,
  context TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS opencode_cursor (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agy_files (
  path TEXT PRIMARY KEY,
  inode TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified REAL NOT NULL,
  wal_size INTEGER NOT NULL,
  wal_modified REAL NOT NULL,
  account TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agy_shared_logs (
  path TEXT PRIMARY KEY,
  inode TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified REAL NOT NULL,
  default_label TEXT NOT NULL,
  events TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_usage (external_id TEXT PRIMARY KEY, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agy_seen_responses (response_key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS usage_observed_at (
  external_id TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codex_otel_starts (
  session_id TEXT PRIMARY KEY,
  started_ms INTEGER NOT NULL,
  duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS codex_otel_timings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  occurred_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  cached_tokens INTEGER,
  output_tokens INTEGER,
  first_token_ms INTEGER,
  duration_ms INTEGER,
  received_ms INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS codex_otel_timings_session_time
  ON codex_otel_timings (session_id, matched, occurred_ms);
CREATE TABLE IF NOT EXISTS codex_recent_usage (
  external_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  occurred_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  cached_tokens INTEGER,
  output_tokens INTEGER,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS codex_recent_usage_session_time
  ON codex_recent_usage (session_id, occurred_ms);
`;

/**
 * 采集器本地状态。outbox 每项只保留最新版本，seq 单调递增且不复用：
 * 推送成功只删除当时发送的 seq，推送期间写入的新版本保持待发送。
 */
export class CollectorState {
  readonly db: Database;
  private segmentCache: AccountSegment[] | null = null;
  private hintCache: LoginHint[] | null = null;
  private bindingCache: HistoryBinding | null | undefined;
  private modelAccounts: readonly ModelAccountRule[] = [];

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    }
    this.db.exec(schema);
    this.ensureEventsAttributionColumn();
  }

  /** 兼容旧版 state.sqlite：若 events 表缺少 attribution 列，在写事务内二次确认后幂等补列，避免多进程并发打开旧库竞争 DDL。 */
  private ensureEventsAttributionColumn() {
    const hasColumn = () =>
      this.db
        .query<{ name: string }, []>("PRAGMA table_info(events)")
        .all()
        .some((col) => col.name === "attribution");
    if (hasColumn()) return;
    this.write(() => {
      if (!hasColumn()) {
        this.db.exec("ALTER TABLE events ADD COLUMN attribution TEXT;");
      }
    });
  }

  close() {
    this.db.close();
  }

  /**
   * 同步与 OTEL 中继是两个进程，各自写这个库。所有写事务都在开始时拿写锁：
   * 默认的延迟事务先读后写，读取后若另一个进程已经提交，升级写锁时 SQLite
   * 直接返回“database is locked”，不经过 busy_timeout 等待，整轮同步因此失败。
   * 嵌套调用按保存点执行，只有最外层决定加锁方式。
   */
  write<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  /** 设置模型账户映射；改变映射后由调用方重新归属全部事件。 */
  setModelAccounts(rules: readonly ModelAccountRule[]) {
    this.modelAccounts = rules;
  }

  /** 账户来源随用量上报：服务端据此决定 OTEL 能否覆盖，模型映射优先于 OTEL。 */
  private accountFor(
    model: string,
    occurredAt: string,
  ): { account: string; attribution: "model" | "timeline" } {
    const routed = routeModel(model, this.modelAccounts);
    if (!routed)
      return {
        account: attribute(
          occurredAt,
          this.segments(),
          this.binding(),
          this.loginHints(),
        ),
        attribution: "timeline",
      };
    this.upsertAccount(routed);
    return { account: routed.externalId, attribution: "model" };
  }

  private attributionOf(model: string): "model" | "timeline" {
    return routeModel(model, this.modelAccounts) ? "model" : "timeline";
  }

  getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?",
      )
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  deleteMeta(key: string) {
    this.db.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  metaByPrefix(prefix: string): { key: string; value: string }[] {
    return this.db
      .query<{ key: string; value: string }, [string, string]>(
        "SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key",
      )
      .all(prefix, `${prefix}\uffff`);
  }

  cursor(path: string): FileCursor | null {
    const row = this.db
      .query<
        {
          identity: string;
          offset: number;
          fingerprint: string;
          mtime_ms: number;
        },
        [string]
      >(
        "SELECT identity, offset, fingerprint, mtime_ms FROM files WHERE path = ?",
      )
      .get(path);
    return row
      ? {
          identity: row.identity,
          offset: row.offset,
          fingerprint: row.fingerprint,
          mtimeMs: row.mtime_ms,
        }
      : null;
  }

  cursors(): { path: string; offset: number }[] {
    return this.db
      .query<{ path: string; offset: number }, []>(
        "SELECT path, offset FROM files ORDER BY path",
      )
      .all();
  }

  /** 文件消失只清理读取进度；已记录的事件与待发送内容保留。 */
  forgetMissingFiles(present: ReadonlySet<string>): number {
    let removed = 0;
    const remove = this.db.query("DELETE FROM files WHERE path = ?");
    for (const { path } of this.cursors()) {
      if (!present.has(path)) {
        remove.run(path);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 新来源（Codex、OpenCode、Antigravity、omp）的用量入账。已按 external_id 记录过的返回 false，
   * 既不重复入队也不更新读取进度；出现过的用量无论被丢弃还是待发送都在记录中。
   * 应在读取器自己的事务中调用，与其读取进度同一批提交，调用方负责回滚。
   */
  recordSourceUsage(source: SourceName, usage: IngestUsage): boolean {
    const inserted = this.db
      .query(
        "INSERT OR IGNORE INTO source_usage (external_id, source) VALUES (?, ?)",
      )
      .run(usage.externalId, source);
    if (inserted.changes === 0) return false;
    this.enqueueRow("usage", usage.externalId, usage);
    return true;
  }

  hasSourceUsage(source: SourceName): boolean {
    return (
      this.db
        .query<{ 1: number }, [SourceName]>(
          "SELECT 1 FROM source_usage WHERE source = ? LIMIT 1",
        )
        .get(source) !== null
    );
  }

  /**
   * Antigravity 用量入账：除 external_id 外，再用单次上游响应标识做跨会话去重，
   * 拦截 /btw 或会话分叉复制父会话 gen_metadata 带来的重复记账；已入账的旧记录重扫时
   * 只补齐 response_key，不重复入队。
   */
  recordAgyUsage(usage: IngestUsage, responseKey: string | null): boolean {
    const alreadyRecorded =
      this.db
        .query<{ 1: number }, [string]>(
          "SELECT 1 FROM source_usage WHERE external_id = ?",
        )
        .get(usage.externalId) !== null;
    if (alreadyRecorded) {
      if (responseKey) {
        this.db
          .query(
            "INSERT OR IGNORE INTO agy_seen_responses (response_key) VALUES (?)",
          )
          .run(responseKey);
      }
      return false;
    }
    if (responseKey) {
      const seen = this.db
        .query(
          "INSERT OR IGNORE INTO agy_seen_responses (response_key) VALUES (?)",
        )
        .run(responseKey);
      if (seen.changes === 0) return false;
    }
    return this.recordSourceUsage("agy", usage);
  }

  /** 新来源的待上传条数；按 external_id 与 outbox 的用量条目对应。 */
  sourcePendingCounts(): Record<SourceName, number> {
    const counts: Record<SourceName, number> = {
      codex: 0,
      opencode: 0,
      agy: 0,
      omp: 0,
    };
    for (const row of this.db
      .query<{ source: string; count: number }, []>(
        `SELECT source_usage.source AS source, COUNT(*) AS count
         FROM outbox JOIN source_usage ON outbox.item_id = source_usage.external_id
         WHERE outbox.kind = 'usage' GROUP BY source`,
      )
      .all()) {
      if (
        row.source === "codex" ||
        row.source === "opencode" ||
        row.source === "agy" ||
        row.source === "omp"
      )
        counts[row.source] = row.count;
    }
    return counts;
  }

  /** Codex 会话文件读取进度，只由读取器维护；结构与被删除的独立 Codex 采集器相同。 */
  codexFile(path: string): {
    offset: number;
    inode: string;
    tail: string;
    context: string;
    size: number;
    modified: number;
  } | null {
    return (
      this.db
        .query<
          {
            offset: number;
            inode: string;
            tail: string;
            context: string;
            size: number;
            modified: number;
          },
          [string]
        >(
          "SELECT offset, inode, tail, context, size, modified FROM codex_files WHERE path = ?",
        )
        .get(path) ?? null
    );
  }

  codexFilePaths(): string[] {
    return this.db
      .query<{ path: string }, []>("SELECT path FROM codex_files")
      .all()
      .map((row) => row.path);
  }

  saveCodexFile(row: {
    path: string;
    offset: number;
    inode: string;
    tail: string;
    context: string;
    size: number;
    modified: number;
  }) {
    this.db
      .query(
        `INSERT INTO codex_files (path, offset, inode, tail, context, size, modified)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, inode = excluded.inode,
           tail = excluded.tail, context = excluded.context, size = excluded.size,
           modified = excluded.modified`,
      )
      .run(
        row.path,
        row.offset,
        row.inode,
        row.tail,
        row.context,
        row.size,
        row.modified,
      );
  }

  /** Codex 文件消失只清理读取进度；已入账的用量靠 source_usage 保持幂等。 */
  forgetMissingCodexFiles(present: ReadonlySet<string>): number {
    let removed = 0;
    const remove = this.db.query("DELETE FROM codex_files WHERE path = ?");
    for (const path of this.codexFilePaths()) {
      if (!present.has(path)) {
        remove.run(path);
        removed += 1;
      }
    }
    return removed;
  }

  /** omp 会话文件读取进度，结构与 Codex 相同；只由读取器维护。 */
  ompFile(path: string): {
    offset: number;
    inode: string;
    tail: string;
    context: string;
    size: number;
    modified: number;
  } | null {
    return (
      this.db
        .query<
          {
            offset: number;
            inode: string;
            tail: string;
            context: string;
            size: number;
            modified: number;
          },
          [string]
        >(
          "SELECT offset, inode, tail, context, size, modified FROM omp_files WHERE path = ?",
        )
        .get(path) ?? null
    );
  }

  /** 全部已登记 omp 文件的路径、inode、字节偏移与末尾指纹，只读，仅用于旧版首次升级迁移。 */
  listOmpFiles(): {
    path: string;
    inode: string;
    offset: number;
    tail: string;
  }[] {
    return this.db
      .query<{ path: string; inode: string; offset: number; tail: string }, []>(
        "SELECT path, inode, offset, tail FROM omp_files",
      )
      .all();
  }

  /**
   * 登记已触发过实时刷新的 Antigravity 429 事件键（仅写 source_usage 幂等表，不进 outbox）。
   * 返回 true 表示首次见到该事件；规则补录或重读遇到同一事件时返回 false。
   */
  recordOmpAgyExhausted(externalId: string): boolean {
    const result = this.db
      .query(
        "INSERT OR IGNORE INTO source_usage (external_id, source) VALUES (?, ?)",
      )
      .run(externalId, "omp-agy-429");
    return result.changes > 0;
  }

  ompFilePaths(): string[] {
    return this.db
      .query<{ path: string }, []>("SELECT path FROM omp_files")
      .all()
      .map((row) => row.path);
  }

  saveOmpFile(row: {
    path: string;
    offset: number;
    inode: string;
    tail: string;
    context: string;
    size: number;
    modified: number;
  }) {
    this.db
      .query(
        `INSERT INTO omp_files (path, offset, inode, tail, context, size, modified)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, inode = excluded.inode,
           tail = excluded.tail, context = excluded.context, size = excluded.size,
           modified = excluded.modified`,
      )
      .run(
        row.path,
        row.offset,
        row.inode,
        row.tail,
        row.context,
        row.size,
        row.modified,
      );
  }

  /** 清空全部 omp 读取进度，下一轮从头重读；已入账的请求靠用量键去重，不会重复上报。 */
  clearOmpFiles() {
    this.db.query("DELETE FROM omp_files").run();
  }

  /** omp 文件消失或被移到别的目录只清理读取进度；已入账的用量靠 source_usage 保持幂等。 */
  forgetMissingOmpFiles(present: ReadonlySet<string>): number {
    let removed = 0;
    const remove = this.db.query("DELETE FROM omp_files WHERE path = ?");
    for (const path of this.ompFilePaths()) {
      if (!present.has(path)) {
        remove.run(path);
        removed += 1;
      }
    }
    return removed;
  }

  /** OpenCode 增量游标（毫秒时间戳），单行；游标与入账由读取器在同一事务提交。 */
  opencodeCursor(): number | null {
    const row = this.db
      .query<{ time_updated: number }, [string]>(
        "SELECT time_updated FROM opencode_cursor WHERE id = 'opencode'",
      )
      .get("opencode");
    return row?.time_updated ?? null;
  }

  saveOpencodeCursor(timeUpdated: number) {
    this.db
      .query(
        `INSERT INTO opencode_cursor (id, time_updated) VALUES ('opencode', ?)
         ON CONFLICT (id) DO UPDATE SET time_updated = excluded.time_updated`,
      )
      .run(timeUpdated);
  }

  /** Antigravity 会话库文件读取进度：主文件与 WAL 都未变化且已关联同一账户时跳过打开。 */
  agyFile(path: string): {
    inode: string;
    size: number;
    modified: number;
    walSize: number;
    walModified: number;
    account: string;
  } | null {
    const row = this.db
      .query<
        {
          inode: string;
          size: number;
          modified: number;
          wal_size: number;
          wal_modified: number;
          account: string;
        },
        [string]
      >(
        "SELECT inode, size, modified, wal_size, wal_modified, account FROM agy_files WHERE path = ?",
      )
      .get(path);
    return row
      ? {
          inode: row.inode,
          size: row.size,
          modified: row.modified,
          walSize: row.wal_size,
          walModified: row.wal_modified,
          account: row.account,
        }
      : null;
  }

  agyFilePaths(): string[] {
    return this.db
      .query<{ path: string }, []>("SELECT path FROM agy_files")
      .all()
      .map((row) => row.path);
  }

  saveAgyFile(row: {
    path: string;
    inode: string;
    size: number;
    modified: number;
    walSize: number;
    walModified: number;
    account: string;
  }) {
    this.db
      .query(
        `INSERT INTO agy_files (path, inode, size, modified, wal_size, wal_modified, account)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET inode = excluded.inode, size = excluded.size,
           modified = excluded.modified, wal_size = excluded.wal_size,
           wal_modified = excluded.wal_modified, account = excluded.account`,
      )
      .run(
        row.path,
        row.inode,
        row.size,
        row.modified,
        row.walSize,
        row.walModified,
        row.account,
      );
  }

  forgetMissingAgyFiles(present: ReadonlySet<string>): number {
    let removed = 0;
    const remove = this.db.query("DELETE FROM agy_files WHERE path = ?");
    for (const path of this.agyFilePaths()) {
      if (!present.has(path)) {
        remove.run(path);
        removed += 1;
      }
    }
    return removed;
  }

  /** 共享 conversations/ 目录场景下按日志文件缓存解析出的轮次归属事件，避免每轮全量重读历史日志。 */
  agySharedLog(path: string): {
    inode: string;
    size: number;
    modified: number;
    defaultLabel: string;
    events: string;
  } | null {
    const row = this.db
      .query<
        {
          inode: string;
          size: number;
          modified: number;
          default_label: string;
          events: string;
        },
        [string]
      >(
        "SELECT inode, size, modified, default_label, events FROM agy_shared_logs WHERE path = ?",
      )
      .get(path);
    return row
      ? {
          inode: row.inode,
          size: row.size,
          modified: row.modified,
          defaultLabel: row.default_label,
          events: row.events,
        }
      : null;
  }

  saveAgySharedLog(row: {
    path: string;
    inode: string;
    size: number;
    modified: number;
    defaultLabel: string;
    events: string;
  }) {
    this.db
      .query(
        `INSERT INTO agy_shared_logs (path, inode, size, modified, default_label, events)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET inode = excluded.inode, size = excluded.size,
           modified = excluded.modified, default_label = excluded.default_label,
           events = excluded.events`,
      )
      .run(
        row.path,
        row.inode,
        row.size,
        row.modified,
        row.defaultLabel,
        row.events,
      );
  }

  forgetMissingAgySharedLogs(present: ReadonlySet<string>): number {
    let removed = 0;
    const rows = this.db
      .query<{ path: string }, []>("SELECT path FROM agy_shared_logs")
      .all();
    const remove = this.db.query("DELETE FROM agy_shared_logs WHERE path = ?");
    for (const { path } of rows) {
      if (!present.has(path)) {
        remove.run(path);
        removed += 1;
      }
    }
    return removed;
  }

  /** 事件合并与读取进度在同一事务提交，崩溃后不会出现进度前移而事件缺失。 */
  applyFile(
    path: string,
    cursor: FileCursor,
    observations: readonly FileObservation[],
  ): number {
    let changed = 0;
    this.write(() => {
      for (const observation of observations) {
        if (this.mergeObservation(observation)) changed += 1;
      }
      this.db
        .query(
          `INSERT INTO files (path, identity, offset, fingerprint, mtime_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET identity = excluded.identity, offset = excluded.offset,
             fingerprint = excluded.fingerprint, mtime_ms = excluded.mtime_ms`,
        )
        .run(
          path,
          cursor.identity,
          cursor.offset,
          cursor.fingerprint,
          cursor.mtimeMs,
        );
    });
    return changed;
  }

  /**
   * 同一键只在四桶合计严格变大时替换所选行，不按字段取最大值；首次出现时间一经记录不再改变。
   * 全零事件也记录，以便后续真实行沿用首行时间，但不发送。
   */
  private mergeObservation(observation: FileObservation): boolean {
    const existing = this.db
      .query<EventRow, [string]>(
        "SELECT key, occurred_at, total, account, observation, attribution FROM events WHERE key = ?",
      )
      .get(observation.key);
    const serialized = JSON.stringify(observation.fact);
    if (!existing) {
      const { account, attribution } = this.accountFor(
        observation.fact.model,
        observation.firstTimestamp,
      );
      this.db
        .query(
          "INSERT INTO events (key, occurred_at, total, account, observation, attribution) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          observation.key,
          observation.firstTimestamp,
          observation.total,
          account,
          serialized,
          attribution,
        );
      if (observation.total > 0) {
        this.recordUsageObservedAt(
          observation.fact.externalId,
          observation.firstTimestamp,
          observation.observedAt ?? observation.firstTimestamp,
        );
        this.enqueueUsage(
          observation.fact,
          observation.firstTimestamp,
          account,
          attribution,
        );
        return true;
      }
      return false;
    }
    if (observation.total < existing.total) return false;
    if (observation.total === existing.total) {
      const incomingDuration =
        typeof observation.fact.metadata.duration_ms === "number" &&
        Number.isFinite(observation.fact.metadata.duration_ms) &&
        observation.fact.metadata.duration_ms > 0
          ? observation.fact.metadata.duration_ms
          : null;
      if (incomingDuration === null) return false;
      const storedFact = JSON.parse(existing.observation) as UsageFact;
      const storedDuration =
        typeof storedFact.metadata.duration_ms === "number" &&
        Number.isFinite(storedFact.metadata.duration_ms)
          ? storedFact.metadata.duration_ms
          : null;
      if (storedDuration !== null && incomingDuration <= storedDuration)
        return false;
      const updatedFact: UsageFact = {
        ...storedFact,
        metadata: { ...storedFact.metadata, duration_ms: incomingDuration },
      };
      this.db
        .query("UPDATE events SET observation = ? WHERE key = ?")
        .run(JSON.stringify(updatedFact), observation.key);
      if (existing.total > 0) {
        this.recordUsageObservedAt(
          updatedFact.externalId,
          existing.occurred_at,
          observation.observedAt ?? observation.firstTimestamp,
        );
        this.enqueueUsage(
          updatedFact,
          existing.occurred_at,
          existing.account,
          this.attributionOf(updatedFact.model),
        );
        return true;
      }
      return false;
    }
    this.db
      .query("UPDATE events SET total = ?, observation = ? WHERE key = ?")
      .run(observation.total, serialized, observation.key);
    this.recordUsageObservedAt(
      observation.fact.externalId,
      existing.occurred_at,
      observation.observedAt ?? observation.firstTimestamp,
    );
    this.enqueueUsage(
      observation.fact,
      existing.occurred_at,
      existing.account,
      this.attributionOf(observation.fact.model),
    );
    return true;
  }

  /** 记录跨行更新的长响应最新观测时间（独立本地表，不污染 outbox 协议载荷）。 */
  private recordUsageObservedAt(
    externalId: string,
    occurredAt: string,
    observedAt?: string,
  ) {
    if (!observedAt || observedAt === occurredAt) return;
    const nextMs = Date.parse(observedAt);
    if (!Number.isFinite(nextMs)) return;
    const existing = this.db
      .query<{ observed_at: string }, [string]>(
        "SELECT observed_at FROM usage_observed_at WHERE external_id = ?",
      )
      .get(externalId);
    if (existing) {
      const prevMs = Date.parse(existing.observed_at);
      if (Number.isFinite(prevMs) && nextMs <= prevMs) return;
    }
    this.db
      .query(
        `INSERT INTO usage_observed_at (external_id, observed_at)
         VALUES (?, ?)
         ON CONFLICT (external_id) DO UPDATE SET observed_at = excluded.observed_at`,
      )
      .run(externalId, observedAt);
  }

  private enqueueUsage(
    fact: UsageFact,
    occurredAt: string,
    account: string,
    attribution: "model" | "timeline",
  ) {
    // 只保存资料、不单独入队：推送时由引用它的用量带上。同一轮内被重新归属的事件
    // 会替换待发送条目，未归属账户就不会因短暂的中间状态出现在服务端。
    if (account === UNATTRIBUTED_ACCOUNT_ID) {
      this.db
        .query(
          "INSERT OR IGNORE INTO accounts (external_id, payload) VALUES (?, ?)",
        )
        .run(UNATTRIBUTED_ACCOUNT_ID, JSON.stringify(unattributedAccount));
    }
    const payload: IngestUsage = {
      externalId: fact.externalId,
      occurredAt,
      accountExternalId: account,
      model: fact.model,
      tier: fact.tier,
      tokens: fact.tokens,
      metadata: { ...fact.metadata, attribution },
    };
    this.enqueue("usage", fact.externalId, payload);
  }

  private enqueueRow(kind: OutboxKind, itemId: string, payload: unknown) {
    this.db
      .query("DELETE FROM outbox WHERE kind = ? AND item_id = ?")
      .run(kind, itemId);
    this.db
      .query("INSERT INTO outbox (kind, item_id, payload) VALUES (?, ?, ?)")
      .run(kind, itemId, JSON.stringify(payload));
  }

  private enqueue(kind: OutboxKind, itemId: string, payload: unknown) {
    this.write(() => this.enqueueRow(kind, itemId, payload));
  }

  /**
   * 本机 OTEL 中继写入待发送队列。一次请求的多条记录在一个事务中提交；写库失败会抛出，
   * 由中继返回 503。同一请求 ID 尚未送出时与队列中的旧项合并：与服务端一致，每个字段
   * 先到的非空值优先、空缺由新记录补齐，因此成功请求的耗时不会被随后的失败事件冲掉。
   */
  enqueueOtel(records: readonly OtelRequestAccount[]): {
    queued: number;
    dropped: number;
  } {
    if (records.length === 0) return { queued: 0, dropped: 0 };
    return this.write(() => {
      for (const record of records)
        this.enqueueRow("otel", record.requestId, this.mergeQueuedOtel(record));
      // 服务端长期收不到时队列不能无限增长：只保留最新的一批，更早的请求
      // 退回按登录时间线归属。上限约合数周的请求量，库内占用十几 MB。
      const dropped = this.db
        .query(
          `DELETE FROM outbox WHERE kind = 'otel' AND seq <= (
             SELECT seq FROM outbox WHERE kind = 'otel'
             ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
        )
        .run(OTEL_QUEUE_LIMIT).changes;
      return { queued: records.length, dropped };
    });
  }

  private mergeQueuedOtel(record: OtelRequestAccount): OtelRequestAccount {
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM outbox WHERE kind = 'otel' AND item_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(record.requestId);
    if (!row) return record;
    const queued = JSON.parse(row.payload) as OtelRequestAccount;
    const merged: OtelRequestAccount = {
      requestId: record.requestId,
      accountUuid: queued.accountUuid ?? record.accountUuid,
      organizationUuid: queued.organizationUuid ?? record.organizationUuid,
      sessionId: queued.sessionId ?? record.sessionId,
      model: queued.model ?? record.model,
      occurredAt: queued.occurredAt ?? record.occurredAt,
    };
    // 耗时字段只在有值时出现，与解析结果的形状保持一致。
    const durationMs = queued.durationMs ?? record.durationMs ?? null;
    const firstTokenMs = queued.firstTokenMs ?? record.firstTokenMs ?? null;
    if (durationMs !== null) merged.durationMs = durationMs;
    if (firstTokenMs !== null) merged.firstTokenMs = firstTokenMs;
    return merged;
  }

  /**
   * 写入 Codex 官方 OTLP 日志事件：记录请求起点、计算总耗时与 TTFT，
   * 若对应 rollout 用量刚在几秒前先一步入队，则立即补写耗时并重新入队更新。
   */
  recordCodexOtelEvents(
    events: readonly CodexOtelEvent[],
    nowMs: number = Date.now(),
  ): { stored: number; backfilled: number } {
    if (events.length === 0) return { stored: 0, backfilled: 0 };
    const timingRetentionMs = 14 * 24 * 60 * 60 * 1000;
    const matchWindowMs = 15_000;
    const maxRequestDurationMs = 60 * 60 * 1000;
    return this.write(() => {
      let stored = 0;
      let backfilled = 0;
      for (const event of events) {
        if (event.kind === "request_start") {
          this.db
            .query(
              `INSERT INTO codex_otel_starts (session_id, started_ms, duration_ms)
               VALUES (?, ?, ?)
               ON CONFLICT (session_id) DO UPDATE SET
                 started_ms = excluded.started_ms,
                 duration_ms = excluded.duration_ms`,
            )
            .run(event.sessionId, event.occurredAtMs, event.durationMs);
          continue;
        }
        const start = this.db
          .query<{ started_ms: number; duration_ms: number | null }, [string]>(
            "SELECT started_ms, duration_ms FROM codex_otel_starts WHERE session_id = ?",
          )
          .get(event.sessionId);
        let durationMs = event.durationMs;
        if (durationMs === null && start) {
          const delta = event.occurredAtMs - start.started_ms;
          if (delta >= 0 && delta <= maxRequestDurationMs) durationMs = delta;
          else if (start.duration_ms !== null) durationMs = start.duration_ms;
        }
        if (
          event.firstTokenMs !== null &&
          durationMs !== null &&
          durationMs < event.firstTokenMs
        ) {
          durationMs = event.firstTokenMs;
        }
        if (start) {
          this.db
            .query("DELETE FROM codex_otel_starts WHERE session_id = ?")
            .run(event.sessionId);
        }
        if (event.firstTokenMs === null && durationMs === null) continue;

        // 若同一请求已被先读取的 rollout 用量暂存，直接回填耗时并重推更新。
        const pendingUsage = this.db
          .query<
            { external_id: string; payload: string },
            [
              string,
              number,
              number,
              number | null,
              number | null,
              number | null,
              number | null,
              number | null,
              number | null,
              number,
            ]
          >(
            `SELECT external_id, payload
               FROM codex_recent_usage
              WHERE session_id = ?
                AND occurred_ms BETWEEN ? AND ?
                AND (input_tokens IS NULL OR ? IS NULL OR input_tokens = ?)
                AND (cached_tokens IS NULL OR ? IS NULL OR cached_tokens = ?)
                AND (output_tokens IS NULL OR ? IS NULL OR output_tokens = ?)
              ORDER BY ABS(occurred_ms - ?) ASC
              LIMIT 1`,
          )
          .get(
            event.sessionId,
            event.occurredAtMs - matchWindowMs,
            event.occurredAtMs + matchWindowMs,
            event.inputTokens,
            event.inputTokens,
            event.cachedTokens,
            event.cachedTokens,
            event.outputTokens,
            event.outputTokens,
            event.occurredAtMs,
          );
        if (pendingUsage) {
          const parsed = JSON.parse(pendingUsage.payload) as IngestUsage;
          const enriched: IngestUsage = {
            ...parsed,
            metadata: {
              ...parsed.metadata,
              ...(event.firstTokenMs !== null
                ? { first_token_ms: event.firstTokenMs }
                : {}),
              ...(durationMs !== null ? { duration_ms: durationMs } : {}),
            },
          };
          this.enqueueRow("usage", enriched.externalId, enriched);
          this.db
            .query("DELETE FROM codex_recent_usage WHERE external_id = ?")
            .run(pendingUsage.external_id);
          backfilled += 1;
          continue;
        }

        const duplicate = this.db
          .query<
            { id: number },
            [string, number, number | null, number | null]
          >(
            `SELECT id FROM codex_otel_timings
              WHERE session_id = ? AND occurred_ms = ?
                AND input_tokens IS ? AND output_tokens IS ?
              LIMIT 1`,
          )
          .get(
            event.sessionId,
            event.occurredAtMs,
            event.inputTokens,
            event.outputTokens,
          );
        if (duplicate) continue;

        this.db
          .query(
            `INSERT INTO codex_otel_timings
               (session_id, occurred_ms, input_tokens, cached_tokens, output_tokens, first_token_ms, duration_ms, received_ms, matched)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            event.sessionId,
            event.occurredAtMs,
            event.inputTokens,
            event.cachedTokens,
            event.outputTokens,
            event.firstTokenMs,
            durationMs,
            nowMs,
          );
        stored += 1;
      }
      this.db
        .query("DELETE FROM codex_otel_timings WHERE received_ms < ?")
        .run(nowMs - timingRetentionMs);
      return { stored, backfilled };
    });
  }

  /** 为一条 Codex rollout 用量查找并消费对应的官方 OTLP 耗时记录。 */
  consumeCodexOtelTiming(
    sessionId: string,
    occurredMs: number,
    inputTokens: number | null,
    cachedTokens: number | null,
    outputTokens: number | null,
  ): { firstTokenMs: number | null; durationMs: number | null } | null {
    const matchWindowMs = 15_000;
    const row = this.db
      .query<
        {
          id: number;
          first_token_ms: number | null;
          duration_ms: number | null;
        },
        [
          string,
          number,
          number,
          number | null,
          number | null,
          number | null,
          number | null,
          number | null,
          number | null,
          number,
        ]
      >(
        `SELECT id, first_token_ms, duration_ms
           FROM codex_otel_timings
          WHERE session_id = ?
            AND matched = 0
            AND occurred_ms BETWEEN ? AND ?
            AND (input_tokens IS NULL OR ? IS NULL OR input_tokens = ?)
            AND (cached_tokens IS NULL OR ? IS NULL OR cached_tokens = ?)
            AND (output_tokens IS NULL OR ? IS NULL OR output_tokens = ?)
          ORDER BY ABS(occurred_ms - ?) ASC
          LIMIT 1`,
      )
      .get(
        sessionId,
        occurredMs - matchWindowMs,
        occurredMs + matchWindowMs,
        inputTokens,
        inputTokens,
        cachedTokens,
        cachedTokens,
        outputTokens,
        outputTokens,
        occurredMs,
      );
    if (!row) return null;
    this.db
      .query("UPDATE codex_otel_timings SET matched = 1 WHERE id = ?")
      .run(row.id);
    return {
      firstTokenMs: row.first_token_ms,
      durationMs: row.duration_ms,
    };
  }

  /** 暂存刚写入但尚未收到官方 OTEL 耗时的近期 Codex 用量（仅保留 24 小时），等待 OTEL 到达后自动补推。 */
  savePendingCodexTimingUsage(
    sessionId: string,
    occurredMs: number,
    inputTokens: number | null,
    cachedTokens: number | null,
    outputTokens: number | null,
    usage: IngestUsage,
    nowMs: number = Date.now(),
  ) {
    const retentionMs = 24 * 60 * 60 * 1000;
    if (nowMs - occurredMs > retentionMs) return;
    this.db
      .query(
        `INSERT OR REPLACE INTO codex_recent_usage
           (external_id, session_id, occurred_ms, input_tokens, cached_tokens, output_tokens, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        usage.externalId,
        sessionId,
        occurredMs,
        inputTokens,
        cachedTokens,
        outputTokens,
        JSON.stringify(usage),
      );
    this.db
      .query("DELETE FROM codex_recent_usage WHERE occurred_ms < ?")
      .run(nowMs - retentionMs);
  }

  /** Command Code 套餐缓存；损坏或缺失时为空表。 */
  commandCodePlans(): Record<string, string> {
    try {
      const raw = JSON.parse(
        this.getMeta(COMMAND_CODE_PLANS_META) ?? "{}",
      ) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return Object.create(null);
      // 无原型的表：账户 id 可以是 constructor、__proto__ 这类名字，查表不能落到原型属性上。
      const result: Record<string, string> = Object.create(null);
      for (const [id, plan] of Object.entries(raw))
        if (typeof plan === "string" && plan.length > 0) result[id] = plan;
      return result;
    } catch {
      return Object.create(null);
    }
  }

  /**
   * omp、OpenCode、Codex 与模型映射都会写 Command Code 账户，但只有额度读取知道套餐与主体。
   * 规则未写死套餐时补上缓存的套餐，主体摘要沿用已绑定的值，避免这些写入方把它们改回未知。
   */
  private withCommandCodeProfile(account: IngestAccount): IngestAccount {
    if (account.platform !== "commandcode") return account;
    const plan =
      account.plan ?? this.commandCodePlans()[account.externalId] ?? null;
    const subjectKey =
      account.subjectKey ??
      this.getMeta(commandCodeIdentityMetaKey(account.externalId)) ??
      null;
    return plan === account.plan && subjectKey === account.subjectKey
      ? account
      : { ...account, plan, subjectKey };
  }

  /** 账户资料变化才进入待发送；返回是否有变化。 */
  upsertAccount(input: IngestAccount): boolean {
    const account = this.withCommandCodeProfile(input);
    const serialized = JSON.stringify(account);
    const existing = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM accounts WHERE external_id = ?",
      )
      .get(account.externalId);
    if (existing?.payload === serialized) return false;
    this.db
      .query(
        "INSERT INTO accounts (external_id, payload) VALUES (?, ?) ON CONFLICT (external_id) DO UPDATE SET payload = excluded.payload",
      )
      .run(account.externalId, serialized);
    this.enqueue("account", account.externalId, account);
    return true;
  }

  account(externalId: string): IngestAccount | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM accounts WHERE external_id = ?",
      )
      .get(externalId);
    return row ? (JSON.parse(row.payload) as IngestAccount) : null;
  }

  segments(): AccountSegment[] {
    this.segmentCache ??= this.db
      .query<AccountSegment, []>(
        "SELECT account_uuid AS accountUuid, first_seen AS firstSeen, last_seen AS lastSeen FROM timeline ORDER BY id",
      )
      .all();
    return this.segmentCache;
  }

  loginHints(): LoginHint[] {
    this.hintCache ??= this.db
      .query<LoginHint, []>("SELECT at, source FROM login_hints ORDER BY at")
      .all();
    return this.hintCache;
  }

  /** 记录一次登录线索；已记录过返回 false。 */
  recordLoginHint(hint: LoginHint): boolean {
    const result = this.db
      .query("INSERT OR IGNORE INTO login_hints (at, source) VALUES (?, ?)")
      .run(hint.at, hint.source);
    if (result.changes > 0) this.hintCache = null;
    return result.changes > 0;
  }

  /** 包含该时刻的不同账户空档的起点；时刻不在任何空档内时返回 null。 */
  gapStart(at: string): string | null {
    const segments = this.segments();
    for (let index = 0; index + 1 < segments.length; index += 1) {
      const segment = segments[index]!;
      const next = segments[index + 1]!;
      if (at > segment.lastSeen && at <= next.firstSeen)
        return segment.lastSeen;
    }
    return null;
  }

  binding(): HistoryBinding | null {
    if (this.bindingCache === undefined) {
      const raw = this.getMeta("history_binding");
      this.bindingCache = raw ? (JSON.parse(raw) as HistoryBinding) : null;
    }
    return this.bindingCache;
  }

  /**
   * 记录一次运行时观察到的登录账户，返回需要重新归属的起点：
   * 同账户延长区间时，只有上次观察之后的事件可能改变归属。
   */
  observeAccount(accountUuid: string, now: string): string {
    const segments = this.segments();
    const last = segments.at(-1);
    this.segmentCache = null;
    if (last && last.accountUuid === accountUuid) {
      if (now > last.lastSeen) {
        this.db
          .query(
            "UPDATE timeline SET last_seen = ? WHERE id = (SELECT MAX(id) FROM timeline)",
          )
          .run(now);
      }
      return last.lastSeen;
    }
    this.db
      .query(
        "INSERT INTO timeline (account_uuid, first_seen, last_seen) VALUES (?, ?, ?)",
      )
      .run(accountUuid, now, now);
    return last?.lastSeen ?? now;
  }

  setBinding(binding: HistoryBinding) {
    this.setMeta("history_binding", JSON.stringify(binding));
    this.bindingCache = binding;
  }

  /**
   * 清理默认目录的登录时间线、登录线索与历史绑定；切换到仅采集指定账号目录时使用。
   * 清理前一次性将旧版库中尚未评估（attribution IS NULL）的既有事件归类到闭集 {'model', 'timeline', 'unknown'}：
   * 1. 尚存待发送队列（outbox）时，载荷的 metadata.attribution（且账户匹配）为决定性依据；
   * 2. 非 claude- 模型必属模型归属；未归属事件记为 timeline；
   * 3. 当时时间线/绑定/登录线索无法解释当前账户时，必属模型归属；
   * 4. v1/v2 旧库无自定义模型规则，或 v3 旧库的模型规则集与当前一致时，可决定性区分；
   * 5. 其余已推送且缺乏决定性来源的旧行标为 'unknown'（与未评估 NULL 区分，也不伪造 'timeline'），
   *    避免后续轮次基于已清空的时间线重复推断并误判为 'model'。
   */
  clearDefaultTimeline() {
    this.write(() => {
      const segments = this.segments();
      const binding = this.binding();
      const hints = this.loginHints();
      const legacyRows = this.db
        .query<
          {
            key: string;
            occurred_at: string;
            account: string;
            observation: string;
          },
          []
        >(
          "SELECT key, occurred_at, account, observation FROM events WHERE attribution IS NULL",
        )
        .all();
      if (legacyRows.length > 0) {
        const pendingAttribution = new Map<
          string,
          { account: string; attribution: "model" | "timeline" }
        >();
        for (const row of this.db
          .query<{ item_id: string; payload: string }, []>(
            "SELECT item_id, payload FROM outbox WHERE kind = 'usage'",
          )
          .all()) {
          try {
            const parsed = JSON.parse(row.payload) as {
              accountExternalId?: unknown;
              metadata?: { attribution?: unknown };
            };
            const attr = parsed?.metadata?.attribution;
            if (
              typeof parsed?.accountExternalId === "string" &&
              (attr === "model" || attr === "timeline")
            ) {
              pendingAttribution.set(row.item_id, {
                account: parsed.accountExternalId,
                attribution: attr,
              });
            }
          } catch {
            // 忽略格式异常的待发送载荷。
          }
        }
        const rulesMeta = this.getMeta("attribution_rules");
        const legacyWithoutModelRules = rulesMeta === "1" || rulesMeta === "2";
        const rulesUnchanged =
          rulesMeta === `3:${modelAccountsDigest(this.modelAccounts)}`;
        const mark = this.db.query(
          "UPDATE events SET attribution = ? WHERE key = ?",
        );
        for (const row of legacyRows) {
          const fact = JSON.parse(row.observation) as UsageFact;
          const fromOutbox = pendingAttribution.get(fact.externalId);
          if (fromOutbox && fromOutbox.account === row.account) {
            mark.run(fromOutbox.attribution, row.key);
            continue;
          }
          if (!fact.model.startsWith("claude-")) {
            mark.run("model", row.key);
            continue;
          }
          if (row.account === UNATTRIBUTED_ACCOUNT_ID) {
            mark.run("timeline", row.key);
            continue;
          }
          const byTimeline = attribute(
            row.occurred_at,
            segments,
            binding,
            hints,
          );
          if (byTimeline !== row.account) {
            mark.run("model", row.key);
            continue;
          }
          if (legacyWithoutModelRules) {
            mark.run("timeline", row.key);
            continue;
          }
          if (rulesUnchanged) {
            const routed = routeModel(fact.model, this.modelAccounts);
            if (routed?.externalId === row.account) {
              mark.run("model", row.key);
              continue;
            }
            if (routed === null) {
              mark.run("timeline", row.key);
              continue;
            }
          }
          mark.run("unknown", row.key);
        }
      }
      this.db.query("DELETE FROM timeline").run();
      this.db.query("DELETE FROM login_hints").run();
      this.deleteMeta("history_binding");
    });
    this.segmentCache = null;
    this.hintCache = null;
    this.bindingCache = null;
  }

  /**
   * 按当前时间线与模型映射重新计算归属；归属变化的非零事件重新进入待发送。since 为 null 时处理全部事件。
   * preserveTimelineAttribution 为 true 时（仅采集多账户目录、已清空默认时间线）：
   * - 命中当前模型规则的事件归属新规则（attribution = 'model'）；
   * - 已确认为模型归属（attribution = 'model'）且规则已移除的事件回退到 unattributed 并替换待发送项；
   * - 确认为时间线归属（attribution = 'timeline'）以及已评估但缺乏决定性来源的旧行
   *   （attribution = 'unknown'，持续保持 'unknown' 不伪造 'timeline' 也不误标 'model'）维持原有历史账户归属。
   */
  reattribute(
    since: string | null,
    options: { preserveTimelineAttribution?: boolean } = {},
  ): number {
    const rows =
      since === null
        ? this.db
            .query<EventRow, []>(
              "SELECT key, occurred_at, total, account, observation, attribution FROM events",
            )
            .all()
        : this.db
            .query<EventRow, [string]>(
              "SELECT key, occurred_at, total, account, observation, attribution FROM events WHERE occurred_at >= ?",
            )
            .all(since);
    let changed = 0;
    this.write(() => {
      for (const row of rows) {
        const fact = JSON.parse(row.observation) as UsageFact;
        const routed = routeModel(fact.model, this.modelAccounts);
        let account: string;
        let attribution: "model" | "timeline";
        if (routed) {
          this.upsertAccount(routed);
          account = routed.externalId;
          attribution = "model";
        } else if (options.preserveTimelineAttribution) {
          if (
            row.account !== UNATTRIBUTED_ACCOUNT_ID &&
            row.attribution !== "model"
          ) {
            continue;
          }
          account = UNATTRIBUTED_ACCOUNT_ID;
          attribution = "timeline";
        } else {
          account = attribute(
            row.occurred_at,
            this.segments(),
            this.binding(),
            this.loginHints(),
          );
          attribution = "timeline";
        }
        if (account === row.account && row.attribution === attribution)
          continue;
        this.db
          .query("UPDATE events SET account = ?, attribution = ? WHERE key = ?")
          .run(account, attribution, row.key);
        if (account !== row.account && row.total > 0) {
          this.enqueueUsage(fact, row.occurred_at, account, attribution);
          changed += 1;
        }
      }
    });
    return changed;
  }

  /**
   * 把全部非零事件重新放入待发送队列。用于推送内容新增字段后让服务端更新已有事实，
   * 不改变归属，也不计入重新归属的条数。
   */
  requeueUsage(): number {
    let queued = 0;
    this.write(() => {
      for (const row of this.db
        .query<EventRow, []>(
          "SELECT key, occurred_at, total, account, observation FROM events WHERE total > 0",
        )
        .all()) {
        const fact = JSON.parse(row.observation) as UsageFact;
        this.enqueueUsage(
          fact,
          row.occurred_at,
          row.account,
          this.attributionOf(fact.model),
        );
        queued += 1;
      }
    });
    return queued;
  }

  /** 同一次上游采样只上报一次；每次采样各自保留，离线期间的历史采样不会被覆盖。 */
  /** 每个额度来源分别记住最近一次上报的内容，同一采样重复读取时不再入队。 */
  /** identity 只给 Command Code 额度：冻结采样时的平台与主体摘要，推送前核对、发出前剥离。 */
  recordQuota(
    snapshot: QuotaSnapshot,
    source = "claude-json",
    identity?: QuotaIdentity,
  ): boolean {
    const metaKey =
      source === "claude-json"
        ? "last_quota_hash"
        : `last_quota_hash:${source}`;
    if (this.getMeta(metaKey) === snapshot.hash) return false;
    this.write(() => {
      for (const quota of snapshot.quotas) {
        this.enqueue(
          "quota",
          `${quota.accountExternalId}:${quota.window}:${quota.sampledAt}`,
          identity ? { ...quota, _identity: identity } : quota,
        );
      }
      this.setMeta(metaKey, snapshot.hash);
    });
    return true;
  }

  /**
   * 记录受管账号池作用域的成员快照；只有活跃/停用集合相对上次有变化时才入队，
   * 推送成功后才确认，离线或失败时自动留待下次重试。
   */
  recordManagedScope(
    scope: IngestManagedScope["scope"],
    activeAccountExternalIds: readonly string[],
    inactiveAccountExternalIds: readonly string[] = [],
  ): boolean {
    const active = [...new Set(activeAccountExternalIds)].sort();
    const activeSet = new Set(active);
    const inactive = [
      ...new Set(inactiveAccountExternalIds.filter((id) => !activeSet.has(id))),
    ].sort();
    const payload: IngestManagedScope = {
      scope,
      activeAccountExternalIds: active,
      ...(inactive.length ? { inactiveAccountExternalIds: inactive } : {}),
    };
    const serialized = JSON.stringify(payload);
    const metaKey = `last_managed_scope:${scope}`;
    if (this.getMeta(metaKey) === serialized) return false;
    this.write(() => {
      this.enqueue("scope", scope, payload);
      this.setMeta(metaKey, serialized);
    });
    return true;
  }

  pending<T>(kind: OutboxKind, limit: number, afterSeq = 0): OutboxItem<T>[] {
    if (kind === "usage") {
      return this.db
        .query<
          { seq: number; payload: string; observed_at: string | null },
          [string, number, number]
        >(
          `SELECT o.seq, o.payload, uo.observed_at
           FROM outbox o
           LEFT JOIN usage_observed_at uo ON uo.external_id = o.item_id
           WHERE o.kind = ? AND o.seq > ?
           ORDER BY o.seq ASC
           LIMIT ?`,
        )
        .all(kind, afterSeq, limit)
        .map((row) => ({
          seq: row.seq,
          payload: JSON.parse(row.payload) as T,
          ...(row.observed_at ? { observedAt: row.observed_at } : {}),
        }));
    }
    return this.db
      .query<{ seq: number; payload: string }, [string, number, number]>(
        "SELECT seq, payload FROM outbox WHERE kind = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(kind, afterSeq, limit)
      .map((row) => ({ seq: row.seq, payload: JSON.parse(row.payload) as T }));
  }

  pendingCounts(): Record<OutboxKind, number> {
    const counts: Record<OutboxKind, number> = {
      usage: 0,
      account: 0,
      quota: 0,
      otel: 0,
      scope: 0,
    };
    for (const row of this.db
      .query<{ kind: OutboxKind; count: number }, []>(
        "SELECT kind, COUNT(*) AS count FROM outbox GROUP BY kind",
      )
      .all()) {
      counts[row.kind] = row.count;
    }
    return counts;
  }

  /** 只确认实际发送的版本；同一条目若已有更新版本，其 seq 不同，不会被删除。 */
  acknowledge(seqs: readonly number[]) {
    const remove = this.db.query("DELETE FROM outbox WHERE seq = ?");
    this.write(() => {
      for (const seq of seqs) remove.run(seq);
    });
  }

  /** 非零事件按模型汇总，供 scan 与 status 对账。 */
  usageTotals(): UsageTotals[] {
    return this.db
      .query<UsageTotals, []>(
        `SELECT json_extract(observation, '$.model') AS model,
           COUNT(*) AS events,
           COALESCE(SUM(json_extract(observation, '$.tokens.input')), 0) AS input,
           COALESCE(SUM(json_extract(observation, '$.tokens.output')), 0) AS output,
           COALESCE(SUM(json_extract(observation, '$.tokens.cacheRead')), 0) AS cacheRead,
           COALESCE(SUM(json_extract(observation, '$.tokens.cacheWrite')), 0) AS cacheWrite,
           COALESCE(SUM(json_extract(observation, '$.tokens.reasoning')), 0) AS reasoning
         FROM events WHERE total > 0 GROUP BY model ORDER BY model`,
      )
      .all();
  }

  eventsByAccount(): { account: string; events: number }[] {
    return this.db
      .query<{ account: string; events: number }, []>(
        "SELECT account, COUNT(*) AS events FROM events WHERE total > 0 GROUP BY account ORDER BY account",
      )
      .all();
  }
}
