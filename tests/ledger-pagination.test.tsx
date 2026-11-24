import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getLedgerPageItems,
  LedgerTable,
  type LedgerPageItem,
} from "../src/web/components/LedgerTable";
import {
  applyLedgerColumnPreset,
  defaultColumnsForTier,
  emptyLedgerColumnOverrides,
  ledgerColumnPresets,
  ledgerWidthTier,
  resolveVisibleLedgerColumns,
  toggleLedgerColumnOverride,
} from "../src/web/lib/ledger-columns";
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
    />,
  );
  const pageMarkup =
    html.match(/<nav class="ledger-page-numbers"[\s\S]*?<\/nav>/)?.[0] ?? "";

  expect(html).toContain('class="ledger-page-summary mobile-only"');
  expect(html).toContain("费用");
  expect(html).not.toContain("USD 估值");
  expect(html).not.toContain("订阅等价");
  expect(html).not.toContain("标准 API");
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

test("ledger table and mobile list render per-request cache hit rate and keep unknowns as N/A", () => {
  const base = createDemoLedger("api").records[0]!;
  const html = renderToStaticMarkup(
    <LedgerTable
      records={[
        {
          ...base,
          id: "req-hit",
          input: 100,
          cacheRead: 300,
          cacheWrite: 0,
        },
        {
          ...base,
          id: "req-zero",
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          ...base,
          id: "req-unknown",
          input: 100,
          cacheRead: 200,
          cacheWrite: null,
        },
      ]}
      total={3}
      pageIndex={0}
      onPage={() => {}}
      sorting={{ id: "cacheRate", desc: true }}
      onSorting={() => {}}
      accounts={[]}
      onSelect={() => {}}
      search=""
      onSearch={() => {}}
    />,
  );
  const tableRows = html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "";
  const mobileItems = [
    ...html.matchAll(
      /<button[^>]*class="mobile-request-item"[\s\S]*?<\/button>/g,
    ),
  ].map((match) => match[0]);

  expect(html).toContain("缓存命中率");
  expect(tableRows).toContain("75.0%");
  expect(mobileItems).toHaveLength(3);
  expect(mobileItems[0]).toContain(
    'aria-label="缓存命中率：75.0%">命中 75.0%</span>',
  );
  expect(mobileItems[1]).not.toContain('class="mobile-request-cache"');
  expect(mobileItems[1]).not.toContain("N/A");
  expect(mobileItems[2]).not.toContain('class="mobile-request-cache"');
  expect(mobileItems[2]).not.toContain("N/A");
});

test("ledger table renders first token latency and duration in seconds, supports column visibility and stepped page size", () => {
  const base = createDemoLedger("api").records[0]!;
  const html = renderToStaticMarkup(
    <LedgerTable
      records={[
        {
          ...base,
          id: "req-sec-1",
          details: {
            requestedModel: base.model,
            sentModel: base.model,
            responseModel: null,
            responseModelMismatch: null,
            requestedReasoningEffort: null,
            reasoningEffort: null,
            durationMs: 12346,
            firstTokenMs: 6727,
          },
        },
        {
          ...base,
          id: "req-sec-2",
          details: {
            requestedModel: base.model,
            sentModel: base.model,
            responseModel: null,
            responseModelMismatch: null,
            requestedReasoningEffort: null,
            reasoningEffort: null,
            durationMs: 1200,
            firstTokenMs: 0,
          },
        },
        {
          ...base,
          id: "req-sec-tiny",
          details: {
            requestedModel: base.model,
            sentModel: base.model,
            responseModel: null,
            responseModelMismatch: null,
            requestedReasoningEffort: null,
            reasoningEffort: null,
            durationMs: 3,
            firstTokenMs: 850,
          },
        },
        {
          ...base,
          id: "req-sec-null",
          details: {
            requestedModel: base.model,
            sentModel: base.model,
            responseModel: null,
            responseModelMismatch: null,
            requestedReasoningEffort: null,
            reasoningEffort: null,
            durationMs: null,
            firstTokenMs: null,
          },
        },
      ]}
      total={240}
      pageIndex={0}
      pageSize={50}
      onPage={() => {}}
      onPageSize={() => {}}
      sorting={{ id: "durationMs", desc: true }}
      onSorting={() => {}}
      hiddenColumns={["reasoningEffort", "cacheRead"]}
      onHiddenColumns={() => {}}
      accounts={[]}
      onSelect={() => {}}
      search=""
      onSearch={() => {}}
    />,
  );
  const thead = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
  const tbody = html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "";

  expect(thead).toContain("首字延迟");
  expect(thead).toContain('title="首 Token 延迟（TTFT）"');
  expect(thead).toContain("总耗时");
  expect(thead).not.toContain('data-column-id="reasoningEffort"');
  expect(thead).not.toContain('data-column-id="cacheRead"');
  expect(tbody).toContain("6.73 s");
  expect(tbody).toContain("0 s");
  expect(tbody).toContain("0.85 s");
  expect(tbody).toContain("12.35 s");
  expect(tbody).toContain("1.2 s");
  expect(tbody).toContain("&lt;0.01 s");
  expect(tbody).toContain("N/A");
  expect(html).toContain("显示列 (9/11)");
  expect(html).toContain('aria-label="每页行数"');
  expect(html).toContain("每页 50 条");
  expect(html).toContain("第 1 / 5 页");
  expect(html).toContain("共 240 条记录");
});

test("ledger width tiers and incremental column overrides stay responsive without cross-tier pollution", () => {
  expect(ledgerWidthTier(1240)).toBe("xl");
  expect(ledgerWidthTier(1048)).toBe("l");
  expect(ledgerWidthTier(903)).toBe("m");
  expect(ledgerWidthTier(780)).toBe("s");
  expect(ledgerWidthTier(600)).toBe("sm");
  expect(ledgerWidthTier(393)).toBe("xs");
  expect(ledgerWidthTier(0)).toBe("l");

  expect(defaultColumnsForTier("xl")).toHaveLength(11);
  expect(defaultColumnsForTier("l")).toHaveLength(11);
  expect(defaultColumnsForTier("m")).toHaveLength(9);
  expect(defaultColumnsForTier("m")).not.toContain("reasoningEffort");
  expect(defaultColumnsForTier("m")).not.toContain("cacheRead");
  expect(defaultColumnsForTier("s")).toHaveLength(7);
  expect(defaultColumnsForTier("sm")).toEqual([
    "occurredAt",
    "model",
    "input",
    "cacheRate",
    "usd",
  ]);
  expect(defaultColumnsForTier("xs")).toEqual(["occurredAt", "model", "usd"]);

  // 在 m 档开启缓存读取只记录 show 增量，不影响其他列在不同档位的自适应默认。
  const showedCacheRead = toggleLedgerColumnOverride(
    "m",
    emptyLedgerColumnOverrides,
    "cacheRead",
    true,
  );
  expect(showedCacheRead).toEqual({ show: ["cacheRead"], hide: [] });
  expect(resolveVisibleLedgerColumns("m", showedCacheRead)).toContain(
    "cacheRead",
  );
  expect(resolveVisibleLedgerColumns("s", showedCacheRead)).toContain(
    "cacheRead",
  );
  expect(resolveVisibleLedgerColumns("s", showedCacheRead)).not.toContain(
    "durationMs",
  );

  // 不能隐藏最后一个可见列。
  const onlyUsd = toggleLedgerColumnOverride(
    "xs",
    { show: [], hide: ["occurredAt", "model"] },
    "usd",
    false,
  );
  expect(resolveVisibleLedgerColumns("xs", onlyUsd)).toEqual(["usd"]);

  // 预设应用准确映射到目标列集合。
  const perfPreset = ledgerColumnPresets.find((p) => p.id === "performance")!;
  const perfOverrides = applyLedgerColumnPreset("l", perfPreset.columns);
  expect(resolveVisibleLedgerColumns("l", perfOverrides)).toEqual([
    ...perfPreset.columns,
  ]);
});

test("narrow width tiers fold reasoning effort inline, shorten headers, and show mobile sort feedback", () => {
  const base = createDemoLedger("api").records[0]!;
  const record = {
    ...base,
    id: "req-inline-effort",
    details: {
      requestedModel: base.model,
      sentModel: base.model,
      responseModel: null,
      responseModelMismatch: null,
      requestedReasoningEffort: "high",
      reasoningEffort: "xhigh",
      durationMs: 14250,
      firstTokenMs: 1850,
    },
  };

  const sHtml = renderToStaticMarkup(
    <LedgerTable
      records={[record]}
      total={1}
      pageIndex={0}
      onPage={() => {}}
      sorting={{ id: "durationMs", desc: true }}
      onSorting={() => {}}
      widthTier="s"
      columnOverrides={emptyLedgerColumnOverrides}
      onColumnOverrides={() => {}}
      accounts={[]}
      onSelect={() => {}}
      search=""
      onSearch={() => {}}
    />,
  );
  const sThead = sHtml.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
  const sTbody = sHtml.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "";
  const mobileItem =
    sHtml.match(
      /<button[^>]*class="mobile-request-item"[\s\S]*?<\/button>/,
    )?.[0] ?? "";

  expect(sHtml).toContain('data-width-tier="s"');
  expect(sThead).toContain("命中率");
  expect(sThead).not.toContain('data-column-id="reasoningEffort"');
  expect(sTbody).toContain('class="model-cell-inline"');
  expect(sTbody).toContain(
    '<span class="effort-badge" title="推理强度">xhigh</span>',
  );
  expect(sHtml).toContain("显示列 (7/11)");
  expect(sHtml).toContain('class="mobile-sort-pill"');
  expect(sHtml).toContain("耗时 ↓");
  expect(mobileItem).toContain("mobile-request-sort-metric");
  expect(mobileItem).toContain("耗时 14.25 s");

  const emptyFilteredHtml = renderToStaticMarkup(
    <LedgerTable
      records={[]}
      total={0}
      pageIndex={0}
      onPage={() => {}}
      sorting={{ id: "occurredAt", desc: true }}
      onSorting={() => {}}
      hasActiveFilters={true}
      onResetFilters={() => {}}
      accounts={[]}
      onSelect={() => {}}
      search=""
      onSearch={() => {}}
    />,
  );
  expect(emptyFilteredHtml).toContain("清除筛选");
});
