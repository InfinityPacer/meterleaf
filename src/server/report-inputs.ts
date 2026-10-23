import type { SourceAccount } from "../domain/connector";
import {
  selectReportQuotas,
  type LedgerStore,
  type ReportQuotaCandidates,
  type StoredQuota,
} from "../storage/ledger";

/** 一次报表查询从账本读取的账户、合并关系与额度快照。 */
export interface ReportInputs {
  accounts: SourceAccount[];
  merges: Record<string, string>;
  quotas: StoredQuota[];
}

/**
 * 跨查询复用报表快照的账本输入。打开页面会连续发出多个报表查询，账本通常没有变化，
 * 每次重新扫描额度历史和解析账户资料是重复劳动。
 *
 * 复用以账本版本 ledger:dataRevision 为界：它与事实在同一事务内推进，账户、额度快照、
 * 套餐观测与指定、账户合并的每次实际变化都会推进它，重复推送不会。额度快照的截取点随时间
 * 后移，候选在同一版本内按当前时刻重新截取；时钟回拨时重新读取。价格表由进程启动时固定，
 * 不在此处失效。必须在读取事务内调用，版本与内容才来自同一快照。
 */
export class ReportInputCache {
  private cached: {
    revision: number;
    accounts: SourceAccount[];
    merges: Record<string, string>;
    candidates: ReportQuotaCandidates;
  } | null = null;

  constructor(private readonly store: LedgerStore) {}

  read(now: string): ReportInputs {
    const revision = this.store.revision();
    const cached = this.cached;
    if (cached?.revision === revision) {
      const quotas = selectReportQuotas(cached.candidates, now);
      if (quotas)
        return { accounts: cached.accounts, merges: cached.merges, quotas };
    }
    const next = {
      revision,
      accounts: this.store.accounts(),
      merges: this.store.accountMerges(),
      candidates: this.store.reportQuotaCandidates(now),
    };
    this.cached = next;
    return {
      accounts: next.accounts,
      merges: next.merges,
      quotas: selectReportQuotas(next.candidates, now)!,
    };
  }
}
