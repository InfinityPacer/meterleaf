import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
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
  numericAmount,
  quotaUnavailableNote,
} from "../lib/report";
import "./mobile-home.css";
import { QuotaWindow } from "./QuotaWindow";
import { CompositionBar, type UsageSummaryData } from "./UsageSummary";

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

/** 首页所选范围的摘要与独立额度窗口；趋势和模型分布由总览在账户之后展示。 */
export interface MobileHomeProps {
  snapshot: LedgerView;
  accounts: LedgerAccount[];
  asOf: string;
  /** 尚未取得所选范围时为 null，显示占位而不是零。 */
  summary: UsageSummaryData | null;
  rangeLabel: string;
  /** 所选范围仍在读取，摘要暂时是上一次的结果。 */
  summaryUpdating?: boolean;
  onAccount: (account: LedgerAccount) => void;
  onRequests: (account: LedgerAccount) => void;
  /** 当前列出的是已归档账户。 */
  showArchived?: boolean;
  /** 账户区标题右侧的归档与排序切换。 */
  accountHeadingActions?: ReactNode;
  /** 每张账户卡片的排序按钮与管理菜单，与卡片按钮平级，不能嵌套在按钮里。 */
  renderAccountActions?: (account: LedgerAccount) => ReactNode;
}

function validDate(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDate(value: string) {
  const date = validDate(value);
  return date ? dateFormatter.format(date) : "未知";
}

function formatAsOf(value: string) {
  const date = validDate(value);
  return date ? dateTimeFormatter.format(date) : "未知";
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

function RangeSummary({
  summary,
  rangeLabel,
  updating,
}: {
  summary: UsageSummaryData | null;
  rangeLabel: string;
  updating: boolean;
}) {
  const since = summary?.since ? `${formatDate(summary.since)} 起` : null;
  const change = summary?.change?.usd ?? null;
  const note = summary?.change
    ? change === null
      ? "暂无对比"
      : `${change > 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(1)}% 环比`
    : [
        since,
        summary?.dailyUsd != null
          ? `日均 ${amount(summary.dailyUsd, "usd")}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <section
      className="mobile-home-summary"
      aria-labelledby="mobile-home-summary-title"
      aria-busy={updating}
    >
      <div className="mobile-home-section-heading mobile-home-visually-hidden">
        <div>
          <h2 id="mobile-home-summary-title">{rangeLabel}用量</h2>
          <span>{note}</span>
        </div>
      </div>
      <div className="mobile-home-summary-hero">
        <small>
          {rangeLabel}费用{summary ? ` · ${summary.usdNote}` : ""}
        </small>
        <strong>{summary ? amount(summary.usd, "usd") : "…"}</strong>
        {note && <small className="mobile-home-summary-note">{note}</small>}
      </div>
      <div className="mobile-home-summary-metrics" data-count="3">
        <span>
          <small>Tokens</small>
          <strong>{formatTokens(summary?.tokens)}</strong>
        </span>
        <span>
          <small>请求</small>
          <strong>{formatRequests(summary?.requests)}</strong>
        </span>
        <span>
          <small>缓存命中率</small>
          <strong>
            {summary?.cacheRate == null
              ? "N/A"
              : `${summary.cacheRate.toFixed(1)}%`}
          </strong>
        </span>
      </div>
      {summary && <CompositionBar composition={summary.composition} />}
    </section>
  );
}

export function MobileHome({
  snapshot,
  accounts,
  asOf,
  onAccount,
  onRequests,
  showArchived = false,
  accountHeadingActions,
  renderAccountActions,
  summary,
  rangeLabel,
  summaryUpdating = false,
}: MobileHomeProps) {
  return (
    <div className="mobile-home">
      <header className="mobile-home-header">
        <div className="mobile-home-as-of">
          <time dateTime={snapshot.asOf}>
            更新于 {formatAsOf(snapshot.asOf)}
          </time>
        </div>
      </header>

      <RangeSummary
        summary={summary}
        rangeLabel={rangeLabel}
        updating={summaryUpdating}
      />

      <section
        className="mobile-home-accounts"
        aria-labelledby="mobile-home-accounts-title"
      >
        <div className="mobile-home-section-heading">
          <h2 id="mobile-home-accounts-title">
            {showArchived ? "已归档账户" : "账户额度"}
          </h2>
          {accountHeadingActions}
        </div>
        <ul
          className="mobile-home-account-list"
          aria-label={showArchived ? "已归档账户列表" : "账户额度摘要"}
        >
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
              <li
                key={account.id}
                data-account-id={account.id}
                data-manageable={renderAccountActions ? "" : undefined}
              >
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
                {renderAccountActions?.(account)}
              </li>
            );
          })}
          {!accounts.length && (
            <li className="mobile-home-empty">
              {showArchived ? "暂无归档账户" : "暂无账户"}
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
