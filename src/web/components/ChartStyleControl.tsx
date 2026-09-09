import { BarChart3, ChartArea, ChartLine, ChartPie } from "lucide-react";
import type { ChartStyle } from "./UsageChart";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** 时间序列允许隐藏占比图；所有入口共享同一组选中状态与图标语义。 */
export function ChartStyleControl({
  value,
  onChange,
  allowPie = true,
}: {
  value: ChartStyle;
  onChange: (value: ChartStyle) => void;
  allowPie?: boolean;
}) {
  return (
    <div className="chart-style-control" role="group" aria-label="图表样式">
      {(
        [
          { value: "line", label: "折线图", icon: ChartLine },
          { value: "area", label: "面积图", icon: ChartArea },
          { value: "bar", label: "柱状图", icon: BarChart3 },
          { value: "pie", label: "饼图", icon: ChartPie },
        ] as const
      )
        .filter((item) => allowPie || item.value !== "pie")
        .map((item) => (
          <Tooltip key={item.value}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={item.label}
                  aria-pressed={value === item.value}
                  onClick={() => onChange(item.value)}
                />
              }
            >
              <item.icon size={16} />
            </TooltipTrigger>
            <TooltipContent>{item.label}</TooltipContent>
          </Tooltip>
        ))}
    </div>
  );
}
