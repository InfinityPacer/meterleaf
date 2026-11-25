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
  METERLEAF_MODEL_ALIASES: optionalText,
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
  METERLEAF_OPENCODE_GO_KEY: optionalText,
  METERLEAF_OPENCODE_GO_ACCOUNT: optionalText,
  METERLEAF_COMMAND_CODE_KEY: optionalText,
  METERLEAF_COMMAND_CODE_ACCOUNT: optionalText,
});
/**
 * 填写 Go 的 Key 即在页面打开时读取 Go 额度。额度挂到推送来源中的账户上，格式为
 * sourceId:账户标识；只有一个推送来源时可省略，默认取该来源的 opencode-go 账户。
 */
function parseOpenCodeGo(
  config: z.infer<typeof envSchema>,
  ingestKeys: readonly IngestKey[],
) {
  const key = config.METERLEAF_OPENCODE_GO_KEY;
  if (!key) return undefined;
  const ref = config.METERLEAF_OPENCODE_GO_ACCOUNT;
  if (!ref) {
    if (ingestKeys.length !== 1)
      throw new Error(
        "METERLEAF_OPENCODE_GO_ACCOUNT is required unless exactly one ingest source is configured",
      );
    return {
      key,
      account: {
        sourceId: ingestKeys[0]!.sourceId,
        accountExternalId: "opencode-go",
      },
    };
  }
  const [sourceId, accountExternalId, extra] = ref.split(":");
  if (
    extra !== undefined ||
    !sourceIdSchema.safeParse(sourceId).success ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(accountExternalId ?? "")
  )
    throw new Error(
      "Invalid METERLEAF_OPENCODE_GO_ACCOUNT; expected sourceId:accountId",
    );
  return {
    key,
    account: { sourceId: sourceId!, accountExternalId: accountExternalId! },
  };
}

/** 只有纯服务端模式（没有推送来源）才使用的保留来源，Command Code 额度挂在这个来源的账户上。 */
export const COMMAND_CODE_SERVER_SOURCE_ID = "commandcode";

/**
 * 填写 Command Code 的 Key 即在页面打开时读取它的额度。额度挂到 sourceId:账户标识 上：
 * 只有一个推送来源时默认取该来源的 commandcode 账户；没有推送来源（纯服务端）时默认用保留来源
 * commandcode；多个推送来源时必须显式填写，避免挂错来源。
 */
function parseCommandCode(
  config: z.infer<typeof envSchema>,
  ingestKeys: readonly IngestKey[],
) {
  const key = config.METERLEAF_COMMAND_CODE_KEY;
  if (!key) return undefined;
  const ref = config.METERLEAF_COMMAND_CODE_ACCOUNT;
  if (!ref) {
    if (ingestKeys.length > 1)
      throw new Error(
        "METERLEAF_COMMAND_CODE_ACCOUNT is required when more than one ingest source is configured",
      );
    return {
      key,
      account: {
        sourceId:
          ingestKeys.length === 1
            ? ingestKeys[0]!.sourceId
            : COMMAND_CODE_SERVER_SOURCE_ID,
        accountExternalId: "commandcode",
      },
    };
  }
  const [sourceId, accountExternalId, extra] = ref.split(":");
  if (
    extra !== undefined ||
    !sourceIdSchema.safeParse(sourceId).success ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(accountExternalId ?? "")
  )
    throw new Error(
      "Invalid METERLEAF_COMMAND_CODE_ACCOUNT; expected sourceId:accountId",
    );
  return {
    key,
    account: { sourceId: sourceId!, accountExternalId: accountExternalId! },
  };
}

/** 只有显式 demo=true 才能使用演示数据；缺配置不能静默切换运行模式。 */
export function readConfig(env: Record<string, string | undefined>) {
  const result = envSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration keys: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const config = result.data;
  const ingestKeys = parseIngestKeys(config.METERLEAF_INGEST_KEYS);
  const commandCode = parseCommandCode(config, ingestKeys);
  // Sub2API、本机采集器与服务端 Command Code 额度都是可选来源，但真实模式至少要有一个，
  // 否则账本永远为空。
  if (
    config.METERLEAF_DEMO === "false" &&
    !config.SUB2API_DATABASE_URL &&
    ingestKeys.length === 0 &&
    !commandCode
  )
    throw new Error(
      "Live mode needs SUB2API_DATABASE_URL, METERLEAF_INGEST_KEYS or METERLEAF_COMMAND_CODE_KEY",
    );
  // 推送来源与拉取来源共用账本主键空间，同名会让两边互相覆盖。
  if (ingestKeys.some((key) => key.sourceId === config.METERLEAF_SOURCE_ID))
    throw new Error(
      "METERLEAF_INGEST_KEYS source must differ from METERLEAF_SOURCE_ID",
    );
  const openCodeGo = parseOpenCodeGo(config, ingestKeys);
  if (commandCode) {
    // Sub2API 拉取来源按完整快照删除不在其中的账户，Command Code 账户不能落在它的来源里；
    // 未配置 Sub2API 时同名来源也保留给它，避免日后接入时冲突。
    if (commandCode.account.sourceId === config.METERLEAF_SOURCE_ID)
      throw new Error(
        "METERLEAF_COMMAND_CODE_ACCOUNT source must differ from METERLEAF_SOURCE_ID",
      );
    // 两个服务端额度写入方共用一个账户会互相覆盖窗口与套餐。
    if (
      openCodeGo &&
      openCodeGo.account.sourceId === commandCode.account.sourceId &&
      openCodeGo.account.accountExternalId ===
        commandCode.account.accountExternalId
    )
      throw new Error(
        "METERLEAF_COMMAND_CODE_ACCOUNT must differ from METERLEAF_OPENCODE_GO_ACCOUNT",
      );
  }
  return {
    ...config,
    ingestKeys,
    githubAuth: parseGithubAuth(config),
    openCodeGo,
    commandCode,
  };
}
