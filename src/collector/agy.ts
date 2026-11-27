import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import type { IngestAccount, IngestQuota, IngestUsage } from "../shared/ingest";
import type { QuotaSnapshot } from "./claude-code/quota";
import { emptySourceReport, type SourceReaderReport } from "./sources";
import type { CollectorState } from "./state";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export type AgyPool = "gemini" | "3p";
export type AgyWindowKey =
  "gemini_5h" | "gemini_weekly" | "3p_5h" | "3p_weekly";

const agyWindows: Record<
  AgyWindowKey,
  { pool: AgyPool; window: IngestQuota["window"]; minutes: 300 | 10080 }
> = {
  gemini_5h: { pool: "gemini", window: "five-hour", minutes: 300 },
  gemini_weekly: { pool: "gemini", window: "seven-day", minutes: 10080 },
  "3p_5h": { pool: "3p", window: "five-hour-3p", minutes: 300 },
  "3p_weekly": { pool: "3p", window: "seven-day-3p", minutes: 10080 },
};

/**
 * Antigravity 状态栏把 Google 邮箱本地部分归一化成仅含小写字母、数字、_ 和 - 的标签。
 * 采集器只接受这一格式的标签，不读取也不还原原始邮箱。
 */
export function isValidAgyLabel(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

/** Google 邮箱本地部分按状态栏同样的规则归一化成账号标签，不合格式时为 null。 */
export function agyLabelFromEmail(email: string): string | null {
  const label = email
    .split("@")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  return isValidAgyLabel(label) ? label : null;
}

export function agyAccountId(label: string): string {
  return `agy-${label}`;
}

/** 早期版本按额度池拆成两个账户时用的标识，只为把那段历史归到合并后的账户。 */
function agyPoolAccountId(label: string, pool: AgyPool): string {
  return `agy-${label}-${pool}`;
}

/**
 * 每个 Google 账号在 Antigravity 中有两套独立额度池：Gemini 池与 Claude/GPT 第三方模型池。
 * 两个池记在同一个账户下，Gemini 池上报为 five-hour 与 seven-day，第三方池上报为
 * five-hour-3p 与 seven-day-3p，服务端按模型分别统计各池的本期花费与推算。
 * legacy 是早期按池拆开的两个账户，指向合并后的账户，使它们名下的历史用量与额度一并归过去。
 */
export function agyAccountsForLabel(
  label: string,
  plan: string | null,
): { account: IngestAccount; legacy: IngestAccount[] } {
  const base = {
    platform: "google",
    kind: "subscription" as const,
    plan,
    subjectKey: null,
  };
  return {
    account: {
      externalId: agyAccountId(label),
      name: `Antigravity (${label})`,
      ...base,
    },
    legacy: [
      {
        externalId: agyPoolAccountId(label, "gemini"),
        name: `Antigravity (${label}) · Gemini`,
        ...base,
        parentExternalId: agyAccountId(label),
      },
      {
        externalId: agyPoolAccountId(label, "3p"),
        name: `Antigravity (${label}) · Claude/GPT`,
        ...base,
        parentExternalId: agyAccountId(label),
      },
    ],
  };
}

export interface AgyQuotaEntry {
  key: AgyWindowKey;
  pool: AgyPool;
  accountExternalId: string;
  window: IngestQuota["window"];
  windowMinutes: 300 | 10080;
  /** 窗口已过重置时间或原值为 - 时保留 null，不把旧周期读数或未知值当作 0% 上报。 */
  percent: number | null;
  resetsAt: string | null;
  expired: boolean;
}

export interface AgyQuotaCache {
  label: string;
  sampledAt: string;
  plan: string | null;
  entries: AgyQuotaEntry[];
  ignoredLines: number;
}

/** 读取 ~/.cache/agy-statusline/current-account（或额外实例的 current-account-<profile>）中的活跃标签。 */
export function readAgyCurrentAccount(
  statuslineDir: string,
  profileName: string | null = null,
): string | null {
  const fileName = profileName
    ? `current-account-${profileName}`
    : "current-account";
  let raw: string;
  try {
    raw = readFileSync(join(statuslineDir, fileName), "utf8");
  } catch {
    return null;
  }
  const label = raw.trim();
  return isValidAgyLabel(label) ? label : null;
}
/**
 * 只读解析单个 quota-<label>.tsv。采样时间取文件修改时间；状态栏脚本只刷某个池子时，
 * 另一个池子的旧行可能留在文件里且已过重置时间，此时保留 resetsAt 供服务端标为已重置，
 * 但将 percent 置为 null，避免把上一周期的旧百分比作为新采样上报。
 */
export function readAgyQuotaFile(
  path: string,
  label: string,
  now: Date = new Date(),
): AgyQuotaCache | null {
  if (!isValidAgyLabel(label)) return null;
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

  const entries = new Map<AgyWindowKey, AgyQuotaEntry>();
  let plan: string | null = null;
  let ignoredLines = 0;
  const effectiveNowMs = Math.max(mtimeMs, now.getTime());

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const [name, col2, col3, extra] = line.split("\t");
    if (extra !== undefined || !name) {
      ignoredLines += 1;
      continue;
    }
    if (name === "plan") {
      const tierText = (col2 ?? "").trim();
      const resetCol = (col3 ?? "").trim();
      if (
        resetCol === "-" &&
        tierText.length > 0 &&
        tierText.length <= 64 &&
        tierText !== "-" &&
        tierText.toLowerCase() !== "unknown" &&
        tierText.toLowerCase() !== "null"
      ) {
        plan = tierText;
      } else {
        ignoredLines += 1;
      }
      continue;
    }
    if (!Object.hasOwn(agyWindows, name)) {
      ignoredLines += 1;
      continue;
    }
    const key = name as AgyWindowKey;
    const spec = agyWindows[key];
    const usedText = (col2 ?? "").trim();
    const resetText = (col3 ?? "").trim();

    let rawPercent: number | null;
    if (usedText === "-") {
      rawPercent = null;
    } else if (/^\d+(\.\d+)?$/.test(usedText)) {
      const value = Number(usedText);
      if (!Number.isFinite(value) || value < 0 || value > 1000) {
        ignoredLines += 1;
        continue;
      }
      rawPercent = value;
    } else {
      ignoredLines += 1;
      continue;
    }

    let resetMs: number | null;
    if (resetText === "-") {
      resetMs = null;
    } else if (resetText === "0" && rawPercent === 0) {
      // 上游刚重置或新账号未开窗时，缓存写为 0\t0（已用 0%、暂无重置时间），保留读数而非当作损坏行丢弃。
      resetMs = null;
    } else if (/^\d{9,11}$/.test(resetText)) {
      const sec = Number(resetText);
      if (!Number.isSafeInteger(sec) || sec <= 0) {
        ignoredLines += 1;
        continue;
      }
      resetMs = sec * 1000;
    } else {
      ignoredLines += 1;
      continue;
    }

    if (rawPercent === null && resetMs === null) {
      ignoredLines += 1;
      continue;
    }

    const expired = resetMs !== null && resetMs <= effectiveNowMs;
    entries.set(key, {
      key,
      pool: spec.pool,
      accountExternalId: agyAccountId(label),
      window: spec.window,
      windowMinutes: spec.minutes,
      percent: expired ? null : rawPercent,
      resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
      expired,
    });
  }

  if (entries.size === 0 && plan === null) return null;
  return {
    label,
    sampledAt: new Date(mtimeMs).toISOString(),
    plan,
    entries: [...entries.values()],
    ignoredLines,
  };
}

export function agyQuotaSnapshot(cache: AgyQuotaCache): QuotaSnapshot {
  const quotas: IngestQuota[] = cache.entries.map((entry) => ({
    accountExternalId: entry.accountExternalId,
    window: entry.window,
    percent: entry.percent,
    sampledAt: cache.sampledAt,
    resetsAt: entry.resetsAt,
    windowMinutes: entry.windowMinutes,
  }));
  const digest = hash(
    JSON.stringify(["agy-statusline", cache.label, cache.sampledAt, quotas]),
  );
  return { hash: digest, quotas };
}

// ---- Protobuf 解码（对应 agy 内置的 exa.cortex_pb 与 exa.codeium_common_pb） ----

export interface DecodedAgyModelUsage {
  /** #1: exa.codeium_common_pb.Model 枚举值 */
  modelEnum: number | null;
  /** #2: 未缓存输入 Tokens（与 #4 缓存写入、#5 缓存读取互斥） */
  inputTokens: number | null;
  /** #3: 输出总 Tokens（等于 #10 可见输出加 #9 思考输出） */
  outputTokens: number | null;
  /** #4: 缓存写入 Tokens */
  cacheWriteTokens: number | null;
  /** #5: 缓存读取 Tokens */
  cacheReadTokens: number | null;
  /** #6: exa.codeium_common_pb.APIProvider 枚举值 */
  apiProvider: number | null;
  /** #7: 单次生成的消息标识（例如 bot-...） */
  messageId: string | null;
  /** #9: 思考/推理 Tokens（属于 #3 输出的子集） */
  thinkingOutputTokens: number | null;
  /** #10: 不含思考的可见回复输出 Tokens */
  responseOutputTokens: number | null;
  /** #11: 上游响应 ID */
  responseId: string | null;
  /** #13: 上游服务档位 */
  serviceTier: string | null;
  hasAnyTokenField: boolean;
}

export interface DecodedAgyChatModel {
  /** #3: 请求模型枚举 */
  modelEnum: number | null;
  /** #4: ModelUsageStats */
  usage: DecodedAgyModelUsage | null;
  /** #9.#4: ChatStartMetadata.created_at */
  createdAt: string | null;
  /** #11: 首字耗时（毫秒） */
  ttftMs: number | null;
  /** #12: 流式输出耗时（毫秒） */
  streamingMs: number | null;
  /** #19: 上游实际执行的模型标识字符串 */
  responseModel: string | null;
  /** #20: 键值元数据（如 used_non_gemini_model、request_id、model_enum） */
  customMetadata: Record<string, string>;
  /** #21: 模型显示名称（如 Gemini 4 Argon (High)、Claude Opus 5.5 (Low)） */
  modelDisplayName: string | null;
}

export interface DecodedAgyGenMetadata {
  /** #1: ChatModelMetadata */
  chatModel: DecodedAgyChatModel | null;
  /** #2: 关联的 steps.idx 列表 */
  stepIndices: number[];
  /** #4: 与 steps.metadata.#12 对应的执行 UUID */
  executionId: string | null;
  /** #5: 生成失败或中止时的错误说明 */
  error: string | null;
}

export interface DecodedAgyStepMetadata {
  /** #1: 步骤创建时间 */
  createdAt: string | null;
  /** #7: 生成结束时间 */
  finishedGeneratingAt: string | null;
  /** #8: 步骤完成时间 */
  completedAt: string | null;
  /** #9.#7: model_usage.message_id */
  messageId: string | null;
  /** #12: execution_id */
  executionId: string | null;
}

function decodeBase64(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) {
    if (raw.byteLength === 0) throw new Error("empty_protobuf");
    return raw;
  }
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    !/^[A-Za-z0-9+/=_-]+$/.test(trimmed) ||
    trimmed.length % 4 === 1
  ) {
    throw new Error("invalid_base64");
  }
  const buf = Buffer.from(trimmed, "base64");
  if (buf.byteLength === 0) throw new Error("empty_protobuf");
  return buf;
}

function readVarint(
  buf: Uint8Array,
  pos: number,
): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let cursor = pos;
  while (cursor < buf.byteLength) {
    const byte = buf[cursor]!;
    cursor += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, next: cursor };
    shift += 7n;
    if (shift >= 70n) throw new Error("varint_overflow");
  }
  throw new Error("truncated_varint");
}

function toSafeUint(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("uint64_out_of_range");
  }
  return Number(value);
}

function walkProto(
  buf: Uint8Array,
  onField: (
    fieldNumber: number,
    wireType: number,
    value: bigint | Uint8Array,
  ) => void,
) {
  let pos = 0;
  while (pos < buf.byteLength) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const wireType = Number(tag.value & 7n);
    const fieldNumber = Number(tag.value >> 3n);
    if (fieldNumber <= 0) throw new Error("invalid_field_number");
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.next;
      onField(fieldNumber, 0, v.value);
    } else if (wireType === 1) {
      if (pos + 8 > buf.byteLength) throw new Error("truncated_fixed64");
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.next;
      const byteLength = toSafeUint(len.value);
      if (pos + byteLength > buf.byteLength)
        throw new Error("truncated_length_delimited");
      onField(fieldNumber, 2, buf.subarray(pos, pos + byteLength));
      pos += byteLength;
    } else if (wireType === 5) {
      if (pos + 4 > buf.byteLength) throw new Error("truncated_fixed32");
      pos += 4;
    } else {
      throw new Error(`unsupported_wire_type_${wireType}`);
    }
  }
}

function decodeTimestamp(buf: Uint8Array): string | null {
  let seconds: bigint | null = null;
  let nanos = 0n;
  walkProto(buf, (field, wire, value) => {
    if (wire === 0 && typeof value === "bigint") {
      if (field === 1) seconds = value;
      else if (field === 2) nanos = value;
    }
  });
  if (seconds === null || seconds <= 0n || seconds > 8640000000n) return null;
  const ms =
    Number(seconds) * 1000 + Math.floor(Math.max(0, Number(nanos)) / 1_000_000);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 解码 google.protobuf.Duration 为毫秒整数；负值或超出一天的异常值返回 null。 */
function decodeDurationMs(buf: Uint8Array): number | null {
  let seconds = 0n;
  let nanos = 0n;
  let sawField = false;
  walkProto(buf, (field, wire, value) => {
    if (wire === 0 && typeof value === "bigint") {
      if (field === 1) {
        seconds = value;
        sawField = true;
      } else if (field === 2) {
        nanos = value;
        sawField = true;
      }
    }
  });
  // proto3 中 0s Duration 可编码为空消息，只要外层字段存在即视为 0ms。
  if (
    seconds < 0n ||
    seconds > 86_400n ||
    nanos < 0n ||
    nanos >= 1_000_000_000n
  )
    return null;
  if (!sawField && buf.byteLength > 0) return null;
  const ms = Math.round(Number(seconds) * 1000 + Number(nanos) / 1_000_000);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

function decodeModelUsageStats(buf: Uint8Array): DecodedAgyModelUsage {
  const usage: DecodedAgyModelUsage = {
    modelEnum: null,
    inputTokens: null,
    outputTokens: null,
    cacheWriteTokens: null,
    cacheReadTokens: null,
    apiProvider: null,
    messageId: null,
    thinkingOutputTokens: null,
    responseOutputTokens: null,
    responseId: null,
    serviceTier: null,
    hasAnyTokenField: false,
  };
  walkProto(buf, (field, wire, value) => {
    if (wire === 0 && typeof value === "bigint") {
      const num = toSafeUint(value);
      switch (field) {
        case 1:
          usage.modelEnum = num;
          break;
        case 2:
          usage.inputTokens = num;
          usage.hasAnyTokenField = true;
          break;
        case 3:
          usage.outputTokens = num;
          usage.hasAnyTokenField = true;
          break;
        case 4:
          usage.cacheWriteTokens = num;
          usage.hasAnyTokenField = true;
          break;
        case 5:
          usage.cacheReadTokens = num;
          usage.hasAnyTokenField = true;
          break;
        case 6:
          usage.apiProvider = num;
          break;
        case 9:
          usage.thinkingOutputTokens = num;
          usage.hasAnyTokenField = true;
          break;
        case 10:
          usage.responseOutputTokens = num;
          usage.hasAnyTokenField = true;
          break;
      }
    } else if (wire === 2 && value instanceof Uint8Array) {
      const text = Buffer.from(value).toString("utf8");
      if (field === 7) usage.messageId = text || null;
      else if (field === 11) usage.responseId = text || null;
      else if (field === 13) usage.serviceTier = text || null;
    }
  });
  return usage;
}

function decodeChatStartMetadata(buf: Uint8Array): string | null {
  let createdAt: string | null = null;
  walkProto(buf, (field, wire, value) => {
    if (field === 4 && wire === 2 && value instanceof Uint8Array) {
      createdAt = decodeTimestamp(value);
    }
  });
  return createdAt;
}

function decodeMapEntry(buf: Uint8Array): [string, string] | null {
  let key = "";
  let val = "";
  walkProto(buf, (field, wire, value) => {
    if (wire === 2 && value instanceof Uint8Array) {
      if (field === 1) key = Buffer.from(value).toString("utf8");
      else if (field === 2) val = Buffer.from(value).toString("utf8");
    }
  });
  return key ? [key, val] : null;
}

function decodeChatModelMetadata(buf: Uint8Array): DecodedAgyChatModel {
  const chatModel: DecodedAgyChatModel = {
    modelEnum: null,
    usage: null,
    createdAt: null,
    ttftMs: null,
    streamingMs: null,
    responseModel: null,
    customMetadata: {},
    modelDisplayName: null,
  };
  walkProto(buf, (field, wire, value) => {
    if (field === 3 && wire === 0 && typeof value === "bigint") {
      chatModel.modelEnum = toSafeUint(value);
    } else if (wire === 2 && value instanceof Uint8Array) {
      // #1 是 system_prompt，直接跳过，不转为字符串也不驻留内存。
      if (field === 4) {
        chatModel.usage = decodeModelUsageStats(value);
      } else if (field === 9) {
        chatModel.createdAt = decodeChatStartMetadata(value);
      } else if (field === 11) {
        chatModel.ttftMs = decodeDurationMs(value);
      } else if (field === 12) {
        chatModel.streamingMs = decodeDurationMs(value);
      } else if (field === 19) {
        const text = Buffer.from(value).toString("utf8").trim();
        if (text) chatModel.responseModel = text;
      } else if (field === 20) {
        const entry = decodeMapEntry(value);
        if (entry) chatModel.customMetadata[entry[0]] = entry[1];
      } else if (field === 21) {
        const text = Buffer.from(value).toString("utf8").trim();
        if (text) chatModel.modelDisplayName = text;
      }
    }
  });
  return chatModel;
}

/** 解码 gen_metadata 表中的 CortexStepGeneratorMetadata protobuf。 */
export function decodeAgyGenMetadata(
  raw: string | Uint8Array,
): DecodedAgyGenMetadata {
  const buf = decodeBase64(raw);
  const result: DecodedAgyGenMetadata = {
    chatModel: null,
    stepIndices: [],
    executionId: null,
    error: null,
  };
  walkProto(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) {
      result.chatModel = decodeChatModelMetadata(value);
    } else if (field === 2) {
      if (wire === 0 && typeof value === "bigint") {
        result.stepIndices.push(toSafeUint(value));
      } else if (wire === 2 && value instanceof Uint8Array) {
        let pos = 0;
        while (pos < value.byteLength) {
          const item = readVarint(value, pos);
          pos = item.next;
          result.stepIndices.push(toSafeUint(item.value));
        }
      }
    } else if (field === 4 && wire === 2 && value instanceof Uint8Array) {
      const text = Buffer.from(value).toString("utf8").trim();
      if (text) result.executionId = text;
    } else if (field === 5 && wire === 2 && value instanceof Uint8Array) {
      const text = Buffer.from(value).toString("utf8").trim();
      if (text) result.error = text;
    }
  });
  return result;
}

/** 解码 steps.metadata 列中的 CortexStepMetadata protobuf，只取时间戳与关联 ID。 */
export function decodeAgyStepMetadata(
  raw: string | Uint8Array,
): DecodedAgyStepMetadata {
  const buf = decodeBase64(raw);
  const result: DecodedAgyStepMetadata = {
    createdAt: null,
    finishedGeneratingAt: null,
    completedAt: null,
    messageId: null,
    executionId: null,
  };
  walkProto(buf, (field, wire, value) => {
    if (wire !== 2 || !(value instanceof Uint8Array)) return;
    if (field === 1) result.createdAt = decodeTimestamp(value);
    else if (field === 7) result.finishedGeneratingAt = decodeTimestamp(value);
    else if (field === 8) result.completedAt = decodeTimestamp(value);
    else if (field === 9) {
      walkProto(value, (subField, subWire, subVal) => {
        if (subField === 7 && subWire === 2 && subVal instanceof Uint8Array) {
          const id = Buffer.from(subVal).toString("utf8").trim();
          if (id) result.messageId = id;
        }
      });
    } else if (field === 12) {
      const id = Buffer.from(value).toString("utf8").trim();
      if (id) result.executionId = id;
    }
  });
  return result;
}

export interface NormalizedAgyModel {
  model: string;
  upstreamModel: string | null;
  reasoningEffort: string | null;
}

/**
 * exa.codeium_common_pb.Model 枚举值到规范模型与默认思考档位的映射。
 * 优先使用上游返回的 response_model 字符串；只有缺失时才回退到显示名或枚举值。
 */
const enumModels: Record<number, { model: string; effort?: string }> = {
  342: { model: "gpt-oss-120b", effort: "medium" },
  1007: { model: "gemini-4-argon", effort: "low" },
  1008: { model: "gemini-4-argon", effort: "high" },
  1018: { model: "gemini-3.8-flash" },
  1026: { model: "claude-opus-4-6" },
  1035: { model: "claude-sonnet-5-5" },
  1036: { model: "gemini-3.8-flash", effort: "low" },
  1037: { model: "gemini-3.8-flash", effort: "high" },
  1042: { model: "claude-opus-5-5", effort: "low" },
  1043: { model: "claude-opus-5-5", effort: "medium" },
  1044: { model: "claude-opus-5-5", effort: "high" },
  1045: { model: "claude-sonnet-5-5", effort: "low" },
  1046: { model: "claude-sonnet-5-5", effort: "medium" },
  1047: { model: "claude-sonnet-5-5", effort: "high" },
  1050: { model: "gemini-3.1-flash-lite", effort: "low" },
  1198: { model: "gemini-3.5-flash-lite", effort: "low" },
  1318: { model: "gemini-3.8-flash", effort: "high" },
  1319: { model: "gemini-3.8-flash", effort: "medium" },
  1320: { model: "gemini-3.8-flash", effort: "low" },
  1322: { model: "gemini-3.8-flash", effort: "high" },
  1400: { model: "claude-opus-5-5", effort: "low" },
  1401: { model: "claude-opus-5-5", effort: "medium" },
  1402: { model: "claude-opus-5-5", effort: "high" },
  1403: { model: "claude-sonnet-5-5", effort: "low" },
  1404: { model: "claude-sonnet-5-5", effort: "medium" },
  1405: { model: "claude-sonnet-5-5", effort: "high" },
  1417: { model: "gemini-4-argon", effort: "high" },
  1418: { model: "gemini-4-argon", effort: "medium" },
  1419: { model: "gemini-4-argon", effort: "low" },
  1427: { model: "gemini-4-carbon", effort: "high" },
  1437: { model: "gemini-4-carbon", effort: "medium" },
  1438: { model: "gemini-4-carbon", effort: "low" },
  1525: { model: "gemini-4-hydrogen", effort: "high" },
  1526: { model: "gemini-4-hydrogen", effort: "medium" },
  1527: { model: "gemini-4-hydrogen", effort: "low" },
  1528: { model: "gemini-4-hydrogen", effort: "xhigh" },
  1532: { model: "gemini-4-neon", effort: "high" },
};

const displayModels: Record<string, string> = {
  "gemini 4 neon": "gemini-4-neon",
  "gemini 4 hydrogen": "gemini-4-hydrogen",
  "gemini 4 carbon": "gemini-4-carbon",
  "gemini 4 argon": "gemini-4-argon",
  "gemini 3.8 flash": "gemini-3.8-flash",
  "gemini 3.5 flash lite": "gemini-3.5-flash-lite",
  "gemini 3.1 flash lite": "gemini-3.1-flash-lite",
  "claude opus 5.5": "claude-opus-5-5",
  "claude sonnet 5.5": "claude-sonnet-5-5",
  "gpt-oss 120b": "gpt-oss-120b",
  "claude opus 4.6": "claude-opus-4-6",
};

/**
 * 归一化 Antigravity 模型标识并提取思考档位。
 * 例如 claude-opus-5-5-medium 归为 claude-opus-5-5（reasoningEffort: medium），
 * gemini-3.8-flash-n（关闭思考的 3.8 Flash 路由变体）归为 gemini-3.8-flash。
 */
export function normalizeAgyModel(input: {
  responseModel?: string | null;
  modelDisplayName?: string | null;
  modelEnum?: number | null;
}): NormalizedAgyModel | null {
  let effort: string | null = null;
  const display = input.modelDisplayName?.trim() ?? "";
  const displayMatch = /\((Low|Medium|High|XHigh|Max|Minimal)\)$/i.exec(
    display,
  );
  if (displayMatch) effort = displayMatch[1]!.toLowerCase();

  const rawResponse = input.responseModel?.trim() ?? "";
  if (rawResponse) {
    let cleaned = rawResponse
      .toLowerCase()
      .replace(/^(?:models|publishers\/[^/]+\/models|openai)\//, "")
      .replace(/-maas$/, "")
      // claude-opus-4-6-thinking 只是开启思考的路由名，思考 token 按输出计价，没有单独费率。
      .replace(/^(claude-[a-z]+-[0-9]+(?:-[0-9]+)*)-thinking$/, "$1");
    if (cleaned === "gemini-3.8-flash-n") {
      return {
        model: "gemini-3.8-flash",
        upstreamModel: rawResponse,
        reasoningEffort: effort ?? "none",
      };
    }
    if (cleaned === "gemini-3.8-flash-tiered") {
      return {
        model: "gemini-3.8-flash",
        upstreamModel: rawResponse,
        reasoningEffort: effort ?? "high",
      };
    }
    const effortSuffix =
      /^(claude-(?:opus|sonnet|haiku|fable)-[0-9]+(?:-[0-9]+)*|gemini-[a-z0-9.-]+|gpt-oss-120b)-(low|medium|high|xhigh|max|minimal)$/.exec(
        cleaned,
      );
    if (effortSuffix) {
      cleaned = effortSuffix[1]!;
      effort ??= effortSuffix[2]!;
    }
    if (!effort && input.modelEnum && enumModels[input.modelEnum]?.effort) {
      effort = enumModels[input.modelEnum]!.effort!;
    }
    return {
      model: cleaned,
      upstreamModel: rawResponse !== cleaned ? rawResponse : null,
      reasoningEffort: effort,
    };
  }

  if (display) {
    const baseDisplay = display
      .replace(/\s*\([^)]+\)$/, "")
      .trim()
      .toLowerCase();
    const mapped = displayModels[baseDisplay];
    if (mapped) {
      return {
        model: mapped,
        upstreamModel: null,
        reasoningEffort:
          effort ??
          (input.modelEnum
            ? (enumModels[input.modelEnum]?.effort ?? null)
            : null),
      };
    }
  }

  if (input.modelEnum && enumModels[input.modelEnum]) {
    const entry = enumModels[input.modelEnum]!;
    return {
      model: entry.model,
      upstreamModel: null,
      reasoningEffort: effort ?? entry.effort ?? null,
    };
  }

  return null;
}

export type ExtractedAgyTokens =
  | {
      kind: "usage";
      tokens: IngestUsage["tokens"];
      tier: string | null;
    }
  | { kind: "aborted" }
  | { kind: "empty" }
  | { kind: "invalid" };

/**
 * 从 ModelUsageStats 提取互斥四桶与思考子集。
 * - proto3 对数值为 0 的标量字段在编码时省略：当 #2（input_tokens）存在时，已完成的
 *   ModelUsageStats 中省略的 #4（cache_write_tokens）与 #5（cache_read_tokens）即为 0；
 *   当 #2 缺失时，输入与缓存桶均保持 null，绝不补零。
 * - #3（output_tokens）是含思考的总输出，#9（thinking_output_tokens）与 #10（response_output_tokens）
 *   是其两个互斥子集；当 #9 省略但 #3 与 #10 同时存在且相等时，思考量为 0；#9 与 #10 都缺失时
 *   思考量保持 null。
 */
export function extractAgyTokens(
  decoded: DecodedAgyGenMetadata,
): ExtractedAgyTokens {
  const usage = decoded.chatModel?.usage;
  if (!usage || !usage.hasAnyTokenField) {
    return decoded.error ? { kind: "aborted" } : { kind: "empty" };
  }
  const input = usage.inputTokens;
  const output =
    usage.outputTokens !== null
      ? usage.outputTokens
      : usage.responseOutputTokens !== null &&
          usage.thinkingOutputTokens !== null
        ? usage.responseOutputTokens + usage.thinkingOutputTokens
        : null;
  const cacheRead =
    usage.cacheReadTokens !== null
      ? usage.cacheReadTokens
      : input !== null
        ? 0
        : null;
  const cacheWrite =
    usage.cacheWriteTokens !== null
      ? usage.cacheWriteTokens
      : input !== null
        ? 0
        : null;
  let reasoning: number | null = null;
  if (usage.thinkingOutputTokens !== null) {
    reasoning = usage.thinkingOutputTokens;
  } else if (
    usage.outputTokens !== null &&
    usage.responseOutputTokens !== null
  ) {
    if (usage.outputTokens < usage.responseOutputTokens) {
      return { kind: "invalid" };
    }
    reasoning = usage.outputTokens - usage.responseOutputTokens;
  }

  if (reasoning !== null && output !== null && reasoning > output) {
    return { kind: "invalid" };
  }
  if (
    usage.responseOutputTokens !== null &&
    reasoning !== null &&
    output !== null &&
    usage.responseOutputTokens + reasoning !== output
  ) {
    return { kind: "invalid" };
  }

  const rawTier = usage.serviceTier?.trim().toLowerCase() ?? null;
  const tier =
    rawTier &&
    ["standard", "priority", "flex", "fast", "default"].includes(rawTier)
      ? rawTier
      : null;

  return {
    kind: "usage",
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
  };
}

export interface AgyReaderSources {
  conversationsDir: string;
  statuslineDir: string;
  start: string;
  /** 可选：是否允许 sync 按需运行 agy -p /usage（或 omp usage）刷新额度缓存；默认 false。 */
  quotaRefresh?: boolean;
  /** 可选：显式指定要采集的 Antigravity 实例 appDataDir 绝对路径列表；设置后不再自动发现默认目录或同级目录。 */
  appDataDirs?: readonly string[];
  /** 可选：动态读取账号池清单文件（accounts.json）中启用且就绪的非默认实例目录。 */
  poolAccountsFile?: string;
  /** 可选：上游未报出精确套餐倍数（如未提供或只报 Google AI Ultra）时的默认套餐。 */
  defaultPlan?: string | null;
  /** 可选：本机默认 .gemini 根目录，确保即使覆盖 conversationsDir 也能识别并排除默认目录下的范围外共享库。 */
  defaultGeminiDir?: string;
}

export interface AgyReaderReport extends SourceReaderReport {
  filesRead: number;
  beforeStart: number;
  unreadable: number;
  quotas: number;
  quotaIgnoredLines: number;
  activeAccount: string | null;
  /** 存在尚未生成额度缓存的已登录额外实例，供 sync 首次补刷额度。 */
  missingQuotaProfiles: number;
  /** 显式/池模式下因可被范围外实例访问而整库跳过的共享会话库数量。 */
  skippedOutOfScopeShared: number;
  /** 本轮是否按需运行了 agy -p /usage 并写出新的额度缓存。 */
  quotaRefreshed: boolean;
  /** 本轮按需刷新失败的原因；未尝试或成功时为 null。 */
  quotaRefreshError: string | null;
}

export function emptyAgyReport(): AgyReaderReport {
  return {
    ...emptySourceReport("agy"),
    filesRead: 0,
    beforeStart: 0,
    unreadable: 0,
    quotas: 0,
    quotaIgnoredLines: 0,
    activeAccount: null,
    missingQuotaProfiles: 0,
    skippedOutOfScopeShared: 0,
    quotaRefreshed: false,
    quotaRefreshError: null,
  };
}
export function readPlanMap(state: CollectorState): Record<string, string> {
  try {
    const raw = JSON.parse(state.getMeta("agy_plans") ?? "{}") as Record<
      string,
      unknown
    >;
    const result: Record<string, string> = {};
    for (const [label, value] of Object.entries(raw)) {
      if (typeof value === "string" && value.length > 0) result[label] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 只读打开 Antigravity 会话 SQLite。
 * - 没有 .db-wal 时，使用 file:...?mode=ro&immutable=1 打开，不在 ~/.gemini 下创建 -shm/-wal。
 * - 存在 .db-wal（会话正在运行或尚未 checkpoint）时，把 .db 与 .db-wal 复制到系统临时目录再只读打开，
 *   既能读到 WAL 里已提交的最新轮次，又不在 ~/.gemini 下写入或加锁。
 */
function openConversationDb(
  path: string,
): { db: Database; close: () => void } | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const walPath = `${path}-wal`;
  if (existsSync(walPath)) {
    let tempDir: string | null = null;
    try {
      tempDir = mkdtempSync(join(tmpdir(), "meterleaf-agy-db-"));
      const copyDb = join(tempDir, "conversation.db");
      copyFileSync(path, copyDb);
      try {
        copyFileSync(walPath, `${copyDb}-wal`);
      } catch {
        // WAL 在复制瞬间刚被 checkpoint 删除时忽略。
      }
      const db = new Database(copyDb, { readonly: true });
      const dirToClean = tempDir;
      return {
        db,
        close: () => {
          try {
            db.close();
          } finally {
            rmSync(dirToClean, { recursive: true, force: true });
          }
        },
      };
    } catch {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  try {
    const uri = `${pathToFileURL(path).href}?mode=ro&immutable=1`;
    const db = new Database(uri, { readonly: true });
    return { db, close: () => db.close() };
  } catch {
    // Linux 上的 SQLite 默认不解析 file: URI 参数，回退到普通路径只读打开。
    try {
      const db = new Database(path, { readonly: true });
      return { db, close: () => db.close() };
    } catch {
      return null;
    }
  }
}

interface StepTimeIndex {
  byExecutionId: Map<string, string>;
  byMessageId: Map<string, string>;
  byStepIdx: Map<number, string>;
  fallbackLatest: string | null;
}

function buildStepTimeIndex(db: Database): StepTimeIndex {
  const byExecutionId = new Map<string, string>();
  const byMessageId = new Map<string, string>();
  const byStepIdx = new Map<number, string>();
  let fallbackLatest: string | null = null;

  const hasSteps = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'steps'",
    )
    .get();
  if (!hasSteps) {
    return { byExecutionId, byMessageId, byStepIdx, fallbackLatest };
  }

  let rows: { idx: number; metadata: string | Uint8Array | null }[] = [];
  try {
    rows = db
      .query<{ idx: number; metadata: string | Uint8Array | null }, []>(
        "SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC",
      )
      .all();
  } catch {
    return { byExecutionId, byMessageId, byStepIdx, fallbackLatest };
  }

  for (const row of rows) {
    if (!row.metadata) continue;
    let meta: DecodedAgyStepMetadata;
    try {
      meta = decodeAgyStepMetadata(row.metadata);
    } catch {
      continue;
    }
    const timestamp =
      meta.completedAt ?? meta.finishedGeneratingAt ?? meta.createdAt;
    if (!timestamp) continue;
    byStepIdx.set(row.idx, timestamp);
    if (!fallbackLatest || timestamp > fallbackLatest)
      fallbackLatest = timestamp;
    if (meta.executionId) {
      const prev = byExecutionId.get(meta.executionId);
      if (!prev || timestamp > prev)
        byExecutionId.set(meta.executionId, timestamp);
    }
    if (meta.messageId) {
      const prev = byMessageId.get(meta.messageId);
      if (!prev || timestamp > prev) byMessageId.set(meta.messageId, timestamp);
    }
  }
  return { byExecutionId, byMessageId, byStepIdx, fallbackLatest };
}

function resolveOccurredAt(
  decoded: DecodedAgyGenMetadata,
  steps: StepTimeIndex,
): string | null {
  if (decoded.executionId) {
    const matched = steps.byExecutionId.get(decoded.executionId);
    if (matched) return matched;
  }
  const messageId = decoded.chatModel?.usage?.messageId;
  if (messageId) {
    const matched = steps.byMessageId.get(messageId);
    if (matched) return matched;
  }
  let latestStep: string | null = null;
  for (const idx of decoded.stepIndices) {
    const at = steps.byStepIdx.get(idx);
    if (at && (!latestStep || at > latestStep)) latestStep = at;
  }
  if (latestStep) return latestStep;
  if (decoded.chatModel?.createdAt) return decoded.chatModel.createdAt;
  return steps.fallbackLatest;
}

const agyQuotaFileName = (label: string) => `quota-${label}.tsv`;

/** statuslineDir 下已有额度缓存的账号标签，按字母序。 */
function listAgyQuotaLabels(statuslineDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(statuslineDir).sort();
  } catch {
    return [];
  }
  const labels: string[] = [];
  for (const name of entries) {
    const match = /^quota-([a-z0-9][a-z0-9_-]{0,63})\.tsv$/.exec(name);
    if (match) labels.push(match[1]!);
  }
  return labels;
}

/** 当前活跃标签：优先 current-account，缺失时目录下只有一个额度缓存才采用它。 */
function activeAgyLabel(statuslineDir: string): string | null {
  const current = readAgyCurrentAccount(statuslineDir);
  if (current) return current;
  const labels = listAgyQuotaLabels(statuslineDir);
  return labels.length === 1 ? labels[0]! : null;
}

/** Antigravity 用量归属的账号：readAgy 与 omp 读取器共用，保证两条路径归到同一个账户。 */
export function resolveAgyActiveAccount(
  statuslineDir: string,
  state: CollectorState,
): { label: string | null; plan: string | null } {
  const label = activeAgyLabel(statuslineDir);
  return { label, plan: label ? (readPlanMap(state)[label] ?? null) : null };
}
/** 允许的额外 Antigravity 实例目录名：严格匹配 antigravity-cli-<名称>，排除默认目录 antigravity-cli。 */
export const AGY_EXTRA_DIR_NAME_RE =
  /^antigravity-cli-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 是否启用了显式/账号池采集范围（配置了 appDataDirs 或 poolAccountsFile）。 */
export function isAgyExplicitScope(
  sources: Pick<AgyReaderSources, "appDataDirs" | "poolAccountsFile">,
): boolean {
  return Boolean(sources.poolAccountsFile || sources.appDataDirs !== undefined);
}

interface AgyInstance {
  /** 实例全局身份键：默认实例为 null；位于默认 geminiDir 下为 profileName，其他父目录下带规范路径摘要后缀。 */
  id: string | null;
  /** 默认实例为 null；额外实例为 antigravity-cli-<name> 的后缀名。 */
  profileName: string | null;
  appDataDir: string;
  geminiDir: string;
  conversationsDir: string;
}

function computeInstanceId(
  profileName: string,
  realAppDataDir: string,
  defaultRealGeminiDir: string,
  fullHash = false,
): string {
  if (canonicalDir(dirname(realAppDataDir)) === defaultRealGeminiDir) {
    return profileName;
  }
  const digest = hash(realAppDataDir);
  return `${profileName}.${fullHash ? digest : digest.slice(0, 12)}`;
}

/** 额外实例必须存在非空普通文件 antigravity-oauth-token，避免在 macOS 触发 agy 弹浏览器登录。 */
function hasNonEmptyOAuthTokenFile(appDataDir: string): boolean {
  try {
    const stat = lstatSync(join(appDataDir, "antigravity-oauth-token"));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export interface AgyTier {
  id: string;
  name: string;
}

const controlCharsRe = /[\x00-\x1f\x7f]/g;

function sanitizeTierField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(controlCharsRe, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 128) : null;
}

/**
 * 从 `agy acp` `session/new` 的 JSON-RPC 响应中提取官方订阅套餐元数据
 *（`result._meta.antigravity.tier = { id, name }`）；其它消息或缺失字段返回 null。
 */
export function extractAcpSessionTier(message: unknown): AgyTier | null {
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return null;
  const result = (message as { result?: unknown }).result;
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return null;
  const meta = (result as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta))
    return null;
  const antigravity = (meta as { antigravity?: unknown }).antigravity;
  if (
    typeof antigravity !== "object" ||
    antigravity === null ||
    Array.isArray(antigravity)
  )
    return null;
  const tier = (antigravity as { tier?: unknown }).tier;
  if (typeof tier !== "object" || tier === null || Array.isArray(tier))
    return null;
  const id = sanitizeTierField((tier as { id?: unknown }).id);
  const name = sanitizeTierField((tier as { name?: unknown }).name);
  if (!id && !name) return null;
  return { id: id ?? name!, name: name ?? id! };
}

/** 将官方 AgyTier 归一化为 Meterleaf 的 Google 套餐标识（与 src/web/lib/plan.ts 及 ingest 长度限制对齐）。 */
export function normalizeAgyTierPlan(
  tier: AgyTier | null | undefined,
): string | null {
  if (!tier) return null;
  const id = sanitizeTierField(tier.id) ?? "";
  const name = sanitizeTierField(tier.name) ?? "";
  const combined = `${id} ${name}`.toLowerCase().trim();
  if (!combined) return null;
  if (combined.includes("ultra")) {
    if (/\b20x\b/.test(combined)) return "ultra-20x";
    if (/\b5x\b/.test(combined)) return "ultra-5x";
    return "Google AI Ultra";
  }
  if (
    combined.includes("enterprise") ||
    combined.includes("business") ||
    /\bge-(?:standard|plus)\b/.test(combined)
  ) {
    if (combined.includes("plus")) return "Gemini Enterprise Plus";
    return "Gemini Enterprise";
  }
  if (/\bpro\b/.test(combined) || combined.includes("g1-pro")) {
    return "Google AI Pro";
  }
  if (/\bplus\b/.test(combined) || combined.includes("g1-plus")) {
    return "Google AI Plus";
  }
  if (
    combined.includes("free") ||
    combined.includes("individual") ||
    combined.includes("legacy-tier")
  ) {
    return "free";
  }
  return (name || id).slice(0, 64);
}

/** 上游未上报套餐或只报无倍数的 Google AI Ultra 时回退到配置的默认套餐。 */
function effectiveAgyPlan(
  observed: string | null,
  defaultPlan?: string | null,
): string | null {
  const fallback = defaultPlan?.trim() || null;
  if (!observed) return fallback;
  if (
    fallback &&
    observed.trim().toLowerCase() === "google ai ultra" &&
    (fallback === "ultra-5x" || fallback === "ultra-20x")
  ) {
    return fallback;
  }
  return observed;
}

interface PoolAccountsInspection {
  /** 清单文件是否成功读取且结构合法；为 false 时不能据此推断池成员已移出。 */
  ok: boolean;
  activeDirs: string[];
  inactiveDirs: string[];
  /** 账号池条目真实目录（canonicalDir）到池内账户 id 的映射，用于读取同目录 routing-state.json 套餐缓存。 */
  accountIdByDir: Map<string, string>;
}

/** 从账号池清单文件（accounts.json）解析启用且就绪与已暂停/移出的非默认实例目录列表。 */
function inspectPoolAccountsFile(
  poolAccountsFile: string,
  geminiDir: string,
): PoolAccountsInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(poolAccountsFile, "utf8"));
  } catch {
    return {
      ok: false,
      activeDirs: [],
      inactiveDirs: [],
      accountIdByDir: new Map(),
    };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { accounts?: unknown }).accounts)
      ? (parsed as { accounts: unknown[] }).accounts
      : null;
  if (!list)
    return {
      ok: false,
      activeDirs: [],
      inactiveDirs: [],
      accountIdByDir: new Map(),
    };
  const activeDirs: string[] = [];
  const inactiveDirs: string[] = [];
  const accountIdByDir = new Map<string, string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as {
      id?: unknown;
      kind?: unknown;
      enabled?: unknown;
      status?: unknown;
      removedAt?: unknown;
      appDataDir?: unknown;
    };
    if (record.kind === "default") continue;
    if (
      typeof record.appDataDir !== "string" ||
      record.appDataDir.trim() === ""
    )
      continue;
    const resolved = record.appDataDir.startsWith("/")
      ? resolve(record.appDataDir)
      : resolve(geminiDir, record.appDataDir);
    // 严格排除默认目录 antigravity-cli，防止误采非池实例。
    if (basename(resolved) === "antigravity-cli") continue;
    if (typeof record.id === "string" && record.id.trim() !== "") {
      accountIdByDir.set(canonicalDir(resolved), record.id.trim());
    }
    if (
      record.enabled === true &&
      record.status === "ready" &&
      !record.removedAt
    ) {
      activeDirs.push(resolved);
    } else {
      inactiveDirs.push(resolved);
    }
  }
  return { ok: true, activeDirs, inactiveDirs, accountIdByDir };
}

/** 读取账号池同目录 routing-state.json 中已缓存的套餐元数据（只读，缺失或损坏时静默返回空表）。 */
function readPoolRoutingTiers(
  poolAccountsFile: string,
  accountIdByDir: ReadonlyMap<string, string>,
): Map<string, string> {
  const result = new Map<string, string>();
  if (accountIdByDir.size === 0) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(
        join(dirname(poolAccountsFile), "routing-state.json"),
        "utf8",
      ),
    );
  } catch {
    return result;
  }
  const accounts =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as { accounts?: unknown }).accounts === "object" &&
    (parsed as { accounts?: unknown }).accounts !== null &&
    !Array.isArray((parsed as { accounts?: unknown }).accounts)
      ? (parsed as { accounts: Record<string, unknown> }).accounts
      : null;
  if (!accounts) return result;
  for (const [dir, accountId] of accountIdByDir) {
    const entry = Object.hasOwn(accounts, accountId)
      ? accounts[accountId]
      : null;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const tierObj = (entry as { tier?: unknown }).tier;
    if (!tierObj || typeof tierObj !== "object" || Array.isArray(tierObj))
      continue;
    const id = sanitizeTierField((tierObj as { id?: unknown }).id);
    const name = sanitizeTierField((tierObj as { name?: unknown }).name);
    if (!id && !name) continue;
    const normalized = normalizeAgyTierPlan({
      id: id ?? name!,
      name: name ?? id!,
    });
    if (normalized) result.set(dir, normalized);
  }
  return result;
}

interface PoolQuotaWindowRaw {
  fiveHourUsedPct?: unknown;
  fiveHourResetsAt?: unknown;
  weeklyUsedPct?: unknown;
  weeklyResetsAt?: unknown;
}

interface PoolQuotaEntryRaw {
  sampledAtMs: number;
  gemini?: PoolQuotaWindowRaw | null;
  thirdParty?: PoolQuotaWindowRaw | null;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function parsePoolPercent(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1000
    ? value
    : null;
}

/**
 * 读取账号池同目录 quota-cache.json 中已缓存的额度快照（只读，缺失或损坏时返回空表）。
 * 账号池自身会定期探测各账号的 Gemini 与第三方模型池额度，直接复用可避免重复启动 agy 进程，
 * 也能在闲置账号窗口重置后及时同步最新读数。
 */
function readPoolQuotaEntries(
  poolAccountsFile: string,
  accountIdByDir: ReadonlyMap<string, string>,
): Map<string, PoolQuotaEntryRaw> {
  const result = new Map<string, PoolQuotaEntryRaw>();
  if (accountIdByDir.size === 0) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(join(dirname(poolAccountsFile), "quota-cache.json"), "utf8"),
    );
  } catch {
    return result;
  }
  const entries =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as { entries?: unknown }).entries === "object" &&
    (parsed as { entries?: unknown }).entries !== null &&
    !Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: Record<string, unknown> }).entries
      : null;
  if (!entries) return result;
  for (const [dir, accountId] of accountIdByDir) {
    const item = Object.hasOwn(entries, accountId) ? entries[accountId] : null;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as {
      sampledAt?: unknown;
      quota?: unknown;
    };
    const quota =
      record.quota &&
      typeof record.quota === "object" &&
      !Array.isArray(record.quota)
        ? (record.quota as {
            sampledAt?: unknown;
            gemini?: unknown;
            thirdParty?: unknown;
          })
        : null;
    if (!quota) continue;
    const sampledAtMs =
      parseIsoMs(quota.sampledAt) ?? parseIsoMs(record.sampledAt);
    if (sampledAtMs === null) continue;
    const gemini =
      quota.gemini &&
      typeof quota.gemini === "object" &&
      !Array.isArray(quota.gemini)
        ? (quota.gemini as PoolQuotaWindowRaw)
        : null;
    const thirdParty =
      quota.thirdParty &&
      typeof quota.thirdParty === "object" &&
      !Array.isArray(quota.thirdParty)
        ? (quota.thirdParty as PoolQuotaWindowRaw)
        : null;
    if (!gemini && !thirdParty) continue;
    result.set(dir, { sampledAtMs, gemini, thirdParty });
  }
  return result;
}

function buildPoolQuotaCacheForLabel(
  label: string,
  raw: PoolQuotaEntryRaw,
  now: Date,
): AgyQuotaCache | null {
  if (!isValidAgyLabel(label)) return null;
  const effectiveNowMs = Math.max(raw.sampledAtMs, now.getTime());
  const entries: AgyQuotaEntry[] = [];
  const pushBucket = (
    key: AgyWindowKey,
    usedValue: unknown,
    resetValue: unknown,
  ) => {
    const rawPercent = parsePoolPercent(usedValue);
    const resetMs = parseIsoMs(resetValue);
    if (rawPercent === null && resetMs === null) return;
    const spec = agyWindows[key];
    const expired = resetMs !== null && resetMs <= effectiveNowMs;
    entries.push({
      key,
      pool: spec.pool,
      accountExternalId: agyAccountId(label),
      window: spec.window,
      windowMinutes: spec.minutes,
      percent: expired ? null : rawPercent,
      resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
      expired,
    });
  };
  if (raw.gemini) {
    pushBucket(
      "gemini_5h",
      raw.gemini.fiveHourUsedPct,
      raw.gemini.fiveHourResetsAt,
    );
    pushBucket(
      "gemini_weekly",
      raw.gemini.weeklyUsedPct,
      raw.gemini.weeklyResetsAt,
    );
  }
  if (raw.thirdParty) {
    pushBucket(
      "3p_5h",
      raw.thirdParty.fiveHourUsedPct,
      raw.thirdParty.fiveHourResetsAt,
    );
    pushBucket(
      "3p_weekly",
      raw.thirdParty.weeklyUsedPct,
      raw.thirdParty.weeklyResetsAt,
    );
  }
  if (entries.length === 0) return null;
  return {
    label,
    sampledAt: new Date(raw.sampledAtMs).toISOString(),
    plan: null,
    entries,
    ignoredLines: 0,
  };
}

/** 判断缓存里是否存在「采样早于重置时间、现已过重置时间」的过期窗口，需要补刷一次最新读数。 */
function hasExpiredQuotaNeedingRefresh(cache: AgyQuotaCache): boolean {
  const sampledMs = Date.parse(cache.sampledAt);
  return cache.entries.some(
    (entry) =>
      entry.expired &&
      entry.resetsAt !== null &&
      Number.isFinite(sampledMs) &&
      sampledMs < Date.parse(entry.resetsAt),
  );
}

/** 读取本轮是否存在已过期等待补刷的 Antigravity 实例。 */
export function hasAgyExpiredQuota(state: CollectorState): boolean {
  try {
    const parsed = JSON.parse(
      state.getMeta("agy_expired_profiles") ?? "[]",
    ) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** 从账号池清单文件（accounts.json）读取当前启用且就绪的非默认实例目录列表；文件缺失或损坏时返回空数组。 */
function readPoolAppDataDirs(
  poolAccountsFile: string,
  geminiDir: string,
): string[] {
  return inspectPoolAccountsFile(poolAccountsFile, geminiDir).activeDirs;
}

/**
 * 列出所有需要扫描的 Antigravity CLI 实例。
 * - 若配置了 poolAccountsFile 或 appDataDirs，则仅采集对应显式/在池非默认实例，不扫描默认目录与其他同级目录；
 * - 否则默认实例取 sources.conversationsDir，位于 <geminiDir>/antigravity-cli/conversations 时自动发现同级已登录额外实例。
 */
function discoverAgyInstances(
  sources:
    | string
    | Pick<
        AgyReaderSources,
        | "conversationsDir"
        | "appDataDirs"
        | "poolAccountsFile"
        | "defaultGeminiDir"
      >,
): AgyInstance[] {
  const conversationsDir =
    typeof sources === "string" ? sources : sources.conversationsDir;
  const absConversationsDir = resolve(conversationsDir);
  const appDataDir = dirname(absConversationsDir);
  const geminiDir = dirname(appDataDir);
  const explicitMode =
    typeof sources !== "string" && isAgyExplicitScope(sources);
  const prefix = "antigravity-cli-";

  if (explicitMode && typeof sources !== "string") {
    const defaultRealAppDataDir = canonicalDir(appDataDir);
    const defaultRealGeminiDir = canonicalDir(geminiDir);
    const homeDefaultRealAppDataDir = sources.defaultGeminiDir
      ? canonicalDir(join(resolve(sources.defaultGeminiDir), "antigravity-cli"))
      : null;
    const rawCandidates: string[] = [];
    if (sources.poolAccountsFile) {
      rawCandidates.push(
        ...readPoolAppDataDirs(sources.poolAccountsFile, geminiDir),
      );
    }
    for (const dir of sources.appDataDirs ?? []) {
      rawCandidates.push(resolve(dir));
    }
    const seenRealDirs = new Set<string>();
    const usedIds = new Set<string>();
    const instances: AgyInstance[] = [];
    for (const dir of rawCandidates) {
      const resolved = resolve(dir);
      if (basename(resolved) === "antigravity-cli") continue;
      try {
        if (!statSync(resolved).isDirectory()) continue;
      } catch {
        continue;
      }
      const realDir = canonicalDir(resolved);
      // 排除默认目录及其软链接别名，并在解析真实路径后按统一命名规则与真实目录去重。
      if (
        basename(realDir) === "antigravity-cli" ||
        realDir === defaultRealAppDataDir ||
        (homeDefaultRealAppDataDir !== null &&
          realDir === homeDefaultRealAppDataDir)
      ) {
        continue;
      }
      const dirName = basename(realDir);
      if (!AGY_EXTRA_DIR_NAME_RE.test(dirName)) continue;
      if (seenRealDirs.has(realDir)) continue;
      seenRealDirs.add(realDir);
      if (!hasNonEmptyOAuthTokenFile(realDir)) continue;
      const profileName = dirName.slice(prefix.length);
      let id = computeInstanceId(profileName, realDir, defaultRealGeminiDir);
      if (usedIds.has(id)) {
        id = computeInstanceId(
          profileName,
          realDir,
          defaultRealGeminiDir,
          true,
        );
      }
      usedIds.add(id);
      instances.push({
        id,
        profileName,
        appDataDir: realDir,
        geminiDir: dirname(realDir),
        conversationsDir: join(realDir, "conversations"),
      });
    }
    instances.sort((a, b) => a.appDataDir.localeCompare(b.appDataDir));
    return instances;
  }

  const instances: AgyInstance[] = [
    {
      id: null,
      profileName: null,
      appDataDir,
      geminiDir,
      conversationsDir: absConversationsDir,
    },
  ];
  if (
    basename(absConversationsDir) !== "conversations" ||
    basename(appDataDir) !== "antigravity-cli"
  ) {
    return instances;
  }
  let entries: string[];
  try {
    entries = readdirSync(geminiDir).sort();
  } catch {
    return instances;
  }
  for (const name of entries) {
    if (!AGY_EXTRA_DIR_NAME_RE.test(name)) continue;
    const profileName = name.slice(prefix.length);
    const profileAppDataDir = join(geminiDir, name);
    try {
      if (!statSync(profileAppDataDir).isDirectory()) continue;
    } catch {
      continue;
    }
    // 跳过备份快照目录以及尚未完成登录（缺少非空普通文件 antigravity-oauth-token）的目录。
    if (
      /(?:^|[-_])(backup|bak)(?:$|[-_])/i.test(profileName) ||
      !hasNonEmptyOAuthTokenFile(profileAppDataDir)
    ) {
      continue;
    }
    instances.push({
      id: profileName,
      profileName,
      appDataDir: profileAppDataDir,
      geminiDir,
      conversationsDir: join(profileAppDataDir, "conversations"),
    });
  }
  return instances;
}

/** 从额外实例的 antigravity-oauth-token 文件（id_token_email 或 id_token JWT）提取账号标签，不保存完整邮箱或令牌。 */
function labelFromOAuthTokenFile(appDataDir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(appDataDir, "antigravity-oauth-token"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      id_token_email?: unknown;
      id_token?: unknown;
    } | null;
    if (
      typeof parsed?.id_token_email === "string" &&
      parsed.id_token_email.length > 0
    ) {
      const label = agyLabelFromEmail(parsed.id_token_email);
      if (label) return label;
    }
    if (typeof parsed?.id_token !== "string") return null;
    const parts = parsed.id_token.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { email?: unknown } | null;
    return typeof claims?.email === "string"
      ? agyLabelFromEmail(claims.email)
      : null;
  } catch {
    return null;
  }
}

/** 从实例目录最近几份 log/acp-server-*.log、log/cli-*.log 或 cli.log 中提取最近一次登录成功的账号标签。 */
function labelFromAppDataLogs(appDataDir: string): string | null {
  const candidates: string[] = [];
  try {
    const logDir = join(appDataDir, "log");
    const entries = readdirSync(logDir)
      .filter(
        (name) =>
          (name.startsWith("acp-server-") || name.startsWith("cli-")) &&
          name.endsWith(".log"),
      )
      .map((name) => {
        const path = join(logDir, name);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return { path, mtimeMs: 0 };
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
      .slice(0, 10);
    for (const entry of entries) candidates.push(entry.path);
  } catch {
    // 没有 log 子目录时只试 cli.log。
  }
  candidates.push(join(appDataDir, "cli.log"));
  for (const path of candidates) {
    try {
      const label = labelFromAgyLog(readFileSync(path, "utf8"));
      if (label) return label;
    } catch {
      // 继续检查下一份日志。
    }
  }
  return null;
}

interface AgyTurnAttribution {
  minAtMs: number;
  maxAtMs: number;
  label: string;
  profileName: string | null;
  instanceId: string | null;
  /** 2 = 实际发送用户消息（轮次级），1 = 创建/加载会话（会话级）。 */
  priority: 1 | 2;
}

const glogLineRe = /^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3,6})\s/;
const logFileDateRe = /(?:^|[-_])(\d{4})(\d{2})(\d{2})_/;
const oauthLineRe = /authenticated successfully as ([^\s]+)/;
const turnMessageRe =
  /(?:Sending user message to conversation |SEND_USER_CASCADE_MESSAGE_LATENCY[^\n]*\bcascade_id:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const sessionOpenRe =
  /(?:Created conversation |Loading\/Resuming session: )([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const dstProbeOffsetsMs = [
  -24 * 3600_000,
  -3 * 3600_000,
  0,
  3 * 3600_000,
  24 * 3600_000,
] as const;
const glogMtimeSlackMs = 1_000;
const glogMonotonicJitterMs = 60_000;

/**
 * 解析 glog 本地时间戳为所有合法的 epoch 毫秒候选（升序去重），结合日志文件名/修改时间的年月处理跨年边界。
 * 普通时刻返回单元素数组；夏令时回拨重复小时返回两个候选 [首次, 回拨后]，
 * 供文件内单调性与 mtime 上界进一步收窄，避免较晚发送的请求被解析到前一小时而抢占归属。
 */
function parseGlogTimestampCandidatesMs(
  line: string,
  anchorYear: number,
  anchorMonth: number,
  anchorFromStart: boolean,
): number[] | null {
  const match = glogLineRe.exec(line);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  const ms = Number(match[6]!.slice(0, 3));
  let year = anchorYear;
  if (anchorFromStart && anchorMonth === 12 && month === 1) year += 1;
  else if (!anchorFromStart && anchorMonth === 1 && month === 12) year -= 1;

  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const baseMs = new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    ms,
  ).getTime();
  if (!Number.isFinite(wallAsUtc) || !Number.isFinite(baseMs)) return null;

  const tzOffsets = new Set<number>();
  for (const deltaMs of dstProbeOffsetsMs) {
    tzOffsets.add(new Date(baseMs + deltaMs).getTimezoneOffset());
  }

  const candidates: number[] = [];
  for (const offsetMinutes of tzOffsets) {
    const candidate = wallAsUtc + offsetMinutes * 60_000;
    const d = new Date(candidate);
    if (
      d.getFullYear() === year &&
      d.getMonth() === month - 1 &&
      d.getDate() === day &&
      d.getHours() === hour &&
      d.getMinutes() === minute &&
      d.getSeconds() === second &&
      d.getMilliseconds() === ms
    ) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return [baseMs];
  candidates.sort((a, b) => a - b);
  return candidates;
}

/**
 * 利用单文件 mtime 的 UTC 上界与文件内前后行时间单调性（容忍 60s 内的并发刷盘乱序，
 * 远小于 30–60 分钟的夏令时回拨跨度）收窄重复本地小时的候选 epoch。
 */
function narrowFileGlogTimestamps(
  lines: readonly string[],
  anchorYear: number,
  anchorMonth: number,
  anchorFromStart: boolean,
  fileMtimeMs: number,
): (number[] | null)[] {
  const perLine = lines.map((line) =>
    parseGlogTimestampCandidatesMs(
      line,
      anchorYear,
      anchorMonth,
      anchorFromStart,
    ),
  );
  const maxAllowedMs = Number.isFinite(fileMtimeMs)
    ? Math.ceil(fileMtimeMs) + glogMtimeSlackMs
    : Number.POSITIVE_INFINITY;

  for (let i = 0; i < perLine.length; i += 1) {
    const cands = perLine[i];
    if (!cands || cands.length <= 1) continue;
    const bounded = cands.filter((t) => t <= maxAllowedMs);
    if (bounded.length > 0) perLine[i] = bounded;
  }

  let prevMinMs = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < perLine.length; i += 1) {
    let cands = perLine[i];
    if (!cands || cands.length === 0) continue;
    if (cands.length > 1 && Number.isFinite(prevMinMs)) {
      const forward = cands.filter(
        (t) => t >= prevMinMs - glogMonotonicJitterMs,
      );
      if (forward.length > 0) {
        cands = forward;
        perLine[i] = cands;
      }
    }
    if (cands[0]! > prevMinMs) prevMinMs = cands[0]!;
  }

  let nextMaxMs = Number.POSITIVE_INFINITY;
  for (let i = perLine.length - 1; i >= 0; i -= 1) {
    let cands = perLine[i];
    if (!cands || cands.length === 0) continue;
    if (cands.length > 1 && Number.isFinite(nextMaxMs)) {
      const backward = cands.filter(
        (t) => t <= nextMaxMs + glogMonotonicJitterMs,
      );
      if (backward.length > 0) {
        cands = backward;
        perLine[i] = cands;
      }
    }
    const last = cands[cands.length - 1]!;
    if (last < nextMaxMs) nextMaxMs = last;
  }

  return perLine;
}

interface CachedSharedLogEvent {
  convId: string;
  minAtMs: number;
  maxAtMs: number;
  label: string;
  profileName: string | null;
  instanceId?: string | null;
  priority: 1 | 2;
}

/** 轻量枚举实例当前存在的日志文件路径（不读取正文），用于共享日志缓存裁剪。 */
function listInstanceLogPaths(appDataDir: string): string[] {
  const paths: string[] = [];
  const collectIfFile = (path: string) => {
    try {
      if (statSync(path).isFile()) paths.push(path);
    } catch {
      // 忽略不存在或读取瞬间消失的日志。
    }
  };
  const logDir = join(appDataDir, "log");
  try {
    for (const name of readdirSync(logDir)) {
      if (
        !(name.startsWith("acp-server-") || name.startsWith("cli-")) ||
        !name.endsWith(".log")
      ) {
        continue;
      }
      collectIfFile(join(logDir, name));
    }
  } catch {
    // 没有 log 子目录时只试 cli.log。
  }
  collectIfFile(join(appDataDir, "cli.log"));
  return paths;
}

export interface SharedLogFileOps {
  openSync: (path: string, flags: string) => number;
  fstatSync: (fd: number) => {
    isFile(): boolean;
    mtimeMs: number;
    size?: number;
    ino?: number | bigint;
  };
  readFileSync: (fd: number, encoding: "utf8") => string;
  closeSync: (fd: number) => void;
}

/**
 * 多个账号通过软链共享同一个 conversations/ 目录或会话库文件时，读取各实例隔离的 log/ 目录，
 * 提取本次待扫描会话的账号切换与发消息时间点，使跨账号加载的同一会话也能按轮次精准归账。
 * 解析结果按日志文件的 inode/size/mtime 缓存在 CollectorState 中，未变动的老日志不重复读盘。
 */
function indexSharedConversationLogs(
  state: CollectorState,
  members: readonly { instance: AgyInstance; label: string | null }[],
  conversationIds: ReadonlySet<string>,
  presentLogPaths: Set<string>,
  logFileOps?: Partial<SharedLogFileOps>,
): Map<string, AgyTurnAttribution[]> {
  const index = new Map<string, AgyTurnAttribution[]>();
  if (conversationIds.size === 0) return index;
  const ops: SharedLogFileOps = {
    openSync,
    fstatSync,
    readFileSync,
    closeSync,
    ...logFileOps,
  };
  const pendingCacheWrites: {
    path: string;
    inode: string;
    size: number;
    modified: number;
    defaultLabel: string;
    events: string;
  }[] = [];

  for (const { instance, label: defaultLabel } of members) {
    const candidateFiles: {
      path: string;
      inode: string;
      size: number;
      mtimeMs: number;
    }[] = [];
    for (const path of listInstanceLogPaths(instance.appDataDir)) {
      try {
        const st = statSync(path);
        if (st.isFile()) {
          candidateFiles.push({
            path,
            inode: String(st.ino),
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      } catch {
        // 忽略不存在或读取瞬间消失的日志。
      }
    }

    const defaultLabelKey = `${instance.id ?? ""}\0${defaultLabel ?? ""}`;
    for (const candidate of candidateFiles) {
      const filePath = candidate.path;
      presentLogPaths.add(filePath);
      const cached = state.agySharedLog(filePath);
      if (
        cached &&
        cached.inode === candidate.inode &&
        cached.size === candidate.size &&
        cached.modified === candidate.mtimeMs &&
        cached.defaultLabel === defaultLabelKey
      ) {
        try {
          const parsed = JSON.parse(cached.events) as CachedSharedLogEvent[];
          for (const ev of parsed) {
            if (!conversationIds.has(ev.convId)) continue;
            const list = index.get(ev.convId) ?? [];
            list.push({
              minAtMs: ev.minAtMs,
              maxAtMs: ev.maxAtMs,
              label: ev.label,
              profileName: ev.profileName,
              instanceId:
                ev.instanceId !== undefined ? ev.instanceId : instance.id,
              priority: ev.priority,
            });
            index.set(ev.convId, list);
          }
          continue;
        } catch {
          // 缓存损坏时回退到重读文件。
        }
      }

      let raw: string;
      let postReadMtimeMs: number;
      let postReadSize: number;
      let postReadInode: string;
      let fd: number | null = null;
      try {
        fd = ops.openSync(filePath, "r");
        const preStat = ops.fstatSync(fd);
        if (!preStat.isFile()) continue;
        raw = ops.readFileSync(fd, "utf8");
        // 在正文读完后对同一文件描述符 fstat，确保 mtime 上界与缓存水位不早于本次读到的任何追加内容。
        const postStat = ops.fstatSync(fd);
        postReadMtimeMs = Math.max(preStat.mtimeMs, postStat.mtimeMs);
        postReadSize = postStat.size ?? preStat.size ?? candidate.size;
        postReadInode =
          postStat.ino !== undefined
            ? String(postStat.ino)
            : preStat.ino !== undefined
              ? String(preStat.ino)
              : candidate.inode;
      } catch {
        continue;
      } finally {
        if (fd !== null) {
          try {
            ops.closeSync(fd);
          } catch {
            // 忽略关闭异常。
          }
        }
      }

      const dateMatch = logFileDateRe.exec(basename(filePath));
      const mtimeDate = new Date(postReadMtimeMs);
      const anchorYear = dateMatch
        ? Number(dateMatch[1])
        : mtimeDate.getFullYear();
      const anchorMonth = dateMatch
        ? Number(dateMatch[2])
        : mtimeDate.getMonth() + 1;
      const anchorFromStart = Boolean(dateMatch);

      const lines = raw.split("\n");
      const pending: {
        lineIdx: number;
        convId: string;
        label: string;
        priority: 1 | 2;
        cands: number[];
      }[] = [];
      let hasAmbiguous = false;
      let currentLabel = defaultLabel;
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
        const line = lines[lineIdx]!;
        const auth = oauthLineRe.exec(line);
        if (auth?.[1]) {
          const parsedLabel = agyLabelFromEmail(auth[1]);
          if (parsedLabel) currentLabel = parsedLabel;
          continue;
        }
        if (!currentLabel) continue;
        const turnMatch = turnMessageRe.exec(line);
        const openMatch = turnMatch ? null : sessionOpenRe.exec(line);
        const convId = turnMatch?.[1] ?? openMatch?.[1] ?? null;
        if (!convId) continue;
        const cands = parseGlogTimestampCandidatesMs(
          line,
          anchorYear,
          anchorMonth,
          anchorFromStart,
        );
        if (!cands || cands.length === 0) continue;
        if (cands.length > 1) hasAmbiguous = true;
        pending.push({
          lineIdx,
          convId,
          label: currentLabel,
          priority: turnMatch ? 2 : 1,
          cands,
        });
      }

      const narrowed = hasAmbiguous
        ? narrowFileGlogTimestamps(
            lines,
            anchorYear,
            anchorMonth,
            anchorFromStart,
            postReadMtimeMs,
          )
        : null;

      const fileEvents: CachedSharedLogEvent[] = [];
      for (const item of pending) {
        const cands = narrowed?.[item.lineIdx] ?? item.cands;
        if (!cands || cands.length === 0) continue;
        const ev: CachedSharedLogEvent = {
          convId: item.convId,
          minAtMs: cands[0]!,
          maxAtMs: cands[cands.length - 1]!,
          label: item.label,
          profileName: instance.profileName,
          instanceId: instance.id,
          priority: item.priority,
        };
        fileEvents.push(ev);
        if (!conversationIds.has(item.convId)) continue;
        const list = index.get(item.convId) ?? [];
        list.push({
          minAtMs: ev.minAtMs,
          maxAtMs: ev.maxAtMs,
          label: ev.label,
          profileName: ev.profileName,
          instanceId: instance.id,
          priority: ev.priority,
        });
        index.set(item.convId, list);
      }
      pendingCacheWrites.push({
        path: filePath,
        inode: postReadInode,
        size: postReadSize,
        modified: postReadMtimeMs,
        defaultLabel: defaultLabelKey,
        events: JSON.stringify(fileEvents),
      });
    }
  }

  if (pendingCacheWrites.length > 0) {
    state.write(() => {
      for (const item of pendingCacheWrites) state.saveAgySharedLog(item);
    });
  }

  for (const list of index.values()) {
    list.sort(
      (a, b) =>
        a.maxAtMs - b.maxAtMs ||
        a.minAtMs - b.minAtMs ||
        a.priority - b.priority,
    );
  }
  return index;
}

/**
 * 取所有合法候选时刻均严格早于事件完成时刻（`event.maxAtMs < occurredAtMs`）的最近一次轮次归属：
 * - 因毫秒截断具有单调性（`t_next >= t_done => floor(t_next) >= floor(t_done)`），严格 `<`
 *   可在毫秒精度下保证完成时刻之后（含同毫秒内）的下一轮发送绝不抢占上一轮；
 * - 夏令时回拨重复小时若收窄后仍存在前后两小时双候选，要求 `maxAtMs < occurredAtMs` 才采信，
 *   防止回拨后较晚发送的请求被按较早一小时错误归到先前已完成的轮次；
 * - 优先采用实际发送请求事件（priority=2），防止另一账号仅被动打开/加载同一会话（priority=1）
 *   在生成期间覆盖正在运行的发送者；仅当截止时间前没有任何发送记录时，才回退到最近的打开事件。
 */
function resolveSharedTurnAttribution(
  events: readonly AgyTurnAttribution[] | undefined,
  occurredAtMs: number,
): {
  label: string;
  profileName: string | null;
  instanceId: string | null;
} | null {
  if (!events || events.length === 0 || !Number.isFinite(occurredAtMs)) {
    return null;
  }
  let matchedTurn: AgyTurnAttribution | null = null;
  let matchedOpen: AgyTurnAttribution | null = null;
  for (const event of events) {
    if (event.maxAtMs >= occurredAtMs) break;
    if (event.priority >= 2) {
      matchedTurn = event;
    } else {
      matchedOpen = event;
    }
  }
  const matched = matchedTurn ?? matchedOpen;
  return matched
    ? {
        label: matched.label,
        profileName: matched.profileName,
        instanceId: matched.instanceId,
      }
    : null;
}

function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 解析单个 Antigravity CLI 实例对应的账号标签：
 * - 额外实例优先读自身的 antigravity-oauth-token，再读 current-account-<profile>，最后回退到日志，
 *   绝不回退到默认实例的 current-account，避免未登录或刚创建的额外目录串号到默认账户；
 * - 默认实例优先读 current-account，再回退到自身的令牌、日志或单一 quota-<label>.tsv。
 */
function resolveInstanceLabel(
  instance: AgyInstance,
  statuslineDir: string,
): string | null {
  if (instance.profileName !== null) {
    return (
      labelFromOAuthTokenFile(instance.appDataDir) ??
      readAgyCurrentAccount(statuslineDir, instance.id) ??
      labelFromAppDataLogs(instance.appDataDir)
    );
  }
  return (
    readAgyCurrentAccount(statuslineDir, null) ??
    labelFromOAuthTokenFile(instance.appDataDir) ??
    labelFromAppDataLogs(instance.appDataDir) ??
    activeAgyLabel(statuslineDir)
  );
}
/** 本机每个 Antigravity CLI 实例当前登录的账户；默认实例 profile 与 key 为 null，未识别时 account 为 null。 */
export function agyInstanceAccounts(
  sources: Pick<
    AgyReaderSources,
    | "conversationsDir"
    | "statuslineDir"
    | "appDataDirs"
    | "poolAccountsFile"
    | "defaultGeminiDir"
  >,
): {
  appDataDir: string;
  profile: string | null;
  key: string | null;
  account: string | null;
}[] {
  return discoverAgyInstances(sources).map((instance) => {
    const label = resolveInstanceLabel(instance, sources.statuslineDir);
    return {
      appDataDir: instance.appDataDir,
      profile: instance.profileName,
      key: instance.id,
      account: label ? agyAccountId(label) : null,
    };
  });
}

/**
 * 显式/池模式下允许上报与刷新额度的账号标签集合；默认模式返回 null（不限制）。
 */
export function agyAllowedQuotaLabels(
  sources: Pick<
    AgyReaderSources,
    | "conversationsDir"
    | "statuslineDir"
    | "appDataDirs"
    | "poolAccountsFile"
    | "defaultGeminiDir"
  >,
): Set<string> | null {
  if (!isAgyExplicitScope(sources)) return null;
  const labels = new Set<string>();
  for (const instance of discoverAgyInstances(sources)) {
    const label = resolveInstanceLabel(instance, sources.statuslineDir);
    if (label) labels.add(label);
  }
  return labels;
}

/** 清理显式/池模式下已移出采集范围的实例遗留的额度刷新状态元信息。 */
function pruneStaleAgyRefreshMeta(
  state: CollectorState,
  instances: readonly AgyInstance[],
) {
  const hasDefault = instances.some((item) => item.id === null);
  const activeIds = new Set(
    instances.map((item) => item.id).filter((id): id is string => id !== null),
  );
  state.write(() => {
    if (!hasDefault) {
      state.deleteMeta("agy_quota_refresh_at");
      state.deleteMeta("agy_quota_refresh_status");
      state.deleteMeta("agy_tier_probe_at");
    }
    for (const row of state.metaByPrefix("agy_quota_refresh_at:")) {
      const id = row.key.slice("agy_quota_refresh_at:".length);
      if (!activeIds.has(id)) state.deleteMeta(row.key);
    }
    for (const row of state.metaByPrefix("agy_quota_refresh_status:")) {
      const id = row.key.slice("agy_quota_refresh_status:".length);
      if (!activeIds.has(id)) state.deleteMeta(row.key);
    }
    for (const row of state.metaByPrefix("agy_tier_probe_at:")) {
      const id = row.key.slice("agy_tier_probe_at:".length);
      if (!activeIds.has(id)) state.deleteMeta(row.key);
    }
  });
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 枚举单个 conversations 目录下所有有效 .db 文件的规范真实路径（只读目录项与 stat，不读内容）；非 ENOENT/ENOTDIR 错误置 unreadable。 */
function listRealDbFiles(convDir: string): {
  paths: string[];
  unreadable: boolean;
} {
  let entries: string[];
  try {
    entries = readdirSync(convDir).sort();
  } catch (error) {
    return { paths: [], unreadable: !isMissingPathError(error) };
  }
  const paths: string[] = [];
  let unreadable = false;
  for (const name of entries) {
    if (!name.endsWith(".db")) continue;
    const rawPath = join(convDir, name);
    try {
      if (!statSync(rawPath).isFile()) continue;
    } catch (error) {
      if (!isMissingPathError(error)) unreadable = true;
      continue;
    }
    try {
      paths.push(realpathSync(rawPath));
    } catch (error) {
      if (!isMissingPathError(error)) unreadable = true;
    }
  }
  return { paths, unreadable };
}

/**
 * 显式/池模式的 A1′ 集合差规划（供 readAgy 与 status 共用）：
 * - 只读枚举目录与真实路径，绝不读取范围外实例的令牌、日志或 .db 内容；
 * - 若合同涵盖的父目录或范围外 conversations 目录不可读（如 EACCES/EPERM），实行 fail-closed 暂缓全部范围内库；
 * - 凡可被范围外实例访问（或单文件软链接指向非范围内会话目录）的 .db 整库跳过；
 * - 其余 .db 按各自所属的范围内成员集合分组：单成员独占文件直采，多成员仅范围内共享文件走共享日志归属。
 */
function planExplicitAgyDbs(
  sources: Pick<
    AgyReaderSources,
    "conversationsDir" | "appDataDirs" | "poolAccountsFile" | "defaultGeminiDir"
  >,
  instances: readonly AgyInstance[],
  instanceLabels?: ReadonlyMap<AgyInstance, string | null>,
): {
  collect: Map<string, { instance: AgyInstance; label: string | null }[]>;
  skippedOutOfScopePaths: Set<string>;
  outOfScopeUnreadable: boolean;
} {
  const absConversationsDir = resolve(sources.conversationsDir);
  const defaultRealAppDataDir = canonicalDir(dirname(absConversationsDir));
  const defaultRealGeminiDir = canonicalDir(
    dirname(dirname(absConversationsDir)),
  );
  const inScopeRealAppDirs = new Set(
    instances.map((inst) => canonicalDir(inst.appDataDir)),
  );
  const inScopeConvDirs = new Set<string>();
  let outOfScopeUnreadable = false;
  for (const inst of instances) {
    try {
      if (statSync(inst.conversationsDir).isDirectory()) {
        inScopeConvDirs.add(realpathSync(inst.conversationsDir));
      }
    } catch (error) {
      if (!isMissingPathError(error)) outOfScopeUnreadable = true;
    }
  }

  const outOfScopeDb = new Set<string>();
  if (!inScopeRealAppDirs.has(defaultRealAppDataDir)) {
    const listed = listRealDbFiles(absConversationsDir);
    if (listed.unreadable) outOfScopeUnreadable = true;
    for (const dbPath of listed.paths) outOfScopeDb.add(dbPath);
  }
  const parentDirs = new Set<string>([
    defaultRealGeminiDir,
    ...instances.map((inst) => canonicalDir(inst.geminiDir)),
  ]);
  if (sources.defaultGeminiDir) {
    parentDirs.add(canonicalDir(resolve(sources.defaultGeminiDir)));
  }
  for (const parent of parentDirs) {
    let entries: string[];
    try {
      entries = readdirSync(parent).sort();
    } catch (error) {
      if (!isMissingPathError(error)) outOfScopeUnreadable = true;
      continue;
    }
    for (const name of entries) {
      if (name !== "antigravity-cli" && !name.startsWith("antigravity-cli-")) {
        continue;
      }
      const dir = join(parent, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch (error) {
        if (!isMissingPathError(error)) outOfScopeUnreadable = true;
        continue;
      }
      let realDir: string;
      try {
        realDir = realpathSync(dir);
      } catch (error) {
        if (!isMissingPathError(error)) outOfScopeUnreadable = true;
        continue;
      }
      if (inScopeRealAppDirs.has(realDir)) continue;
      const convDir = join(realDir, "conversations");
      const listed = listRealDbFiles(convDir);
      if (listed.unreadable) outOfScopeUnreadable = true;
      for (const dbPath of listed.paths) outOfScopeDb.add(dbPath);
    }
  }

  const inScopeDb = new Map<
    string,
    { instance: AgyInstance; label: string | null }[]
  >();
  const skippedOutOfScopePaths = new Set<string>();
  for (const instance of instances) {
    const label = instanceLabels
      ? (instanceLabels.get(instance) ?? null)
      : null;
    const listed = listRealDbFiles(instance.conversationsDir);
    if (listed.unreadable) outOfScopeUnreadable = true;
    for (const realDbPath of listed.paths) {
      if (!inScopeConvDirs.has(dirname(realDbPath))) {
        skippedOutOfScopePaths.add(realDbPath);
        continue;
      }
      const members = inScopeDb.get(realDbPath) ?? [];
      if (
        !members.some(
          (member) => member.instance.appDataDir === instance.appDataDir,
        )
      ) {
        members.push({ instance, label });
      }
      inScopeDb.set(realDbPath, members);
    }
  }

  if (outOfScopeUnreadable) {
    for (const realDbPath of inScopeDb.keys()) {
      skippedOutOfScopePaths.add(realDbPath);
    }
    return {
      collect: new Map(),
      skippedOutOfScopePaths,
      outOfScopeUnreadable: true,
    };
  }

  const collect = new Map<
    string,
    { instance: AgyInstance; label: string | null }[]
  >();
  for (const [realDbPath, members] of inScopeDb) {
    if (outOfScopeDb.has(realDbPath)) {
      skippedOutOfScopePaths.add(realDbPath);
      continue;
    }
    collect.set(realDbPath, members);
  }

  return { collect, skippedOutOfScopePaths, outOfScopeUnreadable: false };
}

/** 显式/池模式下范围外共享跳过计数与目录可读性状态（供 status 与 readAgy 共享同一口径）。 */
export function inspectExplicitAgyOutOfScope(
  sources: Pick<
    AgyReaderSources,
    "conversationsDir" | "appDataDirs" | "poolAccountsFile" | "defaultGeminiDir"
  >,
): { skippedShared: number; outOfScopeUnreadable: boolean } {
  if (!isAgyExplicitScope(sources)) {
    return { skippedShared: 0, outOfScopeUnreadable: false };
  }
  const instances = discoverAgyInstances(sources);
  const plan = planExplicitAgyDbs(sources, instances);
  return {
    skippedShared: plan.skippedOutOfScopePaths.size,
    outOfScopeUnreadable: plan.outOfScopeUnreadable,
  };
}

/** 显式/池模式下因可被范围外实例访问而跳过的共享会话库数量。 */
export function countAgyOutOfScopeSharedDbs(
  sources: Pick<
    AgyReaderSources,
    "conversationsDir" | "appDataDirs" | "poolAccountsFile" | "defaultGeminiDir"
  >,
): number {
  return inspectExplicitAgyOutOfScope(sources).skippedShared;
}

/**
 * 单次上游生成的跨会话去重键。Antigravity 的 `/btw` 或会话分叉会把父会话的
 * `gen_metadata` 整表复制到新的 conversationId 下，仅按 `[conversationId, idx, executionId]`
 * 会把复制来的历史整包重记。上游 `responseId`（缺失时退回 `messageId`）随原记录一起复制且
 * 每次调用唯一，用来在本地拦截跨会话重复入账，同时保持既有 `externalId` 格式不变。
 */
function agyResponseIdentity(decoded: DecodedAgyGenMetadata): string | null {
  const responseId = decoded.chatModel?.usage?.responseId?.trim();
  if (responseId) return `resp:${responseId}`;
  const messageId = decoded.chatModel?.usage?.messageId?.trim();
  if (messageId) return `msg:${messageId}`;
  return null;
}

const agyResponseDedupMetaKey = "agy_response_dedup_v1";

/**
 * 读取一轮 Antigravity 状态栏额度缓存与本地会话数据库。
 * 1. 发现本轮应采集的实例（显式/池模式仅含受管非默认实例；默认模式含默认实例与同级已登录额外实例）；
 * 2. 扫描 statuslineDir 下对应的 quota-<label>.tsv，为每个 Google 账号建立 Gemini 与 Claude/GPT
 *    两个配额池账户并上报额度快照；
 * 3. 只读扫描各实例 conversationsDir 下所有 *.db 的 gen_metadata 与 steps，按模型归入对应账户，
 *    通过 source_usage 保持重跑幂等，并清理已移出目录的跟踪记录与刷新状态。
 */
export function readAgy(
  state: CollectorState,
  sources: AgyReaderSources,
  now: Date = new Date(),
  logFileOps?: Partial<SharedLogFileOps>,
): AgyReaderReport {
  const report = emptyAgyReport();
  const plans = readPlanMap(state);
  const explicitMode = isAgyExplicitScope(sources);
  const instances = discoverAgyInstances(sources);
  // 仅在显式/池模式下清理已移出范围的刷新状态，默认模式保留既有 5 分钟退避记录。
  if (explicitMode) {
    pruneStaleAgyRefreshMeta(state, instances);
  }

  const instanceLabels = new Map<AgyInstance, string | null>();
  for (const instance of instances) {
    instanceLabels.set(
      instance,
      resolveInstanceLabel(instance, sources.statuslineDir),
    );
  }
  // 账号池模式下顺带只读同目录 routing-state.json（套餐缓存）与 quota-cache.json（额度缓存），零进程开销。
  let plansUpdated = false;
  let poolMeta: PoolAccountsInspection | null = null;
  const poolQuotaByLabel = new Map<string, AgyQuotaCache>();
  if (sources.poolAccountsFile) {
    const defaultGeminiDir = dirname(
      dirname(resolve(sources.conversationsDir)),
    );
    poolMeta = inspectPoolAccountsFile(
      sources.poolAccountsFile,
      defaultGeminiDir,
    );
    if (poolMeta.ok) {
      const cachedTiers = readPoolRoutingTiers(
        sources.poolAccountsFile,
        poolMeta.accountIdByDir,
      );
      const cachedQuotas = readPoolQuotaEntries(
        sources.poolAccountsFile,
        poolMeta.accountIdByDir,
      );
      for (const instance of instances) {
        const label = instanceLabels.get(instance);
        if (!label) continue;
        const realDir = canonicalDir(instance.appDataDir);
        const tierPlan = cachedTiers.get(realDir);
        if (tierPlan && plans[label] !== tierPlan) {
          plans[label] = tierPlan;
          plansUpdated = true;
        }
        const rawPoolQuota = cachedQuotas.get(realDir);
        if (rawPoolQuota) {
          const built = buildPoolQuotaCacheForLabel(label, rawPoolQuota, now);
          if (built) {
            const existing = poolQuotaByLabel.get(label);
            if (
              !existing ||
              Date.parse(built.sampledAt) > Date.parse(existing.sampledAt)
            ) {
              poolQuotaByLabel.set(label, built);
            }
          }
        }
      }
    }
  }
  if (plansUpdated) {
    state.setMeta("agy_plans", JSON.stringify(plans));
  }
  const allowedQuotaLabels = explicitMode
    ? new Set(
        [...instanceLabels.values()].filter((label): label is string =>
          Boolean(label),
        ),
      )
    : null;

  const candidateQuotaLabels = [
    ...new Set([
      ...listAgyQuotaLabels(sources.statuslineDir),
      ...poolQuotaByLabel.keys(),
    ]),
  ].sort();
  const expiredQuotaLabels = new Set<string>();

  for (const label of candidateQuotaLabels) {
    if (allowedQuotaLabels && !allowedQuotaLabels.has(label)) continue;
    const tsvCache = readAgyQuotaFile(
      join(sources.statuslineDir, agyQuotaFileName(label)),
      label,
      now,
    );
    const poolCache = poolQuotaByLabel.get(label) ?? null;
    if (!tsvCache && !poolCache) continue;
    if (tsvCache) report.quotaIgnoredLines += tsvCache.ignoredLines;
    if (tsvCache?.plan && !plans[label]) plans[label] = tsvCache.plan;
    const chosen =
      tsvCache && poolCache
        ? Date.parse(poolCache.sampledAt) > Date.parse(tsvCache.sampledAt)
          ? poolCache
          : tsvCache
        : (tsvCache ?? poolCache)!;
    if (chosen === tsvCache && tsvCache?.plan) plans[label] = tsvCache.plan;
    if (hasExpiredQuotaNeedingRefresh(chosen)) {
      expiredQuotaLabels.add(label);
    }
    const effectivePlan = effectiveAgyPlan(
      plans[label] ?? null,
      sources.defaultPlan,
    );
    const accounts = agyAccountsForLabel(label, effectivePlan);
    state.write(() => {
      state.upsertAccount(accounts.account);
      for (const legacy of accounts.legacy) state.upsertAccount(legacy);
      if (chosen.entries.length > 0) {
        const snapshot = agyQuotaSnapshot(chosen);
        if (state.recordQuota(snapshot, `agy:${label}`)) {
          report.quotas += snapshot.quotas.length;
        }
      }
      state.setMeta("agy_plans", JSON.stringify(plans));
    });
  }

  const defaultInstance =
    instances.find((item) => item.profileName === null) ?? null;
  const defaultLabel = defaultInstance
    ? (instanceLabels.get(defaultInstance) ?? null)
    : null;
  report.activeAccount =
    defaultLabel ??
    (instances[0] ? (instanceLabels.get(instances[0]) ?? null) : null);

  const startMs = Date.parse(sources.start);
  const startIso = new Date(startMs).toISOString();
  const allDbPaths = new Set<string>();
  const dirtyProfiles = new Set<string | null>();
  const expiredProfiles = new Set<string | null>();

  interface ConvGroup {
    primary: { instance: AgyInstance; label: string | null };
    members: { instance: AgyInstance; label: string | null }[];
    dbPaths: string[];
  }
  const groups = new Map<string, ConvGroup>();

  for (const instance of instances) {
    const label = instanceLabels.get(instance) ?? null;
    if (label) {
      const accounts = agyAccountsForLabel(
        label,
        effectiveAgyPlan(plans[label] ?? null, sources.defaultPlan),
      );
      state.upsertAccount(accounts.account);
      for (const legacy of accounts.legacy) state.upsertAccount(legacy);
      // 已登录的额外实例尚无本地额度缓存（且账号池 quota-cache.json 也未提供）时，纳入本轮待刷新列表。
      if (
        instance.profileName !== null &&
        !existsSync(join(sources.statuslineDir, agyQuotaFileName(label))) &&
        !poolQuotaByLabel.has(label)
      ) {
        dirtyProfiles.add(instance.id);
        report.missingQuotaProfiles += 1;
      } else if (
        instance.profileName !== null &&
        expiredQuotaLabels.has(label)
      ) {
        // 已登录额外/池实例的快照存在已过重置时间的窗口时，补刷一次最新读数（默认实例留给自身新用量或 omp）。
        dirtyProfiles.add(instance.id);
        expiredProfiles.add(instance.id);
      }
    }
    if (explicitMode) continue;
    if (!existsSync(instance.conversationsDir)) continue;
    const convDirKey = canonicalDir(instance.conversationsDir);
    const member = { instance, label };
    const existing = groups.get(convDirKey);
    if (existing) {
      existing.members.push(member);
      continue;
    }
    let dbNames: string[] = [];
    try {
      dbNames = readdirSync(instance.conversationsDir)
        .filter((name) => name.endsWith(".db"))
        .sort();
    } catch {
      continue;
    }
    const dbPaths = dbNames.map((name) =>
      join(instance.conversationsDir, name),
    );
    for (const path of dbPaths) allDbPaths.add(path);
    groups.set(convDirKey, {
      primary: member,
      members: [member],
      dbPaths,
    });
  }

  let preserveCursorsOnUnreadable = false;
  if (explicitMode) {
    const plan = planExplicitAgyDbs(sources, instances, instanceLabels);
    if (plan.outOfScopeUnreadable) {
      preserveCursorsOnUnreadable = true;
      report.unreadable += 1;
      report.skippedOutOfScopeShared = plan.skippedOutOfScopePaths.size;
      report.skipped["(目录不可读，已暂缓)"] =
        plan.skippedOutOfScopePaths.size || 1;
    } else {
      if (plan.skippedOutOfScopePaths.size > 0) {
        report.skippedOutOfScopeShared = plan.skippedOutOfScopePaths.size;
        report.skipped["(范围外共享库)"] = plan.skippedOutOfScopePaths.size;
      }
      for (const [realDbPath, members] of plan.collect) {
        allDbPaths.add(realDbPath);
        const groupKey = members
          .map((m) => m.instance.appDataDir)
          .sort()
          .join("\0");
        const existing = groups.get(groupKey);
        if (existing) {
          existing.dbPaths.push(realDbPath);
        } else {
          groups.set(groupKey, {
            primary: members[0]!,
            members,
            dbPaths: [realDbPath],
          });
        }
      }
    }
  }

  if (!preserveCursorsOnUnreadable) {
    state.forgetMissingAgyFiles(allDbPaths);
  }
  const allSharedLogPaths = new Set<string>();
  const needsResponseBackfill =
    state.getMeta(agyResponseDedupMetaKey) !== "1" &&
    state.hasSourceUsage("agy");

  for (const group of groups.values()) {
    group.dbPaths.sort();
    const { instance, label: instanceAccount } = group.primary;
    const isShared = group.members.length > 1;
    const watermarkAccount =
      explicitMode && isShared
        ? `__shared__:${group.members
            .map((m) => `${m.instance.id ?? ""}:${m.label ?? ""}`)
            .sort()
            .join(",")}`
        : (instanceAccount ?? (isShared ? "__shared__" : ""));

    // 预筛发生变化的文件；共享目录只在存在待读文件时才按需扫描各实例日志。
    interface PendingDb {
      path: string;
      conversationId: string;
      inode: string;
      size: number;
      modified: number;
      birthtimeMs: number;
      walSize: number;
      walModified: number;
      latestMtimeMs: number;
    }
    const pendingDbs: PendingDb[] = [];
    for (const path of group.dbPaths) {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        report.unreadable += 1;
        continue;
      }
      if (!stat.isFile()) continue;

      let walSize = 0;
      let walModified = 0;
      try {
        const walStat = statSync(`${path}-wal`);
        if (walStat.isFile()) {
          walSize = walStat.size;
          walModified = walStat.mtimeMs;
        }
      } catch {
        // 没有 .db-wal 文件属于正常情况。
      }

      const inode = String(stat.ino);
      const saved = state.agyFile(path);
      if (
        !needsResponseBackfill &&
        saved &&
        saved.inode === inode &&
        saved.size === stat.size &&
        saved.modified === stat.mtimeMs &&
        saved.walSize === walSize &&
        saved.walModified === walModified &&
        saved.account !== "" &&
        saved.account === watermarkAccount
      ) {
        continue;
      }
      pendingDbs.push({
        path,
        conversationId: basename(path, ".db"),
        inode,
        size: stat.size,
        modified: stat.mtimeMs,
        birthtimeMs:
          Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
            ? stat.birthtimeMs
            : Number.POSITIVE_INFINITY,
        walSize,
        walModified,
        latestMtimeMs: Math.max(stat.mtimeMs, walModified),
      });
    }
    // 先处理更早创建的父会话再处理同轮出现的分叉会话（如 /btw），保证父会话的
    // 归属与 externalId 优先占位，避免分叉会话抢先入账。
    pendingDbs.sort((a, b) =>
      a.birthtimeMs === b.birthtimeMs
        ? a.path.localeCompare(b.path)
        : a.birthtimeMs - b.birthtimeMs,
    );

    // 先完整快照待读会话库的 gen_metadata 与 steps，再读取共享日志做轮次归属：
    // agy 先写发送日志再提交数据库，先拷库后读日志可消除顺序写入期间的读取竞态。
    const loadedDbs: {
      item: (typeof pendingDbs)[number];
      genRows: { idx: number; data: string | Uint8Array }[];
      steps: ReturnType<typeof buildStepTimeIndex>;
    }[] = [];

    for (const item of pendingDbs) {
      const { path, inode, size, modified, walSize, walModified } = item;
      const opened = openConversationDb(path);
      if (!opened) {
        report.unreadable += 1;
        continue;
      }

      try {
        let hasGen: { name: string } | null;
        try {
          hasGen = opened.db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'",
            )
            .get();
        } catch {
          report.unreadable += 1;
          continue;
        }
        if (!hasGen) {
          if (watermarkAccount) {
            state.saveAgyFile({
              path,
              inode,
              size,
              modified,
              walSize,
              walModified,
              account: watermarkAccount,
            });
          }
          continue;
        }

        let genRows: { idx: number; data: string | Uint8Array }[];
        try {
          genRows = opened.db
            .query<{ idx: number; data: string | Uint8Array }, []>(
              "SELECT idx, data FROM gen_metadata ORDER BY idx ASC",
            )
            .all();
        } catch {
          report.unreadable += 1;
          continue;
        }

        report.filesRead += 1;
        const steps = buildStepTimeIndex(opened.db);
        loadedDbs.push({ item, genRows, steps });
      } finally {
        opened.close();
      }
    }

    let sharedTurnIndex: Map<string, AgyTurnAttribution[]> | null = null;
    if (isShared) {
      if (loadedDbs.length > 0) {
        const dirtyConvIds = new Set(
          loadedDbs.map((entry) => entry.item.conversationId),
        );
        sharedTurnIndex = indexSharedConversationLogs(
          state,
          group.members,
          dirtyConvIds,
          allSharedLogPaths,
          logFileOps,
        );
      } else {
        // 即使本轮 DB 无变化，也轻量收集当前活跃共享成员的日志路径，确保已移出成员的共享日志缓存立即清理。
        for (const { instance: memberInstance } of group.members) {
          for (const logPath of listInstanceLogPaths(
            memberInstance.appDataDir,
          )) {
            allSharedLogPaths.add(logPath);
          }
        }
      }
    }

    for (const { item, genRows, steps } of loadedDbs) {
      const {
        path,
        conversationId,
        inode,
        size,
        modified,
        walSize,
        walModified,
      } = item;
      const turnEvents = sharedTurnIndex?.get(conversationId);

      state.write(() => {
        let skippedMissingInFile = 0;
        for (const row of genRows) {
          if (
            (typeof row.data !== "string" &&
              !(row.data instanceof Uint8Array)) ||
            (typeof row.data === "string" && row.data.trim() === "") ||
            (row.data instanceof Uint8Array && row.data.byteLength === 0)
          ) {
            report.invalid += 1;
            continue;
          }
          let decoded: DecodedAgyGenMetadata;
          try {
            decoded = decodeAgyGenMetadata(row.data);
          } catch {
            report.invalid += 1;
            continue;
          }

          const extracted = extractAgyTokens(decoded);
          if (extracted.kind === "aborted" || extracted.kind === "empty") {
            continue;
          }
          if (extracted.kind === "invalid") {
            report.invalid += 1;
            continue;
          }

          const normalized = normalizeAgyModel({
            responseModel: decoded.chatModel?.responseModel,
            modelDisplayName: decoded.chatModel?.modelDisplayName,
            modelEnum:
              decoded.chatModel?.usage?.modelEnum ??
              decoded.chatModel?.modelEnum,
          });
          const occurredAt = resolveOccurredAt(decoded, steps);
          if (!normalized || !occurredAt) {
            report.invalid += 1;
            continue;
          }

          report.read += 1;
          if (occurredAt < startIso) {
            report.beforeStart += 1;
            continue;
          }

          const sharedHit = isShared
            ? resolveSharedTurnAttribution(turnEvents, Date.parse(occurredAt))
            : null;
          const resolvedLabel = sharedHit?.label ?? instanceAccount;
          const resolvedInstanceId = sharedHit
            ? sharedHit.instanceId
            : instance.id;

          if (!resolvedLabel) {
            report.skipped["(缺失账户)"] =
              (report.skipped["(缺失账户)"] ?? 0) + 1;
            skippedMissingInFile += 1;
            dirtyProfiles.add(instance.id);
            continue;
          }

          const accountExternalId = agyAccountId(resolvedLabel);
          const uniqueKey = JSON.stringify([
            conversationId,
            row.idx,
            decoded.executionId ??
              decoded.chatModel?.usage?.messageId ??
              decoded.chatModel?.usage?.responseId ??
              "",
          ]);
          const metadata: IngestUsage["metadata"] = {
            origin: "agy_local",
            reasoning_effort: normalized.reasoningEffort,
          };
          if (normalized.upstreamModel) {
            metadata.upstream_model = normalized.upstreamModel;
          }
          const ttftMs = decoded.chatModel?.ttftMs ?? null;
          const streamingMs = decoded.chatModel?.streamingMs ?? null;
          if (ttftMs !== null) {
            metadata.first_token_ms = ttftMs;
            if (streamingMs !== null) {
              metadata.duration_ms = ttftMs + streamingMs;
            }
          }

          const usage: IngestUsage = {
            externalId: `agy-${hash(uniqueKey)}`,
            occurredAt,
            accountExternalId,
            model: normalized.model,
            tier: extracted.tier,
            tokens: extracted.tokens,
            metadata,
          };
          if (state.recordAgyUsage(usage, agyResponseIdentity(decoded))) {
            report.recorded += 1;
            dirtyProfiles.add(resolvedInstanceId);
          }
        }

        if (watermarkAccount && skippedMissingInFile === 0) {
          state.saveAgyFile({
            path,
            inode,
            size,
            modified,
            walSize,
            walModified,
            account: watermarkAccount,
          });
        }
      });
    }
  }

  if (
    state.getMeta(agyResponseDedupMetaKey) !== "1" &&
    !preserveCursorsOnUnreadable &&
    report.unreadable === 0 &&
    !report.skipped["(缺失账户)"]
  ) {
    state.setMeta(agyResponseDedupMetaKey, "1");
  }

  if (!preserveCursorsOnUnreadable) {
    state.forgetMissingAgySharedLogs(allSharedLogPaths);
  }

  state.setMeta("agy_dirty_profiles", JSON.stringify([...dirtyProfiles]));
  state.setMeta("agy_expired_profiles", JSON.stringify([...expiredProfiles]));

  // 配置了账号池清单且文件可读、所有在池实例标签均已解析时，上报当前活跃/停用成员集合，
  // 供服务端自动归档暂停或移出的池账号并恢复重新入池的账号；清单损坏或存在未识别标签时不上报。
  if (sources.poolAccountsFile) {
    const absConversationsDir = resolve(sources.conversationsDir);
    const defaultGeminiDir = dirname(dirname(absConversationsDir));
    const defaultRealGeminiDir = canonicalDir(defaultGeminiDir);
    const poolInfo =
      poolMeta ??
      inspectPoolAccountsFile(sources.poolAccountsFile, defaultGeminiDir);
    const allActiveLabeled = instances.every((inst) =>
      Boolean(instanceLabels.get(inst)),
    );
    if (poolInfo.ok && allActiveLabeled) {
      const activeLabels = new Set<string>();
      for (const inst of instances) {
        const label = instanceLabels.get(inst);
        if (label) activeLabels.add(label);
      }
      if (poolInfo.activeDirs.length > 0 && activeLabels.size === 0) {
        return report;
      }
      const inactiveLabels = new Set<string>();
      for (const dir of poolInfo.inactiveDirs) {
        const resolved = resolve(dir);
        const realDir = canonicalDir(resolved);
        const dirName = basename(realDir);
        if (!AGY_EXTRA_DIR_NAME_RE.test(dirName)) continue;
        const profileName = dirName.slice("antigravity-cli-".length);
        const id = computeInstanceId(
          profileName,
          realDir,
          defaultRealGeminiDir,
        );
        const label = resolveInstanceLabel(
          {
            id,
            profileName,
            appDataDir: realDir,
            geminiDir: dirname(realDir),
            conversationsDir: join(realDir, "conversations"),
          },
          sources.statuslineDir,
        );
        if (label && !activeLabels.has(label)) inactiveLabels.add(label);
      }
      state.recordManagedScope(
        "agy-pool",
        [...activeLabels].map(agyAccountId),
        [...inactiveLabels].map(agyAccountId),
      );
    }
  }

  return report;
}
// ---- 额度按需刷新 ----

const refreshIntervalMs = 5 * 60_000;
const probeTimeoutMs = 35_000;
const quotaBuckets: Record<string, AgyWindowKey> = {
  "gemini-5h": "gemini_5h",
  "gemini-weekly": "gemini_weekly",
  "3p-5h": "3p_5h",
  "3p-weekly": "3p_weekly",
};
const tsvOrder = [...Object.values(quotaBuckets), "plan"];

/**
 * 剩余比例换算成已用百分比整数。上游在剩余不足 1% 时就会拒绝请求，剩余比例停在零点几而不归零，
 * 四舍五入会一直显示 99%；剩余不足 1% 按用满计。状态栏脚本写同一份缓存，换算规则须保持一致。
 */
function usedPercent(remaining: number): number {
  return remaining < 0.01 ? 100 : Math.round((1 - remaining) * 100);
}

export interface AgyQuotaRefreshResult {
  /** 是否启动了 agy；节流或状态栏刚刷新过而跳过时为 false。 */
  attempted: boolean;
  /** 是否写出了新的额度缓存。 */
  refreshed: boolean;
  label: string | null;
  error: string | null;
}

export interface AgyRefreshOptions {
  /** 覆盖 agy 可执行文件位置，默认读 AGY_BIN 再按固定目录查找。 */
  agyBin?: string;
  timeoutMs?: number;
  /** 指定需要刷新的实例身份键或短名（null 为默认实例）；省略时按 agy_dirty_profiles 刷新。 */
  profiles?: readonly (string | null)[];
  /** 多实例刷新时的最大并发度，默认 3。 */
  concurrency?: number;
  /** 内部传递：刷新指定额外实例时使用其 profileName、accountKey、geminiDir 与 appDataDir。 */
  profileName?: string | null;
  /** 状态栏 current-account-<accountKey> 隔离键；省略时回退到 profileName。 */
  accountKey?: string | null;
  geminiDir?: string;
  appDataDir?: string;
}
export interface OmpQuotaRefreshOptions {
  /** 覆盖 omp 可执行文件位置，默认读 OMP_BIN 再按固定目录查找。 */
  ompBin?: string;
  timeoutMs?: number;
  /** 可选：显式/池模式下仅允许写入与上报的账号标签集合。 */
  allowedLabels?: ReadonlySet<string>;
}

/**
 * macOS 后台任务的 PATH 不含 ~/.local/bin 与 Homebrew 目录，agy 和 omp 默认装在这些位置，
 * 所以先按固定目录查找。
 */
function findExecutable(
  name: string,
  explicit: string | undefined,
): string | null {
  const home = process.env.HOME || homedir();
  const candidates = explicit
    ? [explicit]
    : [
        ...[join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"],
        ...(process.env.PATH ?? "").split(":").filter(Boolean),
      ].map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续查找下一个位置。
    }
  }
  return null;
}

/** 日志只带邮箱本地部分的标签，完整邮箱不进入任何返回值或日志。 */
function labelFromAgyLog(log: string): string | null {
  const emails = [...log.matchAll(/authenticated successfully as ([^\s]+)/g)];
  const email = emails.at(-1)?.[1];
  return email ? agyLabelFromEmail(email) : null;
}

/**
 * 解析 agy /usage 桶的 reset_time 为 Unix 秒。
 * 窗口未开窗或刚被上游重置时，remaining_fraction 为 1 且 reset_time 缺失、为 null 或 0，
 * 统一记为 0（写入 TSV 的 `0\t0`），让预热任务和采集器都能识别未开窗状态。
 */
function parseAgyUsageResetEpoch(
  resetTime: unknown,
  remaining: number,
): number | null {
  if (
    resetTime === undefined ||
    resetTime === null ||
    resetTime === "" ||
    resetTime === 0 ||
    resetTime === "0"
  ) {
    return remaining === 1 ? 0 : null;
  }
  if (typeof resetTime !== "string") return null;
  const resetMs = Date.parse(resetTime);
  if (!Number.isFinite(resetMs)) return null;
  const sec = Math.floor(resetMs / 1000);
  return sec > 0 ? sec : remaining === 1 ? 0 : null;
}

/** agy -p /usage 返回的四个额度桶，换算成状态栏缓存的行：窗口名、已用百分比整数、重置 Unix 秒。 */
function parseUsageBuckets(output: string): Map<string, string> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return "agy 返回的不是有效 JSON";
  }
  const root = parsed as {
    status?: unknown;
    command?: { data?: { groups?: { buckets?: unknown }[] } };
  } | null;
  if (root?.status !== "SUCCESS") return "agy /usage 没有返回 SUCCESS";
  const rows = new Map<string, string>();
  for (const group of root.command?.data?.groups ?? []) {
    if (!Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets as Record<string, unknown>[]) {
      const key =
        typeof bucket?.id === "string" ? quotaBuckets[bucket.id] : null;
      const remaining = bucket?.remaining_fraction;
      if (
        !key ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1
      )
        continue;
      const resetEpoch = parseAgyUsageResetEpoch(bucket?.reset_time, remaining);
      if (resetEpoch === null) continue;
      rows.set(key, `${key}\t${usedPercent(remaining)}\t${resetEpoch}`);
    }
  }
  return rows.size > 0 ? rows : "agy /usage 没有可用的额度桶";
}

/** 同目录写满临时文件再改名，状态栏脚本同时写同一文件时也不会留下半截内容。 */
function replaceFile(path: string, content: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * 把刷出的窗口合并进 quota-<label>.tsv。agy -p /usage 不返回套餐，原文件里的 plan 行
 * 和这次没刷到的窗口行原样保留，同名窗口用新值覆盖。
 */
function mergeQuotaFile(path: string, fresh: Map<string, string>) {
  const rows = new Map<string, string>();
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // 首次写入。
  }
  for (const line of existing.split("\n")) {
    const [name, second, third, extra] = line.replace(/\r$/, "").split("\t");
    if (
      name &&
      second &&
      third &&
      extra === undefined &&
      tsvOrder.includes(name)
    )
      rows.set(name, `${name}\t${second}\t${third}`);
  }
  for (const [name, row] of fresh) rows.set(name, row);
  const lines = tsvOrder.flatMap((name) => rows.get(name) ?? []);
  replaceFile(path, lines.map((line) => `${line}\n`).join(""));
}

/** 探测子进程继承当前环境，PATH 补上后台任务缺少的安装目录。 */
function probeEnv(): Record<string, string> {
  const home = process.env.HOME || homedir();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PATH = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    env.PATH ?? "",
  ]
    .filter(Boolean)
    .join(":");
  return env;
}

/**
 * 子进程输出写进文件而不是管道，它派生的后台进程占着管道也不会让 sync 一直等；
 * 独立进程组让超时或结束后能连同它的子进程一起终止。
 */
async function runProbe(
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    outFile: string;
    timeoutMs?: number;
  },
): Promise<number | "timeout"> {
  const outputFd = openSync(options.outFile, "w", 0o600);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: outputFd,
      stderr: "ignore",
      detached: true,
    });
  } finally {
    closeSync(outputFd);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => resolve("timeout"),
      options.timeoutMs ?? probeTimeoutMs,
    );
  });
  const outcome = await Promise.race([child.exited, deadline]);
  clearTimeout(timer);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // 进程组已全部退出。
  }
  if (outcome === "timeout")
    await Promise.race([child.exited, Bun.sleep(2000)]);
  return outcome;
}

/**
 * 为 `agy -p /usage` 与 `agy acp` 统一构造隔离后的子进程环境变量：
 * - 先清除 XDG_*、GEMINI_CLI_HOME、ANTIGRAVITY_*、SSH_* 与 WSL_INTEROP，避免宿主目录或会话环境串扰；
 * - 非默认实例强制设 WSL_INTEROP=1；ACP 探测额外设 SSH_CONNECTION，防止 agy >= 1.5.17 漂移到 macOS Keychain
 *   （`agy -p /usage` 在 SSH_CONNECTION 下会挂起，因此 usage 探测保持清除 SSH_CONNECTION）。
 */
function buildAgyProbeEnv(
  profileName: string | null,
  mode: "usage" | "acp",
): Record<string, string> {
  const home = process.env.HOME || homedir();
  const env = probeEnv();
  for (const name of tierStripEnvVars) delete env[name];
  env.HOME = home;
  env.METERLEAF_AGY_PROBE = "1";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  env.BROWSER = "/usr/bin/false";
  if (profileName !== null) {
    env.WSL_INTEROP = "1";
    if (mode === "acp") {
      env.SSH_CONNECTION = tierProbeSshMarker;
    }
  }
  return env;
}

/** 按指定并发上限执行异步任务，返回与输入顺序一致的结果数组。 */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runWorker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

/**
 * 运行一次 agy -p /usage 并把结果写回状态栏额度缓存。失败只体现在返回值里，
 * 已有的 quota-<label>.tsv 与 current-account 保持原样。
 */
export async function refreshAgyQuota(
  sources: Pick<AgyReaderSources, "statuslineDir">,
  options: AgyRefreshOptions = {},
): Promise<AgyQuotaRefreshResult> {
  const result: AgyQuotaRefreshResult = {
    attempted: false,
    refreshed: false,
    label: null,
    error: null,
  };
  const profileName = options.profileName ?? null;
  const accountKey =
    options.accountKey !== undefined ? options.accountKey : profileName;
  let effectiveGeminiDir = options.geminiDir
    ? resolve(options.geminiDir)
    : null;
  if (profileName !== null) {
    const expectedDirName = `antigravity-cli-${profileName}`;
    if (!effectiveGeminiDir && options.appDataDir) {
      const absAppDataDir = resolve(options.appDataDir);
      if (basename(absAppDataDir) !== expectedDirName) {
        return {
          ...result,
          error: "额外实例目录名与 profileName 不一致，已跳过 agy 探测",
        };
      }
      effectiveGeminiDir = dirname(absAppDataDir);
    }
    const resolvedAppDataDir = effectiveGeminiDir
      ? join(effectiveGeminiDir, expectedDirName)
      : null;
    if (
      resolvedAppDataDir &&
      options.appDataDir &&
      resolve(options.appDataDir) !== resolve(resolvedAppDataDir)
    ) {
      return {
        ...result,
        error: "额外实例 appDataDir 与派发目录不一致，已跳过 agy 探测",
      };
    }
    if (!resolvedAppDataDir || !hasNonEmptyOAuthTokenFile(resolvedAppDataDir)) {
      return {
        ...result,
        error: "额外实例缺少有效的 antigravity-oauth-token，已跳过 agy 探测",
      };
    }
  }
  const agyBin = findExecutable("agy", options.agyBin ?? process.env.AGY_BIN);
  if (!agyBin) return { ...result, error: "找不到 agy 可执行文件" };
  result.attempted = true;
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "meterleaf-agy-usage-"));
    const logFile = join(tempDir, "agy.log");
    const outFile = join(tempDir, "usage.json");
    const env = buildAgyProbeEnv(profileName, "usage");

    const argv = [agyBin];
    if (profileName !== null) {
      if (effectiveGeminiDir) argv.push("--gemini_dir", effectiveGeminiDir);
      argv.push("--app_data_dir", `antigravity-cli-${profileName}`);
    }
    argv.push(
      "-p",
      "/usage",
      "--output-format",
      "json",
      "--print-timeout",
      "30s",
      "--log-file",
      logFile,
    );

    const outcome = await runProbe(argv, {
      cwd: tempDir,
      env,
      outFile,
      timeoutMs: options.timeoutMs,
    });
    if (outcome === "timeout") return { ...result, error: "agy 超时，已终止" };
    if (outcome !== 0) return { ...result, error: `agy 退出码 ${outcome}` };

    const buckets = parseUsageBuckets(readFileSync(outFile, "utf8"));
    if (typeof buckets === "string") return { ...result, error: buckets };

    let logged: string | null = null;
    try {
      logged = labelFromAgyLog(readFileSync(logFile, "utf8"));
    } catch {
      // 没有日志时回退到实例自己的令牌或状态栏记录。
    }
    const fallbackLabel =
      profileName !== null
        ? ((options.appDataDir
            ? labelFromOAuthTokenFile(options.appDataDir)
            : null) ??
          readAgyCurrentAccount(sources.statuslineDir, accountKey) ??
          (options.appDataDir
            ? labelFromAppDataLogs(options.appDataDir)
            : null))
        : (readAgyCurrentAccount(sources.statuslineDir, null) ??
          (options.appDataDir
            ? (labelFromOAuthTokenFile(options.appDataDir) ??
              labelFromAppDataLogs(options.appDataDir))
            : null) ??
          activeAgyLabel(sources.statuslineDir));
    const label = logged ?? fallbackLabel;
    if (!label) return { ...result, error: "无法确定 agy 登录的账号标签" };

    mkdirSync(sources.statuslineDir, { recursive: true, mode: 0o700 });
    mergeQuotaFile(
      join(sources.statuslineDir, agyQuotaFileName(label)),
      buckets,
    );
    if (
      logged &&
      readAgyCurrentAccount(sources.statuslineDir, accountKey) !== logged
    ) {
      const accountFile = accountKey
        ? `current-account-${accountKey}`
        : "current-account";
      replaceFile(join(sources.statuslineDir, accountFile), `${logged}\n`);
    }
    return { ...result, refreshed: true, label };
  } catch (error) {
    return {
      ...result,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 清理临时目录失败不覆盖本次刷新结果或中断本轮上传。
      }
    }
  }
}

async function maybeRefreshInstanceQuota(
  state: CollectorState,
  sources: AgyReaderSources,
  instance: AgyInstance,
  now: Date,
  options: AgyRefreshOptions,
  poolQuotaRaw?: PoolQuotaEntryRaw | null,
): Promise<AgyQuotaRefreshResult> {
  const skipped: AgyQuotaRefreshResult = {
    attempted: false,
    refreshed: false,
    label: null,
    error: null,
  };
  const profileName = instance.profileName;
  const instanceKey = instance.id;
  if (profileName !== null && !hasNonEmptyOAuthTokenFile(instance.appDataDir)) {
    return skipped;
  }
  const refreshAtKey = instanceKey
    ? `agy_quota_refresh_at:${instanceKey}`
    : "agy_quota_refresh_at";
  const statusKey = instanceKey
    ? `agy_quota_refresh_status:${instanceKey}`
    : "agy_quota_refresh_status";
  const displayName = instanceKey
    ? `Antigravity (@${instanceKey})`
    : "Antigravity";

  const lastAttemptAt = state.getMeta(refreshAtKey);
  if (lastAttemptAt) {
    const elapsed = now.getTime() - Date.parse(lastAttemptAt);
    if (elapsed >= 0 && elapsed < refreshIntervalMs) return skipped;
  }
  const label = resolveInstanceLabel(instance, sources.statuslineDir);
  if (label) {
    // 账号池同目录 quota-cache.json 5 分钟内刚采样过且没有待补刷的过期窗口时，直接复用，不重复启动 agy。
    if (poolQuotaRaw) {
      const poolAge = now.getTime() - poolQuotaRaw.sampledAtMs;
      const poolCache = buildPoolQuotaCacheForLabel(label, poolQuotaRaw, now);
      if (
        poolCache &&
        poolAge >= 0 &&
        poolAge < refreshIntervalMs &&
        !hasExpiredQuotaNeedingRefresh(poolCache)
      ) {
        return skipped;
      }
    }
    try {
      const quotaPath = join(sources.statuslineDir, agyQuotaFileName(label));
      const cacheAge = now.getTime() - statSync(quotaPath).mtimeMs;
      if (cacheAge < refreshIntervalMs) {
        const parsed = readAgyQuotaFile(quotaPath, label, now);
        if (!parsed || !hasExpiredQuotaNeedingRefresh(parsed)) return skipped;
      }
    } catch {
      // 还没有额度缓存，需要刷新。
    }
  }
  state.setMeta(refreshAtKey, now.toISOString());
  const result = await refreshAgyQuota(sources, {
    ...options,
    profileName,
    accountKey: instanceKey,
    geminiDir: instance.geminiDir,
    appDataDir: instance.appDataDir,
  });
  noteRefreshStatus(
    state,
    statusKey,
    displayName,
    result.error,
    result.refreshed ? (result.label ?? "") : null,
    now,
  );
  return result;
}

/**
 * 发现新的 Antigravity 用量、缺失缓存或窗口过期后调用。距上次尝试不足 5 分钟，或状态栏/账号池
 * 刚写过有效额度缓存时直接跳过。尝试时间在启动 agy 之前写入，失败也按 5 分钟退避。
 * 多实例按有界并发（默认 3）执行，避免单轮 sync 被串行探测阻塞。
 */
export async function maybeRefreshAgyQuota(
  state: CollectorState,
  sources: AgyReaderSources,
  now: Date = new Date(),
  options: AgyRefreshOptions = {},
): Promise<AgyQuotaRefreshResult> {
  const instances = discoverAgyInstances(sources);
  let targets: readonly (string | null)[] = [];
  if (options.profiles && options.profiles.length > 0) {
    targets = options.profiles;
  } else {
    try {
      const raw = JSON.parse(
        state.getMeta("agy_dirty_profiles") ?? "[]",
      ) as unknown;
      if (Array.isArray(raw) && raw.length > 0) {
        targets = raw.filter(
          (item): item is string | null =>
            item === null || typeof item === "string",
        );
      }
    } catch {
      // 忽略损坏的元信息。
    }
    if (targets.length === 0 && instances.some((item) => item.id === null)) {
      targets = [null];
    }
  }
  let poolQuotas: ReadonlyMap<string, PoolQuotaEntryRaw> = new Map();
  if (sources.poolAccountsFile) {
    const defaultGeminiDir = dirname(
      dirname(resolve(sources.conversationsDir)),
    );
    const poolMeta = inspectPoolAccountsFile(
      sources.poolAccountsFile,
      defaultGeminiDir,
    );
    if (poolMeta.ok) {
      poolQuotas = readPoolQuotaEntries(
        sources.poolAccountsFile,
        poolMeta.accountIdByDir,
      );
    }
  }
  const targetInstances: AgyInstance[] = [];
  const seenInstanceDirs = new Set<string>();
  for (const target of targets) {
    let instance = instances.find((item) => item.id === target) ?? null;
    if (
      !instance &&
      target !== null &&
      options.profiles &&
      options.profiles.length > 0
    ) {
      const byProfile = instances.filter((item) => item.profileName === target);
      if (byProfile.length === 1) instance = byProfile[0]!;
    }
    if (!instance) continue;
    const realDir = canonicalDir(instance.appDataDir);
    if (seenInstanceDirs.has(realDir)) continue;
    seenInstanceDirs.add(realDir);
    targetInstances.push(instance);
  }
  const results = await runWithConcurrency(
    targetInstances,
    options.concurrency ?? 3,
    (instance) =>
      maybeRefreshInstanceQuota(
        state,
        sources,
        instance,
        now,
        options,
        poolQuotas.get(canonicalDir(instance.appDataDir)) ?? null,
      ),
  );
  const finalResult: AgyQuotaRefreshResult = {
    attempted: false,
    refreshed: false,
    label: null,
    error: null,
  };
  for (const res of results) {
    if (res.attempted) finalResult.attempted = true;
    if (res.refreshed) {
      finalResult.refreshed = true;
      finalResult.label = res.label;
    }
    if (res.error && !finalResult.error) {
      finalResult.error = res.error;
    }
  }
  return finalResult;
}

/** 刷新结果只在与上轮不同时记一行日志，失败持续时不每轮刷屏。 */
function noteRefreshStatus(
  state: CollectorState,
  metaKey: string,
  name: string,
  error: string | null,
  refreshed: string | null,
  now: Date,
) {
  const status = error
    ? `error:${error}`
    : refreshed !== null
      ? `ok:${refreshed}`
      : "";
  const previous = state.getMeta(metaKey) ?? "";
  if (status === previous) return;
  state.setMeta(metaKey, status);
  if (error)
    console.error(`${now.toISOString()} ${name} 额度刷新失败: ${error}`);
  else if (previous.startsWith("error:"))
    console.log(`${now.toISOString()} ${name} 额度刷新已恢复`);
}

// ---- 通过 agy acp 握手自动探测账号套餐类型 ----

const tierRefreshTtlMs = 24 * 60 * 60_000;
const tierRetryBackoffMs = 60 * 60_000;
const tierProbeHardTimeoutMs = 20_000;
const tierProbeCloseWaitMs = 3_000;
const tierProbeMaxBufferBytes = 512 * 1024;
const tierProbeSshMarker = "127.0.0.1 1 127.0.0.1 22";
const tierStripEnvVars = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "GEMINI_CLI_HOME",
  "ANTIGRAVITY_HOME",
  "ANTIGRAVITY_DATA_DIR",
  "ANTIGRAVITY_CONFIG_DIR",
  "ANTIGRAVITY_CLI_HOME",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
  "WSL_INTEROP",
] as const;

export interface AgyTierProbeOptions {
  agyBin?: string;
  timeoutMs?: number;
  profileName?: string | null;
  geminiDir?: string;
  appDataDir?: string;
}

export interface AgyTierProbeResult {
  attempted: boolean;
  tier: AgyTier | null;
  error: string | null;
}

export interface AgyTierRefreshResult {
  attempted: number;
  refreshed: boolean;
  updatedLabels: string[];
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

async function waitProcessGroupDead(
  pgid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) return true;
    await Bun.sleep(25);
  }
  return !isProcessGroupAlive(pgid);
}

async function terminateProcessGroup(pgid: number): Promise<boolean> {
  if (!isProcessGroupAlive(pgid)) return true;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return true;
  }
  if (await waitProcessGroupDead(pgid, 1_000)) return true;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return true;
  }
  return waitProcessGroupDead(pgid, 1_000);
}

/**
 * 一次性轻量 ACP 握手探测：启动 `agy acp --disable-telemetry`，依次发送 `initialize` → `session/new`
 * 提取 `result._meta.antigravity.tier`，再礼貌 `session/close` 并按进程组终止。
 * 非默认实例强制隔离 macOS Keychain（设 `SSH_CONNECTION` + `WSL_INTEROP=1`，要求目录内存在非空令牌文件）。
 */
export async function probeAgyTier(
  options: AgyTierProbeOptions = {},
): Promise<AgyTierProbeResult> {
  const result: AgyTierProbeResult = {
    attempted: false,
    tier: null,
    error: null,
  };
  const profileName = options.profileName ?? null;
  const home = process.env.HOME || homedir();
  const defaultGeminiDir = resolve(join(home, ".gemini"));
  let effectiveGeminiDir = options.geminiDir
    ? resolve(options.geminiDir)
    : null;
  if (profileName !== null) {
    const expectedDirName = `antigravity-cli-${profileName}`;
    if (!effectiveGeminiDir && options.appDataDir) {
      const absAppDataDir = resolve(options.appDataDir);
      if (basename(absAppDataDir) !== expectedDirName) {
        return {
          ...result,
          error: "额外实例目录名与 profileName 不一致，已跳过 agy 套餐探测",
        };
      }
      effectiveGeminiDir = dirname(absAppDataDir);
    }
    const resolvedAppDataDir = effectiveGeminiDir
      ? join(effectiveGeminiDir, expectedDirName)
      : null;
    if (
      resolvedAppDataDir &&
      options.appDataDir &&
      resolve(options.appDataDir) !== resolve(resolvedAppDataDir)
    ) {
      return {
        ...result,
        error: "额外实例 appDataDir 与派发目录不一致，已跳过 agy 套餐探测",
      };
    }
    if (!resolvedAppDataDir || !hasNonEmptyOAuthTokenFile(resolvedAppDataDir)) {
      return {
        ...result,
        error:
          "额外实例缺少有效的 antigravity-oauth-token，已跳过 agy 套餐探测",
      };
    }
  }

  const agyBin = findExecutable("agy", options.agyBin ?? process.env.AGY_BIN);
  if (!agyBin) return { ...result, error: "找不到 agy 可执行文件" };
  result.attempted = true;

  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "meterleaf-agy-tier-"));
    chmodSync(tempDir, 0o700);
    const env = buildAgyProbeEnv(profileName, "acp");

    const args = ["acp", "--disable-telemetry"];
    if (profileName !== null) {
      if (effectiveGeminiDir && effectiveGeminiDir !== defaultGeminiDir) {
        args.push("--gemini-dir", effectiveGeminiDir);
      }
      args.push("--app-data-dir", `antigravity-cli-${profileName}`);
    }

    const child = spawn(agyBin, args, {
      cwd: tempDir,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
    });
    const pgid =
      typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
    let detected: AgyTier | null = null;
    let childExited = false;
    let spawnError: string | null = null;
    let probeError: string | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((res) => {
      resolveDone = () => {
        if (settled) return;
        settled = true;
        res();
      };
    });
    const childDone = new Promise<void>((res) => {
      child.once("exit", () => {
        childExited = true;
        res();
        resolveDone();
      });
      child.once("error", (err) => {
        spawnError = err instanceof Error ? err.message : String(err);
        if (!pgid) childExited = true;
        res();
        resolveDone();
      });
    });

    const writeJson = (payload: Record<string, unknown>) => {
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded)
        return;
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
      } catch {
        // 忽略对端提前关闭管道。
      }
    };
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("error", () => resolveDone());
    child.stdout?.setEncoding("utf8");

    let buffer = "";
    let sessionNewSent = false;
    let sessionCloseSent = false;
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || settled) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return;
      const msg = parsed as { id?: unknown; result?: unknown; error?: unknown };
      const formatRpcError = (err: unknown): string => {
        if (typeof err === "object" && err !== null && !Array.isArray(err)) {
          const message = (err as { message?: unknown }).message;
          if (typeof message === "string" && message.trim())
            return `agy acp 返回错误: ${message.trim()}`;
        }
        return "agy acp 返回错误";
      };
      if (msg.id === 1 && !sessionNewSent) {
        if (msg.error !== undefined) {
          probeError = formatRpcError(msg.error);
          resolveDone();
          return;
        }
        sessionNewSent = true;
        writeJson({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: tempDir, mcpServers: [] },
        });
        return;
      }
      if (msg.id === 2 && !sessionCloseSent) {
        if (msg.error !== undefined) {
          probeError = formatRpcError(msg.error);
          resolveDone();
          return;
        }
        const tier = extractAcpSessionTier(parsed);
        if (tier) detected = tier;
        const resultObj =
          typeof msg.result === "object" &&
          msg.result !== null &&
          !Array.isArray(msg.result)
            ? (msg.result as { sessionId?: unknown })
            : null;
        const sessionId =
          typeof resultObj?.sessionId === "string" ? resultObj.sessionId : null;
        if (sessionId) {
          sessionCloseSent = true;
          writeJson({
            jsonrpc: "2.0",
            id: 3,
            method: "session/close",
            params: { sessionId },
          });
          closeTimer = setTimeout(() => resolveDone(), tierProbeCloseWaitMs);
          closeTimer.unref?.();
        } else {
          resolveDone();
        }
        return;
      }
      if (msg.id === 3) resolveDone();
    };

    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > tierProbeMaxBufferBytes) {
        const lastNewline = buffer.lastIndexOf("\n");
        if (lastNewline === -1) {
          buffer = "";
          return;
        }
        buffer = buffer.slice(lastNewline + 1);
      }
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        idx = buffer.indexOf("\n");
      }
    });

    const hardTimer = setTimeout(() => {
      if (!settled) probeError = "agy acp 探测超时";
      resolveDone();
    }, options.timeoutMs ?? tierProbeHardTimeoutMs);
    hardTimer.unref?.();

    try {
      writeJson({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      });
      await donePromise;
    } finally {
      clearTimeout(hardTimer);
      if (closeTimer) clearTimeout(closeTimer);
      try {
        child.stdin?.end();
      } catch {
        // 忽略管道关闭异常。
      }
    }

    let exitConfirmed: boolean;
    if (pgid !== null) {
      const dead = await terminateProcessGroup(pgid);
      if (dead && !childExited) {
        await Promise.race([childDone, Bun.sleep(250)]);
      }
      exitConfirmed = dead && !isProcessGroupAlive(pgid);
    } else {
      exitConfirmed = childExited || spawnError !== null;
    }

    return {
      attempted: true,
      tier: exitConfirmed ? detected : null,
      error:
        spawnError ??
        probeError ??
        (exitConfirmed ? null : "agy acp 探测进程未能终止"),
    };
  } catch (error) {
    return {
      ...result,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 清理临时目录失败不影响本轮同步。
      }
    }
  }
}

interface TierProbeRecord {
  at: string;
  ok: boolean;
}

function readTierProbeRecord(
  state: CollectorState,
  key: string,
): TierProbeRecord | null {
  const raw = state.getMeta(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TierProbeRecord>;
    if (typeof parsed.at === "string") {
      return { at: parsed.at, ok: parsed.ok === true };
    }
  } catch {
    // 兼容或忽略损坏记录。
  }
  return null;
}

/**
 * 为已知标签的 Antigravity 实例按需探测套餐类型（仅 sync 调用，scan 不联网）：
 * - 账号池模式下已在同目录 routing-state.json 中命中的实例跳过进程探测；
 * - 已有套餐按 24 小时 TTL 复查；首次缺失、探测失败或旧版 CLI 返回 null 时按 1 小时退避，防止死循环；
 * - 每轮按有界并发（默认 2）与单轮上限（默认 2）执行，其余到期实例顺延下一轮 sync，避免阻塞后台推送；
 * - 探测成功后写入 agy_plans，并在已有 quota-<label>.tsv 时合并写入 plan 行，仍保留 defaultPlan 细化回退。
 */
export async function maybeRefreshAgyTiers(
  state: CollectorState,
  sources: AgyReaderSources,
  now: Date = new Date(),
  options: Pick<AgyTierProbeOptions, "agyBin" | "timeoutMs"> & {
    /** 为 true 时只为尚无已知套餐的实例探测，已有套餐的不触发 24h 周期复查。 */
    onlyMissingPlan?: boolean;
    /** 单轮最多探测的实例数，默认 2，剩余顺延下一轮。 */
    maxProbesPerRound?: number;
    /** 并发探测数上限，默认 2。 */
    concurrency?: number;
  } = {},
): Promise<AgyTierRefreshResult> {
  const result: AgyTierRefreshResult = {
    attempted: 0,
    refreshed: false,
    updatedLabels: [],
  };
  const instances = discoverAgyInstances(sources);
  if (instances.length === 0) return result;
  const plans = readPlanMap(state);
  let poolCachedDirs: ReadonlyMap<string, string> = new Map();
  if (sources.poolAccountsFile) {
    const defaultGeminiDir = dirname(
      dirname(resolve(sources.conversationsDir)),
    );
    const poolMeta = inspectPoolAccountsFile(
      sources.poolAccountsFile,
      defaultGeminiDir,
    );
    if (poolMeta.ok) {
      poolCachedDirs = readPoolRoutingTiers(
        sources.poolAccountsFile,
        poolMeta.accountIdByDir,
      );
    }
  }

  const dueTasks: {
    instance: AgyInstance;
    label: string;
    probeKey: string;
  }[] = [];
  for (const instance of instances) {
    if (
      instance.profileName !== null &&
      !hasNonEmptyOAuthTokenFile(instance.appDataDir)
    ) {
      continue;
    }
    const label = resolveInstanceLabel(instance, sources.statuslineDir);
    if (!label) continue;
    // 池缓存已提供套餐时直接复用，不额外启动 agy acp 进程。
    if (poolCachedDirs.has(canonicalDir(instance.appDataDir))) continue;

    const probeKey = instance.id
      ? `agy_tier_probe_at:${instance.id}`
      : "agy_tier_probe_at";
    const last = readTierProbeRecord(state, probeKey);
    const hasPlan = Boolean(plans[label]);
    if (options.onlyMissingPlan && hasPlan) continue;
    if (last) {
      const elapsed = now.getTime() - Date.parse(last.at);
      const waitMs = hasPlan && last.ok ? tierRefreshTtlMs : tierRetryBackoffMs;
      if (elapsed >= 0 && elapsed < waitMs) continue;
    }
    dueTasks.push({ instance, label, probeKey });
  }

  const maxProbes = Math.max(1, options.maxProbesPerRound ?? 2);
  const batch = dueTasks.slice(0, maxProbes);
  const outcomes = await runWithConcurrency(
    batch,
    options.concurrency ?? 2,
    async (task) => {
      state.setMeta(
        task.probeKey,
        JSON.stringify({
          at: now.toISOString(),
          ok: false,
        } satisfies TierProbeRecord),
      );
      const probe = await probeAgyTier({
        agyBin: options.agyBin,
        timeoutMs: options.timeoutMs,
        profileName: task.instance.profileName,
        geminiDir: task.instance.geminiDir,
        appDataDir: task.instance.appDataDir,
      });
      return { task, probe };
    },
  );

  for (const { task, probe } of outcomes) {
    if (probe.attempted) result.attempted += 1;
    const normalized = normalizeAgyTierPlan(probe.tier);
    if (!normalized) continue;

    state.setMeta(
      task.probeKey,
      JSON.stringify({
        at: now.toISOString(),
        ok: true,
      } satisfies TierProbeRecord),
    );
    const changed = plans[task.label] !== normalized;
    plans[task.label] = normalized;
    state.setMeta("agy_plans", JSON.stringify(plans));
    // 仅在已有额度缓存文件时合并写入 plan 行，避免在首次刷额度前制造空壳 TSV 掩盖 missingQuotaProfiles。
    const quotaPath = join(sources.statuslineDir, agyQuotaFileName(task.label));
    if (existsSync(quotaPath)) {
      try {
        mergeQuotaFile(
          quotaPath,
          new Map([["plan", `plan\t${normalized}\t-`]]),
        );
      } catch {
        // 状态栏缓存不可写时仍保留 agy_plans 持久化结果。
      }
    }
    if (changed) {
      result.refreshed = true;
      result.updatedLabels.push(task.label);
    }
  }
  return result;
}

// ---- 经 omp 刷新所有已登录 Google 账号的额度 ----

/** 额度已用完时 omp 会收到 429，此后不再产生用量，所以单独用较短的间隔去读一次实时额度。 */
const exhaustedRefreshIntervalMs = 60_000;
/** 本机未安装 omp 时按较长间隔退避，避免存在历史未归属 omp 请求时每 5 分钟反复报错。 */
const ompMissingBinBackoffMs = 30 * 60_000;
const ompMissingBinError = "找不到 omp 可执行文件";

/**
 * omp usage --json 每个已登录账号一份报告，额度标识末段与 agy /usage 的桶名相同，
 * 例如 google-antigravity:google:default:gemini-5h。返回 标签 → 缓存行，完整邮箱不出现在返回值里。
 */
function parseOmpUsageReports(
  output: string,
): Map<string, Map<string, string>> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return "omp usage 返回的不是有效 JSON";
  }
  const reports = (parsed as { reports?: unknown } | null)?.reports;
  if (!Array.isArray(reports)) return "omp usage 没有返回额度报告";
  const result = new Map<string, Map<string, string>>();
  for (const report of reports as Record<string, unknown>[]) {
    if (report?.provider !== "google-antigravity") continue;
    const email = (report.metadata as { email?: unknown } | undefined)?.email;
    const label = typeof email === "string" ? agyLabelFromEmail(email) : null;
    if (!label || !Array.isArray(report.limits)) continue;
    const rows = new Map<string, string>();
    for (const limit of report.limits as Record<string, unknown>[]) {
      const key =
        typeof limit?.id === "string"
          ? quotaBuckets[limit.id.split(":").at(-1)!]
          : undefined;
      const remaining = (limit?.amount as { remainingFraction?: unknown })
        ?.remainingFraction;
      const rawResetMs = (limit?.window as { resetsAt?: unknown })?.resetsAt;
      if (
        !key ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1
      )
        continue;
      let resetEpoch: number | null = null;
      if (rawResetMs === undefined || rawResetMs === null || rawResetMs === 0) {
        resetEpoch = remaining === 1 ? 0 : null;
      } else if (
        typeof rawResetMs === "number" &&
        Number.isFinite(rawResetMs)
      ) {
        const sec = Math.floor(rawResetMs / 1000);
        resetEpoch = sec > 0 ? sec : remaining === 1 ? 0 : null;
      }
      if (resetEpoch === null) continue;
      rows.set(key, `${key}\t${usedPercent(remaining)}\t${resetEpoch}`);
    }
    if (rows.size > 0) result.set(label, rows);
  }
  return result.size > 0 ? result : "omp usage 没有可用的 Antigravity 额度";
}

export interface OmpQuotaRefreshResult {
  attempted: boolean;
  refreshed: boolean;
  /** 写入了额度缓存的账号标签，按字母序。 */
  labels: string[];
  error: string | null;
}

/**
 * 运行 omp usage 并把每个已登录 Google 账号的额度合并进各自的 quota-<label>.tsv。
 * omp 自己会缓存额度几分钟，live 时先让它丢弃缓存再读，用于额度刚用完的场合。
 * 不改 current-account：它只代表 agy 当前登录的账号。
 */
export async function refreshOmpAgyQuota(
  sources: Pick<AgyReaderSources, "statuslineDir">,
  options: OmpQuotaRefreshOptions & { live?: boolean } = {},
): Promise<OmpQuotaRefreshResult> {
  const result: OmpQuotaRefreshResult = {
    attempted: false,
    refreshed: false,
    labels: [],
    error: null,
  };
  if (options.allowedLabels && options.allowedLabels.size === 0) {
    return { ...result, error: "当前 Antigravity 采集范围内没有可用账号" };
  }
  const ompBin = findExecutable("omp", options.ompBin ?? process.env.OMP_BIN);
  if (!ompBin) return { ...result, error: "找不到 omp 可执行文件" };
  result.attempted = true;
  let tempDir: string | null = null;
  const provider = "--provider=google-antigravity";
  try {
    tempDir = mkdtempSync(join(tmpdir(), "meterleaf-omp-usage-"));
    const outFile = join(tempDir, "usage.json");
    const run = { cwd: tempDir, env: probeEnv(), timeoutMs: options.timeoutMs };
    if (options.live)
      // 丢弃缓存失败时仍读一次，最多拿到 omp 缓存里的值。
      await runProbe([ompBin, "usage", "invalidate", provider], {
        ...run,
        outFile: join(tempDir, "invalidate.out"),
      });
    const outcome = await runProbe([ompBin, "usage", "--json", provider], {
      ...run,
      outFile,
    });
    if (outcome === "timeout") return { ...result, error: "omp 超时，已终止" };
    if (outcome !== 0) return { ...result, error: `omp 退出码 ${outcome}` };
    const accounts = parseOmpUsageReports(readFileSync(outFile, "utf8"));
    if (typeof accounts === "string") return { ...result, error: accounts };
    const filtered = options.allowedLabels
      ? new Map(
          [...accounts.entries()].filter(([label]) =>
            options.allowedLabels!.has(label),
          ),
        )
      : accounts;
    if (filtered.size === 0) {
      return {
        ...result,
        error: "omp usage 返回的账号均不在当前 Antigravity 采集范围内",
      };
    }
    mkdirSync(sources.statuslineDir, { recursive: true, mode: 0o700 });
    for (const [label, rows] of filtered)
      mergeQuotaFile(
        join(sources.statuslineDir, agyQuotaFileName(label)),
        rows,
      );
    return { ...result, refreshed: true, labels: [...filtered.keys()].sort() };
  } catch (error) {
    return {
      ...result,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 清理临时目录失败不覆盖本次刷新结果或中断本轮上传。
      }
    }
  }
}

/**
 * omp 里有新的 Antigravity 用量时最多每 5 分钟刷新一次；收到额度用完的 429 时
 * 最多每分钟读一次实时额度，让用满的读数尽快到位，又不在持续报错时反复调用。
 * 尝试时间在启动 omp 之前写入，失败同样退避。
 */
export async function maybeRefreshOmpAgyQuota(
  state: CollectorState,
  sources: Pick<AgyReaderSources, "statuslineDir">,
  trigger: { exhausted: boolean },
  now: Date = new Date(),
  options: OmpQuotaRefreshOptions = {},
): Promise<OmpQuotaRefreshResult> {
  if (options.allowedLabels && options.allowedLabels.size === 0) {
    return { attempted: false, refreshed: false, labels: [], error: null };
  }
  const lastAttemptAt = state.getMeta("omp_agy_quota_refresh_at");
  if (lastAttemptAt) {
    const elapsed = now.getTime() - Date.parse(lastAttemptAt);
    const missingBin =
      state.getMeta("omp_agy_quota_refresh_status") ===
      `error:${ompMissingBinError}`;
    const interval = missingBin
      ? ompMissingBinBackoffMs
      : trigger.exhausted
        ? exhaustedRefreshIntervalMs
        : refreshIntervalMs;
    if (elapsed >= 0 && elapsed < interval)
      return { attempted: false, refreshed: false, labels: [], error: null };
  }
  state.setMeta("omp_agy_quota_refresh_at", now.toISOString());
  const result = await refreshOmpAgyQuota(sources, {
    ...options,
    live: trigger.exhausted,
  });
  noteRefreshStatus(
    state,
    "omp_agy_quota_refresh_status",
    "omp Antigravity",
    result.error,
    result.refreshed ? result.labels.join(",") : null,
    now,
  );
  return result;
}
