import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ref } from "../domain/account-merge";
import {
  QUOTA_SUMMARY_PATH,
  QUOTA_SUMMARY_SCHEMA_VERSION,
  type QuotaSummary,
} from "../shared/quota-summary";
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
  const body = (await response
    .json()
    .catch(() => ({}))) as Partial<QuotaSummary>;
  if (
    body.schemaVersion !== QUOTA_SUMMARY_SCHEMA_VERSION ||
    !Array.isArray(body.accounts)
  )
    return { issue: "额度摘要格式不受支持" };
  return { summary: body as QuotaSummary };
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
