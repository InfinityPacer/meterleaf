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
};
const store = new LedgerStore(config.path, config.book, { readonly: true });
const indexPath = config.indexPath ?? ":memory:";
const nextIndexPath = `${indexPath}.next`;
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
/** 后台重建进行中时，查询沿用旧索引并标记为过渡结果。 */
let building: {
  worker: Worker;
  startedAt: number;
  previousPricing: IndexedPricing;
} | null = null;
/** 后台重建失败后改回在查询中同步重建，避免反复启动失败的线程。 */
let backgroundFailed = false;

/**
 * 需要全量重建且已有旧索引时，改为后台重建。价格表或账户映射变化会触发全量重建，
 * 在 NAS 上可能耗时数分钟；同步重建期间所有查询都要排队等待。
 */
function startBackgroundBuild(): boolean {
  if (building) return true;
  if (backgroundFailed || indexPath === ":memory:") return false;
  if (projection.rebuildNeeded() !== "same-source") return false;
  const previousPricing = indexedPricing();
  // 说不清旧索引按哪版价格计算，或旧索引属于另一套价格表时，不能把旧金额作为过渡结果展示。
  if (!previousPricing || !sameLineage(previousPricing.version)) return false;
  const worker = new Worker(new URL("./index-builder.ts", import.meta.url), {
    workerData: { path: config.path, book: config.book, target: nextIndexPath },
  });
  const startedAt = performance.now();
  building = { worker, startedAt, previousPricing };
  diagnostics.info("report.index_rebuild_started", { background: true });
  let settled = false;
  const finish = () => {
    building = null;
    void worker.terminate();
    parentPort!.postMessage({ type: "index-rebuilt" });
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    backgroundFailed = true;
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

/** 同一价格表的其他版本，或本价格表声明接替的旧标识。 */
function sameLineage(previousKey: string): boolean {
  const previousId = previousKey.slice(0, previousKey.indexOf("@"));
  return (
    previousId === config.book.id ||
    (config.book.supersedes ?? []).includes(previousId)
  );
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
    sync: SyncStatus;
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
    let transitional = false;
    try {
      const result = store.db.transaction(() => {
        const indexStarted = performance.now();
        transitional = startBackgroundBuild();
        let changed = false;
        if (!transitional) {
          changed = projection.ensure();
          lifetime.ensure({
            ...sourceFileState(config.path),
            dataVersion: store.reportFingerprint(),
          });
        }
        indexMs = performance.now() - indexStarted;
        if (!transitional && (!initialized || changed)) {
          diagnostics.info("report.index_updated", {
            initial: !initialized,
            durationMs: Math.round(performance.now() - started),
          });
        }
        if (!transitional) initialized = true;
        const now = new Date().toISOString();
        const readStarted = performance.now();
        const snapshots = {
          subscription: indexedSnapshot(
            store,
            { status: () => request.sync },
            now,
            "subscription",
            (accountId, from, to, selectedBasis) =>
              projection.index.sumWindow(accountId, from, to, selectedBasis),
            projection.accountIds(),
          ),
          api: indexedSnapshot(
            store,
            { status: () => request.sync },
            now,
            "api",
            (accountId, from, to, selectedBasis) =>
              projection.index.sumWindow(accountId, from, to, selectedBasis),
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
        return transitional && building
          ? { ...result, pricing: building.previousPricing }
          : result;
      })();
      parentPort!.postMessage({
        id: request.id,
        result,
        transitional,
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
