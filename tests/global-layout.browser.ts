import { chromium, expect } from "@playwright/test";

const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(base));
if (!page) throw new Error("Open the task page through the browser manager first");

try {
  for (const width of [1440, 1200, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const tab of ["overview", "accounts", "reports", "ledger"]) {
      await page.goto(`${base}#${tab}`);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", { timeout: 30000 });
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator(".topbar h1")).toBeVisible();
      await expect(page.getByRole("button", { name: "刷新账本", exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const title = await page.locator(".topbar-title").boundingBox();
      const actions = await page.locator(".topbar-actions").boundingBox();
      expect(title && actions && (title.x + title.width <= actions.x || title.y + title.height <= actions.y)).toBeTruthy();
      if (tab === "accounts") {
        // 账户页只有列表标题一个二级标题，页面主标题仍在顶栏 h1。
        await expect(page.locator("main h2")).toHaveCount(1);
        await expect(page.locator("main .account-actions-heading h2")).toContainText("账户");
        if (width > 900) {
          // 桌面每个额度窗口占一行纵向排列，各账户的进度条左端对齐。
          const bars = page.locator(".account-row .account-windows .quota-window-progress");
          const boxes = [];
          for (const bar of await bars.all()) boxes.push((await bar.boundingBox())!);
          for (let i = 1; i < boxes.length; i++) expect(Math.abs(boxes[i]!.x - boxes[0]!.x)).toBeLessThan(1);
          const windows = page.locator('.account-row[data-has-quota="true"]').first().locator(".account-windows > .quota-window");
          if (await windows.count() >= 2) {
            const first = (await windows.nth(0).boundingBox())!;
            const second = (await windows.nth(1).boundingBox())!;
            expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
          }
        }
        for (const reset of await page.locator(".account-row .quota-window-reset").all()) {
          await expect(reset).toBeVisible();
        }
        if (width <= 650) {
          const windows = page.locator(".account-row .account-windows").first().locator(":scope > .quota-window");
          if (await windows.count() >= 2) {
            const first = await windows.nth(0).boundingBox();
            const second = await windows.nth(1).boundingBox();
            expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
          }
        }
      }
      await page.waitForTimeout(700);
      await page.screenshot({ path: `test-results/global-${width}-${tab}.png`, fullPage: true });
    }
  }
  console.log(JSON.stringify({ tabs: 4, widths: [1440, 1200, 768, 390, 320], uniqueTitle: true, overflow: false, resetsVisible: true, quotaBarsAligned: true }));
} finally {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await browser.close();
}
