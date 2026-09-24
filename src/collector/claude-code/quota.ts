import { createHash } from "node:crypto";
import type { IngestQuota } from "../../shared/ingest";
import type { CachedUtilization } from "./account";

/** Claude Code 缓存的官方额度接口结果中，当前只采集会话窗口与周窗口。 */
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
    const percent =
      typeof entry.utilization === "number" &&
      Number.isFinite(entry.utilization) &&
      entry.utilization >= 0
        ? entry.utilization
        : null;
    quotas.push({
      accountExternalId: cached.accountUuid,
      window,
      percent,
      sampledAt,
      resetsAt: isoOrNull(entry.resets_at),
      windowMinutes: minutes,
    });
  }
  if (quotas.length === 0) return null;
  const hash = createHash("sha256")
    .update(JSON.stringify([cached.fetchedAtMs, quotas]))
    .digest("hex");
  return { hash, quotas };
}
