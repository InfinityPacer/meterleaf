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
import type { LedgerAccount } from "../../shared/report";
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
  { value: "cacheRate", label: "缓存命中率" },
  { value: "requests", label: "请求数" },
  { value: "usd", label: "费用" },
  { value: "credits", label: "Credits" },
] as const;
const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});
type Row = ReturnType<typeof aggregateReport>[number];

/** 命中率 = 缓存读取 ÷ 输入侧三个桶，均按分组内已知值求和；任一桶未知时不给比例。 */
export function cacheHitRate(
  row: Pick<Row, "input" | "cacheRead" | "cacheWrite">,
) {
  if (row.input === null || row.cacheRead === null || row.cacheWrite === null)
    return null;
  const total = row.input + row.cacheRead + row.cacheWrite;
  return total > 0 ? (row.cacheRead / total) * 100 : null;
}

function percent(value: number | null) {
  return value === null ? "N/A" : `${value.toFixed(1)}%`;
}

/** 合计沿用各列的未知语义：整列都未知才显示 N/A，金额保留已知部分。 */
function totalRow(data: Row[]) {
  const sum = (values: (number | null)[]) =>
    values.some((value) => value !== null)
      ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
      : null;
  return {
    tokens: sum(data.map((row) => row.tokens)),
    input: sum(data.map((row) => row.input)),
    cacheRead: sum(data.map((row) => row.cacheRead)),
    cacheWrite: sum(data.map((row) => row.cacheWrite)),
    output: sum(data.map((row) => row.output)),
    requests: data.reduce((total, row) => total + row.requests, 0),
    usd: sum(data.map((row) => numericAmount(row.usd))),
    credits: sum(data.map((row) => numericAmount(row.credits))),
  };
}

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
}: {
  data: Row[];
  count: number;
  accounts: LedgerAccount[];
  dimension: ReportDimension;
  onDimension: (dimension: ReportDimension) => void;
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
      cell: (info) => compact(info.getValue<number | null>()),
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
      id: "cacheRate",
      accessorFn: (row) => cacheHitRate(row),
      header: "缓存命中率",
      cell: (info) => percent(info.getValue<number | null>()),
    },
    {
      accessorKey: "requests",
      header: "请求数",
      cell: (info) => info.getValue<number>().toLocaleString(),
    },
    {
      id: "usd",
      accessorFn: (row) => numericAmount(row.usd),
      header: "费用",
      cell: (info) => (
        <strong>{amount(info.getValue<number | null>(), "usd")}</strong>
      ),
    },
    {
      id: "credits",
      accessorFn: (row) => numericAmount(row.credits),
      header: "Credits",
      cell: (info) => amount(info.getValue<number | null>(), "credits"),
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
  const mobileReportHeaders = [
    { id: "key", label },
    { id: "requests", label: "请求数" },
    { id: "tokens", label: "Tokens" },
    { id: "usd", label: "费用" },
  ] as const;
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
              <ActionMenu.Positioner
                className="data-menu-positioner"
                sideOffset={6}
                align="end"
              >
                <ActionMenu.Popup className="data-menu">
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
          {data.length > 1 && (
            <tfoot>
              <tr>
                {(() => {
                  const totals = totalRow(data);
                  const cells: Record<string, string | null> = {
                    key: "合计",
                    tokens: compact(totals.tokens),
                    input: compact(totals.input),
                    cacheRead: compact(totals.cacheRead),
                    cacheWrite: compact(totals.cacheWrite),
                    output: compact(totals.output),
                    cacheRate: percent(cacheHitRate(totals)),
                    requests: totals.requests.toLocaleString(),
                    usd: amount(totals.usd, "usd"),
                    credits: amount(totals.credits, "credits"),
                  };
                  return table.getAllLeafColumns().map((column) =>
                    column.id === "key" ? (
                      <th key={column.id} scope="row">
                        {cells.key}
                      </th>
                    ) : (
                      <td key={column.id} className="numeric">
                        {cells[column.id]}
                      </td>
                    ),
                  );
                })()}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div
        className="mobile-report-list"
        role="region"
        aria-label="汇总列表"
        tabIndex={0}
      >
        <div className="mobile-report-columns">
          {mobileReportHeaders.map((header) => {
            const column = table.getColumn(header.id);
            if (!column) return null;
            const direction = column.getIsSorted();
            const directionLabel =
              direction === "asc"
                ? "升序"
                : direction === "desc"
                  ? "降序"
                  : "未排序";
            return (
              <button
                key={header.id}
                type="button"
                data-sort-direction={direction || "none"}
                aria-label={`按${header.label}排序，当前${directionLabel}`}
                onClick={column.getToggleSortingHandler()}
              >
                <span>{header.label}</span>
                {direction === "asc" ? (
                  <ArrowUp size={12} aria-hidden="true" />
                ) : direction === "desc" ? (
                  <ArrowDown size={12} aria-hidden="true" />
                ) : (
                  <ArrowUpDown size={12} aria-hidden="true" />
                )}
              </button>
            );
          })}
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
                  {compact(item.tokens)}
                </span>
                <span className="mobile-report-usd">
                  <span className="sr-only">费用 </span>
                  <strong>{amount(numericAmount(item.usd), "usd")}</strong>
                </span>
              </summary>
              <dl className="mobile-report-details">
                <div>
                  <dt>分组</dt>
                  <dd>{keyLabel}</dd>
                </div>
                <div>
                  <dt>总 Tokens</dt>
                  <dd>{compact(item.tokens)}</dd>
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
                  <dt>缓存命中率</dt>
                  <dd>{percent(cacheHitRate(item))}</dd>
                </div>
                <div>
                  <dt>请求数</dt>
                  <dd>{item.requests.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>费用</dt>
                  <dd>
                    <strong>{amount(numericAmount(item.usd), "usd")}</strong>
                  </dd>
                </div>
                <div>
                  <dt>Credits</dt>
                  <dd>{amount(numericAmount(item.credits), "credits")}</dd>
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
