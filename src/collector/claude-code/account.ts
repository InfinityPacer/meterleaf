import { readFileSync } from "node:fs";
import { subjectKeyFrom } from "../../shared/account-subject";
import type { IngestAccount } from "../../shared/ingest";
import type { ClaudeCredentialPlan } from "./credential";

export const UNATTRIBUTED_ACCOUNT_ID = "unattributed";

/** oauthAccount 中允许读取的非敏感字段；令牌、邮箱和显示名都不读取。 */
export interface ClaudeAccount {
  accountUuid: string;
  organizationUuid: string | null;
  organizationType: string | null;
  rateLimitTier: string | null;
  billingType: string | null;
  /** Team 席位档位，例如 team_tier_1；个人订阅为空。 */
  seatTier: string | null;
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
    seatTier: text(oauth.seatTier),
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

/**
 * Team 席位档位。team_tier_1 是 Premium 席位，速率档位与 Max 5x 相同；team_standard 是
 * Standard 席位。Anthropic 未公开其他取值，未登记的席位只认定为 Team。
 */
function teamPlan(seatTier: string | null): string {
  if (seatTier === "team_tier_1") return "team-premium";
  if (seatTier === "team_standard") return "team-standard";
  return "team";
}

/**
 * 套餐只从上游给出的订阅类型、速率档位、组织类型或席位档位读取，不从接入方式或额度推断。
 * 先用能确定倍数的依据，凭据优先于旧版 Claude Code 写在 ~/.claude.json 的字段；
 * 凭据只说明 Max 或 Team、没有倍数时，排在旧字段和席位档位之后。
 */
export function planFor(
  account: ClaudeAccount,
  credential: ClaudeCredentialPlan | null = null,
): string | null {
  const credentialTier = credential?.rateLimitTier ?? null;
  const credentialType = credential?.subscriptionType ?? null;
  if (credentialType === "team" && credentialTier === "default_claude_max_5x")
    return "team-premium";
  if (credentialType !== "team") {
    if (credentialTier === "default_claude_max_5x") return "max-5x";
    if (credentialTier === "default_claude_max_20x") return "max-20x";
  }
  if (credentialType === "pro" || credentialType === "enterprise")
    return credentialType;
  const tier = account.rateLimitTier;
  if (account.organizationType === "claude_team")
    return tier === "default_claude_max_5x"
      ? "team-premium"
      : teamPlan(account.seatTier);
  if (tier === "default_claude_max_5x") return "max-5x";
  if (tier === "default_claude_max_20x") return "max-20x";
  if (account.organizationType === "claude_pro") return "pro";
  if (account.seatTier?.startsWith("team_")) return teamPlan(account.seatTier);
  if (credentialType === "team" || credentialType === "max")
    return credentialType;
  return account.organizationType;
}

const subscriptionTypes = new Set(["pro", "max", "team", "enterprise"]);

/**
 * 订阅需有订阅计费方式，且组织类型属于 Claude 订阅。新版 Claude Code 不再写组织类型，
 * 缺失时由凭据的订阅类型证明；两者都缺时，订阅计费方式本身只来自 Claude 订阅登录。
 * 组织类型存在但不是 Claude 订阅，或计费方式未知时，不认定为订阅。
 */
export function kindFor(
  account: ClaudeAccount,
  credential: ClaudeCredentialPlan | null = null,
): IngestAccount["kind"] {
  const billingType = account.billingType ?? "";
  if (!billingType.includes("subscription")) return "unknown";
  if (account.organizationType !== null)
    return account.organizationType.startsWith("claude_")
      ? "subscription"
      : "unknown";
  const subscriptionType = credential?.subscriptionType;
  return subscriptionType && !subscriptionTypes.has(subscriptionType)
    ? "unknown"
    : "subscription";
}

/** 公式与 `src/shared/account-subject.ts` 共用，服务端补建账户时保持一致。 */
export function subjectKeyFor(account: ClaudeAccount): string | null {
  return subjectKeyFrom(account.accountUuid, account.organizationUuid);
}

/**
 * 默认名只说明来源；套餐由 plan 单独展示，UUID 对用户没有意义，也不放进名称。
 * 多个账户需要区分时由用户在 Meterleaf 中设置别名。
 */
export function accountFact(
  account: ClaudeAccount,
  credential: ClaudeCredentialPlan | null = null,
): IngestAccount {
  const plan = planFor(account, credential);
  return {
    externalId: account.accountUuid,
    name: "Claude Code",
    platform: "anthropic",
    kind: kindFor(account, credential),
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
