import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const base =
  process.env.METERLEAF_TEST_URL ?? "http://localhost:4330/?appearance-sort";
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(base));
if (!page) throw new Error("Open a managed task tab first");
const saved = {
  url: page.url(),
  viewport: page.viewportSize(),
  storage: await page.evaluate(() => ({ ...localStorage })),
};
const mainScript = "**/src/web/main.tsx**";
const cdp = await page.context().newCDPSession(page);
await mkdir("test-results/appearance-sorting", { recursive: true });
try {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => {
    localStorage.setItem("meterleaf-theme", "system");
    localStorage.setItem("meterleaf-pref-mobile-layout", JSON.stringify("app"));
  });
  await page.route(mainScript, (route) => route.abort());
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(23, 27, 32)",
  );
  await page.unroute(mainScript);
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  for (const width of [320, 390, 844]) {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
    await page.goto(`${base}#reports`);
    const headers = page.locator(".mobile-report-columns button");
    await expect(headers).toHaveCount(4);
    for (const header of await headers.all()) {
      await header.click();
      const first = await header.getAttribute("data-sort-direction");
      await header.click();
      const second = await header.getAttribute("data-sort-direction");
      expect(first).not.toBe(second);
    }
    const requests = page
      .locator(".mobile-report-columns")
      .getByRole("button", { name: /按请求数排序/ });
    for (const direction of ["desc", "asc"]) {
      for (
        let i = 0;
        i < 3 &&
        (await requests.getAttribute("data-sort-direction")) !== direction;
        i++
      )
        await requests.click();
      await expect(requests).toHaveAttribute("data-sort-direction", direction);
      const counts = await page
        .locator(".mobile-report-item summary > span:nth-child(2)")
        .allTextContents();
      const values = counts.map((text) => Number(text.replace(/[^\d]/g, "")));
      expect(values).toEqual(
        [...values].sort((a, b) => (direction === "desc" ? b - a : a - b)),
      );
    }
    const order = await page
      .locator(".mobile-report-item summary")
      .allTextContents();
    await page.reload();
    await expect(requests).toHaveAttribute("data-sort-direction", "asc");
    expect(
      await page.locator(".mobile-report-item summary").allTextContents(),
    ).toEqual(order);
    await page
      .getByRole("button", { name: "模型排名排序", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "USD 估值", exact: true }).click();
    await page
      .getByRole("button", { name: "模型排名排序", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "切换为升序", exact: true })
      .click();
    const dollars = (
      await page
        .locator(".mobile-model-list .distribution-usd")
        .allTextContents()
    ).map((text) => Number(text.replace(/[^\d.]/g, "")));
    expect(dollars).toEqual([...dollars].sort((a, b) => a - b));
    await page.evaluate(() => window.scrollTo(0, 0));
    const nav = page.getByRole("navigation", { name: "底部导航" });
    await expect(nav).toHaveCSS("height", "56px");
    const bottomGap = await nav.evaluate(
      (element) =>
        element.getBoundingClientRect().bottom -
        element.querySelector("button span")!.getBoundingClientRect().bottom,
    );
    expect(bottomGap).toBeLessThanOrEqual(9);
    await expect(nav).toHaveCSS("border-radius", "0px");
    await expect(nav).toHaveCSS("border-left-width", "0px");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/appearance-sorting/reports-${width}.png`,
    });
    await page.goto(`${base}#settings`);
    await expect(
      page.getByRole("group", { name: "页面布局", exact: true }),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [bottom, bottomMax] of [
    [0, 0],
    [34, 34],
    [0, 34],
  ]) {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { bottom, bottomMax },
    });
    const nav = page.getByRole("navigation", { name: "底部导航" });
    await expect
      .poll(() =>
        nav.evaluate(
          (element) => innerHeight - element.getBoundingClientRect().top,
        ),
      )
      .toBe(56 + bottom!);
    const clearance = await nav.evaluate(
      (element) =>
        innerHeight -
        element.querySelector("button span")!.getBoundingClientRect().bottom,
    );
    expect(clearance - bottom!).toBeGreaterThanOrEqual(7);
    expect(clearance - bottom!).toBeLessThanOrEqual(9);
  }
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}#accounts`);
  const labels = await page
    .locator(".filterbar")
    .evaluate((element) =>
      [...element.querySelectorAll('[role="combobox"], [role="group"]')].map(
        (control) => control.getAttribute("aria-label"),
      ),
    );
  expect(labels).toEqual(["账户筛选", "归档状态", "USD 估算口径"]);
  await page.goto(`${base}#reports`);
  await expect(
    page.locator(".model-distribution-scroll thead button"),
  ).toHaveCount(5);
  for (const button of await page
    .locator(".model-distribution-scroll thead button")
    .all()) {
    await button.click();
    await expect(button.locator("..")).not.toHaveAttribute("aria-sort", "none");
  }
  await page.screenshot({
    path: "test-results/appearance-sorting/desktop.png",
  });
  for (const width of [320, 390, 901, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const layout of ["app", "sidebar"]) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          ({ layout, theme }) => {
            localStorage.setItem(
              "meterleaf-pref-mobile-layout",
              JSON.stringify(layout),
            );
            localStorage.setItem("meterleaf-theme", theme);
          },
          { layout, theme },
        );
        await page.goto(`${base}#reports`);
        await page.reload();
        await expect(page.locator(".model-donut canvas")).toBeVisible();
        for (const [view, trigger] of [
          ["reports", "模型排名排序"],
          ["reports", "汇总选项"],
          ["ledger", "请求排序"],
        ]) {
          if (view === "ledger") await page.goto(`${base}#ledger`);
          const button = page.getByRole("button", {
            name: trigger,
            exact: true,
          });
          if (trigger !== "模型排名排序" && (width > 900 || layout !== "app"))
            continue;
          await button.click();
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          await expect(menu).not.toHaveCSS(
            "background-color",
            "rgba(0, 0, 0, 0)",
          );
          await expect(menu).toHaveCSS("border-radius", "8px");
          await expect(menu.getByRole("menuitem").first()).toHaveCSS(
            "display",
            "flex",
          );
          const geometry = await menu.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const rows = [...element.querySelectorAll('[role="menuitem"]')].map(
              (row) => row.getBoundingClientRect(),
            );
            return {
              inViewport:
                box.left >= 0 &&
                box.right <= innerWidth &&
                box.top >= 0 &&
                box.bottom <= innerHeight,
              width: box.width,
              rowsDoNotOverlap: rows.every(
                (row, index) => !index || row.top >= rows[index - 1]!.bottom,
              ),
              onTop: element.contains(
                document.elementFromPoint(
                  box.left + box.width / 2,
                  box.top + 20,
                ),
              ),
            };
          });
          expect(geometry).toMatchObject({
            inViewport: true,
            width: 240,
            rowsDoNotOverlap: true,
            onTop: true,
          });
          await page.screenshot({
            path: `test-results/appearance-sorting/menu-${width}-${layout}-${theme}-${view}-${trigger}.png`,
          });
          await page.keyboard.press("Escape");
          await expect(menu).toBeHidden();
          await expect(button).toBeFocused();
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      status: "passed",
      checks:
        "pre-React dark theme, system change, mobile sorting and persistence, model ranking, 56px square tabbar, layout label, account filter order",
    }),
  );
} finally {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
  await cdp.detach();
  await page.unroute(mainScript);
  await page.evaluate((storage) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage))
      localStorage.setItem(key, value);
  }, saved.storage);
  await page.emulateMedia({ colorScheme: null });
  if (saved.viewport) await page.setViewportSize(saved.viewport);
  await page.goto(saved.url);
  await browser.close();
}
