import {
  withUsdVariants,
  type LedgerView,
  type ViewQuery,
} from "../shared/ledger-view";
import type { UsdBasis } from "../shared/report";
import type { LedgerStore } from "../storage/ledger";
import type { LifetimeIndex } from "../storage/lifetime-index";
import type { ReportInputCache } from "./report-inputs";
import type { ReportProjection } from "./report-projection";
import { indexedSnapshot } from "./snapshot";
import type { SyncStatus } from "./sync";

export interface ReportReadTimings {
  snapshotMs: number;
  aggregateMs: number;
  materializeMs: number;
}

/**
 * 按已就绪的索引计算一次报表结果。调用方负责在账本读取事务内调用并先补齐索引；
 * 结果只取决于账本快照、索引内容与 now，输入缓存只省去重复读取。
 */
export function readReportView(
  sources: {
    store: LedgerStore;
    projection: ReportProjection;
    lifetime: LifetimeIndex;
    inputs: ReportInputCache;
  },
  request: { query: ViewQuery; basis: UsdBasis; sync?: SyncStatus },
  now: string,
  transitional: boolean,
): { result: LedgerView; timings: ReportReadTimings } {
  const { store, projection, lifetime, inputs } = sources;
  const started = performance.now();
  // 两个口径在同一事务内读取相同的账户与近期额度历史，只读一次；窗口汇总同理。
  // 账本版本未变的连续查询沿用上次读取的输入与固定窗口汇总。
  const sumWindow = projection.index.windowReader();
  const { accounts, quotas, merges } = inputs.read(now);
  const ledger = {
    book: store.book,
    accounts: () => accounts,
    quotas: () => quotas,
    accountMerges: () => merges,
  };
  const sync = request.sync ? { status: () => request.sync! } : null;
  const snapshots = {
    subscription: indexedSnapshot(
      ledger,
      sync,
      now,
      "subscription",
      sumWindow,
      projection.accountIds(),
    ),
    api: indexedSnapshot(
      ledger,
      sync,
      now,
      "api",
      sumWindow,
      projection.accountIds(),
    ),
  } as const;
  const snapshotMs = performance.now() - started;
  const aggregateStarted = performance.now();
  const prepared = projection.index.prepare(
    snapshots.subscription,
    request.query,
  );
  const aggregateMs = performance.now() - aggregateStarted;
  const materializeStarted = performance.now();
  const read = (basis: UsdBasis) => {
    const view = projection.index.materialize(
      prepared,
      basis,
      snapshots[basis],
    );
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
  const materializeMs = performance.now() - materializeStarted;
  return {
    // 版本与输入在同一读取事务内取得，前端据此判断首屏结果是否已包含最新提交。
    result: { ...result, ledgerRevision: store.revision() },
    timings: { snapshotMs, aggregateMs, materializeMs },
  };
}
