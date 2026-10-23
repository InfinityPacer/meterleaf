/**
 * OpenCode Go 每个模型各有美元月上限，周窗口和月窗口分别是月上限的 50% 与 100%。
 * 上游百分比向下取整，周期初期按百分比外推误差很大，设了档位时直接用公布上限估算整窗价值。
 * 上限来源 https://opencode.ai/docs/go/ （2026-10-23 读取），官方可能调整。
 * 只登记价格表里有价格的模型，未登记模型的花费会让估算回退到百分比外推。
 */
const monthlyLimits: Record<"go" | "go-plus", Record<string, string>> = {
  go: { "deepseek-v4.1-flash": "80" },
  "go-plus": { "deepseek-v4.1-flash": "160" },
};

export type GoPlanWindow = "seven-day" | "monthly";

/** 窗口占月上限的比例。5 小时窗口不提供预估，因此不在此列。 */
const windowShares: Readonly<Record<GoPlanWindow, number>> = {
  "seven-day": 0.5,
  monthly: 1,
};

// 固定函数身份，报表索引按身份复用同一模型的窗口汇总。
const modelScopes: Readonly<Record<string, (model: string) => boolean>> = {
  "deepseek-v4.1-flash": (model) => model === "deepseek-v4.1-flash",
};

export interface GoPlanModelLimit {
  model: string;
  /** 月上限，美元。 */
  monthlyUsd: string;
  /** 只汇总该模型的窗口费用，必须使用模块级固定身份。 */
  scope: (model: string) => boolean;
}

export interface GoPlanBudget {
  plan: "go" | "go-plus";
  windowShare: Readonly<Record<GoPlanWindow, number>>;
  models: readonly GoPlanModelLimit[];
}

const budgets: Record<"go" | "go-plus", GoPlanBudget> = {
  go: {
    plan: "go",
    windowShare: windowShares,
    models: [
      {
        model: "deepseek-v4.1-flash",
        monthlyUsd: monthlyLimits.go["deepseek-v4.1-flash"],
        scope: modelScopes["deepseek-v4.1-flash"],
      },
    ],
  },
  "go-plus": {
    plan: "go-plus",
    windowShare: windowShares,
    models: [
      {
        model: "deepseek-v4.1-flash",
        monthlyUsd: monthlyLimits["go-plus"]["deepseek-v4.1-flash"],
        scope: modelScopes["deepseek-v4.1-flash"],
      },
    ],
  },
};

/** 非 OpenCode Go 账户或未登记档位返回 null，调用方保持原有外推逻辑。 */
export function goPlanBudget(
  platform: string | null | undefined,
  plan: string | null | undefined,
): GoPlanBudget | null {
  if (platform?.trim().toLowerCase() !== "opencode-go") return null;
  const key = plan?.trim().toLowerCase();
  return key === "go" || key === "go-plus" ? budgets[key] : null;
}
