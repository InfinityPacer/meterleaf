import {
  INGEST_BATCHES_PATH,
  INGEST_MAX_ACCOUNTS,
  INGEST_MAX_QUOTAS,
  INGEST_MAX_USAGE,
  INGEST_SCHEMA_VERSION,
  type IngestAccount,
  type IngestBatch,
  type IngestQuota,
  type IngestUsage,
} from "../shared/ingest";
import type { CollectorConfig } from "./config";
import type { CollectorState, OutboxItem } from "./state";
import packageJson from "../../package.json";

export const COLLECTOR_NAME = "meterleaf-collector";
export const COLLECTOR_VERSION = packageJson.version;

export interface PushLimits {
  usage: number;
  accounts: number;
  quotas: number;
}

export interface PushResult {
  batches: number;
  usage: number;
  accounts: number;
  quotas: number;
  /** 失败原因；网络错误与 5xx 可重试，4xx 需要人工处理配置或服务端。 */
  error: { kind: "network" | "server" | "rejected"; message: string } | null;
}

export interface PushOptions {
  fetch?: typeof fetch;
  limits?: Partial<PushLimits>;
  timeoutMs?: number;
}

const maxBatchesPerRun = 1000;

/**
 * 按 seq 顺序分批推送待发送条目。每批附带被引用账户的最新资料，服务端不依赖先前批次；
 * 仅在 2xx 后确认本批实际发送的 seq。遇到失败立即停止，剩余条目留待下次。
 */
export async function pushOutbox(
  state: CollectorState,
  config: CollectorConfig,
  options: PushOptions = {},
): Promise<PushResult> {
  const doFetch = options.fetch ?? fetch;
  const limits: PushLimits = {
    usage: Math.min(
      options.limits?.usage ?? INGEST_MAX_USAGE,
      INGEST_MAX_USAGE,
    ),
    accounts: Math.min(
      options.limits?.accounts ?? INGEST_MAX_ACCOUNTS,
      INGEST_MAX_ACCOUNTS,
    ),
    quotas: Math.min(
      options.limits?.quotas ?? INGEST_MAX_QUOTAS,
      INGEST_MAX_QUOTAS,
    ),
  };
  const result: PushResult = {
    batches: 0,
    usage: 0,
    accounts: 0,
    quotas: 0,
    error: null,
  };
  const url = `${config.server}${INGEST_BATCHES_PATH}`;

  for (let round = 0; round < maxBatchesPerRun; round += 1) {
    const usage = state.pending<IngestUsage>("usage", limits.usage);
    const quotas = state.pending<IngestQuota>("quota", limits.quotas);
    const accountItems = state.pending<IngestAccount>(
      "account",
      limits.accounts,
    );
    if (usage.length + quotas.length + accountItems.length === 0) break;

    const accounts = new Map<string, IngestAccount>();
    for (const item of accountItems) {
      accounts.set(item.payload.externalId, item.payload);
    }
    const referenced = new Set([
      ...usage.map((item) => item.payload.accountExternalId),
      ...quotas.map((item) => item.payload.accountExternalId),
    ]);
    for (const id of referenced) {
      if (accounts.size >= limits.accounts) break;
      if (accounts.has(id)) continue;
      const account = state.account(id);
      if (account) accounts.set(id, account);
    }

    const batch: IngestBatch = {
      schemaVersion: INGEST_SCHEMA_VERSION,
      sourceId: config.sourceId,
      batchId: crypto.randomUUID(),
      collector: { name: COLLECTOR_NAME, version: COLLECTOR_VERSION },
      accounts: [...accounts.values()],
      usage: usage.map((item) => item.payload),
      quotas: quotas.map((item) => item.payload),
    };

    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      result.error = {
        kind: "network",
        message: error instanceof Error ? error.message : String(error),
      };
      return result;
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 500);
      result.error = {
        kind: response.status >= 500 ? "server" : "rejected",
        message: `HTTP ${response.status}${body ? `: ${body}` : ""}`,
      };
      return result;
    }
    const sent: OutboxItem<unknown>[] = [...usage, ...quotas, ...accountItems];
    state.acknowledge(sent.map((item) => item.seq));
    result.batches += 1;
    result.usage += usage.length;
    result.quotas += quotas.length;
    result.accounts += accountItems.length;
  }
  return result;
}
