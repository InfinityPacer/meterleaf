import type { QuotaFact } from "../domain/connector";
import {
  fetchCommandCodeQuota,
  type CommandCodeQuotaResult,
  type CommandCodeWindow,
} from "../shared/commandcode";
import type { DiagnosticsLogger } from "./diagnostics";

/** 额度挂在哪个账户上：推送来源中的账户，或纯服务端模式的保留来源账户。 */
export interface CommandCodeAccountRef {
  sourceId: string;
  accountExternalId: string;
}

/** 一次服务端额度观测；账本在同一事务里校验平台与主体、建户或更新套餐，再写入额度。 */
export interface CommandCodeQuotaUpdate {
  sourceId: string;
  accountExternalId: string;
  identityDigest: string;
  observedPlan: string | null;
  quotas: QuotaFact[];
}

export type CommandCodeSaveResult =
  "saved" | "unchanged" | "platform_conflict" | "identity_mismatch";

/** 把一次读数换成额度快照；接口不给采样时刻，读取时刻就是采样时刻。 */
export function commandCodeQuotaFacts(
  windows: readonly CommandCodeWindow[],
  account: CommandCodeAccountRef,
  sampledAt: string,
): QuotaFact[] {
  return windows.map((window) => ({
    sourceId: account.sourceId,
    externalId: `${account.accountExternalId}:${window.window}`,
    accountExternalId: account.accountExternalId,
    window: window.window,
    percent: window.percent,
    sampledAt,
    resetsAt: window.resetsAt,
    windowMinutes: window.windowMinutes,
  }));
}

/** 读数未变时最多隔这么久写一次，让页面上的采样时间不至于显得过时。 */
const UNCHANGED_SAVE_MS = 4 * 60_000;

export interface CommandCodeQuotaOptions {
  key: string;
  account: CommandCodeAccountRef;
  save(
    update: CommandCodeQuotaUpdate,
    collectedAt: string,
  ): CommandCodeSaveResult;
  diagnostics: DiagnosticsLogger;
  fetch?: typeof fetch;
  now?: () => number;
  /** 两次读取的最小间隔；页面每 15 秒报一次在线，只有间隔已到才再读。 */
  intervalMs?: number;
}

/**
 * 只在有页面打开时读取 Command Code 额度：页面上报在线且距上次读取超过间隔才读一次，
 * 同一时刻只有一个请求，失败也计入间隔，避免反复请求被拒的 Key。
 * 账户由服务端独占写入额度：同一账户的采集器额度在入账时被跳过。
 */
export class CommandCodeQuotaRefresher {
  private lastAttempt = Number.NEGATIVE_INFINITY;
  /** 上次写入的读数与时刻；读数未变时少写快照，减少写盘与报表重算。 */
  private lastSaved: { readings: string; at: number } | null = null;
  private running: Promise<void> | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private readonly options: CommandCodeQuotaOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 120_000;
  }

  updatePresence(_id: string, visible: boolean) {
    if (!visible) return;
    if (this.running) return;
    if (this.now() - this.lastAttempt < this.intervalMs) return;
    this.lastAttempt = this.now();
    this.running = this.refresh().finally(() => {
      this.running = null;
    });
  }

  /** 供测试等待当前读取结束。 */
  settled() {
    return this.running ?? Promise.resolve();
  }

  private async refresh() {
    const { diagnostics } = this.options;
    let result: CommandCodeQuotaResult;
    try {
      result = await fetchCommandCodeQuota({
        apiKey: this.options.key,
        fetch: this.fetch,
      });
    } catch {
      result = { status: "error", kind: "network" };
    }
    // 结果只含固定字面量与状态码，可直接记录；登录名、组织与上游原文不会出现在这里。
    if (result.status === "rejected") {
      diagnostics.warn("command_code.quota_rejected", {
        status: result.httpStatus,
      });
      return;
    }
    if (result.status === "error") {
      diagnostics.warn("command_code.quota_failed", {
        kind: result.kind,
        ...(result.httpStatus !== undefined
          ? { status: result.httpStatus }
          : {}),
      });
      return;
    }
    const sampledAt = new Date(this.now()).toISOString();
    const quotas = commandCodeQuotaFacts(
      result.windows,
      this.options.account,
      sampledAt,
    );
    const readings = JSON.stringify([
      result.subjectKey,
      result.planId,
      quotas.map((fact) => [
        fact.window,
        fact.percent,
        fact.resetsAt,
        fact.windowMinutes,
      ]),
    ]);
    const now = this.now();
    if (
      this.lastSaved?.readings === readings &&
      now - this.lastSaved.at < UNCHANGED_SAVE_MS
    )
      return;
    try {
      const saved = this.options.save(
        {
          sourceId: this.options.account.sourceId,
          accountExternalId: this.options.account.accountExternalId,
          identityDigest: result.subjectKey,
          observedPlan: result.planId,
          quotas,
        },
        sampledAt,
      );
      // 被拒绝的观测不计入防抖，冲突解除后下一次读取立即写入。
      if (saved === "saved" || saved === "unchanged")
        this.lastSaved = { readings, at: now };
    } catch (error) {
      diagnostics.warn("command_code.quota_save_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
