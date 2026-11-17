import { createHash } from "node:crypto";
import { priceBookKey } from "../domain/pricing";
import type { LedgerStore } from "../storage/ledger";
import { ReportIndex } from "../storage/report-index";
import { currentSchemaRevision } from "../storage/schema";
import { sourceFileState } from "../storage/source-file-state";
import { createAccountResolver, ref, toLedgerRecord } from "./snapshot";

export interface IndexedPricing {
  version: string;
  publishedAt: string;
  sources: string[];
}

interface ProjectionCheckpoint {
  format: number;
  schemaRevision: string;
  identity: string;
  stamp: string;
  book: string;
  accounts: string;
  tracked: boolean;
  sequence: number;
  revision: number;
}

/** 派生数据与源游标同事务提交；重放修订、删除与首次构建使用同一事实转换。 */
export class ReportProjection {
  readonly index: ReportIndex;
  private initialized = false;
  private revision = -1;
  private fingerprint = "";
  private readonly book: string;
  private observedAccounts: string[] | undefined;

  constructor(
    private readonly store: LedgerStore,
    private readonly sourcePath: string,
    indexPath: string,
  ) {
    this.index = new ReportIndex(indexPath);
    this.book = createHash("sha256")
      .update(JSON.stringify(store.book))
      .digest("hex");
  }

  /**
   * 只判断下一次 ensure 是否需要全量重建，不写入索引。尚无索引或源文件身份变了
   * （账本被替换）时返回 replaced-source，旧索引不属于当前账本，不能作为过渡结果。
   */
  rebuildNeeded(): {
    kind: "none" | "same-source" | "replaced-source";
    reason: string | null;
  } {
    if (this.upToDate()) return { kind: "none", reason: null };
    return this.store.db.transaction(() => {
      const { previous, checkpoint, reason } = this.plan();
      if (!reason) return { kind: "none" as const, reason };
      return {
        kind:
          previous?.identity === checkpoint.identity
            ? ("same-source" as const)
            : ("replaced-source" as const),
        reason,
      };
    })();
  }

  private upToDate(): boolean {
    return (
      this.initialized &&
      this.store.revision() === this.revision &&
      this.store.reportFingerprint() === this.fingerprint
    );
  }

  /** 按检查点比较源身份、价格表、账户映射与变更序号，决定全量重建或增量应用。 */
  private plan() {
    const file = sourceFileState(this.sourcePath);
    const state = this.store.reportUsageChangeState();
    const accounts = this.store.accounts();
    // 只记录归到别的账户名下的那部分归属。新增一个独立账户不改变任何已有记录的归属，
    // 不必全量重建；新增账户若是某条父链或合并的目标，会让其他账户改归属，仍会重建。
    const merges = this.store.accountMerges();
    const resolve = createAccountResolver(accounts, merges);
    const keys = new Set([
      ...accounts.map((account) => ref(account.sourceId, account.externalId)),
      ...Object.keys(merges),
    ]);
    const mapping = JSON.stringify(
      [...keys]
        .flatMap((key) => {
          const separator = key.indexOf(":");
          const root = resolve(
            decodeURIComponent(key.slice(0, separator)),
            decodeURIComponent(key.slice(separator + 1)),
          );
          return root === key ? [] : [[key, root]];
        })
        .sort(),
    );
    const row = this.index.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM projection_checkpoint WHERE id=1",
      )
      .get();
    const previous = row
      ? (JSON.parse(row.payload) as ProjectionCheckpoint)
      : null;
    // 变更日志可能已被清理。检查点等于“现存最小序号 - 1”时下一条正好还在，
    // 更早则说明中间那段变更已经不可读，只能全量重建。
    const changeFloor = this.store.reportUsageChangeFloor();
    const checkpoint: ProjectionCheckpoint = {
      // 格式 2 起明细表不再建降序分页索引；旧格式文件整份重建一次，回滚到旧版本时
      // 旧版本也会因格式不符重建出它需要的索引。
      format: 2,
      schemaRevision: currentSchemaRevision(this.index.db, "report"),
      ...file,
      book: this.book,
      accounts: mapping,
      tracked: state.tracked,
      sequence: state.lastSequence,
      revision: this.store.revision(),
    };
    // 按顺序取第一个成立的原因，写进重建日志，便于事后判断是什么引起了全量重建。
    const reasons: [string, boolean][] = [
      ["no-index", !previous],
      ["format", previous?.format !== checkpoint.format],
      ["schema", previous?.schemaRevision !== checkpoint.schemaRevision],
      ["source-replaced", previous?.identity !== file.identity],
      ["price-book", previous?.book !== this.book],
      ["account-ownership", previous?.accounts !== mapping],
      ["change-tracking", previous?.tracked !== state.tracked],
      [
        "sequence-rollback",
        previous !== null && previous.sequence > state.lastSequence,
      ],
      [
        "changes-pruned",
        previous !== null &&
          previous.tracked &&
          changeFloor !== null &&
          previous.sequence < changeFloor - 1,
      ],
      [
        "revision-rollback",
        (previous !== null && previous.revision > checkpoint.revision) ||
          (this.initialized && this.revision > checkpoint.revision),
      ],
      ["source-stamp", !state.tracked && previous?.stamp !== file.stamp],
    ];
    const reason = reasons.find(([, hit]) => hit)?.[0] ?? null;
    const rebuild = reason !== null;
    return { accounts, state, previous, checkpoint, rebuild, reason };
  }

  /** 返回是否改变了报表事实。配额或状态更新不会触发全量账单转换。 */
  ensure(): boolean {
    if (this.upToDate()) return false;
    const revision = this.store.revision();
    const fingerprint = this.store.reportFingerprint();
    const changed = this.store.db.transaction(() => {
      const { accounts, state, previous, checkpoint, rebuild } = this.plan();
      // 有日志的来源以用量游标确认报表事实；额度刷新只更新当前连接的观察状态。
      if (
        state.tracked &&
        !rebuild &&
        state.lastSequence === previous!.sequence
      )
        return false;
      const root = createAccountResolver(accounts, this.store.accountMerges());
      return this.index.db.transaction(() => {
        let updated = rebuild;
        if (rebuild) {
          const store = this.store;
          this.index.replace(
            (function* () {
              for (const usage of store.reportUsages())
                yield toLedgerRecord(usage, root, "subscription");
            })(),
          );
        } else if (state.lastSequence > previous!.sequence) {
          const delta = this.store.storedUsageChangeStream(previous!.sequence);
          this.index.applyChanges(
            (function* () {
              for (const change of delta.changes) {
                updated = true;
                yield {
                  id: ref(change.sourceId, change.externalId),
                  record: change.usage
                    ? toLedgerRecord(change.usage, root, "subscription")
                    : null,
                };
              }
            })(),
          );
          checkpoint.sequence = delta.lastSequence;
        }
        this.index.db
          .query(
            "INSERT INTO projection_checkpoint VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
          )
          .run(JSON.stringify(checkpoint));
        if (rebuild) this.index.setMeta("pricing", this.pricing());
        return updated;
      })();
    })();
    this.revision = revision;
    this.fingerprint = fingerprint;
    this.initialized = true;
    if (changed) this.observedAccounts = undefined;
    return changed;
  }

  /**
   * 在回滚的索引事务里运行 fn；fn 内 ensure 补进的变更与连接内的检查点观察都在返回后
   * 还原，之后的 ensure 仍会把这些变更真正提交。
   */
  rollbackAfter<T>(fn: () => T): T {
    const { initialized, revision, fingerprint, observedAccounts } = this;
    try {
      return this.index.rollbackAfter(fn);
    } finally {
      this.initialized = initialized;
      this.revision = revision;
      this.fingerprint = fingerprint;
      this.observedAccounts = observedAccounts;
    }
  }

  /** 索引事实已提交的消费水位与账本最新变更序号之差；不使用变更日志时返回 null。 */
  pendingChanges(): number | null {
    const committed = this.committedSequence();
    if (committed === null) return null;
    const state = this.store.reportUsageChangeState();
    return state.tracked ? state.lastSequence - committed : null;
  }

  /** 索引内金额所依据的价格表；后台重建期间用它标注过渡结果。 */
  indexedPricing(): IndexedPricing | null {
    return this.index.getMeta<IndexedPricing>("pricing");
  }

  /** 合并变化后旧索引的账户归属不能与新额度混用。 */
  accountsCurrent(): boolean {
    const { previous, checkpoint } = this.plan();
    return previous?.accounts === checkpoint.accounts;
  }

  /**
   * 报表索引已提交的消费水位；索引尚未建立或来源不使用变更日志时返回 null。
   * 与累计索引的水位取较小值，才能安全清理两者都已消费的变更记录。
   */
  committedSequence(): number | null {
    const row = this.index.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM projection_checkpoint WHERE id=1",
      )
      .get();
    if (!row) return null;
    const checkpoint = JSON.parse(row.payload) as ProjectionCheckpoint;
    return checkpoint.tracked ? checkpoint.sequence : null;
  }

  private pricing(): IndexedPricing {
    return {
      version: priceBookKey(this.store.book),
      publishedAt: this.store.book.publishedAt,
      sources: this.store.book.sources,
    };
  }

  accountIds(): string[] {
    return (this.observedAccounts ??= this.index.accountIds());
  }

  close() {
    this.index.close();
  }
}
