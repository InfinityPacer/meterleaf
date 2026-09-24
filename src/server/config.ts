import { z } from "zod";
import { sourceIdSchema } from "../shared/ingest";

/** 每个写入密钥只绑定一个推送来源；环境变量只保存密钥摘要，不保存明文。 */
export interface IngestKey {
  sourceId: string;
  sha256: string;
}

function parseIngestKeys(value: string | undefined): IngestKey[] {
  if (!value?.trim()) return [];
  const keys = value.split(",").map((entry) => {
    const [sourceId, sha256, extra] = entry.trim().split(":");
    if (
      extra !== undefined ||
      !sourceIdSchema.safeParse(sourceId).success ||
      !/^[0-9a-f]{64}$/.test(sha256 ?? "")
    )
      throw new Error(
        "Invalid METERLEAF_INGEST_KEYS entry; expected sourceId:sha256hex",
      );
    return { sourceId: sourceId!, sha256: sha256! };
  });
  if (new Set(keys.map((key) => key.sourceId)).size !== keys.length)
    throw new Error("METERLEAF_INGEST_KEYS contains a duplicate source");
  return keys;
}

const envSchema = z.object({
  METERLEAF_DEMO: z.enum(["true", "false"]).default("false"),
  METERLEAF_HOST: z.string().default("127.0.0.1"),
  METERLEAF_PORT: z.coerce.number().int().min(1).max(65535).default(4318),
  METERLEAF_LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "silent"])
    .default("info"),
  METERLEAF_DATA_DIR: z.string().min(1).default("app_data"),
  METERLEAF_SYNC_VISIBLE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(3_600_000)
    .default(15_000),
  METERLEAF_SYNC_HIDDEN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(3_600_000)
    .default(60_000),
  METERLEAF_REPORT_REFRESH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(86_400_000)
    .default(300_000),
  METERLEAF_SOURCE_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("sub2api"),
  METERLEAF_PRICE_BOOK: z.string().optional(),
  METERLEAF_USD_BASIS: z.enum(["subscription", "api"]).default("subscription"),
  SUB2API_DATABASE_URL: z.string().url().optional(),
  METERLEAF_INGEST_KEYS: z.string().optional(),
});
/** 只有显式 demo=true 才能使用演示数据；缺配置不能静默切换运行模式。 */
export function readConfig(env: Record<string, string | undefined>) {
  const result = envSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration keys: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const config = result.data;
  if (config.METERLEAF_DEMO === "false" && !config.SUB2API_DATABASE_URL)
    throw new Error("SUB2API_DATABASE_URL is required in live mode");
  const ingestKeys = parseIngestKeys(config.METERLEAF_INGEST_KEYS);
  // 推送来源与拉取来源共用账本主键空间，同名会让两边互相覆盖。
  if (ingestKeys.some((key) => key.sourceId === config.METERLEAF_SOURCE_ID))
    throw new Error(
      "METERLEAF_INGEST_KEYS source must differ from METERLEAF_SOURCE_ID",
    );
  return { ...config, ingestKeys };
}
