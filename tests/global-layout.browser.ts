import { chromium, expect } from "@playwright/test";

const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(base));
if (!page)
  throw new Error("Open the task page through the browser manager first");

try {
  for (const width of [1440, 1200, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const tab of ["overview", "reports", "ledger"]) {
      await page.goto(`${base}#${tab}`);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", {
        timeout: 30000,
      });
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator(".topbar h1")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "刷新账本", exact: true }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const title = await page.locator(".topbar-title").boundingBox();
      const actions = await page.locator(".topbar-actions").boundingBox();
      expect(
        title &&
          actions &&
          (title.x + title.width <= actions.x ||
            title.y + title.height <= actions.y),
      ).toBeTruthy();
      if (tab === "overview") {
        // 账户额度并入总览：Web 布局是账户行，手机 App 布局是首页卡片；两者都不再链接独立账户页。
        await expect(page.getByText("全部账户", { exact: true })).toHaveCount(
          0,
        );
        const webQuotas = page.locator(".overview-quotas");
        if (await webQuotas.count()) {
          await expect(webQuotas.locator("#overview-quotas-title")).toHaveText(
            "账户额度",
          );
          if (width > 900) {
            // 桌面每个额度窗口占一行纵向排列，各账户的进度条左端对齐。
            const bars = webQuotas.locator(
              ".account-row .account-windows .quota-window-progress",
            );
            const boxes = [];
            for (const bar of await bars.all())
              boxes.push((await bar.boundingBox())!);
            expect(boxes.length).toBeGreaterThan(1);
            for (let i = 1; i < boxes.length; i++)
              expect(Math.abs(boxes[i]!.x - boxes[0]!.x)).toBeLessThan(1);
            const windows = webQuotas
              .locator('.account-row[data-has-quota="true"]')
              .first()
              .locator(".account-windows > .quota-window");
            if ((await windows.count()) >= 2) {
              const first = (await windows.nth(0).boundingBox())!;
              const second = (await windows.nth(1).boundingBox())!;
              expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
            }
          }
          for (const reset of await webQuotas
            .locator(".account-row .quota-window-reset")
            .all()) {
            await expect(reset).toBeVisible();
          }
          if (width <= 650) {
            const windows = webQuotas
              .locator(".account-row .account-windows")
              .first()
              .locator(":scope > .quota-window");
            if ((await windows.count()) >= 2) {
              const first = await windows.nth(0).boundingBox();
              const second = await windows.nth(1).boundingBox();
              expect(second!.y).toBeGreaterThanOrEqual(
                first!.y + first!.height,
              );
            }
          }
        } else {
          await expect(page.locator("#mobile-home-accounts-title")).toHaveText(
            "账户额度",
          );
        }
      }
      await page.waitForTimeout(700);
      await page.screenshot({
        path: `test-results/global-${width}-${tab}.png`,
        fullPage: true,
      });
    }
  }
  console.log(
    JSON.stringify({
      tabs: 3,
      widths: [1440, 1200, 768, 390, 320],
      uniqueTitle: true,
      overflow: false,
      resetsVisible: true,
      quotaBarsAligned: true,
    }),
  );
} finally {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await browser.close();
}
