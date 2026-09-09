import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createLedgerView, type LedgerView } from "../src/shared/ledger-view";
import {
  ModelDistribution,
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
  expect(ids("model", false)).toEqual(["a", "b", "c"]);
  expect(ids("requests")).toEqual(["a", "c", "b"]);
  expect(ids("tokens")).toEqual(["a", "b", "c"]);
  expect(ids("usd")).toEqual(["b", "a", "c"]);
  expect(ids("usd", false)).toEqual(["a", "b", "c"]);
  expect(ids("share")).toEqual(["b", "a", "c"]);
  expect(ids("share", true, "tokens")).toEqual(["a", "b", "c"]);
  expect(view.units.usd.breakdown.map((row) => row.model)).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("distribution exposes sortable table headings and a ranking menu", () => {
  const html = renderToStaticMarkup(
    <ModelDistribution view={fixture()} dark={false} onModel={() => {}} />,
  );
  expect(html).toContain('aria-label="模型排名排序"');
  expect(html.match(/aria-sort=/g)).toHaveLength(5);
  expect(html).toContain('aria-sort="descending"');
});
