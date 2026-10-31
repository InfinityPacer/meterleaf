import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IngestAccount, IngestUsage } from "../shared/ingest";
import {
  agyAccountsForLabel,
  normalizeAgyModel,
  resolveAgyActiveAccount,
} from "./agy";
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

/** 单个会话文件按行往下读时的上下文：思考档位与服务档位由前面的设置行给出。 */
export interface OmpContext {
  effort: string | null;
  tier: string | null;
  discarding?: boolean;
}

const serviceTiers = ["standard", "priority", "flex", "fast", "default"];

function token(usage: RecordValue, key: string): number | null {
  const value = usage[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid_token_count");
  }
  return value;
}

function isoTime(value: unknown): string | null {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 8_640_000_000_000)
    return null;
  return new Date(ms).toISOString();
}

/**
 * 解析 omp 会话里的一条已完成助手消息。四个基础桶在 omp 里已经互斥（输入已扣除缓存），
 * 输出包含推理量；不采用 omp 自带的 cost，费用由服务端按价格表估值。
 * 全零的响应（例如刚启动即中止）不算一次请求，返回 null。
 */
export function ompMessage(
  entry: RecordValue,
  context: OmpContext,
): {
  usage: Omit<IngestUsage, "accountExternalId" | "model" | "metadata">;
  provider: string;
  rawModel: string;
} | null {
  const message = object(entry.message);
  const usage = object(message?.usage);
  if (
    !message ||
    !usage ||
    typeof entry.id !== "string" ||
    entry.id === "" ||
    typeof message.provider !== "string" ||
    message.provider.trim() === "" ||
    typeof message.model !== "string" ||
    message.model.trim() === ""
  )
    throw new Error("missing_message_fields");
  const input = token(usage, "input");
  const output = token(usage, "output");
  const cacheRead = token(usage, "cacheRead");
  const cacheWrite = token(usage, "cacheWrite");
  // omp 推理量为 0 时省略该字段；保持未知而不是补零。
  const reasoning = token(usage, "reasoningTokens");
  if (reasoning !== null && output !== null && reasoning > output)
    throw new Error("inconsistent_token_breakdown");
  const buckets = [input, output, cacheRead, cacheWrite];
  if (buckets.every((count) => (count ?? 0) === 0)) return null;
  const occurredAt =
    isoTime(message.completedAt) ??
    isoTime(entry.timestamp) ??
    isoTime(message.timestamp);
  if (!occurredAt) throw new Error("invalid_timestamp");
  const rawTier =
    typeof message.serviceTier === "string"
      ? message.serviceTier.toLowerCase()
      : null;
  const tier =
    rawTier && serviceTiers.includes(rawTier) ? rawTier : context.tier;
  const provider = message.provider.trim();
  const rawModel = message.model.trim();
  return {
    provider,
    rawModel,
    usage: {
      // 哈希输入不含文件路径和会话 ID：会话文件迁移目录、从中间分支复制历史消息时
      // 请求本身不变，不能因此重复入账。
      externalId:
        "omp-" +
        hash(
          JSON.stringify([
            entry.id,
            occurredAt,
            provider,
            rawModel,
            [input, output, cacheRead, cacheWrite, reasoning],
          ]),
        ),
      occurredAt,
      tier,
      tokens: {
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning,
      },
    },
  };
}

function ingestAccount(account: ChannelAccount): IngestAccount {
  return {
    externalId: account.id,
    name: account.name,
    platform: account.platform,
    kind: account.kind,
    plan: account.plan,
    subjectKey: null,
  };
}

export interface OmpReaderSources {
  sessionsDir: string;
  statuslineDir: string;
  start: string;
  channelAccounts: readonly ChannelAccountRule[];
}

export interface OmpReaderReport extends SourceReaderReport {
  filesRead: number;
  bytes: number;
  /** 早于起点被丢弃的用量条数。 */
  beforeStart: number;
  unreadable: number;
  /** 本轮是否到达读取预算，剩余会话顺延到下一轮。 */
  deferred: boolean;
  /** 本轮新入账的 Antigravity 请求数，用来判断是否需要刷新额度。 */
  agyRecorded: number;
  /** 找不到活跃 Antigravity 账号而暂缓的请求数；账号出现后下一轮补录。 */
  agyMissingAccount: number;
}

export function emptyOmpReport(): OmpReaderReport {
  return {
    ...emptySourceReport("omp"),
    filesRead: 0,
    bytes: 0,
    beforeStart: 0,
    unreadable: 0,
    deferred: false,
    agyRecorded: 0,
    agyMissingAccount: 0,
  };
}

const chunkBytes = 1024 * 1024;
const tailBytes = 256;
const lineBudgetBytes = 16 * 1024 * 1024;
const budgetBytes = 64 * 1024 * 1024;
const agyProvider = "google-antigravity";

/** 恢复读取进度需要确认上次读到的位置没有变化：按偏移前的短片段指纹判断。 */
function tailFingerprint(fd: number, offset: number): string {
  const size = Math.min(offset, tailBytes);
  const bytes = Buffer.alloc(size);
  const read = readSync(fd, bytes, 0, size, offset - size);
  return hash(bytes.subarray(0, read));
}

function restoreContext(saved: string | null): OmpContext {
  if (saved) {
    try {
      const restored = JSON.parse(saved) as Partial<OmpContext>;
      return {
        effort: typeof restored.effort === "string" ? restored.effort : null,
        tier: typeof restored.tier === "string" ? restored.tier : null,
        discarding: restored.discarding === true,
      };
    } catch {
      // 进度附带的上下文损坏时从头读起；重读靠用量键去重保证不重复入账。
    }
  }
  return { effort: null, tier: null };
}

/**
 * 读取一轮 omp 会话记录。
 *
 * 只取已完成的助手消息作为一次请求，以及设置思考档位与服务档位的行；消息正文、标题和
 * 工作目录不读取也不保存。omp 的 opencode-go 请求按通道规则归账，google-antigravity
 * 请求归入当前活跃的 Antigravity 账号，其余通道没有规则时跳过计数。每个文件的用量、
 * 账户资料与读取进度在同一事务提交，读取中断整体回滚后从原进度重读。
 */
export async function readOmp(
  state: CollectorState,
  sources: OmpReaderSources,
  maxBytes = budgetBytes,
): Promise<OmpReaderReport> {
  const report = emptyOmpReport();
  const rules = sources.channelAccounts;
  if (!existsSync(sources.sessionsDir)) return report;
  const startMs = Date.parse(sources.start);
  const startIso = new Date(startMs).toISOString();
  const paths: { path: string; modified: number }[] = [];
  for await (const file of new Bun.Glob("**/*.jsonl").scan({
    cwd: sources.sessionsDir,
    followSymlinks: false,
  })) {
    const path = join(sources.sessionsDir, file);
    try {
      paths.push({ path, modified: statSync(path).mtimeMs });
    } catch {
      report.unreadable++;
    }
  }
  paths.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
  state.forgetMissingOmpFiles(new Set(paths.map((row) => row.path)));

  // Antigravity 请求没有自己的账号信息，归入与 readAgy 相同的活跃账号。
  const agy = resolveAgyActiveAccount(sources.statuslineDir, state);

  interface FileSinks {
    accounts: Map<string, IngestAccount>;
    /** 文件里有 Antigravity 请求却没有活跃账号时不能推进进度，否则这些请求永远补不上。 */
    missingAccount: boolean;
  }

  const handleLine = (line: string, context: OmpContext, sinks: FileSinks) => {
    if (!/"(?:assistant|thinking_level_change|service_tier_change)"/.test(line))
      return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      report.invalid++;
      return;
    }
    const entry = object(raw);
    if (entry?.type === "thinking_level_change") {
      const level = entry.thinkingLevel;
      context.effort =
        typeof level === "string" &&
        level !== "" &&
        level.toLowerCase() !== "off" &&
        level.length <= 32
          ? level.toLowerCase()
          : null;
      return;
    }
    if (entry?.type === "service_tier_change") {
      const tier =
        typeof entry.serviceTier === "string"
          ? entry.serviceTier.toLowerCase()
          : "";
      context.tier = serviceTiers.includes(tier) ? tier : null;
      return;
    }
    if (
      entry?.type !== "message" ||
      object(entry.message)?.role !== "assistant"
    )
      return;
    let parsed: ReturnType<typeof ompMessage>;
    try {
      parsed = ompMessage(entry, context);
    } catch {
      report.invalid++;
      return;
    }
    if (!parsed) return;
    report.read++;
    const { usage, provider, rawModel } = parsed;
    if (usage.occurredAt < startIso) {
      report.beforeStart++;
      return;
    }

    const routed = routeChannel("omp", provider, rules);
    const toAgy = !routed && provider === agyProvider;
    let account: IngestAccount | null = routed ? ingestAccount(routed) : null;
    let model = rawModel;
    let effort = context.effort;
    const metadata: IngestUsage["metadata"] = { origin: "omp_local" };
    if (toAgy) {
      if (!agy.label) {
        const key = `${agyProvider} (缺失账户)`;
        report.skipped[key] = (report.skipped[key] ?? 0) + 1;
        report.agyMissingAccount++;
        sinks.missingAccount = true;
        return;
      }
      const profile = agyAccountsForLabel(agy.label, agy.plan);
      account = profile.account;
      for (const legacy of profile.legacy)
        sinks.accounts.set(legacy.externalId, legacy);
      const normalized = normalizeAgyModel({ responseModel: rawModel });
      if (normalized) {
        model = normalized.model;
        effort = normalized.reasoningEffort ?? effort;
        if (normalized.upstreamModel)
          metadata.upstream_model = normalized.upstreamModel;
      }
    }
    if (!account) {
      report.skipped[provider] = (report.skipped[provider] ?? 0) + 1;
      return;
    }
    sinks.accounts.set(account.externalId, account);
    metadata.reasoning_effort = effort;
    if (
      state.recordSourceUsage("omp", {
        ...usage,
        accountExternalId: account.externalId,
        model,
        metadata,
      })
    ) {
      report.recorded++;
      if (toAgy) report.agyRecorded++;
    }
  };

  /** 返回 false 表示文件超出本轮剩余预算，留待下一轮。 */
  const processFile = (path: string): boolean => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      report.unreadable++;
      return true;
    }
    if (!stats.isFile()) return true;
    const saved = state.ompFile(path);
    const inode = String(stats.ino);
    if (
      saved &&
      saved.inode === inode &&
      saved.size === stats.size &&
      saved.modified === stats.mtimeMs &&
      saved.offset === stats.size
    ) {
      // 未变化的文件不重读正文。
      return true;
    }
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      report.unreadable++;
      return true;
    }
    report.filesRead += 1;
    try {
      const length = stats.size;
      // omp 会原地改写文件第 0 行的标题（长度不变），所以只用偏移前的末尾片段确认
      // 上次读到的位置没变；不符时从头重读，重复的请求靠用量键去重。
      const resume =
        saved &&
        saved.inode === inode &&
        saved.offset <= length &&
        saved.tail === tailFingerprint(fd, saved.offset)
          ? saved
          : null;
      let offset = resume ? resume.offset : 0;
      const context = restoreContext(resume ? resume.context : null);
      const sinks: FileSinks = { accounts: new Map(), missingAccount: false };
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
        for (const account of sinks.accounts.values())
          state.upsertAccount(account);
        if (!sinks.missingAccount)
          state.saveOmpFile({
            path,
            offset: consumed,
            inode,
            tail: tailFingerprint(fd, consumed),
            context: JSON.stringify(context),
            size: stats.size,
            modified: stats.mtimeMs,
          });
      })();
      return true;
    } finally {
      closeSync(fd);
    }
  };

  // 上一轮顺延的文件本轮排在最前，作为首个文件不受剩余预算限制，避免持续活跃
  // 或无法推进的较新文件每轮占满预算、让它永远轮不到。
  const deferredPath = state.getMeta("omp_deferred");
  const ordered = deferredPath
    ? [
        ...paths.filter((row) => row.path === deferredPath),
        ...paths.filter((row) => row.path !== deferredPath),
      ]
    : paths;
  let nextDeferred: string | null = null;
  for (const { path, modified } of ordered) {
    // 起点之前的文件直接跳过；预算耗尽的文件顺延到下一轮。
    if (modified < startMs) continue;
    if (report.bytes >= maxBytes || !processFile(path)) {
      report.deferred = true;
      nextDeferred = path;
      break;
    }
  }
  if (nextDeferred !== deferredPath)
    state.setMeta("omp_deferred", nextDeferred ?? "");

  return report;
}
