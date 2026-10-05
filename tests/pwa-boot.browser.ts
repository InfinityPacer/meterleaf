import { chromium, expect } from "@playwright/test";

const endpoint = process.env.METERLEAF_CDP_URL;
if (!endpoint) throw new Error("METERLEAF_CDP_URL is required");
const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4329/";
const browser = await chromium.connectOverCDP(endpoint);

try {
  for (const scenario of [
    { name: "mobile-dark-css", width: 390, dark: true, asset: "css" },
    { name: "desktop-light-css", width: 1440, dark: false, asset: "css" },
    { name: "mobile-reduced-js", width: 390, dark: false, asset: "js" },
    { name: "mobile-api", width: 390, dark: true, asset: "api" },
    { name: "css-error-before-js", width: 390, dark: true, asset: "error" },
  ]) {
    // 独立上下文隔离缓存、主题和 SW，不改动维护者预览页。
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: 844 },
      colorScheme: scenario.dark ? "dark" : "light",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const page = await context.newPage();
      await page.route("**/api/**", async (route) => {
        if (scenario.asset === "api") await gate;
        await route.fulfill({
          status: 503,
          json: { error: "test unavailable" },
        });
      });
      if (scenario.asset === "error") {
        await page.route("**/assets/*.css", (route) => route.abort());
      }
      if (scenario.asset !== "api") {
        const extension = scenario.asset === "error" ? "js" : scenario.asset;
        await page.route(`**/assets/*.${extension}`, async (route) => {
          await gate;
          await route.continue();
        });
      }
      await page.goto(base, { waitUntil: "commit" });
      if (scenario.asset === "api") {
        await expect(page.locator(".app-shell")).toBeVisible();
      } else {
        await expect(page.locator(".boot-shell")).toBeVisible();
        // DOM 存在和尺寸可见不能证明首绘，必须在资源仍被拦截时看到 FCP。
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                performance.getEntriesByName("first-contentful-paint").length,
            ),
          )
          .toBe(1);
        await expect(page.locator(".app-shell")).toHaveCount(0);
      }
      const paints = await page.evaluate(() =>
        performance.getEntriesByType("paint").map((entry) => ({
          name: entry.name,
          ms: Math.round(entry.startTime),
        })),
      );
      release();
      if (scenario.asset === "error") {
        await expect(page.locator(".boot-shell")).toContainText(
          "页面样式加载失败，请重新打开 Meterleaf。",
        );
        await expect(page.locator(".app-shell")).toHaveCount(0);
      } else {
        await expect(page.locator(".app-shell")).toBeVisible();
        await expect(page.locator(".boot-shell")).toHaveCount(0);
        await expect
          .poll(() =>
            page.evaluate(() =>
              Array.from(
                document.querySelectorAll<HTMLLinkElement>(
                  "link[data-app-styles]",
                ),
              ).every((link) => link.media === "all" && !!link.sheet),
            ),
          )
          .toBe(true);
      }
      console.log(JSON.stringify({ scenario: scenario.name, paints }));
    } finally {
      release();
      await context.close();
    }
  }
} finally {
  await browser.close();
}
