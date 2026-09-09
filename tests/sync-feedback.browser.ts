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
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const durations: number[] = [];
  for (let index = 0; index < 3; index++) {
    await page.goto(base + "#overview");
    await page.reload();
    const icon = page.locator(".sync-trigger .sync-updated");
    await expect(icon).toHaveCount(1);
    const duration = await icon.evaluate((element) =>
      parseFloat(getComputedStyle(element).animationDuration),
    );
    expect(duration).toBeGreaterThanOrEqual(1);
    expect(duration).toBeLessThanOrEqual(2);
    durations.push(duration);
    await expect(icon).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator(".sync-trigger-label")).toHaveText(
      "更新于 09/09 04:25:36",
    );
    await expect(page.locator("main .sync-state")).toHaveCount(0);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator(".sync-trigger .sync-updated")).toHaveCSS(
    "animation-name",
    "none",
  );
  console.log(
    JSON.stringify({
      durations,
      timestampPreserved: true,
      reducedMotion: true,
    }),
  );
} finally {
  await page.unroute(pattern);
  await browser.close();
}
