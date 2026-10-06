import Decimal from "decimal.js";

interface ProjectedWindow {
  percent: number | null;
  periodUsd?: string | null;
  periodCredits?: string | null;
  estimate?: { usd: string | null; credits: string | null };
}

/**
 * 预估为已花加剩余比例乘整周外推值。反推出外推值，
 * 让历史选择、加权与回退相关的断言继续检查外推本身。
 */
export function fullWeekEstimate(
  view: ProjectedWindow,
  unit: "usd" | "credits" = "usd",
): string | null {
  const estimate = view.estimate?.[unit] ?? null;
  const spent = (unit === "usd" ? view.periodUsd : view.periodCredits) ?? null;
  if (estimate === null || spent === null || view.percent === null)
    return estimate;
  if (view.percent >= 100) return null;
  return new Decimal(estimate)
    .sub(spent)
    .mul(100)
    .div(100 - view.percent)
    .toDecimalPlaces(12)
    .toString();
}
