import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createLedgerView } from "../src/shared/ledger-view";

const base =
  process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4332/?pricing-regression";
if (new URL(base).hostname !== "127.0.0.1")
  throw new Error("Dedicated local test origin required");
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(base));
if (!page) throw new Error("Open a managed pricing-regression tab first");
const saved = await page.evaluate(() => ({ ...localStorage }));
const snapshot = createDemoLedger();
const fixture = createLedgerView(snapshot, {
  filter: { days: 7, account: "all", model: "all", search: "" },
  unit: "usd",
  granularity: "day",
  dimension: "model",
  page: 0,
  pageSize: 12,
  sort: "occurredAt",
  desc: true,
});
const summary = (value: number | null) => ({
  value: value ?? 0,
  hasKnown: value !== null,
  knownRows: value === null ? 0 : 1,
  incompleteRows: 1,
});
fixture.view.units.usd.breakdown = [
  { model: "priced-alpha", count: 2, summary: summary(3) },
  { model: "priced-beta", count: 2, summary: summary(7) },
  { model: "tokens-only", count: 2, summary: summary(null) },
];
fixture.view.units.tokens.breakdown = fixture.view.units.usd.breakdown.map(
  (row) => ({ ...row, summary: summary(100) }),
);
await mkdir("test-results/pricing-presentation", { recursive: true });
await page.route("**/api/view?**", (route) => route.fulfill({ json: fixture }));
const errors: string[] = [];
const onError = (error: Error) => errors.push(error.message);
page.on("pageerror", onError);
try {
  for (const layout of ["app", "sidebar"]) {
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
      [844, 390],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.evaluate((layout) => {
        localStorage.setItem(
          "meterleaf-pref-mobile-layout",
          JSON.stringify(layout),
        );
        localStorage.setItem(
          "meterleaf-pref-distribution-unit",
          JSON.stringify("usd"),
        );
        localStorage.setItem("meterleaf-theme", "dark");
        localStorage.setItem("meterleaf-pref-report-dimension", JSON.stringify("model"));
      }, layout);
      await page.goto(`${base}#reports`);
      await page.reload();
      const distribution = page.locator(".model-distribution");
      await expect(distribution).toBeVisible();
      await expect(distribution.locator("tbody tr")).toHaveCount(2);
      await expect(distribution.locator(".mobile-model-list > li")).toHaveCount(
        2,
      );
      await expect(distribution).toContainText("30.0%");
      await expect(distribution).toContainText("70.0%");
      await expect(distribution).not.toContainText("tokens-only");
      await expect(page.locator("main")).not.toContainText(
        /已计价|已知小计|条不完整|字段不完整|未计价|未知/,
      );
      await expect(page.locator("main")).not.toContainText(/估算费用|USD 估值|独立估值/);
      const toggle =
        width! > 900 || layout === "sidebar"
          ? distribution.getByRole("button", { name: "按 Tokens", exact: true })
          : distribution.getByRole("button", { name: "Tokens", exact: true });
      await toggle.click();
      await expect(distribution.locator("tbody tr")).toHaveCount(3);
      await expect(distribution).toContainText("tokens-only");
      await expect(distribution).not.toContainText("未知");
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      const canvas = distribution.locator("canvas");
      await expect(canvas).toBeVisible();
      expect(
        await canvas.evaluate((element: HTMLCanvasElement) => {
          if (!element.width || !element.height) return false;
          const data = element
            .getContext("2d")!
            .getImageData(0, 0, element.width, element.height).data;
          return data.some((value, index) => index % 4 === 3 && value > 0);
        }),
      ).toBe(true);
      await distribution.screenshot({
        path: `test-results/pricing-presentation/${layout}-${width}.png`,
      });
      await page.goto(`${base}#ledger`);
      await page.locator("[data-request-id]:visible").first().click();
      const detail = page.locator(".detail-sheet");
      await expect(detail).toBeVisible();
      await expect(detail).toContainText("费用");
      await expect(detail).toContainText("网关成本");
      await expect(detail).toContainText("网关计费");
      await expect(detail).not.toContainText(/估值|估算|另一套|费率版本|订阅等价|标准 API/);
      await detail.screenshot({ path: `test-results/pricing-presentation/detail-${layout}-${width}.png` });
      await page.keyboard.press("Escape");
      await expect(detail).toHaveCount(0);
      await page.goto(`${base}#settings`);
      const about = page.locator(".about-page");
      await expect(about).toBeVisible();
      await expect(about).not.toContainText(/估算|计价|订阅等价|标准 API/);
      await expect(about).toContainText("许可证");
      await about.screenshot({ path: `test-results/pricing-presentation/about-${layout}-${width}.png` });
    }
  }
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      states: 6,
      unitSwitch: true,
      matchingChartAndList: true,
      noIncompleteBadges: true,
      conciseCostLabels: true,
      detailsAndAbout: true,
      noOverflow: true,
      canvasPixels: true,
    }),
  );
} finally {
  await page.unroute("**/api/view?**");
  page.off("pageerror", onError);
  await page.evaluate((saved) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(saved))
      localStorage.setItem(key, value);
  }, saved);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await browser.close();
}
