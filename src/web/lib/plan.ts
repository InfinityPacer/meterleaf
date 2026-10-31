import type { LedgerAccount } from "../../shared/report";

/**
 * 订阅档位按使用倍数对齐，不按套餐名称：Claude Pro、ChatGPT Plus 与 Google AI Pro 为 1 档，
 * Claude Max（原 Max 5x）、ChatGPT Pro 5x 与 Google AI Ultra 5x 为 2 档，Claude Ultra
 * （原 Max 20x）、ChatGPT Pro 20x 与 Google AI Ultra 20x 为 3 档。同名的 Pro 在各家上游处于
 * 不同档位，因此必须结合平台判断。
 */
export type PlanTier = 1 | 2 | 3;

export interface PlanBadge {
  label: string;
  tier: PlanTier | null;
}

/**
 * 已知上游的套餐标识。Claude 采集器上报 pro、max-5x、max-20x、team-standard、team-premium，
 * 只知道订阅类型时上报 max、team 或 enterprise。2026-10-30 起 Anthropic 把 Max 5x 改名 Max、
 * Max 20x 改名 Ultra，标识沿用原值，只改显示名。Sub2API 从 ChatGPT 凭据读取 plan_type，其中
 * prolite 是 Pro 5x、pro 是 Pro 20x。Antigravity 采集器原样上报 Google AI Ultra 这类套餐名，
 * 不带倍数，倍数由用户在套餐设置里指定为 ultra-5x 或 ultra-20x。
 */
const knownPlans: Record<string, Record<string, PlanBadge>> = {
  anthropic: {
    pro: { label: "Pro", tier: 1 },
    "max-5x": { label: "Max", tier: 2 },
    "max-20x": { label: "Ultra", tier: 3 },
    // Team 席位按用量对齐，Standard 略高于 Pro，Premium 与 Max（原 Max 5x）同一速率档位。
    "team-standard": { label: "Team Standard", tier: 1 },
    "team-premium": { label: "Team Premium", tier: 2 },
    // 只知道订阅类型、不知道倍数时不给档位。
    max: { label: "Max", tier: null },
    ultra: { label: "Ultra", tier: 3 },
    team: { label: "Team", tier: null },
    enterprise: { label: "Enterprise", tier: null },
  },
  openai: {
    plus: { label: "Plus", tier: 1 },
    prolite: { label: "Pro 5x", tier: 2 },
    pro: { label: "Pro 20x", tier: 3 },
  },
  google: {
    "google ai pro": { label: "Pro", tier: 1 },
    "google ai ultra": { label: "Ultra", tier: null },
    "ultra-5x": { label: "Ultra 5x", tier: 2 },
    "ultra-20x": { label: "Ultra 20x", tier: 3 },
  },
  // OpenCode Go 的额度不按订阅倍数分档，页面只显示名称。
  "opencode-go": {
    go: { label: "Go", tier: null },
    "go-plus": { label: "Go Plus", tier: null },
  },
};

/**
 * 账户的套餐徽标。未知平台或未登记的套餐只整理大小写、不给档位；未提供
 * 套餐的 API 接入显示 API，其余未知情况不显示徽标。
 */
export function planBadge(
  account: Pick<LedgerAccount, "plan" | "kind" | "platform">,
): PlanBadge | null {
  const value = account.plan?.trim();
  if (!value || ["unknown", "未提供"].includes(value.toLowerCase())) {
    return account.kind === "api" ? { label: "API", tier: null } : null;
  }
  const known =
    knownPlans[account.platform?.toLowerCase() ?? ""]?.[value.toLowerCase()];
  if (known) return known;
  return {
    label: value
      .replace(/^max-(\d+x)$/i, "max $1")
      .replace(
        /\b(pro|plus|max|team|enterprise)\b/gi,
        (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
      ),
    tier: null,
  };
}
