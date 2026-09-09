import { parentPort, workerData } from "node:worker_threads";
import { LedgerStore } from "../storage/ledger";
import { LifetimeIndex } from "../storage/lifetime-index";
import { sourceFileState } from "../storage/source-file-state";
import { priceBookKey, type PriceBook } from "../domain/pricing";
import { withUsdVariants, type ViewQuery } from "../shared/ledger-view";
import type { UsdBasis } from "../shared/report";
import { indexedSnapshot } from "./snapshot";
import { ReportProjection } from "./report-projection";
import { createDiagnosticsLogger, summarizeError } from "./diagnostics";
import type { SyncStatus } from "./sync";

const config = workerData as {
  path: string;
  book: PriceBook;
  indexPath?: string;
};
const store = new LedgerStore(config.path, config.book, { readonly: true });
const indexPath = config.indexPath ?? ":memory:";
const projection = new ReportProjection(store, config.path, indexPath);
const lifetime = new LifetimeIndex(
  indexPath === ":memory:" ? indexPath : `${indexPath}.lifetime`,
  store,
  {
    priceBookKey: priceBookKey(config.book),
  },
);
const diagnostics = createDiagnosticsLogger();
let initialized = false;

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
    try {
      const result = store.db.transaction(() => {
        const indexStarted = performance.now();
        const changed = projection.ensure();
        lifetime.ensure({
          ...sourceFileState(config.path),
          dataVersion: store.reportFingerprint(),
        });
        indexMs = performance.now() - indexStarted;
        if (!initialized || changed) {
          diagnostics.info("report.index_updated", {
            initial: !initialized,
            durationMs: Math.round(performance.now() - started),
          });
        }
        initialized = true;
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
            lifetimeTotals: lifetime.value(basis, now),
          };
        };
        const result = withUsdVariants(
          read("subscription"),
          read("api"),
          request.basis,
        );
        materializeMs = performance.now() - materializeStarted;
        readMs = performance.now() - readStarted;
        return result;
      })();
      parentPort!.postMessage({
        id: request.id,
        result,
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
