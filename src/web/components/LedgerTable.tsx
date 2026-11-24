import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Menu as ActionMenu } from "@base-ui/react/menu";
import {
  flexRender,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronRight as OpenIcon,
  Columns3,
  Search,
  Check,
} from "lucide-react";
import type { LedgerAccount, LedgerRecord } from "../../shared/report";
import {
  applyLedgerColumnPreset,
  defaultColumnsForTier,
  emptyLedgerColumnOverrides,
  hasLedgerColumnOverrides,
  ledgerColumnGroupLabels,
  ledgerColumnOptions,
  ledgerColumnPresets,
  ledgerWidthTier,
  resolveVisibleLedgerColumns,
  toggleLedgerColumnOverride,
  type LedgerColumnGroup,
  type LedgerColumnId,
  type LedgerColumnOverrides,
  type LedgerWidthTier,
} from "../lib/ledger-columns";
import { ledgerPageSizes, type LedgerPageSize } from "../lib/preferences";
import {
  amount,
  cacheHitRate,
  compact,
  formatDurationSeconds,
  formatLatencyMs,
  formatPercent,
  isKnownNumber,
  localTime,
  modelColor,
  modelLabel,
  numericAmount,
  requestDurationMs,
  requestFirstTokenMs,
} from "../lib/report";
import { FilterSelect } from "./FilterSelect";
import { Button } from "./ui/button";
import "./mobile-data.css";

export { ledgerColumnOptions };

interface Props {
  records: LedgerRecord[];
  total: number;
  pageIndex: number;
  pageSize?: LedgerPageSize;
  onPage: (page: number) => void;
  onPageSize?: (pageSize: LedgerPageSize) => void;
  sorting: { id: string; desc: boolean };
  onSorting: (sorting: { id: string; desc: boolean }) => void;
  columnOverrides?: LedgerColumnOverrides;
  onColumnOverrides?: Dispatch<SetStateAction<LedgerColumnOverrides>>;
  /** 兼容测试与调用方直接传入静态隐藏列或指定测试容器宽度档位。 */
  hiddenColumns?: LedgerColumnId[];
  onHiddenColumns?: (columns: LedgerColumnId[]) => void;
  widthTier?: LedgerWidthTier;
  hasActiveFilters?: boolean;
  onResetFilters?: () => void;
  accounts: LedgerAccount[];
  onSelect: (row: LedgerRecord) => void;
  search: string;
  onSearch: (value: string) => void;
  compactView?: boolean;
}

const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

const ledgerSortOptions = [
  { value: "occurredAt", label: "时间", shortLabel: "时间" },
  { value: "model", label: "模型", shortLabel: "模型" },
  { value: "accountId", label: "账户", shortLabel: "账户" },
  { value: "input", label: "输入", shortLabel: "输入" },
  { value: "cacheRead", label: "缓存读取", shortLabel: "缓存" },
  { value: "cacheRate", label: "缓存命中率", shortLabel: "命中" },
  { value: "output", label: "输出", shortLabel: "输出" },
  { value: "firstTokenMs", label: "首字延迟", shortLabel: "首字" },
  { value: "durationMs", label: "总耗时", shortLabel: "耗时" },
  { value: "usd", label: "费用", shortLabel: "费用" },
] as const;

const numericColumns = new Set([
  "input",
  "cacheRead",
  "cacheRate",
  "output",
  "firstTokenMs",
  "durationMs",
  "usd",
]);

const columnGroups: readonly LedgerColumnGroup[] = [
  "identity",
  "tokens",
  "performance",
];

/** 输入展示包含三个输入桶；缺少任一桶时保留未知，不用部分值冒充总输入。 */
function requestInputTokens(record: LedgerRecord) {
  const values = [record.input, record.cacheRead, record.cacheWrite];
  return values.every(isKnownNumber)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

/** 有效强度优先；缺少有效值时保留请求值，不推断默认档位。 */
function requestReasoningEffort(record: LedgerRecord) {
  return (
    record.details?.reasoningEffort?.trim() ||
    record.details?.requestedReasoningEffort?.trim() ||
    null
  );
}

/** 移动端按卡片默认未展示的指标排序时，动态回显当前排序指标值。 */
function mobileSortedMetric(
  record: LedgerRecord,
  sortId: string,
): { label: string; text: string } | null {
  if (sortId === "input") {
    const value = requestInputTokens(record);
    return value !== null ? { label: "输入", text: compact(value) } : null;
  }
  if (sortId === "cacheRead") {
    return isKnownNumber(record.cacheRead)
      ? { label: "缓存", text: compact(record.cacheRead) }
      : null;
  }
  if (sortId === "output") {
    return isKnownNumber(record.output)
      ? { label: "输出", text: compact(record.output) }
      : null;
  }
  if (sortId === "firstTokenMs") {
    const value = requestFirstTokenMs(record);
    return value !== null
      ? { label: "首字", text: formatLatencyMs(value) }
      : null;
  }
  if (sortId === "durationMs") {
    const value = requestDurationMs(record);
    return value !== null
      ? { label: "耗时", text: formatDurationSeconds(value) }
      : null;
  }
  return null;
}

export type LedgerPageItem =
  | { type: "page"; pageIndex: number }
  | { type: "ellipsis"; position: "start" | "end" };

/** 生成桌面页码项；数字项沿用请求分页接口的零基页索引。 */
export function getLedgerPageItems(
  pageIndex: number,
  pageCount: number,
): LedgerPageItem[] {
  const count = Math.max(1, Math.floor(pageCount));
  const current = Math.min(Math.max(Math.floor(pageIndex), 0), count - 1);

  if (count <= 7) {
    return Array.from({ length: count }, (_, index) => ({
      type: "page" as const,
      pageIndex: index,
    }));
  }

  const windowStart = Math.max(0, Math.min(current - 2, count - 5));
  const windowPages = Array.from(
    { length: 5 },
    (_, index) => windowStart + index,
  );
  const pages = [...new Set([0, ...windowPages, count - 1])].sort(
    (left, right) => left - right,
  );
  const items: LedgerPageItem[] = [];

  pages.forEach((page, index) => {
    const previous = pages[index - 1];
    if (previous !== undefined && page - previous > 1) {
      items.push({
        type: "ellipsis",
        position: previous === 0 ? "start" : "end",
      });
    }
    items.push({ type: "page", pageIndex: page });
  });

  return items;
}

export function LedgerTable({
  records,
  total,
  pageIndex,
  pageSize: configuredPageSize = 12,
  onPage,
  onPageSize,
  sorting,
  onSorting,
  columnOverrides,
  onColumnOverrides,
  hiddenColumns,
  onHiddenColumns,
  widthTier: forcedTier,
  hasActiveFilters = false,
  onResetFilters,
  accounts,
  onSelect,
  search,
  onSearch,
  compactView = false,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [measuredTier, setMeasuredTier] = useState<LedgerWidthTier>(() => {
    if (forcedTier) return forcedTier;
    if (typeof window === "undefined") return "l";
    // 首帧在 ResizeObserver 回调前先用视口估算容器宽度，避免初始闪烁。
    const estimated =
      window.innerWidth > 900
        ? window.innerWidth - 360
        : window.innerWidth - 40;
    return ledgerWidthTier(estimated);
  });
  const [scrollEdges, setScrollEdges] = useState({
    overflow: false,
    left: false,
    right: false,
  });

  useEffect(() => {
    if (forcedTier) return;
    const sectionEl = sectionRef.current;
    const scrollerEl = scrollRef.current;
    if (!sectionEl && !scrollerEl) return;
    // 优先测量表格滚动区实际可用 clientWidth（已扣除卡片内边距与纵滚条），隐藏时回退容器宽度。
    const updateTier = () => {
      const scrollWidth = scrollerEl?.clientWidth ?? 0;
      const width =
        scrollWidth > 0 ? scrollWidth : (sectionEl?.clientWidth ?? 0);
      if (width > 0) setMeasuredTier(ledgerWidthTier(width));
    };
    updateTier();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateTier);
    if (scrollerEl) observer.observe(scrollerEl);
    if (sectionEl) observer.observe(sectionEl);
    return () => observer.disconnect();
  }, [forcedTier]);

  const tier = forcedTier ?? measuredTier;
  const effectiveOverrides: LedgerColumnOverrides =
    columnOverrides ??
    (hiddenColumns
      ? { show: [], hide: hiddenColumns }
      : emptyLedgerColumnOverrides);
  const defaultColumns = defaultColumnsForTier(tier);
  const defaultColumnSet = new Set(defaultColumns);
  const visibleColumnIds = resolveVisibleLedgerColumns(
    tier,
    effectiveOverrides,
  );
  const visibleColumnSet = new Set<LedgerColumnId>(visibleColumnIds);
  // m/s 等中窄屏把推理强度折进模型列，省出整列宽；xs 极窄屏只保留模型名避免徽标被裁切。
  const foldEffortIntoModel =
    tier !== "xs" && !visibleColumnSet.has("reasoningEffort");
  const visibleDataCount = visibleColumnIds.length;
  const hasCustomColumns = hasLedgerColumnOverrides(effectiveOverrides);
  const canManageColumns = Boolean(
    !compactView && (onColumnOverrides || onHiddenColumns),
  );

  const syncScrollEdges = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const overflow = scroller.scrollWidth > scroller.clientWidth + 1;
    const left = overflow && scroller.scrollLeft > 1;
    const right =
      overflow &&
      scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    setScrollEdges((current) =>
      current.overflow === overflow &&
      current.left === left &&
      current.right === right
        ? current
        : { overflow, left, right },
    );
  }, []);

  useEffect(() => {
    syncScrollEdges();
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncScrollEdges);
    observer.observe(scroller);
    const tableEl = scroller.querySelector("table");
    if (tableEl) observer.observe(tableEl);
    return () => observer.disconnect();
  }, [syncScrollEdges, visibleColumnIds.join(","), records.length, tier]);

  const updateOverrides = (
    updater: (current: LedgerColumnOverrides) => LedgerColumnOverrides,
  ) => {
    if (onColumnOverrides) {
      onColumnOverrides(updater);
      return;
    }
    if (onHiddenColumns) {
      const next = updater(effectiveOverrides);
      const visible = new Set(resolveVisibleLedgerColumns(tier, next));
      onHiddenColumns(
        ledgerColumnOptions
          .map((item) => item.id)
          .filter((id) => !visible.has(id)),
      );
    }
  };

  const pageSize = compactView ? 5 : configuredPageSize;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  // 刷新后的总量可能缩小；页码回到有效范围后重新读取对应记录。
  useEffect(() => {
    if (!compactView && currentPage !== pageIndex) onPage(currentPage);
  }, [compactView, currentPage, onPage, pageIndex]);

  const metaById = new Map(ledgerColumnOptions.map((item) => [item.id, item]));
  const headerLabel = (id: LedgerColumnId) => {
    const meta = metaById.get(id)!;
    if (id === "firstTokenMs") return meta.shortLabel ?? meta.label;
    if (id === "cacheRate" && tier !== "xl")
      return meta.shortLabel ?? meta.label;
    return meta.label;
  };

  const allColumns: ColumnDef<typeof features, LedgerRecord>[] = [
    {
      id: "occurredAt",
      accessorKey: "occurredAt",
      header: () => headerLabel("occurredAt"),
      cell: (info) => (
        <div className="time-cell">
          <span>
            {localTime(info.getValue<string>(), {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </span>
        </div>
      ),
    },
    {
      id: "model",
      accessorKey: "model",
      header: () => headerLabel("model"),
      cell: (info) => {
        const label = modelLabel(info.getValue<string>());
        const effort = foldEffortIntoModel
          ? requestReasoningEffort(info.row.original)
          : null;
        return (
          <span className="model-cell-inline">
            <span className="model-label" title={label}>
              <i style={{ background: modelColor(info.getValue<string>()) }} />
              <span className="model-label-text">{label}</span>
            </span>
            {effort && (
              <span className="effort-badge" title="推理强度">
                {effort}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "reasoningEffort",
      header: () => headerLabel("reasoningEffort"),
      accessorFn: requestReasoningEffort,
      cell: (info) => {
        const effort = info.getValue<string | null>();
        return effort ? (
          <span className="effort-badge">{effort}</span>
        ) : (
          <span className="faint-na">N/A</span>
        );
      },
      enableSorting: false,
    },
    {
      id: "accountId",
      accessorKey: "accountId",
      header: () => headerLabel("accountId"),
      cell: (info) => {
        const name =
          accounts.find((a) => a.id === info.getValue())?.name ??
          info.getValue<string>();
        return (
          <span className="ledger-account-cell" title={name}>
            {name}
          </span>
        );
      },
    },
    {
      id: "input",
      accessorFn: requestInputTokens,
      header: () => headerLabel("input"),
      cell: (info) => compact(info.getValue<number | null>()),
    },
    {
      id: "cacheRead",
      accessorKey: "cacheRead",
      header: () => headerLabel("cacheRead"),
      cell: (info) => (
        <span className="cache-text">
          {compact(info.getValue<number | null>())}
        </span>
      ),
    },
    {
      id: "cacheRate",
      accessorFn: (row) => cacheHitRate(row),
      header: () => headerLabel("cacheRate"),
      cell: (info) => formatPercent(info.getValue<number | null>()),
    },
    {
      id: "output",
      accessorKey: "output",
      header: () => headerLabel("output"),
      cell: (info) => compact(info.getValue<number | null>()),
    },
    {
      id: "firstTokenMs",
      accessorFn: requestFirstTokenMs,
      header: () => headerLabel("firstTokenMs"),
      cell: (info) => formatLatencyMs(info.getValue<number | null>()),
    },
    {
      id: "durationMs",
      accessorFn: requestDurationMs,
      header: () => headerLabel("durationMs"),
      cell: (info) => formatDurationSeconds(info.getValue<number | null>()),
    },
    {
      id: "usd",
      accessorFn: (row) => numericAmount(row.usd),
      header: () => headerLabel("usd"),
      cell: (info) => (
        <strong>{amount(info.getValue<number | null>(), "usd")}</strong>
      ),
    },
    {
      id: "open",
      header: () => <span className="sr-only">明细</span>,
      enableSorting: false,
    },
  ];
  const columns = allColumns.filter(
    (column) =>
      column.id === "open" || visibleColumnSet.has(column.id as LedgerColumnId),
  );
  const table = useTable({
    features,
    data: records,
    getRowId: (record) => record.id,
    columns,
    manualSorting: true,
    manualPagination: true,
    state: {
      sorting: [sorting],
      pagination: { pageIndex: currentPage, pageSize },
    },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater([sorting]) : updater;
      onSorting(next[0] ?? { id: "occurredAt", desc: true });
    },
    initialState: {
      pagination: { pageIndex: 0, pageSize },
    },
  });

  const activeSortOption = ledgerSortOptions.find(
    (item) => item.value === sorting.id,
  );
  const activeSortPill =
    sorting.id !== "occurredAt" && activeSortOption
      ? `${activeSortOption.shortLabel} ${sorting.desc ? "↓" : "↑"}`
      : null;

  return (
    <section
      ref={sectionRef}
      className="ledger-section request-section"
      data-width-tier={tier}
    >
      <div className="section-heading">
        <div>
          <h2>{compactView ? "最近请求" : "请求明细"}</h2>
          <span className="muted">{total.toLocaleString()} 条记录</span>
        </div>
        <div className="mobile-data-controls mobile-request-controls">
          {activeSortPill && (
            <span className="mobile-sort-pill" aria-hidden="true">
              {activeSortPill}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="搜索请求"
            title="搜索请求"
            aria-expanded={searchOpen || !!search}
            onClick={() => {
              if (searchOpen || search) {
                onSearch("");
                setSearchOpen(false);
              } else setSearchOpen(true);
            }}
          >
            <Search size={18} />
          </Button>
          <ActionMenu.Root>
            <ActionMenu.Trigger
              className="mobile-data-tool"
              aria-label="请求排序"
              title="请求排序"
            >
              <ArrowUpDown size={18} />
            </ActionMenu.Trigger>
            <ActionMenu.Portal>
              <ActionMenu.Positioner
                className="data-menu-positioner"
                sideOffset={6}
                align="end"
              >
                <ActionMenu.Popup className="data-menu">
                  {ledgerSortOptions.map((option) => (
                    <ActionMenu.Item
                      key={option.value}
                      onClick={() =>
                        onSorting({ id: option.value, desc: sorting.desc })
                      }
                    >
                      {option.label}
                      {sorting.id === option.value && (
                        <Check size={15} aria-hidden="true" />
                      )}
                    </ActionMenu.Item>
                  ))}
                  <ActionMenu.Separator />
                  <ActionMenu.Item
                    onClick={() =>
                      onSorting({ ...sorting, desc: !sorting.desc })
                    }
                  >
                    切换为{sorting.desc ? "升序" : "降序"}
                    {sorting.desc ? (
                      <ArrowUp size={15} />
                    ) : (
                      <ArrowDown size={15} />
                    )}
                  </ActionMenu.Item>
                </ActionMenu.Popup>
              </ActionMenu.Positioner>
            </ActionMenu.Portal>
          </ActionMenu.Root>
        </div>
        <div className="ledger-heading-tools">
          {canManageColumns && (
            <ActionMenu.Root>
              <ActionMenu.Trigger
                className="ledger-columns-trigger"
                aria-label="显示列"
                title="显示或隐藏表格列"
              >
                <Columns3 size={14} aria-hidden="true" />
                <span>
                  显示列
                  {visibleDataCount < ledgerColumnOptions.length
                    ? ` (${visibleDataCount}/${ledgerColumnOptions.length})`
                    : ""}
                </span>
              </ActionMenu.Trigger>
              <ActionMenu.Portal>
                <ActionMenu.Positioner
                  className="data-menu-positioner"
                  sideOffset={6}
                  align="end"
                >
                  <ActionMenu.Popup className="data-menu ledger-columns-menu">
                    <div
                      className="ledger-columns-presets"
                      role="group"
                      aria-label="列预设"
                    >
                      {ledgerColumnPresets.map((preset) => {
                        const isActive =
                          preset.columns.length === visibleColumnIds.length &&
                          preset.columns.every((id) =>
                            visibleColumnSet.has(id),
                          );
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            className="ledger-preset-chip"
                            aria-pressed={isActive}
                            onClick={() =>
                              updateOverrides(() =>
                                applyLedgerColumnPreset(tier, preset.columns),
                              )
                            }
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                    <ActionMenu.Separator />
                    {columnGroups.map((groupId, groupIndex) => (
                      <div key={groupId}>
                        {groupIndex > 0 && <ActionMenu.Separator />}
                        <ActionMenu.Group>
                          <ActionMenu.GroupLabel>
                            {ledgerColumnGroupLabels[groupId]}
                          </ActionMenu.GroupLabel>
                          {ledgerColumnOptions
                            .filter((option) => option.group === groupId)
                            .map((option) => {
                              const checked = visibleColumnSet.has(option.id);
                              const disabled = checked && visibleDataCount <= 1;
                              const autoDeferred =
                                !checked && !defaultColumnSet.has(option.id);
                              return (
                                <ActionMenu.CheckboxItem
                                  key={option.id}
                                  checked={checked}
                                  disabled={disabled}
                                  closeOnClick={false}
                                  onCheckedChange={(next) =>
                                    updateOverrides((current) =>
                                      toggleLedgerColumnOverride(
                                        tier,
                                        current,
                                        option.id,
                                        next,
                                      ),
                                    )
                                  }
                                >
                                  <span className="ledger-column-option-label">
                                    <span>{option.label}</span>
                                    {autoDeferred && (
                                      <small className="ledger-column-auto-hint">
                                        窄屏收起
                                      </small>
                                    )}
                                  </span>
                                  <ActionMenu.CheckboxItemIndicator
                                    keepMounted={false}
                                  >
                                    <Check size={15} aria-hidden="true" />
                                  </ActionMenu.CheckboxItemIndicator>
                                </ActionMenu.CheckboxItem>
                              );
                            })}
                        </ActionMenu.Group>
                      </div>
                    ))}
                    {hasCustomColumns && (
                      <>
                        <ActionMenu.Separator />
                        <ActionMenu.Item
                          onClick={() =>
                            updateOverrides(() => emptyLedgerColumnOverrides)
                          }
                        >
                          恢复自适应默认
                        </ActionMenu.Item>
                      </>
                    )}
                  </ActionMenu.Popup>
                </ActionMenu.Positioner>
              </ActionMenu.Portal>
            </ActionMenu.Root>
          )}
          <label
            className="search-control"
            data-expanded={searchOpen || !!search}
          >
            <Search size={15} />
            <input
              aria-label="搜索请求"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="搜索模型或请求 ID"
            />
          </label>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={syncScrollEdges}
        className="table-scroll request-table-scroll"
        data-overflow={scrollEdges.overflow ? "true" : "false"}
        data-scroll-left={scrollEdges.left ? "true" : "false"}
        data-scroll-right={scrollEdges.right ? "true" : "false"}
        role="region"
        aria-label="请求明细表格"
        tabIndex={0}
      >
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const tooltip = metaById.get(
                    header.id as LedgerColumnId,
                  )?.tooltip;
                  return (
                    <th
                      key={header.id}
                      data-column-id={header.id}
                      title={tooltip}
                      aria-sort={
                        header.column.getIsSorted() === "asc"
                          ? "ascending"
                          : header.column.getIsSorted() === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={numericColumns.has(header.id) ? "numeric" : ""}
                    >
                      {header.column.getCanSort() ? (
                        <button
                          onClick={header.column.getToggleSortingHandler()}
                          title={tooltip}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {header.column.getIsSorted() === "desc" ? (
                            <ArrowDown size={12} />
                          ) : header.column.getIsSorted() === "asc" ? (
                            <ArrowUp size={12} />
                          ) : (
                            <ArrowUpDown size={11} className="sort-idle" />
                          )}
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="ledger-clickable-row"
                onClick={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (target?.closest("button, a, input")) return;
                  onSelect(row.original);
                }}
              >
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    data-column-id={cell.column.id}
                    className={
                      numericColumns.has(cell.column.id) ? "numeric" : ""
                    }
                  >
                    {/* 行操作保持元素身份，不能随单元格渲染函数重建而丢失焦点。 */}
                    {cell.column.id === "open" ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="查看计量明细"
                        aria-label={`查看 ${row.original.id}`}
                        data-request-id={row.original.id}
                        onClick={() => onSelect(row.original)}
                      >
                        <OpenIcon size={15} />
                      </Button>
                    ) : (
                      flexRender(cell.column.columnDef.cell, cell.getContext())
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        className="mobile-request-list"
        role="region"
        aria-label="请求列表"
        tabIndex={0}
      >
        {table.getRowModel().rows.map((row) => {
          const record = row.original;
          const effort = requestReasoningEffort(record);
          const rate = cacheHitRate(record);
          const sortedMetric = mobileSortedMetric(record, sorting.id);
          const account =
            accounts.find((item) => item.id === record.accountId)?.name ??
            record.accountId;
          return (
            <button
              key={row.id}
              type="button"
              className="mobile-request-item"
              data-request-id={record.id}
              aria-label={`查看 ${record.id} 的计量明细`}
              onClick={() => onSelect(record)}
            >
              <span className="mobile-request-heading">
                <span className="mobile-request-model">
                  <i
                    style={{ background: modelColor(record.model) }}
                    aria-hidden="true"
                  />
                  <span className="mobile-request-identity">
                    <span>{modelLabel(record.model)}</span>
                    {effort && (
                      <span
                        className="mobile-request-effort"
                        title="推理强度"
                        aria-label={`推理强度：${effort}`}
                      >
                        {effort}
                      </span>
                    )}
                  </span>
                </span>
                <strong>{amount(numericAmount(record.usd), "usd")}</strong>
                <OpenIcon size={14} aria-hidden="true" />
              </span>
              <span className="mobile-request-meta">
                <time dateTime={record.occurredAt}>
                  {localTime(record.occurredAt, {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </time>
                {sortedMetric ? (
                  <span
                    className="mobile-request-cache mobile-request-sort-metric"
                    title={sortedMetric.label}
                  >
                    {sortedMetric.label} {sortedMetric.text}
                  </span>
                ) : (
                  rate !== null && (
                    <span
                      className="mobile-request-cache"
                      title="缓存命中率"
                      aria-label={`缓存命中率：${formatPercent(rate)}`}
                    >
                      命中 {formatPercent(rate)}
                    </span>
                  )
                )}
                <span
                  className="mobile-request-account"
                  title={account || "N/A"}
                >
                  {account || "N/A"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {!records.length && (
        <div className="empty-state">
          <Search size={26} />
          <h3>没有匹配的请求</h3>
          <p>当前筛选下暂无记录</p>
          {search ? (
            <Button variant="outline" onClick={() => onSearch("")}>
              清除搜索
            </Button>
          ) : hasActiveFilters && onResetFilters ? (
            <Button variant="outline" onClick={onResetFilters}>
              清除筛选
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onSearch("")} disabled>
              清除搜索
            </Button>
          )}
        </div>
      )}
      {!compactView && total > 0 && (
        <div className="pagination">
          <div className="ledger-page-meta">
            <span className="ledger-page-summary mobile-only">
              第 {currentPage + 1} / {pageCount} 页
            </span>
            {onPageSize ? (
              <>
                <div className="ledger-page-size">
                  <FilterSelect
                    label="每页行数"
                    value={String(pageSize)}
                    onChange={(value) => {
                      const next = Number(value) as LedgerPageSize;
                      if (ledgerPageSizes.includes(next)) onPageSize(next);
                    }}
                    options={ledgerPageSizes.map((size) => ({
                      value: String(size),
                      label: `每页 ${size} 条`,
                    }))}
                  />
                </div>
                <span className="ledger-page-total desktop-only">
                  共 {total.toLocaleString()} 条记录
                </span>
              </>
            ) : (
              <span className="ledger-page-total desktop-only">
                每页 {pageSize} 条，共 {total.toLocaleString()} 条记录
              </span>
            )}
          </div>
          <div className="ledger-page-controls">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="上一页"
              onClick={() => onPage(currentPage - 1)}
              disabled={currentPage === 0}
            >
              <ChevronLeft size={15} />
            </Button>
            <nav className="ledger-page-numbers" aria-label="页码">
              {getLedgerPageItems(currentPage, pageCount).map((item) =>
                item.type === "ellipsis" ? (
                  <span key={`${item.position}-ellipsis`} aria-hidden="true">
                    …
                  </span>
                ) : (
                  <Button
                    key={item.pageIndex}
                    variant="outline"
                    size="icon-sm"
                    aria-label={`第 ${item.pageIndex + 1} 页`}
                    aria-current={
                      item.pageIndex === currentPage ? "page" : undefined
                    }
                    onClick={() => onPage(item.pageIndex)}
                  >
                    {item.pageIndex + 1}
                  </Button>
                ),
              )}
            </nav>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="下一页"
              onClick={() => onPage(currentPage + 1)}
              disabled={currentPage + 1 >= pageCount}
            >
              <ChevronRight size={15} />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
