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
  const pageSize = compactView ? 5 : 12;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
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
          {info.row.original.sourceId && <small>{info.row.original.sourceId}</small>}
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
      accessorFn: (row) => row.details?.reasoningEffort ?? row.details?.requestedReasoningEffort ?? null,
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
      accessorFn: (row) => {
        const values = [row.input, row.cacheRead, row.cacheWrite];
        return values.every(isKnownNumber)
          ? values.reduce((total, value) => total + value, 0)
          : null;
      },
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
    state: { sorting: [sorting], pagination: { pageIndex, pageSize } },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater([sorting]) : updater;
      onSorting(next[0] ?? { id: "occurredAt", desc: true });
    },
    initialState: {
      pagination: { pageIndex: 0, pageSize: compactView ? 5 : 12 },
    },
  });
  return (
    <section className="ledger-section">
      <div className="section-heading">
        <div>
          <h2>{compactView ? "最近请求" : "请求明细"}</h2>
          <span className="muted">{total.toLocaleString()} 条记录</span>
        </div>
        <label className="search-control">
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
      {!compactView && records.length > 0 && (
        <div className="pagination">
          <span>
            第 {pageIndex + 1} / {pageCount} 页
          </span>
          <div>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="上一页"
              onClick={() => onPage(pageIndex - 1)}
              disabled={pageIndex === 0}
            >
              <ChevronLeft size={15} />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="下一页"
              onClick={() => onPage(pageIndex + 1)}
              disabled={pageIndex + 1 >= pageCount}
            >
              <ChevronRight size={15} />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
