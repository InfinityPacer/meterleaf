import { chromium, expect, type Page } from "@playwright/test";
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

const variants = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
] as const;

const palettes = ["green", "indigo", "mono"] as const;

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

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`Unsupported computed color: ${value}`);
  const channels = match[1]!
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map((channel) => Number(channel.trim()));
  return [
    channels[0]!,
    channels[1]!,
    channels[2]!,
    channels[3] === undefined ? 1 : channels[3],
  ];
}

function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const alpha = fg[3];
  const outAlpha = alpha + bg[3] * (1 - alpha);
  if (outAlpha === 0) return [0, 0, 0, 0];
  return [
    (fg[0] * alpha + bg[0] * bg[3] * (1 - alpha)) / outAlpha,
    (fg[1] * alpha + bg[1] * bg[3] * (1 - alpha)) / outAlpha,
    (fg[2] * alpha + bg[2] * bg[3] * (1 - alpha)) / outAlpha,
    outAlpha,
  ];
}

function resolveColor(value: string, fallbackBg: Rgba): Rgba {
  const parsed = parseColor(value);
  return parsed[3] < 1 ? compositeOver(parsed, fallbackBg) : parsed;
}

function luminance(rgb: Rgba) {
  const linear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
  );
}

function contrastRatio(foreground: string, background: string) {
  const bg = parseColor(background);
  const fg = resolveColor(foreground, bg);
  const foregroundLuminance = luminance(fg);
  const backgroundLuminance = luminance(bg);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

async function resolveElementContrast(page: Page, selector: string) {
  const sample = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const style = getComputedStyle(el);
    const layers: string[] = [];
    let current: HTMLElement | null = el;
    while (current) {
      const bg = getComputedStyle(current).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        layers.push(bg);
      }
      current = current.parentElement;
    }
    const rootBg = getComputedStyle(document.documentElement).backgroundColor;
    if (rootBg && rootBg !== "rgba(0, 0, 0, 0)") layers.push(rootBg);
    return {
      foreground: style.color,
      layers,
    };
  }, selector);
  if (!sample) return null;
  let effectiveBg: Rgba = [255, 255, 255, 1];
  for (let i = sample.layers.length - 1; i >= 0; i--) {
    effectiveBg = compositeOver(parseColor(sample.layers[i]!), effectiveBg);
  }
  const bgCss = `rgb(${effectiveBg[0]}, ${effectiveBg[1]}, ${effectiveBg[2]})`;
  return contrastRatio(sample.foreground, bgCss);
}

async function resolveCssVarRgb(page: Page, variable: string) {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, variable);
}

// 整个 CDP 生命周期（含查标签失败路径）包入 try/finally，避免异常泄漏连接或模拟状态。
const browser = await chromium.connectOverCDP(endpoint);
let taskPage: Page | undefined;
let saved: SavedState | undefined;

try {
  taskPage = browser
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
  if (!taskPage)
    throw new Error(
      "Open the local task page through the browser manager first",
    );
  const page = taskPage;
  page.setDefaultTimeout(10_000);

  saved = {
    url: page.url(),
    viewport: page.viewportSize(),
    localStorage: await page.evaluate((keys) => {
      return Object.fromEntries(
        keys.map((key) => [key, localStorage.getItem(key)]),
      );
    }, storageKeys),
  };

  async function installFixture() {
    await page.evaluate((html) => {
      document.querySelector("[data-button-contrast-fixture]")?.remove();
      document.body.insertAdjacentHTML("beforeend", html);
    }, fixture);
  }

  async function setState(
    theme: "light" | "dark",
    layout: "app" | "sidebar",
    palette: (typeof palettes)[number] = "green",
    hash = "#reports",
    viewport = { width: 390, height: 844 },
  ) {
    await page.setViewportSize(viewport);
    await page.goto(`${base}${hash}`);
    await page.evaluate(
      ({ theme, layout, palette }) => {
        localStorage.setItem("meterleaf-theme", theme);
        localStorage.setItem("meterleaf-palette", palette);
        localStorage.setItem(
          "meterleaf-pref-mobile-layout",
          JSON.stringify(layout),
        );
        localStorage.removeItem("meterleaf-report-filter");
      },
      { theme, layout, palette },
    );
    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", {
      timeout: 30_000,
    });
    await expect
      .poll(() =>
        page.evaluate(
          ({ theme }) => ({
            dark: document.documentElement.classList.contains("dark"),
            layout: document.documentElement.dataset.mobileLayout,
            palette: document.documentElement.dataset.palette ?? "green",
            theme,
          }),
          { theme },
        ),
      )
      .toEqual({ dark: theme === "dark", layout, palette, theme });
    await installFixture();
  }

  async function assertFixture() {
    const controls = page.locator(
      '[data-button-contrast-fixture] button[data-ui-button="true"]',
    );
    await expect(controls).toHaveCount(variants.length * 2);
    for (const variant of variants) {
      const enabled = page.locator(
        `[data-button-contrast-fixture] button[data-variant="${variant}"][aria-label="${variant} enabled"]`,
      );
      const disabled = page.locator(
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
      if (variant === "link") {
        const surface = await resolveCssVarRgb(page, "--surface");
        expect(
          contrastRatio(colors.foreground, surface),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }

  for (const theme of ["light", "dark"] as const) {
    for (const layout of ["app", "sidebar"] as const) {
      await setState(theme, layout);
      await assertFixture();

      if (layout === "app") {
        const trigger = page.getByRole("button", {
          name: "筛选与计价",
          exact: true,
        });
        await expect(trigger).toBeVisible();
        await trigger.click();
        const sheet = page.locator(
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
          page.locator('.mobile-filter-sheet[data-slot="sheet-content"]'),
        ).toHaveCount(0);
        await expect(page.locator(".filterbar")).toBeVisible();
      }
    }
  }

  // 验证桌面总览（含 AccountTrend Canvas 纵轴色、摘要附注、图例与套餐徽标）与全配色对比度。
  for (const theme of ["light", "dark"] as const) {
    for (const palette of palettes) {
      await setState(theme, "app", palette, "#overview", {
        width: 1280,
        height: 840,
      });

      const faintColor = await resolveCssVarRgb(page, "--faint");
      const surfaceColor = await resolveCssVarRgb(page, "--surface");
      const canvasColor = await resolveCssVarRgb(page, "--canvas");
      const softColor = await resolveCssVarRgb(page, "--soft");
      const accentColor = await resolveCssVarRgb(page, "--accent");
      const accentInkColor = await resolveCssVarRgb(page, "--accent-ink");

      // AccountTrend.tsx:198 使用 colors.faint（读取 --faint）绘制 Canvas 10px 纵轴文字。
      await expect(page.locator(".mini-trend canvas").first()).toBeVisible();
      expect(contrastRatio(faintColor, surfaceColor)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(faintColor, canvasColor)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(faintColor, softColor)).toBeGreaterThanOrEqual(4.5);

      expect(contrastRatio(accentInkColor, accentColor)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(accentColor, surfaceColor)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(accentColor, canvasColor)).toBeGreaterThanOrEqual(
        4.5,
      );

      for (const selector of [
        ".lifetime-summary small",
        ".token-composition-legend",
        '.plan-chip[data-tier="2"]',
        '.plan-chip[data-tier="3"]',
      ]) {
        const ratio = await resolveElementContrast(page, selector);
        if (ratio !== null) {
          expect(
            ratio,
            `${theme}/${palette} ${selector}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }

    // 验证请求明细列开关菜单中的窄屏收起提示与选中预设胶囊对比度。
    await setState(theme, "app", "green", "#ledger", {
      width: 1280,
      height: 840,
    });
    const columnsTrigger = page.locator(".ledger-columns-trigger");
    await expect(columnsTrigger).toBeVisible();
    await columnsTrigger.click();
    await expect(page.locator(".ledger-columns-menu")).toBeVisible();
    const autoHintRatio = await resolveElementContrast(
      page,
      ".ledger-column-auto-hint",
    );
    if (autoHintRatio !== null) {
      expect(autoHintRatio).toBeGreaterThanOrEqual(4.5);
    }
    const billingPreset = page.locator(".ledger-preset-chip", {
      hasText: "账务精简",
    });
    await billingPreset.click();
    const activeChipRatio = await resolveElementContrast(
      page,
      '.ledger-preset-chip[aria-pressed="true"]',
    );
    expect(activeChipRatio).not.toBeNull();
    expect(activeChipRatio!).toBeGreaterThanOrEqual(4.5);
    const resetItem = page.locator('.ledger-columns-menu [role="menuitem"]', {
      hasText: "恢复自适应默认",
    });
    if ((await resetItem.count()) > 0) await resetItem.click();
    else await page.keyboard.press("Escape");
  }

  // 验证独立离线页 public/offline.html 在浅/深双主题与三配色下的次级文字与主按钮对比度。
  // 拦截离线页探测请求，避免本机服务可达时立即触发 location.reload() 中断测量。
  const probePattern = "**/?probe=*";
  const abortProbe = (route: { abort: (reason?: string) => Promise<void> }) =>
    route.abort("internetdisconnected");
  await page.route(probePattern, abortProbe);
  try {
    for (const theme of ["light", "dark"] as const) {
      for (const palette of palettes) {
        await page.goto(`${baseUrl.origin}/offline.html`, {
          waitUntil: "domcontentloaded",
        });
        await page.evaluate(
          ({ theme, palette }) => {
            document.documentElement.classList.toggle("dark", theme === "dark");
            document.documentElement.dataset.palette = palette;
            document.documentElement.dataset.state = "offline";
          },
          { theme, palette },
        );
        await expect(page.locator("main")).toBeVisible();
        const noteRatio = await resolveElementContrast(page, "main p + p");
        const buttonRatio = await resolveElementContrast(
          page,
          "#reconnect-button",
        );
        expect(noteRatio, `offline ${theme}/${palette} p+p`).not.toBeNull();
        expect(
          noteRatio!,
          `offline ${theme}/${palette} p+p`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          buttonRatio,
          `offline ${theme}/${palette} button`,
        ).not.toBeNull();
        expect(
          buttonRatio!,
          `offline ${theme}/${palette} button`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally {
    await page.unroute(probePattern, abortProbe).catch(() => undefined);
  }

  console.log(
    JSON.stringify({
      sheetDoneContrast: true,
      accountTrendFaintContrast: true,
      ledgerMenuContrast: true,
      offlineContrast: true,
      themes: ["light", "dark"],
      palettes,
      layouts: ["app", "sidebar"],
      variants,
      disabled: true,
    }),
  );
} finally {
  if (taskPage && saved) {
    try {
      await taskPage.goto(saved.url);
      await taskPage.evaluate((storage) => {
        for (const [key, value] of Object.entries(storage)) {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        }
      }, saved.localStorage);
      await taskPage.emulateMedia({ colorScheme: null, reducedMotion: null });
      await taskPage.setViewportSize(
        saved.viewport ?? { width: 1440, height: 1000 },
      );
      await taskPage.reload();
      await taskPage.evaluate(() => {
        const mode = localStorage.getItem("meterleaf-theme") || "system";
        if (mode === "system") {
          const prefersDark = matchMedia(
            "(prefers-color-scheme: dark)",
          ).matches;
          if (
            document.documentElement.classList.contains("dark") !== prefersDark
          ) {
            throw new Error("System theme mismatch after cleanup reload");
          }
        }
      });
    } catch {}
  }
  await browser.close();
}

process.exit(0);
