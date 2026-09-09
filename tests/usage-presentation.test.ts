import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LedgerAccount, LedgerRecord } from "../src/shared/report";
import type { LedgerView } from "../src/shared/ledger-view";
import { createLedgerView } from "../src/shared/ledger-view";
import { MobileHome } from "../src/web/components/MobileHome";
import { ReportTable } from "../src/web/components/ReportTable";
import { UsageChart } from "../src/web/components/UsageChart";
import { createDemoLedger } from "../src/web/demo/ledger";
import { aggregateReport } from "../src/web/lib/report";

const emptyAccount: LedgerAccount = {
  id: "missing-account",
  name: "Missing",
  plan: "",
  kind: "unknown",
  sampledAt: null,
  fiveHour: null,
  sevenDay: null,
};

const records: LedgerRecord[] = [
  {
    id: "known",
    occurredAt: "2026-09-08T00:00:00.000Z",
    accountId: "account-a",
    model: "gpt-6-astra",
    input: 100,
    cacheRead: 20,
    cacheWrite: 5,
    output: 10,
    usd: "1.25",
    credits: "2.5",
    tier: "standard",
    quality: "estimated",
    priceVersion: "test",
  },
  {
    id: "missing",
    occurredAt: "2026-09-08T01:00:00.000Z",
    accountId: "account-b",
    model: "gpt-5.6-sol",
    input: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    usd: null,
    credits: null,
    tier: "unknown",
    quality: "unpriced",
    priceVersion: "test",
  },
];

function viewFixture() {
  return createLedgerView(createDemoLedger(), {
    filter: { days: 7, model: "all", account: "all", search: "" },
    unit: "tokens",
    granularity: "day",
    dimension: "day",
    page: 0,
    pageSize: 1,
    sort: "occurredAt",
    desc: true,
  });
}

function summary(value: number, hasKnown: boolean, incompleteRows = 0) {
  return {
    value,
    hasKnown,
    knownRows: hasKnown ? 1 : 0,
    incompleteRows,
  };
}

test("report table keeps values while removing incomplete and partial-value notes", () => {
  const html = renderToStaticMarkup(
    createElement(ReportTable, {
      data: aggregateReport(records, "model"),
      count: records.length,
      accounts: [],
      dimension: "model",
      onDimension: () => {},
    }),
  );

  expect(html).toContain("N/A");
  expect(html).toContain("$1.25");
  expect(html).toContain("1.25");
  expect(html).toContain("费用");
  expect(html).not.toContain("USD 估值");
  expect(html).not.toContain("Credits 估值");
  expect(html).not.toContain("订阅等价");
  expect(html).not.toContain("标准 API");
  expect(html).not.toContain("无已知值");
  expect(html).not.toContain("已计价小计");
  expect(html).not.toContain("字段不完整");
  expect(html).not.toContain("不完整");
  expect(html).not.toContain("—");
});

test("pie chart screen-reader data matches positive finite pie rows", () => {
  const breakdown: LedgerView["view"]["breakdown"] = [
    {
      model: "gpt-6-astra",
      count: 3,
      summary: summary(2, true, 1),
    },
    {
      model: "gpt-5.6-sol",
      count: 2,
      summary: summary(0, true),
    },
    {
      model: "gpt-5.6-terra",
      count: 1,
      summary: summary(-1, true),
    },
    {
      model: "gpt-5.6-luna",
      count: 4,
      summary: summary(Number.NaN, true),
    },
    {
      model: "unknown-model",
      count: 5,
      summary: summary(9, false),
    },
  ];
  const html = renderToStaticMarkup(
    createElement(UsageChart, {
      points: [
        {
          at: Date.parse("2026-09-08T00:00:00.000Z"),
          value: null,
          count: 2,
          incomplete: 1,
        },
      ],
      breakdown,
      unit: "usd",
      granularity: "day",
      dark: false,
      chartStyle: "pie",
    }),
  );
  const srOnly = html.match(/<dl class="sr-only"[\s\S]*?<\/dl>/)?.[0] ?? "";

  expect(srOnly).toContain("GPT 6 Astra");
  expect(srOnly).not.toContain("GPT 5.6 Sol");
  expect(srOnly).not.toContain("GPT 5.6 Terra");
  expect(srOnly).not.toContain("GPT 5.6 Luna");
  expect(srOnly).not.toContain("Unknown-model");
  expect(srOnly).not.toContain("字段不完整");
  expect(srOnly).not.toContain("无已知值");
});

test("mobile home uses N/A for missing account and trend values", () => {
  const snapshot = viewFixture();
  const trendPoints: LedgerView["view"]["points"] = [
    {
      at: Date.parse(snapshot.asOf),
      value: null,
      count: 1,
      incomplete: 1,
    },
    {
      at: Date.parse(snapshot.asOf) - 86400000,
      value: Number.NaN,
      count: 1,
      incomplete: 1,
    },
  ];
  const html = renderToStaticMarkup(
    createElement(MobileHome, {
      snapshot,
      accounts: [emptyAccount],
      asOf: snapshot.asOf,
      trendPoints,
      onAccount: () => {},
      onRequests: () => {},
      onAllAccounts: () => {},
    }),
  );

  expect((html.match(/N\/A/g) ?? []).length).toBeGreaterThanOrEqual(5);
  expect(html).not.toContain("无已知值");
  expect(html).not.toContain("字段不完整");
  expect(html).not.toContain("—");
});
