import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountWindow, LedgerAccount } from "../src/shared/report";
import { MobileHome } from "../src/web/components/MobileHome";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createLedgerView } from "../src/shared/ledger-view";
import { quotaLabel } from "../src/web/lib/quota-display";

const asOf = "2026-09-08T16:00:00+08:00";

type QuotaEstimate = NonNullable<AccountWindow["estimate"]>;

function quotaEstimate(overrides: Partial<QuotaEstimate> = {}): QuotaEstimate {
  return {
    usd: "1481.58",
    credits: "37039.57",
    deltaPercent: null,
    reason: "eligible",
    ...overrides,
  };
}

function quotaWindow(overrides: Partial<AccountWindow> = {}): AccountWindow {
  return {
    percent: 32,
    resetsAt: "2026-09-15T13:43:00+08:00",
    sampledAt: asOf,
    state: "active",
    periodUsd: "31.85",
    periodTokens: 22_980_000,
    periodRequests: 193,
    estimate: quotaEstimate(),
    ...overrides,
  };
}

function accountFixture(overrides: Partial<LedgerAccount> = {}): LedgerAccount {
  return {
    id: "pro",
    name: "Pro",
    plan: "Pro",
    kind: "subscription",
    sampledAt: asOf,
    fiveHour: null,
    sevenDay: null,
    ...overrides,
  };
}

function renderHome(values: (number | null)[], accounts: LedgerAccount[] = []) {
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
      accounts={accounts}
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

function accountCard(html: string) {
  return (
    html.match(
      /<button type="button" class="mobile-home-account-card"[\s\S]*?<\/button>/,
    )?.[0] ?? ""
  );
}

function estimateMarkup(html: string) {
  return (
    html.match(
      /<([a-z]+)\b[^>]*quota-window-estimate[^>]*>[\s\S]*?<\/\1>/,
    )?.[0] ?? ""
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

test("home hides the seven-day estimate when the quota is exhausted", () => {
  const account = accountFixture({
    fiveHour: quotaWindow({ percent: 40 }),
    sevenDay: quotaWindow({
      percent: 100,
      periodUsd: "844.5",
      estimate: quotaEstimate({ usd: "1481.58" }),
    }),
  });
  const html = renderHome([], [account]);

  expect(html).toContain("7d");
  expect(html).not.toContain("5h");
  expect(html).toContain(quotaLabel(account.sevenDay, asOf));
  expect(html).not.toContain("7d已用尽");
  expect(html).toContain('data-exhausted="true"');
  expect(html).toContain('data-quota-count="1"');
  expect((html.match(/quota-window-estimate/g) ?? []).length).toBe(0);
  expect(html).toContain("$844.50");
  expect(html).not.toContain("$1,481.58");
  expect(html).not.toContain('title="7d 预估"');
  expect(html).not.toContain("quota-cost-separator");
});

test("home renders both valid quota windows with explicit period labels", () => {
  const account = accountFixture({
    fiveHour: quotaWindow({ percent: 7 }),
    sevenDay: quotaWindow({
      percent: 32,
      periodUsd: "844.5",
      estimate: quotaEstimate({ usd: "1481.58" }),
    }),
  });
  const html = renderHome([], [account]);

  expect((html.match(/class="quota-window"/g) ?? []).length).toBe(2);
  expect(html).toContain("5h");
  expect(html).toContain("7d");
  expect(html).toContain('data-count="2"');
  expect((html.match(/quota-window-estimate/g) ?? []).length).toBe(1);
  expect(html).toContain("$844.50");
  expect(html).toContain("$1,481.58");

  const estimate = estimateMarkup(html);
  expect(estimate).toContain('title="7d 预估"');
  // 预估单独成行，费用行只保留金额与 Tokens、请求数，窄屏不会把用量挤到第二行。
  expect(estimate.replace(/<[^>]+>/g, "")).toBe("本周预估 $1,481.58");
  expect(html).not.toContain("quota-cost-pair");
});

test("home keeps an unavailable five-hour window as a waiting slot without old values", () => {
  const account = accountFixture({
    fiveHour: quotaWindow({ percent: null }),
    sevenDay: quotaWindow({ percent: 64 }),
  });
  const html = renderHome([], [account]);
  const card = accountCard(html);

  expect((card.match(/class="quota-window"/g) ?? []).length).toBe(2);
  expect(card).toContain('data-waiting="true"');
  expect(card).toContain("等待更新");
  expect(card).not.toContain("N/A");
});

test("home shows N/A when a valid seven-day quota has no estimate", () => {
  const account = accountFixture({
    sevenDay: quotaWindow({ estimate: undefined }),
  });
  const card = accountCard(renderHome([], [account]));

  expect(card).toContain("quota-window-estimate");
  expect(card).toContain('title="7d 预估"');
  expect(card).toContain("N/A");
});

test("home omits the estimate group without a valid seven-day quota", () => {
  const fiveHourOnly = accountFixture({
    id: "five-hour",
    fiveHour: quotaWindow(),
    sevenDay: null,
  });
  const expiredSevenDay = accountFixture({
    id: "expired-seven-day",
    fiveHour: null,
    sevenDay: quotaWindow({
      resetsAt: "2026-09-08T15:59:59+08:00",
    }),
  });
  const api = accountFixture({
    id: "api",
    name: "API",
    plan: "API",
    kind: "api",
  });
  const html = renderHome([], [fiveHourOnly, expiredSevenDay, api]);

  expect(html).not.toContain("quota-window-estimate");
});

test("home marks unavailable subscription windows and preserves account entry", () => {
  const expired = accountFixture({
    id: "expired",
    name: "Expired Pro",
    fiveHour: quotaWindow({
      resetsAt: "2026-09-08T15:59:59+08:00",
    }),
    sevenDay: null,
  });
  const unknown = accountFixture({
    id: "unknown",
    name: "Unknown Pro",
    sampledAt: null,
    fiveHour: null,
    sevenDay: quotaWindow({ percent: null, state: "unknown" }),
  });
  const html = renderHome([], [expired, unknown]);

  expect(html).toContain('aria-label="查看 Expired Pro 账户额度"');
  expect(html).toContain('aria-label="查看 Unknown Pro 账户额度"');
  expect(html).not.toContain("请求用量");
  // 有过采样的账户给出最近采样时刻，从未采样的账户不暗示存在旧值。
  expect(html).toContain("额度数据已过期，最近更新于");
  expect(html).toContain("暂未收到额度数据");
  expect(html).not.toContain("0 Tokens");
});

test("home keeps a quota-less API account on the request entry", () => {
  const account = accountFixture({
    id: "api",
    name: "API",
    plan: "API",
    kind: "api",
  });
  const html = renderHome([], [account]);

  expect(html).toContain('aria-label="查看 API 请求用量"');
  expect(html).toContain("API");
});

test("home adds the Fable weekly quota as its own row with a Fable-only estimate", () => {
  const account = accountFixture({
    fiveHour: quotaWindow({ percent: 10 }),
    sevenDay: quotaWindow({ percent: 36 }),
    sevenDayFable: quotaWindow({
      percent: 12,
      periodUsd: "40",
      estimate: quotaEstimate({ usd: "333.33" }),
    }),
  });
  const card = accountCard(renderHome([], [account]));

  expect((card.match(/class="quota-window"/g) ?? []).length).toBe(3);
  expect(card).toContain('data-quota-count="3"');
  expect(card).toContain('aria-label="Fable额度使用情况"');
  expect(card).toContain('title="Fable 预估"');
  expect(card).toContain("$333.33");
});

test("home hides the Fable row when upstream reports none or the whole week is exhausted", () => {
  const withoutFable = accountCard(
    renderHome([], [accountFixture({ sevenDay: quotaWindow() })]),
  );
  expect(withoutFable).not.toContain("Fable");

  const exhausted = accountCard(
    renderHome(
      [],
      [
        accountFixture({
          fiveHour: quotaWindow({ percent: 10 }),
          sevenDay: quotaWindow({ percent: 100 }),
          sevenDayFable: quotaWindow({ percent: 12 }),
        }),
      ],
    ),
  );
  expect(exhausted).toContain('data-quota-count="1"');
  expect(exhausted).not.toContain("Fable");
});
