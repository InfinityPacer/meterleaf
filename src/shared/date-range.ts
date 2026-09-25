import { z } from "zod";

const DAY_MS = 86_400_000;

export type DateRange = { from: string; to: string };

const dateSchema = z.iso
  .date()
  .refine((value) => Number(value.slice(0, 4)) >= 1, "year must be >= 0001");

/** 自定义范围只接受真实公历日期，并拒绝额外字段以保持查询合同稳定。 */
export const dateRangeSchema = z
  .object({ from: dateSchema, to: dateSchema })
  .strict()
  .refine((range) => range.from <= range.to, {
    path: ["to"],
    message: "to must be on or after from",
  });

function shanghaiMidnight(date: string) {
  const time = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(time)) throw new RangeError("date is not representable");
  return time;
}

function asOfTime(asOf: string) {
  const time = Date.parse(asOf);
  if (!Number.isFinite(time)) throw new RangeError("asOf must be a valid date");
  return time;
}

/** 返回报表和对比报表的时间边界；上海自然日使用左闭右开，预设保留历史半开区间。 */
export function reportBounds(
  filter: { days: number; dateRange?: DateRange },
  asOf: string,
  previous = false,
): { start: number; end: number; endInclusive: boolean } {
  if (filter.dateRange) {
    const range = dateRangeSchema.parse(filter.dateRange);
    const currentStart = shanghaiMidnight(range.from);
    const currentEnd = shanghaiMidnight(range.to) + DAY_MS;
    const length = currentEnd - currentStart;
    return previous
      ? {
          start: currentStart - length,
          end: currentStart,
          endInclusive: false,
        }
      : { start: currentStart, end: currentEnd, endInclusive: false };
  }

  if (!Number.isFinite(filter.days) || filter.days <= 0)
    throw new RangeError("days must be positive");
  const currentEnd = asOfTime(asOf);
  const length = filter.days * DAY_MS;
  const currentStart = currentEnd - length;
  return previous
    ? {
        start: currentStart - length,
        end: currentStart,
        endInclusive: true,
      }
    : { start: currentStart, end: currentEnd, endInclusive: true };
}

/** 上海自然日；账本首条记录与采样时刻都按这个时区折成日期。 */
export function shanghaiDate(timestamp: string) {
  return new Date(asOfTime(timestamp) + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * 「历史至今」只是客户端的范围写法：服务端仍收到普通自然日范围，
 * 从账本首条记录所在日到采样当日，因此不会与其它自定义范围混淆缓存。
 */
export function allTimeRange(firstAt: string, asOf: string): DateRange {
  const from = shanghaiDate(firstAt);
  const to = shanghaiDate(asOf);
  return { from: from <= to ? from : to, to };
}
