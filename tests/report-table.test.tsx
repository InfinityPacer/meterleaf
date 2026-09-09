import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportTable } from "../src/web/components/ReportTable";
import { createDemoLedger } from "../src/web/demo/ledger";
import { aggregateReport } from "../src/web/lib/report";

const snapshot = createDemoLedger();

function renderReport() {
  return renderToStaticMarkup(
    <ReportTable
      data={aggregateReport(snapshot.records.slice(0, 4), "model")}
      count={4}
      accounts={snapshot.accounts}
      dimension="model"
      onDimension={() => {}}
    />,
  );
}

test("mobile report headers expose the four sortable summary fields", () => {
  const html = renderReport();
  const headers =
    html.match(/<div class="mobile-report-columns">[\s\S]*?<\/div>/)?.[0] ?? "";

  expect(headers.match(/<button/g) ?? []).toHaveLength(4);
  expect(headers).toContain("模型");
  expect(headers).toContain("请求数");
  expect(headers).toContain("Tokens");
  expect(headers).toContain("费用");
  expect(headers).not.toContain("USD 估值");
  expect(headers).not.toContain("订阅等价");
  expect(headers).not.toContain("标准 API");
  expect(headers.match(/data-sort-direction=/g) ?? []).toHaveLength(4);
  expect(headers).toContain('data-sort-direction="asc"');
  expect(headers.match(/<svg/g) ?? []).toHaveLength(4);
});

test("report menu keeps every supported sorting field", () => {
  const html = renderReport();

  for (const label of [
    "分组",
    "总 Tokens",
    "输入",
    "缓存读取",
    "缓存写入",
    "输出",
    "请求数",
    "费用",
    "Credits",
  ]) {
    expect(html).toContain(label);
  }
  expect(html).not.toContain("USD 估值");
  expect(html).not.toContain("Credits 估值");
  expect(html).not.toContain("订阅等价");
  expect(html).not.toContain("标准 API");
});
