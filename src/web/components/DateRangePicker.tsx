import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ArrowRight, CalendarDays, ChevronDown, X } from "lucide-react";
import { dateRangeSchema, type DateRange } from "../../shared/date-range";
import type { ReportFilter } from "../../shared/report";
import { Button } from "./ui/button";

type Selection = Pick<ReportFilter, "days" | "dateRange" | "all">;
type Preset = {
  id: string;
  label: string;
  days: number;
  dateRange: DateRange | undefined;
  all?: true;
};

/** 自然日快捷范围固定使用报表时区，不随浏览器所在地变化；滚动范围保留小时精度。 */
export function datePresets(asOf: string): Preset[] {
  const clock = new Date(Date.parse(asOf) + 8 * 3600_000);
  const date = (dayOffset: number) => {
    const shifted = new Date(clock);
    shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
    return shifted.toISOString().slice(0, 10);
  };
  const today = date(0);
  const month = new Date(clock);
  month.setUTCDate(1);
  const thisMonth = month.toISOString().slice(0, 10);
  month.setUTCDate(0);
  const lastMonthEnd = month.toISOString().slice(0, 10);
  month.setUTCDate(1);
  const lastMonthStart = month.toISOString().slice(0, 10);
  return [
    { id: "all", label: "历史至今", days: 30, dateRange: undefined, all: true },
    {
      id: "today",
      label: "今天",
      days: 1,
      dateRange: { from: today, to: today },
    },
    {
      id: "yesterday",
      label: "昨天",
      days: 1,
      dateRange: { from: date(-1), to: date(-1) },
    },
    { id: "1", label: "近 24 小时", days: 1, dateRange: undefined },
    { id: "7", label: "近 7 天", days: 7, dateRange: undefined },
    {
      id: "14",
      label: "近 14 天",
      days: 14,
      dateRange: { from: date(-13), to: today },
    },
    { id: "30", label: "近 30 天", days: 30, dateRange: undefined },
    {
      id: "month",
      label: "本月",
      days: 1,
      dateRange: { from: thisMonth, to: today },
    },
    {
      id: "last-month",
      label: "上月",
      days: 1,
      dateRange: { from: lastMonthStart, to: lastMonthEnd },
    },
  ];
}

/** 日期仅在完整且有序时立即提交；输入中间态不能清空当前有效报表。 */
export function DateRangePicker({
  value,
  asOf,
  allRange,
  onChange,
}: {
  value: Selection;
  asOf: string;
  /** 历史至今换算出的实际日期，仅用于预填自定义起止。 */
  allRange?: DateRange;
  onChange: (selection: Selection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>({ from: "", to: "" });
  const [presetId, setPresetId] = useState<string | null>(null);
  const presets = datePresets(asOf);
  const selected = presets.find((preset) =>
    value.all
      ? preset.all
      : preset.all
        ? false
        : value.dateRange
          ? preset.dateRange?.from === value.dateRange.from &&
            preset.dateRange.to === value.dateRange.to
          : !preset.dateRange && preset.days === value.days,
  );
  const title =
    selected?.label ??
    (value.dateRange
      ? value.dateRange.from === value.dateRange.to
        ? value.dateRange.from
        : `${value.dateRange.from} ~ ${value.dateRange.to}`
      : `近 ${value.days} 天`);
  const valid = dateRangeSchema.safeParse(draft).success;
  const updateDates = (next: DateRange) => {
    setPresetId(null);
    setDraft(next);
    if (dateRangeSchema.safeParse(next).success)
      onChange({ days: value.days, dateRange: next, all: undefined });
  };
  const changeOpen = (next: boolean) => {
    if (next) {
      setPresetId(selected?.id ?? null);
      const to = new Date(Date.parse(asOf) + 8 * 3600_000)
        .toISOString()
        .slice(0, 10);
      const from = new Date(
        Date.parse(asOf) + 8 * 3600_000 - (value.days - 1) * 86400_000,
      )
        .toISOString()
        .slice(0, 10);
      setDraft(
        (value.all ? allRange : value.dateRange) ??
          value.dateRange ?? { from, to },
      );
    }
    setOpen(next);
  };
  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger
        render={
          <Button
            variant="outline"
            className="date-range-trigger"
            aria-label="日期范围"
          />
        }
      >
        <CalendarDays size={15} />
        <span>{title}</span>
        <ChevronDown size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          sideOffset={8}
          align="start"
          className="date-range-positioner"
        >
          <Popover.Popup className="date-range-popup">
            <div className="date-range-heading">
              <Popover.Title className="date-range-title">
                日期范围
              </Popover.Title>
              <Popover.Close
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="关闭日期选择"
                    title="关闭日期选择"
                  />
                }
              >
                <X size={16} />
              </Popover.Close>
            </div>
            <fieldset className="date-range-presets" aria-label="快捷范围">
              {presets.map((preset) => (
                <label key={preset.id} className="date-range-preset">
                  <input
                    type="radio"
                    name="date-range-preset"
                    checked={presetId === preset.id}
                    onChange={() => {
                      setPresetId(preset.id);
                      const to = new Date(Date.parse(asOf) + 8 * 3600_000)
                        .toISOString()
                        .slice(0, 10);
                      const from = new Date(
                        Date.parse(asOf) +
                          8 * 3600_000 -
                          (preset.days - 1) * 86400_000,
                      )
                        .toISOString()
                        .slice(0, 10);
                      setDraft(
                        (preset.all ? allRange : preset.dateRange) ?? {
                          from,
                          to,
                        },
                      );
                      onChange({
                        days: preset.days,
                        dateRange: preset.dateRange,
                        all: preset.all,
                      });
                      setOpen(false);
                    }}
                  />
                  {preset.label}
                </label>
              ))}
            </fieldset>
            <div className="date-range-fields">
              <label>
                开始日期
                <input
                  type="date"
                  aria-label="开始日期"
                  value={draft.from}
                  max={draft.to || undefined}
                  onChange={(event) =>
                    updateDates({ ...draft, from: event.target.value })
                  }
                />
              </label>
              <ArrowRight size={16} aria-hidden="true" />
              <label>
                结束日期
                <input
                  type="date"
                  aria-label="结束日期"
                  value={draft.to}
                  min={draft.from || undefined}
                  onChange={(event) =>
                    updateDates({ ...draft, to: event.target.value })
                  }
                />
              </label>
            </div>
            {!valid && (
              <p className="date-range-error" role="alert">
                请选择有效日期，结束日期不能早于开始日期。
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
