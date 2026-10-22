import { z } from "zod";
import type { QuotaFact } from "../domain/connector";
import type { DiagnosticsLogger } from "./diagnostics";

/** OpenCode Go 的用量接口；与 OpenCode 自带的用量页面读取同一份数据。 */
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const windowSchema = z.object({
  percent: z.number().finite(),
  resetsAt: z.iso.datetime({ offset: true }),
});
const usageSchema = z.object({
  usage: z.object({
    rolling: windowSchema,
    weekly: windowSchema,
    monthly: windowSchema,
  }),
});

/** 额度挂在哪个账户上：通常是本机采集器按模型映射建立的 Go 账户。 */
export interface GoAccountRef {
  sourceId: string;
  accountExternalId: string;
}

/** 月额度按订阅日起算，周期长度取重置时刻往前一个自然月（UTC）。 */
function monthMinutes(resetsAt: string): number {
  const end = new Date(resetsAt);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

/**
 * 把一次用量读数换成额度快照。Go 的三个窗口是 5 小时、每周和每月，上限都按美元计；
 * 接口不给采样时刻，读取时刻就是采样时刻。
 */
export function goQuotaFacts(
  body: unknown,
  account: GoAccountRef,
  sampledAt: string,
): QuotaFact[] {
  const { usage } = usageSchema.parse(body);
  const windows = [
    ["five-hour", usage.rolling, 300],
    ["seven-day", usage.weekly, 7 * 24 * 60],
    ["monthly", usage.monthly, monthMinutes(usage.monthly.resetsAt)],
  ] as const;
  return windows.map(([window, value, minutes]) => ({
    sourceId: account.sourceId,
    externalId: `${account.accountExternalId}:${window}`,
    accountExternalId: account.accountExternalId,
    window,
    percent: value.percent,
    sampledAt,
    resetsAt: new Date(value.resetsAt).toISOString(),
    windowMinutes: minutes,
  }));
}

export interface GoQuotaOptions {
  key: string;
  account: GoAccountRef;
  save(quotas: QuotaFact[], collectedAt: string): void;
  diagnostics: DiagnosticsLogger;
  fetch?: typeof fetch;
  now?: () => number;
  /** 两次读取的最小间隔；页面每 15 秒报一次在线，只有间隔已到才再读。 */
  intervalMs?: number;
}

/**
 * 只在有页面打开时读取 Go 额度：页面上报在线时，距上次读取超过间隔就读一次，
 * 没有页面时不访问接口。同一时刻只有一个请求，失败也计入间隔，避免反复请求被拒的密钥。
 */
export class GoQuotaRefresher {
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private running: Promise<void> | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private readonly options: GoQuotaOptions) {
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
    try {
      const response = await this.fetch(OPENCODE_GO_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${this.options.key}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        diagnostics.warn("opencode_go.quota_failed", {
          status: response.status,
        });
        return;
      }
      const sampledAt = new Date(this.now()).toISOString();
      const facts = goQuotaFacts(
        await response.json(),
        this.options.account,
        sampledAt,
      );
      this.options.save(facts, sampledAt);
    } catch (error) {
      diagnostics.warn("opencode_go.quota_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
