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
  localTime,
  modelColor,
  modelLabel,
} from "../lib/report";
import type { LedgerView } from "../../shared/ledger-view";

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
  return value === null || !Number.isFinite(value)
    ? `${chartUnitLabels[unit]}：无已知值`
    : `${chartUnitLabels[unit]}：${amount(value, unit)}`;
}

function chartIncomplete(count: number) {
  return count > 0 ? `，${count.toLocaleString("en-US")} 条记录字段不完整` : "";
}

/** 趋势按时间分桶，饼图按模型分组；两者沿用相同筛选与计量单位。 */
export type ChartStyle = "bar" | "line" | "area" | "pie";

interface Props {
  points: LedgerView["view"]["points"];
  breakdown: LedgerView["view"]["breakdown"];
  unit: ReportUnit;
  granularity: Granularity;
  dark: boolean;
  chartStyle: ChartStyle;
  /** 独立模型报表由相邻表格提供图例与完整值。 */
  donut?: boolean;
}

export function UsageChart({
  points,
  breakdown,
  unit,
  granularity,
  dark,
  chartStyle,
  donut = false,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null);
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
    const data = points;
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
      textStyle: { fontFamily: "system-ui, sans-serif" },
      grid: { left: 6, right: 12, top: 32, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        confine: true,
        renderMode: "richText",
        backgroundColor: dark ? "#252b32" : "#ffffff",
        borderColor: dark ? "#404953" : "#dce1e7",
        textStyle: { color: dark ? "#edf0f4" : "#20242b", fontSize: 14 },
        formatter: (params: unknown) => {
          const values = params as { dataIndex: number }[];
          const point = data[values[0]?.dataIndex ?? 0];
          if (!point) return "";
          const value =
            point.value === null
              ? "无已知值"
              : `${amount(point.value, unit)}${unit === "credits" ? " credits" : unit === "tokens" ? " tokens" : ""}`;
          const incomplete = point.incomplete
            ? `\n${point.incomplete} 条记录字段不完整`
            : "";
          return `${localTime(point.at, { hour: granularity === "hour" ? "2-digit" : undefined })}\n${value}\n${point.count.toLocaleString()} 次请求${incomplete}`;
        },
      },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: dark ? "#c1c9d2" : "#414a55",
          fontSize: 13,
          hideOverlap: true,
          margin: 18,
        },
      },
      yAxis: {
        type: "value",
        splitNumber: 4,
        axisLabel: {
          color: dark ? "#c1c9d2" : "#414a55",
          fontSize: 13,
          formatter: (v: number) =>
            unit === "usd" ? `$${compact(v)}` : compact(v),
        },
        splitLine: {
          lineStyle: { color: dark ? "#303841" : "#e9edf2", type: "dashed" },
        },
      },
      series: [
        {
          name: "用量",
          type: chartStyle === "bar" ? "bar" : "line",
          showSymbol: true,
          symbolSize: 6,
          lineStyle: { width: 2.5 },
          areaStyle: chartStyle === "area" ? { opacity: 0.16 } : undefined,
          data: data.map((point) => point.value),
          barMaxWidth: 42,
          itemStyle: {
            color: dark ? "#619be7" : "#3779d5",
            borderRadius: [4, 4, 0, 0],
          },
          emphasis: { itemStyle: { color: "#168579" } },
        },
      ],
    };
    if (chartStyle === "pie") {
      const pieData = breakdown.flatMap((row) => {
        const value = row.summary.hasKnown ? row.summary.value : null;
        return value !== null && value > 0
          ? [
              {
                name: modelLabel(row.model),
                value,
                itemStyle: { color: modelColor(row.model) },
              },
            ]
          : [];
      });
      chart.setOption(
        {
          animation: false,
          textStyle: { fontFamily: "system-ui, sans-serif" },
          tooltip: {
            trigger: "item",
            confine: true,
            renderMode: "richText",
            backgroundColor: dark ? "#252b32" : "#ffffff",
            borderColor: dark ? "#404953" : "#dce1e7",
            textStyle: { color: dark ? "#edf0f4" : "#20242b", fontSize: 14 },
            formatter: (params: unknown) => {
              const point = params as {
                name: string;
                value: number;
                percent: number;
              };
              const percent = Number.isFinite(point.percent)
                ? `${point.percent}%`
                : "无占比";
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
            textStyle: { color: dark ? "#edf0f4" : "#20242b", fontSize: 13 },
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
                color: dark ? "#edf0f4" : "#20242b",
                fontSize: 14,
                formatter: (params: { percent?: number }) =>
                  (params.percent ?? 0) >= 5 ? `${params.percent}%` : "",
              },
              labelLayout: { hideOverlap: true },
              itemStyle: {
                borderColor: dark ? "#20262d" : "#ffffff",
                borderWidth: 2,
              },
              data: pieData,
            },
          ],
        } as EChartsCoreOption,
        true,
      );
    } else chart.setOption(option, true);
  }, [points, breakdown, unit, granularity, dark, chartStyle, donut]);
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
          ? breakdown.map((row) => (
              <div key={row.model}>
                <dt>{modelLabel(row.model)}</dt>
                <dd>
                  {chartMetric(
                    row.summary.hasKnown ? row.summary.value : null,
                    unit,
                  )}
                  ，{row.count.toLocaleString("en-US")} 次请求
                  {chartIncomplete(row.summary.incompleteRows)}
                </dd>
              </div>
            ))
          : points.map((point) => (
              <div key={point.at}>
                <dt>{localTime(point.at, chartDateTimeOptions)}</dt>
                <dd>
                  {chartMetric(point.value, unit)}，
                  {point.count.toLocaleString("en-US")} 次请求
                  {chartIncomplete(point.incomplete)}
                </dd>
              </div>
            ))}
      </dl>
    </>
  );
}
