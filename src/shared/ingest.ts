import { z } from "zod";

/**
 * 本机采集器向 Meterleaf 推送计量事实的协议。采集器只提取计量，不计价；
 * 服务端以 Bearer 写入密钥绑定唯一 sourceId，批次内条目不携带来源，避免跨来源写入。
 * 所有写入按 (sourceId, externalId) 幂等，重发同一批次不会产生新记录。
 */
export const INGEST_BATCHES_PATH = "/api/ingest/v1/batches";
export const INGEST_SCHEMA_VERSION = 1;
export const INGEST_MAX_USAGE = 2000;
export const INGEST_MAX_ACCOUNTS = 100;
export const INGEST_MAX_QUOTAS = 200;
/** 单批 JSON 上限；采集器按条数分批，正常批次远小于此值。 */
export const INGEST_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export const sourceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const externalIdSchema = z.string().min(1).max(256);
const timestampSchema = z.iso.datetime({ offset: true });
const tokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

/** 与 TokenUsage 相同：四桶互斥，reasoning 与 TTL 写入是子集，未知保留 null。 */
const tokensSchema = z
  .object({
    input: tokenCountSchema,
    output: tokenCountSchema,
    cacheRead: tokenCountSchema,
    cacheWrite: tokenCountSchema,
    cacheWrite5m: tokenCountSchema,
    cacheWrite1h: tokenCountSchema,
    reasoning: tokenCountSchema,
  })
  .strict();

/** 元数据只承载计量相关的短值，不能夹带对话内容、路径或凭据。 */
const metadataSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 32, "Too many metadata keys");

export const ingestUsageSchema = z
  .object({
    externalId: externalIdSchema,
    occurredAt: timestampSchema,
    accountExternalId: externalIdSchema,
    model: z.string().min(1).max(128),
    tier: z.string().min(1).max(32).nullable(),
    tokens: tokensSchema,
    metadata: metadataSchema,
  })
  .strict();

export const ingestAccountSchema = z
  .object({
    externalId: externalIdSchema,
    name: z.string().min(1).max(200),
    platform: z.string().min(1).max(64),
    kind: z.enum(["subscription", "api", "unknown"]),
    plan: z.string().min(1).max(64).nullable(),
    subjectKey: z.string().min(1).max(128).nullable(),
  })
  .strict();

export const ingestQuotaSchema = z
  .object({
    accountExternalId: externalIdSchema,
    window: z.enum(["five-hour", "seven-day", "seven-day-fable"]),
    percent: z.number().finite().min(0).max(1000).nullable(),
    /** 上游采样时间，不是采集器读取或上传时间。 */
    sampledAt: timestampSchema.nullable(),
    resetsAt: timestampSchema.nullable(),
    windowMinutes: z.number().int().positive().nullable(),
  })
  .strict();

export const ingestBatchSchema = z
  .object({
    schemaVersion: z.literal(INGEST_SCHEMA_VERSION),
    sourceId: sourceIdSchema,
    batchId: z.uuid(),
    collector: z
      .object({
        name: z.string().min(1).max(64),
        version: z.string().min(1).max(32),
      })
      .strict(),
    accounts: z.array(ingestAccountSchema).max(INGEST_MAX_ACCOUNTS),
    usage: z.array(ingestUsageSchema).max(INGEST_MAX_USAGE),
    quotas: z.array(ingestQuotaSchema).max(INGEST_MAX_QUOTAS),
  })
  .strict();

export type IngestUsage = z.infer<typeof ingestUsageSchema>;
export type IngestAccount = z.infer<typeof ingestAccountSchema>;
export type IngestQuota = z.infer<typeof ingestQuotaSchema>;
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

/** 成功响应表示整批已在同一事务中持久化，采集器此后才能把条目标记为已送达。 */
export interface IngestResult {
  batchId: string;
  accepted: { usage: number; accounts: number; quotas: number };
}

/** 写入密钥格式；服务端只保存其 SHA-256 十六进制摘要。 */
export const INGEST_KEY_PREFIX = "mlk_";
