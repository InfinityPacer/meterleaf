import { chromium, expect } from "@playwright/test";

// 总览账户行：无额度账户优先展示历史累计，缺少累计才用当前区间汇总；额度账户展示当前窗口统计。
const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
  throw new Error("Local test page required");
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(base));
if (!page) throw new Error("Existing local task page required");
const template = await fetch(new URL("api/view?days=7", base)).then(
  (response) => response.json(),
);
const apiAccount = template.accounts.find(
  (account: any) => !account.fiveHour && !account.sevenDay,
);
const subscriptionAccount = template.accounts.find(
  (account: any) => account.kind === "subscription",
);
if (!apiAccount || !subscriptionAccount)
  throw new Error("Accounts with and without quota are required");
let withLifetime = false;
await page.route("**/api/view?**", async (route) => {
  const result = structuredClone(template);
  for (const variant of [
    result,
    ...Object.values(result.usdVariants ?? {}),
  ] as any[]) {
    variant.view.accountUsage = {
      [apiAccount.id]: {
        count: 84,
        tokens: 8400,
        usd: "8.4",
        incompleteTokens: 0,
        incompleteUsd: 0,
      },
    };
    const api = variant.accounts.find(
      (account: any) => account.id === apiAccount.id,
    );
    if (api) {
      if (withLifetime)
        api.lifetime = {
          count: 5000,
          tokens: 50_000_000,
          usd: "500",
          incompleteTokens: 0,
          incompleteUsd: 0,
        };
      else delete api.lifetime;
    }
    const subscription = variant.accounts.find(
      (account: any) => account.id === subscriptionAccount.id,
    );
    for (const [key, hours] of [
      ["fiveHour", 2],
      ["sevenDay", 144],
    ] as const) {
      subscription[key] = {
        ...subscription[key],
        percent: 7,
        state: "active",
        resetsAt: new Date(Date.now() + hours * 3600000).toISOString(),
        periodRequests: 12,
        periodTokens: 129600,
        periodUsd: "1.05",
      };
    }
  }
  await route.fulfill({ json: result });
});
try {
  await page.goto(base + "#overview");
  await page.reload();
  const apiRow = page
    .locator(".overview-quotas .account-row")
    .filter({ hasText: apiAccount.name });
  await expect(apiRow).toContainText("时段 Tokens");
  await expect(apiRow).toContainText("8.4K");
  const subscriptionRow = page
    .locator(".overview-quotas .account-row")
    .filter({ hasText: subscriptionAccount.name });
  await expect(
    subscriptionRow.locator(
      '.quota-window[data-window="fiveHour"] .quota-window-reset',
    ),
  ).toBeVisible();
  await expect(
    subscriptionRow.locator(".quota-window-volume").first(),
  ).toHaveText("129.6K Tokens · 12 次");

  withLifetime = true;
  await page.reload();
  await expect(apiRow).toContainText("累计 Tokens");
  await expect(apiRow).toContainText("50M");

  for (const width of [1440, 1200, 1050, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    if (width > 900) {
      // 额度窗口标题行（名称·用量与重置时间）在桌面各宽度保持一行。
      const heights = await subscriptionRow
        .locator(".quota-window-head")
        .evaluateAll((items) =>
          items.map((item) => item.getBoundingClientRect().height),
        );
      expect(Math.max(...heights)).toBeLessThan(30);
    }
    await page.screenshot({
      path: `test-results/overview-account-usage-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await apiRow.click();
  await expect(page).toHaveURL(/#ledger$/);
  await expect(page.getByRole("combobox", { name: "账户筛选" })).toContainText(
    apiAccount.name,
  );
  console.log(
    JSON.stringify({ lifetimeFirst: true, periodFallback: true, fits: true }),
  );
} finally {
  await page.unroute("**/api/view?**");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "#overview");
  await browser.close();
}
