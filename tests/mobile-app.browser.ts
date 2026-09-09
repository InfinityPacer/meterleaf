import { chromium, expect, type Route, type Request } from "@playwright/test";
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
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().startsWith(base))!;
if (!page)
  throw new Error("Open the task page through the browser manager first");
page.setDefaultTimeout(10_000);
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
}))) as {
  media: "screen" | "print";
  colorScheme: "dark" | "light";
  contrast: "more" | "no-preference";
  forcedColors: "active" | "none";
  reducedMotion: "reduce" | "no-preference";
};
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
const preferencesRoutePattern = "**/api/accounts/archive";
const syncRoutePattern = "**/api/sync**";
const homeTrendRefreshes: boolean[] = [];
let shrinkLedger = false;
const recordHomeTrend = (request: Request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/view" && url.searchParams.get("pageSize") === "1")
    homeTrendRefreshes.push(url.searchParams.get("refresh") !== "false");
};
page.on("requestfinished", recordHomeTrend);

// 所有数字均由明确标记的虚构账本派生，不访问真实同步或账户设置。
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
  if (q.get("pageSize") === "1")
    result.reportStatus = {
      refreshing: q.get("refresh") !== "false",
      lastError: null,
    };
  await route.fulfill({ json: result });
};
const preferencesRouteHandler = (route: Route) =>
  route.fulfill({ json: { archived: [], hidden: [], writable: true } });
const syncRouteHandler = (route: Route) =>
  route.fulfill({
    json: {
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
    } satisfies SyncStatus,
  });
let viewRouteInstalled = false;
let preferencesRouteInstalled = false;
let syncRouteInstalled = false;

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
  // 手机首页使用 DOM 趋势柱；独立时间段页和模型报表才等待延迟加载的 canvas。
  if (hash === "#overview" && mobileApp) {
    await expect(page.locator(".mobile-home")).toBeVisible();
    await expect(page.locator(".mobile-home-trend-bar").first()).toBeVisible();
    await expect(
      page.getByRole("list", { name: "账户额度摘要" }),
    ).toBeVisible();
  }
  if (hash === "#settings")
    await expect(page.locator(".app-settings")).toBeVisible();
  if (
    hash === "#period" ||
    hash === "#reports" ||
    (hash === "#overview" && !mobileApp)
  ) {
    const canvas = page
      .locator(
        hash === "#reports" ? ".model-donut canvas" : ".trend-panel canvas",
      )
      .first();
    await expect(canvas).toBeVisible();
    await expect
      .poll(
        () =>
          canvas.evaluate((element) => {
            const canvas = element as HTMLCanvasElement;
            const ctx = canvas.getContext("2d");
            if (!ctx) return false;
            const pixels = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            let colored = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (
                pixels[i + 3]! > 0 &&
                Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) -
                  Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) >
                  40
              )
                colored++;
            return colored > 100;
          }),
        "chart has painted data pixels",
      )
      .toBe(true);
  }
  await page.waitForTimeout(200);
}
async function settingsFields() {
  const inline = page.locator(".app-settings");
  if (await inline.isVisible()) return inline;
  const profile = page.getByRole("button", { name: "我的设置", exact: true });
  if (await profile.isVisible()) {
    await profile.click();
    await expect(page).toHaveURL(/#settings$/);
    await expect(inline).toBeVisible();
    return inline;
  }
  await page.getByRole("button", { name: "主题设置", exact: true }).click();
  const popup = page.locator(".theme-control-popup");
  await expect(popup).toBeVisible();
  return popup;
}
async function chooseLayout(layout: string) {
  const fields = await settingsFields();
  await fields.getByRole("combobox", { name: "手机导航", exact: true }).click();
  await page.getByRole("option", { name: layout, exact: true }).click();
  await page.keyboard.press("Escape");
}
try {
  await page.route(viewRoutePattern, viewRouteHandler);
  viewRouteInstalled = true;
  await page.route(preferencesRoutePattern, preferencesRouteHandler);
  preferencesRouteInstalled = true;
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
  await expect.poll(() => homeTrendRefreshes).toEqual([true, false]);
  await page.waitForTimeout(1500);
  expect(homeTrendRefreshes).toEqual([true, false]);
  const navigation = page.getByRole("navigation", { name: "底部导航" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button")).toHaveCount(5);
  await expect(navigation.getByRole("button")).toHaveText([
    "首页",
    "账户",
    "统计",
    "明细",
    "我的",
  ]);
  const accounts = page.getByRole("list", { name: "账户额度摘要" });
  await expect(accounts).toHaveJSProperty(
    "scrollWidth",
    await accounts.evaluate((el) => el.clientWidth),
  );
  await page.getByRole("button", { name: /^时间段用量/ }).click();
  await expect(page).toHaveURL(/#period$/);
  await ready();
  await expect(page.locator(".app-period")).toBeVisible();
  await expect(
    navigation.getByRole("button", { name: "用量总览", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("button", { name: "我的", exact: true }).click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(
    page
      .locator(".app-settings")
      .getByRole("combobox", { name: "外观", exact: true }),
  ).toBeVisible();
  await chooseLayout("侧栏模式");
  await expect(page.getByRole("navigation", { name: "底部导航" })).toBeHidden();
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => getComputedStyle(el).borderRightColor),
  ).toBe("rgb(229, 233, 238)");
  await page.screenshot({ path: "test-results/mobile-sidebar.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "打开导航" })).toBeFocused();
  await chooseLayout("App 模式");
  await page.reload();
  await ready();
  await expect(page.locator("html")).toHaveAttribute(
    "data-mobile-layout",
    "app",
  );
  await navigation
    .getByRole("button", { name: "用量总览", exact: true })
    .click();
  await ready();
  await expect(page.getByRole("button", { name: "筛选与计价" })).toBeHidden();
  await page.getByRole("button", { name: /^时间段用量/ }).click();
  await ready();
  await page.getByRole("button", { name: "筛选与计价" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("combobox", { name: "模型筛选" }).click();
  await page.getByRole("option", { name: "GPT 6 Astra", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator(".mobile-filter-summary")).toContainText(
    "GPT 6 Astra",
  );
  await expect(page.getByRole("button", { name: "筛选与计价" })).toBeFocused();
  await page
    .getByRole("navigation", { name: "底部导航" })
    .getByRole("button", { name: "请求明细" })
    .click();
  await ready();
  await expect(page.locator(".mobile-request-list")).toBeVisible();
  await page.locator(".mobile-request-item").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  for (let i = 0; i < 6; i++) {
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
      const fields = await settingsFields();
      await fields.getByRole("combobox", { name: "外观", exact: true }).click();
      await page
        .getByRole("option", { name: dark ? "深色" : "浅色", exact: true })
        .click();
      await page.keyboard.press("Escape");
      for (const tab of views) {
        await page.goto(`${base}#${tab}`);
        await ready();
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
              violations: report.violations.map((v: any) => ({
                id: v.id,
                nodes: v.nodes.map((n: any) => ({
                  target: n.target,
                  summary: n.failureSummary,
                })),
              })),
              incomplete: report.incomplete.map((v: any) => ({
                id: v.id,
                count: v.nodes.length,
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
    results.filter((r: any) => r.violations.length),
    "AAA automated violations",
  ).toEqual([]);
  const summary = {
    status: "passed",
    checks:
      "five navigation items, standalone period, settings route, mode persistence, drawer border/focus, filter focus, detail focus/trap, pagination, reflow, text spacing, reduced motion",
    screens,
    errors,
    a11y: axeSource ? "executed" : "skipped: METERLEAF_AXE_PATH not provided",
    a11yViolations: results.filter((r: any) => r.violations.length),
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
        .closest(".usage-chart")
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
        audits: results,
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
  if (preferencesRouteInstalled)
    await page
      .unroute(preferencesRoutePattern, preferencesRouteHandler)
      .catch(() => undefined);
  if (syncRouteInstalled)
    await page
      .unroute(syncRoutePattern, syncRouteHandler)
      .catch(() => undefined);
  await page.emulateMedia(saved.media).catch(() => undefined);
  if (saved.viewport)
    await page.setViewportSize(saved.viewport).catch(() => undefined);
  await restoreLocalStorage().catch(() => undefined);
  await page
    .goto(saved.url, { waitUntil: "domcontentloaded" })
    .catch(() => undefined);
  await restoreLocalStorage().catch(() => undefined);
  page.off("pageerror", pageErrorHandler);
  page.off("requestfinished", recordHomeTrend);
  await browser.close();
}
