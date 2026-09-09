import { ChevronRight, Wallet } from "lucide-react";
import type { LedgerView } from "../../shared/ledger-view";
import type {
  AccountLifetime,
  AccountWindow,
  LedgerAccount,
} from "../../shared/report";
import { quotaLabel, quotaPercent, quotaState } from "../lib/quota-display";
import { amount, compact, numericAmount } from "../lib/report";
import "./mobile-home.css";
import { MiniTrend } from "./AccountTrend";
import { ChartStyleControl } from "./ChartStyleControl";
import type { ChartStyle } from "./UsageChart";

const TIME_ZONE = "Asia/Shanghai";
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TIME_ZONE,
  month: "numeric",
  day: "numeric",
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

/** 首页累计、独立额度窗口与固定日趋势的展示契约。 */
export interface MobileHomeProps {
  snapshot: LedgerView;
  accounts: LedgerAccount[];
  asOf: string;
  onAccount: (account: LedgerAccount) => void;
  onRequests: (account: LedgerAccount) => void;
  onAllAccounts: () => void;
  trendPoints?: LedgerView["view"]["points"];
  chartStyle?: "line" | "area" | "bar";
  onChartStyleChange?: (style: ChartStyle) => void;
}

type QuotaSelection = {
  label: "5 小时" | "7 天";
  window: AccountWindow;
};

function validDate(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatAsOf(value: string) {
  const date = validDate(value);
  return date ? dateTimeFormatter.format(date) : "未知";
}

function sameShanghaiDay(left: Date, right: Date) {
  return dayKeyFormatter.format(left) === dayKeyFormatter.format(right);
}

function formatResetTime(value: string | null, asOf: string) {
  const reset = validDate(value);
  const sample = validDate(asOf);
  if (!reset) return "重置未知";
  return sample && sameShanghaiDay(reset, sample)
    ? `${clockFormatter.format(reset)} 重置`
    : `${dateTimeFormatter.format(reset)} 重置`;
}

function formatTrendLabel(value: number, asOf: string, isLast: boolean) {
  const point = validDate(value);
  const sample = validDate(asOf);
  if (!point) return "未知";
  if (sample && sameShanghaiDay(point, sample)) {
    return isLast ? "今天" : clockFormatter.format(point);
  }
  return dateFormatter.format(point);
}

function formatUsd(value: string | null | undefined) {
  return amount(numericAmount(value ?? null), "usd");
}

function formatTokens(value: number | null | undefined) {
  return compact(value ?? null);
}

function formatRequests(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : "N/A";
}

function planLabel(account: LedgerAccount) {
  const plan = account.plan?.trim();
  if (plan && !["unknown", "未提供"].includes(plan.toLowerCase())) {
    return plan.replace(
      /\b(pro|plus)\b/gi,
      (value) => value[0]!.toUpperCase() + value.slice(1).toLowerCase(),
    );
  }
  return account.kind === "api" ? "API" : null;
}

function selectPrimaryQuota(
  account: LedgerAccount,
  asOf: string,
): QuotaSelection | null {
  const candidates: QuotaSelection[] = [
    account.fiveHour ? { label: "5 小时", window: account.fiveHour } : null,
    account.sevenDay ? { label: "7 天", window: account.sevenDay } : null,
  ].filter((candidate): candidate is QuotaSelection => candidate !== null);
  if (!candidates.length) return null;

  // 只有当前周期可证明有效时才优先 5 小时；未知周期不能覆盖有效的 7 天窗口。
  return (
    candidates.find(({ window }) => quotaState(window, asOf) === "active") ??
    candidates.find(({ window }) => quotaState(window, asOf) !== "expired") ??
    candidates[0]!
  );
}

function quotaStatus(window: AccountWindow, asOf: string) {
  switch (quotaState(window, asOf)) {
    case "active":
      return "使用中";
    case "expired":
      return "已过期";
    default:
      return "未知";
  }
}

function QuotaSummary({
  selection,
  asOf,
}: {
  selection: QuotaSelection;
  asOf: string;
}) {
  const { label, window } = selection;
  const state = quotaState(window, asOf);
  const percent = quotaPercent(window, asOf);
  const usable = state === "active" && percent !== null;
  const reset = formatResetTime(window.resetsAt, asOf);
  const amountValue = usable ? formatUsd(window.periodUsd) : "N/A";
  const tokens = usable ? formatTokens(window.periodTokens) : "N/A";
  const requests = usable ? formatRequests(window.periodRequests) : "N/A";

  return (
    <div
      className="mobile-home-quota"
      data-state={state}
      data-exhausted={usable && percent >= 100}
    >
      <div className="mobile-home-quota-head">
        <strong className="mobile-home-visually-hidden">{label}</strong>
        <span className="mobile-home-quota-status">
          {usable ? quotaLabel(window, asOf) : quotaStatus(window, asOf)}
        </span>
        <span className="mobile-home-quota-reset">
          {state === "expired" ? "等待新周期" : reset}
        </span>
      </div>
      <div
        className="mobile-home-progress"
        role="progressbar"
        aria-label={`${label}额度使用情况`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usable ? percent : undefined}
        aria-valuetext={usable ? quotaLabel(window, asOf) : "未知"}
      >
        <span style={usable ? { width: `${percent}%` } : undefined} />
      </div>
      <div className="mobile-home-quota-foot">
        <strong>{amountValue}</strong>
        <span>
          {tokens} Tokens <i aria-hidden="true">·</i> {requests} 次
        </span>
      </div>
    </div>
  );
}

function UsageSummary({
  account,
  lifetime,
  current,
}: {
  account: LedgerAccount;
  lifetime?: AccountLifetime;
  current?: AccountLifetime;
}) {
  const usage = lifetime ?? current;
  const source = lifetime
    ? "累计用量"
    : current
      ? "当前区间用量"
      : "暂无用量数据";

  return (
    <div className="mobile-home-account-usage">
      <span className="mobile-home-usage-source">{source}</span>
      <div className="mobile-home-usage-values">
        <span>
          <small>Tokens</small>
          <strong>{formatTokens(usage?.tokens)}</strong>
        </span>
        <span>
          <small>请求</small>
          <strong>{formatRequests(usage?.count)}</strong>
        </span>
        <span>
          <small>费用</small>
          <strong>{formatUsd(usage?.usd)}</strong>
        </span>
      </div>
      {!usage && (
        <span className="mobile-home-usage-note">
          当前没有可读的累计或区间汇总。
        </span>
      )}
      <span className="mobile-home-visually-hidden">
        {account.name}无独立额度窗口。
      </span>
    </div>
  );
}

function TrendStrip({
  points,
  asOf,
  chartStyle,
  onChartStyleChange,
}: {
  points: LedgerView["view"]["points"];
  asOf: string;
  chartStyle: "line" | "area" | "bar";
  onChartStyleChange?: (style: ChartStyle) => void;
}) {
  const axisIndexes =
    points.length <= 3
      ? points.map((_, index) => index)
      : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const axisLabels = [...new Set(axisIndexes)].map((index) => ({
    index,
    label: formatTrendLabel(
      points[index]!.at,
      asOf,
      index === points.length - 1,
    ),
  }));

  return (
    <div
      className="mobile-home-trend"
      role="group"
      aria-label="近 30 天 Tokens 趋势"
    >
      <div className="mobile-home-trend-heading">
        <div>
          <strong>Tokens 趋势</strong>
          <span>近 30 天 · 按天汇总</span>
        </div>
        {onChartStyleChange && (
          <ChartStyleControl
            value={chartStyle}
            onChange={onChartStyleChange}
            allowPie={false}
          />
        )}
      </div>
      {points.length ? (
        <>
          <MiniTrend
            points={points}
            metric="tokens"
            variant={chartStyle}
            label="近30天 Tokens"
            hideCaption
            showScale
          />
          <div className="mobile-home-trend-axis" aria-hidden="true">
            {axisLabels.map(({ index, label }) => (
              <span key={`${index}-${label}`}>{label}</span>
            ))}
          </div>
          <ol
            className="mobile-home-visually-hidden"
            aria-label="Tokens 趋势数据"
          >
            {points.map((point, index) => (
              <li key={`${point.at}-${index}`}>
                {formatTrendLabel(point.at, asOf, index === points.length - 1)}
                ：
                {point.value === null || !Number.isFinite(point.value)
                  ? "N/A"
                  : `${compact(point.value)} Tokens`}
                ，{point.count.toLocaleString("en-US")} 次请求
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="mobile-home-trend-empty">暂无真实趋势数据</p>
      )}
    </div>
  );
}

function LifetimeSummary({
  snapshot,
  trendPoints,
  chartStyle,
  onChartStyleChange,
}: {
  snapshot: LedgerView;
  trendPoints: LedgerView["view"]["points"];
  chartStyle: "line" | "area" | "bar";
  onChartStyleChange?: (style: ChartStyle) => void;
}) {
  const lifetime = snapshot.lifetimeTotals;
  const source = lifetime
    ? lifetime.from
      ? `${formatAsOf(lifetime.from)} 起`
      : "全历史快照"
    : "暂无累计快照";

  return (
    <section
      className="mobile-home-summary"
      aria-labelledby="mobile-home-summary-title"
    >
      <div className="mobile-home-section-heading mobile-home-visually-hidden">
        <div>
          <h2 id="mobile-home-summary-title">累计</h2>
          <span>{source}</span>
        </div>
      </div>
      <div className="mobile-home-summary-metrics">
        <span>
          <small>Tokens</small>
          <strong>{formatTokens(lifetime?.tokens.total)}</strong>
        </span>
        <span>
          <small>费用</small>
          <strong>{formatUsd(lifetime?.usd)}</strong>
        </span>
        <span>
          <small>请求</small>
          <strong>{formatRequests(lifetime?.count)}</strong>
        </span>
      </div>
      <TrendStrip
        points={trendPoints}
        asOf={snapshot.asOf}
        chartStyle={chartStyle}
        onChartStyleChange={onChartStyleChange}
      />
    </section>
  );
}

export function MobileHome({
  snapshot,
  accounts,
  asOf,
  onAccount,
  onRequests,
  onAllAccounts,
  trendPoints,
  chartStyle = "line",
  onChartStyleChange,
}: MobileHomeProps) {
  const points = trendPoints ?? snapshot.view.units.tokens.points;

  return (
    <div className="mobile-home">
      <header className="mobile-home-header">
        <div className="mobile-home-as-of">
          <time dateTime={snapshot.asOf}>
            更新于 {formatAsOf(snapshot.asOf)}
          </time>
        </div>
      </header>

      <LifetimeSummary
        snapshot={snapshot}
        trendPoints={points}
        chartStyle={chartStyle}
        onChartStyleChange={onChartStyleChange}
      />

      <section
        className="mobile-home-accounts"
        aria-labelledby="mobile-home-accounts-title"
      >
        <div className="mobile-home-section-heading">
          <h2 id="mobile-home-accounts-title">账户额度</h2>
          <button type="button" onClick={onAllAccounts}>
            全部账户
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <ul className="mobile-home-account-list" aria-label="账户额度摘要">
          {accounts.map((account) => {
            const quota = selectPrimaryQuota(account, asOf);
            const plan = planLabel(account);
            const open = () =>
              quota ? onAccount(account) : onRequests(account);
            return (
              <li key={account.id}>
                <button
                  type="button"
                  className="mobile-home-account-card"
                  onClick={open}
                  aria-label={`查看 ${account.name} ${quota ? "账户额度" : "请求用量"}`}
                >
                  <span className="mobile-home-account-head">
                    <span
                      className="mobile-home-account-avatar"
                      aria-hidden="true"
                    >
                      <Wallet size={18} />
                    </span>
                    <span className="mobile-home-account-name">
                      <strong>{account.name}</strong>
                      {plan && <small>{plan}</small>}
                    </span>
                    <ChevronRight
                      className="mobile-home-account-chevron"
                      size={18}
                      aria-hidden="true"
                    />
                  </span>
                  {quota ? (
                    <QuotaSummary selection={quota} asOf={asOf} />
                  ) : (
                    <UsageSummary
                      account={account}
                      lifetime={account.lifetime}
                      current={snapshot.view.accountUsage?.[account.id]}
                    />
                  )}
                </button>
              </li>
            );
          })}
          {!accounts.length && <li className="mobile-home-empty">暂无账户</li>}
        </ul>
      </section>
    </div>
  );
}
