import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

/** 详情抽屉在两种布局下共用同一份字段列表，长 ID 不能把标签列挤成竖排。 */
const base =
  process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4333/?request-detail";
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(base));
if (!page) throw new Error("Open a dedicated managed request-detail tab first");
const saved = {
  url: page.url(),
  viewport: page.viewportSize(),
  storage: await page.evaluate(() => ({ ...localStorage })),
};
await mkdir("test-results/request-detail-layout", { recursive: true });

try {
  for (const [layout, width, selector] of [
    ["app", 320, ".mobile-request-item"],
    ["app", 393, ".mobile-request-item"],
    ["sidebar", 441, ".request-table-scroll [data-request-id]"],
    ["sidebar", 1440, ".request-table-scroll [data-request-id]"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      ({ layout }) => {
        localStorage.setItem("meterleaf-theme", "dark");
        localStorage.setItem(
          "meterleaf-pref-mobile-layout",
          JSON.stringify(layout),
        );
      },
      { layout },
    );
    await page.goto(`${base}#ledger`);
    await page.reload();
    const open = page.locator(selector).first();
    await expect(open).toBeVisible();
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // 拉长源记录 ID 只验证 CSS 边界；真实 ID 长度由采集器决定。
    const geometry = await dialog.evaluate((element) => {
      const labels = [...element.querySelectorAll(".details-list dt")];
      const source = labels.find((label) => label.textContent === "源记录 ID");
      (source?.nextElementSibling ??
        labels.at(-1)!.nextElementSibling)!.textContent =
        "req_011CgQvLrjaJSFU7ciNjQz1b:msg_011CgQvLthe25YtypnzXkiBw";
      return {
        labelsHorizontal: labels.every((label) => {
          const range = document.createRange();
          range.selectNodeContents(label);
          return (
            label.getBoundingClientRect().width >= 30 &&
            range.getClientRects().length === 1
          );
        }),
        sheetFits: element.scrollWidth <= element.clientWidth,
        pageFits: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    expect(geometry).toEqual({
      labelsHorizontal: true,
      sheetFits: true,
      pageFits: true,
    });
    await page.screenshot({
      path: `test-results/request-detail-layout/${width}-${layout}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  console.log(
    JSON.stringify({
      status: "passed",
      states: 4,
      checks: "detail labels horizontal and no overflow in both layouts",
    }),
  );
} finally {
  await page.evaluate((storage) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage))
      localStorage.setItem(key, value);
  }, saved.storage);
  if (saved.viewport) await page.setViewportSize(saved.viewport);
  await page.goto(saved.url);
  await browser.close();
}
