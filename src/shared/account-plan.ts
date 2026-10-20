/**
 * 用户可为 Claude 账户手动指定的套餐。新版 Claude Code 只在登录凭据里保存套餐，
 * 未登录的账户或凭据不可读时，由用户补上档位；取值与采集器上报的标识一致。
 */
export const manualAccountPlans = [
  "pro",
  "max-5x",
  "max-20x",
  "team-standard",
  "team-premium",
] as const;

export type ManualAccountPlan = (typeof manualAccountPlans)[number];
