import { ChevronRight } from "lucide-react";
import { accountInitial } from "../lib/account-aliases";
import { planBadge } from "../lib/plan";
import type { LedgerView } from "../../shared/ledger-view";
import type { AccountLifetime, LedgerAccount } from "../../shared/report";
import {
  visibleQuotaWindows,
  withFableQuotaWindow,
} from "../lib/quota-display";
import {
  amount,
  compact,
  continuousPoints,
  numericAmount,
  quotaUnavailableNote,
} from "../lib/report";
import "./mobile-home.css";
import { MiniTrend } from "./AccountTrend";
import { QuotaWindow } from "./QuotaWindow";
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
  points: reportedPoints,
  asOf,
  chartStyle,
  onChartStyleChange,
}: {
  points: LedgerView["view"]["points"];
  asOf: string;
  chartStyle: "line" | "area" | "bar";
  onChartStyleChange?: (style: ChartStyle) => void;
}) {
  const points = continuousPoints(reportedPoints, "day");
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
      <div className="mobile-home-summary-hero">
        <small>历史费用 · {source}</small>
        <strong>{formatUsd(lifetime?.usd)}</strong>
      </div>
      <div className="mobile-home-summary-metrics">
        <span>
          <small>Tokens</small>
          <strong>{formatTokens(lifetime?.tokens.total)}</strong>
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
            const quotas = withFableQuotaWindow(
              visibleQuotaWindows(account, asOf),
              account,
              asOf,
            );
            const hasQuota = Boolean(account.fiveHour || account.sevenDay);
            const plan = planBadge(account);
            const open = () =>
              hasQuota ? onAccount(account) : onRequests(account);
            return (
              <li key={account.id}>
                <button
                  type="button"
                  className="mobile-home-account-card"
                  data-quota-count={quotas.length}
                  onClick={open}
                  aria-label={`查看 ${account.name} ${hasQuota ? "账户额度" : "请求用量"}`}
                >
                  <span className="mobile-home-account-head">
                    <span
                      className="mobile-home-account-avatar"
                      data-kind={account.kind}
                      aria-hidden="true"
                    >
                      {accountInitial(account.name)}
                    </span>
                    <span className="mobile-home-account-name">
                      <strong title={account.name}>{account.name}</strong>
                      {plan && (
                        <span
                          className="plan-chip"
                          data-tier={plan.tier ?? undefined}
                        >
                          {plan.label}
                        </span>
                      )}
                    </span>
                    <ChevronRight
                      className="mobile-home-account-chevron"
                      size={18}
                      aria-hidden="true"
                    />
                  </span>
                  {quotas.length ? (
                    <span
                      className="quota-window-list"
                      data-count={quotas.length}
                    >
                      {quotas.map((quota) => (
                        <QuotaWindow
                          key={quota.key}
                          selection={quota}
                          asOf={asOf}
                        />
                      ))}
                    </span>
                  ) : hasQuota ? (
                    <div className="mobile-home-quota-unavailable">
                      {quotaUnavailableNote(account)}
                    </div>
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
