import {
  chromium,
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { version } from "../package.json";
import type { LedgerSnapshot } from "../src/shared/report";
import { createDemoLedger } from "../src/web/demo/ledger";
import { aggregateReport, filterRecords } from "../src/web/lib/report";
import {
  createLedgerView,
  withUsdVariants,
  type ViewQuery,
} from "../src/shared/ledger-view";

function fixtureView(snapshot: LedgerSnapshot, url: URL) {
  const variant = (basis: "subscription" | "api") =>
    fixtureViewForBasis(
      {
        ...snapshot,
        usdBasis: basis,
        records: snapshot.records.map((record) => {
          const charge =
            basis === "api"
              ? record.valuation?.apiUsd
              : record.valuation?.subscriptionUsd;
          return {
            ...record,
            usd: charge ? charge.amount : record.usd,
            ...(record.valuation
              ? {
                  valuation: {
                    ...record.valuation,
                    usdBasis: basis,
                    usd: charge!,
                  },
                }
              : {}),
          };
        }),
      },
      url,
    );
  return withUsdVariants(
    variant("subscription"),
    variant("api"),
    snapshot.usdBasis ?? "subscription",
  );
}

function fixtureViewForBasis(snapshot: LedgerSnapshot, url: URL) {
  const q = url.searchParams;
  const result = createLedgerView(snapshot, {
    filter: {
      days: Number(q.get("days") ?? 7),
      dateRange: q.has("from")
        ? { from: q.get("from")!, to: q.get("to")! }
        : undefined,
      model: q.get("model") ?? "all",
      account: q.get("account") ?? "all",
      search: q.get("search") ?? "",
    },
    unit: (q.get("unit") as ViewQuery["unit"]) ?? "usd",
    granularity: (q.get("granularity") as ViewQuery["granularity"]) ?? "day",
    dimension: (q.get("dimension") as ViewQuery["dimension"]) ?? "day",
    page: Number(q.get("page") ?? 0),
    pageSize: Number(q.get("pageSize") ?? 12),
    sort: q.get("sort") ?? "occurredAt",
    desc: q.get("desc") !== "false",
  });
  // 全历史夹具不使用请求中的筛选条件，验证首页三层数据的边界。
  const total = aggregateReport(snapshot.records, "model");
  const sum = (field: "usd" | "apiUsd" | "subscriptionUsd" | "credits") =>
    String(total.reduce((value, row) => value + Number(row[field] ?? 0), 0));
  result.lifetimeTotals = {
    asOf: snapshot.asOf,
    from: snapshot.records.map((row) => row.occurredAt).sort()[0] ?? null,
    to: snapshot.asOf,
    count: snapshot.records.length,
    tokens: {
      input: total.reduce((value, row) => value + (row.input ?? 0), 0),
      cacheRead: total.reduce((value, row) => value + (row.cacheRead ?? 0), 0),
      cacheWrite: total.reduce(
        (value, row) => value + (row.cacheWrite ?? 0),
        0,
      ),
      output: total.reduce((value, row) => value + (row.output ?? 0), 0),
      total: total.reduce((value, row) => value + (row.tokens ?? 0), 0),
      incomplete: total.reduce((value, row) => value + row.incompleteTokens, 0),
    },
    usd: sum("usd"),
    apiUsd: sum("apiUsd"),
    subscriptionUsd: sum("subscriptionUsd"),
    credits: sum("credits"),
    incomplete: { usd: 0, apiUsd: 0, subscriptionUsd: 0, credits: 0 },
    usdBasis: snapshot.usdBasis ?? "subscription",
    priceVersion: "browser-fixture",
  };
  if (snapshot.mode === "demo") {
    result.records = result.records.map((record) => ({
      ...record,
      details: {
        requestedModel: "client-model-alias",
        sentModel: record.model,
        responseModel: "upstream-response-model",
        responseModelMismatch: true,
        requestedReasoningEffort: "max",
        reasoningEffort: "xhigh",
        durationMs: 1200,
        firstTokenMs: 0,
      },
    }));
  }
  return result;
}

// 浏览器生命周期由调用者管理；测试只操作已经分配给本任务的页面。
const endpoint = process.env.METERLEAF_CDP_URL;
const baseUrl = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4317/";
if (!endpoint)
  throw new Error(
    "METERLEAF_CDP_URL must point to an existing managed browser",
  );
const browser = await chromium.connectOverCDP(endpoint);
const taskPage = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(baseUrl));
if (!taskPage)
  throw new Error(
    "Open the task page with the browser manager before running this check",
  );
const page: Page = taskPage;
page.setDefaultTimeout(10_000);
const errors: string[] = [];
const ledgerRequests: string[] = [];
const mainLedgerRequests: string[] = [];
const accountTrendRequests: string[] = [];

function isAccountTrendRequest(url: URL) {
  const query = url.searchParams;
  return (
    query.get("days") === "7" &&
    query.get("granularity") === "hour" &&
    query.get("pageSize") === "1" &&
    query.get("account") !== null &&
    query.get("account") !== "all"
  );
}

function isMainLedgerRequest(url: URL) {
  return !isAccountTrendRequest(url);
}

// 总览与统计报表共用同一个摘要条；四格依次为 Tokens、费用、请求、缓存命中率。
function summaryCell(currentPage: Page, index: number) {
  return currentPage
    .locator("section.usage-summary dl > div")
    .nth(index)
    .locator("dd");
}

// 交互断言与截图通道独立；截图被禁用时必须在验证结果中明示。
const capture = (options: Parameters<typeof page.screenshot>[0]) =>
  process.env.METERLEAF_SKIP_SCREENSHOTS === "true"
    ? Promise.resolve()
    : page.screenshot(options);
page.on("pageerror", (error) => errors.push(error.message));

async function expectWithinViewport(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Math.max(
          0,
          -bounds.top,
          -bounds.left,
          bounds.bottom - innerHeight,
          bounds.right - innerWidth,
        );
      }),
    )
    .toBeLessThanOrEqual(1);
}

async function openAboutPage(currentPage: Page) {
  const desktopLink = currentPage.getByRole("button", {
    name: `关于 Meterleaf ${version}`,
    exact: true,
  });
  if (await desktopLink.isVisible()) {
    await desktopLink.click();
    return;
  }
  const bottomAbout = currentPage
    .getByRole("navigation", { name: "底部导航", exact: true })
    .getByRole("button", { name: "关于", exact: true });
  if (await bottomAbout.isVisible()) {
    await bottomAbout.click();
    return;
  }
  await currentPage.goto(`${baseUrl}#settings`);
}

await mkdir("test-results", { recursive: true });

function createLiveUnknownSnapshot(
  usdBasis: "subscription" | "api",
): LedgerSnapshot {
  const demo = createDemoLedger(usdBasis);
  const unpricedCharge = {
    amount: null,
    basis: "unpriced" as const,
    reason: "missing-or-invalid-token-bucket",
    assumedStandard: true,
  };
  const unknownWindow = {
    percent: null,
    resetsAt: null,
    sampledAt: null,
    state: "unknown" as const,
    stale: true,
    periodUsd: null,
    periodCredits: null,
    estimate: {
      usd: null,
      credits: null,
      deltaPercent: null,
      reason: "percent-unavailable" as const,
    },
  };
  return {
    ...demo,
    mode: "live",
    usdBasis,
    accounts: [
      {
        id: "unknown",
        name: "Unknown Account",
        plan: "未提供",
        kind: "unknown",
        sampledAt: null,
        fiveHour: unknownWindow,
        sevenDay: unknownWindow,
      },
    ],
    records: [
      {
        ...demo.records[0]!,
        id: "live-source:unknown-1",
        sourceId: "live-source",
        sourceRecordId: "unknown-1",
        accountId: "unknown",
        input: null,
        cacheRead: 100,
        cacheWrite: null,
        output: null,
        usd: null,
        credits: null,
        tier: "unknown",
        quality: "unpriced",
        priceVersion: "live-v1",
        gatewayCost: null,
        gatewayBilled: "0.2",
        valuation: {
          version: "live-v1",
          usdBasis,
          usd: unpricedCharge,
          apiUsd: unpricedCharge,
          subscriptionUsd: unpricedCharge,
          credits: unpricedCharge,
        },
      },
    ],
    resets: [],
    sync: {
      lastSuccess: "2026-09-08T15:55:00Z",
      error: "source-sync-failed",
      initialComplete: false,
      lastSweep: null,
    },
  };
}

const savedPreferences = await page.evaluate(() =>
  Object.fromEntries(
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith("meterleaf-"),
    ),
  ),
);
try {
  let holdDateResponse = false;
  let releaseDateResponse: (() => void) | undefined;
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("meterleaf-")) localStorage.removeItem(key);
    localStorage.removeItem("meterleaf-usd-basis");
    localStorage.setItem("meterleaf-theme", "light");
    localStorage.setItem("meterleaf-palette", "green");
    // 该套检查覆盖可选侧栏布局；App 的五导航与手机筛选由独立浏览器套件覆盖。
    localStorage.setItem(
      "meterleaf-pref-mobile-layout",
      JSON.stringify("sidebar"),
    );
  });
  await page.route("**/api/view**", async (route) => {
    const url = new URL(route.request().url());
    ledgerRequests.push(url.toString());
    if (isAccountTrendRequest(url)) accountTrendRequests.push(url.toString());
    else mainLedgerRequests.push(url.toString());
    if (
      holdDateResponse &&
      url.searchParams.get("from") === "2026-09-02" &&
      url.searchParams.get("to") === "2026-09-04"
    ) {
      await new Promise<void>((resolve) => {
        releaseDateResponse = resolve;
      });
    }
    const requestedBasis = url.searchParams.get("usdBasis");
    const usdBasis =
      requestedBasis === "api" || requestedBasis === "subscription"
        ? requestedBasis
        : "api";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureView(createDemoLedger(usdBasis), url)),
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl);
  await page.reload();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/favicon.svg",
  );
  const favicon = await page.request.get(
    new URL("/favicon.svg", baseUrl).toString(),
  );
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()["content-type"]).toContain("image/svg+xml");
  await expect(
    page.getByRole("heading", { name: "用量总览", exact: true }),
  ).toBeVisible();
  expect(mainLedgerRequests[0]).not.toContain("usdBasis=");
  // 总览默认看历史至今：日期入口、摘要条和趋势副标题使用同一范围名称。
  const overviewDate = page.getByRole("button", {
    name: "日期范围",
    exact: true,
  });
  await expect(overviewDate).toContainText("历史至今");
  const lifetimeSummary = page.getByRole("region", {
    name: "历史至今用量摘要",
    exact: true,
  });
  await expect(lifetimeSummary).toBeVisible();
  await expect(lifetimeSummary).toContainText("日均");
  await expect(lifetimeSummary).toContainText(/\d{4}\/\d{2}\/\d{2} 起/);
  await expect(lifetimeSummary).not.toContainText("环比");
  await expect(lifetimeSummary.locator(".token-composition-bar")).toBeVisible();
  // 总览账户区承担额度展示和账户管理，按区块标题识别。
  const overviewAccounts = page.getByRole("region", {
    name: "账户额度",
    exact: true,
  });
  await expect(overviewAccounts).toBeVisible();
  const overviewTrendNote = page.locator(
    ".trend-panel .section-heading .muted",
  );
  await expect(overviewTrendNote).toHaveText("历史至今 · 按天汇总");
  await expect(
    page.locator(".desktop-period .trend-panel canvas"),
  ).toBeVisible();
  await expect(page.locator("dl.trend-insights")).toContainText("峰值天");
  await expect(page.locator("dl.trend-insights")).toContainText("活跃天数");
  // 旧的累计/时间段分页、固定 30 天趋势和时段指标卡都已并入总览。
  await expect(page.getByRole("navigation", { name: "总览视图" })).toHaveCount(
    0,
  );
  await expect(page.locator(".overview-history-trend")).toHaveCount(0);
  await expect(page.locator('[aria-label="用量摘要"] .metric')).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "模型筛选", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "账户筛选", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => accountTrendRequests.length).toBeGreaterThan(0);
  expect(
    accountTrendRequests.every((request) => {
      const url = new URL(request);
      return (
        url.searchParams.get("days") === "7" &&
        url.searchParams.get("granularity") === "hour" &&
        url.searchParams.get("pageSize") === "1" &&
        url.searchParams.get("account") !== "all"
      );
    }),
  ).toBe(true);
  expect(
    accountTrendRequests.map((request) =>
      new URL(request).searchParams.get("account"),
    ),
  ).toContain("api");
  // 总览只按时间查询：不带模型、账户筛选，也只取一行明细。
  expect(
    mainLedgerRequests.every((request) => {
      const url = new URL(request);
      return (
        url.searchParams.get("pageSize") === "1" &&
        url.searchParams.get("account") === "all" &&
        (url.searchParams.get("model") ?? "all") === "all"
      );
    }),
  ).toBe(true);
  // 历史至今在查询前换算为从账本首日开始的自然日范围。
  const demoStart = createDemoLedger()
    .records.map((row) => row.occurredAt)
    .sort()[0]!;
  const demoStartDay = new Date(Date.parse(demoStart) + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  await expect
    .poll(() =>
      mainLedgerRequests.some(
        (request) => new URL(request).searchParams.get("from") === demoStartDay,
      ),
    )
    .toBe(true);
  // 无额度账户在总览中展示累计用量，而不是额度窗口。
  const overviewDevelopment = overviewAccounts.getByRole("button", {
    name: /^Development API 接入/,
  });
  await expect(overviewDevelopment).toContainText("累计 Tokens");
  await expect(overviewDevelopment).toContainText("累计请求");
  await openAboutPage(page);
  await expect(page).toHaveURL(`${baseUrl}#settings`);
  await expect(page.locator(".about-page")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto(`${baseUrl}#overview`);
  await expect(page).toHaveURL(`${baseUrl}#overview`);
  const themeTrigger = page.getByRole("button", {
    name: "主题设置",
    exact: true,
  });
  const selectTheme = async (label: "外观" | "配色", option: string) => {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  await page.emulateMedia({ colorScheme: "light" });
  await themeTrigger.click();
  await selectTheme("外观", "跟随系统");
  await selectTheme("配色", "靛蓝");
  await page.keyboard.press("Escape");
  await expect(themeTrigger).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  await themeTrigger.click();
  await expect(
    page.getByRole("combobox", { name: "外观", exact: true }),
  ).toContainText("跟随系统");
  await selectTheme("外观", "浅色");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  await themeTrigger.click();
  await selectTheme("配色", "翠绿");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "green");
  await page.emulateMedia({ colorScheme: null });
  // 侧栏标记总览为当前页，口径切换在页面间保留。
  await page.goto(`${baseUrl}#overview`);
  await expect(
    page.getByRole("heading", { name: "用量总览", exact: true }),
  ).toBeVisible();
  await expect(lifetimeSummary).toBeVisible();
  await expect(page.locator(".desktop-period .trend-panel")).toBeVisible();
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: "用量总览", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", { name: "标准 API", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // 模型筛选只留在统计报表；下拉的键盘行为在那里检查。
  await page.getByRole("button", { name: "统计报表", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}#reports`);
  const modelSelect = page.getByRole("combobox", {
    name: "模型筛选",
    exact: true,
  });
  await modelSelect.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".filter-select-indicator")).toHaveCount(1);
  await expect(
    page.locator(
      '.filter-select-item[aria-selected="true"] .filter-select-indicator',
    ),
  ).toBeVisible();
  const keyboardOption = page.locator(".filter-select-item:focus-visible");
  await expect(keyboardOption).toHaveCount(1);
  await expect(keyboardOption).toHaveCSS("outline-width", "3px");
  await expect(keyboardOption).toHaveCSS("outline-offset", "-3px");
  for (const key of ["End", "Home"]) {
    await page.keyboard.press(key);
    await expect
      .poll(async () => {
        const trigger = await modelSelect.boundingBox();
        const popup = await page
          .locator(".filter-select-positioner")
          .boundingBox();
        if (!trigger || !popup) return Infinity;
        return Math.min(
          Math.abs(popup.y - (trigger.y + trigger.height + 6)),
          Math.abs(trigger.y - (popup.y + popup.height + 6)),
        );
      })
      .toBeLessThan(2);
  }
  await page.keyboard.press("Escape");
  await expect(modelSelect).toBeFocused();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}#overview`);
  await overviewDevelopment.click();
  await expect(page).toHaveURL(`${baseUrl}#ledger`);
  await expect(
    page.getByRole("combobox", { name: "账户筛选", exact: true }),
  ).toContainText("Development");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toContainText("Development");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 256 });
  for (const [name, selector, control] of [
    [
      "日期范围",
      ".date-range-popup",
      page.getByLabel("结束日期", { exact: true }),
    ],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await expectWithinViewport(page.locator(selector));
    await control.focus();
    await expectWithinViewport(control);
    await page.keyboard.press("Escape");
    await expect(page.locator(selector)).toHaveCount(0);
  }
  await openAboutPage(page);
  await expect(page).toHaveURL(`${baseUrl}#settings`);
  const compactAbout = page.locator(".about-page");
  await expect(compactAbout).toBeVisible();
  const compactTheme = compactAbout.getByRole("button", {
    name: "浅色",
    exact: true,
  });
  await compactTheme.focus();
  await expectWithinViewport(compactTheme);
  await compactTheme.click();
  await page.goto(`${baseUrl}#overview`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const summaryCredits = page.locator("section.usage-summary .summary-credits");
  const apiTokens = await summaryCell(page, 0).innerText();
  const apiUsd = await summaryCell(page, 1).innerText();
  const apiCredits = await summaryCredits.innerText();
  const apiRequests = await summaryCell(page, 2).innerText();
  const beforeBasisSwitch = mainLedgerRequests.length;
  await page.getByRole("button", { name: "订阅等价", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "订阅等价", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => summaryCell(page, 1).innerText()).not.toBe(apiUsd);
  await expect(page.locator("section.usage-summary")).toContainText("订阅等价");
  expect(await summaryCredits.innerText()).toBe(apiCredits);
  expect(await summaryCell(page, 0).innerText()).toBe(apiTokens);
  expect(await summaryCell(page, 2).innerText()).toBe(apiRequests);
  expect(
    mainLedgerRequests.some((request) => request.includes("usdBasis=")),
  ).toBe(false);
  expect(mainLedgerRequests.length).toBe(beforeBasisSwitch);
  await expect(page.locator(".trend-panel canvas")).toBeVisible();
  await expect(page.locator(".overview-donut canvas")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>(
          ".trend-panel canvas",
        )!;
        const pixels = c
          .getContext("2d")!
          .getImageData(0, 0, c.width, c.height).data;
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i + 3]! > 0 && pixels[i + 2]! > pixels[i]! + 30) colored++;
        return colored;
      }),
    )
    .toBeGreaterThan(1000);
  await capture({
    path: "test-results/overview-desktop.png",
    fullPage: false,
  });
  for (const [name, style] of [
    ["折线图", "line"],
    ["面积图", "area"],
    ["饼图", "pie"],
    ["柱状图", "bar"],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator(".trend-panel [data-chart-style]"),
    ).toHaveAttribute("data-chart-style", style);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            ".trend-panel canvas",
          )!;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i + 3]! > 0 && pixels[i + 2]! > pixels[i]! + 30) count++;
          return count;
        }),
      )
      .toBeGreaterThan(1000);
    await capture({
      path: `test-results/chart-${style}.png`,
      fullPage: false,
    });
  }
  const requestsBeforeUnitSwitch = mainLedgerRequests.length;
  await page.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Tokens", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(100);
  expect(mainLedgerRequests.length).toBe(requestsBeforeUnitSwitch);
  await page.getByRole("button", { name: "周", exact: true }).click();
  await expect(overviewTrendNote).toHaveText("历史至今 · 自然周，周一起始");
  // 模型分布不再原地筛选总览，而是带着同一时间范围打开统计报表。
  await page
    .locator(".model-panel .model-breakdown button")
    .filter({ hasText: "GPT 5.6 Sol" })
    .click();
  await expect(page).toHaveURL(`${baseUrl}#reports`);
  await expect(page.getByRole("combobox", { name: "模型筛选" })).toContainText(
    "GPT 5.6 Sol",
  );
  await expect(
    page.getByRole("button", { name: "日期范围", exact: true }),
  ).toContainText("历史至今");
  await expect(
    page.getByRole("region", { name: "历史至今报表摘要", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".report-section tbody tr").first()).toBeVisible();
  await expect(summaryCell(page, 2)).not.toHaveText(apiRequests);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await page.getByRole("button", { name: /^Development API/ }).click();
  await expect(
    page.getByRole("heading", { name: "请求明细", level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "账户筛选" })).toContainText(
    "Development",
  );
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByRole("button", { name: "请求明细", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(12);
  await expect(
    page.getByRole("columnheader", { name: /时间/ }),
  ).toHaveAttribute("aria-sort", "descending");
  const firstId = await page.locator("tbody tr").first().innerText();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator("tbody tr").first()).not.toHaveText(firstId!);
  await expect(
    page.getByRole("button", { name: "第 2 页", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", { name: "第 102 页", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "费用", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: "费用", exact: true }),
  ).toHaveAttribute("aria-sort", /ascending|descending/);
  await expect(
    page.getByRole("columnheader", { name: /时间/ }),
  ).not.toHaveAttribute("aria-sort");
  await page.locator("tbody button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Token 拆分")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("client-model-alias");
  await expect(page.getByRole("dialog")).toContainText(
    "upstream-response-model",
  );
  await expect(page.getByRole("dialog")).toContainText("实际推理强度");
  await expect(
    page.getByRole("dialog").getByText("max", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("xhigh", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("0 ms", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const requestsBeforeTyping = mainLedgerRequests.length;
  const searchInput = page.getByRole("textbox", { name: "搜索请求" });
  await searchInput.pressSequentially("not-a-real-request");
  await expect(searchInput).toHaveValue("not-a-real-request");
  await expect(
    page.getByRole("heading", { name: "没有匹配的请求" }),
  ).toBeVisible();
  expect(
    mainLedgerRequests
      .slice(requestsBeforeTyping)
      .map((url) => new URL(url).searchParams.get("search"))
      .filter(Boolean),
  ).toEqual(["not-a-real-request"]);
  await expect(page.getByRole("button", { name: "导出 CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "清除搜索" }).click();
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await expect(page.locator(".account-capacity").first()).toContainText(
    "7d 预估",
  );
  await page.getByRole("button", { name: /^Personal Pro/ }).click();
  await expect(
    page.getByRole("dialog").getByText("7d 预估费用", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看账户请求" }).click();
  await expect(page.getByRole("combobox", { name: "账户筛选" })).toContainText(
    "Personal",
  );
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await page.getByRole("button", { name: "统计报表", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分组汇总" })).toBeVisible();
  for (const name of [
    "总 Tokens",
    "输入",
    "缓存读取",
    "缓存写入",
    "输出",
    "缓存命中率",
  ]) {
    await expect(
      page.getByRole("columnheader", { name, exact: true }),
    ).toBeVisible();
  }
  // 统计报表同样以摘要条开头，区间有上一等长时段可比时给出环比。
  const reportSummary = page.getByRole("region", {
    name: "近 7 天报表摘要",
    exact: true,
  });
  await expect(reportSummary).toBeVisible();
  await expect(reportSummary).toContainText("环比");
  await expect(reportSummary.locator(".token-composition-bar")).toBeVisible();
  const reportTotals = page.locator(".report-section tfoot tr");
  await expect(reportTotals).toHaveCount(1);
  await expect(
    reportTotals.getByRole("rowheader", { name: "合计", exact: true }),
  ).toBeVisible();
  await expect(reportTotals).toContainText(
    (await summaryCell(page, 2).innerText()).trim(),
  );
  await expect(reportTotals).toContainText(/\d+\.\d%/);
  await expect(page.getByRole("columnheader", { name: "完整性" })).toHaveCount(
    0,
  );
  await expect(page.locator(".report-section")).not.toContainText("档位未知");
  await expect(page.locator(".report-section")).not.toContainText(
    "条 USD 未计价",
  );
  await page.getByRole("region", { name: "汇总表格", exact: true }).focus();
  await expect(
    page.getByRole("region", { name: "汇总表格", exact: true }),
  ).toBeFocused();
  await page.getByRole("link", { name: "跳到主要内容" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${baseUrl}#reports`);
  const distribution = page.getByRole("region", {
    name: "模型分布",
    exact: true,
  });
  await expect(distribution.locator("canvas")).toBeVisible();
  for (const name of ["按 Tokens", "按费用"]) {
    await distribution.getByRole("button", { name, exact: true }).click();
    await expect(
      distribution.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await page.locator("main").focus();
  await expect(page.locator("main")).toBeFocused();
  await expect(page.getByRole("heading", { name: "消耗趋势" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "请求明细", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("group", { name: "汇总维度", exact: true })
    .getByRole("button", { name: "模型", exact: true })
    .click();
  await expect(page.locator(".report-section tbody tr")).toHaveCount(6);
  await expect(page.getByRole("button", { name: "导出 CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "账户", exact: true }).click();
  await expect(page.locator(".report-section tbody tr")).toHaveCount(4);
  await page.getByRole("button", { name: "小时", exact: true }).click();
  await expect(page.locator(".report-section tbody tr")).toHaveCount(12);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".pagination")).toContainText("第 2 /");
  await page.getByRole("button", { name: "自然周", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("第 1 /");
  await capture({
    path: "test-results/reports-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await expect(
    page
      .locator(".report-section")
      .getByRole("columnheader", { name: "费用", exact: true }),
  ).toBeAttached();
  await capture({
    path: "test-results/reports-mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  const quotaPreview = overviewAccounts;
  const lifetime = page.locator("section.usage-summary");
  await expect(lifetimeSummary).toBeVisible();
  const quotaWindows = quotaPreview.locator(
    '.account-row[data-has-quota="true"]',
  );
  await expect(quotaWindows).toHaveCount(3);
  const quotasBeforeDate = await quotaWindows.allTextContents();
  const periodAccount = overviewDevelopment;
  const periodBeforeDate = await periodAccount.textContent();
  const lifetimeBeforeDate = await lifetime.textContent();
  expect(
    (await page.locator("main h2").allTextContents()).map((text) =>
      text.trim(),
    ),
  ).toEqual(["账户额度", "消耗趋势", "模型分布"]);
  await expect(
    page.getByRole("heading", { name: "消耗趋势", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "USD", exact: true }).click();
  await page.getByRole("button", { name: "天", exact: true }).click();
  await page.getByRole("button", { name: "主题设置" }).click();
  await page.getByRole("combobox", { name: "外观" }).click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveClass("dark");
  await expect
    .poll(() =>
      page
        .getByRole("heading", { name: "用量总览", exact: true })
        .evaluate((button) => getComputedStyle(button).color),
    )
    .toBe("rgb(242, 242, 243)");
  await capture({
    path: "test-results/overview-dark.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "主题设置" }).click();
  await page.getByRole("combobox", { name: "外观" }).click();
  await page.getByRole("option", { name: "浅色", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await expect(page.locator(".trend-panel canvas")).toBeVisible();
  await capture({
    path: "test-results/overview-mobile.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "饼图", exact: true }).click();
  await expect(page.getByRole("heading", { name: "消耗占比" })).toBeVisible();
  await expect(page.getByRole("group", { name: "时间粒度" })).toHaveCount(0);
  await expect(page.locator(".trend-panel canvas")).toBeVisible();
  await capture({
    path: "test-results/pie-mobile.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "柱状图", exact: true }).click();
  const mobileMenu = page.getByRole("button", {
    name: "打开导航",
    exact: true,
  });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "用量总览", exact: true })
      .click();
  } else {
    const mobileNavigation = page.getByRole("navigation", {
      name: "底部导航",
      exact: true,
    });
    await expect(mobileNavigation).toBeVisible();
    await mobileNavigation
      .getByRole("button", { name: "首页", exact: true })
      .click();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "账户额度", exact: true }).first(),
  ).toBeVisible();
  // 窄屏侧栏布局仍在总览账户区提供排序和逐行管理菜单，不再有独立账户页入口。
  await expect(
    overviewAccounts.getByRole("button", { name: "调整账户顺序", exact: true }),
  ).toBeVisible();
  await expect(
    overviewAccounts.getByRole("button", { name: /账户操作$/ }),
  ).toHaveCount(4);
  await capture({
    path: "test-results/accounts-mobile.png",
    fullPage: false,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "应用", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("开始日期", { exact: true }).fill("2026-09-02");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByRole("button", { name: "刷新账本", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as { previousDateCanvas: Element | null }
    ).previousDateCanvas = document.querySelector(".trend-panel canvas");
  });
  const previousRequests = await summaryCell(page, 2).textContent();
  holdDateResponse = true;
  const customResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/view" &&
      url.searchParams.get("from") === "2026-09-02" &&
      url.searchParams.get("to") === "2026-09-04"
    );
  });
  await page.getByLabel("结束日期", { exact: true }).fill("2026-09-04");
  try {
    await expect.poll(() => Boolean(releaseDateResponse)).toBe(true);
    await expect(page.locator("#main-content")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.getByText("正在读取账本…", { exact: true })).toHaveCount(
      0,
    );
    await expect(summaryCell(page, 2)).toHaveText(previousRequests!);
    expect(
      await page.evaluate(
        () =>
          document.querySelector(".trend-panel canvas") ===
          (window as unknown as { previousDateCanvas: Element | null })
            .previousDateCanvas,
      ),
    ).toBe(true);
  } finally {
    holdDateResponse = false;
    releaseDateResponse?.();
  }
  await customResponse;
  // 换成自定义范围后，摘要条、趋势副标题和粒度随之更新并给出环比。
  const customTitle = "2026-09-02 ~ 2026-09-04";
  const customSummary = page.getByRole("region", {
    name: `${customTitle}用量摘要`,
    exact: true,
  });
  await expect(customSummary).toBeVisible();
  await expect(customSummary).toContainText("环比");
  await expect(customSummary).not.toContainText("日均");
  await expect(overviewTrendNote).toHaveText(`${customTitle} · 按天汇总`);
  await capture({
    path: "test-results/date-range-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await expect(page.getByLabel("结束日期", { exact: true })).toBeVisible();
  await capture({
    path: "test-results/date-range-mobile.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "关闭日期选择" }).click();
  await expect(page).toHaveURL(`${baseUrl}#overview`);
  // 额度行在窄屏改用紧凑布局；在记录基准的同一宽度下比较。额度与无额度账户的累计用量都不随日期筛选变化，摘要条随范围变化。
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(quotaWindows).toHaveText(quotasBeforeDate);
  await expect(periodAccount).toHaveText(periodBeforeDate!);
  await expect(lifetime).not.toHaveText(lifetimeBeforeDate!);
  await page.setViewportSize({ width: 390, height: 844 });
  const customRows = filterRecords(
    createDemoLedger().records,
    {
      days: 7,
      dateRange: { from: "2026-09-02", to: "2026-09-04" },
      model: "all",
      account: "all",
      search: "",
    },
    createDemoLedger().asOf,
  );
  await expect(summaryCell(page, 2)).toHaveText(
    customRows.length.toLocaleString("en-US"),
  );
  await expect(page.getByRole("button", { name: "导出 CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(summaryCell(page, 2)).toHaveText(
    customRows.length.toLocaleString("en-US"),
  );
  await page.getByRole("radio", { name: "近 7 天", exact: true }).click();
  await expect(summaryCell(page, 2)).toHaveText("1,215");
  await expect(
    page.getByRole("region", { name: "近 7 天用量摘要", exact: true }),
  ).toBeVisible();
  // 回到历史至今后，摘要重新读取全历史累计，且范围写入首页专属偏好。
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByRole("radio", { name: "历史至今", exact: true }).click();
  await expect(lifetimeSummary).toBeVisible();
  await expect(summaryCell(page, 2)).toHaveText(
    createDemoLedger().records.length.toLocaleString("en-US"),
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("meterleaf-report-filter-home"),
    ),
  ).toBe('{"days":30,"all":true,"model":"all","account":"all"}');
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByRole("radio", { name: "近 7 天", exact: true }).click();
  await expect(summaryCell(page, 2)).toHaveText("1,215");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.unroute("**/api/view**");
  await page.route("**/api/view**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "ledger-read-failed" }),
    });
  });
  await page.goto(`${baseUrl}#overview`);
  // 哈希导航不会重建页面；替换响应夹具后需要重载，不能复用上一种数据状态。
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "账本读取失败", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("演示数据", { exact: true })).toHaveCount(0);

  await page.unroute("**/api/view**");
  let removeUnknownRecord = false;
  await page.route("**/api/view**", async (route) => {
    const url = new URL(route.request().url());
    const usdBasis =
      url.searchParams.get("usdBasis") === "api" ? "api" : "subscription";
    const snapshot = createLiveUnknownSnapshot(usdBasis);
    if (removeUnknownRecord) snapshot.records = [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...fixtureView(snapshot, new URL(route.request().url())),
        reportStatus: { refreshing: !removeUnknownRecord, lastError: null },
      }),
    });
  });
  await page.evaluate(() => localStorage.removeItem("meterleaf-usd-basis"));
  await page.goto(`${baseUrl}#overview`);
  await page.reload();
  await expect(page.getByText("实时数据", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "近 7 天用量摘要", exact: true })
      .getByText("费用", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("已计价费用", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1 条未计价", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("NaN");
  await page.getByRole("button", { name: "标准 API", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "标准 API", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "请求明细", exact: true }).click();
  await page
    .getByRole("button", { name: /查看 live-source:unknown-1/ })
    .click();
  await expect(
    page.getByRole("dialog").getByText("live-source", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("网关计费", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.getByRole("dialog").press("Escape");
  const unknownTrigger = page.locator(
    '[data-request-id="live-source:unknown-1"]:visible',
  );
  await expect(unknownTrigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  // 详情打开期间的后台结果可能移除该行；关闭后仍须保留键盘操作位置。
  removeUnknownRecord = true;
  await expect(unknownTrigger).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "请求明细表格", exact: true }),
  ).toBeFocused();
  let syncPosts = 0;
  let syncState = {
    lastSuccess: null as string | null,
    lastAttempt: null as string | null,
    initialComplete: false,
    running: false,
    phase: "idle",
    localRecords: 0,
    autoEnabled: false,
    error: null as string | null,
    lastError: null as null | {
      id: string;
      stage: string;
      kind: string;
      code: string;
    },
  };
  await page.route("**/api/sync", async (route) => {
    if (route.request().method() === "POST") {
      syncPosts++;
      syncState = {
        ...syncState,
        lastAttempt: new Date().toISOString(),
        running: true,
        phase: "incremental",
        localRecords: 1000,
      };
    }
    await route.fulfill({
      status: route.request().method() === "POST" ? 202 : 200,
      contentType: "application/json",
      body: JSON.stringify(syncState),
    });
  });
  await page.route("**/api/sync/presence", (route) =>
    route.fulfill({ json: syncState }),
  );
  await page.reload();
  await page.getByRole("button", { name: "数据同步" }).click();
  await expect(page.locator(".sync-popup")).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(page.locator(".sync-popup")).toHaveCount(0);
  expect(syncPosts).toBe(0);
  await page.getByRole("button", { name: "数据同步" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".sync-popup")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "数据同步" })).toBeFocused();
  await page.getByRole("button", { name: "数据同步" }).press("Enter");
  await page.setViewportSize({ width: 320, height: 256 });
  await expectWithinViewport(page.locator(".sync-popup"));
  await page.getByRole("button", { name: "立即同步", exact: true }).focus();
  await expectWithinViewport(
    page.getByRole("button", { name: "立即同步", exact: true }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "立即同步", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "自动同步" }),
  ).not.toBeChecked();
  expect(syncPosts).toBe(0);
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "同步中", exact: true }),
  ).toBeDisabled();
  expect(syncPosts).toBe(1);
  syncState = {
    ...syncState,
    running: false,
    error: "source-sync-failed",
    lastError: {
      id: "test-error-id",
      stage: "incremental",
      kind: "network",
      code: "ECONNREFUSED",
    },
  };
  // 失败说明面向使用者：讲清哪一步、什么原因、怎么处理；阶段代码与错误编号只留在服务端日志。
  const syncDialog = page.getByRole("dialog", {
    name: "数据同步",
    exact: true,
  });
  await expect(
    syncDialog.getByRole("status").filter({
      hasText:
        "补采用量时连接中断。请确认 Meterleaf 能连上 Sub2API 数据库，恢复后会自动继续。",
    }),
  ).toBeVisible({ timeout: 10000 });
  for (const code of ["test-error-id", "incremental", "ECONNREFUSED"])
    await expect(syncDialog).not.toContainText(code);
  await expect(
    page.getByRole("button", { name: "重试同步", exact: true }),
  ).toBeEnabled();
  await page.unroute("**/api/view**");
  const refreshRequests: boolean[] = [];
  // 开发态 StrictMode 会取消首次挂载的读取；刷新协议以真正完成的请求为准。
  const recordRefresh = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/view" && isMainLedgerRequest(url))
      refreshRequests.push(url.searchParams.get("refresh") !== "false");
  };
  page.on("requestfinished", recordRefresh);
  let refreshFailure = false;
  let transportFailure = false;
  let armTransportFailureDuringRefresh = false;
  let transportFailureRequests = 0;
  await page.route("**/api/view**", async (route) => {
    if (transportFailure) {
      transportFailureRequests += 1;
      await route.fulfill({ status: 503, body: "unavailable" });
      return;
    }
    const url = new URL(route.request().url());
    const refresh = url.searchParams.get("refresh") !== "false";
    const value = fixtureView(createDemoLedger(), url);
    value.view.count = refresh ? 900 : 901;
    for (const variant of Object.values(value.usdVariants!)) {
      variant.view.count = value.view.count;
    }
    if (armTransportFailureDuringRefresh && refresh) {
      armTransportFailureDuringRefresh = false;
      transportFailure = true;
    }
    value.reportStatus = {
      refreshing: refresh,
      lastError:
        !refresh && refreshFailure
          ? { kind: "storage", code: "ERR_REPORT_READ_FAILED" }
          : null,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  });
  await page.evaluate(
    (url) => history.replaceState(null, "", url),
    `${baseUrl}#overview`,
  );
  await page.reload();
  await expect(summaryCell(page, 2)).toHaveText("901");
  await expect.poll(() => refreshRequests).toEqual([true, false]);
  await page.waitForTimeout(1500);
  expect(refreshRequests).toEqual([true, false]);
  const signalSyncComplete = async () => {
    syncState.lastSuccess = new Date().toISOString();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };
  armTransportFailureDuringRefresh = true;
  await signalSyncComplete();
  await expect(page.getByRole("alert")).toContainText("网关不可用（HTTP 503）");
  await expect(page.locator("#main-content")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const failedTransportRequests = transportFailureRequests;
  await page.waitForTimeout(2500);
  expect(transportFailureRequests).toBe(failedTransportRequests);
  transportFailure = false;
  await page
    .getByRole("alert")
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(summaryCell(page, 2)).toHaveText("901");

  refreshFailure = true;
  await signalSyncComplete();
  await expect(page.getByRole("alert")).toContainText(
    "刷新失败，当前显示上次成功的数据",
  );
  await expect(summaryCell(page, 2)).toHaveText("901");
  refreshFailure = false;
  await page
    .getByRole("alert")
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(summaryCell(page, 2)).toHaveText("901");
  transportFailure = true;
  await signalSyncComplete();
  await expect(page.getByRole("alert")).toContainText(
    "刷新失败（报表读取失败：网关不可用（HTTP 503）），当前显示上次成功的数据",
  );
  await expect(summaryCell(page, 2)).toHaveText("901");
  page.off("requestfinished", recordRefresh);
  await page.unroute("**/api/view**");
  let expiryReads = 0;
  await page.route("**/api/view**", async (route) => {
    const url = new URL(route.request().url());
    if (isMainLedgerRequest(url)) expiryReads++;
    const snapshot = createDemoLedger();
    snapshot.mode = "live";
    const account = snapshot.accounts[0]!;
    snapshot.accounts = [
      {
        ...account,
        name: "Expiry Account",
        fiveHour: null,
        sevenDay: {
          ...account.sevenDay!,
          percent: 75,
          resetsAt: new Date(Date.now() + 3500).toISOString(),
          periodUsd: "12.34",
          estimate: {
            usd: "16.45",
            credits: "411.33",
            deltaPercent: null,
            reason: "eligible",
          },
        },
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureView(snapshot, url)),
    });
  });
  await page.evaluate(
    (url) => history.replaceState(null, "", url),
    `${baseUrl}#overview`,
  );
  await page.reload();
  const expiryAmount = page.locator('.account-row [aria-label="7d费用"]');
  await expect(expiryAmount).toHaveText("$12.34");
  const readsBeforeExpiry = expiryReads;
  await page.locator(".account-row").first().click();
  await expect(page.getByRole("dialog")).toContainText("$12.34");
  // 到期后不再给出旧百分比：已过期的窗口从详情中移除，只剩额度 N/A。
  await expect(
    page.getByRole("dialog").locator('[role="progressbar"][aria-valuenow]'),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText("额度 N/A");
  await expect(page.getByRole("dialog")).not.toContainText("$12.34");
  await expect(page.getByRole("dialog")).not.toContainText("$16.45");
  await page.keyboard.press("Escape");
  await expect(expiryAmount).toHaveCount(0);
  expect(expiryReads).toBe(readsBeforeExpiry);
  console.log(
    JSON.stringify({
      status: "passed",
      viewports: ["1440x1000", "390x844"],
      checks: [
        process.env.METERLEAF_SKIP_SCREENSHOTS === "true"
          ? "screenshots skipped"
          : "screenshots captured",
        "canvas pixels",
        "overview defaults to all-time summary",
        "overview range updates summary and trend but not quotas",
        "model distribution opens filtered reports",
        "report summary, cache hit rate column and totals row",
        "chart unit",
        "week buckets",
        "pagination",
        "sorting",
        "detail dialog",
        "request detail returns keyboard focus to its row",
        "background row removal preserves details and returns focus to the table",
        "empty results",
        "CSV hidden",
        "weekly estimate in account list",
        "account drilldown",
        "overview account without quota opens filtered requests",
        "sync popup outside click without starting a task",
        "date, theme and sync actions remain reachable at 320x256",
        "dark mode",
        "system theme changes and explicit override",
        "palette and theme persistence after reload",
        "mobile navigation",
        "reduced motion",
        "no page errors",
        "SWR completion without retriggering",
        "refresh failures retain the last view",
        "quota expiry without network refresh",
      ],
    }),
  );
} finally {
  await page.unroute("**/api/view**");
  await page.unroute("**/api/sync");
  await page.unroute("**/api/sync/presence");
  await page.evaluate(() => localStorage.removeItem("meterleaf-usd-basis"));
  await page.evaluate((saved) => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("meterleaf-")) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(saved))
      localStorage.setItem(key, value);
  }, savedPreferences);
  await page.emulateMedia({
    reducedMotion: "no-preference",
    colorScheme: null,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl);
  // CDP 附着连接关闭不会停止调用者持有的浏览器进程。
  await browser.close();
}
