import { chromium, expect, type Request } from "@playwright/test";

const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith(base));
if (!page) throw new Error("Existing task page required");

// 每个页面的筛选分别保存在 meterleaf-report-filter-<视图>，总览使用 home 视图；计价口径全局共享。
const filterKey = (scope: "home" | "reports" | "ledger") =>
  `meterleaf-report-filter-${scope}`;
const readJson = (key: string) =>
  page.evaluate((key) => {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  }, key);
const before = await page.evaluate(() =>
  Object.fromEntries(
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith("meterleaf-"),
    ),
  ),
);
const beforeViewport = page.viewportSize();
// 主列表请求带分页大小 12；pageSize=1 是摘要与趋势查询。
const isMainView = (request: Request) => {
  const url = new URL(request.url());
  return (
    url.pathname === "/api/view" && url.searchParams.get("pageSize") !== "1"
  );
};
async function reloadAndCaptureView(hash: string) {
  const request = page!.waitForRequest(isMainView);
  await page!.goto(base + "#" + hash);
  await page!.reload();
  return new URL((await request).url()).searchParams;
}

try {
  // 该套检查覆盖 Web 布局下的筛选栏与分组按钮。
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("meterleaf-")) localStorage.removeItem(key);
  });
  await page.goto(base + "#reports");
  await page.reload();
  await page.getByRole("button", { name: "日期范围", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-08-20");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-08-27");
  await page.getByRole("button", { name: "关闭日期选择" }).click();
  for (const label of ["模型筛选", "账户筛选"]) {
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("listbox").getByRole("option").nth(1).click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect
      .poll(async () => {
        const saved = await readJson(filterKey("reports"));
        return saved?.[label === "模型筛选" ? "model" : "account"] ?? "all";
      })
      .not.toBe("all");
  }
  await page.getByRole("button", { name: "标准 API", exact: true }).click();
  const saved = await readJson(filterKey("reports"));
  expect(saved.dateRange).toEqual({ from: "2026-08-20", to: "2026-08-27" });
  expect(saved.model).not.toBe("all");
  expect(saved.account).not.toBe("all");
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("meterleaf-usd-basis")),
    )
    .toBe("api");

  // 统计报表重新载入后按保存的范围、模型和账户查询。
  const reportParams = await reloadAndCaptureView("reports");
  expect(reportParams.get("from")).toBe(saved.dateRange.from);
  expect(reportParams.get("to")).toBe(saved.dateRange.to);
  expect(reportParams.get("model")).toBe(saved.model);
  expect(reportParams.get("account")).toBe(saved.account);
  await expect(
    page.getByRole("button", { name: "标准 API", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  // 请求明细与总览不继承统计报表的筛选，只共享计价口径。
  const ledgerParams = await reloadAndCaptureView("ledger");
  expect(ledgerParams.get("from")).toBeNull();
  expect(ledgerParams.get("days")).toBe("7");
  expect(ledgerParams.get("model")).toBe("all");
  expect(ledgerParams.get("account")).toBe("all");
  await expect(
    page.getByRole("button", { name: "标准 API", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.goto(base + "#overview");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "日期范围", exact: true }),
  ).toContainText("历史至今");
  await expect(
    page.getByRole("button", { name: "标准 API", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await readJson(filterKey("home"))).toBeNull();

  // 请求明细自己的筛选同样持久化；搜索词与页码不保存；清除只重置当前页面。
  await page.goto(base + "#ledger");
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("combobox", { name: "模型筛选", exact: true }).click();
  await page.getByRole("listbox").getByRole("option").nth(1).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect
    .poll(async () => (await readJson(filterKey("ledger")))?.model ?? "all")
    .not.toBe("all");
  const ledgerModel = (await readJson(filterKey("ledger"))).model;
  const ledgerReloaded = await reloadAndCaptureView("ledger");
  expect(ledgerReloaded.get("model")).toBe(ledgerModel);
  await page
    .getByRole("textbox", { name: "搜索请求", exact: true })
    .fill("not-persisted-search");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "搜索请求", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.reload();
  expect(await readJson(filterKey("ledger"))).toEqual({
    days: 7,
    model: "all",
    account: "all",
  });
  expect(await readJson(filterKey("reports"))).toEqual(saved);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("第 2 /");
  await page.reload();
  await expect(page.locator(".pagination")).toContainText("第 1 /");

  // 总览的图表单位默认 Tokens，改为 USD 后与图表样式、粒度一起按总览保存。
  await page.goto(base + "#overview");
  await expect(
    page.getByRole("button", { name: "Tokens", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "USD", exact: true }).click();
  await page.getByRole("button", { name: "折线图", exact: true }).click();
  await page
    .getByRole("group", { name: "时间粒度", exact: true })
    .getByRole("button", { name: "周", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "USD", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "折线图", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("group", { name: "时间粒度", exact: true })
      .getByRole("button", { name: "周", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await readJson("meterleaf-pref-home-unit")).toBe("usd");
  expect(await readJson("meterleaf-pref-home-chart")).toBe("line");
  expect(await readJson("meterleaf-pref-home-granularity")).toBe("week");
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
      tabs: 3,
      dates: true,
      model: true,
      account: true,
      perViewFilters: true,
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
  await page.evaluate((before) => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("meterleaf-")) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(before))
      localStorage.setItem(key, value);
  }, before);
  if (beforeViewport) await page.setViewportSize(beforeViewport);
  await page.reload();
  await browser.close();
}
