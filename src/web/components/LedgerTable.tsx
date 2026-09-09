import { useEffect, useState } from "react";
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
  Search,
  Check,
} from "lucide-react";
import type {
  LedgerAccount,
  LedgerRecord,
  UsdBasis,
} from "../../shared/report";
import {
  amount,
  compact,
  isKnownNumber,
  localTime,
  modelColor,
  modelLabel,
  numericAmount,
} from "../lib/report";
import { Button } from "./ui/button";
import "./mobile-data.css";

interface Props {
  records: LedgerRecord[];
  total: number;
  pageIndex: number;
  onPage: (page: number) => void;
  sorting: { id: string; desc: boolean };
  onSorting: (sorting: { id: string; desc: boolean }) => void;
  accounts: LedgerAccount[];
  onSelect: (row: LedgerRecord) => void;
  search: string;
  onSearch: (value: string) => void;
  usdBasis: UsdBasis;
  compactView?: boolean;
}

const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

const ledgerSortOptions = [
  { value: "occurredAt", label: "时间" },
  { value: "model", label: "模型" },
  { value: "accountId", label: "账户" },
  { value: "input", label: "输入 Tokens" },
  { value: "cacheRead", label: "缓存读取" },
  { value: "output", label: "输出 Tokens" },
  { value: "usd", label: "USD 估值" },
] as const;

/** 输入展示包含三个输入桶；缺少任一桶时保留未知，不用部分值冒充总输入。 */
function requestInputTokens(record: LedgerRecord) {
  const values = [record.input, record.cacheRead, record.cacheWrite];
  return values.every(isKnownNumber)
    ? values.reduce((total, value) => total + value, 0)
    : null;
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
  onPage,
  sorting,
  onSorting,
  accounts,
  onSelect,
  search,
  onSearch,
  usdBasis,
  compactView = false,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const pageSize = compactView ? 5 : 12;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  // 刷新后的总量可能缩小；页码回到有效范围后重新读取对应记录。
  useEffect(() => {
    if (!compactView && currentPage !== pageIndex) onPage(currentPage);
  }, [compactView, currentPage, onPage, pageIndex]);
  const columns: ColumnDef<typeof features, LedgerRecord>[] = [
    {
      accessorKey: "occurredAt",
      header: "时间",
      cell: (info) => (
        <div className="time-cell">
          <span>
            {localTime(info.getValue<string>(), {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </span>
          {info.row.original.sourceId && (
            <small>{info.row.original.sourceId}</small>
          )}
        </div>
      ),
    },
    {
      accessorKey: "model",
      header: "模型",
      cell: (info) => (
        <span className="model-label">
          <i style={{ background: modelColor(info.getValue<string>()) }} />
          {modelLabel(info.getValue<string>())}
        </span>
      ),
    },
    {
      id: "reasoningEffort",
      header: "推理强度",
      // 有效强度优先；上游未记录有效值时保留请求值，不推断默认档位。
      accessorFn: (row) =>
        row.details?.reasoningEffort ??
        row.details?.requestedReasoningEffort ??
        null,
      cell: (info) => info.getValue<string | null>() ?? "N/A",
      enableSorting: false,
    },
    {
      accessorKey: "accountId",
      header: "账户",
      cell: (info) =>
        accounts.find((a) => a.id === info.getValue())?.name ??
        info.getValue<string>(),
    },
    {
      id: "input",
      accessorFn: requestInputTokens,
      header: "输入 tokens",
      cell: (info) => compact(info.getValue<number | null>()),
    },
    {
      accessorKey: "cacheRead",
      header: "缓存读取",
      cell: (info) => (
        <span className="cache-text">
          {compact(info.getValue<number | null>())}
        </span>
      ),
    },
    {
      accessorKey: "output",
      header: "输出 tokens",
      cell: (info) => compact(info.getValue<number | null>()),
    },
    {
      id: "usd",
      accessorFn: (row) => numericAmount(row.usd),
      header: `USD 估值 · ${usdBasis === "subscription" ? "订阅等价" : "标准 API"}`,
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
      pagination: { pageIndex: 0, pageSize: compactView ? 5 : 12 },
    },
  });
  return (
    <section className="ledger-section request-section">
      <div className="section-heading">
        <div>
          <h2>{compactView ? "最近请求" : "请求明细"}</h2>
          <span className="muted">{total.toLocaleString()} 条记录</span>
        </div>
        <div className="mobile-data-controls mobile-request-controls">
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
      <div
        className="table-scroll request-table-scroll"
        role="region"
        aria-label="请求明细表格"
        tabIndex={0}
      >
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : undefined
                    }
                    className={
                      ["input", "output", "cacheRead", "usd"].includes(
                        header.id,
                      )
                        ? "numeric"
                        : ""
                    }
                  >
                    {header.column.getCanSort() ? (
                      <button onClick={header.column.getToggleSortingHandler()}>
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
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={
                      ["input", "output", "cacheRead", "usd"].includes(
                        cell.column.id,
                      )
                        ? "numeric"
                        : ""
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
                  <span>{modelLabel(record.model)}</span>
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
                <span className="mobile-request-account">
                  <span>账户</span>
                  <span>{account || "N/A"}</span>
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
          <Button
            variant="outline"
            onClick={() => onSearch("")}
            disabled={!search}
          >
            清除搜索
          </Button>
        </div>
      )}
      {!compactView && total > 0 && (
        <div className="pagination">
          <span className="ledger-page-summary mobile-only">
            第 {currentPage + 1} / {pageCount} 页
          </span>
          <span className="ledger-page-total desktop-only">
            每页 {pageSize} 条，共 {total.toLocaleString()} 条记录
          </span>
          <div>
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
