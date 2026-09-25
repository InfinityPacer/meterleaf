import { createHash } from "node:crypto";
import type { IngestQuota } from "../../shared/ingest";
import type { CachedUtilization } from "./account";

/** Claude Code 缓存的官方额度接口结果中，采集会话窗口、周窗口和 Fable 独立周额度。 */
const windows = [
  { bucket: "five_hour", window: "five-hour", minutes: 300 },
  { bucket: "seven_day", window: "seven-day", minutes: 10080 },
] as const;

export interface QuotaSnapshot {
  /** 快照内容摘要；同一次上游采样重复读取时不再上报。 */
  hash: string;
  quotas: IngestQuota[];
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nonNegativePercent(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Fable 周额度只出现在 limits 列表：kind 为 weekly_scoped，scope.model 的显示名为 Fable，
 * 模型 ID 为空。固定键名的旧额度字段只有代号，不能据代号猜测对应模型。
 * 限定到某个使用入口（surface）的条目不代表账户级额度，不采集。
 */
function fableWeeklyLimit(limits: unknown) {
  if (!Array.isArray(limits)) return null;
  for (const item of limits) {
    const entry = record(item);
    const scope = record(entry?.scope);
    const model = record(scope?.model);
    if (
      entry?.kind === "weekly_scoped" &&
      scope?.surface == null &&
      typeof model?.display_name === "string" &&
      model.display_name.trim().toLowerCase() === "fable"
    )
      return entry;
  }
  return null;
}

export function quotaSnapshot(cached: CachedUtilization): QuotaSnapshot | null {
  if (!cached.accountUuid) return null;
  const sampledAt = new Date(cached.fetchedAtMs).toISOString();
  const quotas: IngestQuota[] = [];
  for (const { bucket, window, minutes } of windows) {
    const value = cached.utilization[bucket];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    quotas.push({
      accountExternalId: cached.accountUuid,
      window,
      percent: nonNegativePercent(entry.utilization),
      sampledAt,
      resetsAt: isoOrNull(entry.resets_at),
      windowMinutes: minutes,
    });
  }
  const fable = fableWeeklyLimit(cached.utilization.limits);
  if (fable)
    quotas.push({
      accountExternalId: cached.accountUuid,
      window: "seven-day-fable",
      percent: nonNegativePercent(fable.percent),
      sampledAt,
      resetsAt: isoOrNull(fable.resets_at),
      windowMinutes: 10080,
    });
  if (quotas.length === 0) return null;
  const hash = createHash("sha256")
    .update(JSON.stringify([cached.fetchedAtMs, quotas]))
    .digest("hex");
  return { hash, quotas };
}
