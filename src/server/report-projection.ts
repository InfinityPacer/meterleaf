import { createHash } from "node:crypto";
import type { LedgerStore } from "../storage/ledger";
import { ReportIndex } from "../storage/report-index";
import { currentSchemaRevision } from "../storage/schema";
import { sourceFileState } from "../storage/source-file-state";
import { createAccountResolver, ref, toLedgerRecord } from "./snapshot";

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

  /** 返回是否改变了报表事实。配额或状态更新不会触发全量账单转换。 */
  ensure(): boolean {
    const revision = this.store.revision();
    const fingerprint = this.store.reportFingerprint();
    if (
      this.initialized &&
      revision === this.revision &&
      fingerprint === this.fingerprint
    )
      return false;
    const changed = this.store.db.transaction(() => {
      const file = sourceFileState(this.sourcePath);
      const state = this.store.reportUsageChangeState();
      const accounts = this.store.accounts();
      const mapping = JSON.stringify(
        accounts
          .map((account) => [
            account.sourceId,
            account.externalId,
            account.parentExternalId,
          ])
          .sort(),
      );
      const root = createAccountResolver(accounts);
      const row = this.index.db
        .query<{ payload: string }, []>(
          "SELECT payload FROM projection_checkpoint WHERE id=1",
        )
        .get();
      const previous = row
        ? (JSON.parse(row.payload) as ProjectionCheckpoint)
        : null;
      const checkpoint: ProjectionCheckpoint = {
        format: 1,
        schemaRevision: currentSchemaRevision(this.index.db, "report"),
        ...file,
        book: this.book,
        accounts: mapping,
        tracked: state.tracked,
        sequence: state.lastSequence,
        revision: this.store.revision(),
      };
      const rebuild =
        !previous ||
        previous.format !== checkpoint.format ||
        previous.schemaRevision !== checkpoint.schemaRevision ||
        previous.identity !== file.identity ||
        previous.book !== this.book ||
        previous.accounts !== mapping ||
        previous.tracked !== state.tracked ||
        previous.sequence > state.lastSequence ||
        previous.revision > checkpoint.revision ||
        (!state.tracked && previous.stamp !== file.stamp);
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
        return updated;
      })();
    })();
    this.revision = revision;
    this.fingerprint = fingerprint;
    this.initialized = true;
    if (changed) this.observedAccounts = undefined;
    return changed;
  }

  accountIds(): string[] {
    return (this.observedAccounts ??= this.index.accountIds());
  }

  close() {
    this.index.close();
  }
}
