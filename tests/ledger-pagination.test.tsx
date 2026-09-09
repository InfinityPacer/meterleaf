import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getLedgerPageItems,
  LedgerTable,
  type LedgerPageItem,
} from "../src/web/components/LedgerTable";
import { createDemoLedger } from "../src/web/demo/ledger";

function pageIndexes(items: LedgerPageItem[]) {
  return items
    .filter(
      (item): item is { type: "page"; pageIndex: number } =>
        item.type === "page",
    )
    .map((item) => item.pageIndex);
}

test("ledger page window keeps first, last, nearby pages and bounded jumps", () => {
  expect(pageIndexes(getLedgerPageItems(0, 1))).toEqual([0]);
  expect(pageIndexes(getLedgerPageItems(0, 7))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(getLedgerPageItems(0, 20)).toEqual([
    { type: "page", pageIndex: 0 },
    { type: "page", pageIndex: 1 },
    { type: "page", pageIndex: 2 },
    { type: "page", pageIndex: 3 },
    { type: "page", pageIndex: 4 },
    { type: "ellipsis", position: "end" },
    { type: "page", pageIndex: 19 },
  ]);
  expect(getLedgerPageItems(9, 20)).toEqual([
    { type: "page", pageIndex: 0 },
    { type: "ellipsis", position: "start" },
    { type: "page", pageIndex: 7 },
    { type: "page", pageIndex: 8 },
    { type: "page", pageIndex: 9 },
    { type: "page", pageIndex: 10 },
    { type: "page", pageIndex: 11 },
    { type: "ellipsis", position: "end" },
    { type: "page", pageIndex: 19 },
  ]);
  expect(getLedgerPageItems(19, 20)).toEqual([
    { type: "page", pageIndex: 0 },
    { type: "ellipsis", position: "start" },
    { type: "page", pageIndex: 15 },
    { type: "page", pageIndex: 16 },
    { type: "page", pageIndex: 17 },
    { type: "page", pageIndex: 18 },
    { type: "page", pageIndex: 19 },
  ]);
  expect(pageIndexes(getLedgerPageItems(9, 20))).toEqual([
    0, 7, 8, 9, 10, 11, 19,
  ]);
  expect(
    pageIndexes(getLedgerPageItems(9, 20)).filter((page) => page === 9),
  ).toEqual([9]);
});

test("ledger pagination exposes mobile and desktop text plus one current page", () => {
  const record = createDemoLedger("api").records[0]!;
  const html = renderToStaticMarkup(
    <LedgerTable
      records={[record]}
      total={240}
      pageIndex={9}
      onPage={() => {}}
      sorting={{ id: "occurredAt", desc: true }}
      onSorting={() => {}}
      accounts={[]}
      onSelect={() => {}}
      search=""
      onSearch={() => {}}
      usdBasis="api"
    />,
  );
  const pageMarkup =
    html.match(/<nav class="ledger-page-numbers"[\s\S]*?<\/nav>/)?.[0] ?? "";

  expect(html).toContain('class="ledger-page-summary mobile-only"');
  expect(html).toContain("第 10 / 20 页");
  expect(html).toContain('class="ledger-page-total desktop-only"');
  expect(html).toContain("每页 12 条，共 240 条记录");
  expect(pageMarkup).toContain('class="ledger-page-numbers"');
  expect(pageMarkup.match(/aria-label="第 \d+ 页"/g) ?? []).toHaveLength(7);
  expect(pageMarkup.match(/aria-current="page"/g) ?? []).toHaveLength(1);
  expect(pageMarkup).toContain('aria-label="第 10 页"');
  expect(pageMarkup).toContain("…");
});

test("an out-of-range empty page retains navigation to the last valid page", () => {
  const html = renderToStaticMarkup(
    <LedgerTable
      records={[]}
      total={25}
      pageIndex={9}
      onPage={() => {}}
      sorting={{ id: "occurredAt", desc: true }}
      onSorting={() => {}}
      accounts={[]}
      onSelect={() => {}}
      search=""
      onSearch={() => {}}
      usdBasis="api"
    />,
  );
  expect(html).toContain("第 3 / 3 页");
  expect(html).toContain('aria-label="第 3 页" aria-current="page"');
  expect(html).toContain('aria-label="上一页"');
  expect(html).toContain('aria-label="下一页"');
  expect(html).not.toContain("第 10 / 3 页");
});

test.each([
  { actual: "max", requested: "high", expected: "max" },
  { actual: null, requested: "xhigh", expected: "xhigh" },
  { actual: " ", requested: "high", expected: "high" },
  { actual: null, requested: null, expected: "N/A" },
])(
  "mobile requests display effective effort $expected and an unprefixed account",
  ({ actual, requested, expected }) => {
    const record = createDemoLedger("api").records[0]!;
    const html = renderToStaticMarkup(
      <LedgerTable
        records={[
          {
            ...record,
            sourceId: undefined,
            details: {
              requestedModel: record.model,
              sentModel: record.model,
              responseModel: null,
              responseModelMismatch: null,
              requestedReasoningEffort: requested,
              reasoningEffort: actual,
              durationMs: null,
              firstTokenMs: null,
            },
          },
        ]}
        total={1}
        pageIndex={0}
        onPage={() => {}}
        sorting={{ id: "occurredAt", desc: true }}
        onSorting={() => {}}
        accounts={[]}
        onSelect={() => {}}
        search=""
        onSearch={() => {}}
        usdBasis="api"
      />,
    );
    const mobile =
      html.match(
        /<button[^>]*class="mobile-request-item"[\s\S]*?<\/button>/,
      )?.[0] ?? "";
    expect(mobile).toContain('class="mobile-request-model"');
    expect(mobile).toContain(
      `class="mobile-request-account" title="${record.accountId}">${record.accountId}</span>`,
    );
    expect(mobile).not.toContain("账户");
    expect(mobile.indexOf("<strong>")).toBeLessThan(mobile.indexOf("<time"));
    if (expected === "N/A") {
      expect(mobile).not.toContain('class="mobile-request-effort"');
      expect(mobile).not.toContain("N/A");
    } else {
      expect(mobile).toContain(
        `aria-label="推理强度：${expected}">${expected}</span>`,
      );
    }
    expect(mobile).not.toContain(">effort<");
    expect(mobile).not.toContain('title="来源"');
    expect(html).toContain("推理强度");
  },
);
