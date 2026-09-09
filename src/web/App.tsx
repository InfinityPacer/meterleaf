import { version as appVersion } from "../../package.json";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu as ActionMenu } from "@base-ui/react/menu";
import type { Charge } from "../domain/pricing";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Check,
  Archive,
  ArchiveRestore,
  Trash2,
  MoreHorizontal,
  BarChart3,
  Coins,
  Database,
  FileText,
  Info,
  Layers3,
  Leaf,
  Menu,
  RefreshCw,
  Search,
  Wallet,
  X,
  Zap,
  Home,
} from "lucide-react";
import type {
  AccountWindow,
  AccountLifetime,
  Granularity,
  LedgerAccount,
  LedgerRecord,
  ReportFilter,
  ReportUnit,
  UsdBasis,
} from "../shared/report";
import { createDemoLedger } from "./demo/ledger";
import {
  createLedgerView,
  withUsdVariants,
  selectUsdView,
  type LedgerView,
  type ViewQuery,
} from "../shared/ledger-view";
import { SyncControl } from "./components/SyncControl";
import { FilterSelect } from "./components/FilterSelect";
import {
  ThemeControl,
  readStoredThemeMode,
  resolveThemeDark,
} from "./components/ThemeControl";
import { quotaLabel, quotaPercent, quotaState } from "./lib/quota-display";
import { useQuotaClock } from "./lib/use-quota-clock";
import { useReportFilters } from "./lib/report-preferences";
import {
  preferenceSchemas as prefs,
  readPreference,
  usePreference,
  useScopedPreference,
} from "./lib/preferences";
import { orderedAccounts, moveAccount } from "./lib/account-order";
import { useAccountArchive } from "./lib/use-account-archive";
import { Segmented } from "./components/Segmented";
import {
  amount,
  compact,
  localTime,
  modelColor,
  modelLabel,
  numericAmount,
  summarize,
} from "./lib/report";
import { LedgerTable } from "./components/LedgerTable";
import { DateRangePicker } from "./components/DateRangePicker";
import { ReportTable } from "./components/ReportTable";
import { ModelDistribution } from "./components/ModelDistribution";
import { MobileFilters } from "./components/MobileFilters";
import { MobileHome } from "./components/MobileHome";
import { AboutPage } from "./components/AboutPage";
import { AccountTrend, MiniTrend } from "./components/AccountTrend";
import { ChartStyleControl } from "./components/ChartStyleControl";
import { useMobileLayout } from "./lib/use-mobile-layout";
import { useLiveUpdates } from "./lib/use-live-updates";
import type { ChartStyle } from "./components/UsageChart";
import type { ReportDimension } from "./lib/report";
import { Button } from "./components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./components/ui/sheet";

const UsageChart = lazy(() =>
  import("./components/UsageChart").then((m) => ({ default: m.UsageChart })),
);
const primaryPages = [
  { id: "overview", name: "用量总览", icon: Activity },
  { id: "accounts", name: "账户额度", icon: Wallet },
  { id: "reports", name: "统计报表", icon: BarChart3 },
  { id: "ledger", name: "请求明细", icon: FileText },
] as const;
const pages = [
  ...primaryPages,
  { id: "period", name: "用量总览", icon: Activity },
  { id: "settings", name: "关于", icon: Info },
] as const;
type Page = (typeof pages)[number]["id"];
const initialFilter: ReportFilter = {
  days: 7,
  model: "all",
  account: "all",
  search: "",
};

function readStoredUsdBasis(): UsdBasis | null {
  try {
    const value = localStorage.getItem("meterleaf-usd-basis");
    return value === "api" || value === "subscription" ? value : null;
  } catch {
    return null;
  }
}

async function readLedger(
  viewQuery: ViewQuery,
  usdBasis?: UsdBasis,
  signal?: AbortSignal,
  refresh = true,
): Promise<LedgerView> {
  const { filter } = viewQuery;
  if (import.meta.env.VITE_METERLEAF_DEMO === "true")
    return withUsdVariants(
      createLedgerView(createDemoLedger("subscription"), viewQuery),
      createLedgerView(createDemoLedger("api"), viewQuery),
      usdBasis ?? "subscription",
    );
  const params = new URLSearchParams(
    filter.dateRange ?? { days: String(filter.days) },
  );
  if (usdBasis) params.set("usdBasis", usdBasis);
  if (!refresh) params.set("refresh", "false");
  for (const key of ["model", "account", "search"] as const)
    params.set(key, filter[key]);
  for (const key of [
    "unit",
    "granularity",
    "dimension",
    "page",
    "pageSize",
    "sort",
    "desc",
  ] as const)
    params.set(key, String(viewQuery[key]));
  try {
    const response = await fetch(`/api/view?${params.toString()}`, { signal });
    if (!response.ok) {
      const reason =
        response.status === 408 || response.status === 504
          ? "网关超时"
          : response.status === 502 || response.status === 503
            ? "网关不可用"
            : `HTTP ${response.status}`;
      throw new Error(`报表读取失败：${reason}（HTTP ${response.status}）`);
    }
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("报表读取失败：响应格式无效", { cause: error });
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof Error && error.message.startsWith("报表读取失败："))
      throw error;
    throw new Error("报表读取失败：网络连接异常", { cause: error });
  }
}

/** 账户微图固定为近七天小时用量，不跟随其他页面的模型或日期筛选。 */
function readAccountTrend(
  accountId: string,
  signal: AbortSignal,
  refresh: boolean,
) {
  return readLedger(
    {
      filter: { days: 7, model: "all", account: accountId, search: "" },
      unit: "tokens",
      granularity: "hour",
      dimension: "day",
      page: 0,
      pageSize: 1,
      sort: "occurredAt",
      desc: true,
    },
    undefined,
    signal,
    refresh,
  );
}

function formatUsd(value: string | null) {
  const numeric = numericAmount(value);
  return numeric === null ? "N/A" : amount(numeric, "usd");
}

function formatCredits(value: string | null) {
  const numeric = numericAmount(value);
  return numeric === null ? "N/A" : amount(numeric, "credits");
}

function chargeBasisLabel(charge: Charge | undefined) {
  if (!charge) return "未提供";
  if (charge.basis === "upstream") return "上游金额";
  if (charge.basis === "estimated")
    return charge.assumedStandard
      ? "独立费率估值 · 档位按 Standard"
      : "独立费率估值";
  return "未计价";
}

function chargeReasonLabel(charge: Charge | undefined) {
  if (!charge || charge.amount !== null) return "";
  return charge.reason ? `未计价原因：${charge.reason}` : "未计价原因未提供";
}

function windowAmount(
  window: AccountWindow | null,
  unit: "usd" | "credits",
  asOf: string,
) {
  if (!window || quotaState(window, asOf) === "expired") return "N/A";
  if ((unit === "usd" ? window.periodUsd : window.periodCredits) == null)
    return "N/A";
  return unit === "usd"
    ? formatUsd(window.periodUsd ?? null)
    : formatCredits(window.periodCredits ?? null);
}

function estimateAmount(
  window: AccountWindow | null,
  unit: "usd" | "credits",
  asOf: string,
) {
  if (!window || quotaState(window, asOf) === "expired") return "N/A";
  const estimate = window.estimate;
  if (!estimate) return "N/A";
  const value = unit === "usd" ? estimate.usd : estimate.credits;
  if (estimate.reason !== "eligible") return "N/A";
  return unit === "usd" ? formatUsd(value) : formatCredits(value);
}

function readPage(): Page {
  const id = location.hash.slice(1);
  return pages.some((p) => p.id === id)
    ? (id as Page)
    : readPreference("page", prefs.page, "overview");
}

function QuotaBar({
  window,
  label,
  asOf,
  reset,
}: {
  window: AccountWindow | null;
  label: string;
  asOf: string;
  reset?: React.ReactNode;
}) {
  const state = quotaState(window, asOf);
  const percent = quotaPercent(window, asOf);
  const suffix = quotaLabel(window, asOf);
  return (
    <div
      className="quota-bar"
      data-quota-level={percent !== null && percent > 80 ? "high" : "normal"}
    >
      <div>
        <span>{label}</span>
        <span className="tabular">{suffix}</span>
        {reset}
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          style={{ width: `${percent ?? 0}%` }}
          className={(percent ?? 0) > 80 ? "high" : state}
        />
      </div>
    </div>
  );
}

/** 周期统计跟随额度窗口；缺失和到期窗口不展示旧统计或虚构零值。 */
function QuotaPeriod({
  window,
  label,
  asOf,
}: {
  window: AccountWindow | null;
  label: string;
  asOf: string;
}) {
  const available =
    window && quotaPercent(window, asOf) !== null && window.state !== "unknown";
  const reset =
    available && window.resetsAt ? (
      <span className="quota-period-reset" aria-label={`${label}重置时间`}>
        {label === "5 小时"
          ? new Intl.DateTimeFormat("zh-CN", {
              timeZone: "Asia/Shanghai",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).format(new Date(window.resetsAt))
          : localTime(window.resetsAt, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}{" "}
        重置
      </span>
    ) : undefined;
  return (
    <span className="quota-period">
      <QuotaBar window={window} label={label} asOf={asOf} reset={reset} />
      {available && (
        <>
          <span className="quota-period-usage">
            <strong aria-label={`${label}估算费用`}>
              {windowAmount(window, "usd", asOf)}
            </strong>
            <span className="quota-period-volume">
              <span>{compact(window.periodTokens ?? null)} Tokens</span>
              <span aria-hidden="true">·</span>
              <span>
                {window.periodRequests?.toLocaleString("en-US") ?? "N/A"} 次
              </span>
            </span>
          </span>
        </>
      )}
    </span>
  );
}

function AccountRow({
  account,
  asOf,
  onOpen,
  compactView = false,
  archived = false,
  usdBasis,
  compactUsage = false,
  usage,
}: {
  account: LedgerAccount;
  asOf: string;
  onOpen: () => void;
  compactView?: boolean;
  archived?: boolean;
  usdBasis: UsdBasis;
  compactUsage?: boolean;
  usage?: AccountLifetime;
}) {
  const accountUsage = account.lifetime ?? usage;
  const hasQuota = Boolean(account.fiveHour || account.sevenDay);
  const primaryFiveHour = quotaPercent(account.fiveHour, asOf) !== null;
  const plan = account.plan?.replace(
    /\b(pro|plus)\b/gi,
    (value) => value[0]!.toUpperCase() + value.slice(1).toLowerCase(),
  );
  const accountKind =
    account.kind === "api"
      ? "API 接入"
      : account.kind === "subscription"
        ? "订阅账户"
        : "账户类型未知";
  return (
    <button className="account-row" data-has-quota={hasQuota} onClick={onOpen}>
      <span className="account-identity">
        <span
          className={`account-avatar ${account.id}`}
          data-kind={account.kind}
          data-plan={account.plan?.toLowerCase()}
        >
          <Wallet size={18} />
        </span>
        <span className="account-name">
          <strong>{account.name}</strong>
          <small>
            {plan && !["未提供", "unknown"].includes(plan) && (
              <span
                className="plan-chip"
                data-plan={account.plan?.toLowerCase()}
              >
                {plan}
              </span>
            )}
            <span>{accountKind}</span>
          </small>
          <span className="desktop-account-status" data-archived={archived}>
            <span aria-hidden="true" />
            {archived ? "已归档" : "使用中"}
          </span>
        </span>
      </span>
      {compactView && (
        <span className="app-account-status">
          {archived ? "已归档" : "使用中"}
        </span>
      )}
      {hasQuota ? (
        <>
          {(!compactView || primaryFiveHour || !account.sevenDay) && (
            <span className="account-window account-five-hour">
              <QuotaPeriod
                window={account.fiveHour}
                label="5 小时"
                asOf={asOf}
              />
            </span>
          )}
          {(!compactView || (!primaryFiveHour && !!account.sevenDay)) && (
            <span className="account-window account-seven-day">
              <QuotaPeriod window={account.sevenDay} label="7 天" asOf={asOf} />
            </span>
          )}
          <span className="account-capacity">
            <small>7 天预估费用</small>
            <AccountTrend accountId={account.id} load={readAccountTrend} />
            <strong>{estimateAmount(account.sevenDay, "usd", asOf)}</strong>
          </span>
        </>
      ) : (
        <span className="account-no-quota">
          {accountUsage ? (
            <span className="account-lifetime">
              <span>
                <Activity className="account-metric-icon" aria-hidden="true" />
                <small>
                  {account.lifetime ? "累计 Tokens" : "时段 Tokens"}
                </small>
                <strong>{compact(accountUsage.tokens)}</strong>
                {!compactUsage && (
                  <AccountTrend
                    accountId={account.id}
                    load={readAccountTrend}
                  />
                )}
              </span>
              <span>
                <Zap className="account-metric-icon" aria-hidden="true" />
                <small>{account.lifetime ? "累计请求" : "时段请求"}</small>
                <strong>{accountUsage.count.toLocaleString()}</strong>
                {!compactUsage && (
                  <AccountTrend
                    accountId={account.id}
                    load={readAccountTrend}
                    metric="requests"
                    variant="line"
                  />
                )}
              </span>
              <span>
                <Coins className="account-metric-icon" aria-hidden="true" />
                <small>估算费用</small>
                <strong>{formatUsd(accountUsage.usd)}</strong>
                {!compactUsage && (
                  <AccountTrend
                    accountId={account.id}
                    load={readAccountTrend}
                    metric="usd"
                    usdBasis={usdBasis}
                  />
                )}
              </span>
            </span>
          ) : (
            <span>暂无用量数据</span>
          )}
          {compactUsage && (
            <AccountTrend accountId={account.id} load={readAccountTrend} />
          )}
        </span>
      )}
      <ArrowRight className="row-arrow" size={16} />
    </button>
  );
}

/** 订阅账户按独立额度窗口展示；无额度账户使用当前报表筛选后的用量。 */
function OverviewQuotas({
  accounts,
  asOf,
  onOpen,
  onAll,
  onRequests,
  accountUsage,
  usdBasis,
}: {
  accounts: LedgerAccount[];
  asOf: string;
  onOpen: (account: LedgerAccount) => void;
  onAll: () => void;
  onRequests: (account: LedgerAccount) => void;
  accountUsage?: Record<string, AccountLifetime>;
  usdBasis: UsdBasis;
}) {
  return (
    <section
      className="overview-quotas"
      aria-labelledby="overview-quotas-title"
    >
      <div className="section-heading">
        <h2 id="overview-quotas-title">账户额度</h2>
        <Button variant="ghost" onClick={onAll}>
          全部账户 <ArrowRight size={16} />
        </Button>
      </div>
      <div
        className="quota-preview-list"
        role="region"
        aria-label="账户额度摘要"
        tabIndex={0}
      >
        {accounts.map((account) => {
          const hasQuota = Boolean(account.fiveHour || account.sevenDay);
          const usage = accountUsage?.[account.id];
          const plan = account.plan?.replace(
            /\b(pro|plus)\b/gi,
            (value) => value[0]!.toUpperCase() + value.slice(1).toLowerCase(),
          );
          return (
            <button
              className="quota-preview"
              data-has-quota={hasQuota}
              key={account.id}
              onClick={() => (hasQuota ? onOpen(account) : onRequests(account))}
              aria-label={`查看 ${account.name} ${hasQuota ? "账户额度" : "请求用量"}`}
            >
              <span className="quota-preview-heading">
                <span
                  className="account-avatar"
                  data-kind={account.kind}
                  data-plan={account.plan?.toLowerCase()}
                >
                  <Wallet size={22} />
                </span>
                <strong>{account.name}</strong>
                {plan && !["未提供", "unknown"].includes(plan) && (
                  <span
                    className="plan-chip"
                    data-plan={account.plan?.toLowerCase()}
                  >
                    {plan}
                  </span>
                )}
                <ArrowRight size={16} />
              </span>
              {hasQuota ? (
                <>
                  {(
                    [
                      ["5 小时", account.fiveHour],
                      ["7 天", account.sevenDay],
                    ] as const
                  ).map(([label, window]) => (
                    <QuotaPeriod
                      key={label}
                      window={window}
                      label={label}
                      asOf={asOf}
                    />
                  ))}
                  <span className="quota-preview-estimate">
                    <span>7 天预估</span>
                    <strong>
                      {estimateAmount(account.sevenDay, "usd", asOf)}
                    </strong>
                  </span>
                </>
              ) : (
                <span className="quota-preview-usage">
                  <span className="quota-preview-period-label">时间段用量</span>
                  <span>
                    <span>
                      <Activity size={16} aria-hidden="true" /> Tokens
                    </span>
                    <strong>{usage ? compact(usage.tokens) : "N/A"}</strong>
                  </span>
                  <span>
                    <span>
                      <Zap size={16} aria-hidden="true" /> 请求
                    </span>
                    <strong>
                      {usage ? usage.count.toLocaleString() : "N/A"}
                    </strong>
                  </span>
                  <span>
                    <span>
                      <Coins size={16} aria-hidden="true" /> 估算费用
                    </span>
                    <strong>{usage ? formatUsd(usage.usd) : "N/A"}</strong>
                  </span>
                  <AccountTrend
                    accountId={account.id}
                    load={readAccountTrend}
                    usdBasis={usdBasis}
                  />
                </span>
              )}
            </button>
          );
        })}
        {!accounts.length && <p className="muted">暂无账户</p>}
      </div>
    </section>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const { paused: liveUpdatesPaused } = useLiveUpdates();
  const [accountOrder, setAccountOrder] = usePreference<string[]>(
    "account-order",
    prefs.accountOrder,
    [],
  );
  const [editingAccountOrder, setEditingAccountOrder] = useState(false);
  const accountArchive = useAccountArchive();
  const [accountToHide, setAccountToHide] = useState<LedgerAccount | null>(
    null,
  );
  const [archiveView, setArchiveView] = usePreference(
    "account-archive-view",
    prefs.accountArchiveView,
    "active",
  );
  // 账户列表范围独立于请求明细；钻取请求不能反向改变账户页筛选。
  const [accountFilter, setAccountFilter] = usePreference(
    "account-filter",
    prefs.accountFilter,
    "all",
  );
  const [reportDimension, setReportDimension] = usePreference<ReportDimension>(
    "report-dimension",
    prefs.dimension,
    "day",
  );
  const [page, setPage] = useState<Page>(readPage);
  const smallScreen = useMobileLayout();
  const [mobileLayout, setMobileLayout] = usePreference(
    "mobile-layout",
    prefs.mobileLayout,
    "app",
  );
  const mobile = smallScreen && mobileLayout === "app";
  const [homeChartStyle, setHomeChartStyle] = usePreference(
    "home-chart",
    prefs.homeChart,
    "line",
  );
  useEffect(() => {
    document.documentElement.dataset.mobileLayout = mobileLayout;
  }, [mobileLayout]);
  const scrollPositions = useRef<Partial<Record<Page, number>>>({});
  useEffect(() => {
    if (!mobile) return;
    window.scrollTo(0, scrollPositions.current[page] ?? 0);
    const rememberScroll = () => {
      scrollPositions.current[page] = window.scrollY;
    };
    window.addEventListener("scroll", rememberScroll, { passive: true });
    return () => window.removeEventListener("scroll", rememberScroll);
  }, [page, mobile]);
  const [, rememberPage] = usePreference<Page>("page", prefs.page, "overview");
  useEffect(() => {
    rememberPage(page);
  }, [page, rememberPage]);
  const [filter, setFilter] = useReportFilters(
    page === "period" ? "overview" : page,
  );
  const [settledSearch, setSettledSearch] = useState({
    page,
    value: filter.search,
  });
  // 输入即时显示，只有文本搜索合并短时间内的按键；清空与日期修改不等待防抖。
  useEffect(() => {
    if (!filter.search) {
      setSettledSearch({ page, value: "" });
      return;
    }
    const timer = setTimeout(
      () => setSettledSearch({ page, value: filter.search }),
      150,
    );
    return () => clearTimeout(timer);
  }, [filter.search, page]);
  const searchForQuery =
    filter.search && settledSearch.page === page ? settledSearch.value : "";
  const searchPending = filter.search !== searchForQuery;
  const [unit, setUnit] = useScopedPreference<ReportUnit>(
    page,
    "unit",
    prefs.unit,
    page === "overview" || page === "period" ? "tokens" : "usd",
  );
  const [usdBasisOverride, setUsdBasisOverride] = useState<UsdBasis | null>(
    readStoredUsdBasis,
  );
  const [granularity, setGranularity] = useScopedPreference<Granularity>(
    page,
    "granularity",
    prefs.granularity,
    page === "overview" || page === "period" ? "hour" : "day",
  );
  const [chartStyle, setChartStyle] = useScopedPreference<ChartStyle>(
    page,
    "chart",
    prefs.chart,
    "area",
  );
  const [selected, setSelected] = useState<LedgerRecord | null>(null);
  const selectedRequestId = useRef<string | null>(null);
  const selectRecord = useCallback((record: LedgerRecord) => {
    selectedRequestId.current = record.id;
    setSelected(record);
  }, []);
  // 后台刷新可能移除原触发元素；按请求身份恢复，离开当前页时回到表格而非 body。
  const requestReturnFocus = useCallback(() => {
    return (
      [
        ...document.querySelectorAll<HTMLButtonElement>("[data-request-id]"),
      ].find(
        (button) =>
          button.dataset.requestId === selectedRequestId.current &&
          button.getClientRects().length > 0,
      ) ??
      [
        ...document.querySelectorAll<HTMLElement>(
          ".request-table-scroll, .mobile-request-list",
        ),
      ].find((element) => element.getClientRects().length > 0) ??
      document.querySelector<HTMLElement>("#main-content")
    );
  }, []);
  const [selectedAccount, setSelectedAccount] = useState<LedgerAccount | null>(
    null,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (mobile) setMobileOpen(false);
  }, [mobile]);
  const [recordPage, setRecordPage] = useState(0);
  const [recordSort, setRecordSort] = useScopedPreference<{
    id: string;
    desc: boolean;
  }>(page, "record-sort", prefs.recordSort, {
    id: "occurredAt",
    desc: true,
  });
  const [dark, setDark] = useState(() => {
    return resolveThemeDark(
      readStoredThemeMode(localStorage),
      matchMedia("(prefers-color-scheme: dark)").matches,
    );
  });
  const viewQuery: ViewQuery = {
    filter: { ...filter, search: searchForQuery },
    unit: "usd",
    granularity,
    dimension: reportDimension,
    page: page === "overview" ? 0 : recordPage,
    pageSize: page === "overview" ? 5 : 12,
    sort: recordSort.id,
    desc: recordSort.desc,
  };
  const query = useQuery({
    queryKey: ["ledger", viewQuery],
    // 新范围尚在读取时保留成功报表；更新状态区分旧结果，避免表格和图表反复卸载。
    placeholderData: keepPreviousData,
    // 刷新期间只取结果，不能让结果轮询再次触发后台重算。
    queryFn: ({ signal, client, queryKey }) => {
      const cached = client.getQueryData<LedgerView>(queryKey);
      const failed = client.getQueryState(queryKey)?.status === "error";
      return readLedger(
        viewQuery,
        undefined,
        signal,
        failed || !cached?.reportStatus?.refreshing,
      );
    },
    // 仅在报表后台重算期间读取结果；同步完成由公共同步控件使所有报表缓存失效。
    refetchInterval: (query) => {
      if (liveUpdatesPaused) return false;
      if (query.state.status === "error" || query.state.fetchFailureCount)
        return false;
      return query.state.data?.reportStatus?.refreshing ? 1000 : false;
    },
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const onHash = () => setPage(readPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    document.title = `${pages.find((item) => item.id === page)?.name} · Meterleaf`;
  }, [page]);
  const snapshot = useMemo(
    () =>
      query.data
        ? selectUsdView(
            query.data,
            usdBasisOverride ?? query.data.usdBasis ?? "subscription",
          )
        : undefined,
    [query.data, usdBasisOverride],
  );
  // 切换报表查询时保留额度摘要，不能让独立订阅窗口随报表加载状态消失。
  const [lastSnapshot, setLastSnapshot] = useState<LedgerView>();
  useEffect(() => {
    if (snapshot) setLastSnapshot(snapshot);
  }, [snapshot]);
  const quotaSnapshot =
    snapshot ??
    (lastSnapshot
      ? selectUsdView(
          lastSnapshot,
          usdBasisOverride ?? lastSnapshot.usdBasis ?? "subscription",
        )
      : undefined);
  const quotaAsOf = useQuotaClock(quotaSnapshot);
  // 首页总量不随时段筛选变化，微型趋势同样固定为全账户近 30 天。
  const homeTrendQuery: ViewQuery = {
    filter: { days: 30, model: "all", account: "all", search: "" },
    unit: "tokens",
    granularity: "day",
    dimension: "day",
    page: 0,
    pageSize: 1,
    sort: "occurredAt",
    desc: true,
  };
  const homeTrend = useQuery({
    queryKey: ["ledger", "home-trend", homeTrendQuery],
    // 固定区间也是后台报表；只轮询结果，不能重复触发重算。
    queryFn: ({ signal, client, queryKey }) => {
      const cached = client.getQueryData<LedgerView>(queryKey);
      const failed = client.getQueryState(queryKey)?.status === "error";
      return readLedger(
        homeTrendQuery,
        undefined,
        signal,
        failed || !cached?.reportStatus?.refreshing,
      );
    },
    refetchInterval: (query) => {
      if (
        liveUpdatesPaused ||
        query.state.status === "error" ||
        query.state.fetchFailureCount
      )
        return false;
      return query.state.data?.reportStatus?.refreshing ? 1000 : false;
    },
    enabled: page === "overview",
  });
  const hiddenIds = new Set(accountArchive.data?.hidden ?? []);
  const sortedAccounts = orderedAccounts(
    (quotaSnapshot?.accounts ?? []).filter(
      (account) => !hiddenIds.has(account.id),
    ),
    accountOrder,
  );
  const archivedIds = new Set(accountArchive.data?.archived ?? []);
  const visibleAccounts = sortedAccounts.filter(
    (account) =>
      archiveView === "all" ||
      archivedIds.has(account.id) === (archiveView === "archived"),
  );
  const usdBasis = usdBasisOverride ?? snapshot?.usdBasis ?? "subscription";
  useEffect(() => {
    if (!snapshot) return;
    setSelectedAccount((current) =>
      current
        ? (snapshot.accounts.find((account) => account.id === current.id) ??
          null)
        : null,
    );
  }, [snapshot]);
  useEffect(() => {
    if (!snapshot) return;
    // 分页结果不包含某条记录，不代表记录被删除；保留正在阅读的详情直到用户关闭。
    setSelected((current) =>
      current
        ? (snapshot.records.find((row) => row.id === current.id) ?? current)
        : null,
    );
  }, [snapshot]);
  const view = snapshot?.view;
  // 查询切换不撤销已知选项，否则受控选择器可能将仍有效的选择重置。
  const modelNames = quotaSnapshot?.view.models ?? [];
  const records = snapshot?.records ?? [];
  const changeRecordPage = useCallback(
    (next: number) => {
      const current = snapshot?.view;
      if (
        current &&
        current.page >= Math.max(1, Math.ceil(current.count / current.pageSize))
      ) {
        // 总量收缩后其它页的缓存也可能已过时，回页时必须重新读取。
        void queryClient.invalidateQueries({
          queryKey: ["ledger"],
          refetchType: "none",
        });
      }
      setRecordPage(next);
    },
    [queryClient, snapshot],
  );
  const emptySummary = {
    value: 0,
    hasKnown: false,
    knownRows: 0,
    incompleteRows: 0,
  };
  const unitView = view?.units[unit];
  const totalSummary = unitView?.totalSummary ?? emptySummary;
  const total = totalSummary.value;
  const usdSummary = view?.usdSummary ?? emptySummary;
  const creditsSummary = view?.creditsSummary ?? emptySummary;
  const tokenSummary = view?.tokenSummary ?? emptySummary;
  const previousUsdSummary = view?.previousUsdSummary ?? emptySummary;
  const change =
    usdSummary.hasKnown &&
    previousUsdSummary.hasKnown &&
    previousUsdSummary.value
      ? (usdSummary.value / previousUsdSummary.value - 1) * 100
      : null;
  const cacheSummary = view?.cacheSummary ?? emptySummary;
  const cacheRate = view?.cacheRate ?? null;
  const breakdown = unitView?.breakdown ?? [];
  const selectedTokenSummary = selected
    ? summarize([selected], "tokens")
    : null;
  const navigate = (next: Page) => {
    setRecordPage(0);
    location.hash = next;
    setPage(next);
    setMobileOpen(false);
  };
  const patchFilter = (patch: Partial<ReportFilter>) => {
    setRecordPage(0);
    setFilter((current) => ({ ...current, ...patch }));
  };
  const openAccountRequests = (accountId: string) => {
    // 总览钻取沿用当前时段；账户页钻取保留请求页自己的日期。
    setFilter(
      (current) => ({
        ...current,
        ...(page === "overview"
          ? {
              days: filter.days,
              dateRange: filter.dateRange,
              model: filter.model,
            }
          : { model: "all" }),
        account: accountId,
        search: "",
      }),
      "ledger",
    );
    navigate("ledger");
  };
  const nav = (
    <>
      <a
        href="#overview"
        className="brand"
        onClick={() => navigate("overview")}
      >
        <span className="brand-icon">
          <Leaf size={21} strokeWidth={1.8} />
        </span>
        <span>Meterleaf</span>
      </a>
      <nav aria-label="主导航">
        {primaryPages.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(item.id)}
            aria-current={
              page === item.id || (page === "period" && item.id === "overview")
                ? "page"
                : undefined
            }
            className={
              page === item.id || (page === "period" && item.id === "overview")
                ? "active"
                : ""
            }
          >
            <item.icon size={17} />
            <span>{item.name}</span>
            {(page === item.id ||
              (page === "period" && item.id === "overview")) && (
              <span className="nav-marker" />
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="about-link"
          aria-current={page === "settings" ? "page" : undefined}
          onClick={() => navigate("settings")}
        >
          <Info size={15} />
          关于 Meterleaf <span>{appVersion}</span>
        </button>
      </div>
    </>
  );
  return (
    <div className="app-shell" data-page={page}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          // 页内焦点跳转不能改写用于页面导航的 hash。
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳到主要内容
      </a>
      <aside className="sidebar">
        <img
          className="sidebar-art"
          src="/meterleaf-sidebar-leaves.png"
          alt=""
          width="1024"
          height="1536"
          aria-hidden="true"
        />
        {nav}
      </aside>
      <div className="main-shell">
        <header
          className={`topbar ${mobile ? "app-topbar" : ""} ${mobile && (page === "overview" || page === "period") ? "app-home-topbar" : ""}`}
        >
          <div className="topbar-title">
            <Button
              className="mobile-menu"
              variant="ghost"
              size="icon"
              aria-label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={18} />
            </Button>
            <Button
              className="mobile-about"
              variant="ghost"
              size="icon"
              aria-label="关于 Meterleaf"
              title="关于 Meterleaf"
              onClick={() => navigate("settings")}
            >
              <Info size={20} />
            </Button>
            {mobile && (page === "overview" || page === "period") ? (
              <a
                className="mobile-brand"
                href="#overview"
                aria-label="Meterleaf 首页"
              >
                <img src="/favicon.svg" width="30" height="30" alt="" />
                <span>Meterleaf</span>
                <h1 id="page-title" className="sr-only">
                  用量总览
                </h1>
              </a>
            ) : mobile ? (
              <h1 id="page-title">{pages.find((p) => p.id === page)?.name}</h1>
            ) : (
              <>
                <a
                  className="mobile-brand"
                  href="#overview"
                  aria-label="Meterleaf 首页"
                >
                  <span>
                    Meterleaf
                    <small>{pages.find((p) => p.id === page)?.name}</small>
                  </span>
                </a>
                <h1 id="page-title">
                  {pages.find((p) => p.id === page)?.name}
                </h1>
                <p className="topbar-subtitle">
                  {page === "accounts"
                    ? "管理账户的使用情况、额度限制与费用预估"
                    : page === "reports"
                      ? "多维统计分析，洞察用量与成本"
                      : page === "ledger"
                        ? "每一条请求，都清晰可查"
                        : page === "settings"
                          ? "Meterleaf · 独立 AI 用量账本"
                          : "实时掌握 API 使用情况，洞察成本与性能"}
                </p>
              </>
            )}
          </div>
          <div className="topbar-actions">
            <span className="timezone-label">Asia/Shanghai</span>
            {import.meta.env.VITE_METERLEAF_DEMO !== "true" && (
              <div className="app-sync">
                <SyncControl compact={mobile} />
              </div>
            )}
            {snapshot?.mode === "demo" && (
              <span className="demo-badge">演示数据</span>
            )}
            {page !== "settings" && (
              <ThemeControl
                hidden={mobile}
                onResolvedChange={setDark}
                mobileLayout={mobileLayout}
                onMobileLayoutChange={setMobileLayout}
              />
            )}
          </div>
        </header>
        <main
          id="main-content"
          aria-labelledby="page-title"
          tabIndex={-1}
          aria-busy={
            searchPending ||
            query.isFetching ||
            (!query.isError && snapshot?.reportStatus?.refreshing) ||
            false
          }
        >
          {(page === "overview" || page === "period") && (
            <nav className="overview-tabs" aria-label="总览视图">
              <button
                aria-current={page === "overview" ? "page" : undefined}
                onClick={() => navigate("overview")}
              >
                累计总览
              </button>
              <button
                aria-current={page === "period" ? "page" : undefined}
                onClick={() => navigate("period")}
              >
                时间段用量
              </button>
            </nav>
          )}
          {mobile && page === "overview" && quotaSnapshot && (
            <MobileHome
              snapshot={quotaSnapshot}
              accounts={sortedAccounts.filter(
                (account) => !archivedIds.has(account.id),
              )}
              asOf={quotaAsOf}
              trendPoints={homeTrend.data?.view.units.tokens.points ?? []}
              onAccount={setSelectedAccount}
              onRequests={(account) => openAccountRequests(account.id)}
              onAllAccounts={() => navigate("accounts")}
              chartStyle={homeChartStyle}
              onChartStyleChange={(value) => {
                if (value !== "pie") setHomeChartStyle(value);
              }}
            />
          )}
          {page === "settings" && (
            <AboutPage
              mode={snapshot?.mode}
              usdBasis={usdBasis}
              onResolvedChange={setDark}
              mobileLayout={mobileLayout}
              onMobileLayoutChange={setMobileLayout}
            />
          )}
          {!mobile && page === "overview" && quotaSnapshot && (
            <>
              {quotaSnapshot.lifetimeTotals && (
                <section className="lifetime-summary" aria-label="历史累计">
                  <div className="lifetime-heading">
                    <h2>历史累计</h2>
                    {quotaSnapshot.lifetimeTotals.from && (
                      <span>
                        {localTime(quotaSnapshot.lifetimeTotals.from, {
                          year: "numeric",
                        })}{" "}
                        起
                      </span>
                    )}
                  </div>
                  <dl>
                    <div>
                      <dt>Tokens</dt>
                      <dd>
                        {compact(quotaSnapshot.lifetimeTotals.tokens.total)}
                      </dd>
                    </div>
                    <div>
                      <dt>估算费用</dt>
                      <dd>{formatUsd(quotaSnapshot.lifetimeTotals.usd)}</dd>
                    </div>
                    <div>
                      <dt>请求</dt>
                      <dd>
                        {quotaSnapshot.lifetimeTotals.count.toLocaleString()}
                      </dd>
                    </div>
                  </dl>
                </section>
              )}
              <OverviewQuotas
                accounts={sortedAccounts.filter(
                  (account) => !archivedIds.has(account.id),
                )}
                asOf={quotaAsOf}
                accountUsage={snapshot?.view.accountUsage}
                usdBasis={usdBasis}
                onOpen={setSelectedAccount}
                onAll={() => navigate("accounts")}
                onRequests={(account) => {
                  openAccountRequests(account.id);
                }}
              />
              <section
                className="overview-history-trend"
                aria-label="近30天累计趋势"
              >
                <div className="section-heading">
                  <h2>Tokens 趋势</h2>
                  <span className="muted">近 30 天 · 按天汇总</span>
                  <ChartStyleControl
                    value={homeChartStyle}
                    onChange={(value) => {
                      if (value !== "pie") setHomeChartStyle(value);
                    }}
                    allowPie={false}
                  />
                </div>
                <Suspense
                  fallback={
                    <div className="usage-chart loading-panel">
                      正在读取趋势…
                    </div>
                  }
                >
                  <UsageChart
                    points={homeTrend.data?.view.units.tokens.points ?? []}
                    breakdown={[]}
                    unit="tokens"
                    granularity="day"
                    chartStyle={homeChartStyle}
                    dark={dark}
                  />
                </Suspense>
              </section>
            </>
          )}
          {page !== "settings" && page !== "overview" && (
            <MobileFilters
              enabled={mobile}
              page={page}
              presets={
                page === "period" ? (
                  <div className="mobile-period-presets">
                    {([1, 7, 30] as const).map((days) => (
                      <button
                        key={days}
                        aria-pressed={!filter.dateRange && filter.days === days}
                        onClick={() =>
                          patchFilter({ days, dateRange: undefined })
                        }
                      >
                        {days === 1 ? "近 24 小时" : `近 ${days} 天`}
                      </button>
                    ))}
                    <DateRangePicker
                      value={filter}
                      asOf={snapshot?.asOf ?? new Date().toISOString()}
                      onChange={patchFilter}
                    />
                  </div>
                ) : undefined
              }
              primary={
                <>
                  {page !== "accounts" && (
                    <FilterSelect
                      label="快捷模型筛选"
                      value={filter.model}
                      onChange={(model) => patchFilter({ model })}
                      icon={<Layers3 size={15} />}
                      options={[
                        { value: "all", label: "全部模型" },
                        ...modelNames.map((model) => ({
                          value: model,
                          label: modelLabel(model),
                        })),
                      ]}
                    />
                  )}
                  {(page === "accounts" || page === "period") && (
                    <FilterSelect
                      label="快捷账户筛选"
                      value={
                        page === "accounts" ? accountFilter : filter.account
                      }
                      onChange={(account) =>
                        page === "accounts"
                          ? setAccountFilter(account)
                          : patchFilter({ account })
                      }
                      icon={<Wallet size={15} />}
                      options={[
                        { value: "all", label: "全部账户" },
                        ...(quotaSnapshot?.accounts.map((account) => ({
                          value: account.id,
                          label: account.name,
                        })) ?? []),
                      ]}
                    />
                  )}
                  {page === "accounts" && (
                    <FilterSelect
                      label="快捷归档状态"
                      value={archiveView}
                      onChange={(value) =>
                        setArchiveView(prefs.accountArchiveView.parse(value))
                      }
                      options={[
                        { value: "active", label: "使用中" },
                        { value: "archived", label: "已归档" },
                        { value: "all", label: "全部状态" },
                      ]}
                    />
                  )}
                </>
              }
              summary={[
                page !== "accounts" && filter.model !== "all"
                  ? modelLabel(filter.model)
                  : null,
                quotaSnapshot?.accounts.find(
                  (account) =>
                    account.id ===
                    (page === "accounts" ? accountFilter : filter.account),
                )?.name ?? "全部账户",
                usdBasis === "subscription" ? "订阅等价" : "标准 API",
                page === "accounts"
                  ? { active: "使用中", archived: "已归档", all: "全部状态" }[
                      archiveView
                    ]
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              date={
                page !== "accounts" ? (
                  <DateRangePicker
                    value={filter}
                    asOf={snapshot?.asOf ?? new Date().toISOString()}
                    onChange={patchFilter}
                  />
                ) : undefined
              }
            >
              {page !== "accounts" && (
                <FilterSelect
                  label="模型筛选"
                  value={filter.model}
                  onChange={(model) => patchFilter({ model })}
                  icon={<Layers3 size={15} />}
                  options={[
                    { value: "all", label: "全部模型" },
                    ...modelNames.map((model) => ({
                      value: model,
                      label: modelLabel(model),
                    })),
                  ]}
                />
              )}
              <FilterSelect
                label="账户筛选"
                value={page === "accounts" ? accountFilter : filter.account}
                onChange={(account) =>
                  page === "accounts"
                    ? setAccountFilter(account)
                    : patchFilter({ account })
                }
                icon={<Wallet size={15} />}
                options={[
                  { value: "all", label: "全部账户" },
                  ...(quotaSnapshot?.accounts.map((account) => ({
                    value: account.id,
                    label: account.name,
                  })) ?? []),
                ]}
              />
              {page === "accounts" && (
                <FilterSelect
                  label="归档状态"
                  value={archiveView}
                  onChange={(value) =>
                    setArchiveView(prefs.accountArchiveView.parse(value))
                  }
                  options={[
                    { value: "active", label: "使用中" },
                    { value: "archived", label: "已归档" },
                    { value: "all", label: "全部状态" },
                  ]}
                />
              )}
              <Segmented
                label="USD 估算口径"
                value={usdBasis}
                onChange={(basis) => {
                  setUsdBasisOverride(basis);
                  localStorage.setItem("meterleaf-usd-basis", basis);
                }}
                options={[
                  { value: "subscription", label: "订阅等价" },
                  { value: "api", label: "标准 API" },
                ]}
              />
              {mobile && page === "period" && (
                <>
                  <Segmented
                    label="时间粒度"
                    value={granularity}
                    onChange={setGranularity}
                    options={[
                      { value: "hour", label: "时" },
                      { value: "day", label: "天" },
                      { value: "week", label: "周" },
                    ]}
                  />
                </>
              )}
              {((page === "accounts" ? accountFilter : filter.account) !==
                "all" ||
                (page !== "accounts" &&
                  (filter.model !== "all" ||
                    filter.search ||
                    filter.dateRange))) && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="清除筛选"
                  title="清除筛选"
                  onClick={() =>
                    page === "accounts"
                      ? setAccountFilter("all")
                      : setFilter(initialFilter)
                  }
                >
                  <X size={14} />
                </Button>
              )}
            </MobileFilters>
          )}
          {page === "accounts" &&
            (accountArchive.isError || accountArchive.mutation.isError) && (
              <p role="alert" className="sync-warning">
                {accountArchive.mutation.error?.message ??
                  "账户归档状态读取失败，请刷新重试"}
              </p>
            )}
          {snapshot && (query.isError || snapshot.reportStatus?.lastError) && (
            <div role="alert" className="report-error sync-warning">
              <span>
                {query.isError
                  ? `刷新失败（${query.error instanceof Error ? query.error.message : "报表读取失败"}），当前显示上次成功的数据。`
                  : "刷新失败，当前显示上次成功的数据。"}
              </span>
              <Button
                variant="ghost"
                disabled={
                  query.isFetching ||
                  (!query.isError && snapshot.reportStatus?.refreshing)
                }
                onClick={() => void query.refetch()}
              >
                <RefreshCw size={14} aria-hidden="true" />
                重试
              </Button>
            </div>
          )}
          {query.isPending ? (
            <div className="loading-panel" role="status">
              正在读取账本…
            </div>
          ) : !snapshot ? (
            <div className="empty-state" role="alert">
              <Database />
              <h2>账本读取失败</h2>
              <Button onClick={() => void query.refetch()}>重新读取</Button>
            </div>
          ) : (
            <>
              {page === "period" && (
                <div className={mobile ? "app-period" : "desktop-period"}>
                  {mobile && <h2 className="app-metrics-heading">关键指标</h2>}
                  <section className="metrics" aria-label="用量摘要">
                    <div className="metric primary-metric">
                      <span className="metric-symbol" aria-hidden="true">
                        <Leaf />
                      </span>
                      <div className="metric-label">估算费用</div>
                      <div className="metric-value">
                        {amount(
                          usdSummary.hasKnown ? usdSummary.value : null,
                          "usd",
                        )}
                      </div>
                      <div className="metric-foot">
                        <span
                          className={
                            change !== null && change > 0
                              ? "change higher"
                              : "change"
                          }
                        >
                          {change !== null ? (
                            <>
                              {change > 0 ? (
                                <ArrowUpRight size={12} />
                              ) : (
                                <ArrowDownLeft size={12} />
                              )}
                              {Math.abs(change).toFixed(1)}%
                            </>
                          ) : (
                            "暂无对比"
                          )}
                        </span>
                        <span>环比</span>
                      </div>
                      <MiniTrend
                        points={view?.units.usd.points ?? []}
                        metric="usd"
                        tone="teal"
                        label="所选时段估算费用趋势"
                        hideCaption
                      />
                    </div>
                    <div className="metric">
                      <span className="metric-symbol" aria-hidden="true">
                        <Layers3 />
                      </span>
                      <div className="metric-label">
                        订阅 Credits <Coins size={14} />
                      </div>
                      <div className="metric-value">
                        {amount(
                          creditsSummary.hasKnown ? creditsSummary.value : null,
                          "credits",
                        )}
                      </div>
                      <div className="metric-foot">
                        {creditsSummary.incompleteRows ? "已计价点数" : ""}
                      </div>
                      <MiniTrend
                        points={view?.units.credits.points ?? []}
                        metric="credits"
                        tone="blue"
                        label="所选时段 Credits 趋势"
                        hideCaption
                      />
                    </div>
                    <div className="metric">
                      <span className="metric-symbol" aria-hidden="true">
                        <Coins />
                      </span>
                      <div className="metric-label">
                        Tokens 总量 <Activity size={14} />
                      </div>
                      <div className="metric-value">
                        {tokenSummary.hasKnown
                          ? compact(tokenSummary.value)
                          : "N/A"}
                      </div>
                      <div className="metric-foot">
                        <span>
                          {(view?.count ?? 0).toLocaleString()} 次请求
                        </span>
                        {tokenSummary.incompleteRows > 0 && (
                          <span>{tokenSummary.incompleteRows} 条不完整</span>
                        )}
                      </div>
                      <MiniTrend
                        points={view?.units.tokens.points ?? []}
                        metric="tokens"
                        tone="purple"
                        label="所选时段 Tokens 趋势"
                        hideCaption
                      />
                    </div>
                    <div className="metric">
                      <span className="metric-symbol" aria-hidden="true">
                        <Activity />
                      </span>
                      <div className="metric-label">
                        缓存命中率 <Zap size={14} />
                      </div>
                      <div className="metric-value">
                        {cacheRate === null
                          ? "无完整样本"
                          : cacheRate.toFixed(1)}
                        {cacheRate !== null && <small>%</small>}
                      </div>
                      <div className="metric-foot">
                        <span className="cache-text">
                          {cacheSummary.hasKnown
                            ? compact(cacheSummary.value)
                            : "无已知值"}
                        </span>
                        <span>缓存读取 tokens</span>
                        {cacheSummary.incompleteRows > 0 && (
                          <span>{cacheSummary.incompleteRows} 条缺值</span>
                        )}
                      </div>
                      {cacheRate !== null && (
                        <div className="cache-rate-track" aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.min(100, Math.max(0, cacheRate))}%`,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </section>
                  <section className="analysis-section">
                    <div className="trend-panel">
                      <div className="section-heading">
                        <div>
                          <h2>
                            {chartStyle === "pie" ? "消耗占比" : "消耗趋势"}
                          </h2>
                          <span className="muted">
                            {chartStyle === "pie"
                              ? "按模型汇总"
                              : granularity === "week"
                                ? "自然周，周一起始"
                                : `按${granularity === "hour" ? "小时" : "天"}汇总`}
                          </span>
                        </div>
                        {smallScreen ? (
                          <FilterSelect
                            label="计量单位"
                            value={unit}
                            onChange={(value) =>
                              setUnit(prefs.unit.parse(value))
                            }
                            options={[
                              { value: "usd", label: "USD" },
                              { value: "credits", label: "Credits" },
                              { value: "tokens", label: "Tokens" },
                            ]}
                          />
                        ) : (
                          <Segmented
                            label="计量单位"
                            value={unit}
                            onChange={setUnit}
                            options={[
                              { value: "usd", label: "USD" },
                              { value: "credits", label: "Credits" },
                              { value: "tokens", label: "Tokens" },
                            ]}
                          />
                        )}
                      </div>
                      <div className="chart-toolbar">
                        <span>
                          <i className={`chart-series-symbol ${chartStyle}`} />
                          {unit === "usd"
                            ? `USD 估算 · ${usdBasis === "subscription" ? "订阅等价" : "标准 API"}`
                            : unit === "credits"
                              ? "Credits 独立估值"
                              : "总 tokens"}
                        </span>
                        <div className="chart-controls">
                          <ChartStyleControl
                            value={chartStyle}
                            onChange={setChartStyle}
                          />
                          {chartStyle !== "pie" && (
                            <Segmented
                              label="时间粒度"
                              value={granularity}
                              onChange={setGranularity}
                              options={[
                                { value: "hour", label: "时" },
                                { value: "day", label: "天" },
                                { value: "week", label: "周" },
                              ]}
                            />
                          )}
                        </div>
                      </div>
                      {view?.count ? (
                        <Suspense
                          fallback={
                            <div className="usage-chart loading-panel">
                              正在加载图表…
                            </div>
                          }
                        >
                          <UsageChart
                            points={unitView?.points ?? []}
                            breakdown={breakdown}
                            unit={unit}
                            granularity={granularity}
                            chartStyle={chartStyle}
                            dark={dark}
                          />
                        </Suspense>
                      ) : (
                        <div className="usage-chart empty-chart">
                          <Search size={24} />
                          <span>所选范围内暂无用量</span>
                        </div>
                      )}
                    </div>
                    <div className="model-panel">
                      <div className="section-heading">
                        <h2>模型分布</h2>
                        <span className="muted">
                          {unit === "usd"
                            ? "USD"
                            : unit === "credits"
                              ? "Credits"
                              : "Tokens"}
                        </span>
                      </div>
                      <div className="model-donut overview-donut">
                        <Suspense fallback={<div className="usage-chart" />}>
                          <UsageChart
                            points={[]}
                            breakdown={breakdown}
                            unit={unit}
                            granularity={granularity}
                            chartStyle="pie"
                            donut
                            dark={dark}
                          />
                        </Suspense>
                        <div className="model-donut-total" aria-hidden="true">
                          <span>
                            {unit === "tokens"
                              ? "总 Tokens"
                              : unit === "usd"
                                ? "估算费用"
                                : "Credits"}
                          </span>
                          <strong>
                            {amount(totalSummary.hasKnown ? total : null, unit)}
                          </strong>
                        </div>
                      </div>
                      <div className="model-breakdown">
                        {breakdown
                          .filter((item) => item.count > 0)
                          .map((item) => (
                            <button
                              key={item.model}
                              onClick={() =>
                                patchFilter({
                                  model:
                                    filter.model === item.model
                                      ? "all"
                                      : item.model,
                                })
                              }
                            >
                              <div>
                                <span className="model-label">
                                  <i
                                    style={{
                                      background: modelColor(item.model),
                                    }}
                                  />
                                  {modelLabel(item.model)}
                                </span>
                                <strong>
                                  {amount(
                                    item.summary.hasKnown
                                      ? item.summary.value
                                      : null,
                                    unit,
                                  )}
                                </strong>
                              </div>
                              <div>
                                <span>
                                  {item.count.toLocaleString()} 次请求
                                </span>
                                <span>
                                  {totalSummary.hasKnown &&
                                  item.summary.hasKnown
                                    ? `${((item.summary.value / total) * 100).toFixed(1)}%`
                                    : "无占比"}
                                </span>
                              </div>
                            </button>
                          ))}
                      </div>
                    </div>
                  </section>
                </div>
              )}
              {page === "accounts" && (
                <section className="accounts-section" aria-label="账户额度列表">
                  <div className="account-actions-heading">
                    <h2>
                      账户{" "}
                      <span>
                        {
                          visibleAccounts.filter(
                            (account) =>
                              accountFilter === "all" ||
                              account.id === accountFilter,
                          ).length
                        }
                      </span>
                    </h2>
                    <Button
                      variant="ghost"
                      aria-label={
                        editingAccountOrder ? "完成账户排序" : "调整账户顺序"
                      }
                      aria-pressed={editingAccountOrder}
                      onClick={() => setEditingAccountOrder((value) => !value)}
                    >
                      {editingAccountOrder ? (
                        <Check size={16} />
                      ) : (
                        <ArrowUpDown size={16} />
                      )}
                      {editingAccountOrder ? "完成" : "排序"}
                    </Button>
                  </div>
                  <div className="account-list-heading" aria-hidden="true">
                    <span>账户</span>
                    <span>5 小时</span>
                    <span>7 天</span>
                    <span>7 天预估</span>
                    <span />
                  </div>
                  <div>
                    {visibleAccounts
                      .filter(
                        (a) =>
                          accountFilter === "all" || a.id === accountFilter,
                      )
                      .map((account) => (
                        <div
                          className="account-list-item"
                          key={account.id}
                          data-account-id={account.id}
                          data-manageable
                        >
                          <AccountRow
                            account={account}
                            asOf={quotaAsOf}
                            compactView={mobile}
                            archived={archivedIds.has(account.id)}
                            usdBasis={usdBasis}
                            compactUsage={smallScreen}
                            usage={snapshot.view.accountUsage?.[account.id]}
                            onOpen={() => {
                              if (account.fiveHour || account.sevenDay)
                                setSelectedAccount(account);
                              else {
                                openAccountRequests(account.id);
                              }
                            }}
                          />
                          {editingAccountOrder && (
                            <div
                              className="account-order-actions"
                              aria-label={`${account.name} 排序`}
                            >
                              {editingAccountOrder &&
                                ([-1, 1] as const).map((direction) => (
                                  <Button
                                    key={direction}
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`${direction === -1 ? "上移" : "下移"} ${account.name}`}
                                    title={
                                      direction === -1 ? "上移账户" : "下移账户"
                                    }
                                    disabled={
                                      sortedAccounts.indexOf(account) +
                                        direction <
                                        0 ||
                                      sortedAccounts.indexOf(account) +
                                        direction >=
                                        sortedAccounts.length
                                    }
                                    onClick={() =>
                                      setAccountOrder(
                                        moveAccount(
                                          sortedAccounts.map(
                                            (value) => value.id,
                                          ),
                                          account.id,
                                          direction,
                                        ),
                                      )
                                    }
                                  >
                                    {direction === -1 ? (
                                      <ArrowUp size={18} />
                                    ) : (
                                      <ArrowDown size={18} />
                                    )}
                                  </Button>
                                ))}
                            </div>
                          )}
                          {
                            <ActionMenu.Root>
                              <ActionMenu.Trigger
                                className="account-menu-trigger"
                                render={<Button variant="ghost" size="icon" />}
                                aria-label={`${account.name} 账户操作`}
                                title="账户操作"
                              >
                                <MoreHorizontal size={18} />
                              </ActionMenu.Trigger>
                              <ActionMenu.Portal>
                                <ActionMenu.Positioner
                                  side="bottom"
                                  align="end"
                                  sideOffset={4}
                                  className="account-menu-positioner"
                                >
                                  <ActionMenu.Popup className="account-menu-popup">
                                    {!accountArchive.data?.writable && (
                                      <p className="account-readonly-note">
                                        {accountArchive.isError
                                          ? "账户状态读取失败"
                                          : accountArchive.isPending
                                            ? "正在读取账户状态"
                                            : "只读数据，无法修改账户"}
                                      </p>
                                    )}
                                    <ActionMenu.Item
                                      className="account-menu-item"
                                      disabled={
                                        !accountArchive.data?.writable ||
                                        accountArchive.mutation.isPending
                                      }
                                      onClick={() =>
                                        accountArchive.mutation.mutate({
                                          id: account.id,
                                          archived: !archivedIds.has(
                                            account.id,
                                          ),
                                        })
                                      }
                                    >
                                      {archivedIds.has(account.id) ? (
                                        <ArchiveRestore size={16} />
                                      ) : (
                                        <Archive size={16} />
                                      )}
                                      {archivedIds.has(account.id)
                                        ? "恢复账户"
                                        : "归档账户"}
                                    </ActionMenu.Item>
                                    <ActionMenu.Item
                                      className="account-menu-item"
                                      disabled={
                                        !accountArchive.data?.writable ||
                                        accountArchive.mutation.isPending
                                      }
                                      onClick={() => setAccountToHide(account)}
                                    >
                                      <Trash2 size={16} />
                                      删除账户
                                    </ActionMenu.Item>
                                  </ActionMenu.Popup>
                                </ActionMenu.Positioner>
                              </ActionMenu.Portal>
                            </ActionMenu.Root>
                          }
                        </div>
                      ))}
                    {!visibleAccounts.length && (
                      <p className="empty-chart">
                        {archiveView === "archived"
                          ? "暂无归档账户"
                          : "暂无账户"}
                      </p>
                    )}
                  </div>
                </section>
              )}
              {page === "reports" && (
                <>
                  {view && (
                    <ModelDistribution
                      view={view}
                      dark={dark}
                      onModel={(model) => {
                        setFilter({ ...filter, model, search: "" }, "ledger");
                        navigate("ledger");
                      }}
                    />
                  )}
                  <ReportTable
                    data={view?.reportRows ?? []}
                    count={view?.count ?? 0}
                    accounts={snapshot.accounts}
                    dimension={reportDimension}
                    onDimension={setReportDimension}
                    usdBasis={usdBasis}
                  />
                </>
              )}
              {page === "ledger" && (
                <LedgerTable
                  key={page}
                  records={records}
                  total={view?.count ?? 0}
                  pageIndex={view?.page ?? 0}
                  onPage={changeRecordPage}
                  sorting={recordSort}
                  onSorting={(next) => {
                    setRecordPage(0);
                    setRecordSort(next);
                  }}
                  accounts={snapshot.accounts}
                  compactView={false}
                  search={filter.search}
                  onSearch={(search) => patchFilter({ search })}
                  onSelect={selectRecord}
                  usdBasis={usdBasis}
                />
              )}
            </>
          )}
        </main>
      </div>
      <AlertDialog.Root
        open={!!accountToHide}
        onOpenChange={(open) => {
          if (!open) setAccountToHide(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="account-confirm-backdrop" />
          <AlertDialog.Popup className="account-confirm">
            <AlertDialog.Title>删除账户</AlertDialog.Title>
            <AlertDialog.Description>
              从列表移除 {accountToHide?.name}，历史请求和统计仍保留。
            </AlertDialog.Description>
            {accountArchive.mutation.isError && (
              <p role="alert">{accountArchive.mutation.error.message}</p>
            )}
            <div>
              <AlertDialog.Close render={<Button variant="outline" />}>
                取消
              </AlertDialog.Close>
              <Button
                disabled={accountArchive.mutation.isPending}
                onClick={() => {
                  if (accountToHide)
                    accountArchive.mutation.mutate(
                      { id: accountToHide.id, hidden: true },
                      { onSuccess: () => setAccountToHide(null) },
                    );
                }}
              >
                <Trash2 size={16} />
                删除
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <nav className="mobile-tabbar" aria-label="底部导航">
        {[
          { ...primaryPages[0], icon: Home },
          ...primaryPages.slice(1),
          pages[5],
        ].map((item, index) => (
          <button
            key={item.id}
            aria-label={item.name}
            aria-current={
              page === item.id || (page === "period" && item.id === "overview")
                ? "page"
                : undefined
            }
            className={
              page === item.id || (page === "period" && item.id === "overview")
                ? "active"
                : ""
            }
            onClick={() => navigate(item.id)}
          >
            <item.icon size={22} strokeWidth={page === item.id ? 2.2 : 1.8} />
            <span>{["首页", "账户", "统计", "明细", "关于"][index]}</span>
          </button>
        ))}
      </nav>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="mobile-nav-sheet">
          <SheetHeader className="sr-only">
            <SheetTitle>导航</SheetTitle>
            <SheetDescription>账本视图</SheetDescription>
          </SheetHeader>
          {nav}
        </SheetContent>
      </Sheet>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          side={mobile ? "bottom" : "right"}
          className="detail-sheet"
          finalFocus={requestReturnFocus}
        >
          <SheetHeader>
            <span className="detail-eyebrow">
              <FileText size={16} />
              请求明细
            </span>
            <SheetTitle>
              {selected ? modelLabel(selected.model) : "请求"}
            </SheetTitle>
            <SheetDescription className="sr-only">
              请求用量与估算费用
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="detail-body">
              <div className="detail-amount">
                {formatUsd(selected.usd)}
                <span>
                  USD 估算 ·{" "}
                  {usdBasis === "subscription" ? "订阅等价" : "标准 API"}
                </span>
              </div>
              <dl className="details-list">
                <dt>时间</dt>
                <dd>
                  {localTime(selected.occurredAt, {
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                  })}
                </dd>
                <dt>账户</dt>
                <dd>
                  {snapshot?.accounts.find((a) => a.id === selected.accountId)
                    ?.name ?? selected.accountId}
                </dd>
                {selected.details && (
                  <>
                    <dt>请求模型</dt>
                    <dd>{selected.details.requestedModel ?? "未提供"}</dd>
                    {selected.details.sentModel !==
                      selected.details.requestedModel && (
                      <>
                        <dt>发送模型</dt>
                        <dd>{selected.details.sentModel ?? "未提供"}</dd>
                      </>
                    )}
                    {selected.details.responseModel && (
                      <>
                        <dt>响应模型</dt>
                        <dd>{selected.details.responseModel}</dd>
                      </>
                    )}
                    <dt>推理强度</dt>
                    <dd>
                      {selected.details.requestedReasoningEffort ??
                        selected.details.reasoningEffort ??
                        "未提供"}
                    </dd>
                    {selected.details.requestedReasoningEffort &&
                      selected.details.reasoningEffort &&
                      selected.details.requestedReasoningEffort !==
                        selected.details.reasoningEffort && (
                        <>
                          <dt>实际推理强度</dt>
                          <dd>{selected.details.reasoningEffort}</dd>
                        </>
                      )}
                    {selected.details.firstTokenMs !== null && (
                      <>
                        <dt>首 token 延迟</dt>
                        <dd>
                          {selected.details.firstTokenMs.toLocaleString()} ms
                        </dd>
                      </>
                    )}
                    {selected.details.durationMs !== null && (
                      <>
                        <dt>总耗时</dt>
                        <dd>
                          {selected.details.durationMs.toLocaleString()} ms
                        </dd>
                      </>
                    )}
                  </>
                )}
                <dt>速度档</dt>
                <dd>
                  {selected.tier === "unknown"
                    ? "未知"
                    : selected.tier === "priority"
                      ? "Priority"
                      : selected.tier === "flex"
                        ? "Flex"
                        : "Standard"}
                </dd>
                <dt>USD 估值依据</dt>
                <dd>{chargeBasisLabel(selected.valuation?.usd)}</dd>
                {selected.valuation?.usd.amount === null && (
                  <>
                    <dt>USD 未计价原因</dt>
                    <dd>{chargeReasonLabel(selected.valuation.usd)}</dd>
                  </>
                )}
                <dt>另一套 USD 参考</dt>
                <dd>
                  {formatUsd(
                    (usdBasis === "api"
                      ? selected.valuation?.subscriptionUsd
                      : selected.valuation?.apiUsd
                    )?.amount ?? null,
                  )}
                  <span className="inline-badge">
                    {usdBasis === "api" ? "订阅等价" : "标准 API"}
                  </span>
                </dd>
                <dt>Credits 估值依据</dt>
                <dd>{chargeBasisLabel(selected.valuation?.credits)}</dd>
                <dt>费率版本</dt>
                <dd>{selected.priceVersion}</dd>
                <dt>来源 ID</dt>
                <dd>{selected.sourceId ?? "未提供"}</dd>
                <dt>源记录 ID</dt>
                <dd>{selected.sourceRecordId ?? "未提供"}</dd>
                <dt>网关成本</dt>
                <dd>{formatUsd(selected.gatewayCost ?? null)}</dd>
                <dt>网关计费</dt>
                <dd>{formatUsd(selected.gatewayBilled ?? null)}</dd>
              </dl>
              <h3>Token 拆分</h3>
              <dl className="details-list tokens-list">
                <dt>普通输入</dt>
                <dd>
                  {selected.input === null
                    ? "未采集"
                    : selected.input.toLocaleString()}
                </dd>
                <dt>缓存读取</dt>
                <dd className="cache-text">
                  {selected.cacheRead === null
                    ? "未采集"
                    : selected.cacheRead.toLocaleString()}
                </dd>
                <dt>缓存写入</dt>
                <dd>
                  {selected.cacheWrite === null
                    ? "未采集"
                    : selected.cacheWrite.toLocaleString()}
                </dd>
                <dt>输出</dt>
                <dd>
                  {selected.output === null
                    ? "未采集"
                    : selected.output.toLocaleString()}
                </dd>
                <dt>总计</dt>
                <dd>
                  <strong>
                    {selectedTokenSummary?.hasKnown
                      ? `${compact(selectedTokenSummary.value)}${selectedTokenSummary.incompleteRows ? "（已知小计，字段不完整）" : ""}`
                      : "无已知小计"}
                  </strong>
                </dd>
              </dl>
              <div className="detail-credit">
                <Coins size={18} />
                <span>Credits 独立估值</span>
                <strong>{formatCredits(selected.credits)}</strong>
              </div>
              {snapshot?.mode === "demo" && (
                <span className="detail-footnote">
                  演示数据，不代表真实扣费。
                </span>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={!!selectedAccount}
        onOpenChange={(open) => {
          if (!open) setSelectedAccount(null);
        }}
      >
        <SheetContent
          side={mobile ? "bottom" : "right"}
          className="detail-sheet"
        >
          <SheetHeader>
            <span className="detail-eyebrow">
              <Wallet size={16} />
              账户额度
            </span>
            <SheetTitle>{selectedAccount?.name}</SheetTitle>
            <SheetDescription>
              {selectedAccount?.plan?.replace(
                /\b(pro|plus)\b/gi,
                (value) =>
                  value[0]!.toUpperCase() + value.slice(1).toLowerCase(),
              )}
            </SheetDescription>
          </SheetHeader>
          {selectedAccount && snapshot && (
            <div className="detail-body">
              {selectedAccount.fiveHour || selectedAccount.sevenDay ? (
                <>
                  <div className="account-detail-windows">
                    <QuotaBar
                      window={selectedAccount.fiveHour}
                      label="5 小时窗口"
                      asOf={quotaAsOf}
                    />
                    <QuotaBar
                      window={selectedAccount.sevenDay}
                      label="7 天窗口"
                      asOf={quotaAsOf}
                    />
                  </div>
                  <dl className="details-list">
                    <dt>快照时间</dt>
                    <dd>
                      {localTime(selectedAccount.sampledAt, {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </dd>
                    <dt>七天重置</dt>
                    <dd>
                      {!selectedAccount.sevenDay
                        ? "N/A"
                        : quotaState(selectedAccount.sevenDay, quotaAsOf) ===
                            "expired"
                          ? "N/A"
                          : selectedAccount.sevenDay.resetsAt
                            ? localTime(selectedAccount.sevenDay.resetsAt, {
                                hour: "2-digit",
                                minute: "2-digit",
                                hour12: false,
                              })
                            : "N/A"}
                    </dd>
                    <dt>5 小时周期 USD</dt>
                    <dd>
                      {windowAmount(selectedAccount.fiveHour, "usd", quotaAsOf)}
                    </dd>
                    <dt>5 小时周期 Credits</dt>
                    <dd>
                      {windowAmount(
                        selectedAccount.fiveHour,
                        "credits",
                        quotaAsOf,
                      )}
                    </dd>
                    <dt>7 天周期 USD</dt>
                    <dd>
                      {windowAmount(selectedAccount.sevenDay, "usd", quotaAsOf)}
                    </dd>
                    <dt>7 天周期 Credits</dt>
                    <dd>
                      {windowAmount(
                        selectedAccount.sevenDay,
                        "credits",
                        quotaAsOf,
                      )}
                    </dd>
                    <dt>预计每周额度（美元）</dt>
                    <dd>
                      {estimateAmount(
                        selectedAccount.sevenDay,
                        "usd",
                        quotaAsOf,
                      )}
                    </dd>
                    <dt>预计每周额度（点数）</dt>
                    <dd>
                      {estimateAmount(
                        selectedAccount.sevenDay,
                        "credits",
                        quotaAsOf,
                      )}
                    </dd>
                  </dl>
                </>
              ) : (
                <p>上游尚未提供额度快照。</p>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  openAccountRequests(selectedAccount.id);
                  setSelectedAccount(null);
                }}
              >
                查看账户请求 <ArrowRight size={15} />
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
