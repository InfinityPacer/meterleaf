import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import type { LedgerView, UnitView } from "../../shared/ledger-view";
import { selectUsdView } from "../../shared/ledger-view";
import type { UsdBasis } from "../../domain/pricing";
import { compact, localTime } from "../lib/report";
import { useLiveUpdates } from "../lib/use-live-updates";
import {
  isReportBuilding,
  reportRefetchInterval,
  reportRetry,
} from "../lib/report-building";
import "./account-trend.css";

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type AccountTrendMetric = "tokens" | "requests" | "usd";
export type MiniTrendMetric =
  "tokens" | "requests" | "usd" | "credits" | "percent";
export type TrendVariant = "line" | "area" | "bar";
export type TrendTone = "teal" | "blue" | "purple";

/** 查询函数提供近 7 天逐小时报表，并保留原始美元双变体。 */
export type AccountTrendLoad = (
  accountId: string,
  signal: AbortSignal,
  refresh: boolean,
) => Promise<LedgerView>;

export interface AccountTrendProps {
  accountId: string;
  load: AccountTrendLoad;
  metric?: AccountTrendMetric;
  variant?: TrendVariant;
  usdBasis?: UsdBasis;
}

export interface MiniTrendProps {
  points: LedgerView["view"]["points"];
  metric?: MiniTrendMetric;
  variant?: TrendVariant;
  label: string;
  hideCaption?: boolean;
  tone?: TrendTone;
  /** 独立阅读的趋势显示数值刻度；指标旁的微图保持无轴。 */
  showScale?: boolean;
}

type TrendPoint = UnitView["points"][number];

const metricLabels: Record<MiniTrendMetric, string> = {
  tokens: "Tokens",
  requests: "Requests",
  usd: "USD",
  credits: "Credits",
  percent: "%",
};

const tonePalettes: Record<
  TrendTone,
  { stroke: string; areaTop: string; areaBottom: string }
> = {
  teal: {
    stroke: "#15998c",
    areaTop: "rgba(21, 153, 140, 0.3)",
    areaBottom: "rgba(21, 153, 140, 0.02)",
  },
  blue: {
    stroke: "#3779d5",
    areaTop: "rgba(55, 121, 213, 0.28)",
    areaBottom: "rgba(55, 121, 213, 0.02)",
  },
  purple: {
    stroke: "#8064b8",
    areaTop: "rgba(128, 100, 184, 0.28)",
    areaBottom: "rgba(128, 100, 184, 0.02)",
  },
};
const metricDefaultTones: Record<MiniTrendMetric, TrendTone> = {
  tokens: "teal",
  requests: "blue",
  usd: "purple",
  credits: "blue",
  percent: "blue",
};

const tooltipDateOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

export function accountTrendCaption(metric: AccountTrendMetric) {
  return `近7天 · 每小时 ${metricLabels[metric]}`;
}

/** 请求趋势读取请求数，其他指标沿用所选计价口径的数值。 */
function displayValue(point: TrendPoint, metric: MiniTrendMetric) {
  return metric === "requests" ? point.count : point.value;
}

function hasKnownValue(points: TrendPoint[], metric: MiniTrendMetric) {
  return points.some((point) => {
    const value = displayValue(point, metric);
    return value !== null && Number.isFinite(value);
  });
}

/** AccountTrend 只选择已缓存的账户报表分支，不复制或改写查询结果。 */
export function selectAccountTrendPoints(
  view: LedgerView,
  metric: AccountTrendMetric,
): LedgerView["view"]["points"] {
  if (metric === "requests") return view.view.units.tokens.points;
  return view.view.units[metric].points;
}

function formatMetricValue(value: number | null, metric: MiniTrendMetric) {
  if (value === null || !Number.isFinite(value)) return "N/A";
  if (metric === "usd")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6,
    }).format(value);
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: metric === "percent" ? 2 : 0,
  }).format(value);
  return `${formatted} ${metricLabels[metric]}`;
}

function tooltipPoint(params: unknown, points: TrendPoint[]) {
  const first = Array.isArray(params) ? params[0] : params;
  if (!first || typeof first !== "object") return undefined;
  const index = (first as { dataIndex?: unknown }).dataIndex;
  return typeof index === "number" ? points[index] : undefined;
}

function buildMiniTrendOption(
  points: TrendPoint[],
  metric: MiniTrendMetric,
  variant: TrendVariant,
  tone: TrendTone,
  showScale: boolean,
): EChartsCoreOption {
  const palette = tonePalettes[tone];
  const areaColor = {
    type: "linear",
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: palette.areaTop },
      { offset: 1, color: palette.areaBottom },
    ],
  };
  return {
    animation: false,
    textStyle: { fontFamily: "system-ui, sans-serif" },
    grid: {
      left: 0,
      right: 2,
      top: showScale ? 8 : 2,
      bottom: 2,
      containLabel: showScale,
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "rgba(20, 28, 36, 0.95)",
      borderWidth: 0,
      textStyle: { color: "#ffffff", fontSize: 11 },
      formatter: (params: unknown) => {
        const point = tooltipPoint(params, points);
        if (!point) return "";
        return `${localTime(point.at, tooltipDateOptions)}\n${formatMetricValue(displayValue(point, metric), metric)}`;
      },
    },
    xAxis: {
      type: "category",
      data: points.map((point) => point.at),
      boundaryGap: variant === "bar",
      show: false,
    },
    yAxis: {
      type: "value",
      show: showScale,
      scale: !showScale,
      splitNumber: 2,
      max: showScale
        ? (range: { max: number }) => (range.max > 0 ? range.max * 1.12 : 1)
        : undefined,
      axisLabel: {
        color: "#7c8a99",
        fontSize: 10,
        formatter: compact,
        showMaxLabel: !showScale,
      },
      splitLine: {
        lineStyle: { color: "rgba(124, 138, 153, 0.16)", type: "dashed" },
      },
    },
    series: [
      {
        type: variant === "bar" ? "bar" : "line",
        data: points.map((point) => displayValue(point, metric)),
        connectNulls: false,
        showSymbol: false,
        lineStyle: { color: palette.stroke, width: showScale ? 2 : 1.5 },
        itemStyle: {
          color: palette.stroke,
          borderRadius: variant === "bar" ? [2, 2, 0, 0] : undefined,
        },
        areaStyle: variant === "area" ? { color: areaColor } : undefined,
        barMaxWidth: 7,
        emphasis: { focus: "series" },
      },
    ],
  } as EChartsCoreOption;
}

function TrendCaption({
  label,
  hideCaption,
}: Pick<MiniTrendProps, "label" | "hideCaption">) {
  return hideCaption ? null : (
    <span className="mini-trend-caption">{label}</span>
  );
}

function TrendState({
  label,
  text,
  error = false,
}: {
  label: string;
  text: string;
  error?: boolean;
}) {
  return (
    <div className="mini-trend" title={label}>
      <TrendCaption label={label} />
      <div
        className={`mini-trend-state${error ? " is-error" : ""}`}
        role={error ? "alert" : "status"}
      >
        {text}
      </div>
    </div>
  );
}

/** 只消费调用方提供的报表点；不查询、不补点，也不生成预测曲线。 */
export function MiniTrend({
  points,
  metric = "tokens",
  variant = "area",
  label,
  hideCaption = false,
  tone,
  showScale = false,
}: MiniTrendProps) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null);
  const displayPoints = useMemo(
    () =>
      points.map((point) => ({ ...point, value: displayValue(point, metric) })),
    [points, metric],
  );
  const hasKnownPoint = hasKnownValue(displayPoints, metric);
  const showChart = displayPoints.length > 0 && hasKnownPoint;
  const resolvedTone = tone ?? metricDefaultTones[metric];
  const ariaLabel = `${label}，真实报表趋势，非预测曲线`;

  useEffect(() => {
    if (!showChart || !container.current) return;
    const chart = echarts.init(container.current, undefined, {
      renderer: "canvas",
    });
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      if (instance.current === chart) instance.current = null;
      chart.dispose();
    };
  }, [showChart]);

  useEffect(() => {
    const chart = instance.current;
    if (!chart || !showChart) return;
    chart.setOption(
      buildMiniTrendOption(
        displayPoints,
        metric,
        variant,
        resolvedTone,
        showScale,
      ),
      true,
    );
  }, [displayPoints, metric, variant, resolvedTone, showChart, showScale]);

  return (
    <div
      className={`mini-trend${hideCaption ? " is-caption-hidden" : ""}`}
      data-metric={metric}
      data-variant={variant}
      data-tone={resolvedTone}
      data-show-scale={showScale || undefined}
      title={label}
    >
      <TrendCaption label={label} hideCaption={hideCaption} />
      {showChart ? (
        <div
          className="mini-trend-chart"
          ref={container}
          role="img"
          aria-label={ariaLabel}
        />
      ) : (
        <div className="mini-trend-state" role="status">
          暂无真实趋势数据
        </div>
      )}
    </div>
  );
}

/** 账户趋势只封装查询与缓存状态，展示始终交给 MiniTrend。 */
export function AccountTrend({
  accountId,
  load,
  metric = "tokens",
  variant = "area",
  usdBasis = "subscription",
}: AccountTrendProps) {
  const { paused } = useLiveUpdates();
  const queryKey = ["ledger", "account-trend", accountId] as const;
  const query = useQuery<LedgerView>({
    queryKey,
    queryFn: ({ signal, client, queryKey: currentKey }) => {
      const cached = client.getQueryData<LedgerView>(currentKey);
      const failed = client.getQueryState(currentKey)?.status === "error";
      return load(
        accountId,
        signal,
        failed || !cached?.reportStatus?.refreshing,
      );
    },
    refetchInterval: (current) => reportRefetchInterval(current, paused),
    retry: reportRetry,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const selectedView = useMemo(
    () => (query.data ? selectUsdView(query.data, usdBasis) : undefined),
    [query.data, usdBasis],
  );
  const points = useMemo(
    () =>
      selectedView
        ? selectAccountTrendPoints(selectedView, metric)
        : ([] as LedgerView["view"]["points"]),
    [selectedView, metric],
  );
  const label = accountTrendCaption(metric);
  const hasKnownPoint = hasKnownValue(points, metric);
  const hasUsableData = Boolean(
    selectedView && points.length > 0 && hasKnownPoint,
  );
  const hasReportError = Boolean(
    query.isError || selectedView?.reportStatus?.lastError,
  );

  if (query.isPending) return <TrendState label={label} text="读取中…" />;
  if (!selectedView && isReportBuilding(query.error))
    return <TrendState label={label} text="计算中…" />;
  if (hasReportError && !hasUsableData)
    return <TrendState label={label} text="读取失败" error />;
  if (!selectedView)
    return <TrendState label={label} text="暂无真实趋势数据" />;

  return (
    <MiniTrend
      points={points}
      metric={metric}
      variant={variant}
      label={hasReportError ? `${label} · 更新失败` : label}
    />
  );
}
