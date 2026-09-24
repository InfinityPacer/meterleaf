import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { expect, test } from "bun:test";
import { Menu as ActionMenu } from "@base-ui/react/menu";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterSelect } from "../src/web/components/FilterSelect";
import { Button } from "../src/web/components/ui/button";
import { Sheet, SheetClose } from "../src/web/components/ui/sheet";
import {
  PALETTE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  readStoredPalette,
  readStoredThemeMode,
  resolveThemeDark,
  ThemeControl,
} from "../src/web/components/ThemeControl";
import {
  formatSyncStatusReadError,
  isSyncActuallyRunning,
  SyncControl,
  formatSyncUpdatedAt,
} from "../src/web/components/SyncControl";

test("sync update label includes seconds in the ledger timezone", () => {
  expect(formatSyncUpdatedAt("2026-09-08T20:25:36.123Z")).toBe(
    "更新于 09/09 04:25:36",
  );
  expect(formatSyncUpdatedAt("2026-09-08T16:00:00Z")).toBe(
    "更新于 09/09 00:00:00",
  );
  expect(formatSyncUpdatedAt(null)).toBeNull();
  expect(formatSyncUpdatedAt("invalid")).toBeNull();
});

test("status transport failures do not masquerade as sync failures", () => {
  expect(
    formatSyncStatusReadError({
      syncStatusReadError: "gateway-timeout",
      status: 504,
    }),
  ).toBe("读取同步状态失败：网关超时（HTTP 504）");
  expect(formatSyncStatusReadError({ syncStatusReadError: "network" })).toBe(
    "读取同步状态失败：网络连接异常",
  );
  expect(isSyncActuallyRunning({ running: true }, true)).toBe(false);
  expect(isSyncActuallyRunning({ running: true }, false)).toBe(true);
});

test("FilterSelect renders Base UI options without a native select", () => {
  const html = renderToStaticMarkup(
    <FilterSelect
      label="模型筛选"
      value="all"
      onChange={() => {}}
      options={[
        { value: "all", label: "全部模型" },
        { value: "gpt", label: "GPT" },
      ]}
    />,
  );
  expect(html).toContain('aria-label="模型筛选"');
  expect(html).not.toContain("<select");
  expect(html).toContain("全部模型");
});

test("ThemeControl keeps appearance and palette contracts independent", () => {
  const storage = new Map<string, string>([
    [THEME_STORAGE_KEY, "system"],
    [PALETTE_STORAGE_KEY, "mono"],
  ]);
  const readOnlyStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
  };
  expect(readStoredThemeMode(readOnlyStorage)).toBe("system");
  expect(readStoredPalette(readOnlyStorage)).toBe("mono");
  // 旧版本的「默认」「自然」配色已不存在，回到翠绿。
  expect(readStoredPalette({ getItem: () => "natural" })).toBe("green");
  expect(resolveThemeDark("system", true)).toBe(true);
  expect(resolveThemeDark("system", false)).toBe(false);
  expect(resolveThemeDark("light", true)).toBe(false);
  expect(resolveThemeDark("dark", false)).toBe(true);
});

test("fresh and invalid appearance preferences follow the system", () => {
  expect(readStoredThemeMode(null)).toBe("system");
  expect(readStoredThemeMode({ getItem: () => "invalid" })).toBe("system");
  expect(resolveThemeDark(readStoredThemeMode(null), true)).toBe(true);
  expect(resolveThemeDark(readStoredThemeMode(null), false)).toBe(false);
});

test("ThemeControl and SyncControl expose accessible Base UI triggers", () => {
  const client = new QueryClient();
  const theme = renderToStaticMarkup(
    <ThemeControl onResolvedChange={() => {}} />,
  );
  const sync = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SyncControl />
    </QueryClientProvider>,
  );
  expect(theme).toContain('aria-label="主题设置"');
  expect(sync).toContain('aria-label="数据同步"');
  expect(sync).not.toContain("<details");
});

test("shared buttons keep their identity through SheetClose composition", () => {
  const variants = [
    "default",
    "outline",
    "secondary",
    "ghost",
    "destructive",
    "link",
  ] as const;

  for (const variant of variants) {
    const html = renderToStaticMarkup(
      <Sheet open>
        <SheetClose render={<Button variant={variant} />}>{variant}</SheetClose>
      </Sheet>,
    );
    expect(html).toContain('data-slot="sheet-close"');
    expect(html).toContain('data-ui-button="true"');
    expect(html).toContain(`data-variant="${variant}"`);
  }
});

test("shared buttons keep their identity through dialog and menu composition", () => {
  const dialog = renderToStaticMarkup(
    <AlertDialog.Root open>
      <AlertDialog.Close render={<Button variant="outline" />}>
        取消
      </AlertDialog.Close>
    </AlertDialog.Root>,
  );
  const menu = renderToStaticMarkup(
    <ActionMenu.Root>
      <ActionMenu.Trigger render={<Button variant="ghost" />}>
        操作
      </ActionMenu.Trigger>
    </ActionMenu.Root>,
  );

  expect(dialog).toContain('data-ui-button="true"');
  expect(dialog).toContain('data-variant="outline"');
  expect(menu).toContain('data-ui-button="true"');
  expect(menu).toContain('data-variant="ghost"');
});
