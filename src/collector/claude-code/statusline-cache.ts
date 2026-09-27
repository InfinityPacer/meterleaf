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
  /** 被忽略的非空行数：格式不符或窗口名不认识。 */
  ignoredLines: number;
}

const windows = {
  five_hour: { window: "five-hour", minutes: 300 },
  seven_day: { window: "seven-day", minutes: 10080 },
} as const;

/**
 * 只读打开一次，逐行校验。格式不符或窗口名不认识的行单独忽略并计数，其余行照常使用：
 * 状态栏脚本按窗口名替换各自的行，一行写坏后会一直留在文件里，整份放弃会让额度永久停更。
 * 没有任何有效行时返回 null。
 */
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
  let ignoredLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const [name, used, reset, extra] = line.split("\t");
    const percent = Number(used);
    if (
      extra !== undefined ||
      !name ||
      !Object.hasOwn(windows, name) ||
      !/^\d+(\.\d+)?$/.test(used ?? "") ||
      !/^\d{9,11}$/.test(reset ?? "") ||
      percent > 1000
    ) {
      ignoredLines += 1;
      continue;
    }
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
    ignoredLines,
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
