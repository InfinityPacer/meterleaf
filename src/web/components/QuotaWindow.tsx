import { amount, compact, numericAmount } from "../lib/report";
import {
  estimateAmount,
  quotaLabel,
  quotaPercent,
  quotaWaitingReset,
  showQuotaEstimate,
  type VisibleQuotaWindow,
} from "../lib/quota-display";
import "./quota-window.css";

const TIME_ZONE = "Asia/Shanghai";
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 当天重置只显示时刻，跨天才带日期；无效时间不猜测。 */
function formatResetTime(value: string | null, asOf: string) {
  const reset = value ? new Date(value) : null;
  const sample = new Date(asOf);
  if (!reset || !Number.isFinite(reset.getTime())) return "重置未知";
  return Number.isFinite(sample.getTime()) &&
    dayKeyFormatter.format(reset) === dayKeyFormatter.format(sample)
    ? `${clockFormatter.format(reset)} 重置`
    : `${dateTimeFormatter.format(reset)} 重置`;
}

function formatRequests(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : "N/A";
}

/**
 * 首页卡片、账户列表共用的额度窗口：标题行、进度条、费用行，周额度在费用后附整周预估。
 * 每行内容固定，窗口数量变化只增减行或列，不需要为某个数量单独写布局。
 * 整体用 span 渲染，可以放进可点击的账户按钮内。
 */
export function QuotaWindow({
  selection,
  asOf,
  estimate = true,
}: {
  selection: VisibleQuotaWindow;
  asOf: string;
  /** 桌面账户行在右侧另有 7d 预估栏，此时不在窗口内重复。 */
  estimate?: boolean;
}) {
  const { key, label, window, waiting } = selection;
  if (waiting) {
    const ended = quotaWaitingReset(window, asOf);
    return (
      <span className="quota-window" data-window={key} data-waiting="true">
        <span className="quota-window-head">
          <span className="quota-window-title">
            <strong className="quota-window-label">{label}</strong>
            <span className="quota-window-status">等待更新</span>
          </span>
          {ended && <span className="quota-window-reset">{ended}</span>}
        </span>
        <span
          className="quota-window-progress"
          role="progressbar"
          aria-label={`${label}额度使用情况`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext="等待更新"
        >
          {/* 等待期间只显示空轨道；不设宽度的填充块会撑满，看起来像已用尽。 */}
          <span style={{ width: 0 }} />
        </span>
        <span className="quota-window-foot">
          <span className="quota-window-volume">新周期数据到达后显示</span>
        </span>
      </span>
    );
  }
  const percent = quotaPercent(window, asOf);
  const usable = percent !== null;
  // 预估未知时不写“预估 N/A”，账户详情里仍会显示 N/A。
  const estimateText = estimateAmount(window, "usd", asOf);
  const showEstimate =
    estimate &&
    (key === "sevenDay" || key === "sevenDayFable") &&
    showQuotaEstimate(window, asOf) &&
    estimateText !== "N/A";
  const status = usable ? quotaLabel(window, asOf) : "N/A";

  return (
    <span
      className="quota-window"
      data-window={key}
      data-exhausted={usable && percent >= 100}
    >
      <span className="quota-window-head">
        <span className="quota-window-title">
          <strong className="quota-window-label">{label}</strong>
          <span className="quota-window-status">{status}</span>
        </span>
        <span className="quota-window-reset">
          {formatResetTime(window.resetsAt, asOf)}
        </span>
      </span>
      <span
        className="quota-window-progress"
        role="progressbar"
        aria-label={`${label}额度使用情况`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usable ? percent : undefined}
        aria-valuetext={status}
      >
        <span style={{ width: `${usable ? percent : 0}%` }} />
      </span>
      <span className="quota-window-foot">
        {/* 周额度的整周预估紧跟已用费用，与右侧 Tokens、请求数同一行。 */}
        <span className="quota-window-amount">
          <strong aria-label={`${label}费用`}>
            {usable
              ? amount(numericAmount(window.periodUsd ?? null), "usd")
              : "N/A"}
          </strong>
          {showEstimate && (
            <span
              className="quota-window-estimate"
              title={`${label} 预估：按已用比例推算的整周额度价值`}
            >
              <i aria-hidden="true">·</i>
              <span aria-label={`${label} 预估`}>{estimateText}</span>
            </span>
          )}
        </span>
        <span className="quota-window-volume">
          {usable ? compact(window.periodTokens ?? null) : "N/A"} Tokens{" "}
          <i aria-hidden="true">·</i>{" "}
          {usable ? formatRequests(window.periodRequests) : "N/A"} 次
        </span>
      </span>
    </span>
  );
}
