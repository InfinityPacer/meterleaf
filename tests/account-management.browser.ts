import { chromium, expect } from "@playwright/test";

// 需要非演示构建：页面读取真实 /api/view，归档接口由本脚本拦截模拟。
const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4321/";
const baseUrl = new URL(base);
const localHost = baseUrl.hostname.replace(/^\[|\]$/g, "");
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(localHost)) {
  throw new Error(`Refusing non-local test URL: ${base}`);
}
const browser = await chromium.connectOverCDP(process.env.METERLEAF_CDP_URL!);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => {
    try {
      return new URL(candidate.url()).origin === baseUrl.origin;
    } catch {
      return false;
    }
  });
if (!page) throw new Error("Task page required");
const state = {
  archived: [] as string[],
  hidden: [] as string[],
  aliases: {} as Record<string, string>,
  writable: true,
};
const writes: unknown[] = [];
const storageKeys = [
  "meterleaf-pref-account-order",
  "meterleaf-pref-page",
  "meterleaf-report-filter",
  "meterleaf-theme",
  "meterleaf-palette",
];

function contrastRatio(foreground: string, background: string) {
  const parse = (value: string) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) throw new Error(`Unsupported color: ${value}`);
    const channels = match[1]!
      .split(",")
      .map((channel) => Number(channel.trim()));
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

// 总览账户区在 Web 布局是 .account-list-item，在手机 App 布局是 li；两者都带 data-manageable。
const rows = page.locator("[data-manageable]");
const quotas = page.locator("section.overview-quotas");
const heading = page.locator("#overview-quotas-title");
const archivedButton = quotas.getByRole("button", { name: /^已归档 \d+$/ });
const activeButton = quotas.getByRole("button", {
  name: "使用中账户",
  exact: true,
});
const sortButton = quotas.getByRole("button", {
  name: "调整账户顺序",
  exact: true,
});
const doneButton = quotas.getByRole("button", {
  name: "完成账户排序",
  exact: true,
});

async function operate(index: number, action: string) {
  await rows
    .nth(index)
    .getByRole("button", { name: /账户操作$/ })
    .click();
  await page!.getByRole("menuitem", { name: action, exact: true }).click();
}
const ids = () =>
  rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-account-id")),
  );
const storedOrder = () =>
  page!.evaluate(() =>
    JSON.parse(localStorage.getItem("meterleaf-pref-account-order") ?? "[]"),
  );

let failWrite = false;
let failRead = false;
const original = await page.evaluate(
  (keys) =>
    Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
  storageKeys,
);
await page.route("**/api/accounts/archive", async (route) => {
  if (route.request().method() === "PUT") {
    if (failWrite)
      return route.fulfill({ status: 500, json: { error: "test" } });
    const data = route.request().postDataJSON();
    writes.push(data);
    if (data.hidden) state.hidden.push(data.id);
    else if ("alias" in data) {
      if (data.alias) state.aliases[data.id] = data.alias;
      else delete state.aliases[data.id];
    } else
      state.archived = data.archived
        ? [...new Set([...state.archived, data.id])]
        : state.archived.filter((id) => id !== data.id);
  } else if (failRead)
    return route.fulfill({ status: 500, json: { error: "test" } });
  await route.fulfill({ json: state });
});
try {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    localStorage.removeItem("meterleaf-pref-account-order");
    localStorage.removeItem("meterleaf-pref-page");
    localStorage.removeItem("meterleaf-report-filter");
  });
  await page.goto(`${base}#overview`);
  await page.reload();
  await expect(rows).toHaveCount(4, { timeout: 30000 });
  await expect(heading).toHaveText("账户额度");
  await expect(page.locator(".account-lifetime")).toHaveCount(1, {
    timeout: 30000,
  });
  await expect(page.locator(".account-lifetime")).toContainText("累计 Tokens");
  // 没有归档账户时不出现归档入口，也不再有跳到独立账户页的链接。
  await expect(archivedButton).toHaveCount(0);
  await expect(page.getByText("全部账户")).toHaveCount(0);
  for (const width of [1440, 1200, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(rows).toHaveCount(4);
    await page.waitForTimeout(350);
    await page.screenshot({
      path: `test-results/account-management-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 排序：上移后立即生效并在重新载入后保留。
  const [first, second, third, fourth] = (await ids()) as [
    string,
    string,
    string,
    string,
  ];
  await sortButton.click();
  await expect(doneButton).toHaveAttribute("aria-pressed", "true");
  await expect(
    rows.first().getByRole("button", { name: /^上移 / }),
  ).toBeDisabled();
  await expect(
    rows.last().getByRole("button", { name: /^下移 / }),
  ).toBeDisabled();
  await rows
    .nth(1)
    .getByRole("button", { name: /^上移 / })
    .click();
  await expect.poll(ids).toEqual([second, first, third, fourth]);
  await doneButton.click();
  await expect(page.locator(".account-order-actions")).toHaveCount(0);
  await page.reload();
  await expect.poll(ids).toEqual([second, first, third, fourth]);
  await expect(page.locator(".account-order-actions")).toHaveCount(0);

  // 归档中间的账户后，已归档入口出现；排序只在使用中账户之间交换，归档账户在完整顺序中原位保留。
  await operate(1, "归档账户");
  await expect.poll(ids).toEqual([second, third, fourth]);
  await expect(archivedButton).toHaveText("已归档 1");
  await sortButton.click();
  // 排序期间隐藏归档入口，避免在两份列表之间切换时丢失排序状态。
  await expect(archivedButton).toHaveCount(0);
  await rows
    .nth(1)
    .getByRole("button", { name: /^上移 / })
    .click();
  await expect.poll(ids).toEqual([third, second, fourth]);
  await expect.poll(storedOrder).toEqual([third, first, second, fourth]);
  await doneButton.click();
  await expect(archivedButton).toHaveText("已归档 1");

  // 已归档列表：标题切换，只保留返回按钮，恢复后列表为空。
  await archivedButton.click();
  await expect(heading).toHaveText("已归档账户");
  await expect.poll(ids).toEqual([first]);
  await expect(quotas.locator(".account-heading-actions button")).toHaveCount(
    1,
  );
  await expect(activeButton).toBeVisible();
  await expect(rows.first().locator(".account-row")).toContainText("已归档");
  await operate(0, "恢复账户");
  await expect(rows).toHaveCount(0);
  await expect(quotas).toContainText("暂无归档账户");
  await activeButton.click();
  await expect(heading).toHaveText("账户额度");
  await expect.poll(ids).toEqual([third, first, second, fourth]);
  await expect(archivedButton).toHaveCount(0);

  // 重命名只写别名；清空后恢复上游原名。
  const upstreamName = (
    await rows.first().locator(".account-name-line strong").textContent()
  )?.trim();
  await operate(0, "重命名");
  const renameDialog = page.getByRole("dialog", { name: "重命名账户" });
  await expect(renameDialog).toBeVisible();
  await renameDialog.getByLabel("显示名称").fill("测试别名账户");
  await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(renameDialog).toHaveCount(0);
  await expect(rows.first()).toContainText("测试别名账户");
  await expect(
    rows.first().getByRole("button", { name: "测试别名账户 账户操作" }),
  ).toBeVisible();
  expect(writes).toContainEqual({ id: third, alias: "测试别名账户" });
  await operate(0, "重命名");
  await renameDialog
    .getByRole("button", { name: "恢复原名", exact: true })
    .click();
  await expect(renameDialog).toHaveCount(0);
  await expect(rows.first()).not.toContainText("测试别名账户");
  if (upstreamName) await expect(rows.first()).toContainText(upstreamName);
  expect(state.aliases).toEqual({});

  // 删除确认框：浅色桌面和深色 320 手机布局下都在视口内、对比度足够、无动画。
  await operate(0, "归档账户");
  await archivedButton.click();
  await operate(0, "删除账户");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("历史请求和统计仍保留");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  const checkDialog = async (theme: "light" | "dark", width: number) => {
    await page.evaluate(
      (mode) => localStorage.setItem("meterleaf-theme", mode),
      theme,
    );
    await page.reload();
    await page.setViewportSize({ width, height: 900 });
    await expect(rows.first()).toBeVisible();
    await operate(0, "删除账户");
    const currentDialog = page.getByRole("alertdialog");
    await expect(currentDialog).toBeVisible();
    const confirm = currentDialog.getByRole("button", {
      name: "删除",
      exact: true,
    });
    const colors = await confirm.evaluate((element) => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
    expect(
      contrastRatio(colors.foreground, colors.background),
    ).toBeGreaterThanOrEqual(7);
    const geometry = await page.evaluate(() => {
      const dialogElement = document.querySelector<HTMLElement>(
        '[role="alertdialog"]',
      );
      const buttons = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="alertdialog"] button',
        ),
      ];
      const box = dialogElement?.getBoundingClientRect();
      return {
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        dialog: box
          ? { left: box.left, right: box.right, width: box.width }
          : null,
        buttons: buttons.map((button) => {
          const buttonBox = button.getBoundingClientRect();
          return {
            left: buttonBox.left,
            right: buttonBox.right,
            top: buttonBox.top,
            bottom: buttonBox.bottom,
          };
        }),
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        motion: [
          dialogElement,
          document.querySelector<HTMLElement>(".account-confirm-backdrop"),
        ].map((element) => {
          const style = element ? getComputedStyle(element) : null;
          return style
            ? {
                transitionDuration: style.transitionDuration,
                animationDuration: style.animationDuration,
              }
            : null;
        }),
      };
    });
    expect(geometry.reducedMotion).toBe(true);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.dialog).not.toBeNull();
    expect(geometry.dialog!.left).toBeGreaterThanOrEqual(0);
    expect(geometry.dialog!.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.dialog!.width).toBeLessThanOrEqual(width);
    expect(
      geometry.buttons.every(
        (button) => button.left >= 0 && button.right <= geometry.viewport,
      ),
    ).toBe(true);
    // 极短时长保留组件结束事件语义，但不能产生可感知的动画。
    const negligible = (duration: string) =>
      duration.split(",").every((part) => {
        const milliseconds =
          Number.parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000);
        return milliseconds <= 0.02;
      });
    expect(
      geometry.motion.every(
        (value) =>
          value === null ||
          (negligible(value.transitionDuration) &&
            negligible(value.animationDuration)),
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/account-management-dialog-${theme}-${width}.png`,
      fullPage: true,
    });
    await currentDialog
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(currentDialog).toHaveCount(0);
  };
  await checkDialog("light", 1440);
  await checkDialog("dark", 320);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => localStorage.setItem("meterleaf-theme", "light"));
  await page.reload();

  // 已归档视图不持久化：重新载入后回到使用中列表，再从入口进入并删除归档账户。
  await expect(heading).toHaveText("账户额度");
  await expect(rows).toHaveCount(3);
  await archivedButton.click();
  await expect(rows).toHaveCount(1);
  await operate(0, "删除账户");
  const finalDialog = page.getByRole("alertdialog");
  failWrite = true;
  await finalDialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(finalDialog.getByRole("alert")).toBeVisible();
  await expect(rows).toHaveCount(1);
  failWrite = false;
  await finalDialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(finalDialog).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await expect(quotas).toContainText("暂无归档账户");
  await page.reload();
  await expect(heading).toHaveText("账户额度");
  await expect(rows).toHaveCount(3);
  await expect(archivedButton).toHaveCount(0);

  // 只读与读取失败：菜单说明原因，所有写操作禁用。
  const expectReadonlyMenu = async (note: string) => {
    await rows
      .first()
      .getByRole("button", { name: /账户操作$/ })
      .click();
    await expect(page.locator(".account-readonly-note")).toHaveText(note);
    for (const label of ["重命名", "归档账户", "删除账户"])
      await expect(
        page.getByRole("menuitem", { name: label, exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".account-readonly-note")).toHaveCount(0);
  };
  state.writable = false;
  await page.reload();
  await expect(rows).toHaveCount(3);
  await expectReadonlyMenu("只读数据，无法修改账户");
  failRead = true;
  await page.reload();
  await expect(rows).toHaveCount(4);
  await expectReadonlyMenu("账户状态读取失败");
  failRead = false;
  state.writable = true;
  console.log(
    JSON.stringify({
      cumulativeUsage: true,
      orderPersists: true,
      sortSkipsArchived: true,
      archiveRestore: true,
      archivedViewTransient: true,
      rename: true,
      deleteArchived: true,
      errorRetainsAccount: true,
      hiddenAfterReload: true,
      readonlyStates: true,
      dialogContrast: true,
      narrowDialog: true,
      reducedMotion: true,
    }),
  );
} finally {
  await page.unroute("**/api/accounts/archive");
  await page.emulateMedia({ reducedMotion: null });
  await page.evaluate((values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }, original);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}#overview`);
  await page.reload();
  await browser.close();
}
