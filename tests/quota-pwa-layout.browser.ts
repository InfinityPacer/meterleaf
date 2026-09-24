import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createLedgerView, type ViewQuery } from "../src/shared/ledger-view";
import type { AccountWindow } from "../src/shared/report";

const base =
  process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4332/?quota-pwa";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("Local task origin required");
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith(base));
if (!page)
  throw new Error("Open the dedicated task tab through browser-manager");
const saved = {
  url: page.url(),
  viewport: page.viewportSize(),
  storage: await page.evaluate(() => ({ ...localStorage })),
};
const cdp = await page.context().newCDPSession(page);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const demo = createDemoLedger();
const now = new Date().toISOString();
const shift = Date.parse(now) - Date.parse(demo.asOf);
demo.asOf = now;
demo.records = demo.records.slice(0, 1000).map((row) => ({
  ...row,
  occurredAt: new Date(Date.parse(row.occurredAt) + shift).toISOString(),
}));
function window(percent: number | null): AccountWindow {
  return {
    percent,
    state: "active",
    resetsAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
    sampledAt: now,
    periodUsd: "844.5",
    periodCredits: "2000",
    periodTokens: 767520000,
    periodRequests: 5698,
    estimate: {
      usd: "1481.58",
      credits: "37039.57",
      deltaPercent: null,
      reason: "eligible",
    },
  };
}
demo.accounts = [
  {
    ...demo.accounts[0]!,
    name: "20x",
    plan: "Pro",
    fiveHour: window(null),
    sevenDay: window(57),
  },
  {
    ...demo.accounts[1]!,
    name: "plus",
    plan: "Plus",
    fiveHour: window(75),
    sevenDay: window(100),
  },
  {
    ...demo.accounts[2]!,
    name: "API",
    kind: "api",
    fiveHour: null,
    sevenDay: null,
  },
];
let weeklyFull = true;
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/view") {
    const q = url.searchParams;
    const query: ViewQuery = {
      filter: {
        days: Number(q.get("days") ?? 7),
        account: q.get("account") ?? "all",
        model: "all",
        search: "",
      },
      unit: "usd",
      granularity: "day",
      dimension: "account",
      page: 0,
      pageSize: Number(q.get("pageSize") ?? 12),
      sort: "occurredAt",
      desc: true,
    };
    demo.accounts[1]!.sevenDay!.percent = weeklyFull ? 100 : 92;
    const result = createLedgerView(demo, query);
    result.lifetimeTotals = {
      asOf: now,
      from: demo.records.at(-1)!.occurredAt,
      to: now,
      count: 262943,
      tokens: {
        input: 1e9,
        cacheRead: 36e9,
        cacheWrite: 0,
        output: 30e6,
        total: 37030000000,
        incomplete: 0,
      },
      usd: "17085.17",
      apiUsd: "17085.17",
      subscriptionUsd: "17085.17",
      credits: "420000",
      incomplete: { usd: 0, apiUsd: 0, subscriptionUsd: 0, credits: 0 },
      usdBasis: "subscription",
      priceVersion: "fixture",
    };
    await route.fulfill({ json: result });
  } else if (url.pathname.includes("archive")) {
    await route.fulfill({
      json: { archived: [], hidden: [], writable: false },
    });
  } else {
    await route.fulfill({
      json: {
        autoEnabled: false,
        localRecords: demo.records.length,
        batchRecords: 0,
        batchPages: 0,
        hasSynced: true,
        running: false,
        error: null,
        lastSuccess: now,
        initialComplete: true,
      },
    });
  }
});
await mkdir("test-results/quota-pwa", { recursive: true });
let states = 0;
try {
  for (const width of [320, 390, 844, 1000, 1200, 1440]) {
    for (const layout of ["app", "sidebar"]) {
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({
          width,
          height: width === 844 ? 390 : 1000,
        });
        await page.emulateMedia({
          colorScheme: theme as "light" | "dark",
          reducedMotion: "reduce",
        });
        await page.evaluate(
          ({ layout, theme }) => {
            localStorage.setItem(
              "meterleaf-pref-mobile-layout",
              JSON.stringify(layout),
            );
            localStorage.setItem("meterleaf-theme", theme);
          },
          { layout, theme },
        );
        for (const route of ["overview", "accounts"]) {
          await page.goto(`${base}#${route}`);
          await page.reload();
          const mobileHome =
            width <= 900 && layout === "app" && route === "overview";
          const cards = page.locator(
            mobileHome ? ".mobile-home-account-card" : ".account-row",
          );
          const pro = cards.filter({ hasText: "20x" });
          const plus = cards.filter({ hasText: "plus" });
          await expect(pro).toBeVisible();
          await expect(pro.getByRole("progressbar")).toHaveCount(1);
          await expect(plus.getByRole("progressbar")).toHaveCount(
            width > 900 ? 2 : 1,
          );
          await expect(plus.getByRole("progressbar").last()).toHaveAttribute(
            "aria-valuenow",
            "100",
          );
          await expect(pro).not.toContainText("5h");
          if (width > 900) await expect(plus).toContainText("5h");
          else await expect(plus).not.toContainText("5h");
          await expect(pro).toContainText("7d");
          await expect(plus).not.toContainText("已用尽");
          await expect(plus).not.toContainText("使用中");
          const fill = plus
            .getByRole("progressbar")
            .last()
            .locator(":scope > span");
          expect(
            await fill.evaluate((el) => getComputedStyle(el).backgroundColor),
          ).toBe("rgb(217, 78, 105)");
          expect(
            await fill.evaluate((el) => getComputedStyle(el).backgroundColor),
          ).not.toBe(
            await pro
              .getByRole("progressbar")
              .locator(":scope > span")
              .evaluate((el) => getComputedStyle(el).backgroundColor),
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await expect(
            plus.locator(
              ".quota-cost-estimate, .account-capacity > small, .account-capacity > strong",
            ),
          ).toHaveCount(0);
          if (width > 900 && route === "accounts") {
            await expect(
              plus.locator(".account-capacity .mini-trend"),
            ).toBeVisible();
            if (width > 1000) {
              expect(
                Math.abs(
                  (await pro.boundingBox())!.height -
                    (await plus.boundingBox())!.height,
                ),
              ).toBeLessThan(2);
            }
          }
          if (width <= 900) {
            const pair = pro.locator(".quota-cost-pair").first();
            const estimate = pair.locator(".quota-cost-estimate");
            await expect(estimate).toBeVisible();
            await expect(estimate).toHaveText("$1,481.58");
            await expect(pair.locator(".quota-cost-separator")).toHaveText("·");
            const currentBox = (await pair.locator("strong").boundingBox())!;
            const estimateBox = (await estimate.boundingBox())!;
            expect(estimateBox.x).toBeGreaterThan(
              currentBox.x + currentBox.width,
            );
            expect(Math.abs(estimateBox.y - currentBox.y)).toBeLessThan(4);
            expect(
              await pair.evaluate((el) => el.scrollWidth <= el.clientWidth),
            ).toBe(true);
            expect(
              await estimate.evaluate((el) => getComputedStyle(el).fontStyle),
            ).toBe("italic");
            if (route === "accounts") {
              const title = (await pro
                .locator(".quota-bar > div:first-child > span:first-child")
                .boundingBox())!;
              const status = (await pro
                .locator(".quota-bar .tabular")
                .boundingBox())!;
              expect(Math.abs(title.y - status.y)).toBeLessThan(3);
            }
          }
          if (width >= 1200 && route === "accounts") {
            const capacity = (await pro
              .locator(".account-capacity")
              .boundingBox())!;
            const period = (await pro
              .locator(".account-window")
              .boundingBox())!;
            expect(capacity.width).toBeGreaterThan(180);
            expect(capacity.x).toBeGreaterThanOrEqual(period.x + period.width);
          }
          if ([390, 1440].includes(width))
            await page.screenshot({
              path: `test-results/quota-pwa/${width}-${layout}-${theme}-${route}.png`,
              fullPage: true,
            });
          await pro.click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          await expect(dialog).not.toContainText("5h");
          await expect(dialog.getByRole("progressbar")).toHaveCount(1);
          await page.keyboard.press("Escape");
          states++;
        }
      }
    }
  }
  weeklyFull = false;
  for (const layout of ["app", "sidebar"]) {
    for (const width of [320, 390, 844, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        (layout) =>
          localStorage.setItem(
            "meterleaf-pref-mobile-layout",
            JSON.stringify(layout),
          ),
        layout,
      );
      for (const route of ["overview", "accounts"]) {
        await page.goto(`${base}#${route}`);
        await page.reload();
        const cards = page.locator(
          route === "overview" && width <= 900 && layout === "app"
            ? ".mobile-home-account-card"
            : ".account-row",
        );
        const bars = cards.filter({ hasText: "plus" }).getByRole("progressbar");
        await expect(bars).toHaveCount(2);
        const one = (await bars.nth(0).boundingBox())!,
          two = (await bars.nth(1).boundingBox())!;
        expect(two.y >= one.y + one.height || two.x >= one.x + one.width).toBe(
          true,
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (width === 390)
          await page.screenshot({
            path: `test-results/quota-pwa/two-${layout}-${route}.png`,
            fullPage: true,
          });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() =>
    localStorage.setItem("meterleaf-pref-mobile-layout", JSON.stringify("app")),
  );
  await page.reload();
  expect(
    await page.locator('meta[name="viewport"]').getAttribute("content"),
  ).toContain("viewport-fit=cover");
  for (const [bottom, bottomMax] of [
    [0, 0],
    [34, 34],
    [0, 34],
  ]) {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { bottom, bottomMax },
    });
    const nav = page.getByRole("navigation", { name: "底部导航" });
    await expect(nav).toHaveCSS("height", `${56 + bottom!}px`);
    const geometry = await nav.evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      labels: [...element.querySelectorAll("button span")].map(
        (label) => innerHeight - label.getBoundingClientRect().bottom,
      ),
    }));
    expect(geometry.bottom).toBe(844);
    expect(
      geometry.labels.every((gap) => gap >= bottom! + 7 && gap <= bottom! + 9),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/quota-pwa/safe-${bottom}-${bottomMax}.png`,
    });
  }
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({ states, twoWindowStates: 16, safeAreaStates: 3, errors }),
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  console.error({ errors, url: page.url() });
  await page.screenshot({
    path: "test-results/quota-pwa/failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
  await cdp.detach();
  await page.unroute("**/api/**");
  await page.evaluate((storage) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage))
      localStorage.setItem(key, value);
  }, saved.storage);
  await page.emulateMedia({ colorScheme: null, reducedMotion: null });
  if (saved.viewport) await page.setViewportSize(saved.viewport);
  await page.goto(saved.url);
  await browser.close();
}
