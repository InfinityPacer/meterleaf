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
export const INGEST_MAX_MANAGED_SCOPES = 10;
export const INGEST_MAX_SCOPE_ACCOUNTS = 200;
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
    /** 账户并入另一个账户时指向它，历史用量与额度随之归到那个账户；旧采集器不发送。 */
    parentExternalId: externalIdSchema.nullable().optional(),
  })
  .strict();

const creditsBalanceSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,18})?$/)
  .max(64)
  .nullable();

export const ingestQuotaCreditsSchema = z
  .object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: creditsBalanceSchema,
  })
  .strict();

export const ingestQuotaSchema = z
  .object({
    accountExternalId: externalIdSchema,
    window: z.enum([
      "five-hour",
      "seven-day",
      "seven-day-fable",
      "five-hour-3p",
      "seven-day-3p",
      // 账单周期（例如 Command Code）；服务端需先升级认识这个值，采集器才能发送。
      "monthly",
      // 账户额外 Credits 余额快照（例如 Codex）；服务端需先升级认识这个值，采集器才能发送。
      "credits",
    ]),
    percent: z.number().finite().min(0).max(1000).nullable(),
    /** 上游采样时间，不是采集器读取或上传时间。 */
    sampledAt: timestampSchema.nullable(),
    resetsAt: timestampSchema.nullable(),
    windowMinutes: z.number().int().positive().nullable(),
    credits: ingestQuotaCreditsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.window === "credits") {
      if (!value.credits) {
        ctx.addIssue({
          code: "custom",
          path: ["credits"],
          message: "credits snapshot requires credits payload",
        });
      }
      if (
        value.percent !== null ||
        value.resetsAt !== null ||
        value.windowMinutes !== null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["window"],
          message:
            "credits snapshot must not set window percent or reset fields",
        });
      }
      return;
    }
    if (value.credits !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["credits"],
        message: "credits payload is only allowed on credits window",
      });
    }
  });

export const ingestManagedScopeSchema = z
  .object({
    /** 受管账号池作用域（例如 Antigravity 账号池或 Claude 多账户目录）。 */
    scope: z.enum(["agy-pool", "claude-profiles"]),
    /** 本轮确认在池且活跃的账户 externalId 完整列表。 */
    activeAccountExternalIds: z
      .array(externalIdSchema)
      .max(INGEST_MAX_SCOPE_ACCOUNTS),
    /** 可选：池清单中明确处于暂停、未就绪或已移出状态的账户 externalId 列表。 */
    inactiveAccountExternalIds: z
      .array(externalIdSchema)
      .max(INGEST_MAX_SCOPE_ACCOUNTS)
      .optional(),
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
    managedScopes: z
      .array(ingestManagedScopeSchema)
      .max(INGEST_MAX_MANAGED_SCOPES)
      .refine(
        (scopes) =>
          new Set(scopes.map((item) => item.scope)).size === scopes.length,
        "Duplicate managed scope in batch",
      )
      .optional(),
  })
  .strict();

export type IngestUsage = z.infer<typeof ingestUsageSchema>;
export type IngestAccount = z.infer<typeof ingestAccountSchema>;
export type IngestQuota = z.infer<typeof ingestQuotaSchema>;
export type IngestManagedScope = z.infer<typeof ingestManagedScopeSchema>;
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

/** 成功响应表示整批已在同一事务中持久化，采集器此后才能把条目标记为已送达。 */
export interface IngestResult {
  batchId: string;
  accepted: { usage: number; accounts: number; quotas: number };
}

/** 写入密钥格式；服务端只保存其 SHA-256 十六进制摘要。 */
export const INGEST_KEY_PREFIX = "mlk_";
