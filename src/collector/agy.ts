import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

/** 读取 ~/.cache/agy-statusline/current-account 中的当前活跃标签。 */
export function readAgyCurrentAccount(statuslineDir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(statuslineDir, "current-account"), "utf8");
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
};

const displayModels: Record<string, string> = {
  "gemini 4 argon": "gemini-4-argon",
  "gemini 3.8 flash": "gemini-3.8-flash",
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
  const displayMatch = /\((Low|Medium|High|Max|Minimal)\)$/i.exec(display);
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
    const effortSuffix =
      /^(claude-(?:opus|sonnet|haiku|fable)-[0-9]+(?:-[0-9]+)*|gemini-[a-z0-9.-]+|gpt-oss-120b)-(low|medium|high|max|minimal)$/.exec(
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
}

export interface AgyReaderReport extends SourceReaderReport {
  filesRead: number;
  beforeStart: number;
  unreadable: number;
  quotas: number;
  quotaIgnoredLines: number;
  activeAccount: string | null;
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
  };
}

function readPlanMap(state: CollectorState): Record<string, string> {
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
    return null;
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

/**
 * 读取一轮 Antigravity 状态栏额度缓存与本地会话数据库。
 * 1. 扫描 statuslineDir 下所有 quota-<label>.tsv，为每个 Google 账号建立 Gemini 与 Claude/GPT
 *    两个配额池账户并上报额度快照；
 * 2. 读取 current-account（若缺失且目录中只有一个 quota-<label>.tsv 则采用该标签）作为当前活跃账号；
 * 3. 只读扫描 conversationsDir 下所有 *.db 的 gen_metadata 与 steps，按模型归入对应配额池账户，
 *    通过 source_usage 保持重跑幂等。
 */
export function readAgy(
  state: CollectorState,
  sources: AgyReaderSources,
  now: Date = new Date(),
): AgyReaderReport {
  const report = emptyAgyReport();
  const plans = readPlanMap(state);
  const discoveredLabels: string[] = [];

  if (existsSync(sources.statuslineDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(sources.statuslineDir).sort();
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const match = /^quota-([a-z0-9][a-z0-9_-]{0,63})\.tsv$/.exec(name);
      if (!match) continue;
      const label = match[1]!;
      discoveredLabels.push(label);
      const cache = readAgyQuotaFile(
        join(sources.statuslineDir, name),
        label,
        now,
      );
      if (!cache) continue;
      report.quotaIgnoredLines += cache.ignoredLines;
      if (cache.plan) plans[label] = cache.plan;
      const effectivePlan = plans[label] ?? null;
      const accounts = agyAccountsForLabel(label, effectivePlan);
      state.db.transaction(() => {
        state.upsertAccount(accounts.account);
        for (const legacy of accounts.legacy) state.upsertAccount(legacy);
        if (cache.entries.length > 0) {
          const snapshot = agyQuotaSnapshot(cache);
          if (state.recordQuota(snapshot, `agy:${label}`)) {
            report.quotas += snapshot.quotas.length;
          }
        }
        state.setMeta("agy_plans", JSON.stringify(plans));
      })();
    }
  }

  const activeAccount =
    readAgyCurrentAccount(sources.statuslineDir) ??
    (discoveredLabels.length === 1 ? discoveredLabels[0]! : null);
  report.activeAccount = activeAccount;

  if (activeAccount) {
    const accounts = agyAccountsForLabel(
      activeAccount,
      plans[activeAccount] ?? null,
    );
    state.upsertAccount(accounts.account);
    for (const legacy of accounts.legacy) state.upsertAccount(legacy);
  }

  if (!existsSync(sources.conversationsDir)) return report;
  let dbNames: string[] = [];
  try {
    dbNames = readdirSync(sources.conversationsDir)
      .filter((name) => name.endsWith(".db"))
      .sort();
  } catch {
    return report;
  }

  const startMs = Date.parse(sources.start);
  const startIso = new Date(startMs).toISOString();
  const dbPaths = dbNames.map((name) => join(sources.conversationsDir, name));
  state.forgetMissingAgyFiles(new Set(dbPaths));

  for (const path of dbPaths) {
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
      saved &&
      saved.inode === inode &&
      saved.size === stat.size &&
      saved.modified === stat.mtimeMs &&
      saved.walSize === walSize &&
      saved.walModified === walModified &&
      saved.account !== "" &&
      saved.account === (activeAccount ?? "")
    ) {
      continue;
    }

    const opened = openConversationDb(path);
    if (!opened) {
      report.unreadable += 1;
      continue;
    }

    try {
      const hasGen = opened.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'",
        )
        .get();
      if (!hasGen) {
        if (activeAccount) {
          state.saveAgyFile({
            path,
            inode,
            size: stat.size,
            modified: stat.mtimeMs,
            walSize,
            walModified,
            account: activeAccount,
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
      const conversationId = basename(path, ".db");

      state.db.transaction(() => {
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

          if (!activeAccount) {
            report.skipped["(缺失账户)"] =
              (report.skipped["(缺失账户)"] ?? 0) + 1;
            continue;
          }

          const accountExternalId = agyAccountId(activeAccount);
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

          const usage: IngestUsage = {
            externalId: `agy-${hash(uniqueKey)}`,
            occurredAt,
            accountExternalId,
            model: normalized.model,
            tier: extracted.tier,
            tokens: extracted.tokens,
            metadata,
          };
          if (state.recordSourceUsage("agy", usage)) {
            report.recorded += 1;
          }
        }

        if (activeAccount) {
          state.saveAgyFile({
            path,
            inode,
            size: stat.size,
            modified: stat.mtimeMs,
            walSize,
            walModified,
            account: activeAccount,
          });
        }
      })();
    } finally {
      opened.close();
    }
  }

  return report;
}
