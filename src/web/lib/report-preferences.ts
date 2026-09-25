import { z } from "zod";
import { useState } from "react";
import { dateRangeSchema } from "../../shared/date-range";
import type { ReportFilter } from "../../shared/report";
import { readStoredPreference, writeStoredPreference } from "./preferences";

type Selection = Pick<
  ReportFilter,
  "days" | "dateRange" | "all" | "model" | "account"
>;
const key = "meterleaf-report-filter";
const schema = z
  .object({
    days: z.union([z.literal(1), z.literal(7), z.literal(14), z.literal(30)]),
    dateRange: dateRangeSchema.optional(),
    all: z.literal(true).optional(),
    model: z.string().min(1).max(512),
    account: z.string().min(1).max(512),
  })
  .strict()
  .refine((value) => value.days !== 14 || !!value.dateRange)
  .refine((value) => !value.all || !value.dateRange);

/**
 * 按视图恢复日期、模型和账户；搜索关键词不持久化。
 * 首页（home）第一眼看历史至今，与旧「时间段用量」保存的范围分开存放。
 */
export function readReportPreference(
  storage?: Pick<Storage, "getItem">,
  scope?: string,
): Selection {
  return readStoredPreference(
    scope ? `${key}-${scope}` : key,
    schema,
    scope === "home"
      ? { days: 30, all: true, model: "all", account: "all" }
      : { days: scope === "overview" ? 1 : 7, model: "all", account: "all" },
    storage,
  );
}

/** 日期组件仅提交有效范围；存储失败不回滚已生效的页面选择。 */
export function saveReportPreference(
  selection: Selection,
  storage?: Pick<Storage, "setItem">,
  scope?: string,
): void {
  writeStoredPreference<Selection>(
    scope ? `${key}-${scope}` : key,
    schema,
    {
      days: selection.days,
      dateRange: selection.dateRange,
      ...(selection.all ? { all: true as const } : {}),
      model: selection.model,
      account: selection.account,
    },
    storage,
  );
}

/** 每个视图保存独立筛选；跨页钻取显式指定目标，不修改来源页。 */
export function useReportFilters(scope: string) {
  const [filters, setFilters] = useState<Record<string, ReportFilter>>({});
  const read = (target: string): ReportFilter =>
    filters[target] ?? {
      ...readReportPreference(undefined, target),
      search: "",
    };
  const update = (
    value: ReportFilter | ((current: ReportFilter) => ReportFilter),
    target = scope,
  ) => {
    const next = typeof value === "function" ? value(read(target)) : value;
    saveReportPreference(next, undefined, target);
    setFilters((current) => ({ ...current, [target]: next }));
  };
  return [read(scope), update] as const;
}
