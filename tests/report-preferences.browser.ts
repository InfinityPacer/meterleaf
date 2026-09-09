import { chromium, expect } from "@playwright/test";

const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith(base));
if (!page) throw new Error("Existing task page required");
const keys = [
  "meterleaf-report-filter",
  "meterleaf-usd-basis",
  ...[
    "page",
    "unit",
    "granularity",
    "chart",
    "report-dimension",
    "record-sort",
    "report-sort",
    "distribution-unit",
  ].map((key) => `meterleaf-pref-${key}`),
];
const before = await page.evaluate(
  (keys) => keys.map((key) => localStorage.getItem(key)),
  keys,
);
try {
  await page.evaluate(() => localStorage.removeItem("meterleaf-report-filter"));
  await page.goto(base + "#reports");
  await page.reload();
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-08-20");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-08-27");
  await page.getByRole("button", { name: "关闭日期选择" }).click();
  for (const label of ["模型筛选", "账户筛选"]) {
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await page.getByRole("combobox", { name: label }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("listbox").getByRole("option").nth(1).click();
    await expect
      .poll(() =>
        page.evaluate(
          (label) =>
            JSON.parse(localStorage.getItem("meterleaf-report-filter")!)[
              label === "模型筛选" ? "model" : "account"
            ],
          label,
        ),
      )
      .not.toBe("all");
  }
  await page.getByRole("button", { name: "标准 API", exact: true }).click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("meterleaf-report-filter")!),
  );
  expect(saved.dateRange).toEqual({ from: "2026-08-20", to: "2026-08-27" });
  expect(saved.model).not.toBe("all");
  expect(saved.account).not.toBe("all");
  for (const tab of ["overview", "accounts", "reports", "ledger"]) {
    const request = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/view",
    );
    await page.goto(base + "#" + tab);
    await page.reload();
    const params = new URL((await request).url()).searchParams;
    expect(params.get("from")).toBe(saved.dateRange.from);
    expect(params.get("to")).toBe(saved.dateRange.to);
    expect(params.get("model")).toBe(saved.model);
    expect(params.get("account")).toBe(saved.account);
    await expect(
      page.getByRole("button", { name: "标准 API", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await page
    .getByRole("textbox", { name: "搜索请求", exact: true })
    .fill("not-persisted-search");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "搜索请求", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.reload();
  const reset = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("meterleaf-report-filter")!),
  );
  expect(reset).toEqual({ days: 7, model: "all", account: "all" });
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("第 2 /");
  await page.reload();
  await expect(page.locator(".pagination")).toContainText("第 1 /");
  await page.goto(base + "#overview");
  await page.getByRole("button", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "折线图", exact: true }).click();
  await page
    .getByRole("group", { name: "时间粒度", exact: true })
    .getByRole("button", { name: "周", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Tokens", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "折线图", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("group", { name: "时间粒度", exact: true })
      .getByRole("button", { name: "周", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.goto(base + "#reports");
  await page
    .getByRole("group", { name: "汇总维度" })
    .getByRole("button", { name: "账户", exact: true })
    .click();
  await page
    .getByRole("group", { name: "模型分布指标" })
    .getByRole("button", { name: "按 Tokens", exact: true })
    .click();
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: "汇总维度" })
      .getByRole("button", { name: "账户", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("group", { name: "模型分布指标" })
      .getByRole("button", { name: "按 Tokens", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.goto(base);
  await expect(page.locator(".topbar h1")).toHaveText("统计报表");
  console.log(
    JSON.stringify({
      tabs: 4,
      dates: true,
      model: true,
      account: true,
      usdBasis: true,
      chart: true,
      unit: true,
      granularity: true,
      dimension: true,
      distribution: true,
      lastTab: true,
      paginationNotSaved: true,
      searchNotSaved: true,
      reset: true,
    }),
  );
} finally {
  await page.evaluate(
    ({ keys, before }) =>
      keys.forEach((key, i) =>
        before[i] === null
          ? localStorage.removeItem(key)
          : localStorage.setItem(key, before[i]!),
      ),
    { keys, before },
  );
  await page.reload();
  await browser.close();
}
