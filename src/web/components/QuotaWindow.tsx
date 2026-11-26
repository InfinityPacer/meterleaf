import type { AccountCredits } from "../../shared/report";
import { amount, compact, numericAmount } from "../lib/report";
import {
  creditsBalanceExact,
  estimateAmount,
  estimateDescription,
  formatCreditsBalance,
  quotaFillStyle,
  quotaLabel,
  quotaPercent,
  quotaPeriodKnown,
  quotaResetMinute,
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
  const minute = quotaResetMinute(value);
  const sample = new Date(asOf);
  if (minute === null) return "重置未知";
  const reset = new Date(minute);
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
 * 标题行在已用比例后附本周期缓存命中率。
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
  const { key, label, window, waiting, unopened, independent, platform } =
    selection;
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
        {/* 费用未知不补零，用破折号占住费用位，与其他窗口保持“金额 + 说明”两行。 */}
        <span className="quota-window-foot">
          <span className="quota-window-amount">
            <strong aria-label={`${label}费用等待更新`}>—</strong>
          </span>
          <span className="quota-window-volume">新周期数据到达后显示</span>
        </span>
      </span>
    );
  }
  if (unopened) {
    return (
      <span className="quota-window" data-window={key} data-unopened="true">
        <span className="quota-window-head">
          <span className="quota-window-title">
            <strong className="quota-window-label">{label}</strong>
            <span className="quota-window-status">已用 0%</span>
          </span>
          <span className="quota-window-reset">未开窗</span>
        </span>
        <span
          className="quota-window-progress"
          role="progressbar"
          aria-label={`${label}额度使用情况`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
          aria-valuetext="已用 0%，未开窗"
        >
          <span style={quotaFillStyle(0)} />
        </span>
        {/* 未开窗时尚无周期起点，费用保留破折号不补零，标明首次请求后开始计时。 */}
        <span className="quota-window-foot">
          <span className="quota-window-amount">
            <strong aria-label={`${label}尚未开窗`}>—</strong>
          </span>
          <span className="quota-window-volume">首次请求后开始计时</span>
        </span>
      </span>
    );
  }
  const percent = quotaPercent(window, asOf);
  const usable = percent !== null;
  // 底部本地用量：独立模式按周期是否已知判断，缺百分比时仍照常展示；默认随百分比一起显示。
  const local = independent ? quotaPeriodKnown(window, asOf) : usable;
  // 预估未知时不写“预估 N/A”，账户详情里仍会显示 N/A。
  const estimateText = estimateAmount(window, "usd", asOf);
  const showEstimate =
    estimate &&
    (key === "sevenDay" ||
      key === "sevenDayThirdParty" ||
      key === "sevenDayFable" ||
      key === "monthly") &&
    showQuotaEstimate(window, asOf) &&
    estimateText !== "N/A";
  const status = usable ? quotaLabel(window, asOf, platform) : "N/A";
  // 命中率没有分母时不补 0%，整项不显示；口径与统计页的缓存命中率相同。
  const cacheRate =
    local &&
    window.periodCacheRate !== null &&
    window.periodCacheRate !== undefined &&
    Number.isFinite(window.periodCacheRate)
      ? window.periodCacheRate
      : null;

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
          {cacheRate !== null && (
            <span
              className="quota-window-cache"
              title="本周期缓存命中率，即缓存读取占输入的比例"
            >
              命中 {cacheRate.toFixed(1)}%
            </span>
          )}
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
        <span style={quotaFillStyle(percent)} />
      </span>
      <span className="quota-window-foot">
        {/* 周额度的整周预估紧跟已用费用，与右侧 Tokens、请求数同一行。 */}
        <span className="quota-window-amount">
          <strong aria-label={`${label}费用`}>
            {local
              ? amount(numericAmount(window.periodUsd ?? null), "usd")
              : "N/A"}
          </strong>
          {showEstimate && (
            <span
              className="quota-window-estimate"
              title={`${label} 预估 · ${estimateDescription(window)}`}
            >
              <i aria-hidden="true">·</i>
              <span aria-label={`${label} 预估`}>{estimateText}</span>
            </span>
          )}
        </span>
        <span className="quota-window-volume">
          {local ? compact(window.periodTokens ?? null) : "N/A"} Tokens{" "}
          <i aria-hidden="true">·</i>{" "}
          {local ? formatRequests(window.periodRequests) : "N/A"} 次
        </span>
      </span>
    </span>
  );
}

/** 上游账户额外 Credits 余额行（例如 Codex 订阅额度耗尽后可继续扣减的余额），与额度窗口共用列表与桌面列宽。 */
export function AccountCreditsRow({ credits }: { credits: AccountCredits }) {
  const text = formatCreditsBalance(credits);
  const exact = creditsBalanceExact(credits);
  const title = credits.unlimited
    ? "上游账户 Credits 不限量"
    : exact
      ? `上游账户 Credits 剩余余额：${exact}`
      : "上游账户 Credits 剩余余额";
  return (
    <span className="quota-credits" title={title}>
      <span className="quota-credits-head">
        <strong className="quota-credits-label">Credits</strong>
        <span className="quota-credits-status">
          {credits.unlimited ? "无上限" : "剩余余额"}
        </span>
      </span>
      <strong className="quota-credits-balance" aria-label={`Credits ${text}`}>
        {text}
      </strong>
    </span>
  );
}
