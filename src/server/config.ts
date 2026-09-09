import { z } from "zod";

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
  return config;
}
