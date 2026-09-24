import type { LedgerAccount } from "../../shared/report";

/**
 * 订阅档位按使用倍数对齐，不按套餐名称：Claude Pro 与 ChatGPT Plus 为 1 档，
 * Claude Max 5x 与 ChatGPT Pro 5x 为 2 档，Claude Max 20x 与 ChatGPT Pro 20x
 * 为 3 档。同名的 Pro 在两家上游处于不同档位，因此必须结合平台判断。
 */
export type PlanTier = 1 | 2 | 3;

export interface PlanBadge {
  label: string;
  tier: PlanTier | null;
}

/**
 * 已知上游的套餐标识。Claude 采集器上报 pro、max-5x、max-20x；Sub2API 从
 * ChatGPT 凭据读取 plan_type，其中 prolite 是 Pro 5x、pro 是 Pro 20x。
 */
const knownPlans: Record<string, Record<string, PlanBadge>> = {
  anthropic: {
    pro: { label: "Pro", tier: 1 },
    "max-5x": { label: "Max 5x", tier: 2 },
    "max-20x": { label: "Max 20x", tier: 3 },
  },
  openai: {
    plus: { label: "Plus", tier: 1 },
    prolite: { label: "Pro 5x", tier: 2 },
    pro: { label: "Pro 20x", tier: 3 },
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
