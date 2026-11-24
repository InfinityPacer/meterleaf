import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { ref } from "../domain/account-merge";
import {
  QUOTA_SUMMARY_PATH,
  QUOTA_SUMMARY_SCHEMA_VERSION,
  type QuotaSummary,
} from "../shared/quota-summary";
import { canPreserveManagedProfileDir, isManagedProfileDir } from "./collect";
import type { CollectorConfig } from "./config";

export const QUOTA_SUMMARY_FILE = "quota-summary.json";

/**
 * 本机各入口当前登录的账户，id 与摘要里的 members 同一格式。会话据此把自己和派发入口
 * 对到服务端账户，不必理解采集器如何识别各家账户。
 */
export interface LocalLogins {
  claude: { configDir: string; account: string }[];
  agy: { appDataDir: string; profile: string | null; account: string }[];
  codex: { channel: string; account: string }[];
}

/** 写给本机会话读取的文件；fetchedAt 是摘要取回时间，读取方据此判断是否过旧。 */
export interface LocalQuotaSummary {
  schemaVersion: 1;
  fetchedAt: string;
  logins: LocalLogins;
  summary: QuotaSummary;
}

export function localLogins(
  sourceId: string,
  input: {
    claude: { configDir: string; accountUuid: string | null }[];
    agy: {
      appDataDir: string;
      profile: string | null;
      account: string | null;
    }[];
    codexChannels: { channel: string; id: string }[];
  },
): LocalLogins {
  const own = (externalId: string) => ref(sourceId, externalId);
  return {
    claude: input.claude.flatMap(({ configDir, accountUuid }) =>
      accountUuid ? [{ configDir, account: own(accountUuid) }] : [],
    ),
    agy: input.agy.flatMap(({ appDataDir, profile, account }) =>
      account ? [{ appDataDir, profile, account: own(account) }] : [],
    ),
    codex: input.codexChannels.map(({ channel, id }) => ({
      channel,
      account: own(id),
    })),
  };
}

/**
 * 取回服务端摘要。报表还在首次计算（202）、旧版服务端没有该接口（404）或网络失败时返回原因，
 * 调用方保留上一份文件，由读取方按取回时间判断新旧。
 */
export async function fetchQuotaSummary(
  config: Pick<CollectorConfig, "server" | "key">,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ summary: QuotaSummary } | { issue: string }> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${config.server}${QUOTA_SUMMARY_PATH}`,
      {
        headers: { authorization: `Bearer ${config.key}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      },
    );
  } catch (error) {
    return {
      issue: `额度摘要读取失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status !== 200)
    return { issue: `额度摘要暂不可用（HTTP ${response.status}）` };
  // 中间层可能返回 null 或非对象正文，按格式不受支持处理，不能让推送这一轮失败。
  const body: unknown = await response.json().catch(() => null);
  const value = (body ?? {}) as Partial<QuotaSummary>;
  if (
    typeof body !== "object" ||
    value.schemaVersion !== QUOTA_SUMMARY_SCHEMA_VERSION ||
    !Array.isArray(value.accounts)
  )
    return { issue: "额度摘要格式不受支持" };
  return { summary: value as QuotaSummary };
}

/** 先写同目录临时文件再改名，读取方不会读到半份；临时文件只有当前用户可读。 */
export function writeQuotaSummary(path: string, value: LocalQuotaSummary) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * 读取既有额度摘要文件中的 `logins.claude`。
 * 文件确认不存在（ENOENT）时返回 null（可按空旧映射继续写入）；
 * 文件存在但暂时不可读（如 EACCES/IO 错误）或格式损坏时抛出错误，避免调用方在需要保留映射时覆盖原文件。
 */
export function readExistingClaudeQuotaSummaryLogins(
  path: string,
): LocalLogins["claude"] | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("既有额度摘要格式无效");
  }
  const existing = parsed as Partial<LocalQuotaSummary>;
  if (
    existing.schemaVersion !== 1 ||
    !existing.logins ||
    typeof existing.logins !== "object" ||
    !Array.isArray(existing.logins.claude)
  ) {
    throw new Error("既有额度摘要缺少必要字段");
  }
  return existing.logins.claude.filter(
    (item): item is { configDir: string; account: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof item.configDir === "string" &&
      typeof item.account === "string",
  );
}

/**
 * 在独占 Claude 目录模式下合并最终写入摘要的 `logins.claude`：
 * - 枚举完整时直接采用本轮发现结果；
 * - 根目录本身不可枚举（如临时 EACCES）时，仅保留既有摘要中属于当前 `profilesDir` 范围的映射，
 *   立即剔除默认 `~/.claude` 或其他范围外/非法命名目录；
 * - 根目录可读但个别子目录读元数据出错时，已读出的受管目录采用本轮结果，仅对出错子目录保留既有映射，
 *   已删除目录与范围外目录一并剔除。
 */
export function resolveExclusiveClaudeLogins(
  profilesDir: string,
  computed: LocalLogins["claude"],
  existing: LocalLogins["claude"] | null,
  discovery: {
    profilesRootReadable: boolean;
    profilesDiscoveryComplete: boolean;
    uncertainProfileDirs: readonly string[];
  },
): LocalLogins["claude"] {
  if (discovery.profilesDiscoveryComplete) return computed;
  const validExisting = (existing ?? []).filter(
    (item): item is { configDir: string; account: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof item.configDir === "string" &&
      typeof item.account === "string",
  );
  if (!discovery.profilesRootReadable) {
    const preserved = new Map<string, { configDir: string; account: string }>();
    for (const item of validExisting) {
      if (!canPreserveManagedProfileDir(item.configDir, profilesDir)) continue;
      const key = resolve(item.configDir);
      if (!preserved.has(key)) preserved.set(key, item);
    }
    return [...preserved.values()];
  }
  const uncertain = new Set(
    discovery.uncertainProfileDirs.map((dir) => resolve(dir)),
  );
  const merged = new Map<string, { configDir: string; account: string }>();
  for (const item of computed) {
    merged.set(resolve(item.configDir), item);
  }
  for (const item of validExisting) {
    const key = resolve(item.configDir);
    if (
      !merged.has(key) &&
      uncertain.has(key) &&
      isManagedProfileDir(item.configDir, profilesDir)
    ) {
      merged.set(key, item);
    }
  }
  return [...merged.values()].sort((a, b) =>
    a.configDir.localeCompare(b.configDir),
  );
}

/**
 * 独占 Claude 账号目录模式下，当推送失败或服务端暂不可用时仅更新已有摘要文件中的 `logins.claude`，
 * 原样保留 `fetchedAt`、`summary` 以及 `logins.agy`、`logins.codex`。
 * 文件不存在时返回 false；读取、解析或写入失败时抛出错误由调用方记录日志。
 */
export function refreshClaudeQuotaSummaryLogins(
  path: string,
  claudeLogins:
    | LocalLogins["claude"]
    | ((existing: LocalLogins["claude"]) => LocalLogins["claude"]),
): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return false;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("既有额度摘要格式无效");
  }
  const existing = parsed as Partial<LocalQuotaSummary>;
  if (
    existing.schemaVersion !== 1 ||
    typeof existing.fetchedAt !== "string" ||
    !existing.summary ||
    typeof existing.summary !== "object" ||
    !existing.logins ||
    typeof existing.logins !== "object" ||
    !Array.isArray(existing.logins.claude) ||
    !Array.isArray(existing.logins.agy) ||
    !Array.isArray(existing.logins.codex)
  ) {
    throw new Error("既有额度摘要缺少必要字段");
  }
  const nextClaude =
    typeof claudeLogins === "function"
      ? claudeLogins(existing.logins.claude)
      : claudeLogins;
  if (JSON.stringify(existing.logins.claude) === JSON.stringify(nextClaude))
    return false;
  writeQuotaSummary(path, {
    schemaVersion: 1,
    fetchedAt: existing.fetchedAt,
    logins: {
      ...existing.logins,
      claude: nextClaude,
    },
    summary: existing.summary,
  });
  return true;
}
