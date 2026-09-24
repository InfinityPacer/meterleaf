import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import type { Granularity, ReportUnit } from "../../shared/report";
import {
  amount,
  compact,
  continuousPoints,
  localTime,
  modelColor,
  modelLabel,
} from "../lib/report";
import type { LedgerView } from "../../shared/ledger-view";
import { useThemeColors } from "../lib/theme-colors";

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  LegendComponent,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const chartUnitLabels: Record<ReportUnit, string> = {
  usd: "USD（美元）",
  tokens: "Tokens",
  credits: "Credits",
};
const chartDateTimeOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

function chartMetric(value: number | null, unit: ReportUnit) {
  return `${chartUnitLabels[unit]}：${chartValue(value, unit)}`;
}

function chartValue(value: number | null, unit: ReportUnit) {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${amount(value, unit)}${unit === "credits" ? " credits" : unit === "tokens" ? " tokens" : ""}`;
}

function pieRows(breakdown: LedgerView["view"]["breakdown"]) {
  return breakdown.filter(
    (row) =>
      row.summary.hasKnown &&
      Number.isFinite(row.summary.value) &&
      row.summary.value > 0,
  );
}

/** 趋势按时间分桶，饼图按模型分组；两者沿用相同筛选与计量单位。 */
export type ChartStyle = "bar" | "line" | "area" | "pie";

interface Props {
  points: LedgerView["view"]["points"];
  breakdown: LedgerView["view"]["breakdown"];
  unit: ReportUnit;
  granularity: Granularity;
  chartStyle: ChartStyle;
  /** 独立模型报表由相邻表格提供图例与完整值。 */
  donut?: boolean;
}

export function UsageChart({
  points,
  breakdown,
  unit,
  granularity,
  chartStyle,
  donut = false,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null);
  const positivePieRows = pieRows(breakdown);
  const colors = useThemeColors();
  useEffect(() => {
    if (!container.current) return;
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
  }, []);
  useEffect(() => {
    const chart = instance.current;
    if (!chart) return;
    const data = continuousPoints(points, granularity);
    const labels = data.map((point) =>
      localTime(
        point.at,
        granularity === "hour"
          ? { day: undefined, month: undefined, hour: "2-digit", hour12: false }
          : {},
      ),
    );
    const option: EChartsCoreOption = {
      animation: false,
      textStyle: { fontFamily: colors.fontFamily },
      grid: { left: 6, right: 12, top: 32, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        confine: true,
        renderMode: "richText",
        backgroundColor: colors.surface,
        borderColor: colors.line,
        textStyle: { color: colors.ink, fontSize: 13 },
        formatter: (params: unknown) => {
          const values = params as { dataIndex: number }[];
          const point = data[values[0]?.dataIndex ?? 0];
          if (!point) return "";
          return `${localTime(point.at, { hour: granularity === "hour" ? "2-digit" : undefined })}\n${chartValue(point.value, unit)}\n${point.count.toLocaleString()} 次请求`;
        },
      },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: colors.muted,
          fontSize: 12,
          hideOverlap: true,
          margin: 18,
        },
      },
      yAxis: {
        type: "value",
        splitNumber: 4,
        axisLabel: {
          color: colors.muted,
          fontSize: 12,
          formatter: (v: number) =>
            unit === "usd" ? `$${compact(v)}` : compact(v),
        },
        splitLine: {
          lineStyle: { color: colors.lineSoft },
        },
      },
      series: [
        {
          name: "用量",
          type: chartStyle === "bar" ? "bar" : "line",
          showSymbol: false,
          symbolSize: 6,
          lineStyle: { width: 2 },
          areaStyle:
            chartStyle === "area"
              ? {
                  color: {
                    type: "linear",
                    x: 0,
                    y: 0,
                    x2: 0,
                    y2: 1,
                    colorStops: [
                      { offset: 0, color: colors.accentAlpha(0.22) },
                      { offset: 1, color: colors.accentAlpha(0.02) },
                    ],
                  },
                }
              : undefined,
          data: data.map((point) => point.value),
          barMaxWidth: 42,
          itemStyle: {
            color: colors.accent,
            borderRadius: [3, 3, 0, 0],
          },
          emphasis: { itemStyle: { color: colors.accent } },
        },
      ],
    };
    if (chartStyle === "pie") {
      const pieData = positivePieRows.map((row) => ({
        name: modelLabel(row.model),
        value: row.summary.value,
        itemStyle: { color: modelColor(row.model) },
      }));
      chart.setOption(
        {
          animation: false,
          textStyle: { fontFamily: colors.fontFamily },
          tooltip: {
            trigger: "item",
            confine: true,
            renderMode: "richText",
            backgroundColor: colors.surface,
            borderColor: colors.line,
            textStyle: { color: colors.ink, fontSize: 13 },
            formatter: (params: unknown) => {
              const point = params as {
                name: string;
                value: number;
                percent: number;
              };
              const percent = Number.isFinite(point.percent)
                ? `${point.percent}%`
                : "N/A";
              return `${point.name}\n${amount(point.value, unit)}${unit === "credits" ? " credits" : unit === "tokens" ? " tokens" : ""}\n${percent}`;
            },
          },
          legend: {
            show: !donut,
            type: "plain",
            width: "90%",
            bottom: 0,
            left: "center",
            itemWidth: 12,
            itemHeight: 12,
            textStyle: { color: colors.ink, fontSize: 12 },
          },
          series: [
            {
              type: "pie",
              radius: donut ? ["58%", "90%"] : "68%",
              center: donut ? ["50%", "50%"] : ["50%", "43%"],
              stillShowZeroSum: false,
              label: {
                show: !donut,
                position: "outside",
                color: colors.ink,
                fontSize: 12,
                formatter: (params: { percent?: number }) =>
                  (params.percent ?? 0) >= 5 ? `${params.percent}%` : "",
              },
              labelLayout: { hideOverlap: true },
              itemStyle: {
                borderColor: colors.surface,
                borderWidth: 2,
              },
              data: pieData,
            },
          ],
        } as EChartsCoreOption,
        true,
      );
    } else chart.setOption(option, true);
  }, [points, breakdown, unit, granularity, colors, chartStyle, donut]);
  return (
    <>
      <div
        className="usage-chart"
        ref={container}
        aria-hidden="true"
        data-chart-style={chartStyle}
        data-chart-unit={unit}
        aria-label={
          chartStyle === "pie"
            ? "所选范围内各模型的消耗占比"
            : "所选时间范围内的用量趋势，详细数值见请求明细"
        }
      />
      <dl
        className="sr-only"
        aria-label={`${chartStyle === "pie" ? "模型用量占比数据" : "用量趋势数据"}（单位：${chartUnitLabels[unit]}）`}
      >
        {chartStyle === "pie"
          ? positivePieRows.map((row) => (
              <div key={row.model}>
                <dt>{modelLabel(row.model)}</dt>
                <dd>
                  {chartMetric(row.summary.value, unit)}，
                  {row.count.toLocaleString("en-US")} 次请求
                </dd>
              </div>
            ))
          : points.map((point) => (
              <div key={point.at}>
                <dt>{localTime(point.at, chartDateTimeOptions)}</dt>
                <dd>
                  {chartMetric(point.value, unit)}，
                  {point.count.toLocaleString("en-US")} 次请求
                </dd>
              </div>
            ))}
      </dl>
    </>
  );
}
