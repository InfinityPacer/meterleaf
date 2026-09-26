import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { PriceBook } from "../domain/pricing";
import type { AccountWindow } from "../shared/report";
import type { LedgerView, ViewQuery } from "../shared/ledger-view";
import type { UsdBasis } from "../shared/report";
import { ViewCache, type CachedReport } from "../storage/view-cache";
import { sourceFileState } from "../storage/source-file-state";
import {
  silentLogger,
  summarizeError,
  type DiagnosticsLogger,
  type SafeErrorSummary,
} from "./diagnostics";
import type { SyncStatus } from "./sync";

const CACHE_LIMIT = 16;
const DEFAULT_REFRESH_INTERVAL_MS = 300_000;

/** 报表结果的可见同步状态；账本结果本身仍保持 shared 契约不变。 */
export interface ReportStatus {
  refreshing: boolean;
  rebuilding: boolean;
  lastError: SafeErrorSummary | null;
}

export type ReportView = LedgerView & { reportStatus?: ReportStatus };

export interface ViewServiceOptions {
  /** 派生报表索引独立于事实账本；只读 URI 默认用内存，验证时可显式指定本地索引文件。 */
  indexPath?: string;
  /** 成功视图独立持久化；null 禁用，默认从磁盘索引路径派生，内存索引不落盘。 */
  cachePath?: string | null;
  refreshIntervalMs?: number;
  /** 账本事实少于此数时同步重建索引，默认 2000；测试用 0 验证后台重建。 */
  inlineRebuildLimit?: number;
  diagnostics?: DiagnosticsLogger;
  /** 配置了拉取来源时提供；未提供表示只接收推送，报表照常计算和刷新。 */
  getSyncStatus?: () => SyncStatus;
  now?: () => number;
}

interface WorkerMessage {
  /** index-rebuilt 表示后台重建结束（成功或放弃），此前的过渡结果需要重新计算。 */
  type?: "index-rebuilt";
  id: number;
  result?: LedgerView;
  /** 结果来自后台重建期间保留的旧索引，可能使用旧价格表或缺少最新事实。 */
  transitional?: boolean;
  /** 后台重建中且没有可用的旧索引，本次查询没有结果。 */
  building?: { since: string };
  error?: string;
  /** 分段耗时仅用于诊断，不写入缓存或用户账本。 */
  timings?: {
    queueMs: number; indexMs: number; readMs: number;
    snapshotMs: number; aggregateMs: number; materializeMs: number;
  };
}

interface PendingRequest {
  /** 只记录查询结构与哈希，不把搜索内容或账户标识写入日志。 */
  diagnostic: Record<string, string | number | boolean>;
  resolve: (value: LedgerView) => void;
  reject: (error: Error) => void;
}

/** 缓存 worker 的响应契约；save 必须先回 saved，close 必须回 closed。 */
interface CacheWorkerMessage {
  type: "saved" | "failed" | "closed";
  id?: number;
  error?: SafeErrorSummary;
  durationMs?: number;
}

interface PendingCacheWrite {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface CacheEntry {
  key: string;
  query: ViewQuery;
  basis: UsdBasis;
  value: LedgerView;
  lastUsed: number;
  refreshing: boolean;
  lastError: SafeErrorSummary | null;
  sync?: SyncStatus;
}

type ReportErrorCode =
  | "ERR_REPORT_BUILDING"
  | "ERR_REPORT_READ_FAILED"
  | "ERR_REPORT_WORKER_UNAVAILABLE"
  | "ERR_REPORT_QUEUE_FULL"
  | "ERR_REPORT_SYNC_UNAVAILABLE";

const reportErrorMessages: Record<ReportErrorCode, string> = {
  ERR_REPORT_BUILDING: "report-building",
  ERR_REPORT_READ_FAILED: "report-read-failed",
  ERR_REPORT_WORKER_UNAVAILABLE: "report-worker-unavailable",
  ERR_REPORT_QUEUE_FULL: "report-queue-full",
  ERR_REPORT_SYNC_UNAVAILABLE: "report-sync-unavailable",
};

function reportError(code: ReportErrorCode): Error {
  return Object.assign(new Error(reportErrorMessages[code]), { code });
}

/** 报表首次计算或换账本后正在后台建立，调用方应稍后再读，而不是当作失败。 */
export class ReportBuildingError extends Error {
  readonly code = "ERR_REPORT_BUILDING";
  constructor(readonly since: string) {
    super(reportErrorMessages.ERR_REPORT_BUILDING);
  }
}

function workerError(code: string | undefined): Error {
  return code === "report-worker-unavailable"
    ? reportError("ERR_REPORT_WORKER_UNAVAILABLE")
    : reportError("ERR_REPORT_READ_FAILED");
}

type AccountEstimate = NonNullable<AccountWindow["estimate"]>;

/** 旧结果跨过 reset 时只修正额度窗口，账单 asOf 与明细不重新计算。 */
function expireWindow(window: AccountWindow | null, now: number) {
  if (!window || !window.resetsAt) return window;
  const reset = Date.parse(window.resetsAt);
  if (!Number.isFinite(reset) || reset > now) return window;
  const estimate: AccountEstimate = {
    usd: null,
    credits: null,
    deltaPercent: null,
    reason: "expired",
  };
  return {
    ...window,
    percent: 0,
    state: "expired" as const,
    stale: true,
    periodUsd: null,
    periodCredits: null,
    periodRequests: null,
    periodTokens: null,
    estimate,
    ...(typeof window === "object" && "startsAt" in window
      ? { startsAt: null }
      : {}),
  };
}

function expireCachedQuotas(value: LedgerView, now: number): LedgerView {
  const accounts = (items: LedgerView["accounts"]) =>
    items.map((account) => ({
      ...account,
      fiveHour: expireWindow(account.fiveHour, now),
      sevenDay: expireWindow(account.sevenDay, now),
      sevenDayFable: expireWindow(account.sevenDayFable ?? null, now),
    }));
  return {
    ...value,
    accounts: accounts(value.accounts),
    ...(value.usdVariants
      ? {
          usdVariants: {
            subscription: {
              ...value.usdVariants.subscription,
              accounts: accounts(value.usdVariants.subscription.accounts),
            },
            api: {
              ...value.usdVariants.api,
              accounts: accounts(value.usdVariants.api.accounts),
            },
          },
        }
      : {}),
  };
}

/** 主线程持有成功结果；持久化写入由独立 worker 排队完成。 */
export class ViewService {
  private readonly worker: Worker;
  private readonly diagnostics: DiagnosticsLogger;
  private readonly refreshIntervalMs: number;
  private readonly getSyncStatus?: () => SyncStatus;
  private readonly now: () => number;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private scheduledRefresh: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private sequence = 0;
  private failed = false;
  private closed = false;
  private pending = new Map<number, PendingRequest>();
  /** 报表线程正在后台重建索引；期间所有结果都按刷新中展示。 */
  private indexRebuilding = false;
  private active = new Map<string, Promise<LedgerView>>();
  private cache = new Map<string, CacheEntry>();
  private cacheWriter: Worker | null = null;
  private cacheWriterClosing = false;
  private cacheWriterTermination: Promise<number> | null = null;
  private cacheWriterClose: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private cacheWriteSequence = 0;
  private cacheWriteTask: Promise<void> | null = null;
  private pendingCacheWrites = new Map<string, CachedReport>();
  private cacheWriteRequests = new Map<number, PendingCacheWrite>();
  private cachePersistenceDisabled = false;

  constructor(path: string, book: PriceBook, options: ViewServiceOptions = {}) {
    this.diagnostics = options.diagnostics ?? silentLogger;
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.getSyncStatus = options.getSyncStatus;
    this.now = options.now ?? Date.now;
    const indexPath =
      options.indexPath ??
      (path.startsWith("file:") ? ":memory:" : `${path}.reports.sqlite`);
    const cachePath =
      options.cachePath === undefined
        ? indexPath === ":memory:"
          ? null
          : `${indexPath}.views`
        : options.cachePath;
    if (cachePath) this.restoreCache(cachePath, path, book);
    this.worker = new Worker(new URL("./view-worker.ts", import.meta.url), {
      workerData: {
        path,
        book,
        indexPath,
        inlineRebuildLimit: options.inlineRebuildLimit,
      },
    });
    this.worker.on("message", (message: WorkerMessage) => {
      if (message.type === "index-rebuilt") {
        this.indexRebuilding = false;
        this.refreshAfterRebuild();
        return;
      }
      if (message.transitional || message.building) this.indexRebuilding = true;
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!request) return;
      if (message.building) {
        request.reject(new ReportBuildingError(message.building.since));
        return;
      }
      if (message.timings) {
        const { queueMs, indexMs, readMs } = message.timings;
        this.diagnostics.log(
          queueMs + indexMs + readMs >= 100 ? "info" : "debug",
          "report.query_timing",
          { ...request.diagnostic, ...message.timings },
        );
      }
      if (message.result !== undefined) request.resolve(message.result);
      else request.reject(workerError(message.error));
    });
    this.worker.on("error", () => this.fail());
    this.worker.on("exit", () => this.fail());
    this.startRefreshTimer();
  }

  /** 已有缓存先返回旧结果；refresh=false 只观察任务结果，防止轮询持续重算。 */
  read(
    query: ViewQuery,
    basis: UsdBasis,
    sync?: SyncStatus,
    refresh = true,
  ): Promise<ReportView> {
    if (this.closed)
      return Promise.reject(reportError("ERR_REPORT_WORKER_UNAVAILABLE"));
    const key = this.cacheKey(query, basis);
    const currentSync = sync ?? this.readSyncStatus();
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = this.now();
      if (currentSync) cached.sync = currentSync;
      const refreshSync = currentSync ?? cached.sync;
      if (
        refresh &&
        !cached.refreshing &&
        !this.closed &&
        (refreshSync || !this.getSyncStatus)
      ) {
        void this.refreshEntry(cached, refreshSync, "read");
      }
      return Promise.resolve(this.publicResult(cached, currentSync));
    }

    const running = this.active.get(key);
    if (running) {
      return running.then((result) => {
        const entry = this.saveColdResult(
          key,
          query,
          basis,
          result,
          currentSync,
        );
        return this.publicResult(entry, currentSync);
      });
    }

    if (!currentSync && this.getSyncStatus)
      return Promise.reject(reportError("ERR_REPORT_SYNC_UNAVAILABLE"));
    return this.dispatch(query, basis, currentSync, true).then((result) => {
      const entry = this.saveColdResult(key, query, basis, result, currentSync);
      return this.publicResult(entry, currentSync);
    });
  }

  private cacheKey(query: ViewQuery, basis: UsdBasis): string {
    return JSON.stringify([query, basis]);
  }

  /** 旧价格版本只作为过渡结果保留，不能把旧金额标为新版本；数据库替换必须失效。 */
  private restoreCache(cachePath: string, sourcePath: string, book: PriceBook) {
    let cache: ViewCache | null = null;
    try {
      const namespace = JSON.stringify({
        format: 1,
        source: sourceFileState(sourcePath).identity,
        book: book.id,
      });
      cache = new ViewCache(cachePath, namespace);
      for (const saved of cache.load()) {
        if (saved.key !== this.cacheKey(saved.query, saved.basis))
          throw new Error("Invalid persisted report key");
        this.cache.set(saved.key, {
          ...saved,
          refreshing: false,
          lastError: null,
        });
      }
      cache.close();
      cache = null;
      if (this.cache.size)
        this.diagnostics.info("report.cache_restored", {
          count: this.cache.size,
        });
      this.startCacheWriter(cachePath, namespace);
    } catch (error) {
      try {
        cache?.close();
      } catch {
        /* 恢复连接关闭失败不能遮蔽原始诊断。 */
      }
      this.cache.clear();
      this.disablePersistentCache(error, "restore");
    }
  }

  private startCacheWriter(cachePath: string, namespace: string) {
    try {
      const writer = new Worker(
        new URL("./view-cache-worker.ts", import.meta.url),
        {
          workerData: { cachePath, namespace },
        },
      );
      this.cacheWriter = writer;
      writer.on("message", (message: CacheWorkerMessage) => {
        this.handleCacheWorkerMessage(message);
      });
      writer.on("error", (error) => {
        const pendingClose = this.cacheWriterClose;
        if (pendingClose) {
          this.cacheWriterClose = null;
          pendingClose.reject(
            error instanceof Error
              ? error
              : new Error("Report cache worker failed"),
          );
          return;
        }
        this.failCacheWriter(error);
      });
      writer.on("exit", (code) => {
        const pendingClose = this.cacheWriterClose;
        if (pendingClose) {
          this.cacheWriterClose = null;
          if (code === 0) pendingClose.resolve();
          else pendingClose.reject(new Error("Report cache worker exited"));
          return;
        }
        if (this.cacheWriterClosing) return;
        this.failCacheWriter(new Error(`Report cache worker exited: ${code}`));
      });
    } catch (error) {
      this.disablePersistentCache(error, "save");
    }
  }

  private handleCacheWorkerMessage(message: CacheWorkerMessage) {
    if (message.type === "closed") {
      this.cacheWriterClose?.resolve();
      this.cacheWriterClose = null;
      return;
    }
    if (message.durationMs !== undefined)
      this.logCacheWriteTiming(message.durationMs);
    if (message.type === "saved") {
      if (message.id !== undefined) {
        const request = this.cacheWriteRequests.get(message.id);
        if (request) {
          this.cacheWriteRequests.delete(message.id);
          request.resolve();
        }
      }
      return;
    }
    if (message.id !== undefined) {
      const request = this.cacheWriteRequests.get(message.id);
      if (request) {
        this.cacheWriteRequests.delete(message.id);
        request.reject(new Error("report-cache-write-failed"));
      }
    }
    this.failCacheWriter(
      message.error ?? new Error("report-cache-write-failed"),
    );
  }

  private logCacheWriteTiming(durationMs: number) {
    if (!Number.isFinite(durationMs)) return;
    this.diagnostics.log(
      durationMs >= 100 ? "info" : "debug",
      "report.cache_write_timing",
      { durationMs },
    );
  }

  private persistCache(entry: CacheEntry) {
    if (this.closed || this.cachePersistenceDisabled || !this.cacheWriter)
      return;
    for (const key of this.pendingCacheWrites.keys()) {
      if (!this.cache.has(key)) this.pendingCacheWrites.delete(key);
    }
    this.pendingCacheWrites.set(entry.key, {
      key: entry.key,
      query: entry.query,
      basis: entry.basis,
      value: entry.value,
      lastUsed: entry.lastUsed,
    });
    while (this.pendingCacheWrites.size > CACHE_LIMIT) {
      const victim = [...this.pendingCacheWrites.values()]
        .filter((candidate) => candidate.key !== entry.key)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!victim) break;
      this.pendingCacheWrites.delete(victim.key);
    }
    this.scheduleCacheWrites();
  }

  /** 持久缓存失效不影响内存成功结果或报表线程，不将缓存错误升级为账本不可用。 */
  private disablePersistentCache(error: unknown, phase: "restore" | "save") {
    if (this.cachePersistenceDisabled) return;
    this.cachePersistenceDisabled = true;
    this.diagnostics.warn("report.cache_failed", {
      phase,
      error: summarizeError(error),
    });
    this.pendingCacheWrites.clear();
    const failure =
      error instanceof Error ? error : new Error("report-cache-write-failed");
    for (const request of this.cacheWriteRequests.values())
      request.reject(failure);
    this.cacheWriteRequests.clear();
    this.cacheWriterClose?.reject(failure);
    this.cacheWriterClose = null;
    void this.terminateCacheWriter();
  }

  private failCacheWriter(error: unknown) {
    if (this.cachePersistenceDisabled || this.cacheWriterClosing) return;
    this.disablePersistentCache(error, "save");
  }

  private scheduleCacheWrites() {
    if (
      this.cacheWriteTask ||
      this.cachePersistenceDisabled ||
      !this.cacheWriter
    )
      return;
    let task!: Promise<void>;
    task = this.drainCacheWrites().finally(() => {
      if (this.cacheWriteTask !== task) return;
      this.cacheWriteTask = null;
      if (
        this.pendingCacheWrites.size &&
        !this.cachePersistenceDisabled &&
        !this.closed
      ) {
        this.scheduleCacheWrites();
      }
    });
    this.cacheWriteTask = task;
  }

  private async drainCacheWrites() {
    while (this.pendingCacheWrites.size && !this.cachePersistenceDisabled) {
      const next = this.pendingCacheWrites.entries().next().value as
        [string, CachedReport] | undefined;
      if (!next) return;
      this.pendingCacheWrites.delete(next[0]);
      try {
        await this.sendCacheWrite(next[1]);
      } catch (error) {
        this.disablePersistentCache(error, "save");
      }
    }
  }

  private sendCacheWrite(entry: CachedReport): Promise<void> {
    const writer = this.cacheWriter;
    if (!writer || this.cachePersistenceDisabled) return Promise.resolve();
    const id = ++this.cacheWriteSequence;
    return new Promise<void>((resolve, reject) => {
      this.cacheWriteRequests.set(id, { resolve, reject });
      try {
        writer.postMessage({ type: "save", id, entry });
      } catch (error) {
        this.cacheWriteRequests.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error("report-cache-write-failed"),
        );
      }
    });
  }

  private async waitForCacheWrites() {
    while (this.cacheWriteTask) {
      const task = this.cacheWriteTask;
      await task;
      if (this.cacheWriteTask === task) return;
    }
  }

  private terminateCacheWriter(): Promise<number> {
    if (this.cacheWriterTermination) return this.cacheWriterTermination;
    const writer = this.cacheWriter;
    if (!writer) return Promise.resolve(0);
    this.cacheWriterClosing = true;
    this.cacheWriterTermination = writer.terminate().catch(() => -1);
    return this.cacheWriterTermination;
  }

  private async closeCacheWriter() {
    const writer = this.cacheWriter;
    if (!writer) return;
    if (this.cachePersistenceDisabled || this.cacheWriterClosing) {
      await this.terminateCacheWriter();
      return;
    }
    this.cacheWriterClosing = true;
    const closed = new Promise<void>((resolve, reject) => {
      this.cacheWriterClose = { resolve, reject };
    });
    try {
      writer.postMessage({ type: "close" });
      await closed;
    } catch (error) {
      this.disablePersistentCache(error, "save");
    } finally {
      await this.terminateCacheWriter();
    }
  }

  private readSyncStatus(): SyncStatus | undefined {
    try {
      return this.getSyncStatus?.();
    } catch {
      return undefined;
    }
  }

  private dispatch(
    query: ViewQuery,
    basis: UsdBasis,
    sync: SyncStatus | undefined,
    refresh: boolean,
  ): Promise<LedgerView> {
    const key = this.cacheKey(query, basis);
    const running = this.active.get(key);
    if (running) return running;
    if (this.closed || this.failed)
      return Promise.reject(reportError("ERR_REPORT_WORKER_UNAVAILABLE"));
    if (this.pending.size >= CACHE_LIMIT)
      return Promise.reject(reportError("ERR_REPORT_QUEUE_FULL"));

    const id = ++this.sequence;
    let task!: Promise<LedgerView>;
    const request = new Promise<LedgerView>((resolve, reject) => {
      this.pending.set(id, {
        resolve, reject,
        diagnostic: {
          queryId: this.cacheId(key),
          sort: query.sort, desc: query.desc, page: query.page,
          pageSize: query.pageSize, dimension: query.dimension,
          granularity: query.granularity,
          hasSearch: !!query.filter.search.trim(),
          hasModel: query.filter.model !== "all",
          hasAccount: query.filter.account !== "all",
          customRange: !!query.filter.dateRange,
          refresh,
        },
      });
      try {
        this.worker.postMessage({
          id,
          query,
          basis,
          sync,
          refresh,
          queuedAt: performance.timeOrigin + performance.now(),
        });
      } catch (error) {
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : reportError("ERR_REPORT_READ_FAILED"),
        );
      }
    });
    task = request.finally(() => {
      if (this.active.get(key) === task) this.active.delete(key);
    });
    this.active.set(key, task);
    return task;
  }

  private saveColdResult(
    key: string,
    query: ViewQuery,
    basis: UsdBasis,
    value: LedgerView,
    sync?: SyncStatus,
  ): CacheEntry {
    const existing = this.cache.get(key);
    if (existing) {
      existing.value = value;
      existing.lastUsed = this.now();
      existing.refreshing = false;
      existing.lastError = null;
      if (sync) existing.sync = sync;
      this.persistCache(existing);
      return existing;
    }
    const entry: CacheEntry = {
      key,
      query,
      basis,
      value,
      lastUsed: this.now(),
      refreshing: false,
      lastError: null,
      sync,
    };
    this.cache.set(key, entry);
    this.evictCache(key);
    this.persistCache(entry);
    return entry;
  }

  private evictCache(protectedKey: string) {
    while (this.cache.size > CACHE_LIMIT) {
      const victim = [...this.cache.values()]
        .filter((entry) => entry.key !== protectedKey)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!victim) return;
      this.cache.delete(victim.key);
    }
  }

  private publicResult(entry: CacheEntry, sync?: SyncStatus): ReportView {
    const currentSync = sync ?? entry.sync;
    const result = expireCachedQuotas(entry.value, this.now());
    return {
      ...result,
      ...(currentSync ? { sync: currentSync } : {}),
      reportStatus: {
        refreshing: entry.refreshing || this.indexRebuilding,
        rebuilding: this.indexRebuilding,
        lastError: entry.lastError,
      },
    };
  }

  private refreshEntry(
    entry: CacheEntry,
    sync: SyncStatus | undefined,
    trigger: "read" | "timer",
  ): Promise<void> {
    if (
      this.closed ||
      entry.refreshing ||
      this.cache.get(entry.key) !== entry
    ) {
      return Promise.resolve();
    }
    entry.refreshing = true;
    const task = this.dispatch(entry.query, entry.basis, sync, true)
      .then((result) => {
        if (this.closed || this.cache.get(entry.key) !== entry) return;
        entry.value = result;
        if (sync) entry.sync = sync;
        entry.lastError = null;
        this.persistCache(entry);
      })
      .catch((error: unknown) => {
        if (this.closed || this.cache.get(entry.key) !== entry) return;
        // 重建完成后会再刷新一轮，期间保留已有结果，不算作刷新失败。
        if (error instanceof ReportBuildingError) return;
        entry.lastError = summarizeError(error);
        this.diagnostics.warn("report.refresh_failed", {
          cacheKey: this.cacheId(entry.key),
          trigger,
          error: entry.lastError,
        });
      })
      .finally(() => {
        if (this.cache.get(entry.key) === entry) entry.refreshing = false;
      });
    return task;
  }

  private cacheId(key: string): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 16);
  }

  private startRefreshTimer() {
    if (!(this.refreshIntervalMs > 0)) return;
    this.refreshTimer = setInterval(() => {
      void this.refreshCachedEntries();
    }, this.refreshIntervalMs);
    const unref = (this.refreshTimer as unknown as { unref?: () => void })
      .unref;
    unref?.call(this.refreshTimer);
  }

  /** 等进行中的定时刷新结束后再完整刷新一轮，确保每个过渡结果都换成新索引的结果。 */
  private refreshAfterRebuild() {
    void (this.scheduledRefresh ?? Promise.resolve()).then(() =>
      this.refreshCachedEntries(),
    );
  }

  private refreshCachedEntries(): Promise<void> {
    if (this.closed || this.scheduledRefresh) {
      return this.scheduledRefresh ?? Promise.resolve();
    }
    let task!: Promise<void>;
    task = (async () => {
      const entries = [...this.cache.values()].sort(
        (left, right) => right.lastUsed - left.lastUsed,
      );
      for (const entry of entries) {
        if (this.closed) break;
        if (this.cache.get(entry.key) !== entry || entry.refreshing) continue;
        const sync = this.readSyncStatus() ?? entry.sync;
        if (!sync && this.getSyncStatus) continue;
        await this.refreshEntry(entry, sync, "timer");
      }
    })().finally(() => {
      if (this.scheduledRefresh === task) this.scheduledRefresh = null;
    });
    this.scheduledRefresh = task;
    return task;
  }

  private fail() {
    this.failed = true;
    const error = reportError("ERR_REPORT_WORKER_UNAVAILABLE");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async close() {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    const scheduled = this.scheduledRefresh;
    this.fail();
    this.closeTask = (async () => {
      await this.worker.terminate();
      await scheduled;
      await this.waitForCacheWrites();
      await this.closeCacheWriter();
    })();
    return this.closeTask;
  }
}
