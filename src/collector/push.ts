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
import {
  OTEL_API_REQUEST_BODY,
  OTEL_API_REQUEST_EVENT,
  OTEL_LOGS_PATH,
  type OtelRequestAccount,
} from "../shared/otel";
import { effectiveChannelAccounts } from "./channel-accounts";
import type { CollectorConfig } from "./config";
import type { CollectorState, OutboxItem, QuotaIdentity } from "./state";
import packageJson from "../../package.json";

export const COLLECTOR_NAME = "meterleaf-collector";
export const COLLECTOR_VERSION = packageJson.version;
/** 单次 OTLP 请求最多携带的记录数，与服务端的记录上限无关。 */
export const OTEL_MAX_PUSH_RECORDS = 1000;

export interface PushLimits {
  usage: number;
  accounts: number;
  quotas: number;
  otel: number;
}

export interface PushResult {
  batches: number;
  usage: number;
  accounts: number;
  quotas: number;
  /** 本轮随 OTLP 日志推送的请求归属记录数。 */
  otel: number;
  /**
   * 因账户已缺失、改为其他平台或改绑其他主体而丢弃的 Command Code 旧额度数；
   * 这些额度来自另一个账户身份，不能随改写后的账户资料发出。
   */
  droppedQuotas: number;
  /** 失败原因；网络错误与 5xx 可重试，4xx 需要人工处理配置或服务端。 */
  error: { kind: "network" | "server" | "rejected"; message: string } | null;
}

export interface PushOptions {
  fetch?: typeof fetch;
  limits?: Partial<PushLimits>;
  timeoutMs?: number;
  /** 非敏感告警输出，只含固定事件名与账户 id；默认写标准错误。 */
  warn?: (message: string) => void;
}

/** 待发送队列里的额度条目；Command Code 额度带有只在本机使用的采样身份。 */
type QueuedQuota = IngestQuota & { _identity?: QuotaIdentity };

/** 剥离本机字段，得到严格符合 ingest 协议的额度。 */
function wireQuota(quota: QueuedQuota): IngestQuota {
  const { _identity: _ignored, ...rest } = quota;
  return rest;
}

const maxBatchesPerRun = 1000;

/**
 * 当前配置里各账户 id 的平台：通道规则与模型规则都算。配置已把账户改成其他平台时，
 * 即使本机账户资料还没被新用量刷新，旧的 Command Code 额度也不能再发出。
 */
function configuredPlatforms(config: CollectorConfig) {
  const platforms = new Map<string, Set<string>>();
  const add = (id: string, platform: string) => {
    const set = platforms.get(id) ?? new Set<string>();
    set.add(platform);
    platforms.set(id, set);
  };
  for (const rule of effectiveChannelAccounts(config))
    add(rule.id, rule.platform);
  for (const rule of config.modelAccounts ?? []) add(rule.id, rule.platform);
  return platforms;
}

/**
 * 把 outbox 中的请求归属记录还原成服务端认识的 OTLP JSON。字段与原导出器一致，
 * 事件时间写回 event.timestamp，因此 parseOtelRequestAccounts 能还原出相同记录。
 */
export function serializeOtelRequests(
  records: readonly OtelRequestAccount[],
): unknown {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: records.map((record) => {
              const attributes: [string, string | null][] = [
                ["event.name", OTEL_API_REQUEST_EVENT],
                ["request_id", record.requestId],
                ["user.account_uuid", record.accountUuid],
                ["organization.id", record.organizationUuid],
                ["session.id", record.sessionId],
                ["model", record.model],
                ["event.timestamp", record.occurredAt],
                [
                  "duration_ms",
                  record.durationMs != null ? String(record.durationMs) : null,
                ],
                [
                  "ttft_ms",
                  record.firstTokenMs != null
                    ? String(record.firstTokenMs)
                    : null,
                ],
              ];
              return {
                body: { stringValue: OTEL_API_REQUEST_BODY },
                attributes: attributes
                  .filter(([, value]) => value !== null)
                  .map(([key, value]) => ({
                    key,
                    value: { stringValue: value as string },
                  })),
              };
            }),
          },
        ],
      },
    ],
  };
}

/**
 * 按 seq 顺序分批推送待发送条目。OTEL 请求归属先于用量发送，服务端写用量时就能
 * 按请求 ID 归属；每批附带被引用账户的最新资料，服务端不依赖先前批次。
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
    otel: Math.min(
      options.limits?.otel ?? OTEL_MAX_PUSH_RECORDS,
      OTEL_MAX_PUSH_RECORDS,
    ),
  };
  const result: PushResult = {
    batches: 0,
    usage: 0,
    accounts: 0,
    quotas: 0,
    otel: 0,
    droppedQuotas: 0,
    error: null,
  };
  const warn = options.warn ?? ((message: string) => console.error(message));
  const ingestUrl = `${config.server}${INGEST_BATCHES_PATH}`;
  const otelUrl = `${config.server}${OTEL_LOGS_PATH}`;

  /** 发送一个请求体；网络错误归类为可重试的 network。 */
  const post = async (
    url: string,
    body: string,
  ): Promise<
    { response: Response } | { failure: NonNullable<PushResult["error"]> }
  > => {
    try {
      return {
        response: await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.key}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        }),
      };
    } catch (error) {
      return {
        failure: {
          kind: "network",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };

  const rejected = async (response: Response) => {
    const body = (await response.text().catch(() => "")).slice(0, 500);
    return {
      kind:
        response.status >= 500 ? ("server" as const) : ("rejected" as const),
      message: `HTTP ${response.status}${body ? `: ${body}` : ""}`,
    };
  };

  // 请求归属先推：服务端写入后面的用量时已经知道请求属于哪个账户。
  for (let round = 0; round < maxBatchesPerRun; round += 1) {
    const otel = state.pending<OtelRequestAccount>("otel", limits.otel);
    if (otel.length === 0) break;
    const sent = await post(
      otelUrl,
      JSON.stringify(serializeOtelRequests(otel.map((item) => item.payload))),
    );
    if ("failure" in sent) {
      result.error = sent.failure;
      return result;
    }
    if (!sent.response.ok) {
      result.error = await rejected(sent.response);
      // 服务端拒收请求归属（例如尚未开放 OTEL 入口）时，用量仍照常推送，
      // 只是退回按登录时间线归属；归属记录留在队列里，服务端修好后补发。
      if (result.error.kind === "rejected") break;
      return result;
    }
    state.acknowledge(otel.map((item) => item.seq));
    result.batches += 1;
    result.otel += otel.length;
  }

  for (let round = 0; round < maxBatchesPerRun; round += 1) {
    const usage = state.pending<IngestUsage>("usage", limits.usage);
    const queuedQuotas = state.pending<QueuedQuota>("quota", limits.quotas);
    const accountItems = state.pending<IngestAccount>(
      "account",
      limits.accounts,
    );
    if (usage.length + queuedQuotas.length + accountItems.length === 0) break;

    const accounts = new Map<string, IngestAccount>();
    for (const item of accountItems) {
      accounts.set(item.payload.externalId, item.payload);
    }
    // 带采样身份的额度必须与平台、主体摘要都相符的账户条目同批送达；账户已改写的旧额度丢弃，
    // 账户名额已满的顺延到下一批。其余条目照常发送，普通用量不会被这些额度卡住。
    const quotas: OutboxItem<QueuedQuota>[] = [];
    const dropped: number[] = [];
    const configured = configuredPlatforms(config);
    for (const item of queuedQuotas) {
      const identity = item.payload._identity;
      if (!identity) {
        quotas.push(item);
        continue;
      }
      const id = item.payload.accountExternalId;
      const account = accounts.get(id) ?? state.account(id);
      const rulePlatforms = configured.get(id);
      if (
        !account ||
        (rulePlatforms !== undefined &&
          [...rulePlatforms].some(
            (platform) => platform !== identity.platform,
          )) ||
        account.platform !== identity.platform ||
        account.subjectKey !== identity.subjectKey
      ) {
        dropped.push(item.seq);
        continue;
      }
      if (!accounts.has(id)) {
        if (accounts.size >= limits.accounts) continue;
        accounts.set(id, account);
      }
      quotas.push(item);
    }
    if (dropped.length) {
      state.acknowledge(dropped);
      result.droppedQuotas += dropped.length;
      // 告警只是诊断输出；后台日志追加失败不能中断本批普通用量的推送。
      try {
        warn(
          `${new Date().toISOString()} command_code.quota_dropped: 丢弃 ${dropped.length} 条账户已改写的 Command Code 额度`,
        );
      } catch {
        // 见上。
      }
    }
    if (usage.length + quotas.length + accountItems.length === 0) {
      // 本批只剩被丢弃的旧额度时继续取下一批；只剩顺延额度时说明名额无法腾出，留待下次。
      if (dropped.length) continue;
      break;
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
      quotas: quotas.map((item) => wireQuota(item.payload)),
    };

    const sent = await post(ingestUrl, JSON.stringify(batch));
    if ("failure" in sent) {
      result.error = sent.failure;
      return result;
    }
    if (!sent.response.ok) {
      result.error = await rejected(sent.response);
      return result;
    }
    const acknowledged: OutboxItem<unknown>[] = [
      ...usage,
      ...quotas,
      ...accountItems,
    ];
    state.acknowledge(acknowledged.map((item) => item.seq));
    result.batches += 1;
    result.usage += usage.length;
    result.quotas += quotas.length;
    result.accounts += accountItems.length;
  }
  return result;
}
