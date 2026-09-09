import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  Check,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Smartphone,
  Sun,
} from "lucide-react";
import { FilterSelect } from "./FilterSelect";
import "./controls.css";

export type ThemeMode = "system" | "light" | "dark";
export type ThemePalette = "default" | "natural";

export const THEME_STORAGE_KEY = "meterleaf-theme";
export const PALETTE_STORAGE_KEY = "meterleaf-palette";

export const themeModeOptions = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] satisfies { value: ThemeMode; label: string }[];

export const themePaletteOptions = [
  { value: "default", label: "默认" },
  { value: "natural", label: "自然" },
] satisfies { value: ThemePalette; label: string }[];

export function resolveThemeDark(mode: ThemeMode, systemDark: boolean) {
  return mode === "dark" || (mode === "system" && systemDark);
}

export function readStoredThemeMode(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ThemeMode {
  const value = storage?.getItem(THEME_STORAGE_KEY);
  if (value === "system" || value === "light" || value === "dark") return value;
  return "system";
}

export function readStoredPalette(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ThemePalette {
  return storage?.getItem(PALETTE_STORAGE_KEY) === "natural"
    ? "natural"
    : "default";
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function systemDark(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

function persist(storage: Storage | null, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    // 隐私模式或受限文档可能禁止持久化，主题切换仍应继续生效。
  }
}

export function ThemeControl({
  onResolvedChange,
  mobileLayout,
  onMobileLayoutChange,
  inline = false,
  hidden = false,
}: {
  onResolvedChange: (dark: boolean) => void;
  mobileLayout?: "sidebar" | "app";
  onMobileLayoutChange?: (layout: "sidebar" | "app") => void;
  inline?: boolean;
  /** 不显示入口时仍应用已保存主题和系统外观变化。 */
  hidden?: boolean;
}) {
  const storage = browserStorage();
  const [mode, setMode] = useState<ThemeMode>(() =>
    readStoredThemeMode(storage),
  );
  const [palette, setPalette] = useState<ThemePalette>(() =>
    readStoredPalette(storage),
  );
  const [dark, setDark] = useState(() =>
    resolveThemeDark(readStoredThemeMode(storage), systemDark()),
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const media =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const apply = () => {
      const nextDark = resolveThemeDark(mode, media?.matches ?? false);
      root.classList.toggle("dark", nextDark);
      root.dataset.palette = palette;
      setDark(nextDark);
      onResolvedChange(nextDark);
    };
    const onSystemChange = () => {
      if (mode === "system") apply();
    };

    apply();
    media?.addEventListener("change", onSystemChange);
    return () => {
      media?.removeEventListener("change", onSystemChange);
    };
  }, [mode, palette, onResolvedChange]);

  const changeMode = (next: string) => {
    if (next !== "system" && next !== "light" && next !== "dark") return;
    setMode(next);
    persist(storage, THEME_STORAGE_KEY, next);
  };
  const changePalette = (next: string) => {
    if (next !== "default" && next !== "natural") return;
    setPalette(next);
    persist(storage, PALETTE_STORAGE_KEY, next);
  };

  const fields = (
    <>
      <div className="theme-control-fields">
        {onMobileLayoutChange && (
          <div className="theme-control-field">
            <span className="theme-control-label">手机导航</span>
            <FilterSelect
              label="手机导航"
              value={mobileLayout ?? "app"}
              onChange={(value) => {
                if (value === "app" || value === "sidebar")
                  onMobileLayoutChange(value);
              }}
              options={[
                { value: "app", label: "App 模式" },
                { value: "sidebar", label: "侧栏模式" },
              ]}
            />
          </div>
        )}
        <div className="theme-control-field">
          <span className="theme-control-label">外观</span>
          <FilterSelect
            label="外观"
            value={mode}
            onChange={changeMode}
            options={themeModeOptions}
          />
        </div>
        <div className="theme-control-field">
          <span className="theme-control-label">配色</span>
          <FilterSelect
            label="配色"
            value={palette}
            onChange={changePalette}
            options={themePaletteOptions}
          />
        </div>
      </div>
    </>
  );
  if (hidden) return null;
  if (inline)
    return (
      <div className="theme-control-inline theme-preferences">
        <div className="theme-preferences-section">
          <h3>外观</h3>
          <div
            className="theme-appearance-options"
            role="group"
            aria-label="外观"
          >
            {themeModeOptions.map((option) => {
              const Icon =
                option.value === "light"
                  ? Sun
                  : option.value === "dark"
                    ? Moon
                    : Monitor;
              return (
                <button
                  key={option.value}
                  aria-pressed={mode === option.value}
                  onClick={() => changeMode(option.value)}
                >
                  <span
                    className={`theme-appearance-preview theme-preview-${option.value}`}
                    aria-hidden="true"
                  >
                    <span />
                    <span>
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                  <span className="theme-option-caption">
                    <Icon size={15} />
                    {option.label}
                    {mode === option.value && <Check size={14} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="theme-preferences-row">
          <span>配色</span>
          <div className="theme-palette-options" role="group" aria-label="配色">
            {themePaletteOptions.map((option) => (
              <button
                key={option.value}
                aria-pressed={palette === option.value}
                onClick={() => changePalette(option.value)}
              >
                <i data-palette={option.value} aria-hidden="true" />
                {option.label}
                {palette === option.value && <Check size={13} />}
              </button>
            ))}
          </div>
        </div>
        {onMobileLayoutChange && (
          <div className="theme-preferences-row">
            <span>手机导航</span>
            <div
              className="theme-navigation-options"
              role="group"
              aria-label="手机导航"
            >
              <button
                aria-pressed={mobileLayout === "app"}
                onClick={() => onMobileLayoutChange("app")}
              >
                <Smartphone size={15} />
                App 模式
              </button>
              <button
                aria-pressed={mobileLayout === "sidebar"}
                onClick={() => onMobileLayoutChange("sidebar")}
              >
                <PanelLeft size={15} />
                侧栏模式
              </button>
            </div>
          </div>
        )}
      </div>
    );
  return (
    <div className="theme-control">
      <Popover.Root>
        <Popover.Trigger
          className="theme-control-trigger"
          aria-label="主题设置"
          title="主题设置"
        >
          {dark ? (
            <Moon size={18} aria-hidden="true" />
          ) : (
            <Sun size={18} aria-hidden="true" />
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="theme-control-positioner"
            sideOffset={8}
            align="end"
          >
            <Popover.Popup className="theme-control-popup">
              <div className="theme-control-heading">
                <Popover.Title className="theme-control-title">
                  <Palette size={16} aria-hidden="true" />
                  主题
                </Popover.Title>
              </div>
              {fields}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
