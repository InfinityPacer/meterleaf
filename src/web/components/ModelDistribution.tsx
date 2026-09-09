import { lazy, Suspense } from "react";
import { Menu as ActionMenu } from "@base-ui/react/menu";
import { Segmented } from "./Segmented";
import { preferenceSchemas, usePreference } from "../lib/preferences";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
} from "lucide-react";
import { Button } from "./ui/button";
import type { LedgerView } from "../../shared/ledger-view";
import { amount, compact, modelColor, modelLabel } from "../lib/report";
import "./mobile-data.css";

const UsageChart = lazy(() =>
  import("./UsageChart").then((m) => ({ default: m.UsageChart })),
);

const distributionSortOptions = [
  { id: "model", label: "模型" },
  { id: "requests", label: "请求数" },
  { id: "tokens", label: "Tokens" },
  { id: "usd", label: "USD 估值" },
  { id: "share", label: "占比" },
] as const;
type DistributionSort = {
  id: (typeof distributionSortOptions)[number]["id"];
  desc: boolean;
};

/** 占比分布只包含当前指标的正有限值，圆环与排名共用同一数据范围。 */
export function distributionRows(
  view: LedgerView["view"],
  unit: "usd" | "tokens",
) {
  return view.units[unit].breakdown.filter(
    (row) =>
      row.count > 0 &&
      row.summary.hasKnown &&
      Number.isFinite(row.summary.value) &&
      row.summary.value > 0,
  );
}

/** 排名使用完整聚合；次要指标的未知值置后，不改动环图顺序。 */
export function sortedDistributionRows(
  view: LedgerView["view"],
  unit: "usd" | "tokens",
  sorting: DistributionSort,
) {
  const values = new Map(
    view.units[
      sorting.id === "usd" || sorting.id === "tokens" ? sorting.id : unit
    ].breakdown.map((row) => [
      row.model,
      row.summary.hasKnown ? row.summary.value : null,
    ]),
  );
  const valueOf = (row: LedgerView["view"]["breakdown"][number]) =>
    sorting.id === "model"
      ? modelLabel(row.model)
      : sorting.id === "requests"
        ? row.count
        : (values.get(row.model) ?? null);
  return distributionRows(view, unit).sort((left, right) => {
    const a = valueOf(left);
    const b = valueOf(right);
    if (a === null && b !== null) return 1;
    if (a !== null && b === null) return -1;
    const compared =
      a === b
        ? 0
        : typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b));
    return compared
      ? compared * (sorting.desc ? -1 : 1)
      : left.model.localeCompare(right.model);
  });
}

/** 同一查询的多单位聚合按模型键关联，不从当前明细页推算模型总量。 */
export function ModelDistribution({
  view,
  dark,
  onModel,
}: {
  view: LedgerView["view"];
  dark: boolean;
  onModel: (model: string) => void;
}) {
  const [unit, setUnit] = usePreference(
    "distribution-unit",
    preferenceSchemas.distributionUnit,
    "usd",
  );
  const [sorting, setSorting] = usePreference<DistributionSort>(
    "distribution-sort",
    preferenceSchemas.distributionSort,
    { id: "share", desc: true },
  );
  const rankedRows = sortedDistributionRows(view, unit, sorting);
  const sortBy = (id: DistributionSort["id"]) =>
    setSorting({
      id,
      desc: sorting.id === id ? !sorting.desc : id !== "model",
    });
  const usd = new Map(
    view.units.usd.breakdown.map((row) => [row.model, row.summary]),
  );
  const tokens = new Map(
    view.units.tokens.breakdown.map((row) => [row.model, row.summary]),
  );
  const rows = distributionRows(view, unit);
  const total = rows.reduce(
    (sum, row) => sum + (row.summary.hasKnown ? row.summary.value : 0),
    0,
  );
  return (
    <section
      className="model-distribution"
      aria-labelledby="distribution-title"
    >
      <div className="model-chart-tool">
        <div className="section-heading">
          <h2 id="distribution-title">模型分布</h2>
          <Segmented
            label="模型分布指标"
            value={unit}
            onChange={setUnit}
            options={[
              { value: "tokens", label: "按 Tokens" },
              { value: "usd", label: "按费用" },
            ]}
          />
          <div className="model-sort-control">
            <ActionMenu.Root>
              <ActionMenu.Trigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label="模型排名排序"
                title={`模型排名排序：${distributionSortOptions.find((option) => option.id === sorting.id)?.label} · ${sorting.desc ? "降序" : "升序"}`}
              >
                <ArrowUpDown size={17} />
              </ActionMenu.Trigger>
              <ActionMenu.Portal>
                <ActionMenu.Positioner
                  className="data-menu-positioner"
                  sideOffset={6}
                  align="end"
                >
                  <ActionMenu.Popup className="data-menu">
                    {distributionSortOptions.map((option) => (
                      <ActionMenu.Item
                        key={option.id}
                        onClick={() => sortBy(option.id)}
                      >
                        {option.label}
                        {sorting.id === option.id && (
                          <Check size={15} aria-hidden="true" />
                        )}
                      </ActionMenu.Item>
                    ))}
                    <ActionMenu.Separator />
                    <ActionMenu.Item onClick={() => sortBy(sorting.id)}>
                      切换为{sorting.desc ? "升序" : "降序"}
                      {sorting.desc ? (
                        <ArrowUp size={15} />
                      ) : (
                        <ArrowDown size={15} />
                      )}
                    </ActionMenu.Item>
                  </ActionMenu.Popup>
                </ActionMenu.Positioner>
              </ActionMenu.Portal>
            </ActionMenu.Root>
          </div>
        </div>
        <div className="model-distribution-layout">
          <div className="model-donut">
            {total > 0 ? (
              <Suspense fallback={<div className="usage-chart" />}>
                <UsageChart
                  points={[]}
                  breakdown={rows}
                  unit={unit}
                  granularity="day"
                  chartStyle="pie"
                  donut
                  dark={dark}
                />
              </Suspense>
            ) : (
              <div className="usage-chart empty-chart">暂无可展示的占比</div>
            )}
            {total > 0 && (
              <div className="model-donut-total" aria-hidden="true">
                <span>{unit === "usd" ? "估算费用" : "总 Tokens"}</span>
                <strong>{amount(total, unit)}</strong>
              </div>
            )}
          </div>
          <div
            className="model-distribution-scroll"
            tabIndex={0}
            role="region"
            aria-label="模型分布明细"
          >
            <table>
              <caption className="sr-only">
                模型请求数、Tokens、独立美元估值与
                {unit === "usd" ? "费用" : "Tokens"}占比
              </caption>
              <thead>
                <tr>
                  {distributionSortOptions.map((option) => (
                    <th
                      key={option.id}
                      scope="col"
                      aria-sort={
                        sorting.id === option.id
                          ? sorting.desc
                            ? "descending"
                            : "ascending"
                          : "none"
                      }
                    >
                      <button onClick={() => sortBy(option.id)}>
                        {option.label}
                        {sorting.id === option.id ? (
                          sorting.desc ? (
                            <ArrowDown size={12} />
                          ) : (
                            <ArrowUp size={12} />
                          )
                        ) : (
                          <ArrowUpDown size={12} />
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rankedRows.map((row) => {
                  const dollars = usd.get(row.model);
                  const count = tokens.get(row.model);
                  return (
                    <tr key={row.model}>
                      <th scope="row">
                        <button
                          title={row.model}
                          aria-label={`查看 ${modelLabel(row.model)} 请求`}
                          onClick={() => onModel(row.model)}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                          <i
                            style={{ background: modelColor(row.model) }}
                            aria-hidden="true"
                          />
                          <span>{modelLabel(row.model)}</span>
                        </button>
                      </th>
                      <td>{row.count.toLocaleString()}</td>
                      <td>{count?.hasKnown ? compact(count.value) : "N/A"}</td>
                      <td className="distribution-usd">
                        {amount(
                          dollars?.hasKnown ? dollars.value : null,
                          "usd",
                        )}
                      </td>
                      <td>
                        {`${((row.summary.value / total) * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length && <p className="muted">暂无可展示的占比</p>}
          </div>
          <ol className="mobile-model-list" aria-label="模型排名" tabIndex={0}>
            {rankedRows.map((row) => {
              const dollars = usd.get(row.model);
              const count = tokens.get(row.model);
              const percentage = `${((row.summary.value / total) * 100).toFixed(1)}%`;
              return (
                <li key={row.model}>
                  <button
                    type="button"
                    className="mobile-model-item"
                    title={row.model}
                    aria-label={`查看 ${modelLabel(row.model)} 请求`}
                    onClick={() => onModel(row.model)}
                  >
                    <span className="mobile-model-heading">
                      <span className="mobile-model-name">
                        <i
                          style={{ background: modelColor(row.model) }}
                          aria-hidden="true"
                        />
                        <span>{modelLabel(row.model)}</span>
                      </span>
                      <strong className="distribution-usd">
                        {amount(
                          dollars?.hasKnown ? dollars.value : null,
                          "usd",
                        )}
                      </strong>
                      <span className="mobile-model-percentage">
                        {percentage}
                      </span>
                    </span>
                    <span className="sr-only">
                      Tokens {count?.hasKnown ? compact(count.value) : "N/A"}，
                      {row.count.toLocaleString()} 次请求
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {!rows.length && (
            <p className="mobile-model-empty muted">暂无可展示的占比</p>
          )}
        </div>
      </div>
      <div className="mobile-distribution-unit">
        <Segmented
          label="手机模型分布指标"
          value={unit}
          onChange={setUnit}
          options={[
            { value: "tokens", label: "Tokens" },
            { value: "usd", label: "费用" },
          ]}
        />
      </div>
    </section>
  );
}
