import {
  chromium,
  expect,
  type Locator,
  type Request,
  type Route,
} from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createDemoLedger } from "../src/web/demo/ledger";
import {
  createLedgerView,
  withUsdVariants,
  type ViewQuery,
} from "../src/shared/ledger-view";
import { aggregateReport } from "../src/web/lib/report";
import type { SyncStatus } from "../src/server/sync";

const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4331/";
const baseUrl = new URL(base);
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const matchedPage = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => {
    try {
      const url = new URL(candidate.url());
      return url.origin === baseUrl.origin && url.pathname === baseUrl.pathname;
    } catch {
      return false;
    }
  });
if (!matchedPage)
  throw new Error("Open the task page through the browser manager first");
const page = matchedPage;
page.setDefaultTimeout(10_000);

type SavedMedia = {
  media: "screen" | "print";
  colorScheme: "dark" | "light" | "no-preference";
  contrast: "more" | "no-preference";
  forcedColors: "active" | "none";
  reducedMotion: "reduce" | "no-preference";
};

type ViewRequest = {
  account: string;
  days: number;
  granularity: string;
  pageSize: number;
  refresh: boolean;
};

type TrendPayload = {
  account: string;
  points: number;
  knownTokens: number;
  knownUsd: number;
};

type ArchiveState = {
  archived: string[];
  hidden: string[];
  writable: boolean;
};

const errors: string[] = [];
const pageErrorHandler = (error: Error) => errors.push(error.message);
page.on("pageerror", pageErrorHandler);

const savedMedia = (await page.evaluate(() => ({
  media: matchMedia("print").matches ? "print" : "screen",
  colorScheme: matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light",
  contrast: matchMedia("(prefers-contrast: more)").matches
    ? "more"
    : "no-preference",
  forcedColors: matchMedia("(forced-colors: active)").matches
    ? "active"
    : "none",
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "reduce"
    : "no-preference",
}))) as SavedMedia;
const saved = {
  url: page.url(),
  viewport:
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))),
  media: savedMedia,
  localStorage: await page.evaluate(() => ({ ...localStorage })),
};

const restoreLocalStorage = () =>
  page.evaluate((storage) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage))
      localStorage.setItem(key, value);
  }, saved.localStorage);

await mkdir("test-results", { recursive: true });
const axeSource = process.env.METERLEAF_AXE_PATH
  ? await readFile(process.env.METERLEAF_AXE_PATH, "utf8")
  : null;
const results: unknown[] = [];
const views = [
  "overview",
  "period",
  "accounts",
  "reports",
  "ledger",
  "settings",
] as const;
let screens = 0;

const viewRoutePattern = "**/api/view**";
const archiveRoutePattern = "**/api/accounts/archive**";
const syncRoutePattern = "**/api/sync**";
const viewRequests: ViewRequest[] = [];
const trendPayloads: TrendPayload[] = [];
const archiveWrites: unknown[] = [];
const archiveState: ArchiveState = {
  archived: [],
  hidden: [],
  writable: true,
};
let shrinkLedger = false;

const recordViewRequest = (request: Request) => {
  const url = new URL(request.url());
  if (url.pathname !== "/api/view") return;
  const query = url.searchParams;
  viewRequests.push({
    account: query.get("account") ?? "all",
    days: Number(query.get("days") ?? 7),
    granularity: query.get("granularity") ?? "day",
    pageSize: Number(query.get("pageSize") ?? 12),
    refresh: query.get("refresh") !== "false",
  });
};
page.on("requestfinished", recordViewRequest);

const viewRouteHandler = async (route: Route) => {
  const q = new URL(route.request().url()).searchParams;
  const query: ViewQuery = {
    filter: {
      days: Number(q.get("days") ?? 7),
      model: q.get("model") ?? "all",
      account: q.get("account") ?? "all",
      search: q.get("search") ?? "",
      ...(q.has("from")
        ? { dateRange: { from: q.get("from")!, to: q.get("to")! } }
        : {}),
    },
    unit: "usd",
    granularity: (q.get("granularity") ?? "day") as ViewQuery["granularity"],
    dimension: (q.get("dimension") ?? "day") as ViewQuery["dimension"],
    page: Number(q.get("page") ?? 0),
    pageSize: Number(q.get("pageSize") ?? 12),
    sort: q.get("sort") ?? "occurredAt",
    desc: q.get("desc") !== "false",
  };
  const variant = (basis: "subscription" | "api") => {
    const snapshot = createDemoLedger(basis);
    if (shrinkLedger && query.pageSize === 12)
      snapshot.records = snapshot.records.slice(0, 1);
    for (const account of snapshot.accounts) {
      for (const [hours, window] of [
        [5, account.fiveHour],
        [168, account.sevenDay],
      ] as const) {
        if (!window) continue;
        const records = snapshot.records.filter(
          (row) =>
            row.accountId === account.id &&
            Date.parse(row.occurredAt) >=
              Date.parse(snapshot.asOf) - hours * 3600000,
        );
        const total = aggregateReport(records, "account")[0];
        window.periodUsd = total?.usd ?? null;
        window.periodTokens = total?.tokens ?? null;
        window.periodRequests = records.length;
      }
    }
    const view = createLedgerView(snapshot, query);
    const total = aggregateReport(
      snapshot.records.map((row) => ({ ...row, accountId: "total" })),
      "account",
    )[0]!;
    view.lifetimeTotals = {
      asOf: snapshot.asOf,
      from: snapshot.records.at(-1)!.occurredAt,
      to: snapshot.asOf,
      count: snapshot.records.length,
      tokens: {
        input: total.input,
        cacheRead: total.cacheRead,
        cacheWrite: total.cacheWrite,
        output: total.output,
        total: total.tokens,
        incomplete: total.incompleteTokens,
      },
      usd: total.usd,
      apiUsd: total.apiUsd,
      subscriptionUsd: total.subscriptionUsd,
      credits: total.credits,
      incomplete: { usd: 0, apiUsd: 0, subscriptionUsd: 0, credits: 0 },
      usdBasis: basis,
      priceVersion: "mobile-fixture",
    };
    return view;
  };
  const result = withUsdVariants(
    variant("subscription"),
    variant("api"),
    "subscription",
  );
  if (q.get("pageSize") === "1") {
    result.reportStatus = {
      refreshing: q.get("refresh") !== "false",
      lastError: null,
    };
    if (query.filter.account !== "all") {
      const points = result.view.units.tokens.points;
      trendPayloads.push({
        account: query.filter.account,
        points: points.length,
        knownTokens: points.filter((point) => point.value !== null).length,
        knownUsd: result.view.units.usd.points.filter(
          (point) => point.value !== null,
        ).length,
      });
    }
  }
  await route.fulfill({ json: result });
};

const archiveRouteHandler = async (route: Route) => {
  if (route.request().method() === "PUT") {
    const value = route.request().postDataJSON() as
      { id: string; archived: boolean } | { id: string; hidden: true };
    archiveWrites.push(value);
    if ("hidden" in value) {
      archiveState.hidden = [...new Set([...archiveState.hidden, value.id])];
    } else {
      archiveState.archived = value.archived
        ? [...new Set([...archiveState.archived, value.id])]
        : archiveState.archived.filter((id) => id !== value.id);
    }
  }
  await route.fulfill({ json: archiveState });
};

const syncStatus: SyncStatus = {
  autoEnabled: false,
  running: false,
  initialComplete: true,
  initialCompleteAt: createDemoLedger().asOf,
  phase: "idle",
  localRecords: 900,
  batchRecords: 0,
  batchPages: 0,
  hasSynced: true,
  lastAttempt: createDemoLedger().asOf,
  lastSuccess: createDemoLedger().asOf,
  lastSweep: null,
  error: null,
  quotaError: null,
  lastError: null,
};
const syncRouteHandler = (route: Route) => route.fulfill({ json: syncStatus });

let viewRouteInstalled = false;
let archiveRouteInstalled = false;
let syncRouteInstalled = false;

async function painted(canvas: Locator) {
  return canvas.evaluate((element) => {
    const value = element as HTMLCanvasElement;
    const context = value.getContext("2d");
    if (!context || value.width === 0 || value.height === 0) return false;
    const pixels = context.getImageData(0, 0, value.width, value.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      if (
        pixels[index + 3]! > 0 &&
        Math.max(red, green, blue) - Math.min(red, green, blue) > 24
      )
        return true;
    }
    return false;
  });
}

async function expectChartPainted(canvas: Locator, message: string) {
  await expect.poll(() => painted(canvas), message).toBe(true);
}

async function ready() {
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const hash = new URL(page.url()).hash;
  const mobileApp = await page.evaluate(
    () =>
      innerWidth <= 900 &&
      document.documentElement.dataset.mobileLayout === "app",
  );
  if (mobileApp) {
    const shell = await page.locator(".main-shell").boundingBox();
    expect(shell?.x, "mobile shell has no hidden-sidebar gutter").toBe(0);
    expect(shell?.width).toBe(await page.evaluate(() => innerWidth));
    await expect(
      page.getByRole("navigation", { name: "底部导航" }),
    ).toBeVisible();
  }
  if (hash === "#overview") {
    const tabs = page.getByRole("navigation", { name: "总览视图" });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole("button")).toHaveText([
      "累计总览",
      "时间段用量",
    ]);
    await expect(page.locator(".mobile-home-title")).toHaveCount(0);
    await expect(page.locator(".mobile-home-period-link")).toHaveCount(0);
    if (mobileApp) {
      await expect(page.locator(".mobile-home")).toBeVisible();
      await expect(page.locator(".mobile-home-trend-bars")).toHaveCount(0);
      await expect(
        page.locator(".mobile-home .mini-trend-chart"),
      ).toBeVisible();
      await expect(
        page.getByRole("group", { name: "近 30 天 Tokens 趋势" }),
      ).toBeVisible();
      const trendData = page.getByRole("list", {
        name: "Tokens 趋势数据",
      });
      await expect(trendData).toHaveCount(1);
      expect(await trendData.locator("li").count()).toBeGreaterThan(0);
      await expect(
        page.getByRole("list", { name: "账户额度摘要" }),
      ).toBeVisible();
    } else {
      await expect(page.locator("main .metrics")).toHaveCount(0);
      await expect(page.locator("main > .filterbar")).toHaveCount(0);
      await expect(page.locator(".overview-history-trend")).toBeVisible();
      await expect(page.locator(".quota-preview-estimate > strong")).toHaveText(
        ["N/A", "N/A"],
      );
      await expect(
        page.locator(".quota-preview-estimate").getByText(/未提供|未计价原因/),
      ).toHaveCount(0);
    }
  }
  if (hash === "#period") {
    await expect(
      page.getByRole("navigation", { name: "总览视图" }),
    ).toBeVisible();
  }
  if (hash === "#settings")
    await expect(page.locator(".about-page")).toBeVisible();
  if (hash === "#accounts") {
    const trends = page.locator(".account-list-item .mini-trend");
    await expect
      .poll(
        () =>
          trends.evaluateAll(
            (elements) =>
              elements.length > 0 &&
              elements.every((element) =>
                element.getAttribute("data-metric") === "requests"
                  ? element.getAttribute("data-variant") === "line"
                  : ["line", "area", "bar"].includes(
                      element.getAttribute("data-variant") ?? "",
                    ),
              ),
          ),
        "account trends render with requests shown as lines",
      )
      .toBe(true);
    await expect(page.locator(".account-capacity > strong")).toHaveText([
      "N/A",
      "N/A",
    ]);
    await expect(
      page.locator(".account-capacity").getByText(/未提供|未计价原因/),
    ).toHaveCount(0);
    for (const button of [
      page.locator(".account-actions-heading > button"),
      page.locator(".account-menu-trigger").first(),
    ]) {
      await expect(button).toHaveAttribute("data-variant", "ghost");
      await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
  }
  if (
    hash === "#period" ||
    hash === "#reports" ||
    (hash === "#overview" && !mobileApp)
  ) {
    const selector =
      hash === "#reports"
        ? ".model-donut .usage-chart canvas"
        : hash === "#period"
          ? ".trend-panel .usage-chart canvas"
          : ".overview-history-trend .usage-chart canvas";
    const canvas = page.locator(selector).first();
    await expect(canvas).toBeVisible();
    await expectChartPainted(canvas, "chart has painted data pixels");
  }
  await page.waitForTimeout(200);
}

async function settingsFields() {
  const about = page.locator(".about-page");
  if (await about.isVisible()) return about;
  const bottomAbout = page.getByRole("button", { name: "关于", exact: true });
  if (await bottomAbout.isVisible()) {
    await bottomAbout.click();
    await expect(about).toBeVisible();
    return about;
  }
  const sidebarAbout = page.locator(".about-link").first();
  if (await sidebarAbout.isVisible()) {
    await sidebarAbout.click();
    await expect(about).toBeVisible();
    return about;
  }
  const menuButton = page.getByRole("button", {
    name: "打开导航",
    exact: true,
  });
  if (await menuButton.isVisible()) {
    await menuButton.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator(".about-link").click();
    await expect(about).toBeVisible();
    return about;
  }
  const themeTrigger = page.getByRole("button", {
    name: "主题设置",
    exact: true,
  });
  if (await themeTrigger.isVisible()) {
    await themeTrigger.click();
    const popup = page.locator(".theme-control-popup");
    await expect(popup).toBeVisible();
    return popup;
  }
  throw new Error("About entry is not reachable from the assigned task page");
}

async function chooseSetting(label: string, option: string) {
  const fields = await settingsFields();
  const group = fields.getByRole("group", { name: label, exact: true });
  if (await group.count()) {
    const button = group.getByRole("button", { name: option, exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    return;
  }
  await fields.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await page.keyboard.press("Escape");
}

async function assertHomeChartControl(scope: Locator, mobile: boolean) {
  const control = scope.getByRole("group", {
    name: "图表样式",
    exact: true,
  });
  await expect(control).toBeVisible();
  await expect(control.getByRole("button")).toHaveCount(3);
  expect(
    await control
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
  ).toEqual(["折线图", "面积图", "柱状图"]);

  const readStoredChart = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem("meterleaf-pref-home-chart");
      return raw ? JSON.parse(raw) : null;
    });
  await expect.poll(readStoredChart).toBe("line");
  await expect(
    control.getByRole("button", { name: "折线图", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  for (const [label, value] of [
    ["面积图", "area"],
    ["柱状图", "bar"],
    ["折线图", "line"],
  ] as const) {
    const button = control.getByRole("button", { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect.poll(readStoredChart).toBe(value);
    if (mobile)
      await expect(scope.locator(".mini-trend")).toHaveAttribute(
        "data-variant",
        value,
      );
    else
      await expect(scope.locator(".usage-chart")).toHaveAttribute(
        "data-chart-style",
        value,
      );
  }
}

try {
  await page.route(viewRoutePattern, viewRouteHandler);
  viewRouteInstalled = true;
  await page.route(archiveRoutePattern, archiveRouteHandler);
  archiveRouteInstalled = true;
  await page.route(syncRoutePattern, syncRouteHandler);
  syncRouteInstalled = true;
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("meterleaf-theme", "light");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    (url) => history.replaceState(null, "", url),
    `${base}#overview`,
  );
  await page.reload();
  await ready();
  await assertHomeChartControl(page.locator(".mobile-home-summary"), true);

  const homeTrendRequests = () =>
    viewRequests.filter(
      (request) =>
        request.pageSize === 1 &&
        request.days === 30 &&
        request.account === "all" &&
        request.granularity === "day",
    );
  await expect
    .poll(() => homeTrendRequests().map((request) => request.refresh))
    .toEqual([true, false]);
  await page.waitForTimeout(1500);
  expect(homeTrendRequests().map((request) => request.refresh)).toEqual([
    true,
    false,
  ]);
  expect(
    homeTrendRequests().every(
      (request) =>
        request.pageSize === 1 &&
        request.days === 30 &&
        request.account === "all" &&
        request.granularity === "day",
    ),
  ).toBe(true);

  const navigation = page.getByRole("navigation", { name: "底部导航" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button")).toHaveCount(5);
  await expect(navigation.getByRole("button")).toHaveText([
    "首页",
    "账户",
    "统计",
    "明细",
    "关于",
  ]);
  const accounts = page.getByRole("list", { name: "账户额度摘要" });
  await expect(accounts).toHaveJSProperty(
    "scrollWidth",
    await accounts.evaluate((element) => element.clientWidth),
  );
  const overviewTabStart = await page
    .getByRole("navigation", { name: "总览视图" })
    .getByRole("button")
    .first()
    .boundingBox();
  await page
    .getByRole("navigation", { name: "总览视图" })
    .getByRole("button", { name: "时间段用量", exact: true })
    .click();
  await expect(page).toHaveURL(/#period$/);
  await ready();
  const periodTabStart = await page
    .getByRole("navigation", { name: "总览视图" })
    .getByRole("button")
    .first()
    .boundingBox();
  expect(overviewTabStart, "overview tab geometry").not.toBeNull();
  expect(periodTabStart, "period tab geometry").not.toBeNull();
  expect(
    Math.abs((overviewTabStart?.x ?? 0) - (periodTabStart?.x ?? 0)),
    "overview tabs keep the same starting x coordinate",
  ).toBeLessThanOrEqual(1);
  await expect(page.locator(".app-period")).toBeVisible();
  await expect(
    navigation.getByRole("button", { name: "用量总览", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("button", { name: "关于", exact: true }).click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.locator(".about-page")).toBeVisible();
  await expect(page.locator(".app-settings")).toHaveCount(0);
  await expect(page.locator('[aria-label="我的设置"]')).toHaveCount(0);
  await expect(page.getByText("常用术语", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "返回总览", exact: true }),
  ).toHaveCount(0);
  await chooseSetting("页面布局", "侧栏模式");
  await expect(page.getByRole("navigation", { name: "底部导航" })).toBeHidden();
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => getComputedStyle(element).borderRightColor),
  ).toBe("rgb(229, 233, 238)");
  await page.screenshot({ path: "test-results/mobile-sidebar.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "打开导航" })).toBeFocused();
  await chooseSetting("页面布局", "App 模式");
  await page.reload();
  await ready();
  await expect(page.locator("html")).toHaveAttribute(
    "data-mobile-layout",
    "app",
  );
  await navigation
    .getByRole("button", { name: "用量总览", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "总览视图" })
    .getByRole("button", { name: "累计总览", exact: true })
    .click();
  await ready();
  await expect(page.getByRole("button", { name: "筛选与计价" })).toBeHidden();
  await page
    .getByRole("navigation", { name: "总览视图" })
    .getByRole("button", { name: "时间段用量", exact: true })
    .click();
  await ready();
  await page.getByRole("button", { name: "筛选与计价" }).click();
  const filterDialog = page.getByRole("dialog");
  await expect(filterDialog).toBeVisible();
  const filterBox = await page.locator(".mobile-filter-sheet").boundingBox();
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect(
    filterBox?.width ?? 0,
    "mobile filter sheet width",
  ).toBeLessThanOrEqual(viewport.width);
  expect(
    filterBox?.height ?? viewport.height,
    "mobile filter sheet height",
  ).toBeLessThan(viewport.height);
  await page.getByRole("combobox", { name: "模型筛选" }).click();
  await page.getByRole("option", { name: "GPT 6 Astra", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator(".mobile-filter-summary")).toContainText(
    "GPT 6 Astra",
  );
  await expect(page.getByRole("button", { name: "筛选与计价" })).toBeFocused();
  await page
    .getByRole("navigation", { name: "底部导航" })
    .getByRole("button", { name: "请求明细", exact: true })
    .click();
  await ready();
  await expect(page.locator(".mobile-request-list")).toBeVisible();
  await page.locator(".mobile-request-item").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab");
    await expect
      .poll(
        () =>
          page.evaluate(() => ({
            trapped: !!document.activeElement?.closest('[role="dialog"]'),
            active: document.activeElement?.outerHTML.slice(0, 200),
          })),
        "detail focus trap",
      )
      .toMatchObject({ trapped: true });
  }
  await page.keyboard.press("Escape");
  await expect(page.locator(".mobile-request-item").first()).toBeFocused();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("第 2");

  // 下一次读取缩减记录总量，验证空的越界页能自动读取新的有效页。
  shrinkLedger = true;
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".ledger-page-summary")).toHaveText("第 1 / 1 页");
  await expect(page.locator(".mobile-request-item")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  shrinkLedger = false;
  await page.reload();
  await ready();

  for (const [width, height] of [
    [390, 844],
    [375, 812],
    [320, 740],
    [844, 390],
    [900, 600],
    [901, 600],
    [1440, 1000],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const dark of [false, true]) {
      await chooseSetting("外观", dark ? "深色" : "浅色");
      for (const tab of views) {
        await page.goto(`${base}#${tab}`);
        await ready();
        if (tab === "overview") {
          const mobileApp = await page.evaluate(
            () =>
              innerWidth <= 900 &&
              document.documentElement.dataset.mobileLayout === "app",
          );
          await assertHomeChartControl(
            mobileApp
              ? page.locator(".mobile-home-summary")
              : page.locator(".overview-history-trend"),
            mobileApp,
          );
        }
        if (width === 844 && height === 390 && tab === "reports") {
          const donut = page.locator(".model-donut").first();
          await expect(donut).toBeVisible();
          const donutBox = await donut.boundingBox();
          expect(
            donutBox?.width ?? 0,
            "landscape donut container width",
          ).toBeGreaterThan(0);
          expect(
            donutBox?.height ?? 0,
            "landscape donut container height",
          ).toBeGreaterThan(0);
          const canvas = donut.locator("canvas").first();
          await expect(canvas).toBeVisible();
          const canvasSize = await canvas.evaluate((element) => {
            const chart = element as HTMLCanvasElement;
            return { width: chart.width, height: chart.height };
          });
          expect(
            canvasSize.width,
            "landscape donut canvas width",
          ).toBeGreaterThan(0);
          expect(
            canvasSize.height,
            "landscape donut canvas height",
          ).toBeGreaterThan(0);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `overflow ${width} ${dark} ${tab}`,
        ).toBe(true);
        await page.screenshot({
          path: `test-results/mobile-app-${width}-${dark ? "dark" : "light"}-${tab}.png`,
        });
        screens++;
        if (axeSource) {
          await page.evaluate(axeSource);
          const audit = await page.evaluate(async () => {
            const axe = (window as any).axe;
            const report = await axe.run(document, {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag21a", "wcag22a"],
              },
            });
            return {
              level: "WCAG 2.2 A",
              violations: report.violations.map((violation: any) => ({
                id: violation.id,
                nodes: violation.nodes.map((node: any) => ({
                  target: node.target,
                  summary: node.failureSummary,
                })),
              })),
              incomplete: report.incomplete.map((violation: any) => ({
                id: violation.id,
                count: violation.nodes.length,
              })),
            };
          });
          results.push({ width, height, dark, tab, ...audit });
        }
      }
    }
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const tab of views) {
    await page.goto(`${base}#${tab}`);
    await ready();
    await page.addStyleTag({
      content:
        "* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/mobile-spacing-${tab}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
  await writeFile(
    "test-results/mobile-app-a11y.json",
    JSON.stringify(results, null, 2),
  );
  expect(
    results.filter((result: any) => result.violations.length),
    "A automated violations",
  ).toEqual([]);
  const summary = {
    status: "passed",
    checks:
      "five navigation items, overview tabs, standalone period, about route, mode persistence, drawer border/focus, filter focus, detail focus/trap, pagination, reflow, text spacing, reduced motion, home chart preference, line micro trends, N/A estimates, transparent actions, tab geometry, compact filter sheet, home and account pageSize=1 query bounds",
    screens,
    errors,
    a11y: axeSource ? "executed" : "skipped: METERLEAF_AXE_PATH not provided",
    a11yViolations: results.filter((result: any) => result.violations.length),
    homeTrendRequests: homeTrendRequests(),
    accountTrendRequests: viewRequests.filter(
      (request) => request.pageSize === 1 && request.account !== "all",
    ),
  };
  await writeFile(
    "test-results/mobile-app-run.json",
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  await page.screenshot({ path: "test-results/mobile-test-failure.png" });
  const state = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dark: document.documentElement.classList.contains("dark"),
    layout: document.documentElement.dataset.mobileLayout,
    scrollWidth: document.documentElement.scrollWidth,
    charts: [...document.querySelectorAll("canvas")].map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      visible: canvas.checkVisibility(),
      container: canvas
        .closest(".usage-chart, .mini-trend-chart")
        ?.getBoundingClientRect()
        .toJSON(),
    })),
  }));
  await writeFile(
    "test-results/mobile-app-run.json",
    JSON.stringify(
      {
        status: "failed",
        screens,
        url: page.url(),
        state,
        error: String(error),
        errors,
        a11y: axeSource
          ? "executed"
          : "skipped: METERLEAF_AXE_PATH not provided",
        homeTrendRequests: viewRequests.filter(
          (request) =>
            request.pageSize === 1 &&
            request.days === 30 &&
            request.account === "all" &&
            request.granularity === "day",
        ),
        accountTrendRequests: viewRequests.filter(
          (request) => request.pageSize === 1 && request.account !== "all",
        ),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (viewRouteInstalled)
    await page
      .unroute(viewRoutePattern, viewRouteHandler)
      .catch(() => undefined);
  if (archiveRouteInstalled)
    await page
      .unroute(archiveRoutePattern, archiveRouteHandler)
      .catch(() => undefined);
  if (syncRouteInstalled)
    await page
      .unroute(syncRoutePattern, syncRouteHandler)
      .catch(() => undefined);
  await page
    .emulateMedia({
      media: saved.media.media,
      colorScheme: saved.media.colorScheme,
      contrast: saved.media.contrast,
      forcedColors: saved.media.forcedColors,
      reducedMotion: saved.media.reducedMotion,
    })
    .catch(() => undefined);
  if (saved.viewport)
    await page.setViewportSize(saved.viewport).catch(() => undefined);
  await restoreLocalStorage().catch(() => undefined);
  await page
    .goto(saved.url, { waitUntil: "domcontentloaded" })
    .catch(() => undefined);
  await restoreLocalStorage().catch(() => undefined);
  page.off("pageerror", pageErrorHandler);
  page.off("requestfinished", recordViewRequest);
  await browser.close();
}
