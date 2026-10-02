import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LedgerStore } from "../src/storage/ledger";
import { defaultPriceBook } from "../src/domain/default-prices";
import { createApp } from "../src/server/app";
import { liveSnapshot } from "../src/server/snapshot";

// 独立示例账本，不连接采集器和任何已有服务。
const dir = mkdtempSync(join(tmpdir(), "meterleaf-merge-browser-"));
const store = new LedgerStore(join(dir, "ledger.sqlite"), defaultPriceBook);
const now = new Date().toISOString();
for (const [sourceId, name, percent] of [
  ["sample-local", "本地订阅（示例）", 75],
  ["sample-gateway", "网关账号（示例）", 20],
] as const) {
  store.saveAccounts([
    {
      sourceId,
      externalId: "a",
      name,
      platform: "openai",
      kind: "subscription",
      plan: "pro",
      parentExternalId: null,
      subjectKey: null,
    },
  ]);
  store.saveQuotas(
    [
      {
        sourceId,
        externalId: "quota",
        accountExternalId: "a",
        window: "seven-day",
        percent,
        sampledAt: now,
        resetsAt: new Date(Date.now() + 86400000).toISOString(),
        windowMinutes: 10080,
      },
    ],
    now,
  );
}
store.saveAccounts(
  Array.from({ length: 16 }, (_, index) => ({
    sourceId: "sample-extra",
    externalId: String(index),
    name: `候选账号 ${index + 1}`,
    platform: "openai",
    kind: "api" as const,
    plan: null,
    parentExternalId: null,
    subjectKey: null,
  })),
);
const app = createApp({
  webRoot: resolve("dist/web"),
  snapshot: (days, basis, dateRange) =>
    liveSnapshot(store, null, days, new Date().toISOString(), basis, dateRange),
  accountMerge: {
    read: () => store.accountMergeState(),
    write: (id, target) => store.setAccountMerge(id, target),
  },
  accountArchive: {
    read: () => store.archivedAccounts(),
    write: (id, value) => store.setAccountArchived(id, value),
    hidden: () => store.hiddenAccounts(),
    hide: (id) => store.hideAccount(id),
    aliases: () => store.accountAliases(),
    setAlias: (id, value) => store.setAccountAlias(id, value),
  },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch({ headless: true });
  mkdirSync("test-results/account-merge", { recursive: true });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    const context = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
      colorScheme: viewport.width === 1440 ? "light" : "dark",
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await page
        .getByRole("button", { name: "本地订阅（示例） 账户操作", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "合并额度与用量" }).click();
      const dialog = page.getByRole("dialog", { name: "合并额度与用量" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "确认合并" }),
      ).toBeDisabled();
      const initialScroll = await dialog.evaluate(
        (element) => element.scrollTop,
      );
      await dialog.getByRole("combobox", { name: "目标账户" }).click();
      const list = page.getByRole("listbox");
      const listBox = await list.boundingBox();
      expect(listBox!.y).toBeGreaterThanOrEqual(0);
      expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(viewport.height);
      expect(
        await list.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      ).toBe(true);
      await page
        .getByRole("option", {
          name: "候选账号 16 · sample-extra",
          exact: true,
        })
        .click();
      expect(await dialog.evaluate((element) => element.scrollTop)).toBe(
        initialScroll,
      );
      await dialog.getByRole("combobox", { name: "目标账户" }).click();
      await page.screenshot({
        path: `test-results/account-merge/${viewport.width}-dropdown.png`,
      });
      await page
        .getByRole("option", { name: "网关账号（示例） · sample-gateway" })
        .click();
      await dialog.screenshot({
        path: `test-results/account-merge/${viewport.width}-merge.png`,
      });
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await page.route("**/api/accounts/merge", (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({
              status: 400,
              json: { error: "请选择尚未合并的目标账户" },
            })
          : route.continue(),
      );
      await dialog
        .getByRole("button", { name: "确认合并", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toHaveText(
        "请选择尚未合并的目标账户",
      );
      expect(store.accountMerges()).toEqual({});
      await page.unroute("**/api/accounts/merge");
      await dialog
        .getByRole("button", { name: "确认合并", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "本地订阅（示例） 账户操作",
          exact: true,
        }),
      ).toHaveCount(0);
      expect(store.accountMerges()).toEqual({
        "sample-local:a": "sample-gateway:a",
      });
      await page
        .getByRole("button", { name: "网关账号（示例） 账户操作", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "合并额度与用量" }).click();
      await expect(
        dialog.getByRole("heading", { name: "已合并到此账户" }),
      ).toBeVisible();
      await dialog.screenshot({
        path: `test-results/account-merge/${viewport.width}-undo.png`,
      });
      await dialog
        .getByRole("button", {
          name: "解除 本地订阅（示例） · sample-local 的合并",
        })
        .click();
      await expect(
        page.getByRole("button", {
          name: "本地订阅（示例） 账户操作",
          exact: true,
        }),
      ).toBeVisible();
      expect(store.accountMerges()).toEqual({});
      expect(errors).toEqual([]);
      console.log(
        `account merge UI passed: ${viewport.width}px, reduced motion`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
