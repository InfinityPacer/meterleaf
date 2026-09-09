import { Database } from "bun:sqlite";
import {
  DATABASE_SCHEMA_REVISION,
  assertReadableSchema,
  migrateSchema,
} from "./schema";
import Decimal from "decimal.js";
import type {
  ReportUsageChanges,
  ReportUsageChangeStream,
  ReportUsageMetric,
} from "./ledger";
import type { UsdBasis } from "../domain/pricing";
import type { LifetimeTotals } from "../shared/ledger-view";

/** LifetimeIndex 只读取事实账本；索引文件是独立的派生数据，不拥有源账本写权限。 */
export interface LifetimeIndexSource {
  readonly db: Database;
  revision(): number;
  reportUsageMetrics(): ReportUsageMetric[];
  reportUsageChangeState(): Pick<
    ReportUsageChanges,
    "tracked" | "lastSequence"
  >;
  reportUsageChanges(afterSequence: number): ReportUsageChanges;
  /** 流必须在来源事务结束前耗尽；旧来源可继续使用数组接口。 */
  reportUsageChangeStream?(afterSequence: number): ReportUsageChangeStream;
  reportUsageMetricStream?(): Iterable<ReportUsageMetric>;
}

/** ensure 的源状态；dataVersion 只用于当前连接内快速跳过稳定读，不会落盘。 */
export interface LifetimeIndexEnsureOptions {
  identity: string;
  stamp: string;
  dataVersion?: string | number;
}

export interface LifetimeIndexOptions {
  priceBookKey: string;
}

interface MutableAmount {
  value: Decimal;
  known: number;
}

interface MutableNumber {
  value: number;
  known: number;
}

interface MutableTotals {
  count: number;
  from: string | null;
  to: string | null;
  input: MutableNumber;
  cacheRead: MutableNumber;
  cacheWrite: MutableNumber;
  output: MutableNumber;
  tokenTotal: MutableNumber;
  incompleteTokenRows: number;
  apiUsd: MutableAmount;
  subscriptionUsd: MutableAmount;
  credits: MutableAmount;
  boundsDirty: boolean;
}

interface MutableState {
  identity: string;
  stamp: string;
  sourceRevision: number;
  checkpoint: number;
  tracked: boolean;
  totals: MutableTotals;
}

interface StateRow {
  source_identity: string;
  source_stamp: string;
  source_revision: number;
  checkpoint: number;
  tracked: number;
  count: number;
  from_at: string | null;
  to_at: string | null;
  input_total: number;
  input_known: number;
  cache_read_total: number;
  cache_read_known: number;
  cache_write_total: number;
  cache_write_known: number;
  output_total: number;
  output_known: number;
  token_total: number;
  token_total_known: number;
  incomplete_token_rows: number;
  api_usd_total: string;
  api_usd_known: number;
  subscription_usd_total: string;
  subscription_usd_known: number;
  credits_total: string;
  credits_known: number;
}

interface IndexMetricRow {
  source_id: string;
  external_id: string;
  occurred_at: string;
  input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
  api_usd: string | null;
  subscription_usd: string | null;
  credits: string | null;
}

interface SourceObservation {
  revision: number;
  changeState: Pick<ReportUsageChanges, "tracked" | "lastSequence">;
  changes: ReportUsageChangeStream | null;
  resetRequired: boolean;
}

function emptyNumber(): MutableNumber {
  return { value: 0, known: 0 };
}

function emptyAmount(): MutableAmount {
  return { value: new Decimal(0), known: 0 };
}

function emptyTotals(): MutableTotals {
  return {
    count: 0,
    from: null,
    to: null,
    input: emptyNumber(),
    cacheRead: emptyNumber(),
    cacheWrite: emptyNumber(),
    output: emptyNumber(),
    tokenTotal: emptyNumber(),
    incompleteTokenRows: 0,
    apiUsd: emptyAmount(),
    subscriptionUsd: emptyAmount(),
    credits: emptyAmount(),
    boundsDirty: false,
  };
}

function cloneNumber(value: MutableNumber): MutableNumber {
  return { value: value.value, known: value.known };
}

function cloneAmount(value: MutableAmount): MutableAmount {
  return { value: new Decimal(value.value), known: value.known };
}

function cloneTotals(value: MutableTotals): MutableTotals {
  return {
    count: value.count,
    from: value.from,
    to: value.to,
    input: cloneNumber(value.input),
    cacheRead: cloneNumber(value.cacheRead),
    cacheWrite: cloneNumber(value.cacheWrite),
    output: cloneNumber(value.output),
    tokenTotal: cloneNumber(value.tokenTotal),
    incompleteTokenRows: value.incompleteTokenRows,
    apiUsd: cloneAmount(value.apiUsd),
    subscriptionUsd: cloneAmount(value.subscriptionUsd),
    credits: cloneAmount(value.credits),
    boundsDirty: value.boundsDirty,
  };
}

function cloneState(value: MutableState): MutableState {
  return {
    identity: value.identity,
    stamp: value.stamp,
    sourceRevision: value.sourceRevision,
    checkpoint: value.checkpoint,
    tracked: value.tracked,
    totals: cloneTotals(value.totals),
  };
}

function addNumber(
  target: MutableNumber,
  value: number | null,
  direction: 1 | -1,
) {
  if (value === null || !Number.isFinite(value)) return;
  target.value += direction * value;
  target.known += direction;
}

function addAmount(
  target: MutableAmount,
  value: string | null,
  direction: 1 | -1,
) {
  if (value === null) return;
  target.value = target.value.add(
    new Decimal(value).mul(direction === 1 ? 1 : -1),
  );
  target.known += direction;
}

function metricFromRow(row: IndexMetricRow): ReportUsageMetric {
  return {
    sourceId: row.source_id,
    externalId: row.external_id,
    occurredAt: row.occurred_at,
    input: row.input,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    output: row.output,
    apiUsd: row.api_usd,
    subscriptionUsd: row.subscription_usd,
    credits: row.credits,
  };
}

function addMetric(totals: MutableTotals, metric: ReportUsageMetric) {
  totals.count += 1;
  if (totals.from === null || metric.occurredAt < totals.from)
    totals.from = metric.occurredAt;
  if (totals.to === null || metric.occurredAt > totals.to)
    totals.to = metric.occurredAt;
  addNumber(totals.input, metric.input, 1);
  addNumber(totals.cacheRead, metric.cacheRead, 1);
  addNumber(totals.cacheWrite, metric.cacheWrite, 1);
  addNumber(totals.output, metric.output, 1);

  const tokenValues = [
    metric.input,
    metric.cacheRead,
    metric.cacheWrite,
    metric.output,
  ];
  const knownTokens = tokenValues.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (knownTokens.length) {
    totals.tokenTotal.known += 1;
    totals.tokenTotal.value += knownTokens.reduce(
      (total, value) => total + value,
      0,
    );
  }
  if (knownTokens.length !== tokenValues.length)
    totals.incompleteTokenRows += 1;

  addAmount(totals.apiUsd, metric.apiUsd, 1);
  addAmount(totals.subscriptionUsd, metric.subscriptionUsd, 1);
  addAmount(totals.credits, metric.credits, 1);
}

function removeMetric(totals: MutableTotals, metric: ReportUsageMetric) {
  totals.count -= 1;
  if (metric.occurredAt === totals.from || metric.occurredAt === totals.to)
    totals.boundsDirty = true;
  addNumber(totals.input, metric.input, -1);
  addNumber(totals.cacheRead, metric.cacheRead, -1);
  addNumber(totals.cacheWrite, metric.cacheWrite, -1);
  addNumber(totals.output, metric.output, -1);

  const tokenValues = [
    metric.input,
    metric.cacheRead,
    metric.cacheWrite,
    metric.output,
  ];
  const knownTokens = tokenValues.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (knownTokens.length) {
    totals.tokenTotal.known -= 1;
    totals.tokenTotal.value -= knownTokens.reduce(
      (total, value) => total + value,
      0,
    );
  }
  if (knownTokens.length !== tokenValues.length)
    totals.incompleteTokenRows -= 1;

  addAmount(totals.apiUsd, metric.apiUsd, -1);
  addAmount(totals.subscriptionUsd, metric.subscriptionUsd, -1);
  addAmount(totals.credits, metric.credits, -1);
}

function stateFromRow(row: StateRow): MutableState {
  return {
    identity: row.source_identity,
    stamp: row.source_stamp,
    sourceRevision: row.source_revision,
    checkpoint: row.checkpoint,
    tracked: row.tracked !== 0,
    totals: {
      count: row.count,
      from: row.from_at,
      to: row.to_at,
      input: { value: row.input_total, known: row.input_known },
      cacheRead: {
        value: row.cache_read_total,
        known: row.cache_read_known,
      },
      cacheWrite: {
        value: row.cache_write_total,
        known: row.cache_write_known,
      },
      output: { value: row.output_total, known: row.output_known },
      tokenTotal: {
        value: row.token_total,
        known: row.token_total_known,
      },
      incompleteTokenRows: row.incomplete_token_rows,
      apiUsd: {
        value: new Decimal(row.api_usd_total),
        known: row.api_usd_known,
      },
      subscriptionUsd: {
        value: new Decimal(row.subscription_usd_total),
        known: row.subscription_usd_known,
      },
      credits: {
        value: new Decimal(row.credits_total),
        known: row.credits_known,
      },
      boundsDirty: false,
    },
  };
}

/** 持久化全历史 primitive 指标；索引数据与源账本分离，冷启动不再扫描全量事实。 */
export class LifetimeIndex {
  readonly db: Database;
  private state: MutableState | undefined;
  private lastDataVersion: string | undefined;

  constructor(
    path: string,
    private readonly source: LifetimeIndexSource,
    private readonly options: LifetimeIndexOptions,
  ) {
    if (!options.priceBookKey)
      throw new Error("Lifetime index price book key is required");
    this.db = new Database(path, { create: true, strict: true });
    assertReadableSchema(this.db, "lifetime");
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    migrateSchema(this.db, "lifetime", [
      {
        revision: DATABASE_SCHEMA_REVISION,
        downRevision: null,
        apply: (db) =>
          db.exec(`
      CREATE TABLE IF NOT EXISTS lifetime_index_state (
        price_book_key TEXT PRIMARY KEY,
        source_identity TEXT NOT NULL,
        source_stamp TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        checkpoint INTEGER NOT NULL,
        tracked INTEGER NOT NULL CHECK (tracked IN (0, 1)),
        count INTEGER NOT NULL,
        from_at TEXT,
        to_at TEXT,
        input_total REAL NOT NULL,
        input_known INTEGER NOT NULL,
        cache_read_total REAL NOT NULL,
        cache_read_known INTEGER NOT NULL,
        cache_write_total REAL NOT NULL,
        cache_write_known INTEGER NOT NULL,
        output_total REAL NOT NULL,
        output_known INTEGER NOT NULL,
        token_total REAL NOT NULL,
        token_total_known INTEGER NOT NULL,
        incomplete_token_rows INTEGER NOT NULL,
        api_usd_total TEXT NOT NULL,
        api_usd_known INTEGER NOT NULL,
        subscription_usd_total TEXT NOT NULL,
        subscription_usd_known INTEGER NOT NULL,
        credits_total TEXT NOT NULL,
        credits_known INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lifetime_index_rows (
        price_book_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        input REAL,
        cache_read REAL,
        cache_write REAL,
        output REAL,
        api_usd TEXT,
        subscription_usd TEXT,
        credits TEXT,
        PRIMARY KEY (price_book_key, source_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS lifetime_index_rows_time
        ON lifetime_index_rows(price_book_key, occurred_at);
    `),
      },
    ]);
  }

  /**
   * 以 sequence 与 revision 消费变更日志；无日志源比较每次调用传入的 identity/stamp。
   * dataVersion 只在当前 worker 连接内生效，不能成为持久化命中条件。
   */
  ensure(sourceState: LifetimeIndexEnsureOptions): boolean {
    return this.source.db.transaction(() => this.ensureSnapshot(sourceState))();
  }

  private ensureSnapshot(sourceState: LifetimeIndexEnsureOptions): boolean {
    if (!sourceState.identity)
      throw new Error("Lifetime index source identity is required");
    if (!sourceState.stamp)
      throw new Error("Lifetime index source stamp is required");
    const dataVersion =
      sourceState.dataVersion === undefined
        ? undefined
        : String(sourceState.dataVersion);
    const previousDataVersion = this.lastDataVersion;

    const current = this.loadState();
    if (!current || current.identity !== sourceState.identity)
      return this.complete(dataVersion, this.rebuild(sourceState));

    if (!current.tracked) {
      if (current.stamp === sourceState.stamp)
        return this.complete(dataVersion, false);
      return this.complete(dataVersion, this.rebuild(sourceState));
    }

    if (
      dataVersion !== undefined &&
      previousDataVersion !== undefined &&
      dataVersion === previousDataVersion
    ) {
      const revision = this.source.revision();
      if (revision === current.sourceRevision)
        return this.complete(dataVersion, false);
    }

    const observation = this.observeTracked(current);
    if (
      observation.resetRequired ||
      !observation.changeState.tracked ||
      observation.changes?.tracked === false
    )
      return this.complete(dataVersion, this.rebuild(sourceState));
    if (!observation.changes) {
      if (
        current.stamp !== sourceState.stamp ||
        current.sourceRevision !== observation.revision
      ) {
        const next = cloneState(current);
        next.identity = sourceState.identity;
        next.stamp = sourceState.stamp;
        next.sourceRevision = observation.revision;
        this.db.transaction(() => this.writeState(next))();
        this.state = next;
      }
      return this.complete(dataVersion, false);
    }

    const next = cloneState(current);
    let changed = false;
    this.db.transaction(() => {
      changed = this.applyChanges(next, observation.changes!.changes);
      next.identity = sourceState.identity;
      next.stamp = sourceState.stamp;
      next.sourceRevision = observation.revision;
      next.checkpoint = observation.changes!.lastSequence;
      next.tracked = true;
      this.writeState(next);
    })();
    this.state = next;
    return this.complete(dataVersion, changed);
  }

  /** 返回与现有 API 相同的全历史累计契约；金额只有存在已知行时才返回字符串。 */
  value(basis: UsdBasis, asOf: string): LifetimeTotals {
    const state = this.loadState();
    if (!state) throw new Error("Lifetime index has not been built");
    const totals = state.totals;
    const selected = basis === "api" ? totals.apiUsd : totals.subscriptionUsd;
    return {
      asOf,
      from: totals.from,
      to: totals.to,
      count: totals.count,
      tokens: {
        input: this.knownNumber(totals.input),
        cacheRead: this.knownNumber(totals.cacheRead),
        cacheWrite: this.knownNumber(totals.cacheWrite),
        output: this.knownNumber(totals.output),
        total: this.knownNumber(totals.tokenTotal),
        incomplete: totals.incompleteTokenRows,
      },
      usd: this.knownAmount(selected),
      apiUsd: this.knownAmount(totals.apiUsd),
      subscriptionUsd: this.knownAmount(totals.subscriptionUsd),
      credits: this.knownAmount(totals.credits),
      incomplete: {
        usd: totals.count - selected.known,
        apiUsd: totals.count - totals.apiUsd.known,
        subscriptionUsd: totals.count - totals.subscriptionUsd.known,
        credits: totals.count - totals.credits.known,
      },
      usdBasis: basis,
      priceVersion: this.options.priceBookKey,
    };
  }

  close() {
    this.db.close();
  }

  private complete(dataVersion: string | undefined, changed: boolean) {
    this.lastDataVersion = dataVersion;
    return changed;
  }

  private loadState(): MutableState | undefined {
    if (this.state) return this.state;
    const row = this.db
      .query<StateRow, [string]>(
        `SELECT source_identity, source_revision, checkpoint, tracked,
                count, from_at, to_at,
                source_stamp,
                input_total, input_known,
                cache_read_total, cache_read_known,
                cache_write_total, cache_write_known,
                output_total, output_known,
                token_total, token_total_known, incomplete_token_rows,
                api_usd_total, api_usd_known,
                subscription_usd_total, subscription_usd_known,
                credits_total, credits_known
           FROM lifetime_index_state
          WHERE price_book_key=?`,
      )
      .get(this.options.priceBookKey);
    if (!row) return undefined;
    this.state = stateFromRow(row);
    return this.state;
  }

  private observeTracked(state: MutableState): SourceObservation {
    return this.source.db.transaction(() => {
      const revision = this.source.revision();
      const changeState = this.source.reportUsageChangeState();
      if (!changeState.tracked) {
        return {
          revision,
          changeState,
          changes: null,
          resetRequired: true,
        };
      }
      if (changeState.lastSequence < state.checkpoint) {
        return {
          revision,
          changeState,
          changes: null,
          resetRequired: true,
        };
      }
      if (
        revision === state.sourceRevision &&
        changeState.lastSequence === state.checkpoint
      ) {
        return {
          revision,
          changeState,
          changes: null,
          resetRequired: false,
        };
      }
      const changes =
        this.source.reportUsageChangeStream?.(state.checkpoint) ??
        this.source.reportUsageChanges(state.checkpoint);
      return {
        revision,
        changeState,
        changes,
        resetRequired: changes.lastSequence < state.checkpoint,
      };
    })();
  }

  private rebuild(sourceState: LifetimeIndexEnsureOptions): boolean {
    const built = this.source.db.transaction(() => ({
      revision: this.source.revision(),
      metrics:
        this.source.reportUsageMetricStream?.() ??
        this.source.reportUsageMetrics(),
      changeState: this.source.reportUsageChangeState(),
    }))();
    const next: MutableState = {
      identity: sourceState.identity,
      stamp: sourceState.stamp,
      sourceRevision: built.revision,
      checkpoint: built.changeState.lastSequence,
      tracked: built.changeState.tracked,
      totals: emptyTotals(),
    };
    this.db.transaction(() => {
      this.db
        .query("DELETE FROM lifetime_index_rows WHERE price_book_key=?")
        .run(this.options.priceBookKey);
      for (const metric of built.metrics) {
        addMetric(next.totals, metric);
        this.insertMetric(metric);
      }
      this.writeState(next);
    })();
    this.state = next;
    return true;
  }

  private applyChanges(
    state: MutableState,
    changes: ReportUsageChangeStream["changes"],
  ) {
    const select = this.db.query<IndexMetricRow, [string, string, string]>(
      `SELECT source_id, external_id, occurred_at,
              input, cache_read, cache_write, output,
              api_usd, subscription_usd, credits
         FROM lifetime_index_rows
        WHERE price_book_key=? AND source_id=? AND external_id=?`,
    );
    const remove = this.db.query(
      `DELETE FROM lifetime_index_rows
        WHERE price_book_key=? AND source_id=? AND external_id=?`,
    );
    let observed = false;
    for (const change of changes) {
      observed = true;
      const previous = select.get(
        this.options.priceBookKey,
        change.sourceId,
        change.externalId,
      );
      // 来源回扫可能只补充明细；累计指标相同时保留行和总量，仅推进外层检查点。
      if (previous && change.metric) {
        const priorMetric = metricFromRow(previous);
        if (
          Object.entries(change.metric).every(
            ([key, value]) =>
              priorMetric[key as keyof ReportUsageMetric] === value,
          )
        )
          continue;
      }
      if (!previous && !change.metric) continue;
      if (previous) removeMetric(state.totals, metricFromRow(previous));
      remove.run(this.options.priceBookKey, change.sourceId, change.externalId);
      if (change.metric) {
        addMetric(state.totals, change.metric);
        this.insertMetric(change.metric);
      }
    }
    // 新增和内部修订不会收缩时间范围；仅删除或替换边界记录时需要重新定位。
    if (state.totals.boundsDirty) this.refreshBounds(state.totals);
    return observed;
  }

  private insertMetric(metric: ReportUsageMetric) {
    this.db
      .query(
        `INSERT INTO lifetime_index_rows (
           price_book_key, source_id, external_id, occurred_at,
           input, cache_read, cache_write, output,
           api_usd, subscription_usd, credits
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.options.priceBookKey,
        metric.sourceId,
        metric.externalId,
        metric.occurredAt,
        metric.input,
        metric.cacheRead,
        metric.cacheWrite,
        metric.output,
        metric.apiUsd,
        metric.subscriptionUsd,
        metric.credits,
      );
  }

  private refreshBounds(totals: MutableTotals) {
    const bounds = this.db
      .query<
        { from_at: string | null; to_at: string | null },
        [string, string]
      >(
        // MIN/MAX 同列合并查询会扫描整段索引；两个首尾定位分别只读一行。
        `SELECT
          (SELECT occurred_at FROM lifetime_index_rows WHERE price_book_key=?
           ORDER BY occurred_at ASC LIMIT 1) AS from_at,
          (SELECT occurred_at FROM lifetime_index_rows WHERE price_book_key=?
           ORDER BY occurred_at DESC LIMIT 1) AS to_at`,
      )
      .get(this.options.priceBookKey, this.options.priceBookKey);
    totals.from = bounds?.from_at ?? null;
    totals.to = bounds?.to_at ?? null;
    totals.boundsDirty = false;
  }

  private writeState(state: MutableState) {
    const totals = state.totals;
    this.db
      .query(
        `INSERT INTO lifetime_index_state (
           price_book_key, source_identity, source_stamp, source_revision, checkpoint, tracked,
           count, from_at, to_at,
           input_total, input_known,
           cache_read_total, cache_read_known,
           cache_write_total, cache_write_known,
           output_total, output_known,
           token_total, token_total_known, incomplete_token_rows,
           api_usd_total, api_usd_known,
           subscription_usd_total, subscription_usd_known,
           credits_total, credits_known
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(price_book_key) DO UPDATE SET
           source_identity=excluded.source_identity,
           source_stamp=excluded.source_stamp,
           source_revision=excluded.source_revision,
           checkpoint=excluded.checkpoint,
           tracked=excluded.tracked,
           count=excluded.count,
           from_at=excluded.from_at,
           to_at=excluded.to_at,
           input_total=excluded.input_total,
           input_known=excluded.input_known,
           cache_read_total=excluded.cache_read_total,
           cache_read_known=excluded.cache_read_known,
           cache_write_total=excluded.cache_write_total,
           cache_write_known=excluded.cache_write_known,
           output_total=excluded.output_total,
           output_known=excluded.output_known,
           token_total=excluded.token_total,
           token_total_known=excluded.token_total_known,
           incomplete_token_rows=excluded.incomplete_token_rows,
           api_usd_total=excluded.api_usd_total,
           api_usd_known=excluded.api_usd_known,
           subscription_usd_total=excluded.subscription_usd_total,
           subscription_usd_known=excluded.subscription_usd_known,
           credits_total=excluded.credits_total,
           credits_known=excluded.credits_known`,
      )
      .run(
        this.options.priceBookKey,
        state.identity,
        state.stamp,
        state.sourceRevision,
        state.checkpoint,
        state.tracked ? 1 : 0,
        totals.count,
        totals.from,
        totals.to,
        totals.input.value,
        totals.input.known,
        totals.cacheRead.value,
        totals.cacheRead.known,
        totals.cacheWrite.value,
        totals.cacheWrite.known,
        totals.output.value,
        totals.output.known,
        totals.tokenTotal.value,
        totals.tokenTotal.known,
        totals.incompleteTokenRows,
        totals.apiUsd.value.toString(),
        totals.apiUsd.known,
        totals.subscriptionUsd.value.toString(),
        totals.subscriptionUsd.known,
        totals.credits.value.toString(),
        totals.credits.known,
      );
  }

  private knownNumber(value: MutableNumber) {
    return value.known ? value.value : null;
  }

  private knownAmount(value: MutableAmount) {
    return value.known ? value.value.toString() : null;
  }
}
