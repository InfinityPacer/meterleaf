import type { UsageConnector } from "../domain/connector";
import {
  silentLogger,
  summarizeError,
  type ErrorKind,
  type DiagnosticsLogger,
} from "./diagnostics";
import type { LedgerStore } from "../storage/ledger";
import { SyncPresence } from "./sync-presence";

export type SyncPhase =
  "idle" | "accounts" | "quotas" | "incremental" | "sweep";

export type SyncErrorStage = SyncPhase | "task";

export interface SyncLastError {
  id: string;
  stage: SyncErrorStage;
  kind: ErrorKind;
  code?: string;
}

export interface SyncStatus {
  autoEnabled: boolean;
  running: boolean;
  phase: SyncPhase;
  localRecords: number;
  batchRecords: number;
  batchPages: number;
  hasSynced: boolean;
  lastAttempt: string | null;
  lastSuccess: string | null;
  error: string | null;
  quotaError: string | null;
  lastError: SyncLastError | null;
  initialComplete: boolean;
  initialCompleteAt: string | null;
  lastSweep: string | null;
}

export interface SyncRunnerOptions {
  /** 有可见页面时的批次间隔；积压补采使用独立的短间隔。 */
  intervalMs?: number;
  /** 所有页面不可见或失联后的批次间隔。 */
  hiddenIntervalMs?: number;
  backlogIntervalMs?: number;
  quotaIntervalMs?: number;
  sweepMs?: number;
  pageSize?: number;
  pagesPerPoll?: number;
}

type SyncWorkPhase = Exclude<SyncPhase, "idle">;

type SyncTrigger = "manual" | "automatic";

interface SyncTaskContext {
  trigger: SyncTrigger;
  taskId: string;
}

interface ResolvedSyncRunnerOptions {
  intervalMs: number;
  hiddenIntervalMs: number;
  backlogIntervalMs: number;
  quotaIntervalMs: number;
  sweepMs: number;
  pageSize: number;
  pagesPerPoll: number;
}

interface StageProgress {
  count: number;
  pages: number;
  records: number;
}

interface PageStageResult extends StageProgress {
  durationMs: number;
}

class SyncPhaseError extends Error {
  constructor(
    readonly phase: SyncWorkPhase,
    readonly progress: StageProgress,
    readonly startedAt: number,
    readonly originalError: unknown,
  ) {
    super("Sync phase failed", { cause: originalError });
    this.name = "SyncPhaseError";
  }
}

const defaultOptions: ResolvedSyncRunnerOptions = {
  intervalMs: 15_000,
  hiddenIntervalMs: 60_000,
  backlogIntervalMs: 1_000,
  quotaIntervalMs: 30_000,
  sweepMs: 6 * 3_600_000,
  pageSize: 1000,
  pagesPerPoll: 10,
};

/** 非重叠有界采集；自动采集默认关闭，手动任务只在追赶期间短间隔推进。 */
export class SyncRunner {
  private running: Promise<void> | null = null;
  private manualTask: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private closed = false;
  private closeTask: Promise<void> | null = null;
  private runtimePhase: SyncPhase = "idle";
  private runtimeBatchRecords = 0;
  private runtimeBatchPages = 0;
  private localRecordCount: number | null = null;
  private activeTask: SyncTaskContext | null = null;
  private sequence = 0;
  private readonly presence = new SyncPresence();
  private scheduledFrom = 0;
  private readonly options: ResolvedSyncRunnerOptions;

  constructor(
    private connector: UsageConnector,
    private store: LedgerStore,
    options: SyncRunnerOptions | undefined = {},
    private logger: DiagnosticsLogger = silentLogger,
  ) {
    this.options = { ...defaultOptions, ...(options ?? {}) };
  }

  status(): SyncStatus {
    const stored = this.storedStatus();
    const active = this.running !== null || this.manualTask !== null;
    return {
      ...stored,
      autoEnabled: this.autoEnabled(),
      running: active,
      phase: active ? this.runtimePhase : "idle",
      localRecords: this.localRecords(),
      batchRecords: active ? this.runtimeBatchRecords : stored.batchRecords,
      batchPages: active ? this.runtimeBatchPages : stored.batchPages,
    };
  }

  /** 心跳不会开启采集或创建新任务；只调整已有自动任务的等待时间。 */
  updatePresence(id: string, visible: boolean) {
    this.presence.update(id, visible);
    if (this.timer !== null) this.scheduleAutomatic(true);
  }

  /** 执行一个有界批次；保留直接 poll 调用，不受自动开关影响。 */
  poll(now = new Date().toISOString()): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    const context = this.activeTask ?? this.newTask("manual");
    if (!this.activeTask) this.logTaskRequested(context);
    return this.runBatch(now, context);
  }

  /** 非阻塞触发一次完整在线任务；运行中只复用当前任务，不重置任何游标。 */
  requestSync(): SyncStatus {
    if (this.closed || this.manualTask !== null) return this.status();
    this.clearTimer();
    const context = this.newTask("manual");
    this.logTaskRequested(context);
    const task = this.runManualTask(context).catch((error: unknown) => {
      this.recordTaskFailure(error, context);
    });
    this.manualTask = task;
    void task.finally(() => {
      if (this.manualTask === task) {
        this.manualTask = null;
        if (this.running === null) this.setRuntimeIdle();
      }
      this.scheduleAutomatic();
    });
    return this.status();
  }

  /** 保存自动采集选择；关闭只阻止后续自动批次，不取消正在执行的任务。 */
  setAutoSync(enabled: boolean): SyncStatus {
    if (this.closed) return this.status();
    this.store.setState(this.autoKey(), enabled);
    this.persistStatus({ ...this.storedStatus(), autoEnabled: enabled });
    if (!enabled) {
      this.clearTimer();
    } else if (this.started && this.manualTask === null) {
      this.clearTimer();
      this.triggerAutomatic();
    }
    return this.status();
  }

  /** 只恢复已持久化开启的自动采集；默认 idle 且不触碰来源。 */
  start() {
    if (this.closed) return;
    this.started = true;
    this.clearTimer();
    if (this.autoEnabled() && this.manualTask === null) this.triggerAutomatic();
    else if (this.running === null) this.setRuntimeIdle();
  }

  async stop() {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.started = false;
    this.clearTimer();
    this.closeTask = (async () => {
      await this.running;
      await this.manualTask;
      await this.connector.close();
    })();
    return this.closeTask;
  }

  /** 完整回扫覆盖结束快照，且该采样区间没有冷启动/断线缺口，才允许额度推算。 */
  covered(from: string, to: string) {
    const status = this.status();
    const gaps =
      this.store.getState<{ from: string; to: string }[]>(
        `${this.connector.sourceId}:coverageGaps`,
      ) ?? [];
    return (
      !status.error &&
      status.initialCompleteAt !== null &&
      status.initialCompleteAt <= from &&
      status.lastSweep !== null &&
      status.lastSweep >= to &&
      !gaps.some((gap) => gap.from < to && gap.to > from)
    );
  }

  private runBatch(now: string, context: SyncTaskContext): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;

    this.activeTask = context;
    let task!: Promise<void>;
    task = this.collect(now).finally(() => {
      if (this.running === task) this.running = null;
      if (this.manualTask === null) {
        this.activeTask = null;
        this.setRuntimeIdle();
      }
    });
    this.running = task;
    return task;
  }

  private async collect(now: string) {
    const sourceId = this.connector.sourceId;
    const prior = this.storedStatus();
    const startedAt = performance.now();
    const recovered = prior.error !== null;
    let currentPhase: SyncWorkPhase = "accounts";
    let totalPages = 0;
    let totalRecords = 0;
    let accountFailure: SyncPhaseError | null = null;
    let quotaFailure: SyncPhaseError | null = null;

    this.runtimePhase = "accounts";
    this.runtimeBatchRecords = 0;
    this.runtimeBatchPages = 0;
    const status: SyncStatus = {
      ...prior,
      autoEnabled: this.autoEnabled(),
      running: false,
      phase: "idle",
      batchRecords: 0,
      batchPages: 0,
      lastAttempt: now,
    };
    this.persistStatus(status);

    this.logger.info("sync.start", {
      sourceId,
      trigger: this.activeTask?.trigger ?? "manual",
      taskId: this.activeTask?.taskId ?? "unknown",
      initialComplete: prior.initialComplete,
      recovered,
    });
    if (
      prior.lastSuccess &&
      Date.parse(now) - Date.parse(prior.lastSuccess) >
        Math.max(this.options.intervalMs, this.options.hiddenIntervalMs) * 2
    ) {
      this.recordGap(prior.lastSuccess, now);
    }

    try {
      currentPhase = "accounts";
      const accountsStartedAt = performance.now();
      let accountsCount = 0;
      const accountsDue = this.metadataDue("accounts", now, prior.lastSuccess);
      if (accountsDue) {
        try {
          const accounts = await this.connector.readAccounts();
          accountsCount = accounts.length;
          this.store.saveAccountsSnapshot(sourceId, accounts);
          this.store.setState(this.metadataSuccessKey("accounts"), now);
          this.logStage("accounts", {
            count: accountsCount,
            pages: 0,
            records: 0,
            durationMs: this.elapsed(accountsStartedAt),
            initialComplete: status.initialComplete,
          });
        } catch (error) {
          accountFailure = new SyncPhaseError(
            "accounts",
            { count: accountsCount, pages: 0, records: 0 },
            accountsStartedAt,
            error,
          );
        }
      } else {
        this.logStage("accounts", {
          count: 0,
          pages: 0,
          records: 0,
          durationMs: this.elapsed(accountsStartedAt),
          initialComplete: status.initialComplete,
          skipped: true,
        });
      }

      currentPhase = "quotas";
      this.runtimePhase = "quotas";
      const quotasStartedAt = performance.now();
      let quotasCount = 0;
      let quotasSkipped = false;
      const quotasDue = this.metadataDue("quotas", now, prior.lastSuccess);
      if (this.connector.readQuotas === undefined) {
        quotasSkipped = true;
      } else if (quotasDue) {
        this.store.setState(this.metadataAttemptKey("quotas"), now);
        try {
          const quotas = await this.connector.readQuotas();
          quotasCount = quotas.length;
          this.store.saveQuotas(quotas, now);
          this.store.setState(this.metadataSuccessKey("quotas"), now);
          status.quotaError = null;
        } catch (error) {
          quotaFailure = new SyncPhaseError(
            "quotas",
            { count: quotasCount, pages: 0, records: 0 },
            quotasStartedAt,
            error,
          );
          status.quotaError = "source-quota-failed";
        }
      } else {
        quotasSkipped = true;
      }
      this.logStage("quotas", {
        count: quotasCount,
        pages: 0,
        records: 0,
        durationMs: this.elapsed(quotasStartedAt),
        initialComplete: status.initialComplete,
        ...(quotasSkipped ? { skipped: true } : {}),
      });
      if (quotaFailure) this.logFailure(quotaFailure, status);

      if (accountFailure) throw accountFailure;

      currentPhase = "incremental";
      this.runtimePhase = "incremental";
      const incremental = await this.runPages("incremental", now);
      if (
        !status.initialComplete &&
        this.store.getState<boolean>(`${sourceId}:incremental:caughtUp`) ===
          true
      ) {
        status.initialComplete = true;
        if (!status.initialCompleteAt) status.initialCompleteAt = now;
      }
      totalPages += incremental.pages;
      totalRecords += incremental.records;
      this.logStage("incremental", {
        ...incremental,
        count: incremental.records,
        initialComplete: status.initialComplete,
      });

      const sweeping =
        this.store.getState<boolean>(`${sourceId}:sweeping`) === true;
      if (
        status.initialComplete &&
        (sweeping ||
          !status.lastSweep ||
          Date.parse(now) - Date.parse(status.lastSweep) >=
            this.options.sweepMs)
      ) {
        currentPhase = "sweep";
        this.runtimePhase = "sweep";
        const sweepStartedAt = performance.now();
        let sweep: PageStageResult;
        try {
          if (!sweeping) {
            this.store.setState(`${sourceId}:sweep:cursor`, null);
            this.store.setState(`${sourceId}:sweeping`, true);
          }
          sweep = await this.runPages("sweep", now);
          if (this.store.getState<boolean>(`${sourceId}:sweep:caughtUp`)) {
            this.store.setState(`${sourceId}:sweeping`, false);
            status.lastSweep = now;
          }
        } catch (error) {
          if (error instanceof SyncPhaseError) throw error;
          throw new SyncPhaseError(
            "sweep",
            { count: 0, pages: 0, records: 0 },
            sweepStartedAt,
            error,
          );
        }
        totalPages += sweep.pages;
        totalRecords += sweep.records;
        this.logStage("sweep", {
          ...sweep,
          count: sweep.records,
          initialComplete: status.initialComplete,
        });
      }

      status.lastSuccess = now;
      status.hasSynced = true;
      status.error = null;
      if (status.quotaError === null) status.lastError = null;
      status.batchRecords = totalRecords;
      status.batchPages = totalPages;
      this.persistStatus(status);
      const completion = {
        sourceId,
        durationMs: this.elapsed(startedAt),
        pages: totalPages,
        records: totalRecords,
        initialComplete: status.initialComplete,
        quotaError: status.quotaError,
        recovered,
      };
      this.logger.info("sync.complete", completion);
      if (recovered) this.logger.info("sync.recover", completion);
    } catch (error) {
      // 驱动异常可能带连接串或 SQL；公开状态只记录类别，保留成功游标供重试。
      const failure =
        error instanceof SyncPhaseError
          ? error
          : new SyncPhaseError(
              currentPhase,
              {
                count: totalRecords,
                pages: totalPages,
                records: totalRecords,
              },
              startedAt,
              error,
            );
      status.error = "source-sync-failed";
      status.batchRecords = totalRecords;
      status.batchPages = totalPages;
      this.recordGap(status.lastSuccess ?? now, now);
      this.persistStatus(status);
      this.logFailure(failure, status);
    }
  }

  private async runManualTask(context: SyncTaskContext): Promise<void> {
    while (!this.closed) {
      await this.runBatch(new Date().toISOString(), context);
      const status = this.status();
      const incrementalCaughtUp =
        this.store.getState<boolean>(
          `${this.connector.sourceId}:incremental:caughtUp`,
        ) === true;
      const sweeping =
        this.store.getState<boolean>(`${this.connector.sourceId}:sweeping`) ===
        true;
      if (
        this.closed ||
        status.error !== null ||
        (status.initialComplete && incrementalCaughtUp && !sweeping)
      ) {
        return;
      }
      await this.wait(this.options.backlogIntervalMs);
    }
  }

  private triggerAutomatic() {
    if (
      this.closed ||
      !this.started ||
      !this.autoEnabled() ||
      this.manualTask !== null
    ) {
      return;
    }
    const context = this.newTask("automatic");
    this.logTaskRequested(context);
    const task = this.runBatch(new Date().toISOString(), context);
    void task
      .then(() => this.scheduleAutomatic())
      .catch((error: unknown) => {
        this.recordTaskFailure(error, context);
        this.scheduleAutomatic();
      });
  }

  private scheduleAutomatic(reschedule = false) {
    if (
      this.closed ||
      !this.started ||
      !this.autoEnabled() ||
      this.manualTask !== null
    ) {
      return;
    }
    this.clearTimer();
    if (!reschedule) this.scheduledFrom = Date.now();
    const status = this.status();
    const incrementalCaughtUp =
      this.store.getState<boolean>(
        `${this.connector.sourceId}:incremental:caughtUp`,
      ) === true;
    const fast =
      status.error === null &&
      (!status.initialComplete ||
        !incrementalCaughtUp ||
        this.store.getState<boolean>(`${this.connector.sourceId}:sweeping`) ===
          true);
    const interval = () =>
      fast
        ? this.options.backlogIntervalMs
        : this.presence.hasVisible()
          ? this.options.intervalMs
          : this.options.hiddenIntervalMs;
    const delay = Math.max(0, this.scheduledFrom + interval() - Date.now());
    this.timer = setTimeout(() => {
      // 租约可能在等待期间过期；按原批次完成时间重新计算，避免多跑前台频率。
      if (Date.now() < this.scheduledFrom + interval()) {
        this.scheduleAutomatic(true);
        return;
      }
      this.timer = null;
      this.triggerAutomatic();
    }, delay);
  }

  private metadataDue(
    kind: "accounts" | "quotas",
    now: string,
    fallback: string | null,
  ): boolean {
    const last =
      this.store.getState<string>(this.metadataAttemptKey(kind)) ??
      this.store.getState<string>(this.metadataSuccessKey(kind)) ??
      fallback;
    if (!last) return true;
    const elapsed = Date.parse(now) - Date.parse(last);
    return !Number.isFinite(elapsed) || elapsed >= this.options.quotaIntervalMs;
  }

  private autoEnabled(): boolean {
    const value = this.store.getState<boolean>(this.autoKey());
    if (typeof value === "boolean") return value;
    const legacy = this.store.getState<Partial<SyncStatus>>(this.statusKey());
    return legacy?.autoEnabled === true;
  }

  private storedStatus(): SyncStatus {
    const raw = this.store.getState<Partial<SyncStatus>>(this.statusKey());
    const lastSuccess = this.textOrNull(raw?.lastSuccess);
    return {
      autoEnabled: this.autoEnabled(),
      running: false,
      phase: "idle",
      localRecords: 0,
      batchRecords: this.nonNegativeNumber(raw?.batchRecords),
      batchPages: this.nonNegativeNumber(raw?.batchPages),
      hasSynced:
        typeof raw?.hasSynced === "boolean"
          ? raw.hasSynced
          : lastSuccess !== null,
      lastAttempt: this.textOrNull(raw?.lastAttempt),
      lastSuccess,
      error: this.textOrNull(raw?.error),
      quotaError: this.textOrNull(raw?.quotaError),
      lastError: this.parseLastError(raw?.lastError),
      initialComplete: raw?.initialComplete === true,
      initialCompleteAt: this.textOrNull(raw?.initialCompleteAt),
      lastSweep: this.textOrNull(raw?.lastSweep),
    };
  }

  private persistStatus(status: SyncStatus) {
    this.store.setState(this.statusKey(), {
      ...status,
      autoEnabled: this.autoEnabled(),
      running: false,
      phase: "idle",
      localRecords: this.localRecordCount ?? status.localRecords,
    });
  }

  private localRecords(): number {
    if (this.localRecordCount === null) {
      this.localRecordCount = this.store.countUsage(this.connector.sourceId);
    }
    return this.localRecordCount;
  }

  private setRuntimeIdle() {
    this.runtimePhase = "idle";
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private recordGap(from: string, to: string) {
    const key = `${this.connector.sourceId}:coverageGaps`;
    const gaps = this.store.getState<{ from: string; to: string }[]>(key) ?? [];
    if (gaps.at(-1)?.from === from) gaps[gaps.length - 1]!.to = to;
    else gaps.push({ from, to });
    this.store.setState(key, gaps);
  }

  private async runPages(
    mode: "incremental" | "sweep",
    now: string,
  ): Promise<PageStageResult> {
    const sourceId = this.connector.sourceId;
    const startedAt = performance.now();
    let pages = 0;
    let records = 0;
    for (
      let pageIndex = 0;
      pageIndex < this.options.pagesPerPoll;
      pageIndex++
    ) {
      try {
        const cursor = this.store.getState<string>(
          `${sourceId}:${mode}:cursor`,
        );
        const page = await this.connector.readUsage(
          cursor,
          this.options.pageSize,
        );
        records += page.records.length;
        if (page.hasMore && page.nextCursor === cursor)
          throw new Error("Source cursor did not advance");
        this.store.savePage(sourceId, mode, page, now);
        pages += 1;
        this.runtimeBatchRecords += page.records.length;
        this.runtimeBatchPages += 1;
        this.localRecordCount = null;
        if (!page.hasMore) break;
      } catch (error) {
        if (error instanceof SyncPhaseError) throw error;
        throw new SyncPhaseError(
          mode,
          { count: records, pages, records },
          startedAt,
          error,
        );
      }
    }
    return {
      count: records,
      pages,
      records,
      durationMs: this.elapsed(startedAt),
    };
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, Math.round(performance.now() - startedAt));
  }

  private logStage(
    stage: SyncWorkPhase,
    fields: StageProgress & {
      durationMs: number;
      initialComplete: boolean;
      skipped?: boolean;
    },
  ) {
    this.logger.info("sync.stage", {
      sourceId: this.connector.sourceId,
      stage,
      count: fields.count,
      pages: fields.pages,
      records: fields.records,
      durationMs: fields.durationMs,
      initialComplete: fields.initialComplete,
      ...(fields.skipped ? { skipped: true } : {}),
    });
  }

  private logFailure(failure: SyncPhaseError, status: SyncStatus) {
    const summary = summarizeError(failure);
    const errorId = this.nextId("error");
    const lastError: SyncLastError = {
      id: errorId,
      stage: failure.phase,
      kind: summary.kind,
      ...(summary.code ? { code: summary.code } : {}),
    };
    status.lastError = lastError;
    this.persistStatus(status);
    this.logger.error("sync.fail", {
      sourceId: this.connector.sourceId,
      errorId,
      trigger: this.activeTask?.trigger ?? "manual",
      taskId: this.activeTask?.taskId ?? "unknown",
      stage: failure.phase,
      count: failure.progress.count,
      pages: failure.progress.pages,
      records: failure.progress.records,
      durationMs: this.elapsed(failure.startedAt),
      initialComplete: status.initialComplete,
      error: summary,
    });
  }

  private recordTaskFailure(error: unknown, context: SyncTaskContext) {
    const summary = summarizeError(error);
    const status = this.storedStatus();
    const errorId = this.nextId("error");
    status.error = "source-sync-failed";
    status.lastError = {
      id: errorId,
      stage: "task",
      kind: summary.kind,
      ...(summary.code ? { code: summary.code } : {}),
    };
    this.persistStatus(status);
    this.logger.error("sync.task_fail", {
      sourceId: this.connector.sourceId,
      errorId,
      trigger: context.trigger,
      taskId: context.taskId,
      error: summary,
    });
  }

  private logTaskRequested(context: SyncTaskContext) {
    this.logger.info("sync.requested", {
      sourceId: this.connector.sourceId,
      trigger: context.trigger,
      taskId: context.taskId,
    });
  }

  private newTask(trigger: SyncTrigger): SyncTaskContext {
    return { trigger, taskId: this.nextId(trigger) };
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.sequence}`;
  }

  private parseLastError(value: unknown): SyncLastError | null {
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.stage !== "string" ||
      typeof candidate.kind !== "string"
    ) {
      return null;
    }
    const stage: SyncErrorStage[] = [
      "accounts",
      "quotas",
      "incremental",
      "sweep",
      "task",
    ];
    if (!stage.includes(candidate.stage as SyncErrorStage)) return null;
    const kinds: ErrorKind[] = [
      "sql",
      "storage",
      "network",
      "timeout",
      "configuration",
      "unknown",
    ];
    if (!kinds.includes(candidate.kind as ErrorKind)) return null;
    return {
      id: candidate.id,
      stage: candidate.stage as SyncErrorStage,
      kind: candidate.kind as ErrorKind,
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    };
  }

  private statusKey(): string {
    return `${this.connector.sourceId}:status`;
  }

  private autoKey(): string {
    return `${this.connector.sourceId}:autoEnabled`;
  }

  private metadataAttemptKey(kind: "accounts" | "quotas"): string {
    return `${this.connector.sourceId}:${kind}:lastAttempt`;
  }

  private metadataSuccessKey(kind: "accounts" | "quotas"): string {
    return `${this.connector.sourceId}:${kind}:lastSuccess`;
  }

  private textOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private nonNegativeNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  }
}
