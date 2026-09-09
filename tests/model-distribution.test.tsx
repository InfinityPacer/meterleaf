import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createLedgerView, type LedgerView } from "../src/shared/ledger-view";
import {
  ModelDistribution,
  distributionRows,
  sortedDistributionRows,
} from "../src/web/components/ModelDistribution";

function fixture() {
  const { view } = createLedgerView(createDemoLedger(), {
    filter: { days: 7, model: "all", account: "all", search: "" },
    unit: "usd",
    granularity: "day",
    dimension: "model",
    page: 0,
    pageSize: 12,
    sort: "occurredAt",
    desc: true,
  });
  const row = (
    model: string,
    count: number,
    value: number | null,
  ): LedgerView["view"]["breakdown"][number] => ({
    model,
    count,
    summary: {
      ...view.totalSummary,
      value: value ?? 0,
      hasKnown: value !== null,
    },
  });
  view.units.usd.breakdown = [
    row("a", 3, 2),
    row("b", 1, 5),
    row("c", 2, null),
  ];
  view.units.tokens.breakdown = [
    row("a", 3, 900),
    row("b", 1, 100),
    row("c", 2, null),
  ];
  return view;
}

test("distribution sorts every displayed field using complete unit aggregates", () => {
  const view = fixture();
  const ids = (
    id: "model" | "requests" | "tokens" | "usd" | "share",
    desc = true,
    unit: "tokens" | "usd" = "usd",
  ) => sortedDistributionRows(view, unit, { id, desc }).map((row) => row.model);
  expect(ids("model", false)).toEqual(["a", "b"]);
  expect(ids("requests")).toEqual(["a", "b"]);
  expect(ids("tokens")).toEqual(["a", "b"]);
  expect(ids("usd")).toEqual(["b", "a"]);
  expect(ids("usd", false)).toEqual(["a", "b"]);
  expect(ids("share")).toEqual(["b", "a"]);
  expect(ids("share", true, "tokens")).toEqual(["a", "b"]);
  expect(view.units.usd.breakdown.map((row) => row.model)).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("distribution omits unavailable shares but retains the model in other units", () => {
  const view = fixture();
  view.units.tokens.breakdown[2]!.summary = {
    ...view.units.tokens.breakdown[2]!.summary,
    hasKnown: true,
    value: 400,
  };
  view.units.usd.breakdown[0]!.summary.incompleteRows = 1;
  const rows = distributionRows(view, "usd");
  expect(rows.map((row) => row.model)).toEqual(["a", "b"]);
  expect(distributionRows(view, "tokens").map((row) => row.model)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(rows.reduce((sum, row) => sum + row.summary.value, 0)).toBe(7);
  const html = renderToStaticMarkup(
    <ModelDistribution view={view} dark={false} onModel={() => {}} />,
  );
  expect(html).toContain("28.6%");
  expect(html).toContain("71.4%");
  expect(html).not.toMatch(/已计价|已知小计|不完整|未知/);
  expect(html).not.toContain('aria-label="查看 c 请求"');
});

test("distribution never lists zero, negative, nonfinite or all-missing shares", () => {
  const view = fixture();
  for (const value of [0, -1, NaN, Infinity]) {
    view.units.usd.breakdown[0]!.summary.value = value;
    expect(distributionRows(view, "usd").map((row) => row.model)).toEqual([
      "b",
    ]);
  }
  view.units.usd.breakdown.forEach((row) => {
    row.summary.hasKnown = false;
  });
  const html = renderToStaticMarkup(
    <ModelDistribution view={view} dark={false} onModel={() => {}} />,
  );
  expect(html).toContain("暂无可展示的占比");
  expect(html).not.toMatch(/未知|NaN|Infinity|已知小计/);
});

test("distribution exposes sortable table headings and a ranking menu", () => {
  const html = renderToStaticMarkup(
    <ModelDistribution view={fixture()} dark={false} onModel={() => {}} />,
  );
  expect(html).toContain('aria-label="模型排名排序"');
  expect(html.match(/aria-sort=/g)).toHaveLength(5);
  expect(html).toContain('aria-sort="descending"');
});
