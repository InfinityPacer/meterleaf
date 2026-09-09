import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const base =
  process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4330/?request-layout";
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(base));
if (!page) throw new Error("Open a dedicated managed request-layout tab first");
const saved = {
  url: page.url(),
  viewport: page.viewportSize(),
  storage: await page.evaluate(() => ({ ...localStorage })),
};
await mkdir("test-results/mobile-request-layout", { recursive: true });
try {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((theme) => {
      localStorage.setItem("meterleaf-theme", theme);
      localStorage.setItem(
        "meterleaf-pref-mobile-layout",
        JSON.stringify("app"),
      );
    }, theme);
    for (const [width, height] of [
      [320, 740],
      [393, 852],
      [844, 390],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}#ledger`);
      await page.reload();
      const item = page.locator(".mobile-request-item").first();
      await expect(item).toBeVisible();
      await expect(item.locator(".mobile-request-heading")).not.toContainText(
        "N/A",
      );
      await expect(item.locator(".mobile-request-meta")).not.toContainText(
        "N/A",
      );
      await expect(item.locator(".mobile-request-account")).toContainText(
        "账户",
      );
      const geometry = await item.evaluate((element) => {
        const rect = (selector: string) =>
          element.querySelector(selector)!.getBoundingClientRect();
        const model = rect(".mobile-request-model");
        const price = rect("strong");
        const time = rect("time");
        const account = rect(".mobile-request-account");
        return {
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          primaryAligned: Math.abs(model.y - price.y) < 2,
          primaryGap: price.left - model.right,
          secondaryBelow: time.top >= Math.max(model.bottom, price.bottom),
          secondaryGap: account.left - time.right,
        };
      });
      expect(geometry).toMatchObject({
        noOverflow: true,
        primaryAligned: true,
        secondaryBelow: true,
      });
      expect(geometry.primaryGap).toBeGreaterThanOrEqual(9);
      expect(geometry.secondaryGap).toBeGreaterThanOrEqual(11);
      await page.screenshot({
        path: `test-results/mobile-request-layout/${width}-${theme}.png`,
      });
      await item.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("来源 ID");
      await expect(dialog).not.toContainText("未提供");
      await page.keyboard.press("Escape");
      await expect(item).toBeFocused();
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(page.locator(".ledger-page-summary")).toContainText("第 2");
    }
  }
  console.log(
    JSON.stringify({
      status: "passed",
      states: 6,
      checks:
        "request hierarchy, labeled account, no placeholder metadata, detail and pagination",
    }),
  );
} finally {
  await page.evaluate((storage) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage))
      localStorage.setItem(key, value);
  }, saved.storage);
  if (saved.viewport) await page.setViewportSize(saved.viewport);
  await page.goto(saved.url);
  await browser.close();
}
