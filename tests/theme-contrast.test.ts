import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { modelColors } from "../src/web/lib/report";
import { readThemeColors } from "../src/web/lib/theme-colors";

const stylesCss = readFileSync(
  new URL("../src/web/styles.css", import.meta.url),
  "utf8",
);
const aboutCss = readFileSync(
  new URL("../src/web/components/about-page.css", import.meta.url),
  "utf8",
);
const indexHtml = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const offlineHtml = readFileSync(
  new URL("../public/offline.html", import.meta.url),
  "utf8",
);

function parseHex(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  const value = Number.parseInt(clean, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function composite(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number],
): [number, number, number] {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

function luminance(rgb: [number, number, number]) {
  const [r, g, b] = rgb.map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(
  foreground: [number, number, number],
  background: [number, number, number],
) {
  const fg = luminance(foreground);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function readBlockVar(source: string, selector: RegExp, variable: string) {
  const block = source.match(selector)?.[1];
  expect(block).toBeDefined();
  const value = block?.match(new RegExp(`${variable}:\\s*([^;]+);`))?.[1];
  expect(value).toBeDefined();
  return value!.trim();
}

test("light and dark --faint tokens meet WCAG AA contrast across text surfaces", () => {
  const lightCanvas = parseHex(
    readBlockVar(stylesCss, /:root\s*\{([\s\S]*?)\n\}/, "--canvas"),
  );
  const lightSurface = parseHex(
    readBlockVar(stylesCss, /:root\s*\{([\s\S]*?)\n\}/, "--surface"),
  );
  const lightSoft = parseHex(
    readBlockVar(stylesCss, /:root\s*\{([\s\S]*?)\n\}/, "--soft"),
  );
  const lightFaint = parseHex(
    readBlockVar(stylesCss, /:root\s*\{([\s\S]*?)\n\}/, "--faint"),
  );

  expect(contrastRatio(lightFaint, lightSurface)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(lightFaint, lightCanvas)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(lightFaint, lightSoft)).toBeGreaterThanOrEqual(4.5);

  const darkCanvas = parseHex(
    readBlockVar(stylesCss, /\.dark\s*\{([\s\S]*?)\n\}/, "--canvas"),
  );
  const darkSurface = parseHex(
    readBlockVar(stylesCss, /\.dark\s*\{([\s\S]*?)\n\}/, "--surface"),
  );
  const darkSoft = parseHex(
    readBlockVar(stylesCss, /\.dark\s*\{([\s\S]*?)\n\}/, "--soft"),
  );
  const darkFaint = parseHex(
    readBlockVar(stylesCss, /\.dark\s*\{([\s\S]*?)\n\}/, "--faint"),
  );

  expect(contrastRatio(darkFaint, darkCanvas)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(darkFaint, darkSurface)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(darkFaint, darkSoft)).toBeGreaterThanOrEqual(4.5);
});

test("all light and dark accent palettes meet WCAG AA contrast on solid and tinted surfaces", () => {
  const lightCanvas = parseHex(
    readBlockVar(stylesCss, /:root\s*\{([\s\S]*?)\n\}/, "--canvas"),
  );
  const lightSurface = parseHex(
    readBlockVar(stylesCss, /:root\s*\{([\s\S]*?)\n\}/, "--surface"),
  );
  const lightSoft = parseHex(
    readBlockVar(stylesCss, /:root\s*\{([\s\S]*?)\n\}/, "--soft"),
  );
  const darkCanvas = parseHex(
    readBlockVar(stylesCss, /\.dark\s*\{([\s\S]*?)\n\}/, "--canvas"),
  );
  const darkSurface = parseHex(
    readBlockVar(stylesCss, /\.dark\s*\{([\s\S]*?)\n\}/, "--surface"),
  );
  const darkSoft = parseHex(
    readBlockVar(stylesCss, /\.dark\s*\{([\s\S]*?)\n\}/, "--soft"),
  );

  const cases = [
    {
      name: "light-green",
      selector: /:root\s*\{([\s\S]*?)\n\}/,
      textSurfaces: [lightSurface, lightCanvas, lightSoft],
      tintedSurfaces: [lightSurface, lightCanvas],
      softAlpha: 0.08,
    },
    {
      name: "dark-green",
      selector: /\.dark\s*\{([\s\S]*?)\n\}/,
      textSurfaces: [darkCanvas, darkSurface, darkSoft],
      tintedSurfaces: [darkCanvas, darkSurface],
      softAlpha: 0.12,
    },
    {
      name: "light-indigo",
      selector: /:root\[data-palette="indigo"\]\s*\{([\s\S]*?)\n\}/,
      textSurfaces: [lightSurface, lightCanvas, lightSoft],
      tintedSurfaces: [lightSurface, lightCanvas],
      softAlpha: 0.08,
    },
    {
      name: "dark-indigo",
      selector: /:root\.dark\[data-palette="indigo"\]\s*\{([\s\S]*?)\n\}/,
      textSurfaces: [darkCanvas, darkSurface, darkSoft],
      tintedSurfaces: [darkCanvas, darkSurface],
      softAlpha: 0.12,
    },
    {
      name: "light-mono",
      selector: /:root\[data-palette="mono"\]\s*\{([\s\S]*?)\n\}/,
      textSurfaces: [lightSurface, lightCanvas, lightSoft],
      tintedSurfaces: [lightSurface, lightCanvas],
      softAlpha: 0.08,
    },
    {
      name: "dark-mono",
      selector: /:root\.dark\[data-palette="mono"\]\s*\{([\s\S]*?)\n\}/,
      textSurfaces: [darkCanvas, darkSurface, darkSoft],
      tintedSurfaces: [darkCanvas, darkSurface],
      softAlpha: 0.12,
    },
  ] as const;

  for (const item of cases) {
    const accent = parseHex(readBlockVar(stylesCss, item.selector, "--accent"));
    const accentInk = parseHex(
      readBlockVar(stylesCss, item.selector, "--accent-ink"),
    );
    expect(contrastRatio(accentInk, accent)).toBeGreaterThanOrEqual(4.5);
    for (const surface of item.textSurfaces) {
      expect(contrastRatio(accent, surface)).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of item.tintedSurfaces) {
      expect(
        contrastRatio(accent, composite(accent, item.softAlpha, surface)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("standalone boot, offline, canvas fallback, and swatch tokens stay synchronized with styles.css", () => {
  const lightFaint = readBlockVar(
    stylesCss,
    /:root\s*\{([\s\S]*?)\n\}/,
    "--faint",
  );
  const darkFaint = readBlockVar(
    stylesCss,
    /\.dark\s*\{([\s\S]*?)\n\}/,
    "--faint",
  );
  const lightAccent = readBlockVar(
    stylesCss,
    /:root\s*\{([\s\S]*?)\n\}/,
    "--accent",
  );
  const lightAccentRgb = readBlockVar(
    stylesCss,
    /:root\s*\{([\s\S]*?)\n\}/,
    "--accent-rgb",
  );

  const fallbackColors = readThemeColors();
  expect(fallbackColors.faint).toBe(lightFaint);
  expect(fallbackColors.accent).toBe(lightAccent);
  expect(fallbackColors.accentAlpha(0.5)).toBe(
    `rgba(${lightAccentRgb.split(/\s+/).join(", ")}, 0.5)`,
  );

  expect(
    readBlockVar(indexHtml, /:root\s*\{([\s\S]*?)\}/, "--boot-accent"),
  ).toBe(lightAccent);
  expect(readBlockVar(offlineHtml, /:root\s*\{([\s\S]*?)\}/, "--faint")).toBe(
    lightFaint,
  );
  expect(readBlockVar(offlineHtml, /:root\s*\{([\s\S]*?)\}/, "--accent")).toBe(
    lightAccent,
  );
  expect(
    readBlockVar(offlineHtml, /:root\.dark\s*\{([\s\S]*?)\}/, "--faint"),
  ).toBe(darkFaint);
  expect(
    readBlockVar(
      aboutCss,
      /\.about-page \.theme-palette-options i\s*\{([\s\S]*?)\}/,
      "background",
    ),
  ).toBe(lightAccent);
  // 模型图表色独立于品牌强调色，不随主题强调色联动替换。
  expect(modelColors["gemini-4-hydrogen"]).toBe("#0e8a55");
});
