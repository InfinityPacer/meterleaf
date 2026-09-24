import { chromium, expect } from "@playwright/test";

const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
const baseUrl = new URL(base);
const localHost = baseUrl.hostname.replace(/^\[|\]$/g, "");
if (!(new Set(["127.0.0.1", "localhost", "::1"]).has(localHost))) {
  throw new Error(`Refusing non-local test URL: ${base}`);
}
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
  try {
    return new URL(candidate.url()).origin === baseUrl.origin;
  } catch {
    return false;
  }
});
if (!page) throw new Error("Task page required");
const state = { archived: [] as string[], hidden: [] as string[], writable: true };
const storageKeys = [
  "meterleaf-pref-account-order",
  "meterleaf-pref-account-archive-view",
  "meterleaf-report-filter",
  "meterleaf-theme",
  "meterleaf-palette",
];

function contrastRatio(foreground: string, background: string) {
  const parse = (value: string) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) throw new Error(`Unsupported color: ${value}`);
    const channels = match[1]!.split(",").map((channel) => Number(channel.trim()));
    return channels.slice(0, 3).map((channel) => channel / 255);
  };
  const luminance = (value: string) => {
    const [r, g, b] = parse(value);
    const linear = (channel: number) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

async function operateFirst(action: string) {
  await page!.locator(".account-list-item").first().getByRole("button", { name: /账户操作$/ }).click();
  await page!.getByRole("menuitem", { name: action, exact: true }).click();
}
let failWrite = false;
const original = await page.evaluate((keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), storageKeys);
await page.route("**/api/accounts/archive", async route => {
  if (route.request().method() === "PUT") {
    if (failWrite) return route.fulfill({ status: 500, json: { error: "test" } });
    const data = route.request().postDataJSON();
    if (data.hidden) state.hidden.push(data.id);
    else state.archived = data.archived ? [...new Set([...state.archived, data.id])] : state.archived.filter(id => id !== data.id);
  }
  await route.fulfill({ json: state });
});
try {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { localStorage.removeItem("meterleaf-pref-account-order"); localStorage.removeItem("meterleaf-report-filter"); localStorage.removeItem("meterleaf-pref-account-archive-view"); });
  await page.goto(`${base}#accounts`); await page.reload();
  const rows = page.locator(".account-list-item");
  await expect(rows).toHaveCount(3, { timeout: 30000 });
  await expect(page.locator(".account-lifetime")).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator(".account-lifetime")).toContainText("累计 Tokens");
  for (const width of [1440, 1200, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `test-results/account-management-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const secondId = await rows.nth(1).getAttribute("data-account-id");
  await page.getByRole("button", { name: "调整账户顺序", exact: true }).click();
  await rows.nth(1).getByRole("button", { name: /^上移 / }).click();
  await expect(rows.first()).toHaveAttribute("data-account-id", secondId!);
  await page.reload();
  await expect(rows.first()).toHaveAttribute("data-account-id", secondId!);
  await operateFirst("归档账户");
  await expect(rows).toHaveCount(2);
  await page.getByRole("combobox", { name: "归档状态" }).click();
  await page.getByRole("option", { name: "已归档", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await operateFirst("恢复账户");
  await expect(rows).toHaveCount(0);
  await page.getByRole("combobox", { name: "归档状态" }).click();
  await page.getByRole("option", { name: "使用中", exact: true }).click();
  await operateFirst("归档账户");
  await page.getByRole("combobox", { name: "归档状态" }).click();
  await page.getByRole("option", { name: "已归档", exact: true }).click();
  await operateFirst("删除账户");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("历史请求和统计仍保留");
  const checkDialog = async (theme: "light" | "dark", width: number) => {
    await page.evaluate((mode) => localStorage.setItem("meterleaf-theme", mode), theme);
    await page.reload();
    await page.setViewportSize({ width, height: 900 });
    await operateFirst("删除账户");
    const currentDialog = page.getByRole("alertdialog");
    await expect(currentDialog).toBeVisible();
    const confirm = currentDialog.getByRole("button", { name: "删除", exact: true });
    const colors = await confirm.evaluate((element) => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(7);
    const geometry = await page.evaluate(() => {
      const dialogElement = document.querySelector<HTMLElement>('[role="alertdialog"]');
      const buttons = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"] button')];
      const box = dialogElement?.getBoundingClientRect();
      return {
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        dialog: box ? { left: box.left, right: box.right, width: box.width } : null,
        buttons: buttons.map((button) => {
          const buttonBox = button.getBoundingClientRect();
          return { left: buttonBox.left, right: buttonBox.right, top: buttonBox.top, bottom: buttonBox.bottom };
        }),
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        motion: [dialogElement, document.querySelector<HTMLElement>(".account-confirm-backdrop")].map((element) => {
          const style = element ? getComputedStyle(element) : null;
          return style ? { transitionDuration: style.transitionDuration, animationDuration: style.animationDuration } : null;
        }),
      };
    });
    expect(geometry.reducedMotion).toBe(true);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.dialog).not.toBeNull();
    expect(geometry.dialog!.left).toBeGreaterThanOrEqual(0);
    expect(geometry.dialog!.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.dialog!.width).toBeLessThanOrEqual(width);
    expect(geometry.buttons.every((button) => button.left >= 0 && button.right <= geometry.viewport)).toBe(true);
    // 极短时长保留组件结束事件语义，但不能产生可感知的动画。
    const negligible = (duration: string) => duration.split(",").every((part) => {
      const milliseconds = Number.parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000);
      return milliseconds <= 0.02;
    });
    expect(geometry.motion.every((value) => value === null || (negligible(value.transitionDuration) && negligible(value.animationDuration)))).toBe(true);
    await page.screenshot({ path: `test-results/account-management-dialog-${theme}-${width}.png`, fullPage: true });
    await currentDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(currentDialog).toHaveCount(0);
  };
  await checkDialog("light", 1440);
  await checkDialog("dark", 320);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => localStorage.setItem("meterleaf-theme", "light"));
  await page.reload();
  await operateFirst("删除账户");
  const finalDialog = page.getByRole("alertdialog");
  failWrite = true;
  await finalDialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(finalDialog.getByRole("alert")).toBeVisible();
  await expect(rows).toHaveCount(1);
  failWrite = false;
  await finalDialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(finalDialog).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await page.reload();
  await expect(rows).toHaveCount(0);
  await page.goto(`${base}#overview`);
  await expect(page.locator(".overview-quotas .account-row")).toHaveCount(2);
  console.log(JSON.stringify({ cumulativeUsage: true, orderPersists: true, archiveRestore: true, deleteArchived: true, errorRetainsAccount: true, hiddenAfterReload: true, dialogContrast: true, narrowDialog: true, reducedMotion: true }));
} finally {
  await page.unroute("**/api/accounts/archive");
  await page.emulateMedia({ reducedMotion: null });
  await page.evaluate((values) => { for (const [key, value] of Object.entries(values)) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } }, original);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}#accounts`); await page.reload();
  await browser.close();
}
