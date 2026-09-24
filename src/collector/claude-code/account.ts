import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IngestAccount } from "../../shared/ingest";

export const UNATTRIBUTED_ACCOUNT_ID = "unattributed";

/** oauthAccount 中允许读取的非敏感字段；令牌、邮箱和显示名都不读取。 */
export interface ClaudeAccount {
  accountUuid: string;
  organizationUuid: string | null;
  organizationType: string | null;
  rateLimitTier: string | null;
  billingType: string | null;
}

export interface CachedUtilization {
  fetchedAtMs: number;
  accountUuid: string | null;
  utilization: Record<string, unknown>;
}

export interface ClaudeJsonSnapshot {
  account: ClaudeAccount | null;
  utilization: CachedUtilization | null;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

/**
 * 只读一次 ~/.claude.json。Claude Code 会频繁整体重写该文件，读到半截或无效 JSON
 * 时返回 null，本轮跳过账户与额度，下一轮再读；绝不写入、加锁或改权限。
 */
export function readClaudeJson(path: string): ClaudeJsonSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(path, { encoding: "utf8", flag: "r" });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = object(parsed);
  if (!root) return null;
  return {
    account: accountFrom(root.oauthAccount),
    utilization: utilizationFrom(root.cachedUsageUtilization),
  };
}

function accountFrom(value: unknown): ClaudeAccount | null {
  const oauth = object(value);
  const accountUuid = oauth ? text(oauth.accountUuid) : null;
  if (!oauth || !accountUuid) return null;
  return {
    accountUuid,
    organizationUuid: text(oauth.organizationUuid),
    organizationType: text(oauth.organizationType),
    rateLimitTier: text(oauth.organizationRateLimitTier),
    billingType: text(oauth.billingType),
  };
}

function utilizationFrom(value: unknown): CachedUtilization | null {
  const cached = object(value);
  const utilization = cached ? object(cached.utilization) : null;
  if (!cached || !utilization) return null;
  if (typeof cached.fetchedAtMs !== "number") return null;
  if (!Number.isFinite(cached.fetchedAtMs)) return null;
  return {
    fetchedAtMs: cached.fetchedAtMs,
    accountUuid: text(cached.accountUuid),
    utilization,
  };
}

/** 套餐只从速率档位或组织类型读取，不从接入方式推断。 */
export function planFor(account: ClaudeAccount): string | null {
  const tier = account.rateLimitTier;
  if (tier === "default_claude_max_5x") return "max-5x";
  if (tier === "default_claude_max_20x") return "max-20x";
  if (account.organizationType === "claude_pro") return "pro";
  return account.organizationType;
}

/** 订阅需同时满足 Claude 订阅组织类型和订阅计费方式，任一未知都不认定为订阅。 */
export function kindFor(account: ClaudeAccount): IngestAccount["kind"] {
  const organizationType = account.organizationType ?? "";
  const billingType = account.billingType ?? "";
  return organizationType.startsWith("claude_") &&
    billingType.includes("subscription")
    ? "subscription"
    : "unknown";
}

/**
 * 同一上游主体的稳定摘要，用于服务端跨来源识别同一账户；只含 UUID，不含邮箱或名称。
 * 组织 UUID 缺失时无法构成完整主体，保留未知。
 */
export function subjectKeyFor(account: ClaudeAccount): string | null {
  if (!account.organizationUuid) return null;
  const digest = createHash("sha256")
    .update(
      `anthropic_account_uuid=${account.accountUuid}\nanthropic_organization_uuid=${account.organizationUuid}`,
    )
    .digest("hex");
  return `sha256:${digest}`;
}

/**
 * 默认名只说明来源；套餐由 plan 单独展示，UUID 对用户没有意义，也不放进名称。
 * 多个账户需要区分时由用户在 Meterleaf 中设置别名。
 */
export function accountFact(account: ClaudeAccount): IngestAccount {
  const plan = planFor(account);
  return {
    externalId: account.accountUuid,
    name: "Claude Code",
    platform: "anthropic",
    kind: kindFor(account),
    plan,
    subjectKey: subjectKeyFor(account),
  };
}

export const unattributedAccount: IngestAccount = {
  externalId: UNATTRIBUTED_ACCOUNT_ID,
  name: "未归属",
  platform: "anthropic",
  kind: "unknown",
  plan: null,
  subjectKey: null,
};
