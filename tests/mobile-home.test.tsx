import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileHome } from "../src/web/components/MobileHome";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createLedgerView } from "../src/shared/ledger-view";

function renderHome(values: (number | null)[]) {
  const snapshot = createDemoLedger();
  const view = createLedgerView(snapshot, {
    filter: { days: 7, model: "all", account: "all", search: "" },
    unit: "tokens",
    granularity: "day",
    dimension: "day",
    page: 0,
    pageSize: 1,
    sort: "occurredAt",
    desc: true,
  });
  return renderToStaticMarkup(
    <MobileHome
      snapshot={view}
      accounts={[]}
      asOf={view.asOf}
      trendPoints={values.map((value, index) => ({
        at: Date.parse(view.asOf) - index * 86400000,
        value,
        count: value === null ? 1 : 0,
        incomplete: value === null ? 1 : 0,
      }))}
      onAccount={() => {}}
      onRequests={() => {}}
      onAllAccounts={() => {}}
    />,
  );
}

test("home trend defaults to a line and preserves unknown values", () => {
  const html = renderHome([0, 100, null]);
  expect(html).toContain('data-variant="line"');
  expect(html).toContain('data-show-scale="true"');
  expect(html).toContain("Tokens 趋势</strong>");
  expect(html).toContain("0 Tokens");
  expect(html).toContain("100 Tokens");
  expect(html).toContain("N/A");
  expect(html).toContain('role="group" aria-label="近 30 天 Tokens 趋势"');
});

test("home without cumulative facts does not substitute filtered totals", () => {
  const html = renderHome([]);
  expect(html).toContain("暂无累计快照");
  expect(html).toContain("暂无真实趋势数据");
  expect(html).not.toContain("$0.00");
});
