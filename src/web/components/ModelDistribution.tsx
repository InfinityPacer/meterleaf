import { lazy, Suspense } from "react";
import { Segmented } from "./Segmented";
import { preferenceSchemas, usePreference } from "../lib/preferences";
import { ChevronRight } from "lucide-react";
import type { LedgerView } from "../../shared/ledger-view";
import { amount, compact, modelColor, modelLabel } from "../lib/report";

const UsageChart = lazy(() =>
  import("./UsageChart").then((m) => ({ default: m.UsageChart })),
);

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
  const [unit, setUnit] = usePreference("distribution-unit", preferenceSchemas.distributionUnit, "usd");
  const usd = new Map(
    view.units.usd.breakdown.map((row) => [row.model, row.summary]),
  );
  const tokens = new Map(
    view.units.tokens.breakdown.map((row) => [row.model, row.summary]),
  );
  const rows = view.units[unit].breakdown.filter((row) => row.count > 0);
  const total = rows.reduce(
    (sum, row) => sum + (row.summary.hasKnown ? row.summary.value : 0),
    0,
  );
  const partial = rows.some((row) => row.summary.incompleteRows > 0);
  return (
    <section
      className="model-distribution"
      aria-labelledby="distribution-title"
    >
      <div className="section-heading">
        <h2 id="distribution-title">模型分布</h2>
        <Segmented label="模型分布指标" value={unit} onChange={setUnit} options={[{ value: "tokens", label: "按 Tokens" }, { value: "usd", label: "按费用" }]} />
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
              {partial && <small>已知小计</small>}
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
                <th scope="col">模型</th>
                <th scope="col">请求数</th>
                <th scope="col">Tokens</th>
                <th scope="col">USD 估值</th>
                <th scope="col">占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
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
                    <td>{count?.hasKnown ? compact(count.value) : "未知"}</td>
                    <td className="distribution-usd">
                      {amount(dollars?.hasKnown ? dollars.value : null, "usd")}
                      {!!dollars?.incompleteRows && <small>已计价小计</small>}
                    </td>
                    <td>
                      {total > 0 && row.summary.hasKnown
                        ? `${((row.summary.value / total) * 100).toFixed(1)}%`
                        : "未知"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <p className="muted">所选范围内暂无请求</p>}
        </div>
      </div>
    </section>
  );
}
