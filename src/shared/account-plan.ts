/**
 * 用户可手动指定的套餐，按平台列出。新版 Claude Code 只在登录凭据里保存套餐，未登录的账户或
 * 凭据不可读时由用户补上档位；Codex 在账户不再登录本机或上游未上报 plan_type 时由用户指定；
 * Antigravity 只报出 Google AI Ultra，不报 5x 或 20x，倍数由用户指定，只在 omp 里登录、
 * 状态栏从未读到套餐的 Google 账号也可以补上 Plus 或 Pro。
 * 取值与采集器上报的标识一致。
 */
export const manualAccountPlansByPlatform = {
  anthropic: ["pro", "max-5x", "max-20x", "team-standard", "team-premium"],
  openai: ["go", "plus", "prolite", "pro", "pro500", "team", "business"],
  google: ["plus", "pro", "ultra-5x", "ultra-20x"],
} as const;

export type ManualPlanPlatform = keyof typeof manualAccountPlansByPlatform;

export const manualAccountPlans = [
  ...manualAccountPlansByPlatform.anthropic,
  ...manualAccountPlansByPlatform.openai,
  ...manualAccountPlansByPlatform.google,
] as const;

export type ManualAccountPlan = (typeof manualAccountPlans)[number];

export function isManualPlanPlatform(
  platform: string | null | undefined,
): platform is ManualPlanPlatform {
  return (
    platform === "anthropic" || platform === "openai" || platform === "google"
  );
}
