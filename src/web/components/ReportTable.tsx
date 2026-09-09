import { useEffect } from "react";
import { preferenceSchemas, usePreference } from "../lib/preferences";
import {
  flexRender,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { LedgerAccount, UsdBasis } from "../../shared/report";
import {
  aggregateReport,
  amount,
  compact,
  localTime,
  modelLabel,
  numericAmount,
  type ReportDimension,
} from "../lib/report";
import { Button } from "./ui/button";

const dimensions = [
  { value: "hour", label: "小时" },
  { value: "day", label: "天" },
  { value: "week", label: "自然周" },
  { value: "model", label: "模型" },
  { value: "account", label: "账户" },
] as const;
const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});
type Row = ReturnType<typeof aggregateReport>[number];

/** 汇总表只呈现分组结果；逐次记录保留在独立的请求明细视图。 */
export function ReportTable({
  data,
  count,
  accounts,
  dimension,
  onDimension,
  usdBasis,
}: {
  data: Row[];
  count: number;
  accounts: LedgerAccount[];
  dimension: ReportDimension;
  onDimension: (dimension: ReportDimension) => void;
  usdBasis: UsdBasis;
}) {
  const [sorting, setSorting] = usePreference<SortingState>("report-sort", preferenceSchemas.reportSort, [
    { id: "key", desc: false },
  ]);
  const label = dimensions.find((item) => item.value === dimension)!.label;
  const columns: ColumnDef<typeof features, Row>[] = [
    {
      accessorKey: "key",
      header: label,
      cell: (info) => {
        const key = info.getValue<string>();
        if (dimension === "model") return modelLabel(key);
        if (dimension === "account")
          return accounts.find((account) => account.id === key)?.name ?? key;
        return localTime(key, {
          year: "numeric",
          ...(dimension === "hour"
            ? { hour: "2-digit", minute: "2-digit", hour12: false }
            : {}),
        });
      },
    },
    {
      accessorKey: "tokens",
      header: "总 Tokens",
      cell: (info) => {
        const row = info.row.original;
        return (
          <span>
            {row.tokens === null ? "无已知值" : compact(row.tokens)}
            {row.incompleteTokens > 0 && (
              <small className="table-note">
                {row.incompleteTokens} 条不完整
              </small>
            )}
          </span>
        );
      },
    },
    {
      accessorKey: "input",
      header: "输入",
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
      accessorKey: "cacheWrite",
      header: "缓存写入",
      cell: (info) => compact(info.getValue<number | null>()),
    },
    {
      accessorKey: "output",
      header: "输出",
      cell: (info) => compact(info.getValue<number | null>()),
    },
    {
      accessorKey: "requests",
      header: "请求数",
      cell: (info) => info.getValue<number>().toLocaleString(),
    },
    {
      id: "usd",
      accessorFn: (row) => numericAmount(row.usd),
      header: `USD 估值 · ${usdBasis === "subscription" ? "订阅等价" : "标准 API"}`,
      cell: (info) => {
        const row = info.row.original;
        return (
          <span>
            <strong>{amount(info.getValue<number | null>(), "usd")}</strong>
            {row.unpricedUsd > 0 && (
              <small className="table-note">已计价小计</small>
            )}
          </span>
        );
      },
    },
    {
      id: "credits",
      accessorFn: (row) => numericAmount(row.credits),
      header: "Credits 估值",
      cell: (info) => {
        const row = info.row.original;
        return (
          <span>
            {amount(info.getValue<number | null>(), "credits")}
            {row.unpricedCredits > 0 && (
              <small className="table-note">已计价小计</small>
            )}
          </span>
        );
      },
    },
  ];
  const table = useTable({
    features,
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    initialState: { pagination: { pageIndex: 0, pageSize: 12 } },
  });
  useEffect(() => {
    table.setPageIndex(0);
  }, [data]);
  return (
    <section
      className="ledger-section report-section"
      aria-label="分组统计报表"
    >
      <div className="section-heading report-heading">
        <div>
          <h2>分组汇总</h2>
          <span className="muted">{count.toLocaleString()} 次请求</span>
        </div>
        <div className="segmented" role="group" aria-label="汇总维度">
          {dimensions.map((item) => (
            <button
              key={item.value}
              aria-pressed={dimension === item.value}
              onClick={() => onDimension(item.value)}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
      {dimension === "week" && (
        <p className="muted report-period">周一起始，首尾周按所选范围统计</p>
      )}
      <div
        className="table-scroll"
        role="region"
        aria-label="汇总表格"
        tabIndex={0}
      >
        <table aria-label="汇总结果">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    className={header.id === "key" ? "" : "numeric"}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    <button onClick={header.column.getToggleSortingHandler()}>
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      {header.column.getIsSorted() === "asc" ? (
                        <ArrowUp size={12} />
                      ) : header.column.getIsSorted() === "desc" ? (
                        <ArrowDown size={12} />
                      ) : (
                        <ArrowUpDown size={12} />
                      )}
                    </button>
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
                    className={cell.column.id === "key" ? "" : "numeric"}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.length ? (
        <div className="empty-state">
          <h3>没有可汇总的用量</h3>
        </div>
      ) : (
        <div className="pagination">
          <span>
            第 {table.state.pagination.pageIndex + 1} / {table.getPageCount()}{" "}
            页
          </span>
          <div>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="上一页"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              <ChevronLeft size={15} />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="下一页"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              <ChevronRight size={15} />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
