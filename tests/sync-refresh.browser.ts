import { chromium, expect } from "@playwright/test";

const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith(base));
if (!page) throw new Error("Existing task page required");
let revision = 1;
let heartbeats = 0;
let views = 0;
const track = (request: { url(): string }) => {
  if (new URL(request.url()).pathname === "/api/view") views += 1;
};
const routePattern = "**/api/sync/presence";
try {
  // 模拟两次查询之间已完成的任务，不向真实上游提交同步。
  await page.route(routePattern, async (route) => {
    heartbeats += 1;
    await route.fulfill({
      json: {
        autoEnabled: true,
        running: false,
        phase: "idle",
        localRecords: 0,
        batchRecords: 0,
        batchPages: 0,
        hasSynced: true,
        lastAttempt: `2026-09-08T20:25:${String(revision).padStart(2, "0")}Z`,
        lastSuccess: `2026-09-08T20:25:${String(revision).padStart(2, "0")}Z`,
        error: null,
        quotaError: null,
        lastError: null,
        initialComplete: true,
        initialCompleteAt: null,
        lastSweep: null,
      },
    });
  });
  await page.bringToFront();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(base + "#overview");
  await page.reload();
  await expect.poll(() => heartbeats).toBeGreaterThan(0);
  page.on("request", track);
  for (const tab of ["overview", "accounts", "reports", "ledger"]) {
    await page.goto(base + "#" + tab);
    await expect(page.locator("main .sync-state")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "刷新账本", exact: true })).toHaveCount(0);
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", {
      timeout: 15000,
    });
    await page.waitForTimeout(1500);
    const before = views;
    revision += 1;
    await expect.poll(() => views, { timeout: 20000 }).toBeGreaterThan(before);
    await expect(page.locator(".sync-trigger-label")).toHaveText(
      `更新于 09/09 04:25:${String(revision).padStart(2, "0")}`,
    );
  }
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(1500);
  const unchanged = views;
  const heartbeat = heartbeats;
  await expect
    .poll(() => heartbeats, { timeout: 20000 })
    .toBeGreaterThan(heartbeat);
  await page.waitForTimeout(500);
  expect(views).toBe(unchanged);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(500);
  const hiddenHeartbeat = heartbeats;
  revision += 1;
  await page.waitForTimeout(16_000);
  expect(heartbeats).toBe(hiddenHeartbeat);
  const beforeResume = views;
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => views, { timeout: 5000 })
    .toBeGreaterThan(beforeResume);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 1440) {
      const gap = await page.evaluate(() => {
        const brand = document
          .querySelector(".sidebar .brand")!
          .getBoundingClientRect();
        const nav = document
          .querySelector(".sidebar nav")!
          .getBoundingClientRect();
        return nav.top - brand.bottom;
      });
      expect(gap).toBe(16);
    }
    await page.getByRole("button", { name: "数据同步", exact: true }).click();
    await expect(page.getByText("自动同步", { exact: true })).toBeVisible();
    await expect(page.getByText("自动刷新", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `/tmp/meterleaf-sync-${width}.png` });
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  console.log(
    JSON.stringify({
      allTabsRefreshOnCompletion: true,
      unchangedSkipsView: true,
      hiddenStopsAndResumeRefreshes: true,
      heartbeats,
    }),
  );
} finally {
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  page.off("request", track);
  await page.unroute(routePattern);
  await page.setViewportSize({ width: 1440, height: 900 });
  await browser.close();
}
