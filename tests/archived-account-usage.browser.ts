import { chromium, expect } from "@playwright/test";

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
const account = template.accounts.find(
  (item: any) => item.kind === "subscription",
);
if (!account) throw new Error("Subscription fixture required");
let archived = true;
let expired = false;
let usage: "lifetime" | "period" | "missing" = "lifetime";
const total = {
  count: 5000,
  tokens: 50_000_000,
  usd: "500",
  incompleteTokens: 0,
  incompleteUsd: 0,
};
const originalStorage = await page.evaluate(() => ({ ...localStorage }));
try {
  await page.route("**/api/accounts/archive", (route) =>
    route.fulfill({
      json: {
        archived: archived ? [account.id] : [],
        hidden: [],
        aliases: {},
        writable: true,
      },
    }),
  );
  await page.route("**/api/view?**", (route) => {
    const result = structuredClone(template);
    for (const variant of [
      result,
      ...Object.values(result.usdVariants ?? {}),
    ] as any[]) {
      const target = variant.accounts.find(
        (item: any) => item.id === account.id,
      );
      if (usage === "lifetime") target.lifetime = total;
      else delete target.lifetime;
      variant.view.accountUsage =
        usage === "period"
          ? { [account.id]: { ...total, tokens: 8400, count: 84, usd: "8.4" } }
          : {};
      for (const key of ["fiveHour", "sevenDay"]) {
        target[key] = {
          ...target[key],
          state: expired ? "stale" : "active",
          percent: 7,
          resetsAt: new Date(
            Date.now() + (expired ? -1 : 2) * 3600000,
          ).toISOString(),
        };
      }
    }
    return route.fulfill({ json: result });
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const row = page.locator(`[data-account-id="${account.id}"]`);
    for (expired of [false, true]) {
      archived = true;
      usage = "lifetime";
      await page.goto(base + "#overview");
      await page.reload();
      await page.getByRole("button", { name: "已归档 1", exact: true }).click();
      await expect(row).toContainText(width > 900 ? "累计 Tokens" : "累计用量");
      await expect(row).toContainText("50.00M");
      await expect(row).toContainText("5,000");
      await expect(row).toContainText("$500");
      await expect(
        row.locator(
          ".quota-window, .account-window-unavailable, .mobile-home-quota-unavailable",
        ),
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await row
      .locator(width > 900 ? ".account-row" : ".mobile-home-account-card")
      .click();
    await expect(page).toHaveURL(/#ledger$/);
    for (usage of ["period", "missing"] as const) {
      await page.goto(base + "#overview");
      await page.reload();
      await page.getByRole("button", { name: "已归档 1", exact: true }).click();
      await expect(row).toContainText(
        usage === "missing"
          ? "暂无用量数据"
          : width > 900
            ? "时段 Tokens"
            : "当前区间用量",
      );
      if (usage === "period") await expect(row).toContainText("8.40K");
    }
    archived = false;
    expired = false;
    usage = "lifetime";
    await page.reload();
    await expect(
      row.locator('.quota-window[data-window="fiveHour"]'),
    ).toBeVisible();
    await expect(row).not.toContainText("累计 Tokens");
    await expect(row).not.toContainText("累计用量");
  }
  console.log(
    JSON.stringify({
      archivedLifetime: true,
      expiredQuota: true,
      periodFallback: true,
      missingUsage: true,
      restoredQuota: true,
      requestNavigation: true,
      desktopAndMobile: true,
      reducedMotion: true,
    }),
  );
} finally {
  await page.unroute("**/api/view?**");
  await page.unroute("**/api/accounts/archive");
  await page.emulateMedia({ reducedMotion: null });
  await page.evaluate((original) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(original))
      localStorage.setItem(key, value);
  }, originalStorage);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "#overview");
  await page.reload();
  await browser.close();
}
