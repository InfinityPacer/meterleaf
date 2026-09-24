import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import type { IngestQuota } from "../../shared/ingest";
import type { QuotaSnapshot } from "./quota";

/**
 * 可选额度来源：用户的状态栏脚本把 Claude Code 每轮传给状态栏的 rate_limits
 * 写成 TSV（窗口名、已用百分比、重置时间的 Unix 秒）。它比 ~/.claude.json 的缓存新，
 * 但属于用户自己的脚本：文件不带账户，也不带采样时间，采样时间只能取文件修改时间。
 */
export interface StatuslineCache {
  sampledAt: string;
  entries: {
    window: IngestQuota["window"];
    percent: number;
    resetsAt: string;
  }[];
}

const windows = {
  five_hour: { window: "five-hour", minutes: 300 },
  seven_day: { window: "seven-day", minutes: 10080 },
} as const;

/** 只读打开一次；任一行格式不符就放弃本轮，避免读到写了一半的文件。 */
export function readStatuslineCache(path: string): StatuslineCache | null {
  let raw: string;
  let mtimeMs: number;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    mtimeMs = stat.mtimeMs;
    raw = readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  // 脚本可能追加同一窗口的新值，以最后一行为准。
  const entries = new Map<string, StatuslineCache["entries"][number]>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const [name, used, reset, extra] = line.split("\t");
    if (extra !== undefined || !name || !Object.hasOwn(windows, name))
      return null;
    if (!/^\d+(\.\d+)?$/.test(used ?? "") || !/^\d{9,11}$/.test(reset ?? ""))
      return null;
    const percent = Number(used);
    if (percent > 1000) return null;
    const window = windows[name as keyof typeof windows].window;
    entries.set(window, {
      window,
      percent,
      resetsAt: new Date(Number(reset) * 1000).toISOString(),
    });
  }
  if (entries.size === 0) return null;
  return {
    sampledAt: new Date(mtimeMs).toISOString(),
    entries: [...entries.values()],
  };
}

/** 账户由调用方按采样时刻的登录区间确定；无法确定账户时不应调用。 */
export function statuslineQuotaSnapshot(
  cache: StatuslineCache,
  accountExternalId: string,
): QuotaSnapshot {
  const quotas: IngestQuota[] = cache.entries.map((entry) => ({
    accountExternalId,
    window: entry.window,
    percent: entry.percent,
    sampledAt: cache.sampledAt,
    resetsAt: entry.resetsAt,
    windowMinutes:
      entry.window === "five-hour"
        ? windows.five_hour.minutes
        : windows.seven_day.minutes,
  }));
  const hash = createHash("sha256")
    .update(JSON.stringify(["statusline", quotas]))
    .digest("hex");
  return { hash, quotas };
}
