import type { AccountWindow, LedgerAccount } from "../../shared/report";
import { amount, numericAmount } from "./report";

/** 各入口只展示当前周期可用的预估，缺值和过期金额不补零。 */
export function estimateAmount(
  window: AccountWindow | null,
  unit: "usd" | "credits",
  asOf: string,
) {
  if (!window || quotaState(window, asOf) === "expired") return "N/A";
  const estimate = window.estimate;
  if (!estimate || estimate.reason !== "eligible") return "N/A";
  return amount(
    numericAmount(unit === "usd" ? estimate.usd : estimate.credits),
    unit,
  );
}

/** 已耗尽的周额度没有剩余用量可预估；未知或过期周期不展示预测。 */
export function showQuotaEstimate(window: AccountWindow | null, asOf: string) {
  const percent = quotaPercent(window, asOf);
  return (
    quotaState(window, asOf) === "active" && percent !== null && percent < 100
  );
}

export interface VisibleQuotaWindow {
  key: "fiveHour" | "sevenDay";
  label: "5h" | "7d";
  window: AccountWindow;
}

/** 周额度耗尽会阻止继续使用，优先单独展示；其他情况只展示当前有效周期。 */
export function visibleQuotaWindows(
  account: Pick<LedgerAccount, "fiveHour" | "sevenDay">,
  asOf: string,
): VisibleQuotaWindow[] {
  const windows: VisibleQuotaWindow[] = [];
  for (const [key, label] of [
    ["fiveHour", "5h"],
    ["sevenDay", "7d"],
  ] as const) {
    const window = account[key];
    if (
      window &&
      quotaState(window, asOf) === "active" &&
      quotaPercent(window, asOf) !== null
    ) {
      windows.push({ key, label, window });
    }
  }
  const exhaustedWeek = windows.find(
    ({ key, window }) =>
      key === "sevenDay" && quotaPercent(window, asOf) === 100,
  );
  return exhaustedWeek ? [exhaustedWeek] : windows;
}

/** 各入口使用同一有效周期规则，过期的耗尽状态不能延续到下一周期。 */
export function accountQuotaExhausted(
  account: Pick<LedgerAccount, "fiveHour" | "sevenDay">,
  asOf: string,
) {
  return visibleQuotaWindows(account, asOf).some(
    ({ window }) => quotaPercent(window, asOf) === 100,
  );
}

/** 未处理的到期点即使已越过也要立即执行，不能在渲染和 effect 之间漏掉。 */
export function nextQuotaRefreshDelay(
  windows: readonly (AccountWindow | null)[],
  lastChecked: number,
  now: number,
) {
  const resets = windows
    .map((window) => Date.parse(window?.resetsAt ?? ""))
    .filter((reset) => Number.isFinite(reset) && reset > lastChecked);
  return resets.length
    ? Math.max(0, Math.min(Math.min(...resets) - now + 1, 2_147_483_647))
    : undefined;
}

/** 重置时刻优先于缓存的状态标记，已到期的旧百分比不能作为当前用量。 */
export function quotaState(window: AccountWindow | null, asOf: string) {
  if (!window) return "unknown" as const;
  if (window.resetsAt && Date.parse(window.resetsAt) <= Date.parse(asOf))
    return "expired" as const;
  return window.state ?? (window.percent === null ? "unknown" : "active");
}

export function quotaPercent(window: AccountWindow | null, asOf: string) {
  if (!window || quotaState(window, asOf) === "expired") return null;
  return window.percent !== null && Number.isFinite(window.percent)
    ? Math.min(Math.max(window.percent, 0), 100)
    : null;
}

/** 缓存年龄不等于同步失败；采样时间在账户详情展示，缺值不补零。 */
export function quotaLabel(window: AccountWindow | null, asOf: string) {
  const percent = quotaPercent(window, asOf);
  if (percent === null) return "N/A";
  return `已用 ${percent}%`;
}
