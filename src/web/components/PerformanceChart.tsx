import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import type { LedgerAccount } from "../../shared/report";
import {
  formatLatencyMs,
  formatTps,
  localTime,
  modelColor,
  modelLabel,
  performanceAvgDurationMs,
  performanceAvgFirstTokenMs,
  performanceTps,
  type ReportDimension,
  type ReportPerformance,
} from "../lib/report";
import { useThemeColors } from "../lib/theme-colors";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export interface PerformanceChartRow {
  key: string;
  requests: number;
  performance?: ReportPerformance;
}

interface Props {
  data: PerformanceChartRow[];
  dimension: ReportDimension;
  accounts: LedgerAccount[];
}

function axisLabel(
  key: string,
  dimension: ReportDimension,
  accounts: LedgerAccount[],
) {
  if (dimension === "model") return modelLabel(key);
  if (dimension === "account")
    return accounts.find((account) => account.id === key)?.name ?? key;
  if (dimension === "hour") {
    return localTime(key, {
      month: undefined,
      day: undefined,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return localTime(key);
}

function tooltipTitle(
  key: string,
  dimension: ReportDimension,
  accounts: LedgerAccount[],
) {
  if (dimension === "model") return modelLabel(key);
  if (dimension === "account")
    return accounts.find((account) => account.id === key)?.name ?? key;
  return localTime(key, {
    year: "numeric",
    ...(dimension === "hour"
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
  });
}

/** 响应性能组合图：柱状展示加权生成速度，折线叠加平均首字延迟并附可切换图例。 */
export function PerformanceChart({ data, dimension, accounts }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null);
  const colors = useThemeColors();

  const isTimeDimension =
    dimension === "hour" || dimension === "day" || dimension === "week";
  const rows = (
    isTimeDimension
      ? [...data].sort((left, right) => left.key.localeCompare(right.key))
      : [...data]
          .filter(
            (row) =>
              performanceTps(row.performance) !== null ||
              performanceAvgFirstTokenMs(row.performance) !== null,
          )
          .sort(
            (left, right) =>
              (performanceTps(right.performance) ?? -1) -
                (performanceTps(left.performance) ?? -1) ||
              left.key.localeCompare(right.key),
          )
          .slice(0, 12)
  ).map((row) => ({
    row,
    label: axisLabel(row.key, dimension, accounts),
    title: tooltipTitle(row.key, dimension, accounts),
    tps: performanceTps(row.performance),
    firstTokenMs: performanceAvgFirstTokenMs(row.performance),
    durationMs: performanceAvgDurationMs(row.performance),
    samples: row.performance?.durationKnown ?? 0,
  }));

  const hasTps = rows.some((item) => item.tps !== null);
  const hasFirstToken = rows.some((item) => item.firstTokenMs !== null);

  useEffect(() => {
    if (!container.current || (!hasTps && !hasFirstToken)) return;
    const chart = echarts.init(container.current, undefined, {
      renderer: "canvas",
    });
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.current = null;
      chart.dispose();
    };
  }, [hasTps, hasFirstToken]);

  useEffect(() => {
    const chart = instance.current;
    if (!chart || (!hasTps && !hasFirstToken)) return;

    const series: Record<string, unknown>[] = [];
    const yAxis: Record<string, unknown>[] = [];

    if (hasTps) {
      yAxis.push({
        type: "value",
        splitNumber: 4,
        axisLabel: {
          color: colors.muted,
          fontSize: 11.5,
          formatter: (v: number) => `${Math.round(v)}`,
        },
        splitLine: {
          lineStyle: { color: colors.lineSoft, type: "dashed" },
        },
      });
      series.push({
        name: "生成速度 (tok/s)",
        type: "bar",
        yAxisIndex: 0,
        barMaxWidth: 28,
        itemStyle: {
          color: colors.accent,
          borderRadius: [4, 4, 0, 0],
        },
        data: rows.map((item) =>
          item.tps === null
            ? null
            : {
                value: Number(item.tps.toFixed(1)),
                itemStyle:
                  dimension === "model"
                    ? { color: modelColor(item.row.key) }
                    : undefined,
              },
        ),
      });
    }

    if (hasFirstToken) {
      const axisIndex = yAxis.length;
      yAxis.push({
        type: "value",
        splitNumber: 4,
        axisLabel: {
          color: colors.muted,
          fontSize: 11.5,
          formatter: (v: number) => formatLatencyMs(v * 1000),
        },
        splitLine: {
          show: !hasTps,
          lineStyle: { color: colors.lineSoft, type: "dashed" },
        },
      });
      series.push({
        name: "平均首字延迟",
        type: "line",
        yAxisIndex: axisIndex,
        connectNulls: false,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: {
          width: 2,
          color: colors.muted,
          type: isTimeDimension ? "solid" : "dashed",
        },
        itemStyle: {
          color: colors.muted,
          borderColor: colors.surface,
          borderWidth: 1.5,
        },
        data: rows.map((item) =>
          item.firstTokenMs === null
            ? null
            : Number((item.firstTokenMs / 1000).toFixed(3)),
        ),
      });
    }

    const option: EChartsCoreOption = {
      animation: false,
      textStyle: { fontFamily: colors.fontFamily },
      legend: {
        show: true,
        top: 2,
        left: "center",
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 18,
        textStyle: { color: colors.muted, fontSize: 12 },
      },
      grid: {
        left: 8,
        right: hasFirstToken && hasTps ? 12 : 16,
        top: 34,
        bottom: 6,
        containLabel: true,
      },
      tooltip: {
        trigger: "axis",
        axisPointer: {
          type: isTimeDimension ? "line" : "shadow",
          shadowStyle: { color: colors.soft, opacity: 0.45 },
          lineStyle: { color: colors.line },
        },
        confine: true,
        renderMode: "richText",
        backgroundColor: colors.surface,
        borderColor: colors.line,
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: colors.ink, fontSize: 12.5 },
        formatter: (params: unknown) => {
          const items = Array.isArray(params)
            ? (params as { dataIndex: number }[])
            : [];
          const entry = rows[items[0]?.dataIndex ?? 0];
          if (!entry) return "";
          const lines = [entry.title];
          lines.push(`生成速度：${formatTps(entry.tps)}`);
          lines.push(`平均首字延迟：${formatLatencyMs(entry.firstTokenMs)}`);
          lines.push(`平均总耗时：${formatLatencyMs(entry.durationMs)}`);
          lines.push(
            `有效样本：${entry.samples.toLocaleString()} / ${entry.row.requests.toLocaleString()}`,
          );
          return lines.join("\n");
        },
      },
      xAxis: {
        type: "category",
        data: rows.map((item) => item.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: colors.muted,
          fontSize: 11.5,
          hideOverlap: true,
          interval: isTimeDimension ? "auto" : 0,
          formatter: (value: string) =>
            value.length > 20 ? `${value.slice(0, 19)}…` : value,
        },
      },
      yAxis,
      series,
    };

    chart.setOption(option, true);
  }, [rows, hasTps, hasFirstToken, colors, dimension, isTimeDimension]);

  if (!hasTps && !hasFirstToken) return null;

  return (
    <div
      className="performance-chart-wrap"
      role="region"
      aria-label="响应性能图表"
    >
      <div className="performance-chart" ref={container} />
    </div>
  );
}
