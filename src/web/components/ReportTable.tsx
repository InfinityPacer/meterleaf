import { useEffect } from "react";
import { Menu as ActionMenu } from "@base-ui/react/menu";
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
  Check,
  SlidersHorizontal,
} from "lucide-react";
import type { LedgerAccount, UsdBasis } from "../../shared/report";
import {
  aggregateReport,
  amount,
  compact,
  localTime,
  modelLabel,
  modelColor,
  numericAmount,
  type ReportDimension,
} from "../lib/report";
import { Button } from "./ui/button";
import "./mobile-data.css";

const dimensions = [
  { value: "hour", label: "小时" },
  { value: "day", label: "天" },
  { value: "week", label: "自然周" },
  { value: "model", label: "模型" },
  { value: "account", label: "账户" },
] as const;
const reportSortOptions = [
  { value: "key", label: "分组" },
  { value: "tokens", label: "总 Tokens" },
  { value: "input", label: "输入" },
  { value: "cacheRead", label: "缓存读取" },
  { value: "cacheWrite", label: "缓存写入" },
  { value: "output", label: "输出" },
  { value: "requests", label: "请求数" },
  { value: "usd", label: "USD 估值" },
  { value: "credits", label: "Credits 估值" },
] as const;
const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});
type Row = ReturnType<typeof aggregateReport>[number];

function reportRowLabel(
  key: string,
  dimension: ReportDimension,
  accounts: LedgerAccount[],
) {
  if (dimension === "model") return modelLabel(key);
  if (dimension === "account")
    return accounts.find((account) => account.id === key)?.name ?? key;
  return localTime(key, {
    year: "numeric",
    ...(dimension === "hour"
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
  });
}

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
  const [sorting, setSorting] = usePreference<SortingState>(
    "report-sort",
    preferenceSchemas.reportSort,
    [{ id: "key", desc: false }],
  );
  const label = dimensions.find((item) => item.value === dimension)!.label;
  const columns: ColumnDef<typeof features, Row>[] = [
    {
      accessorKey: "key",
      header: label,
      cell: (info) =>
        reportRowLabel(info.getValue<string>(), dimension, accounts),
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
  const activeSorting = sorting[0] ?? { id: "key", desc: false };
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
        <div className="mobile-data-controls mobile-report-controls">
          <ActionMenu.Root>
            <ActionMenu.Trigger
              className="mobile-data-tool"
              aria-label="汇总选项"
              title="汇总选项"
            >
              <SlidersHorizontal size={18} />
            </ActionMenu.Trigger>
            <ActionMenu.Portal>
              <ActionMenu.Positioner sideOffset={6} align="end">
                <ActionMenu.Popup className="mobile-data-menu">
                  <ActionMenu.Group>
                    <ActionMenu.GroupLabel>汇总维度</ActionMenu.GroupLabel>
                    {dimensions.map((item) => (
                      <ActionMenu.Item
                        key={item.value}
                        onClick={() => onDimension(item.value)}
                      >
                        {item.label}
                        {dimension === item.value && (
                          <Check size={15} aria-hidden="true" />
                        )}
                      </ActionMenu.Item>
                    ))}
                  </ActionMenu.Group>
                  <ActionMenu.Separator />
                  <ActionMenu.Group>
                    <ActionMenu.GroupLabel>排序字段</ActionMenu.GroupLabel>
                    {reportSortOptions.map((option) => (
                      <ActionMenu.Item
                        key={option.value}
                        onClick={() =>
                          setSorting([
                            { id: option.value, desc: activeSorting.desc },
                          ])
                        }
                      >
                        {option.label}
                        {activeSorting.id === option.value && (
                          <Check size={15} aria-hidden="true" />
                        )}
                      </ActionMenu.Item>
                    ))}
                  </ActionMenu.Group>
                  <ActionMenu.Separator />
                  <ActionMenu.Item
                    onClick={() =>
                      setSorting([
                        { ...activeSorting, desc: !activeSorting.desc },
                      ])
                    }
                  >
                    切换为{activeSorting.desc ? "升序" : "降序"}
                    {activeSorting.desc ? (
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
        className="table-scroll report-table-scroll"
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
      <div
        className="mobile-report-list"
        role="region"
        aria-label="汇总列表"
        tabIndex={0}
      >
        <div className="mobile-report-columns" aria-hidden="true">
          <span>{label}</span>
          <span>请求数</span>
          <span>Tokens</span>
          <span>USD 估值</span>
        </div>
        {table.getRowModel().rows.map((row) => {
          const item = row.original;
          const keyLabel = reportRowLabel(item.key, dimension, accounts);
          return (
            <details key={item.key} className="mobile-report-item">
              <summary>
                <span className="mobile-report-key">
                  {dimension === "model" && (
                    <i
                      style={{ background: modelColor(item.key) }}
                      aria-hidden="true"
                    />
                  )}
                  <span>{keyLabel}</span>
                </span>
                <span>
                  <span className="sr-only">请求数 </span>
                  {item.requests.toLocaleString()}
                </span>
                <span>
                  <span className="sr-only">Tokens </span>
                  {item.tokens === null ? "无已知值" : compact(item.tokens)}
                  {item.incompleteTokens > 0 && (
                    <small className="table-note">不完整</small>
                  )}
                </span>
                <span className="mobile-report-usd">
                  <span className="sr-only">USD 估值 </span>
                  <strong>{amount(numericAmount(item.usd), "usd")}</strong>
                  {item.unpricedUsd > 0 && (
                    <small className="table-note">已计价小计</small>
                  )}
                </span>
              </summary>
              <dl className="mobile-report-details">
                <div>
                  <dt>分组</dt>
                  <dd>{keyLabel}</dd>
                </div>
                <div>
                  <dt>总 Tokens</dt>
                  <dd>
                    {item.tokens === null ? "无已知值" : compact(item.tokens)}
                    {item.incompleteTokens > 0 && (
                      <small className="table-note">
                        {item.incompleteTokens} 条不完整
                      </small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>输入</dt>
                  <dd>{compact(item.input)}</dd>
                </div>
                <div>
                  <dt>缓存读取</dt>
                  <dd className="cache-text">{compact(item.cacheRead)}</dd>
                </div>
                <div>
                  <dt>缓存写入</dt>
                  <dd>{compact(item.cacheWrite)}</dd>
                </div>
                <div>
                  <dt>输出</dt>
                  <dd>{compact(item.output)}</dd>
                </div>
                <div>
                  <dt>请求数</dt>
                  <dd>{item.requests.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>
                    USD 估值 ·{" "}
                    {usdBasis === "subscription" ? "订阅等价" : "标准 API"}
                  </dt>
                  <dd>
                    <strong>{amount(numericAmount(item.usd), "usd")}</strong>
                    {item.unpricedUsd > 0 && (
                      <small className="table-note">已计价小计</small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Credits 估值</dt>
                  <dd>
                    {amount(numericAmount(item.credits), "credits")}
                    {item.unpricedCredits > 0 && (
                      <small className="table-note">已计价小计</small>
                    )}
                  </dd>
                </div>
              </dl>
            </details>
          );
        })}
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
