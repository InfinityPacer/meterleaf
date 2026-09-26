import {
  chromium,
  expect,
  type Locator,
  type Request,
  type Route,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createDemoLedger } from "../src/web/demo/ledger";
import {
  createLedgerView,
  withUsdVariants,
  type ViewQuery,
} from "../src/shared/ledger-view";
import { aggregateReport } from "../src/web/lib/report";
import { estimateAmount } from "../src/web/lib/quota-display";
import type { SyncStatus } from "../src/server/sync";

const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4331/";
const baseUrl = new URL(base);
const endpoint = process.env.METERLEAF_CDP_URL;
if (!endpoint) throw new Error("METERLEAF_CDP_URL is required");
const browser = await chromium.connectOverCDP(endpoint);
const matchedPage = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => {
    try {
      const url = new URL(candidate.url());
      return (
        url.origin === baseUrl.origin &&
        url.pathname === baseUrl.pathname &&
        (!baseUrl.search || url.search === baseUrl.search)
      );
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
  from: string | null;
  days: number;
  granularity: string;
  pageSize: number;
};

type ArchiveState = {
  archived: string[];
  hidden: string[];
  writable: boolean;
};

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

await mkdir("test-results/visual-feedback", { recursive: true });

// 演示账本给出 7d 整周预估；Web 账户行按来源顺序为每个有额度窗口的账户显示订阅等价 USD 预估。
const demoLedger = createDemoLedger("subscription");
const expectedWeeklyEstimates = demoLedger.accounts
  .filter(
    (account) => account.fiveHour || account.sevenDay || account.sevenDayFable,
  )
  .map((account) => estimateAmount(account.sevenDay, "usd", demoLedger.asOf));
if (
  !expectedWeeklyEstimates.length ||
  expectedWeeklyEstimates.some((value) => !/^\$[\d,]+\.\d{2}$/.test(value))
)
  throw new Error(
    `Demo weekly estimates must be amounts: ${expectedWeeklyEstimates}`,
  );

// 历史至今在查询前换算为从账本首条记录所在上海自然日开始的范围。
const demoStartDay = new Date(
  Date.parse(demoLedger.records.map((row) => row.occurredAt).sort()[0]!) +
    8 * 3600_000,
)
  .toISOString()
  .slice(0, 10);

const viewRoutePattern = "**/api/view**";
const archiveRoutePattern = "**/api/accounts/archive**";
const syncRoutePattern = "**/api/sync**";
const viewRequests: ViewRequest[] = [];
const trendPayloads: string[] = [];
const archiveWrites: Array<
  { id: string; archived: boolean } | { id: string; hidden: true }
> = [];
const archiveState: ArchiveState = {
  archived: [],
  hidden: [],
  writable: true,
};

const recordViewRequest = (request: Request) => {
  const url = new URL(request.url());
  if (url.pathname !== "/api/view") return;
  const query = url.searchParams;
  viewRequests.push({
    account: query.get("account") ?? "all",
    from: query.get("from"),
    days: Number(query.get("days") ?? 7),
    granularity: query.get("granularity") ?? "day",
    pageSize: Number(query.get("pageSize") ?? 12),
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
      // 与服务端一致，累计范围从账本最早的一条记录开始。
      from: snapshot.records.map((row) => row.occurredAt).sort()[0]!,
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
      priceVersion: "visual-feedback-fixture",
    };
    return view;
  };
  const result = withUsdVariants(
    variant("subscription"),
    variant("api"),
    "subscription",
  );
  if (query.pageSize === 1) {
    result.reportStatus = {
      refreshing: q.get("refresh") !== "false",
      lastError: null,
    };
    if (query.filter.account !== "all") {
      const points = result.view.units.tokens.points;
      trendPayloads.push(
        `${query.filter.account}:${points.length}:${points.filter((point) => point.value !== null).length}:${result.view.units.usd.points.filter((point) => point.value !== null).length}`,
      );
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

async function expectPainted(canvas: Locator, message: string) {
  await expect
    .poll(
      () =>
        canvas.evaluate((element) => {
          const value = element as HTMLCanvasElement;
          const context = value.getContext("2d");
          if (!context || value.width === 0 || value.height === 0) return false;
          const pixels = context.getImageData(
            0,
            0,
            value.width,
            value.height,
          ).data;
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
        }),
      message,
    )
    .toBe(true);
}

async function ready() {
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const hash = new URL(page.url()).hash;
  if (hash === "#settings")
    await expect(page.locator(".about-page")).toBeVisible();
  if (hash === "#overview" || hash === "#reports") {
    const canvas = page
      .locator(
        hash === "#reports"
          ? ".model-donut .usage-chart canvas"
          : ".trend-panel .usage-chart canvas",
      )
      .first();
    await expect(canvas).toBeVisible();
    await expectPainted(canvas, "primary chart has painted data pixels");
  }
}

async function resetFixture(
  width: number,
  height: number,
  layout: "app" | "sidebar",
  theme: "light" | "dark",
) {
  archiveState.archived = [];
  archiveState.hidden = [];
  archiveState.writable = true;
  archiveWrites.length = 0;
  viewRequests.length = 0;
  trendPayloads.length = 0;
  await page.setViewportSize({ width, height });
  await page.evaluate(
    ({ layout, theme }) => {
      localStorage.clear();
      localStorage.setItem("meterleaf-theme", theme);
      localStorage.setItem(
        "meterleaf-pref-mobile-layout",
        JSON.stringify(layout),
      );
    },
    { layout, theme },
  );
  await page.goto(`${base}#overview`);
  await page.reload();
  await ready();
}

async function openAboutFromEntry(width: number, layout: "app" | "sidebar") {
  await page.goto(`${base}#overview`);
  await ready();
  const mobile = width <= 900;
  if (mobile && layout === "app") {
    await expect(
      page.getByRole("navigation", { name: "底部导航" }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "底部导航" })
      .getByRole("button", { name: "关于", exact: true })
      .click();
  } else if (mobile) {
    await expect(
      page.getByRole("navigation", { name: "底部导航" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator(".about-link").click();
  } else {
    await page.locator(".sidebar .about-link").click();
  }
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.locator(".about-page")).toBeVisible();
}

async function assertAboutContent() {
  const about = page.locator(".about-page");
  for (const label of [
    "Meterleaf",
    "独立 AI 用量账本",
    "数据模式",
    "许可证",
    "GitHub",
    "运行时",
    "时区",
  ])
    await expect(about.getByText(label, { exact: true })).toBeVisible();
  await expect(
    about.getByRole("link", { name: /InfinityPacer\/meterleaf/ }),
  ).toBeVisible();
  await expect(about.getByText("Apache-2.0", { exact: true })).toBeVisible();
  await expect(about.getByText("Bun", { exact: true })).toBeVisible();
  await expect(about.getByText("Asia/Shanghai", { exact: true })).toBeVisible();
  await expect(about.getByText("常用术语", { exact: true })).toHaveCount(0);
  await expect(about).not.toContainText(/估算口径|计价说明|订阅等价|标准 API/);
  await expect(
    about.locator(".profile-monogram, .app-profile-button, .account-avatar"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "返回总览", exact: true }),
  ).toHaveCount(0);
}

/**
 * 合并后的总览只有一个消耗趋势面板（Web 为 .desktop-period，App 为 .app-period），
 * 图表样式按总览（home）单独保存，默认面积图。
 */
async function assertOverviewChartControl(mobileApp: boolean) {
  const scope = page.locator(
    mobileApp ? ".app-period .trend-panel" : ".desktop-period .trend-panel",
  );
  await expect(scope).toBeVisible();
  const control = scope.getByRole("group", {
    name: "图表样式",
    exact: true,
  });
  await expect(control).toBeVisible();
  expect(
    await control
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
  ).toEqual(["折线图", "面积图", "柱状图", "饼图"]);

  const readStoredChart = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem("meterleaf-pref-home-chart");
      return raw ? JSON.parse(raw) : null;
    });
  const chart = scope.locator(".usage-chart");
  await expect.poll(readStoredChart).toBeNull();
  await expect(
    control.getByRole("button", { name: "面积图", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(chart).toHaveAttribute("data-chart-style", "area");

  for (const [label, value] of [
    ["折线图", "line"],
    ["柱状图", "bar"],
    ["饼图", "pie"],
    ["面积图", "area"],
  ] as const) {
    const button = control.getByRole("button", { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect.poll(readStoredChart).toBe(value);
    await expect(chart).toHaveAttribute("data-chart-style", value);
    // 饼图按模型汇总，不再提供时间粒度；App 布局的时间粒度在「筛选与计价」面板里。
    await expect(
      scope.getByRole("heading", {
        name: value === "pie" ? "消耗占比" : "消耗趋势",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      scope.getByRole("group", { name: "时间粒度", exact: true }),
    ).toHaveCount(value === "pie" || mobileApp ? 0 : 1);
  }
  await control.getByRole("button", { name: "柱状图", exact: true }).click();
  await expect.poll(readStoredChart).toBe("bar");
  await page.reload();
  await ready();
  await expect(
    control.getByRole("button", { name: "柱状图", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(chart).toHaveAttribute("data-chart-style", "bar");
  await control.getByRole("button", { name: "面积图", exact: true }).click();
  await expect.poll(readStoredChart).toBe("area");

  if (mobileApp) {
    const canvas = chart.locator("canvas").first();
    await expect(canvas).toBeVisible();
    await expectPainted(
      canvas,
      "mobile overview trend has painted data pixels",
    );
    const geometry = await control.evaluate((element) => {
      const controlBox = element.getBoundingClientRect();
      const trendBox =
        element.closest(".trend-panel")?.getBoundingClientRect() ?? controlBox;
      return {
        controlLeft: controlBox.left,
        controlRight: controlBox.right,
        trendLeft: trendBox.left,
        trendRight: trendBox.right,
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        buttons: [...element.querySelectorAll("button")].map((button) => {
          const box = button.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            left: box.left,
            right: box.right,
          };
        }),
      };
    });
    // mobile.css 为 App 总览的图表样式按钮设定 32×36。
    expect(
      geometry.buttons.every(
        ({ width, height }) =>
          Math.abs(width - 32) <= 0.5 && Math.abs(height - 36) <= 0.5,
      ),
      "mobile chart buttons are 32x36",
    ).toBe(true);
    expect(
      geometry.controlLeft,
      "mobile chart control stays in viewport",
    ).toBeGreaterThanOrEqual(-0.5);
    expect(
      geometry.controlRight,
      "mobile chart control stays in viewport",
    ).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
    expect(
      geometry.controlLeft,
      "mobile chart control stays in trend",
    ).toBeGreaterThanOrEqual(geometry.trendLeft - 0.5);
    expect(
      geometry.controlRight,
      "mobile chart control stays in trend",
    ).toBeLessThanOrEqual(geometry.trendRight + 0.5);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  }
}

// 当前页导航项的图标使用强调色 --accent（绿色配色：浅色 #0e8a55，深色 #3ccb8a），其余项不用。
async function assertCurrentNavigation(nav: Locator, theme: "light" | "dark") {
  const accent = theme === "light" ? "rgb(14, 138, 85)" : "rgb(60, 203, 138)";
  const current = nav.locator('button[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("用量总览");
  await expect(current).toHaveClass(/\bactive\b/);
  await expect(current.locator("svg")).toHaveCSS("color", accent);
  for (const other of await nav
    .locator("button:not([aria-current])")
    .locator("svg")
    .all())
    await expect(other).not.toHaveCSS("color", accent);
}

async function assertOverview(width: number, theme: "light" | "dark") {
  await page.goto(`${base}#overview`);
  await ready();
  await expect(page.getByRole("navigation", { name: "总览视图" })).toHaveCount(
    0,
  );
  await expect(page.locator(".mobile-home-title")).toHaveCount(0);
  await expect(page.locator(".mobile-home-period-link")).toHaveCount(0);
  const mobileApp = await page.evaluate(
    () =>
      innerWidth <= 900 &&
      document.documentElement.dataset.mobileLayout === "app",
  );
  await assertOverviewChartControl(mobileApp);
  // 总览默认历史至今：摘要与趋势按账本首条记录所在日到今天查询，按天汇总。
  await expect
    .poll(
      () =>
        viewRequests.some(
          (request) =>
            request.pageSize === 1 &&
            request.account === "all" &&
            request.from === demoStartDay &&
            request.granularity === "day",
        ),
      "overview summary and trend query all history by day",
    )
    .toBe(true);
  await expect(page.locator("main .metrics")).toHaveCount(0);
  if (!mobileApp) {
    await expect(page.locator("section.usage-summary")).toBeVisible();
    // 总览筛选栏只有日期范围和计价口径，模型与账户筛选留给统计报表和请求明细。
    const filterbar = page.locator("main > .filterbar");
    await expect(filterbar).toBeVisible();
    await expect(
      filterbar.getByRole("button", { name: "日期范围", exact: true }),
    ).toBeVisible();
    await expect(
      filterbar.getByRole("group", { name: "计价口径", exact: true }),
    ).toBeVisible();
    await expect(filterbar.getByRole("combobox")).toHaveCount(0);
    if (width > 900) {
      await expect(
        page.locator(".overview-quotas .account-capacity > strong"),
      ).toHaveText(expectedWeeklyEstimates);
      await expect(
        page
          .locator(".overview-quotas .account-capacity")
          .getByText(/未提供|未计价原因/),
      ).toHaveCount(0);
    }
  } else {
    await expect(page.locator(".mobile-home-summary")).toBeVisible();
    await expect(page.locator(".mobile-filterbar")).toBeVisible();
    await expect(
      page.locator(".mobile-period-presets > button:not(.date-range-trigger)"),
    ).toHaveText(["全部", "7 天", "30 天"]);
  }
  if (width > 900) {
    await assertCurrentNavigation(
      page.locator('.sidebar nav[aria-label="主导航"]'),
      theme,
    );
  } else if (!mobileApp) {
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await assertCurrentNavigation(
      drawer.locator('nav[aria-label="主导航"]'),
      theme,
    );
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  }
}

async function assertChartControls(width: number) {
  await page.goto(`${base}#overview`);
  await ready();
  const chartButtons = page.locator(".chart-style-control button");
  await expect(chartButtons).toHaveCount(4);
  for (const label of ["柱状图", "折线图", "面积图", "饼图"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  if (width <= 900) {
    const unit = page.getByRole("combobox", { name: "计量单位", exact: true });
    await unit.click();
    await page.getByRole("option", { name: "Credits", exact: true }).click();
    await expect(unit).toContainText("Credits");
    await expect(
      page.locator(".trend-panel .usage-chart").first(),
    ).toHaveAttribute("data-chart-unit", "credits");
  } else {
    const unit = page.getByRole("group", { name: "计量单位", exact: true });
    await unit.getByRole("button", { name: "Credits", exact: true }).click();
    await expect(
      unit.getByRole("button", { name: "Credits", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
}

/** 账户额度与账户趋势都在总览账户区；App 布局的首页卡片不带逐账户微趋势。 */
async function assertAccountsAndTrends() {
  await page.goto(`${base}#overview`);
  await ready();
  const mobileApp = await page.evaluate(
    () =>
      innerWidth <= 900 &&
      document.documentElement.dataset.mobileLayout === "app",
  );
  if (mobileApp) {
    const cards = page.locator(
      ".mobile-home-account-list > li[data-manageable]",
    );
    await expect(cards).toHaveCount(4);
    await expect(
      page.locator('.mobile-home-account-list > li[data-account-id="api"]'),
    ).toBeVisible();
    return;
  }
  const rows = page.locator(".overview-quotas .account-list-item");
  await expect(rows).toHaveCount(4);
  const api = page.locator(
    '.overview-quotas .account-list-item[data-account-id="api"]',
  );
  await expect(api).toBeVisible();
  const requestMiniTrends = rows.locator('.mini-trend[data-metric="requests"]');
  const mobile = await page.evaluate(() => innerWidth <= 900);
  if (!mobile)
    await expect.poll(() => requestMiniTrends.count()).toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        requestMiniTrends.evaluateAll((elements) =>
          elements.every(
            (element) => element.getAttribute("data-variant") === "line",
          ),
        ),
      "account request micro trends use line variant",
    )
    .toBe(true);
  if (mobile) {
    // 窄屏账户行改用紧凑布局：7d 预估跟在周额度的金额行里，不再单列预估栏。
    await expect(
      page.locator(".overview-quotas .account-capacity"),
    ).toHaveCount(0);
    const estimates = page.locator(
      '.overview-quotas .quota-window[data-window="sevenDay"] .quota-window-estimate',
    );
    await expect(estimates).toHaveCount(expectedWeeklyEstimates.length);
    for (const [index, value] of expectedWeeklyEstimates.entries())
      await expect(estimates.nth(index)).toContainText(value);
  } else {
    await expect(
      page.locator(".overview-quotas .account-capacity > strong"),
    ).toHaveText(expectedWeeklyEstimates);
    await expect(
      page
        .locator(".overview-quotas .account-capacity")
        .getByText(/未提供|未计价原因/),
    ).toHaveCount(0);
  }
  await expect(api.locator(".account-lifetime > span")).toHaveCount(3);
  await expect
    .poll(() => api.locator(".mini-trend-chart canvas").count())
    .toBe(mobile ? 1 : 3);
  await expect
    .poll(async () =>
      api.locator(".mini-trend-chart canvas").evaluateAll((canvases) =>
        canvases.every((canvas) => {
          const value = canvas as HTMLCanvasElement;
          const context = value.getContext("2d");
          if (!context || value.width === 0 || value.height === 0) return false;
          const pixels = context.getImageData(
            0,
            0,
            value.width,
            value.height,
          ).data;
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
        }),
      ),
    )
    .toBe(true);
  const apiRequests = viewRequests.filter(
    (request) => request.pageSize === 1 && request.account === "api",
  );
  expect(apiRequests.length).toBeGreaterThan(0);
  expect(
    apiRequests.every(
      (request) =>
        request.days === 7 &&
        request.granularity === "hour" &&
        request.pageSize === 1,
    ),
  ).toBe(true);
  expect(
    trendPayloads.some((payload) => {
      const [account, points, knownTokens, knownUsd] = payload.split(":");
      return (
        account === "api" &&
        Number(points) > 0 &&
        Number(knownTokens) > 0 &&
        Number(knownUsd) > 0
      );
    }),
  ).toBe(true);
}

async function openArchiveMenu(row: Locator) {
  await row.getByRole("button", { name: /账户操作$/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * 账户排序、只读菜单与归档删除都在总览账户区完成：归档后从使用中列表移除，
 * 经「已归档 N」进入归档列表恢复或删除。
 */
async function assertSortingAndArchiveBehavior(width: number) {
  await page.goto(`${base}#overview`);
  await page.reload();
  await ready();
  const rows = page.locator("[data-manageable]");
  await expect(rows).toHaveCount(4);
  const filter = page.getByRole("button", { name: "筛选与计价", exact: true });
  if (await filter.isVisible()) {
    await filter.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
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
    await expect(
      dialog.getByRole("button", { name: "调整账户顺序", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "完成", exact: true }).click();
  }
  const orderButton = page.getByRole("button", {
    name: "调整账户顺序",
    exact: true,
  });
  await expect(orderButton).toBeVisible();
  await expect(orderButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const operationButton = page.locator(".account-menu-trigger").first();
  await expect(operationButton).toHaveAttribute("data-variant", "ghost");
  await expect(operationButton).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const secondId = await rows.nth(1).getAttribute("data-account-id");
  await orderButton.click();
  await rows
    .nth(1)
    .getByRole("button", { name: /^上移 / })
    .click();
  await expect(rows.first()).toHaveAttribute("data-account-id", secondId!);
  await page.reload();
  await ready();
  await expect(rows.first()).toHaveAttribute("data-account-id", secondId!);
  const storedOrder = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("meterleaf-pref-account-order") ?? "[]"),
  );
  expect(storedOrder[0]).toBe(secondId);

  archiveState.writable = false;
  await page.reload();
  await ready();
  const readonlyMenu = await openArchiveMenu(rows.first());
  await expect(readonlyMenu.locator(".account-readonly-note")).toContainText(
    "只读数据，无法修改账户",
  );
  for (const label of ["归档账户", "删除账户"]) {
    const item = readonlyMenu.getByRole("menuitem", {
      name: label,
      exact: true,
    });
    await expect(item).toBeVisible();
    const disabled = await item.getAttribute("aria-disabled");
    const dataDisabled = await item.getAttribute("data-disabled");
    expect(disabled === "true" || dataDisabled !== null).toBe(true);
  }
  await page.keyboard.press("Escape");

  archiveState.writable = true;
  archiveState.archived = [];
  archiveState.hidden = [];
  archiveWrites.length = 0;
  await page.reload();
  await ready();
  const targetId = await rows.first().getAttribute("data-account-id");
  const target = page.locator(
    `[data-manageable][data-account-id="${targetId}"]`,
  );
  const archivedEntry = page.getByRole("button", { name: "已归档 1" });
  const activeEntry = page.getByRole("button", {
    name: "使用中账户",
    exact: true,
  });
  await expect(archivedEntry).toHaveCount(0);
  let menu = await openArchiveMenu(target);
  await menu.getByRole("menuitem", { name: "归档账户", exact: true }).click();
  await expect(target).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  expect(archiveState.archived).toContain(targetId);
  await archivedEntry.click();
  await expect(rows).toHaveCount(1);
  await expect(target).toBeVisible();
  menu = await openArchiveMenu(target);
  await menu.getByRole("menuitem", { name: "恢复账户", exact: true }).click();
  await expect(target).toHaveCount(0);
  expect(archiveState.archived).not.toContain(targetId);
  await activeEntry.click();
  await expect(target).toBeVisible();
  await expect(rows).toHaveCount(4);
  menu = await openArchiveMenu(target);
  await menu.getByRole("menuitem", { name: "归档账户", exact: true }).click();
  await archivedEntry.click();
  menu = await openArchiveMenu(target);
  await menu.getByRole("menuitem", { name: "删除账户", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("历史请求和统计仍保留");
  await confirmation.getByRole("button", { name: "删除", exact: true }).click();
  await expect(target).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await activeEntry.click();
  await expect(rows).toHaveCount(3);
  await expect(archivedEntry).toHaveCount(0);
  expect(archiveState.hidden).toContain(targetId);
  expect(
    archiveWrites.some(
      (value) => "archived" in value && value.id === targetId && value.archived,
    ),
  ).toBe(true);
  expect(
    archiveWrites.some(
      (value) =>
        "archived" in value && value.id === targetId && !value.archived,
    ),
  ).toBe(true);
  expect(
    archiveWrites.some((value) => "hidden" in value && value.id === targetId),
  ).toBe(true);
  expect(width).toBeGreaterThan(0);
}

try {
  await page.route(viewRoutePattern, viewRouteHandler);
  viewRouteInstalled = true;
  await page.route(archiveRoutePattern, archiveRouteHandler);
  archiveRouteInstalled = true;
  await page.route(syncRoutePattern, syncRouteHandler);
  syncRouteInstalled = true;

  const viewports = [
    [1586, 992],
    [901, 900],
    [390, 844],
    [320, 740],
    [844, 390],
  ] as const;
  const layouts = ["app", "sidebar"] as const;
  const themes = ["light", "dark"] as const;
  const screenshots: string[] = [];

  for (const [width, height] of viewports) {
    for (const layout of layouts) {
      for (const theme of themes) {
        await resetFixture(width, height, layout, theme);
        const key = `${layout}-${theme}-${width}x${height}`;
        await openAboutFromEntry(width, layout);
        await assertAboutContent();
        const aboutPath = `test-results/visual-feedback/${key}-about.png`;
        await page.screenshot({ path: aboutPath, fullPage: true });
        screenshots.push(aboutPath);

        await assertOverview(width, theme);
        await page.goto(`${base}#overview`);
        await ready();
        const overviewPath = `test-results/visual-feedback/${key}-overview.png`;
        await page.screenshot({ path: overviewPath, fullPage: true });
        screenshots.push(overviewPath);

        await assertChartControls(width);
        const periodPath = `test-results/visual-feedback/${key}-period.png`;
        await page.screenshot({ path: periodPath, fullPage: true });
        screenshots.push(periodPath);

        await assertAccountsAndTrends();
        const accountsPath = `test-results/visual-feedback/${key}-accounts.png`;
        await page.screenshot({ path: accountsPath, fullPage: true });
        screenshots.push(accountsPath);
      }
    }
  }

  archiveState.archived = [];
  archiveState.hidden = [];
  archiveState.writable = true;
  await resetFixture(390, 844, "app", "light");
  await assertSortingAndArchiveBehavior(390);
  await writeFile(
    "test-results/visual-feedback/summary.json",
    JSON.stringify(
      {
        status: "passed",
        viewports,
        layouts,
        themes,
        screenshots,
        overviewRangeContract: viewRequests.filter(
          (request) =>
            request.pageSize === 1 &&
            request.account === "all" &&
            request.from === demoStartDay,
        ),
        accountTrendContract: viewRequests.filter(
          (request) => request.pageSize === 1 && request.account !== "all",
        ),
        trendPayloads,
        archiveWrites,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      viewports,
      layouts,
      themes,
      screenshots: screenshots.length,
      routeWrites: archiveWrites.length,
    }),
  );
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
  page.off("requestfinished", recordViewRequest);
  await browser.close();
}
