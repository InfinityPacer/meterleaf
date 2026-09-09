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
let failure: "timeout" | "authentication" | null = null;
let syncWrites = 0;
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
const trackWrites = (request: { url(): string; method(): string }) => {
  const pathname = new URL(request.url()).pathname;
  if (
    request.method() !== "GET" &&
    (pathname === "/api/sync" || pathname === "/api/sync/automatic")
  )
    syncWrites += 1;
};

try {
  await page.route("**/api/sync/presence", async (route) => {
    requests += 1;
    if (failed && failure === "timeout") {
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ error: "gateway-timeout" }),
      });
      return;
    }
    if (failed && failure === "authentication") {
      await route.fulfill({
        status: 302,
        headers: {
          location: "/outpost.goauthentik.io/start",
        },
      });
      return;
    }
    await route.fulfill({ json: status });
  });
  page.on("request", trackWrites);
  await page.bringToFront();
  await page.goto(`${base}#overview`);
  await page.reload();

  const trigger = page.getByRole("button", {
    name: "数据同步",
    exact: true,
  });
  await expect(trigger).toHaveAttribute("aria-busy", "true");
  failed = true;
  failure = "timeout";
  await trigger.click();
  await expect(page.locator(".sync-status")).toHaveText("同步状态读取失败", {
    timeout: 10_000,
  });
  await expect(page.locator(".sync-popup .sync-error")).toContainText(
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

  failed = false;
  failure = null;
  await page.reload();
  await expect(trigger).toHaveAttribute("aria-busy", "true");
  failed = true;
  failure = "authentication";
  const authRequestsBeforeFailure = requests;
  await expect
    .poll(() => requests, { timeout: 10_000 })
    .toBeGreaterThan(authRequestsBeforeFailure);
  await trigger.click();
  await expect(page.locator(".sync-status")).toHaveText("需要重新认证", {
    timeout: 10_000,
  });
  await expect(page.locator(".sync-popup .sync-error")).toHaveText(
    "同步状态认证失败，请重新认证",
  );
  await expect(
    page.getByRole("button", { name: "重新认证", exact: true }),
  ).toBeVisible();
  expect(requests).toBe(authRequestsBeforeFailure + 1);
  const authRequests = requests;
  await page.waitForTimeout(4000);
  expect(requests).toBe(authRequests);
  expect(syncWrites).toBe(0);

  const reload = page.waitForEvent("framenavigated");
  await page.getByRole("button", { name: "重新认证", exact: true }).click();
  await reload;
  expect(syncWrites).toBe(0);
  console.log(
    JSON.stringify({
      statusReadFailure: true,
      staleRunningDoesNotSpin: true,
      pollingBackedOff: true,
      authenticationRequiresReload: true,
      authenticationPollingStopped: true,
      syncWrites,
      requests,
    }),
  );
} finally {
  await page.unroute("**/api/sync/presence");
  page.off("request", trackWrites);
  await page.reload();
  await browser.close();
}
