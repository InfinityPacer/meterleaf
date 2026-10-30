import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  ingestQuotaSchema,
  ingestUsageSchema,
  type IngestQuota,
  type IngestUsage,
} from "../shared/ingest";
import {
  routeChannel,
  type ChannelAccount,
  type ChannelAccountRule,
} from "./channel-accounts";
import { emptySourceReport, type SourceReaderReport } from "./sources";
import type { CollectorState } from "./state";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");

export interface CodexContext {
  session: string;
  /** 会话声明的供应商通道，决定归属与额度；缺失时该会话跳过。 */
  provider: string | null;
  model: string;
  effort: string | null;
  total: string | null;
  discarding?: boolean;
}

export function emptyContext(): CodexContext {
  return { session: "", provider: null, model: "", effort: null, total: null };
}

function token(tokens: RecordValue, key: string): number | null {
  const value = tokens[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid_token_count");
  }
  return value;
}

export interface CodexQuotaSample {
  window: "five-hour" | "seven-day";
  percent: number | null;
  sampledAt: string;
  resetsAt: string;
  windowMinutes: number;
}

/** Quota notifications are independent of token usage, including info:null and repeated totals. */
export function codexSnapshot(raw: unknown): {
  sampledAt: string;
  plan: string | null;
  quotas: CodexQuotaSample[];
} | null {
  const event = object(raw);
  const payload = object(event?.payload);
  if (event?.type !== "event_msg" || payload?.type !== "token_count")
    return null;
  const limits = object(payload.rate_limits);
  if (!limits || (limits.limit_id != null && limits.limit_id !== "codex"))
    return null;
  if (
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp))
  )
    return null;
  const sampledAt = new Date(event.timestamp).toISOString();
  const plan =
    typeof limits.plan_type === "string" &&
    limits.plan_type !== "unknown" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(limits.plan_type)
      ? limits.plan_type
      : null;
  const quotas: CodexQuotaSample[] = [];
  for (const name of ["primary", "secondary"]) {
    const bucket = object(limits[name]);
    if (!bucket) continue;
    const reset =
      typeof bucket.resets_at === "number" &&
      Number.isSafeInteger(bucket.resets_at) &&
      bucket.resets_at > 0 &&
      bucket.resets_at < 8640000000000
        ? new Date(bucket.resets_at * 1000).toISOString()
        : null;
    const percent = bucket.used_percent;
    const minutes = bucket.window_minutes;
    // 窗口按实际时长识别：300 分钟映射 5 小时，10080 分钟映射 7 天；
    // 上游百分比是四舍五入整数，负值或越界读数不当作额度。
    const window =
      minutes === 300 ? "five-hour" : minutes === 10080 ? "seven-day" : null;
    if (
      !reset ||
      typeof minutes !== "number" ||
      !window ||
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 1000
    )
      continue;
    quotas.push({
      window,
      percent,
      sampledAt,
      resetsAt: reset,
      windowMinutes: minutes,
    });
  }
  return plan || quotas.length ? { sampledAt, plan, quotas } : null;
}

/** Only inspect session identity, provider, model context and token events, never message bodies. */
export function codexEvent(
  raw: unknown,
  context: CodexContext,
): Omit<IngestUsage, "accountExternalId"> | null {
  const event = object(raw);
  const payload = object(event?.payload);
  if (!event || !payload) return null;
  if (event.type === "session_meta") {
    if (typeof payload.id === "string") context.session = payload.id;
    if (typeof payload.model_provider === "string")
      context.provider = payload.model_provider;
    return null;
  }
  if (event.type === "turn_context") {
    context.model = typeof payload.model === "string" ? payload.model : "";
    context.effort =
      typeof payload.effort === "string" && payload.effort.length <= 32
        ? payload.effort
        : null;
    return null;
  }
  if (event.type !== "event_msg" || payload.type !== "token_count") return null;
  const info = object(payload.info);
  const last = object(info?.last_token_usage);
  if (!last) return null;
  const total = object(info?.total_token_usage);
  const fields = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ];
  // Rate-limit-only notifications repeat the cumulative counters. Do not turn them into requests.
  const signature = total
    ? JSON.stringify(fields.map((key) => token(total, key)))
    : null;
  if (signature && signature === context.total) return null;
  if (!context.session || !context.model)
    throw new Error("missing_session_or_model");
  const input = token(last, "input_tokens");
  const cached = token(last, "cached_input_tokens");
  const write = token(last, "cache_write_input_tokens");
  const output = token(last, "output_tokens");
  const reasoning = token(last, "reasoning_output_tokens");
  // Older Codex logs omit cache-write usage; keep it unknown without subtracting a guessed amount.
  const uncached =
    input !== null && cached !== null ? input - cached - (write ?? 0) : null;
  if (
    (uncached !== null && uncached < 0) ||
    (reasoning !== null && output !== null && reasoning > output)
  ) {
    throw new Error("inconsistent_token_breakdown");
  }
  if (
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp))
  ) {
    throw new Error("invalid_timestamp");
  }
  // 账户由读取器按通道归属；解析函数之外的账户字段保持同一结构与校验。
  // 签名只在完整解析成功后保存；失败或被跳过的计数不更新累计标记。
  const usage = usageSchema.parse({
    externalId:
      "codex-" +
      hash(
        JSON.stringify([
          context.session,
          event.timestamp,
          fields.map((key) => token(last, key)),
          signature,
        ]),
      ),
    occurredAt: new Date(event.timestamp).toISOString(),
    model: context.model,
    tier: null,
    tokens: {
      input: uncached,
      output,
      cacheRead: cached,
      cacheWrite: write,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning,
    },
    metadata: { origin: "codex_local", reasoning_effort: context.effort },
  });
  context.total = signature;
  return usage;
}

/** 与 ingestUsageSchema 相同的用量，但账户由通道路由决定，在入账前补上。 */
const usageSchema = ingestUsageSchema.omit({ accountExternalId: true });

export interface CodexReaderSources {
  home: string;
  start: string;
  channelAccounts: readonly ChannelAccountRule[];
}

export interface CodexReaderReport extends SourceReaderReport {
  /** 本轮读取的会话文件数与字节数（压缩文件按解压后计）。 */
  filesRead: number;
  bytes: number;
  /** 早于起点被丢弃的用量条数。 */
  beforeStart: number;
  unreadable: number;
  /** 本轮是否到达读取预算，剩余会话顺延到下一轮。 */
  deferred: boolean;
  /** 本轮随额度上传的窗口读数条数。 */
  quotas: number;
}

const chunkBytes = 1024 * 1024;
const tailBytes = 256;
const lineBudgetBytes = 16 * 1024 * 1024;
const budgetBytes = 64 * 1024 * 1024;

export function emptyCodexReport(): CodexReaderReport {
  return {
    ...emptySourceReport("codex"),
    filesRead: 0,
    bytes: 0,
    beforeStart: 0,
    unreadable: 0,
    deferred: false,
    quotas: 0,
  };
}

/** 会话内各窗口保留采样时间最晚的一份读数；额度的归属账户在拿到快照时已知。 */
interface WindowSample {
  quota: IngestQuota;
  sampledAt: string;
}

function readJsonMap(
  state: CollectorState,
  key: string,
): Record<string, string> {
  try {
    return JSON.parse(state.getMeta(key) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** 恢复读取进度需要确认上次读到的位置没有变化：按偏移前的短片段指纹判断。 */
function tailFingerprint(fd: number, offset: number): string {
  const size = Math.min(offset, tailBytes);
  const bytes = Buffer.alloc(size);
  const read = readSync(fd, bytes, 0, size, offset - size);
  return hash(bytes.subarray(0, read));
}

function restoreContext(saved: string | null): CodexContext {
  if (saved) {
    try {
      const restored = JSON.parse(saved) as CodexContext;
      if (
        typeof restored?.session === "string" &&
        restored.session !== "" &&
        typeof restored.model === "string"
      ) {
        return {
          session: restored.session,
          provider:
            typeof restored.provider === "string" ? restored.provider : null,
          model: restored.model,
          effort: typeof restored.effort === "string" ? restored.effort : null,
          total: typeof restored.total === "string" ? restored.total : null,
          discarding: restored.discarding === true,
        };
      }
    } catch {
      // 进度附带的上下文损坏时从头读起；重读靠用量键去重保证不重复入账。
    }
  }
  return emptyContext();
}

interface FileSinks {
  /** 键形如 `${账户}:${窗口}`，一个文件内只保留采样最晚的一份。 */
  windows: Map<string, WindowSample>;
  plans: Map<string, string>;
}

/** 读取一轮 Codex 本地会话记录。
 *
 * 按「来源加通道」归属账户，额度只来自路由到 openai 平台账户的会话；压缩与未压缩
 * 文件共用同一用量签名与每轮读取预算，先按修改时间新到旧处理。每个文件的用量、
 * 相关账户资料与读取进度在同一事务提交，读取中断整体回滚后从原进度重读。
 */
export async function readCodex(
  state: CollectorState,
  sources: CodexReaderSources,
  maxBytes = budgetBytes,
): Promise<CodexReaderReport> {
  const report = emptyCodexReport();
  const rules = sources.channelAccounts;
  if (!existsSync(sources.home)) return report;
  const startMs = Date.parse(sources.start);
  const startIso = new Date(startMs).toISOString();
  const paths: { path: string; modified: number }[] = [];
  for (const directory of ["sessions", "archived_sessions"]) {
    const cwd = join(sources.home, directory);
    if (!existsSync(cwd)) continue;
    for (const pattern of ["**/*.jsonl", "**/*.jsonl.zst"]) {
      for await (const file of new Bun.Glob(pattern).scan({
        cwd,
        followSymlinks: false,
      })) {
        const path = join(cwd, file);
        try {
          paths.push({ path, modified: statSync(path).mtimeMs });
        } catch {
          report.unreadable++;
        }
      }
    }
  }
  paths.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
  state.forgetMissingCodexFiles(new Set(paths.map((row) => row.path)));

  // 额度与套餐的上次观察持久保存；同一窗口只上传比此前更新的采样。
  const observed = readJsonMap(state, "codex_window_sampled");
  const plans = readJsonMap(state, "codex_plans");
  /** 跨账户、跨窗口的本轮读数；账户与窗口是键的两段。 */
  const windows = new Map<string, Map<string, WindowSample>>();
  const roundPlans = new Map<string, string>();
  const routedAccounts = new Map<string, ChannelAccount>();

  const ensureAccount = (account: ChannelAccount) => {
    state.upsertAccount({
      externalId: account.id,
      name: account.name,
      platform: account.platform,
      kind: account.kind,
      plan: roundPlans.get(account.id) ?? account.plan,
      subjectKey: null,
    });
    routedAccounts.set(account.id, account);
  };

  /**
   * 单行解析：元数据行更新会话上下文；token_count 事件先按通道归属，额度独立于
   * 用量筛选，早于起点的用量在入账前丢弃。
   */
  const handleLine = (
    line: string,
    context: CodexContext,
    sinks: FileSinks,
  ) => {
    if (!/"(?:session_meta|turn_context|token_count)"/.test(line)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      report.invalid++;
      return;
    }
    const event = object(raw);
    const payload = object(event?.payload);
    if (event?.type !== "event_msg" || payload?.type !== "token_count") {
      try {
        codexEvent(raw, context);
      } catch {
        report.invalid++;
      }
      return;
    }
    report.read++;
    const routed = routeChannel("codex", context.provider, rules);
    if (!routed) {
      const key = context.provider ?? "(缺失)";
      report.skipped[key] = (report.skipped[key] ?? 0) + 1;
      return;
    }
    if (routed.platform === "openai") {
      // 额度只取路由到 openai 平台账户的会话；套餐用观察到的 plan_type 覆盖规则值。
      const snapshot = codexSnapshot(raw);
      if (snapshot) {
        if (snapshot.plan && !sinks.plans.has(routed.id))
          sinks.plans.set(routed.id, snapshot.plan);
        for (const bucket of snapshot.quotas) {
          if (bucket.sampledAt < startIso) continue;
          const key = `${routed.id}:${bucket.window}`;
          const ahead = sinks.windows.get(key);
          if (ahead && ahead.sampledAt >= bucket.sampledAt) continue;
          const parsed = ingestQuotaSchema.safeParse({
            accountExternalId: routed.id,
            window: bucket.window,
            percent: bucket.percent,
            sampledAt: bucket.sampledAt,
            resetsAt: bucket.resetsAt,
            windowMinutes: bucket.windowMinutes,
          });
          if (parsed.success)
            sinks.windows.set(key, {
              quota: parsed.data,
              sampledAt: bucket.sampledAt,
            });
        }
      }
    }
    let usage: Omit<IngestUsage, "accountExternalId"> | null;
    try {
      usage = codexEvent(raw, context);
    } catch {
      report.invalid++;
      return;
    }
    if (!usage) return;
    if (usage.occurredAt < startIso) {
      report.beforeStart++;
      return;
    }
    ensureAccount(routed);
    if (
      state.recordSourceUsage("codex", {
        ...usage,
        accountExternalId: routed.id,
      })
    )
      report.recorded++;
  };

  /** 文件按修改时间新到旧处理：账户与窗口的首个（最新）观察优先。 */
  const adoptFile = (sinks: FileSinks) => {
    for (const [key, sample] of sinks.windows) {
      const separator = key.indexOf(":");
      const account = key.slice(0, separator);
      const window = key.slice(separator + 1);
      let byWindow = windows.get(account);
      if (!byWindow) {
        byWindow = new Map();
        windows.set(account, byWindow);
      }
      if (!byWindow.has(window)) byWindow.set(window, sample);
    }
    for (const [account, plan] of sinks.plans) {
      if (!roundPlans.has(account)) roundPlans.set(account, plan);
    }
  };

  const processFile = (path: string) => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      report.unreadable++;
      return;
    }
    if (!stats.isFile()) return;
    const saved = state.codexFile(path);
    const inode = String(stats.ino);
    if (
      saved &&
      saved.inode === inode &&
      saved.size === stats.size &&
      saved.modified === stats.mtimeMs &&
      saved.offset === stats.size
    ) {
      // 未变化的文件不重读正文。
      return;
    }
    report.filesRead += 1;
    const sinks: FileSinks = { windows: new Map(), plans: new Map() };
    const save = (offset: number, context: string, tail: string) =>
      state.saveCodexFile({
        path,
        offset,
        inode,
        tail,
        context,
        size: stats.size,
        modified: stats.mtimeMs,
      });
    if (path.endsWith(".jsonl.zst")) {
      // 压缩文件写完即不再变化：整解压、整读逐行解析，进度只记整文件标记。
      let text: Buffer;
      try {
        text = Bun.zstdDecompressSync(readFileSync(path));
      } catch {
        report.unreadable++;
        return;
      }
      report.bytes += text.length;
      const context = emptyContext();
      state.db.transaction(() => {
        const lines = text.toString("utf8");
        let from = 0;
        while (from < lines.length) {
          const to = lines.indexOf("\n", from);
          if (to < 0) break;
          if (to > from) handleLine(lines.slice(from, to), context, sinks);
          from = to + 1;
        }
        save(stats.size, "", "");
      })();
      adoptFile(sinks);
      return;
    }
    // 未压缩文件仍会被追加：从上次完整行边界继续，未写完的行留到下一轮。
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      report.unreadable++;
      return;
    }
    try {
      const identity = String(stats.ino);
      const length = stats.size;
      const resume =
        saved &&
        saved.inode === identity &&
        saved.offset <= length &&
        saved.tail === tailFingerprint(fd, saved.offset)
          ? saved
          : null;
      let offset = resume ? resume.offset : 0;
      const context = restoreContext(resume ? resume.context : null);
      let fragment = Buffer.alloc(0);
      let discarding = context.discarding ?? false;
      const block = Buffer.alloc(chunkBytes);
      // 进度只推进到最后一个完整行之后；末尾未写完的行下一轮重读。
      let consumed = offset;
      state.db.transaction(() => {
        while (offset < length) {
          const chunkStart = offset;
          const read = readSync(
            fd,
            block,
            0,
            Math.min(block.length, length - offset),
            offset,
          );
          if (read <= 0) break;
          offset += read;
          report.bytes += read;
          let start = 0;
          for (;;) {
            const newline = block.indexOf(10, start);
            if (newline < 0 || newline >= read) break;
            if (!discarding) {
              const line = Buffer.concat([
                fragment,
                block.subarray(start, newline),
              ]).toString("utf8");
              handleLine(line, context, sinks);
            }
            fragment = Buffer.alloc(0);
            discarding = false;
            consumed = chunkStart + newline + 1;
            start = newline + 1;
          }
          if (start < read) {
            if (!discarding)
              fragment = Buffer.concat([fragment, block.subarray(start, read)]);
            if (fragment.length > lineBudgetBytes) {
              // 超长行丢弃但进度照常推进到该行的读取边界，不反复重读。
              fragment = Buffer.alloc(0);
              discarding = true;
              consumed = offset;
            }
          }
        }
        context.discarding = discarding;
        save(consumed, JSON.stringify(context), tailFingerprint(fd, consumed));
      })();
      adoptFile(sinks);
    } finally {
      closeSync(fd);
    }
  };

  for (const { path, modified } of paths) {
    // 起点之前的文件直接跳过，不解压；预算耗尽后剩余文件顺延到下一轮。
    if (modified < startMs) continue;
    if (report.bytes >= maxBytes) {
      report.deferred = true;
      break;
    }
    processFile(path);
  }

  state.db.transaction(() => {
    for (const [account, byWindow] of windows) {
      const quotas: IngestQuota[] = [];
      for (const window of [...byWindow.keys()].sort()) {
        const sample = byWindow.get(window)!;
        const last = observed[`${account}:${window}`];
        if (
          last !== undefined &&
          Date.parse(last) >= Date.parse(sample.sampledAt)
        )
          continue;
        quotas.push(sample.quota);
        observed[`${account}:${window}`] = sample.sampledAt;
      }
      if (quotas.length === 0) continue;
      if (
        state.recordQuota(
          { hash: hash(JSON.stringify(quotas)), quotas },
          "codex",
        )
      )
        report.quotas += quotas.length;
    }
    if (roundPlans.size > 0) {
      for (const [account, plan] of roundPlans) plans[account] = plan;
      state.setMeta("codex_plans", JSON.stringify(plans));
    }
    state.setMeta("codex_window_sampled", JSON.stringify(observed));
  })();

  for (const account of routedAccounts.values()) ensureAccount(account);
  return report;
}
