import { useEffect, useState } from "react";
import { z } from "zod";

/** 偏好只接受当前合同；旧格式、损坏数据和存储异常均回到默认值。 */
export function readStoredPreference<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  storage?: Pick<Storage, "getItem">,
): T {
  try {
    const raw = (storage ?? localStorage).getItem(key);
    const result = schema.safeParse(raw ? JSON.parse(raw) : null);
    if (result.success) return result.data;
  } catch {
    /* 存储不可用不影响当前会话。 */
  }
  return fallback;
}

/** 显式构造持久字段后写入，不将调用者的临时字段混入存储。 */
export function writeStoredPreference<T>(
  key: string,
  schema: z.ZodType<T>,
  value: T,
  storage?: Pick<Storage, "setItem">,
): void {
  const result = schema.safeParse(value);
  if (!result.success) return;
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(result.data));
  } catch {
    /* 当前选择仍然有效。 */
  }
}

export function readPreference<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  return readStoredPreference(`meterleaf-pref-${key}`, schema, fallback);
}

/** 仅由明确声明的界面偏好调用，不能持久化搜索、弹窗或任务运行状态。 */
export function usePreference<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
) {
  const [value, setValue] = useState<T>(() =>
    readPreference(key, schema, fallback),
  );
  useEffect(() => {
    writeStoredPreference(`meterleaf-pref-${key}`, schema, value);
  }, [key, schema, value]);
  return [value, setValue] as const;
}

/** 视图选项按范围隔离，切页不把旧值写入新范围；搜索不使用此持久化入口。 */
export function useScopedPreference<T>(
  scope: string,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
) {
  const [values, setValues] = useState<Record<string, T>>({});
  const scopedKey = `${scope}-${key}`;
  const value =
    values[scopedKey] ?? readPreference(scopedKey, schema, fallback);
  const update = (next: T | ((current: T) => T)) => {
    const resolved =
      typeof next === "function" ? (next as (current: T) => T)(value) : next;
    writeStoredPreference(`meterleaf-pref-${scopedKey}`, schema, resolved);
    setValues((current) => ({ ...current, [scopedKey]: resolved }));
  };
  return [value, update] as const;
}

export const preferenceSchemas = {
  /** 账本首条记录时间，用于首屏立即换算历史至今，响应返回后按最新值校正。 */
  ledgerStart: z.string().min(10).max(40).nullable(),
  mobileLayout: z.enum(["sidebar", "app"]),
  accountOrder: z.array(z.string().min(1).max(512)).max(10000),
  accountArchiveView: z.enum(["active", "archived", "all"]),
  accountFilter: z.string().min(1).max(512),
  page: z.enum([
    "overview",
    "accounts",
    "reports",
    "ledger",
    "period",
    "settings",
  ]),
  unit: z.enum(["usd", "credits", "tokens"]),
  distributionUnit: z.enum(["usd", "tokens"]),
  distributionSort: z.object({
    id: z.enum(["model", "requests", "tokens", "usd", "share"]),
    desc: z.boolean(),
  }),
  granularity: z.enum(["hour", "day", "week"]),
  dimension: z.enum(["hour", "day", "week", "model", "account"]),
  chart: z.enum(["bar", "line", "area", "pie"]),
  recordSort: z.object({
    id: z.enum([
      "occurredAt",
      "model",
      "accountId",
      "input",
      "cacheRead",
      "output",
      "usd",
    ]),
    desc: z.boolean(),
  }),
  reportSort: z
    .array(
      z.object({
        id: z.enum([
          "key",
          "tokens",
          "input",
          "cacheRead",
          "cacheWrite",
          "output",
          "cacheRate",
          "requests",
          "usd",
          "credits",
        ]),
        desc: z.boolean(),
      }),
    )
    .max(1),
};
