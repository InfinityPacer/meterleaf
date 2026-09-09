import {
  chromium,
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { mkdir } from "node:fs/promises";
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
const homeTrendRequests: string[] = [];
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

function isHomeTrendRequest(url: URL) {
  const query = url.searchParams;
  return (
    query.get("days") === "30" &&
    query.get("granularity") === "day" &&
    query.get("pageSize") === "1" &&
    query.get("account") === "all"
  );
}

function isMainLedgerRequest(url: URL) {
  return !isAccountTrendRequest(url) && !isHomeTrendRequest(url);
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
    name: "关于 Meterleaf 0.1.0",
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
    localStorage.setItem("meterleaf-palette", "default");
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
    else if (isHomeTrendRequest(url)) homeTrendRequests.push(url.toString());
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
  await expect(
    page.getByRole("region", { name: "历史累计", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "账户额度摘要", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".overview-history-trend canvas")).toBeVisible();
  await expect(page.getByRole("region", { name: "用量摘要" })).toHaveCount(0);
  await expect(page.locator(".filterbar")).toHaveCount(0);
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
  expect(
    homeTrendRequests.every((request) => {
      const url = new URL(request);
      return (
        url.searchParams.get("days") === "30" &&
        url.searchParams.get("granularity") === "day" &&
        url.searchParams.get("pageSize") === "1" &&
        url.searchParams.get("account") === "all"
      );
    }),
  ).toBe(true);
  await expect(
    page.getByRole("button", {
      name: "查看 Development 请求用量",
      exact: true,
    }),
  ).toContainText("时间段用量 Tokens");
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
  await selectTheme("配色", "自然");
  await page.keyboard.press("Escape");
  await expect(themeTrigger).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "natural");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "natural");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "natural");
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
  await expect(page.locator("html")).toHaveAttribute("data-palette", "natural");
  await themeTrigger.click();
  await selectTheme("配色", "默认");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "default");
  await page.emulateMedia({ colorScheme: null });
  await page.getByRole("button", { name: "时间段用量", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}#period`);
  await expect(
    page.getByRole("button", { name: "标准 API", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
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
  await page.getByRole("button", { name: "累计总览", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}#overview`);
  await page
    .getByRole("button", { name: "查看 Development 请求用量", exact: true })
    .click();
  await expect(page).toHaveURL(`${baseUrl}#ledger`);
  await expect(
    page.getByRole("combobox", { name: "账户筛选", exact: true }),
  ).toContainText("Development");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toContainText("Development");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await page.getByRole("button", { name: "时间段用量", exact: true }).click();
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
  await page.getByRole("button", { name: "时间段用量", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const periodMetrics = page.locator('[aria-label="用量摘要"] .metric');
  const apiUsd = await periodMetrics
    .nth(0)
    .locator(".metric-value")
    .innerText();
  const apiCredits = await periodMetrics
    .nth(1)
    .locator(".metric-value")
    .innerText();
  const apiRequests = await periodMetrics
    .nth(2)
    .locator(".metric-value")
    .innerText();
  const beforeBasisSwitch = mainLedgerRequests.length;
  await page.getByRole("button", { name: "订阅等价", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "订阅等价", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => periodMetrics.nth(0).locator(".metric-value").innerText())
    .not.toBe(apiUsd);
  expect(await periodMetrics.nth(1).locator(".metric-value").innerText()).toBe(
    apiCredits,
  );
  expect(await periodMetrics.nth(2).locator(".metric-value").innerText()).toBe(
    apiRequests,
  );
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
        const c = document.querySelector("canvas")!;
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
          const canvas = document.querySelector("canvas")!;
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
  await page.getByRole("combobox", { name: "模型筛选" }).click();
  await page.getByRole("option", { name: "GPT 5.6 Sol", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "模型筛选" })).toContainText(
    "GPT 5.6 Sol",
  );
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await expect(page.locator(".metric").nth(2)).not.toContainText("900");
  const requestsBeforeUnitSwitch = mainLedgerRequests.length;
  await page.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Tokens", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(100);
  expect(mainLedgerRequests.length).toBe(requestsBeforeUnitSwitch);
  await page.getByRole("button", { name: "周", exact: true }).click();
  await expect(
    page.getByText("自然周，周一起始", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByRole("button", { name: "账户额度", exact: true }).click();
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
    page.getByRole("button", { name: "第 75 页", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /USD 估值/ }).click();
  await expect(
    page.getByRole("columnheader", { name: /USD 估值/ }),
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
  await page.getByRole("button", { name: "账户额度", exact: true }).click();
  await expect(page.locator(".account-capacity").first()).toContainText(
    "7 天预估",
  );
  await page.getByRole("button", { name: /^Personal Pro/ }).click();
  await expect(
    page.getByRole("dialog").getByText("N/A", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看账户请求" }).click();
  await expect(page.getByRole("combobox", { name: "账户筛选" })).toContainText(
    "Personal",
  );
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await page.getByRole("button", { name: "统计报表", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分组汇总" })).toBeVisible();
  for (const name of ["总 Tokens", "输入", "缓存读取", "缓存写入", "输出"]) {
    await expect(
      page.getByRole("columnheader", { name, exact: true }),
    ).toBeVisible();
  }
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
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.locator(".report-section tbody tr")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "导出 CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "账户", exact: true }).click();
  await expect(page.locator(".report-section tbody tr")).toHaveCount(3);
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
      .getByRole("columnheader", { name: /USD 估值/ }),
  ).toBeAttached();
  await capture({
    path: "test-results/reports-mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  const quotaPreview = page.getByRole("region", { name: "账户额度摘要" });
  const lifetime = page.getByRole("region", { name: "历史累计", exact: true });
  await expect(lifetime).toBeVisible();
  const quotaWindows = quotaPreview.getByRole("button", { name: /账户额度$/ });
  const quotasBeforeDate = await quotaWindows.allTextContents();
  const periodAccount = quotaPreview.getByRole("button", {
    name: "查看 Development 请求用量",
    exact: true,
  });
  const periodBeforeDate = await periodAccount.textContent();
  const lifetimeBeforeDate = await lifetime.textContent();
  expect(
    (await page.locator("main h2").allTextContents()).map((text) =>
      text.trim(),
    ),
  ).toEqual(["历史累计", "账户额度", "Tokens 趋势"]);
  await page.getByRole("button", { name: "时间段用量", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}#period`);
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
    .toBe("rgb(237, 245, 247)");
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
      .getByRole("button", { name: "账户额度", exact: true })
      .click();
  } else {
    const mobileNavigation = page.getByRole("navigation", {
      name: "底部导航",
      exact: true,
    });
    await expect(mobileNavigation).toBeVisible();
    await mobileNavigation
      .getByRole("button", { name: "账户", exact: true })
      .click();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "账户额度", exact: true }).first(),
  ).toBeVisible();
  await capture({
    path: "test-results/accounts-mobile.png",
    fullPage: false,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "用量总览", exact: true }).click();
  await page.getByRole("button", { name: "时间段用量", exact: true }).click();
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
    ).previousDateCanvas = document.querySelector("canvas");
  });
  const previousMetrics = await page.locator(".metrics").textContent();
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
    await expect(page.locator(".metrics")).toHaveText(previousMetrics!);
    expect(
      await page.evaluate(
        () =>
          document.querySelector("canvas") ===
          (window as unknown as { previousDateCanvas: Element | null })
            .previousDateCanvas,
      ),
    ).toBe(true);
  } finally {
    holdDateResponse = false;
    releaseDateResponse?.();
  }
  await customResponse;
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
  await page.getByRole("button", { name: "累计总览", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}#overview`);
  await expect(quotaWindows).toHaveText(quotasBeforeDate);
  await expect(periodAccount).not.toHaveText(periodBeforeDate!);
  await expect(lifetime).toHaveText(lifetimeBeforeDate!);
  await page.getByRole("button", { name: "时间段用量", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}#period`);
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
  await expect(page.locator(".metric").nth(2)).toContainText(
    String(customRows.length),
  );
  await expect(page.getByRole("button", { name: "导出 CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".metric").nth(2)).toContainText(
    String(customRows.length),
  );
  await page.getByRole("radio", { name: "近 7 天", exact: true }).click();
  await expect(page.locator(".metric").nth(2)).toContainText("900");
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
  await page.getByRole("button", { name: "时间段用量", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}#period`);
  await expect(page.getByText("实时数据", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "用量摘要", exact: true })
      .getByText("估算费用", { exact: true }),
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
  await expect(
    page
      .getByRole("dialog", { name: "数据同步", exact: true })
      .getByRole("status")
      .filter({ hasText: "test-error-id" }),
  ).toBeVisible({ timeout: 10000 });
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
    `${baseUrl}#period`,
  );
  await page.reload();
  await expect(page.locator(".metric").nth(2)).toContainText("901");
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
  await expect(page.locator(".metric").nth(2)).toContainText("901");

  refreshFailure = true;
  await signalSyncComplete();
  await expect(page.getByRole("alert")).toContainText(
    "刷新失败，当前显示上次成功的数据",
  );
  await expect(page.locator(".metric").nth(2)).toContainText("901");
  refreshFailure = false;
  await page
    .getByRole("alert")
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".metric").nth(2)).toContainText("901");
  transportFailure = true;
  await signalSyncComplete();
  await expect(page.getByRole("alert")).toContainText(
    "刷新失败（报表读取失败：网关不可用（HTTP 503）），当前显示上次成功的数据",
  );
  await expect(page.locator(".metric").nth(2)).toContainText("901");
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
    `${baseUrl}#accounts`,
  );
  await page.reload();
  const expiryAmount = page.locator('.account-row [aria-label="7 天估算费用"]');
  await expect(expiryAmount).toHaveText("$12.34");
  const readsBeforeExpiry = expiryReads;
  await page.locator(".account-row").first().click();
  await expect(page.getByRole("dialog")).toContainText("$12.34");
  await expect(
    page.getByRole("dialog").getByRole("progressbar", { name: "7 天窗口" }),
  ).not.toHaveAttribute("aria-valuenow", /.+/);
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
        "model filter",
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
