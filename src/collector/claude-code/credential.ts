import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * Claude Code 登录凭据里的套餐字段。新版 Claude Code 不再把套餐写入 ~/.claude.json，
 * 只有凭据还保存订阅类型和速率档位。凭据只代表当前登录账户，不带账户 UUID，
 * 调用方必须确认读取前后登录账户未变，才能把套餐归给该账户。
 */
export interface ClaudeCredentialPlan {
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export interface CredentialLocation {
  /** 已解析的 Claude Code 配置目录。 */
  claudeRoot: string;
  /**
   * CLAUDE_CONFIG_DIR 的原值；未设置为 null。设置后 Claude Code 的钥匙串条目名带该值的
   * 摘要后缀，摘要按原值计算，不是解析后的路径。
   */
  configDir: string | null;
}

/** 读出凭据原文；读不到返回 null。测试可替换，生产实现见 readCredentialText。 */
export type CredentialTextReader = (
  location: CredentialLocation,
) => string | null;

/**
 * 凭据的修改标记，凭据每次被改写都会变化；读不到返回 null。只取条目属性或文件状态，
 * 不读取令牌。测试可替换，生产实现见 readCredentialVersion。
 */
export type CredentialVersionReader = (
  location: CredentialLocation,
) => string | null;

const keychainTimeoutMs = 5_000;

/** 与 Claude Code 保持一致的钥匙串条目名和账户名。 */
export function keychainService(location: CredentialLocation): string {
  const suffix = location.configDir
    ? `-${createHash("sha256")
        .update(location.configDir.normalize("NFC"))
        .digest("hex")
        .slice(0, 8)}`
    : "";
  return `Claude Code-credentials${suffix}`;
}

function keychainAccount(): string {
  let name: string;
  try {
    name = process.env.USER || userInfo().username;
  } catch {
    name = "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/**
 * macOS 上通过系统自带的 security 读取钥匙串条目，其他平台或钥匙串没有条目时读取
 * 配置目录下的 .credentials.json。只运行系统命令、只读本机，不调用 Claude Code，
 * 也不发出网络请求；被拒绝或超时时返回 null，本轮不更新套餐。
 */
export const readCredentialText: CredentialTextReader = (location) => {
  if (process.platform === "darwin") {
    const result = spawnSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        keychainService(location),
        "-a",
        keychainAccount(),
        "-w",
      ],
      { encoding: "utf8", timeout: keychainTimeoutMs, maxBuffer: 1024 * 1024 },
    );
    if (result.status === 0 && result.stdout) return result.stdout;
  }
  try {
    return readFileSync(join(location.claudeRoot, ".credentials.json"), {
      encoding: "utf8",
      flag: "r",
    });
  } catch {
    return null;
  }
};

/**
 * 钥匙串条目取修改时间属性；不带 -w 时 security 只输出属性，不输出密码，也不需要授权。
 * 与 readCredentialText 取同一来源：钥匙串没有条目时取 .credentials.json 的文件状态。
 */
export const readCredentialVersion: CredentialVersionReader = (location) => {
  if (process.platform === "darwin") {
    const result = spawnSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        keychainService(location),
        "-a",
        keychainAccount(),
      ],
      { encoding: "utf8", timeout: keychainTimeoutMs, maxBuffer: 1024 * 1024 },
    );
    if (result.status === 0) {
      const modified = /"mdat"<timedate>=0x[0-9A-F]+\s+"(\d{14}Z)/.exec(
        result.stdout ?? "",
      )?.[1];
      return modified ? `keychain:${modified}` : null;
    }
  }
  try {
    const stat = statSync(join(location.claudeRoot, ".credentials.json"));
    return `file:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
};

/** 从修改标记取出凭据最近一次改写的时刻（ISO UTC）；没有或无法解析时返回 null。 */
export function credentialModifiedAt(version: string | null): string | null {
  const keychain =
    /^keychain:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(
      version ?? "",
    );
  const at = keychain
    ? Date.UTC(
        Number(keychain[1]),
        Number(keychain[2]) - 1,
        Number(keychain[3]),
        Number(keychain[4]),
        Number(keychain[5]),
        Number(keychain[6]),
      )
    : Number(/^file:([\d.]+):/.exec(version ?? "")?.[1] ?? NaN);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    ? value
    : null;
}

/**
 * 只取 claudeAiOauth 的 subscriptionType 和 rateLimitTier。令牌等其余字段不解析、
 * 不保存、不记录，原文在本函数返回后即可回收。
 */
export function credentialPlanFrom(
  raw: string | null,
): ClaudeCredentialPlan | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).claudeAiOauth
      : null;
  if (oauth === null || typeof oauth !== "object") return null;
  const record = oauth as Record<string, unknown>;
  const plan = {
    subscriptionType: text(record.subscriptionType),
    rateLimitTier: text(record.rateLimitTier),
  };
  return plan.subscriptionType || plan.rateLimitTier ? plan : null;
}
