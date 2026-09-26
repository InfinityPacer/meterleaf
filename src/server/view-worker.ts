import { renameSync, rmSync } from "node:fs";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { LedgerStore } from "../storage/ledger";
import { LifetimeIndex } from "../storage/lifetime-index";
import { sourceFileState } from "../storage/source-file-state";
import { priceBookKey, type PriceBook } from "../domain/pricing";
import { withUsdVariants, type ViewQuery } from "../shared/ledger-view";
import type { UsdBasis } from "../shared/report";
import { indexedSnapshot } from "./snapshot";
import { indexFiles } from "./index-files";
import { ReportProjection, type IndexedPricing } from "./report-projection";
import { createDiagnosticsLogger, summarizeError } from "./diagnostics";
import type { SyncStatus } from "./sync";

const config = workerData as {
  path: string;
  book: PriceBook;
  indexPath?: string;
  /** 账本事实少于此数时直接同步重建，耗时不到一秒，不值得启动线程。 */
  inlineRebuildLimit?: number;
};
const store = new LedgerStore(config.path, config.book, { readonly: true });
const indexPath = config.indexPath ?? ":memory:";
const nextIndexPath = `${indexPath}.next`;
const inlineRebuildLimit = config.inlineRebuildLimit ?? 2000;
/** 后台重建失败后，等待这段时间再重试，避免反复启动注定失败的线程。 */
const retryDelayMs = 60_000;
const diagnostics = createDiagnosticsLogger();

function openIndexes() {
  return {
    projection: new ReportProjection(store, config.path, indexPath),
    lifetime: new LifetimeIndex(
      indexPath === ":memory:" ? indexPath : `${indexPath}.lifetime`,
      store,
      { priceBookKey: priceBookKey(config.book) },
    ),
  };
}

let { projection, lifetime } = openIndexes();
let initialized = false;
/**
 * 后台重建进行中。previousPricing 非空时旧索引可用，查询沿用旧索引并标记为过渡结果；
 * 为空时（首次建立、账本被替换或旧价格不明）没有可展示的结果，查询回复计算中。
 */
let building: {
  worker: Worker;
  since: string;
  previousPricing: IndexedPricing | null;
} | null = null;
let retryAt = 0;

/** 查询前的索引状态：已是最新、沿用旧索引，或尚无可用结果。 */
type IndexState =
  | { mode: "current" }
  | { mode: "transitional"; pricing: IndexedPricing }
  | { mode: "building"; since: string };

function whileBuilding(): IndexState {
  return building!.previousPricing
    ? { mode: "transitional", pricing: building!.previousPricing }
    : { mode: "building", since: building!.since };
}

/**
 * 全量重建（首次建立、价格表或账户映射变化、账本替换）在 NAS 上可能耗时数分钟，
 * 因此放到独立线程，查询期间不排队等待：旧索引属于同一账本且价格版本可知时展示旧结果，
 * 否则回复计算中。小账本与内存索引仍同步重建。
 */
function prepareIndex(): IndexState {
  if (building) return whileBuilding();
  const needed = projection.rebuildNeeded();
  if (
    needed === "none" ||
    indexPath === ":memory:" ||
    usageCount() < inlineRebuildLimit
  ) {
    ensureInline();
    return { mode: "current" };
  }
  const previousPricing = needed === "same-source" ? usablePricing() : null;
  if (Date.now() < retryAt) {
    if (previousPricing) return { mode: "transitional", pricing: previousPricing };
    throw new Error("Report index rebuild failed recently");
  }
  if (!startBackgroundBuild(previousPricing)) {
    // 无法启动线程时只能同步重建，至少保证结果正确。
    ensureInline();
    return { mode: "current" };
  }
  return whileBuilding();
}

function ensureInline() {
  const changed = projection.ensure();
  lifetime.ensure({
    ...sourceFileState(config.path),
    dataVersion: store.reportFingerprint(),
  });
  if (!initialized || changed) {
    diagnostics.info("report.index_updated", { initial: !initialized });
  }
  initialized = true;
}

function usageCount(): number {
  return (
    store.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM usage_facts")
      .get()?.count ?? 0
  );
}

/** 旧索引可作过渡结果的前提：价格版本可知，且累计索引至少建过一次。 */
function usablePricing(): IndexedPricing | null {
  if (!lifetime.latestPriceBookKey()) return null;
  return indexedPricing();
}

function startBackgroundBuild(previousPricing: IndexedPricing | null): boolean {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./index-builder.ts", import.meta.url), {
      workerData: { path: config.path, book: config.book, target: nextIndexPath },
    });
  } catch (error) {
    diagnostics.warn("report.index_rebuild_unavailable", {
      error: summarizeError(error),
    });
    return false;
  }
  const startedAt = performance.now();
  building = { worker, since: new Date().toISOString(), previousPricing };
  diagnostics.info("report.index_rebuild_started", {
    background: true,
    transitional: previousPricing !== null,
  });
  let settled = false;
  const finish = () => {
    building = null;
    void worker.terminate();
    parentPort!.postMessage({ type: "index-rebuilt" });
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    retryAt = Date.now() + retryDelayMs;
    for (const file of indexFiles(nextIndexPath)) rmSync(file, { force: true });
    diagnostics.warn("report.index_rebuild_failed", {
      error: summarizeError(error),
    });
    finish();
  };
  worker.on("message", (message: { type?: string }) => {
    if (message.type !== "built" || settled) return;
    try {
      swapIndexes();
    } catch (error) {
      fail(error);
      return;
    }
    settled = true;
    initialized = true;
    diagnostics.info("report.index_rebuild_finished", {
      durationMs: Math.round(performance.now() - startedAt),
    });
    finish();
  });
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (code !== 0) fail(new Error(`Index builder exited: ${code}`));
  });
  return true;
}

/** 旧索引的价格表：新版本写在索引元数据里，早期索引从累计索引和账本记录的价格表推断。 */
function indexedPricing(): IndexedPricing | null {
  const recorded = projection.indexedPricing();
  if (recorded) return recorded;
  const key = lifetime.latestPriceBookKey();
  const book = key ? store.storedPriceBook(key) : null;
  return key && book
    ? { version: key, publishedAt: book.publishedAt, sources: book.sources }
    : null;
}

/**
 * 先关闭旧连接并删除旧 WAL，再用 rename 原子替换主文件；旧 WAL 若留下会被新文件误用。
 * 替换后重新打开，增量部分由下一次 ensure 从新检查点补上。
 */
function swapIndexes() {
  projection.close();
  lifetime.close();
  try {
    for (const base of [indexPath, `${indexPath}.lifetime`]) {
      rmSync(`${base}-wal`, { force: true });
      rmSync(`${base}-shm`, { force: true });
    }
    renameSync(nextIndexPath, indexPath);
    renameSync(`${nextIndexPath}.lifetime`, `${indexPath}.lifetime`);
  } finally {
    // 替换中途失败时重新打开现有文件，检查点不符的部分由下一次 ensure 同步重建。
    ({ projection, lifetime } = openIndexes());
  }
}

/** 查询只读取持久化小时汇总及当前明细页；事实解析仅发生于首次建索引或增量修订。 */
parentPort!.on(
  "message",
  (request: {
    id: number;
    query: ViewQuery;
    basis: UsdBasis;
    sync?: SyncStatus;
    /** 与主线程共享绝对时钟；缺失或无效时队列耗时按 0 计。 */
    queuedAt?: number;
  }) => {
    const started = performance.now();
    const receivedAt = performance.timeOrigin + performance.now();
    const queueMs =
      typeof request.queuedAt === "number" && Number.isFinite(request.queuedAt)
        ? Math.max(0, receivedAt - request.queuedAt)
        : 0;
    let indexMs = 0;
    let readMs = 0;
    let snapshotMs = 0;
    let aggregateMs = 0;
    let materializeMs = 0;
    let state = { mode: "current" } as IndexState;
    try {
      const result = store.db.transaction(() => {
        const indexStarted = performance.now();
        state = prepareIndex();
        indexMs = performance.now() - indexStarted;
        if (state.mode === "building") return null;
        const transitional = state.mode === "transitional";
        const now = new Date().toISOString();
        const readStarted = performance.now();
        const snapshots = {
          subscription: indexedSnapshot(
            store,
            request.sync ? { status: () => request.sync! } : null,
            now,
            "subscription",
            (accountId, from, to, selectedBasis, modelScope) =>
              projection.index.sumWindow(
                accountId,
                from,
                to,
                selectedBasis,
                modelScope,
              ),
            projection.accountIds(),
          ),
          api: indexedSnapshot(
            store,
            request.sync ? { status: () => request.sync! } : null,
            now,
            "api",
            (accountId, from, to, selectedBasis, modelScope) =>
              projection.index.sumWindow(
                accountId,
                from,
                to,
                selectedBasis,
                modelScope,
              ),
            projection.accountIds(),
          ),
        } as const;
        snapshotMs = performance.now() - readStarted;
        const aggregateStarted = performance.now();
        const prepared = projection.index.prepare(
          snapshots.subscription,
          request.query,
        );
        aggregateMs = performance.now() - aggregateStarted;
        const materializeStarted = performance.now();
        const read = (basis: UsdBasis) => {
          const view = projection.index.materialize(prepared, basis, snapshots[basis]);
          return {
            ...view,
            accounts: view.accounts.map((account) => ({
              ...account,
              lifetime: projection.index.accountLifetime(account.id, basis),
            })),
            lifetimeTotals: lifetime.value(basis, now, { transitional }),
          };
        };
        const result = withUsdVariants(
          read("subscription"),
          read("api"),
          request.basis,
        );
        materializeMs = performance.now() - materializeStarted;
        readMs = performance.now() - readStarted;
        // 过渡结果的金额来自旧索引，价格版本也必须是旧的。
        return state.mode === "transitional"
          ? { ...result, pricing: state.pricing }
          : result;
      })();
      if (state.mode === "building") {
        parentPort!.postMessage({ id: request.id, building: { since: state.since } });
        return;
      }
      parentPort!.postMessage({
        id: request.id,
        result,
        transitional: state.mode === "transitional",
        timings: { queueMs, indexMs, readMs, snapshotMs, aggregateMs, materializeMs },
      });
    } catch (error) {
      diagnostics.warn("report.query_failed", {
        durationMs: Math.round(performance.now() - started),
        error: summarizeError(error),
      });
      parentPort!.postMessage({ id: request.id, error: "report-read-failed" });
    }
  },
);
