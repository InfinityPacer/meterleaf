import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { IngestAccount, IngestUsage } from "../shared/ingest";
import {
  agyAccountsForLabel,
  agyLabelFromEmail,
  normalizeAgyModel,
  readPlanMap,
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

function durationMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && rounded <= 86_400_000
    ? rounded
    : null;
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
  durationMs: number | null;
  firstTokenMs: number | null;
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
  const totalDurationMs = durationMs(message.duration);
  const rawTtftMs = durationMs(message.ttft);
  const firstTokenMs =
    rawTtftMs !== null &&
    (totalDurationMs === null || rawTtftMs <= totalDurationMs)
      ? rawTtftMs
      : null;
  return {
    provider,
    rawModel,
    durationMs: totalDurationMs,
    firstTokenMs,
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
  /** omp 的账号库 agent.db，用来把请求里的账号编号对应到 Google 账号。 */
  credentialsDb: string;
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
  /** 本轮新读到的额度用完（429）响应数，用来立即读一次实时额度。 */
  agyExhausted: number;
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
    agyExhausted: 0,
  };
}

const chunkBytes = 1024 * 1024;
const tailBytes = 256;
const lineBudgetBytes = 16 * 1024 * 1024;
const budgetBytes = 64 * 1024 * 1024;
const agyProvider = "google-antigravity";

/**
 * omp 账号库里 Antigravity 登录的编号与账号标签。只查编号和 identity_key（形如 email:<邮箱>），
 * 不读存放令牌的列。账号库缺失、结构变化或正被锁住时返回空表，请求退回活跃账号归属。
 */
export function readOmpAgyLabels(path: string): Map<number, string> {
  const labels = new Map<number, string>();
  if (!existsSync(path)) return labels;
  let db: Database | null = null;
  try {
    // 用普通路径只读打开：Linux 上的 SQLite 默认不解析 file: URI 参数。
    db = new Database(path, { readonly: true });
    const rows = db
      .query<{ id: number; identity_key: string }, [string]>(
        "SELECT id, identity_key FROM auth_credentials WHERE provider = ? AND identity_key LIKE 'email:%'",
      )
      .all(agyProvider);
    for (const row of rows) {
      const label = agyLabelFromEmail(row.identity_key.slice("email:".length));
      if (label) labels.set(row.id, label);
    }
  } catch {
    // 见函数说明。
  } finally {
    db?.close();
  }
  return labels;
}

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

/** 已完成历史补录的 omp 渠道规则摘要。 */
export const OMP_RULES_DIGEST_META = "omp_channel_rules_digest";
/** 正在补录的 omp 渠道规则摘要；补录跨多轮进行，完成后删除。 */
export const OMP_RULES_PENDING_META = "omp_channel_rules_pending_digest";
/**
 * 仅用于从无规则摘要的旧版首次升级迁移：记录旧版已读完的文件偏移与末尾指纹，
 * 使旧版已处理过但未写事件去重键的历史 429 只补记去重键而不重复触发实时刷新。
 * 首次补录完成后即删除，此后所有规则变更与重写均纯按事件身份幂等去重。
 */
export const OMP_H0_MIGRATION_OFFSETS_META = "omp_h0_migration_offsets";

type MigrationOffsets = Map<
  string,
  { inode: string; offset: number; tail: string }
>;

function readMigrationOffsets(state: CollectorState): MigrationOffsets {
  const offsets: MigrationOffsets = new Map();
  const rawText = state.getMeta(OMP_H0_MIGRATION_OFFSETS_META);
  if (!rawText) return offsets;
  try {
    const raw = JSON.parse(rawText) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const [path, value] of Object.entries(raw)) {
        const entry = value as {
          inode?: unknown;
          offset?: unknown;
          tail?: unknown;
        } | null;
        if (
          typeof entry?.inode === "string" &&
          typeof entry.offset === "number" &&
          Number.isFinite(entry.offset) &&
          entry.offset >= 0 &&
          typeof entry.tail === "string"
        )
          offsets.set(path, {
            inode: entry.inode,
            offset: entry.offset,
            tail: entry.tail,
          });
      }
  } catch {
    // 迁移记录损坏时按无边界处理，最多多触发一次受冷却限制的实时刷新。
  }
  return offsets;
}

/** 生效的 omp 渠道规则摘要：规则变化后需要从头重读，把此前因无路由跳过的请求补录进来。 */
export function ompRulesDigest(rules: readonly ChannelAccountRule[]) {
  return hash(
    JSON.stringify(
      rules
        .filter((rule) => rule.source === "omp")
        .map((rule) => [
          rule.channel,
          rule.id,
          rule.name,
          rule.platform,
          rule.kind,
          rule.plan,
        ]),
    ),
  );
}

/**
 * 规则变化时的两阶段补录。进行中摘要与当前规则不同时（含 A → B 未完成又切回 A），
 * 先清空读取进度与顺延标记，再记下新的进行中摘要，同一事务提交；首次发现规则与已完成摘要不同也一样。
 * 进行中摘要等于当前规则时保留进度续扫；没有进行中摘要且规则未变时正常增量读取。返回补录中的摘要。
 */
function beginRulesBackfill(state: CollectorState, digest: string): string {
  const completed = state.getMeta(OMP_RULES_DIGEST_META) ?? "";
  const pending = state.getMeta(OMP_RULES_PENDING_META) ?? "";
  if (pending === digest) return pending;
  if (pending === "" && digest === completed) return "";
  state.write(() => {
    if (completed === "" && pending === "") {
      const existing = state.listOmpFiles();
      if (existing.length > 0) {
        const migration: Record<
          string,
          { inode: string; offset: number; tail: string }
        > = Object.create(null);
        for (const file of existing)
          migration[file.path] = {
            inode: file.inode,
            offset: file.offset,
            tail: file.tail,
          };
        state.setMeta(OMP_H0_MIGRATION_OFFSETS_META, JSON.stringify(migration));
      }
    }
    state.clearOmpFiles();
    state.setMeta("omp_deferred", "");
    state.setMeta(OMP_RULES_PENDING_META, digest);
  });
  return digest;
}

/**
 * 读取一轮 omp 会话记录。
 *
 * 只取已完成的助手消息作为一次请求，以及设置思考档位与服务档位的行；消息正文、标题和
 * 工作目录不读取也不保存。omp 的 opencode-go 请求按通道规则归账，google-antigravity
 * 请求归入它所用的 Google 账号，其余通道没有规则时跳过计数。每个文件的用量、
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
  // 已入账的请求靠用量键去重，从头重读不会重复上报；已由自定义规则归账的请求键不变，归属也不变。
  const digest = ompRulesDigest(rules);
  const currentPending = beginRulesBackfill(state, digest);
  const migrationOffsets = readMigrationOffsets(state);
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

  // Antigravity 请求按 credentialId 归到登录的 Google 账号；没有编号或账号库里查不到时，
  // 归入与 readAgy 相同的活跃账号。
  const credentialLabels = readOmpAgyLabels(sources.credentialsDb);
  const activeLabel = resolveAgyActiveAccount(
    sources.statuslineDir,
    state,
  ).label;
  const plans = readPlanMap(state);

  interface FileSinks {
    accounts: Map<string, IngestAccount>;
    /** 文件里有 Antigravity 请求却没有活跃账号时不能推进进度，否则这些请求永远补不上。 */
    missingAccount: boolean;
  }

  const handleLine = (
    line: string,
    context: OmpContext,
    sinks: FileSinks,
    inH0MigrationRange: boolean,
  ) => {
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
    const message = object(entry?.message);
    if (entry?.type !== "message" || message?.role !== "assistant") return;
    // 每条 429 按事件身份（整行哈希）只计一次：规则补录或重读遇到已计过的事件不再触发实时读取；
    // 旧版首次升级迁移范围内的历史 429 只补记去重键，不重复触发刷新。
    // 登记与读取进度在同一文件事务内提交，中途失败一起回滚。
    if (
      message.provider === agyProvider &&
      message.errorStatus === 429 &&
      state.recordOmpAgyExhausted(`omp-agy-429-${hash(line)}`) &&
      !inH0MigrationRange
    )
      report.agyExhausted++;
    let parsed: ReturnType<typeof ompMessage>;
    try {
      parsed = ompMessage(entry, context);
    } catch {
      report.invalid++;
      return;
    }
    if (!parsed) return;
    report.read++;
    const {
      usage,
      provider,
      rawModel,
      durationMs: totalDurationMs,
      firstTokenMs,
    } = parsed;
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
    if (totalDurationMs !== null) metadata.duration_ms = totalDurationMs;
    if (firstTokenMs !== null) metadata.first_token_ms = firstTokenMs;
    if (toAgy) {
      const credential = message.credentialId;
      const label =
        (typeof credential === "number"
          ? credentialLabels.get(credential)
          : undefined) ?? activeLabel;
      if (!label) {
        const key = `${agyProvider} (缺失账户)`;
        report.skipped[key] = (report.skipped[key] ?? 0) + 1;
        report.agyMissingAccount++;
        sinks.missingAccount = true;
        return;
      }
      const profile = agyAccountsForLabel(label, plans[label] ?? null);
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
      const migrationPrior = migrationOffsets.get(path);
      const migrationOffset =
        migrationPrior &&
        migrationPrior.inode === inode &&
        migrationPrior.offset <= length &&
        migrationPrior.tail === tailFingerprint(fd, migrationPrior.offset)
          ? migrationPrior.offset
          : 0;
      const context = restoreContext(resume ? resume.context : null);
      const sinks: FileSinks = { accounts: new Map(), missingAccount: false };
      let fragment = Buffer.alloc(0);
      let discarding = context.discarding ?? false;
      const block = Buffer.alloc(chunkBytes);
      // 进度只推进到最后一个完整行之后；末尾未写完的行下一轮重读。
      let consumed = offset;
      state.write(() => {
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
              handleLine(
                line,
                context,
                sinks,
                chunkStart + newline + 1 <= migrationOffset,
              );
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
      });
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
  // 整轮读完且没有顺延，补录才算完成；若存在旧版迁移边界一并清除。
  if (!report.deferred && currentPending !== "" && currentPending === digest)
    state.write(() => {
      state.setMeta(OMP_RULES_DIGEST_META, digest);
      state.deleteMeta(OMP_RULES_PENDING_META);
      state.deleteMeta(OMP_H0_MIGRATION_OFFSETS_META);
    });

  return report;
}
