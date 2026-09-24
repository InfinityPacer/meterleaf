import { useSyncExternalStore } from "react";

/**
 * 图表在 canvas 中绘制，读不到 CSS 变量，因此在这里把当前主题的颜色取出来。
 * 明暗（html.dark）或配色（data-palette）变化时，订阅者会拿到新的颜色并重绘。
 */
export interface ThemeColors {
  accent: string;
  /** 强调色的 rgba 形式，alpha 由调用方决定。 */
  accentAlpha: (alpha: number) => string;
  ink: string;
  muted: string;
  faint: string;
  line: string;
  lineSoft: string;
  surface: string;
  soft: string;
  fontFamily: string;
}

const fallback = {
  accent: "#0e8a55",
  accentRgb: "14 138 85",
  ink: "#18181b",
  muted: "#5f5f68",
  faint: "#8e8e97",
  line: "#e4e4e7",
  lineSoft: "#ededf0",
  surface: "#ffffff",
  soft: "#f0f0f2",
};

export const chartFontFamily =
  '"Geist Variable", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';

let cachedKey = "";
let cached: ThemeColors | null = null;

function build(values: typeof fallback): ThemeColors {
  const channels = values.accentRgb
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [r, g, b] = channels.length === 3 ? channels : [14, 138, 85];
  return {
    accent: values.accent,
    accentAlpha: (alpha) => `rgba(${r}, ${g}, ${b}, ${alpha})`,
    ink: values.ink,
    muted: values.muted,
    faint: values.faint,
    line: values.line,
    lineSoft: values.lineSoft,
    surface: values.surface,
    soft: values.soft,
    fontFamily: chartFontFamily,
  };
}

export function readThemeColors(): ThemeColors {
  if (typeof document === "undefined") return build(fallback);
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, value: string) =>
    style.getPropertyValue(name).trim() || value;
  const values = {
    accent: read("--accent", fallback.accent),
    accentRgb: read("--accent-rgb", fallback.accentRgb),
    ink: read("--ink", fallback.ink),
    muted: read("--muted", fallback.muted),
    faint: read("--faint", fallback.faint),
    line: read("--line", fallback.line),
    lineSoft: read("--line-soft", fallback.lineSoft),
    surface: read("--surface", fallback.surface),
    soft: read("--soft", fallback.soft),
  };
  const key = JSON.stringify(values);
  if (key !== cachedKey || !cached) {
    cachedKey = key;
    cached = build(values);
  }
  return cached;
}

function subscribe(onChange: () => void) {
  if (
    typeof MutationObserver === "undefined" ||
    typeof document === "undefined"
  )
    return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-palette"],
  });
  return () => observer.disconnect();
}

const serverColors = build(fallback);

export function useThemeColors(): ThemeColors {
  return useSyncExternalStore(subscribe, readThemeColors, () => serverColors);
}
