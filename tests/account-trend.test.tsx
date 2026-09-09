import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountTrend,
  MiniTrend,
  accountTrendCaption,
  selectAccountTrendPoints,
} from "../src/web/components/AccountTrend";
import {
  createLedgerView,
  selectUsdView,
  withUsdVariants,
  type LedgerView,
} from "../src/shared/ledger-view";
import { createDemoLedger } from "../src/web/demo/ledger";

const viewQuery = {
  filter: { days: 7, model: "all", account: "all", search: "" },
  unit: "tokens" as const,
  granularity: "hour" as const,
  dimension: "hour" as const,
  page: 0,
  pageSize: 1,
  sort: "occurredAt",
  desc: true,
};

function trendView(usdBasis: "api" | "subscription" = "subscription") {
  const view = createLedgerView(createDemoLedger(usdBasis), viewQuery);
  const points: LedgerView["view"]["points"] = [
    {
      at: Date.parse("2026-09-08T00:00:00Z"),
      value: 120,
      count: 3,
      incomplete: 0,
    },
    {
      at: Date.parse("2026-09-08T01:00:00Z"),
      value: null,
      count: 2,
      incomplete: 1,
    },
  ];
  const usdPoints = points.map((point) => ({
    ...point,
    value: point.value === null ? null : usdBasis === "api" ? 9 : 3,
  }));
  return {
    ...view,
    view: {
      ...view.view,
      units: {
        ...view.view.units,
        tokens: { ...view.view.units.tokens, points },
        usd: { ...view.view.units.usd, points: usdPoints },
      },
    },
  };
}

test("account trend requests use token point counts and preserve null gaps", () => {
  const view = trendView();
  const points = selectAccountTrendPoints(view, "requests");

  expect(points.map((point) => point.count)).toEqual([3, 2]);
  expect(points.map((point) => point.value)).toEqual([120, null]);
  expect(accountTrendCaption("usd")).toBe("近7天 · 每小时 USD");
});

test("MiniTrend is a display-only component with an optional hidden caption", () => {
  const html = renderToStaticMarkup(
    <MiniTrend
      points={trendView().view.units.tokens.points}
      metric="requests"
      label="账户请求趋势"
      hideCaption
      tone="purple"
    />,
  );

  expect(html).toContain('data-metric="requests"');
  expect(html).toContain('data-tone="purple"');
  expect(html).toContain('title="账户请求趋势"');
  expect(html).toContain('aria-label="账户请求趋势，真实报表趋势，非预测曲线"');
  expect(html).not.toContain('class="mini-trend-caption"');
});

test("AccountTrend reuses the account key while selecting the requested USD variant", () => {
  const subscription = trendView("subscription");
  const api = trendView("api");
  const raw = withUsdVariants(subscription, api, "subscription");
  expect(
    selectAccountTrendPoints(selectUsdView(raw, "api"), "usd")[0]?.value,
  ).toBe(9);
  const client = new QueryClient();
  const key = ["ledger", "account-trend", "account-a"] as const;
  client.setQueryData<LedgerView>(key, raw);

  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AccountTrend
        accountId="account-a"
        load={async () => raw}
        metric="usd"
        usdBasis="api"
      />
    </QueryClientProvider>,
  );

  expect(client.getQueryData<LedgerView>(key)).toBe(raw);
  expect(html).toContain('data-metric="usd"');
  expect(html).toContain("近7天 · 每小时 USD");
  expect(html).not.toContain("读取中");
});

test("AccountTrend does not render another account's cached trend while loading", () => {
  const client = new QueryClient();
  client.setQueryData(["ledger", "account-trend", "account-a"], trendView());

  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AccountTrend accountId="account-b" load={async () => trendView()} />
    </QueryClientProvider>,
  );

  expect(html).toContain("读取中…");
  expect(html).not.toContain('data-metric="tokens"');
});
