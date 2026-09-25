import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountWindow, LedgerAccount } from "../src/shared/report";
import { MobileHome } from "../src/web/components/MobileHome";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createLedgerView } from "../src/shared/ledger-view";
import { quotaLabel } from "../src/web/lib/quota-display";
import type { UsageSummaryData } from "../src/web/components/UsageSummary";

const lifetimeSummary: UsageSummaryData = {
  tokens: 41_760_000_000,
  usd: 20_149.03,
  credits: null,
  requests: 288_729,
  cacheRate: 98.9,
  composition: {
    input: 400_000_000,
    cacheRead: 39_000_000_000,
    cacheWrite: 30_000_000,
    output: 90_000_000,
  },
  change: null,
  since: "2026-08-15T02:00:00.000Z",
  dailyUsd: 480,
  dailyTokens: 994_000_000,
  usdNote: "订阅等价",
};

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

function renderHome(
  summary: UsageSummaryData | null,
  accounts: LedgerAccount[] = [],
) {
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
      summary={summary}
      rangeLabel="历史至今"
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
      /<span class="quota-window-estimate"[^>]*>(?:[^<]|<(i|span)\b[^>]*>[^<]*<\/\1>)*<\/span>/,
    )?.[0] ?? ""
  );
}

test("home summary shows the selected range with its start and cache rate", () => {
  const html = renderHome(lifetimeSummary);
  expect(html).toContain("历史至今费用 · 订阅等价");
  expect(html).toContain("$20,149.03");
  expect(html).toContain("8/15 起 · 日均 $480.00");
  expect(html).toContain("98.9%");
  expect(html).toContain('aria-label="Tokens 构成"');
});

test("home range change replaces the start date with a comparison", () => {
  const html = renderHome({
    ...lifetimeSummary,
    change: { tokens: 12, usd: -21.94, requests: null },
    since: null,
  });
  expect(html).toContain("↓ 21.9% 环比");
  expect(html).not.toContain(" 起");
});

test("home without a summary shows placeholders instead of zero", () => {
  const html = renderHome(null);
  expect(html).toContain("…");
  expect(html).toContain("N/A");
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
  const html = renderHome(null, [account]);

  expect(html).toContain("7d");
  expect(html).not.toContain("5h");
  expect(html).toContain(quotaLabel(account.sevenDay, asOf));
  expect(html).not.toContain("7d已用尽");
  expect(html).toContain('data-exhausted="true"');
  expect(html).toContain('data-quota-count="1"');
  expect((html.match(/quota-window-estimate/g) ?? []).length).toBe(0);
  expect(html).toContain("$844.50");
  expect(html).not.toContain("$1,481.58");
  expect(html).not.toContain('aria-label="7d 预估"');
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
  const html = renderHome(null, [account]);

  expect((html.match(/class="quota-window"/g) ?? []).length).toBe(2);
  expect(html).toContain("5h");
  expect(html).toContain("7d");
  expect(html).toContain('data-count="2"');
  expect((html.match(/quota-window-estimate/g) ?? []).length).toBe(1);
  expect(html).toContain("$844.50");
  expect(html).toContain("$1,481.58");

  const estimate = estimateMarkup(html);
  expect(estimate).toContain('aria-label="7d 预估"');
  // 整周预估以“· $X”紧跟已用费用，不单独占行。
  expect(estimate.replace(/<[^>]+>/g, "")).toBe("·$1,481.58");
  expect(html).not.toContain("quota-cost-pair");
});

test("home keeps an unavailable five-hour window as a waiting slot without old values", () => {
  const account = accountFixture({
    fiveHour: quotaWindow({ percent: null }),
    sevenDay: quotaWindow({ percent: 64 }),
  });
  const html = renderHome(null, [account]);
  const card = accountCard(html);

  expect((card.match(/class="quota-window"/g) ?? []).length).toBe(2);
  expect(card).toContain('data-waiting="true"');
  expect(card).toContain("等待更新");
  expect(card).not.toContain("N/A");
});

test("home omits the fraction when a valid seven-day quota has no estimate", () => {
  const account = accountFixture({
    sevenDay: quotaWindow({ estimate: undefined }),
  });
  const card = accountCard(renderHome(null, [account]));

  // 未知预估不写成“· N/A”，也不补零；详情页仍显示 N/A。
  expect(card).not.toContain("quota-window-estimate");
  expect(card).not.toContain("N/A");
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
  const html = renderHome(null, [fiveHourOnly, expiredSevenDay, api]);

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
  const html = renderHome(null, [expired, unknown]);

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
  const html = renderHome(null, [account]);

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
  const card = accountCard(renderHome(null, [account]));

  expect((card.match(/class="quota-window"/g) ?? []).length).toBe(3);
  expect(card).toContain('data-quota-count="3"');
  expect(card).toContain('aria-label="Fable额度使用情况"');
  expect(card).toContain('aria-label="Fable 预估"');
  expect(card).toContain("$333.33");
});

test("home hides the Fable row when upstream reports none or the whole week is exhausted", () => {
  const withoutFable = accountCard(
    renderHome(null, [accountFixture({ sevenDay: quotaWindow() })]),
  );
  expect(withoutFable).not.toContain("Fable");

  const exhausted = accountCard(
    renderHome(null, [
      accountFixture({
        fiveHour: quotaWindow({ percent: 10 }),
        sevenDay: quotaWindow({ percent: 100 }),
        sevenDayFable: quotaWindow({ percent: 12 }),
      }),
    ]),
  );
  expect(exhausted).toContain('data-quota-count="1"');
  expect(exhausted).not.toContain("Fable");
});
