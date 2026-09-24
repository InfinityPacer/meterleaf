import { chromium, expect } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/web/components/ui/button";

const base =
  process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4330/?button-audit";
const baseUrl = new URL(base);
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(baseUrl.hostname)) {
  throw new Error(`Refusing non-local test URL: ${base}`);
}

const endpoint = process.env.METERLEAF_CDP_URL;
if (!endpoint) throw new Error("METERLEAF_CDP_URL is required");

const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => {
    try {
      const candidateUrl = new URL(candidate.url());
      return (
        candidateUrl.origin === baseUrl.origin &&
        candidateUrl.pathname === baseUrl.pathname &&
        candidateUrl.search === baseUrl.search
      );
    } catch {
      return false;
    }
  });
if (!page)
  throw new Error("Open the local task page through the browser manager first");
const taskPage = page;
taskPage.setDefaultTimeout(10_000);

const variants = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
] as const;

const fixture = renderToStaticMarkup(
  createElement(
    "div",
    {
      "data-button-contrast-fixture": "true",
      style: {
        position: "fixed",
        left: "-10000px",
        top: 0,
        display: "grid",
        color: "rgb(1, 2, 3)",
        background: "var(--surface)",
      },
    },
    variants.flatMap((variant) => [
      createElement(
        Button,
        {
          key: `${variant}-enabled`,
          variant,
          "aria-label": `${variant} enabled`,
        },
        variant,
      ),
      createElement(
        Button,
        {
          key: `${variant}-disabled`,
          variant,
          disabled: true,
          "aria-label": `${variant} disabled`,
        },
        `${variant} disabled`,
      ),
    ]),
  ),
);

type SavedState = {
  url: string;
  viewport: { width: number; height: number } | null;
  localStorage: Record<string, string | null>;
};

const storageKeys = [
  "meterleaf-theme",
  "meterleaf-palette",
  "meterleaf-pref-mobile-layout",
  "meterleaf-report-filter",
] as const;

const saved: SavedState = {
  url: taskPage.url(),
  viewport: taskPage.viewportSize(),
  localStorage: await taskPage.evaluate((keys) => {
    return Object.fromEntries(
      keys.map((key) => [key, localStorage.getItem(key)]),
    );
  }, storageKeys),
};

function parseColor(value: string) {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`Unsupported computed color: ${value}`);
  const channels = match[1]!
    .split(",")
    .map((channel) => Number(channel.trim()));
  return channels.slice(0, 3).map((channel) => channel / 255);
}

function luminance(value: string) {
  const [red, green, blue] = parseColor(value);
  const linear = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * linear(red!) + 0.7152 * linear(green!) + 0.0722 * linear(blue!)
  );
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

async function installFixture() {
  await taskPage.evaluate((html) => {
    document.querySelector("[data-button-contrast-fixture]")?.remove();
    document.body.insertAdjacentHTML("beforeend", html);
  }, fixture);
}

async function setState(theme: "light" | "dark", layout: "app" | "sidebar") {
  await taskPage.setViewportSize({ width: 390, height: 844 });
  await taskPage.goto(`${base}#reports`);
  await taskPage.evaluate(
    ({ theme, layout }) => {
      localStorage.setItem("meterleaf-theme", theme);
      localStorage.setItem("meterleaf-palette", "green");
      localStorage.setItem(
        "meterleaf-pref-mobile-layout",
        JSON.stringify(layout),
      );
      localStorage.removeItem("meterleaf-report-filter");
    },
    { theme, layout },
  );
  await taskPage.reload();
  await expect(taskPage.locator("main")).toHaveAttribute("aria-busy", "false", {
    timeout: 30_000,
  });
  await expect
    .poll(() =>
      taskPage.evaluate(
        ({ theme }) => ({
          dark: document.documentElement.classList.contains("dark"),
          layout: document.documentElement.dataset.mobileLayout,
          theme,
        }),
        { theme },
      ),
    )
    .toEqual({ dark: theme === "dark", layout, theme });
  await installFixture();
}

async function assertFixture() {
  const controls = taskPage.locator(
    '[data-button-contrast-fixture] button[data-ui-button="true"]',
  );
  await expect(controls).toHaveCount(variants.length * 2);
  for (const variant of variants) {
    const enabled = taskPage.locator(
      `[data-button-contrast-fixture] button[data-variant="${variant}"][aria-label="${variant} enabled"]`,
    );
    const disabled = taskPage.locator(
      `[data-button-contrast-fixture] button[data-variant="${variant}"][aria-label="${variant} disabled"]`,
    );
    await expect(enabled).toHaveCount(1);
    await expect(disabled).toHaveCount(1);
    await expect(disabled).toBeDisabled();
    const colors = await enabled.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        foreground: style.color,
        background: style.backgroundColor,
      };
    });
    expect(colors.foreground).not.toBe(colors.background);
  }
}

try {
  for (const theme of ["light", "dark"] as const) {
    for (const layout of ["app", "sidebar"] as const) {
      await setState(theme, layout);
      await assertFixture();

      if (layout === "app") {
        const trigger = taskPage.getByRole("button", {
          name: "筛选与计价",
          exact: true,
        });
        await expect(trigger).toBeVisible();
        await trigger.click();
        const sheet = taskPage.locator(
          '.mobile-filter-sheet[data-slot="sheet-content"]',
        );
        await expect(sheet).toBeVisible();
        const done = sheet.getByRole("button", { name: "完成", exact: true });
        await expect(done).toBeVisible();
        await expect(done).toHaveAttribute("data-ui-button", "true");
        await expect(done).toHaveAttribute("data-slot", "sheet-close");
        const colors = await done.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            foreground: style.color,
            background: style.backgroundColor,
          };
        });
        expect(colors.foreground).not.toBe(colors.background);
        expect(
          contrastRatio(colors.foreground, colors.background),
        ).toBeGreaterThanOrEqual(4.5);
        await done.click();
        await expect(sheet).toBeHidden();
      } else {
        await expect(
          taskPage.locator('.mobile-filter-sheet[data-slot="sheet-content"]'),
        ).toHaveCount(0);
        await expect(taskPage.locator(".filterbar")).toBeVisible();
      }
    }
  }
  console.log(
    JSON.stringify({
      sheetDoneContrast: true,
      themes: ["light", "dark"],
      layouts: ["app", "sidebar"],
      variants,
      disabled: true,
    }),
  );
} finally {
  await taskPage.evaluate((storage) => {
    for (const [key, value] of Object.entries(storage)) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }, saved.localStorage);
  await taskPage.setViewportSize(
    saved.viewport ?? { width: 1440, height: 1000 },
  );
  await taskPage.goto(saved.url);
}

process.exit(0);
