import { chromium, expect } from "@playwright/test";

const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4317/";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
  throw new Error("Local test page required");
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(base));
if (!page) throw new Error("Existing task page required");

let failed = false;
let requests = 0;
const status = {
  autoEnabled: false,
  running: true,
  phase: "incremental",
  localRecords: 12,
  batchRecords: 1,
  batchPages: 1,
  hasSynced: true,
  lastAttempt: "2026-09-09T02:25:00.000Z",
  lastSuccess: "2026-09-09T02:24:00.000Z",
  error: null,
  quotaError: null,
  lastError: null,
  initialComplete: true,
  initialCompleteAt: "2026-09-08T02:00:00.000Z",
  lastSweep: "2026-09-09T02:00:00.000Z",
};

try {
  await page.route("**/api/sync/presence", async (route) => {
    requests += 1;
    if (failed) {
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ error: "gateway-timeout" }),
      });
      return;
    }
    await route.fulfill({ json: status });
  });
  await page.bringToFront();
  await page.goto(`${base}#overview`);
  await page.reload();

  const trigger = page.getByRole("button", {
    name: "数据同步",
    exact: true,
  });
  await expect(trigger).toHaveAttribute("aria-busy", "true");
  failed = true;
  await trigger.click();
  await expect(page.locator(".sync-status")).toHaveText("同步状态读取失败", {
    timeout: 10_000,
  });
  await expect(page.locator(".sync-popup [role=alert]")).toContainText(
    "网关超时（HTTP 504）",
  );
  await expect(trigger).toHaveAttribute(
    "title",
    "数据同步 · 更新于 09/09 10:24:00",
  );
  await expect(trigger).toContainText("需处理");
  await expect(trigger).not.toHaveAttribute("aria-busy", "true");
  await expect(trigger.locator(".spinning")).toHaveCount(0);

  const failedRequests = requests;
  await page.waitForTimeout(4000);
  expect(requests).toBe(failedRequests);
  console.log(
    JSON.stringify({
      statusReadFailure: true,
      staleRunningDoesNotSpin: true,
      pollingBackedOff: true,
      requests,
    }),
  );
} finally {
  await page.unroute("**/api/sync/presence");
  await page.reload();
  await browser.close();
}
