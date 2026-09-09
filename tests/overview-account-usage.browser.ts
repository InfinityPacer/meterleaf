import { chromium, expect } from "@playwright/test";

const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local test page required");
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith(base));
if (!page) throw new Error("Existing local task page required");
const keys = ["meterleaf-report-filter-overview", "meterleaf-report-filter-reports", "meterleaf-report-filter-ledger", "meterleaf-pref-account-filter"];
const original = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), keys);
const template = await fetch(new URL("api/view?days=7", base)).then(response => response.json());
const apiAccount = template.accounts.find((account: any) => !account.fiveHour && !account.sevenDay);
const subscriptionAccount = template.accounts.find((account: any) => account.kind === "subscription");
if (!apiAccount) throw new Error("An account without quota is required");
await page.route("**/api/view?**", async route => {
  const days = new URL(route.request().url()).searchParams.get("days");
  const result = structuredClone(template);
  for (const variant of [result, ...Object.values(result.usdVariants ?? {})] as any[]) {
    variant.view.accountUsage = { [apiAccount.id]: { count: days === "1" ? 12 : 84, tokens: days === "1" ? 1200 : 8400, usd: days === "1" ? "1.2" : "8.4", incompleteUsd: 0 } };
    const subscription = variant.accounts.find((account: any) => account.kind === "subscription");
    if (subscription) {
      for (const [key, hours] of [["fiveHour", 2], ["sevenDay", 144]] as const) {
        subscription[key] = { ...subscription[key], percent: 7, state: "active", resetsAt: new Date(Date.now() + hours * 3600000).toISOString(), periodRequests: 12, periodTokens: 129600, periodUsd: "1.05" };
      }
    }
  }
  await route.fulfill({ json: result });
});
try {
  await page.evaluate(keys => keys.forEach(key => localStorage.removeItem(key)), keys);
  await page.goto(base + "#overview");
  await page.reload();
  const card = page.getByRole("button", { name: `查看 ${apiAccount.name} 请求用量`, exact: true });
  await expect(card).toContainText("时间段用量");
  await expect(page.getByText("已计价费用", { exact: true })).toHaveCount(0);
  expect(await page.locator(".lifetime-summary").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("0px");
  expect(await page.locator(".lifetime-summary").evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector(".overview-quotas")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByRole("radio", { name: "近 24 小时", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(card).toContainText("1.2K");
  await expect(card).toContainText("$1.20");
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByRole("radio", { name: "近 7 天", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(card).toContainText("8.4K");
  await expect(page.locator('.quota-preview [aria-label="5 小时重置时间"]').first()).toBeVisible();
  await expect(page.getByRole("button", { name: `查看 ${subscriptionAccount.name} 账户额度`, exact: true }).locator(".quota-period-volume").first()).toHaveText("129.6K Tokens·12 次");
  await expect(page.locator(".quota-preview .quota-period-requests")).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.screenshot({ path: `test-results/overview-period-account-${width}.png`, fullPage: true });
  }
  await card.click();
  await expect(page).toHaveURL(/#ledger$/);
  await expect(page.getByRole("combobox", { name: "账户筛选" })).toContainText(apiAccount.name);
  await page.goto(base + "#reports");
  await expect(page.getByRole("combobox", { name: "账户筛选" })).toContainText("全部账户");
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByRole("radio", { name: "近 24 小时", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.goto(base + "#overview");
  await expect(page.getByRole("button", { name: "日期范围", exact: true })).toContainText("近 7 天");
  await expect(page.getByRole("combobox", { name: "账户筛选" })).toContainText("全部账户");
  await page.goto(base + "#accounts");
  await expect(page.getByRole("combobox", { name: "账户筛选" })).toContainText("全部账户");
  await expect(page.locator(".account-row")).toHaveCount(template.accounts.length);
  await expect(page.locator(".account-requests-link")).toHaveCount(0);
  await expect(page.locator(".account-row").filter({ hasText: subscriptionAccount.name }).locator(".quota-period-volume").first()).toHaveText("129.6K Tokens·12 次");
  await expect(page.locator(".account-row .quota-period-requests")).toHaveCount(0);
  const row = page.locator(".account-row").filter({ hasText: apiAccount.name });
  await expect(row).toContainText("累计 Tokens");
  await expect(page.getByText("等待新快照", { exact: true })).toHaveCount(0);
  for (const width of [1440, 1200, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440) {
      const positions = await page.evaluate(() => {
        const headings = [...document.querySelectorAll(".account-list-heading > span")].map(el => el.getBoundingClientRect());
        const values = [...document.querySelectorAll(".account-lifetime > span")].map(el => el.getBoundingClientRect());
        return [Math.abs(headings[1]!.left - values[0]!.left), Math.abs(headings[2]!.left - values[1]!.left), Math.abs(headings[3]!.right - values[2]!.right)];
      });
      expect(positions.every(delta => delta < 2)).toBe(true);
    }
    await page.screenshot({ path: `test-results/account-period-layout-${width}.png`, fullPage: true });
  }
  console.log(JSON.stringify({ lifetimeFirst: true, periodUsageChanges: true, accountPageRemainsLifetime: true, requestLink: true, mobileFits: true }));
} finally {
  await page.unroute("**/api/view?**");
  await page.evaluate(values => { for (const [key, value] of Object.entries(values)) value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); }, original);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "#overview");
  await browser.close();
}
