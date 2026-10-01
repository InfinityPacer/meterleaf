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

// Compose 对未填写的变量传入空字符串，按未配置处理。
const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

/** 填写 Client ID 即启用 GitHub 登录，此时其余登录配置缺一不可，避免半配置下意外开放。 */
function parseGithubAuth(config: z.infer<typeof envSchema>) {
  const fields = [
    config.METERLEAF_GITHUB_CLIENT_ID,
    config.METERLEAF_GITHUB_CLIENT_SECRET,
    config.METERLEAF_GITHUB_USERS,
    config.METERLEAF_PUBLIC_URL,
  ];
  if (fields.every((value) => value === undefined)) return undefined;
  if (fields.some((value) => value === undefined))
    throw new Error(
      "GitHub login needs METERLEAF_GITHUB_CLIENT_ID, METERLEAF_GITHUB_CLIENT_SECRET, METERLEAF_GITHUB_USERS and METERLEAF_PUBLIC_URL",
    );
  const users = config
    .METERLEAF_GITHUB_USERS!.split(",")
    .map((user) => user.trim())
    .filter(Boolean);
  if (
    users.length === 0 ||
    users.some((user) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user))
  )
    throw new Error("Invalid METERLEAF_GITHUB_USERS; expected GitHub logins");
  return {
    clientId: config.METERLEAF_GITHUB_CLIENT_ID!,
    clientSecret: config.METERLEAF_GITHUB_CLIENT_SECRET!,
    users,
    publicUrl: config.METERLEAF_PUBLIC_URL!,
    sessionDays: config.METERLEAF_SESSION_DAYS,
  };
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
    .default(900_000),
  METERLEAF_REPORT_REFRESH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(86_400_000)
    .default(86_400_000),
  METERLEAF_SOURCE_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("sub2api"),
  METERLEAF_PRICE_BOOK: z.string().optional(),
  METERLEAF_USD_BASIS: z.enum(["subscription", "api"]).default("subscription"),
  // Compose 对未填写的变量传入空字符串，按未配置处理。
  SUB2API_DATABASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  METERLEAF_INGEST_KEYS: z.string().optional(),
  METERLEAF_GITHUB_CLIENT_ID: optionalText,
  METERLEAF_GITHUB_CLIENT_SECRET: optionalText,
  METERLEAF_GITHUB_USERS: optionalText,
  METERLEAF_PUBLIC_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  METERLEAF_SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});
/** 只有显式 demo=true 才能使用演示数据；缺配置不能静默切换运行模式。 */
export function readConfig(env: Record<string, string | undefined>) {
  const result = envSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration keys: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const config = result.data;
  const ingestKeys = parseIngestKeys(config.METERLEAF_INGEST_KEYS);
  // Sub2API 与本机采集器都是可选来源，但真实模式至少要有一个，否则账本永远为空。
  if (
    config.METERLEAF_DEMO === "false" &&
    !config.SUB2API_DATABASE_URL &&
    ingestKeys.length === 0
  )
    throw new Error(
      "Live mode needs SUB2API_DATABASE_URL or METERLEAF_INGEST_KEYS",
    );
  // 推送来源与拉取来源共用账本主键空间，同名会让两边互相覆盖。
  if (ingestKeys.some((key) => key.sourceId === config.METERLEAF_SOURCE_ID))
    throw new Error(
      "METERLEAF_INGEST_KEYS source must differ from METERLEAF_SOURCE_ID",
    );
  return { ...config, ingestKeys, githubAuth: parseGithubAuth(config) };
}
