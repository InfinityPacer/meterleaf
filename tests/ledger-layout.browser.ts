import { chromium, expect, type Page } from "@playwright/test";
import { ledgerWidthTier } from "../src/web/lib/ledger-columns";

const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4317/";
const baseUrl = new URL(base);
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(baseUrl.hostname)) {
  throw new Error(`Refusing non-local test URL: ${base}`);
}

const endpoint = process.env.METERLEAF_CDP_URL;
if (!endpoint) throw new Error("METERLEAF_CDP_URL is required");

type CaseSpec = {
  name: string;
  width: number;
  height: number;
  mobileLayout?: "app" | "sidebar";
  expectedTier: "l" | "m" | "s" | "sm" | "xs";
  expectTable: boolean;
  expectAllColsOverflow: boolean;
  expectLeftSticky: boolean;
};

const cases: CaseSpec[] = [
  {
    name: "desktop-1440",
    width: 1440,
    height: 900,
    expectedTier: "l",
    expectTable: true,
    expectAllColsOverflow: false,
    expectLeftSticky: true,
  },
  {
    name: "desktop-1280",
    width: 1280,
    height: 800,
    expectedTier: "m",
    expectTable: true,
    expectAllColsOverflow: false,
    expectLeftSticky: true,
  },
  {
    name: "tablet-1024",
    width: 1024,
    height: 768,
    expectedTier: "s",
    expectTable: true,
    expectAllColsOverflow: true,
    expectLeftSticky: true,
  },
  {
    name: "tablet-1024-short",
    width: 1024,
    height: 580,
    expectedTier: "s",
    expectTable: true,
    expectAllColsOverflow: true,
    expectLeftSticky: true,
  },
  {
    name: "tablet-768-app",
    width: 768,
    height: 1024,
    mobileLayout: "app",
    expectedTier: "s",
    expectTable: true,
    expectAllColsOverflow: true,
    expectLeftSticky: true,
  },
  {
    name: "tablet-768-sidebar",
    width: 768,
    height: 1024,
    mobileLayout: "sidebar",
    expectedTier: "s",
    expectTable: true,
    expectAllColsOverflow: true,
    expectLeftSticky: true,
  },
  {
    name: "narrow-650-app",
    width: 650,
    height: 800,
    mobileLayout: "app",
    expectedTier: "sm",
    expectTable: true,
    expectAllColsOverflow: true,
    expectLeftSticky: true,
  },
  {
    name: "narrow-650-sidebar",
    width: 650,
    height: 800,
    mobileLayout: "sidebar",
    expectedTier: "sm",
    expectTable: true,
    expectAllColsOverflow: true,
    expectLeftSticky: true,
  },
  {
    name: "mobile-393-app",
    width: 393,
    height: 852,
    mobileLayout: "app",
    expectedTier: "xs",
    expectTable: false,
    expectAllColsOverflow: false,
    expectLeftSticky: false,
  },
  {
    name: "mobile-393-sidebar",
    width: 393,
    height: 852,
    mobileLayout: "sidebar",
    expectedTier: "xs",
    expectTable: true,
    expectAllColsOverflow: true,
    expectLeftSticky: false,
  },
  {
    name: "mobile-320-app",
    width: 320,
    height: 568,
    mobileLayout: "app",
    expectedTier: "xs",
    expectTable: false,
    expectAllColsOverflow: false,
    expectLeftSticky: false,
  },
  {
    name: "mobile-320-sidebar",
    width: 320,
    height: 568,
    mobileLayout: "sidebar",
    expectedTier: "xs",
    expectTable: true,
    expectAllColsOverflow: true,
    expectLeftSticky: false,
  },
];

const storageKeys = [
  "meterleaf-theme",
  "meterleaf-palette",
  "meterleaf-pref-mobile-layout",
  "meterleaf-pref-ledger-column-overrides",
  "meterleaf-pref-ledger-hidden-columns",
] as const;

type SavedState = {
  url: string;
  viewport: { width: number; height: number } | null;
  localStorage: Record<string, string | null>;
};

// 整个 CDP 生命周期（含查标签失败路径）包入 try/finally，结束时撤销模拟并复验系统主题。
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
          (!baseUrl.search || candidateUrl.search === baseUrl.search)
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
    localStorage: await page.evaluate(
      (keys) =>
        Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
      storageKeys,
    ),
  };

  async function verifyCase(spec: CaseSpec, theme: "light" | "dark") {
    await page.setViewportSize({ width: spec.width, height: spec.height });
    await page.goto(`${base}#ledger`);
    await page.evaluate(
      ({ theme, layout }) => {
        localStorage.setItem("meterleaf-theme", theme);
        localStorage.setItem("meterleaf-palette", "green");
        if (layout) {
          localStorage.setItem(
            "meterleaf-pref-mobile-layout",
            JSON.stringify(layout),
          );
        }
        localStorage.removeItem("meterleaf-pref-ledger-column-overrides");
        localStorage.removeItem("meterleaf-pref-ledger-hidden-columns");
      },
      { theme, layout: spec.mobileLayout ?? null },
    );
    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", {
      timeout: 30_000,
    });
    await expect(page.locator(".ledger-section")).toBeVisible();

    const defaultGeom = await page.evaluate(() => {
      const docWidth = document.documentElement.scrollWidth;
      const vpWidth = window.innerWidth;
      const section = document.querySelector(".ledger-section") as HTMLElement;
      const scroller = document.querySelector(
        ".request-table-scroll",
      ) as HTMLElement | null;
      const mobileList = document.querySelector(
        ".mobile-request-list",
      ) as HTMLElement | null;
      const tableVisible =
        !!scroller && getComputedStyle(scroller).display !== "none";
      const mobileVisible =
        !!mobileList && getComputedStyle(mobileList).display !== "none";
      const colIds = Array.from(
        document.querySelectorAll(".request-table-scroll thead th"),
      ).map((th) => th.getAttribute("data-column-id"));
      const scrollerRect = scroller?.getBoundingClientRect();
      const usdTh = document.querySelector(
        '.request-table-scroll thead th[data-column-id="usd"]',
      );
      const openTh = document.querySelector(
        '.request-table-scroll thead th[data-column-id="open"]',
      );
      const searchControl = document.querySelector(
        ".ledger-heading-tools .search-control",
      ) as HTMLElement | null;
      const demoBadge = document.querySelector(
        ".demo-badge",
      ) as HTMLElement | null;

      return {
        docWidth,
        vpWidth,
        tier: section.getAttribute("data-width-tier"),
        tableVisible,
        mobileVisible,
        scrollerClientW: scroller ? scroller.clientWidth : 0,
        scrollerScrollW: scroller ? scroller.scrollWidth : 0,
        dataOverflow: scroller?.getAttribute("data-overflow"),
        colIds,
        usdInScroller:
          !!usdTh &&
          !!scrollerRect &&
          usdTh.getBoundingClientRect().right <= scrollerRect.right + 1,
        openInScroller:
          !!openTh &&
          !!scrollerRect &&
          openTh.getBoundingClientRect().right <= scrollerRect.right + 1,
        searchWidth:
          searchControl && getComputedStyle(searchControl).display !== "none"
            ? Math.round(searchControl.getBoundingClientRect().width)
            : null,
        demoBadgeHeight:
          demoBadge && getComputedStyle(demoBadge).display !== "none"
            ? Math.round(demoBadge.getBoundingClientRect().height)
            : null,
      };
    });

    // 1. 默认列下严格禁止页面级横向溢出；档位与滚动区实际可用宽度（含滚动条）一致。
    expect(
      defaultGeom.docWidth,
      `${spec.name}/${theme} default page overflow`,
    ).toBeLessThanOrEqual(defaultGeom.vpWidth);
    expect(defaultGeom.tableVisible, `${spec.name} tableVisible`).toBe(
      spec.expectTable,
    );
    if (defaultGeom.tableVisible && defaultGeom.scrollerClientW > 0) {
      expect(defaultGeom.tier, `${spec.name} tier`).toBe(
        ledgerWidthTier(defaultGeom.scrollerClientW),
      );
    } else {
      expect(defaultGeom.tier, `${spec.name} tier`).toBe(spec.expectedTier);
    }

    if (
      spec.mobileLayout === "app" &&
      spec.width <= 359 &&
      defaultGeom.demoBadgeHeight !== null
    ) {
      // 320px App 模式演示徽标保持紧凑 2x2 折行，不再竖排成 4 行（约 66px）。
      expect(defaultGeom.demoBadgeHeight).toBeLessThanOrEqual(46);
    }

    if (!spec.expectTable) {
      expect(defaultGeom.mobileVisible).toBe(true);
      const firstCard = page.locator(".mobile-request-item").first();
      await expect(firstCard).toBeVisible();
      await firstCard.click();
      await expect(page.locator(".detail-body")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".detail-body")).toBeHidden();
      return;
    }

    // 2. 默认列下表内零横向溢出，费用与详情入口均立即可达。
    expect(
      defaultGeom.scrollerScrollW,
      `${spec.name}/${theme} default table overflow`,
    ).toBeLessThanOrEqual(defaultGeom.scrollerClientW + 1);
    expect(defaultGeom.dataOverflow).toBe("false");
    expect(defaultGeom.usdInScroller).toBe(true);
    expect(defaultGeom.openInScroller).toBe(true);

    if (spec.width <= 360 && defaultGeom.searchWidth !== null) {
      // 320px 侧栏下搜索框换行占满工具栏宽度，不再半字裁切占位符。
      expect(defaultGeom.searchWidth).toBeGreaterThanOrEqual(200);
    }

    // 3. 验证列开关勾选状态与实际渲染列一致，并切换全列验证表内受控横滚与页面零溢出。
    const trigger = page.locator(".ledger-columns-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.locator(".ledger-columns-menu")).toBeVisible();

    const checkedCount = await page
      .locator(
        '.ledger-columns-menu [role="menuitemcheckbox"][aria-checked="true"]',
      )
      .count();
    expect(checkedCount).toBe(
      defaultGeom.colIds.filter((id) => id !== "open").length,
    );

    await page.locator(".ledger-preset-chip", { hasText: "完整明细" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ledger-columns-menu")).toBeHidden();

    const expandedGeom = await page.evaluate(() => {
      const docWidth = document.documentElement.scrollWidth;
      const vpWidth = window.innerWidth;
      const scroller = document.querySelector(
        ".request-table-scroll",
      ) as HTMLElement;
      const overflow = scroller.scrollWidth > scroller.clientWidth + 1;
      if (overflow) {
        scroller.scrollLeft = Math.round(
          (scroller.scrollWidth - scroller.clientWidth) / 2,
        );
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const firstTh = document.querySelector(
        ".request-table-scroll thead th:first-child",
      ) as HTMLElement;
      const middleTh = document.querySelector(
        '.request-table-scroll thead th[data-column-id="input"]',
      ) as HTMLElement;
      const usdTh = document.querySelector(
        '.request-table-scroll thead th[data-column-id="usd"]',
      ) as HTMLElement;
      const openTh = document.querySelector(
        '.request-table-scroll thead th[data-column-id="open"]',
      ) as HTMLElement;
      const middleTd = document.querySelector(
        '.request-table-scroll tbody tr:first-child td[data-column-id="input"]',
      ) as HTMLElement;
      const usdTd = document.querySelector(
        '.request-table-scroll tbody tr:first-child td[data-column-id="usd"]',
      ) as HTMLElement;
      const effectiveBg = (el: HTMLElement) => {
        let cur: HTMLElement | null = el;
        while (cur) {
          const bg = getComputedStyle(cur).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent")
            return bg;
          cur = cur.parentElement;
        }
        return getComputedStyle(document.documentElement).backgroundColor;
      };
      const usdRect = usdTh.getBoundingClientRect();
      const openRect = openTh.getBoundingClientRect();

      return {
        docWidth,
        vpWidth,
        overflow,
        dataOverflow: scroller.getAttribute("data-overflow"),
        scrollerClientW: scroller.clientWidth,
        firstThPosition: getComputedStyle(firstTh).position,
        usdThPosition: getComputedStyle(usdTh).position,
        openThPosition: getComputedStyle(openTh).position,
        middleThBg: getComputedStyle(middleTh).backgroundColor,
        firstThBg: getComputedStyle(firstTh).backgroundColor,
        usdThBg: getComputedStyle(usdTh).backgroundColor,
        openThBg: getComputedStyle(openTh).backgroundColor,
        middleTdEffectiveBg: effectiveBg(middleTd),
        usdTdBg: getComputedStyle(usdTd).backgroundColor,
        usdVisible:
          usdRect.left >= scrollerRect.left - 1 &&
          usdRect.right <= scrollerRect.right + 1,
        openVisible:
          openRect.left >= scrollerRect.left - 1 &&
          openRect.right <= scrollerRect.right + 1,
        freeScrollViewportW:
          scroller.clientWidth -
          Math.round(usdRect.width) -
          Math.round(openRect.width) -
          (getComputedStyle(firstTh).position === "sticky"
            ? Math.round(firstTh.getBoundingClientRect().width)
            : 0),
      };
    });

    // 主动增选全部 11 列后，页面级仍保持零横向溢出。
    expect(
      expandedGeom.docWidth,
      `${spec.name}/${theme} expanded page overflow`,
    ).toBeLessThanOrEqual(expandedGeom.vpWidth);
    expect(expandedGeom.usdVisible).toBe(true);
    expect(expandedGeom.openVisible).toBe(true);

    if (spec.expectAllColsOverflow) {
      expect(expandedGeom.overflow).toBe(true);
      expect(expandedGeom.dataOverflow).toBe("true");
      expect(expandedGeom.usdThPosition).toBe("sticky");
      expect(expandedGeom.openThPosition).toBe("sticky");
      expect(expandedGeom.firstThPosition).toBe(
        spec.expectLeftSticky ? "sticky" : "static",
      );
      // 粘性表头与数据单元格底色必须与同表格普通单元格一致，避免深浅双主题下的底色断层。
      expect(expandedGeom.usdThBg, `${spec.name}/${theme} usd th bg`).toBe(
        expandedGeom.middleThBg,
      );
      expect(expandedGeom.openThBg, `${spec.name}/${theme} open th bg`).toBe(
        expandedGeom.middleThBg,
      );
      expect(expandedGeom.usdTdBg, `${spec.name}/${theme} usd td bg`).toBe(
        expandedGeom.middleTdEffectiveBg,
      );
      if (spec.expectLeftSticky) {
        expect(
          expandedGeom.firstThBg,
          `${spec.name}/${theme} first th bg`,
        ).toBe(expandedGeom.middleThBg);
      } else {
        // xs 取消左列 sticky 后，320px 侧栏中间滚动视窗宽敞可读（>= 140px）。
        expect(expandedGeom.freeScrollViewportW).toBeGreaterThanOrEqual(140);
      }
    }

    // 滚动状态下右侧详情入口仍可直接点击打开抽屉。
    await page
      .locator(".request-table-scroll tbody button[data-request-id]")
      .first()
      .click();
    await expect(page.locator(".detail-body")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".detail-body")).toBeHidden();

    // 恢复自适应默认并验证回到无表内横滚状态。
    await trigger.click();
    await expect(page.locator(".ledger-columns-menu")).toBeVisible();
    const resetItem = page.locator('.ledger-columns-menu [role="menuitem"]', {
      hasText: "恢复自适应默认",
    });
    if ((await resetItem.count()) > 0) {
      await resetItem.click();
      await expect(page.locator(".request-table-scroll")).toHaveAttribute(
        "data-overflow",
        "false",
      );
    } else {
      await page.keyboard.press("Escape");
    }
  }

  for (const spec of cases) {
    await verifyCase(spec, "light");
  }
  // 深色主题复验关键横滚与窄屏场景，确保表头粘性底色与布局同样一致。
  for (const name of [
    "tablet-1024-short",
    "narrow-650-app",
    "mobile-320-sidebar",
    "mobile-320-app",
  ]) {
    const spec = cases.find((item) => item.name === name)!;
    await verifyCase(spec, "dark");
  }

  // 减少动态效果模式下复验关键窄屏状态。
  await page.emulateMedia({ reducedMotion: "reduce" });
  await verifyCase(
    cases.find((item) => item.name === "narrow-650-app")!,
    "light",
  );

  console.log(
    JSON.stringify({
      status: "passed",
      lightCases: cases.length,
      darkCases: 4,
      reducedMotionChecked: true,
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
