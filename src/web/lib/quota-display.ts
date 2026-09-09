import type { AccountWindow } from "../../shared/report";

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
