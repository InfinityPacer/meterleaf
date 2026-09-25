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

/** 移动端紧凑金额行隐藏已耗尽、未知或过期周期的预估；Web 始终保留预估栏。 */
export function showQuotaEstimate(window: AccountWindow | null, asOf: string) {
  const percent = quotaPercent(window, asOf);
  return (
    quotaState(window, asOf) === "active" && percent !== null && percent < 100
  );
}

export interface VisibleQuotaWindow {
  key: "fiveHour" | "sevenDay" | "sevenDayFable";
  label: "5h" | "7d" | "Fable";
  window: AccountWindow;
  /** 上游报过这个窗口，但当前快照已过期或缺值；只占位，不展示旧用量。 */
  waiting?: boolean;
}

/**
 * 紧凑视图优先展示耗尽的周额度；完整视图保留所有有效周期。周额度有效且未用满时，
 * 上游报过的 5h 窗口即使暂时过期或缺值也保留位置，避免它随采样节奏时隐时现。
 */
export function visibleQuotaWindows(
  account: Pick<LedgerAccount, "fiveHour" | "sevenDay">,
  asOf: string,
  prioritizeExhaustedWeek = true,
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
  if (exhaustedWeek) return prioritizeExhaustedWeek ? [exhaustedWeek] : windows;
  const week = windows.find(({ key }) => key === "sevenDay");
  if (week && account.fiveHour && windows[0] === week)
    return [
      { key: "fiveHour", label: "5h", window: account.fiveHour, waiting: true },
      week,
    ];
  return windows;
}

/**
 * Fable 周额度只计 Fable 请求，排在共享窗口之后。账户整体周额度用尽时所有模型都不可用，
 * 紧凑视图只保留用尽的周额度；上游未上报 Fable 额度时不显示，不按套餐推断有无。
 */
export function withFableQuotaWindow(
  windows: VisibleQuotaWindow[],
  account: Pick<LedgerAccount, "sevenDayFable">,
  asOf: string,
): VisibleQuotaWindow[] {
  const window = account.sevenDayFable ?? null;
  if (
    !window ||
    quotaState(window, asOf) !== "active" ||
    quotaPercent(window, asOf) === null
  )
    return windows;
  const exhaustedWeekOnly =
    windows.length === 1 &&
    windows[0]!.key === "sevenDay" &&
    quotaPercent(windows[0]!.window, asOf) === 100;
  if (exhaustedWeekOnly) return windows;
  return [...windows, { key: "sevenDayFable", label: "Fable", window }];
}

/** 等待新采样的窗口只说明上一周期何时结束，不给出百分比或金额。 */
export function quotaWaitingReset(window: AccountWindow, asOf: string) {
  if (quotaState(window, asOf) !== "expired" || !window.resetsAt) return null;
  return `${new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(window.resetsAt))} 已重置`;
}

/** 各入口使用同一有效周期规则，过期的耗尽状态不能延续到下一周期。 */
export function accountQuotaExhausted(
  account: Pick<LedgerAccount, "fiveHour" | "sevenDay">,
  asOf: string,
) {
  return visibleQuotaWindows(account, asOf).some(
    ({ window, waiting }) => !waiting && quotaPercent(window, asOf) === 100,
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
