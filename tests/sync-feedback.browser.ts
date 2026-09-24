import { chromium, expect } from "@playwright/test";

const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith(base));
if (!page) throw new Error("Existing task page required");
const pattern = "**/api/sync/presence";
try {
  await page.route(pattern, (route) =>
    route.fulfill({
      json: {
        autoEnabled: false,
        running: false,
        phase: "idle",
        localRecords: 0,
        lastSuccess: "2026-09-08T20:25:36Z",
        initialComplete: true,
      },
    }),
  );
  await page.bringToFront();
  // 触发器显示上次成功的同步时间并在重载后保持；页面主体不重复同步状态。
  for (let index = 0; index < 3; index++) {
    await page.goto(base + "#overview");
    await page.reload();
    await expect(page.locator(".sync-trigger-label")).toHaveText(
      "更新于 09/09 04:25:36",
    );
    await expect(
      page.getByRole("button", { name: "数据同步", exact: true }),
    ).toHaveAttribute("title", "数据同步 · 更新于 09/09 04:25:36");
    await expect(page.locator(".sync-trigger-badge")).toHaveCount(0);
    await expect(page.locator("main .sync-state")).toHaveCount(0);
  }
  console.log(
    JSON.stringify({
      reloads: 3,
      timestampPreserved: true,
    }),
  );
} finally {
  await page.unroute(pattern);
  await browser.close();
}
