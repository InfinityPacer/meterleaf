/**
 * 用户可手动指定的套餐，按平台列出。新版 Claude Code 只在登录凭据里保存套餐，未登录的账户或
 * 凭据不可读时由用户补上档位；Antigravity 只报出 Google AI Ultra，不报 5x 或 20x，倍数由用户指定。
 * 取值与采集器上报的标识一致。
 */
export const manualAccountPlansByPlatform = {
  anthropic: ["pro", "max-5x", "max-20x", "team-standard", "team-premium"],
  google: ["ultra-5x", "ultra-20x"],
} as const;

export type ManualPlanPlatform = keyof typeof manualAccountPlansByPlatform;

export const manualAccountPlans = [
  ...manualAccountPlansByPlatform.anthropic,
  ...manualAccountPlansByPlatform.google,
] as const;

export type ManualAccountPlan = (typeof manualAccountPlans)[number];

export function isManualPlanPlatform(
  platform: string | null | undefined,
): platform is ManualPlanPlatform {
  return platform === "anthropic" || platform === "google";
}
