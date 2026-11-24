export const ledgerColumnIds = [
  "occurredAt",
  "model",
  "reasoningEffort",
  "accountId",
  "input",
  "cacheRead",
  "cacheRate",
  "output",
  "firstTokenMs",
  "durationMs",
  "usd",
] as const;

export type LedgerColumnId = (typeof ledgerColumnIds)[number];

export interface LedgerColumnOverrides {
  show: LedgerColumnId[];
  hide: LedgerColumnId[];
}

export const emptyLedgerColumnOverrides: LedgerColumnOverrides = {
  show: [],
  hide: [],
};

export type LedgerWidthTier = "xs" | "sm" | "s" | "m" | "l" | "xl";

export type LedgerColumnGroup = "identity" | "tokens" | "performance";

export interface LedgerColumnMeta {
  id: LedgerColumnId;
  label: string;
  shortLabel?: string;
  tooltip?: string;
  group: LedgerColumnGroup;
}

export const ledgerColumnGroupLabels: Record<LedgerColumnGroup, string> = {
  identity: "基础信息",
  tokens: "Tokens 与缓存",
  performance: "性能与费用",
};

export const ledgerColumnOptions: readonly LedgerColumnMeta[] = [
  { id: "occurredAt", label: "时间", group: "identity" },
  { id: "model", label: "模型", group: "identity" },
  { id: "reasoningEffort", label: "推理强度", group: "identity" },
  { id: "accountId", label: "账户", group: "identity" },
  {
    id: "input",
    label: "输入",
    tooltip: "总输入（普通输入 + 缓存读取 + 缓存写入）",
    group: "tokens",
  },
  { id: "cacheRead", label: "缓存读取", group: "tokens" },
  {
    id: "cacheRate",
    label: "缓存命中率",
    shortLabel: "命中率",
    tooltip: "缓存命中率 = 缓存读取 ÷ 总输入",
    group: "tokens",
  },
  { id: "output", label: "输出", group: "tokens" },
  {
    id: "firstTokenMs",
    label: "首 Token 延迟",
    shortLabel: "首字延迟",
    tooltip: "首 Token 延迟（TTFT）",
    group: "performance",
  },
  { id: "durationMs", label: "总耗时", group: "performance" },
  { id: "usd", label: "费用", group: "performance" },
];

export interface LedgerColumnPreset {
  id: "billing" | "performance" | "all";
  label: string;
  columns: readonly LedgerColumnId[];
}

export const ledgerColumnPresets: readonly LedgerColumnPreset[] = [
  {
    id: "billing",
    label: "账务精简",
    columns: [
      "occurredAt",
      "model",
      "accountId",
      "input",
      "cacheRate",
      "output",
      "usd",
    ],
  },
  {
    id: "performance",
    label: "性能诊断",
    columns: [
      "occurredAt",
      "model",
      "input",
      "output",
      "firstTokenMs",
      "durationMs",
      "usd",
    ],
  },
  {
    id: "all",
    label: "完整明细",
    columns: ledgerColumnIds,
  },
];

const tierDefaultColumns: Record<LedgerWidthTier, readonly LedgerColumnId[]> = {
  // 宽屏与 1440px 桌面：紧凑列宽下全 11 列零溢出展示。
  xl: ledgerColumnIds,
  l: ledgerColumnIds,
  // 1280px 笔记本：默认收起可由输入×命中率推算的缓存读取，推理强度内嵌到模型徽标。
  m: [
    "occurredAt",
    "model",
    "accountId",
    "input",
    "cacheRate",
    "output",
    "firstTokenMs",
    "durationMs",
    "usd",
  ],
  // 1024px–1279px 小屏本与 768px 平板：保留账务核心 7 列，零溢出。
  s: [
    "occurredAt",
    "model",
    "accountId",
    "input",
    "cacheRate",
    "output",
    "usd",
  ],
  // 窄桌面窗口与 640px–740px 平板（表格可用宽 520–689px）：收起账户与输出，保持 5 核心列零溢出。
  sm: ["occurredAt", "model", "input", "cacheRate", "usd"],
  // 极窄侧栏模式表格（<520px）：只保留时间、模型与费用，避免强制横滚。
  xs: ["occurredAt", "model", "usd"],
};

/** 按表格滚动区实际可用宽度（clientWidth）划分响应档位，保证各档默认列严格零横向溢出。 */
export function ledgerWidthTier(availableWidth: number): LedgerWidthTier {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return "l";
  if (availableWidth >= 1200) return "xl";
  if (availableWidth >= 1040) return "l";
  if (availableWidth >= 895) return "m";
  if (availableWidth >= 692) return "s";
  if (availableWidth >= 520) return "sm";
  return "xs";
}

export function defaultColumnsForTier(
  tier: LedgerWidthTier,
): readonly LedgerColumnId[] {
  return tierDefaultColumns[tier];
}

/**
 * 合并当前宽度档位默认列与用户增量覆盖；保证至少保留一个可见数据列。
 */
export function resolveVisibleLedgerColumns(
  tier: LedgerWidthTier,
  overrides: LedgerColumnOverrides,
): LedgerColumnId[] {
  const defaults = tierDefaultColumns[tier];
  const show = new Set(
    overrides.show.filter((id) => ledgerColumnIds.includes(id)),
  );
  const hide = new Set(
    overrides.hide.filter((id) => ledgerColumnIds.includes(id)),
  );
  const visible = ledgerColumnIds.filter(
    (id) => (defaults.includes(id) || show.has(id)) && !hide.has(id),
  );
  return visible.length > 0 ? visible : [...defaults];
}

export function hasLedgerColumnOverrides(
  overrides: LedgerColumnOverrides,
): boolean {
  return overrides.show.length > 0 || overrides.hide.length > 0;
}

/** 切换单列可见性时只记录相对当前档位默认值的增量差异，避免跨端互相污染。 */
export function toggleLedgerColumnOverride(
  tier: LedgerWidthTier,
  current: LedgerColumnOverrides,
  id: LedgerColumnId,
  visible: boolean,
): LedgerColumnOverrides {
  const resolved = resolveVisibleLedgerColumns(tier, current);
  if (!visible && resolved.length <= 1 && resolved.includes(id)) return current;
  const isDefault = tierDefaultColumns[tier].includes(id);
  const show = new Set(current.show);
  const hide = new Set(current.hide);
  if (visible) {
    hide.delete(id);
    if (!isDefault) show.add(id);
  } else {
    show.delete(id);
    if (isDefault) hide.add(id);
  }
  return {
    show: ledgerColumnIds.filter((col) => show.has(col)),
    hide: ledgerColumnIds.filter((col) => hide.has(col)),
  };
}

/** 应用列预设：显式声明预设内与预设外列的增量，使所见即所选。 */
export function applyLedgerColumnPreset(
  tier: LedgerWidthTier,
  presetColumns: readonly LedgerColumnId[],
): LedgerColumnOverrides {
  const defaults = new Set(tierDefaultColumns[tier]);
  const target = new Set(presetColumns);
  return {
    show: ledgerColumnIds.filter((id) => target.has(id) && !defaults.has(id)),
    hide: ledgerColumnIds.filter((id) => !target.has(id) && defaults.has(id)),
  };
}
