import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  1417: { model: "gemini-4-argon", effort: "high" },
  1418: { model: "gemini-4-argon", effort: "medium" },
  1419: { model: "gemini-4-argon", effort: "low" },
  1427: { model: "gemini-4-carbon", effort: "high" },
  1437: { model: "gemini-4-carbon", effort: "medium" },
  1438: { model: "gemini-4-carbon", effort: "low" },
};

const displayModels: Record<string, string> = {
  "gemini 4 carbon": "gemini-4-carbon",
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
interface AgyInstance {
  /** 默认实例为 null；额外实例为 antigravity-cli-<name> 的后缀名。 */
  profileName: string | null;
  appDataDir: string;
  geminiDir: string;
  conversationsDir: string;
}

/**
 * 列出所有需要扫描的 Antigravity CLI 实例。
 * 默认实例取 sources.conversationsDir；当它位于 <geminiDir>/antigravity-cli/conversations 时，
 * 自动发现同级 <geminiDir>/antigravity-cli-<name> 下的额外账户实例。
 */
function discoverAgyInstances(conversationsDir: string): AgyInstance[] {
  const appDataDir = dirname(conversationsDir);
  const geminiDir = dirname(appDataDir);
  const instances: AgyInstance[] = [
    {
      profileName: null,
      appDataDir,
      geminiDir,
      conversationsDir,
    },
  ];
  if (
    basename(conversationsDir) !== "conversations" ||
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
  const prefix = "antigravity-cli-";
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const profileName = name.slice(prefix.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileName)) continue;
    const profileAppDataDir = join(geminiDir, name);
    try {
      if (!statSync(profileAppDataDir).isDirectory()) continue;
    } catch {
      continue;
    }
    instances.push({
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

/** 从实例目录最近几份 log/cli-*.log 或 cli.log 中提取最近一次登录成功的账号标签。 */
function labelFromAppDataLogs(appDataDir: string): string | null {
  const candidates: string[] = [];
  try {
    const logDir = join(appDataDir, "log");
    const names = readdirSync(logDir)
      .filter((name) => name.startsWith("cli-") && name.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 5);
    for (const name of names) candidates.push(join(logDir, name));
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
      readAgyCurrentAccount(statuslineDir, instance.profileName) ??
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
/**
 * 读取一轮 Antigravity 状态栏额度缓存与本地会话数据库。
 * 1. 扫描 statuslineDir 下所有 quota-<label>.tsv，为每个 Google 账号建立 Gemini 与 Claude/GPT
 *    两个配额池账户并上报额度快照；
 * 2. 读取默认实例及同级 antigravity-cli-<name> 额外实例的账号归属；
 * 3. 只读扫描各实例 conversationsDir 下所有 *.db 的 gen_metadata 与 steps，按模型归入对应账户，
 *    通过 source_usage 保持重跑幂等。
 */
export function readAgy(
  state: CollectorState,
  sources: AgyReaderSources,
  now: Date = new Date(),
): AgyReaderReport {
  const report = emptyAgyReport();
  const plans = readPlanMap(state);

  for (const label of listAgyQuotaLabels(sources.statuslineDir)) {
    const cache = readAgyQuotaFile(
      join(sources.statuslineDir, agyQuotaFileName(label)),
      label,
      now,
    );
    if (!cache) continue;
    report.quotaIgnoredLines += cache.ignoredLines;
    if (cache.plan) plans[label] = cache.plan;
    const effectivePlan = plans[label] ?? null;
    const accounts = agyAccountsForLabel(label, effectivePlan);
    state.write(() => {
      state.upsertAccount(accounts.account);
      for (const legacy of accounts.legacy) state.upsertAccount(legacy);
      if (cache.entries.length > 0) {
        const snapshot = agyQuotaSnapshot(cache);
        if (state.recordQuota(snapshot, `agy:${label}`)) {
          report.quotas += snapshot.quotas.length;
        }
      }
      state.setMeta("agy_plans", JSON.stringify(plans));
    });
  }

  const instances = discoverAgyInstances(sources.conversationsDir);
  const defaultLabel = resolveInstanceLabel(
    instances[0]!,
    sources.statuslineDir,
  );
  report.activeAccount = defaultLabel;

  const startMs = Date.parse(sources.start);
  const startIso = new Date(startMs).toISOString();
  const allDbPaths = new Set<string>();
  const instanceDbs: {
    instance: AgyInstance;
    label: string | null;
    dbPaths: string[];
  }[] = [];

  for (const instance of instances) {
    const label =
      instance.profileName === null
        ? defaultLabel
        : resolveInstanceLabel(instance, sources.statuslineDir);
    if (label) {
      const accounts = agyAccountsForLabel(label, plans[label] ?? null);
      state.upsertAccount(accounts.account);
      for (const legacy of accounts.legacy) state.upsertAccount(legacy);
    }
    if (!existsSync(instance.conversationsDir)) continue;
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
    instanceDbs.push({ instance, label, dbPaths });
  }

  state.forgetMissingAgyFiles(allDbPaths);
  const dirtyProfiles = new Set<string | null>();

  for (const { instance, label: instanceAccount, dbPaths } of instanceDbs) {
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
        saved.account === (instanceAccount ?? "")
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
          if (instanceAccount) {
            state.saveAgyFile({
              path,
              inode,
              size: stat.size,
              modified: stat.mtimeMs,
              walSize,
              walModified,
              account: instanceAccount,
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

        state.write(() => {
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

            if (!instanceAccount) {
              report.skipped["(缺失账户)"] =
                (report.skipped["(缺失账户)"] ?? 0) + 1;
              dirtyProfiles.add(instance.profileName);
              continue;
            }

            const accountExternalId = agyAccountId(instanceAccount);
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
              dirtyProfiles.add(instance.profileName);
            }
          }

          if (instanceAccount) {
            state.saveAgyFile({
              path,
              inode,
              size: stat.size,
              modified: stat.mtimeMs,
              walSize,
              walModified,
              account: instanceAccount,
            });
          }
        });
      } finally {
        opened.close();
      }
    }
  }

  state.setMeta("agy_dirty_profiles", JSON.stringify([...dirtyProfiles]));
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
  /** 指定需要刷新的实例名（null 为默认实例）；省略时刷新默认实例。 */
  profiles?: readonly (string | null)[];
  /** 内部传递：刷新指定额外实例时使用其 geminiDir 与 appDataDir。 */
  profileName?: string | null;
  geminiDir?: string;
  appDataDir?: string;
}
export interface OmpQuotaRefreshOptions {
  /** 覆盖 omp 可执行文件位置，默认读 OMP_BIN 再按固定目录查找。 */
  ompBin?: string;
  timeoutMs?: number;
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
      const resetMs =
        typeof bucket?.reset_time === "string"
          ? Date.parse(bucket.reset_time)
          : NaN;
      if (
        !key ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1 ||
        !Number.isFinite(resetMs)
      )
        continue;
      const used = Math.round((1 - remaining) * 100);
      rows.set(key, `${key}\t${used}\t${Math.floor(resetMs / 1000)}`);
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
  const agyBin = findExecutable("agy", options.agyBin ?? process.env.AGY_BIN);
  if (!agyBin) return { ...result, error: "找不到 agy 可执行文件" };
  result.attempted = true;
  const tempDir = mkdtempSync(join(tmpdir(), "meterleaf-agy-usage-"));
  const logFile = join(tempDir, "agy.log");
  const outFile = join(tempDir, "usage.json");
  const profileName = options.profileName ?? null;
  try {
    const env = probeEnv();
    env.METERLEAF_AGY_PROBE = "1";
    env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
    env.BROWSER = "/usr/bin/false";

    const argv = [agyBin];
    if (profileName !== null) {
      env.WSL_INTEROP = "1";
      if (options.geminiDir) argv.push("--gemini_dir", options.geminiDir);
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
          readAgyCurrentAccount(sources.statuslineDir, profileName) ??
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
      readAgyCurrentAccount(sources.statuslineDir, profileName) !== logged
    ) {
      const accountFile = profileName
        ? `current-account-${profileName}`
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
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function maybeRefreshInstanceQuota(
  state: CollectorState,
  sources: AgyReaderSources,
  instance: AgyInstance,
  now: Date,
  options: AgyRefreshOptions,
): Promise<AgyQuotaRefreshResult> {
  const skipped: AgyQuotaRefreshResult = {
    attempted: false,
    refreshed: false,
    label: null,
    error: null,
  };
  const profileName = instance.profileName;
  const refreshAtKey = profileName
    ? `agy_quota_refresh_at:${profileName}`
    : "agy_quota_refresh_at";
  const statusKey = profileName
    ? `agy_quota_refresh_status:${profileName}`
    : "agy_quota_refresh_status";
  const displayName = profileName
    ? `Antigravity (@${profileName})`
    : "Antigravity";

  const lastAttemptAt = state.getMeta(refreshAtKey);
  if (lastAttemptAt) {
    const elapsed = now.getTime() - Date.parse(lastAttemptAt);
    if (elapsed >= 0 && elapsed < refreshIntervalMs) return skipped;
  }
  const label = resolveInstanceLabel(instance, sources.statuslineDir);
  if (label) {
    try {
      const cacheAge =
        now.getTime() -
        statSync(join(sources.statuslineDir, agyQuotaFileName(label))).mtimeMs;
      if (cacheAge < refreshIntervalMs) return skipped;
    } catch {
      // 还没有额度缓存，需要刷新。
    }
  }
  state.setMeta(refreshAtKey, now.toISOString());
  const result = await refreshAgyQuota(sources, {
    ...options,
    profileName,
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
 * 发现新的 Antigravity 用量后调用。距上次尝试不足 5 分钟，或状态栏刚写过额度缓存时
 * 直接跳过。尝试时间在启动 agy 之前写入，失败也按 5 分钟退避，不会每分钟重试。
 * 错误只在与上轮不同时记一行日志。
 */
export async function maybeRefreshAgyQuota(
  state: CollectorState,
  sources: AgyReaderSources,
  now: Date = new Date(),
  options: AgyRefreshOptions = {},
): Promise<AgyQuotaRefreshResult> {
  const instances = discoverAgyInstances(sources.conversationsDir);
  let targets: readonly (string | null)[] = [null];
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
      // 忽略损坏的元信息，回退到默认实例。
    }
    if (targets.length === 0) targets = [null];
  }
  const finalResult: AgyQuotaRefreshResult = {
    attempted: false,
    refreshed: false,
    label: null,
    error: null,
  };
  for (const target of targets) {
    const instance =
      instances.find((item) => item.profileName === target) ??
      (target === null ? instances[0]! : null);
    if (!instance) continue;
    const res = await maybeRefreshInstanceQuota(
      state,
      sources,
      instance,
      now,
      options,
    );
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

// ---- 经 omp 刷新所有已登录 Google 账号的额度 ----

/** 额度已用完时 omp 会收到 429，此后不再产生用量，所以单独用较短的间隔去读一次实时额度。 */
const exhaustedRefreshIntervalMs = 60_000;

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
      const resetMs = (limit?.window as { resetsAt?: unknown })?.resetsAt;
      if (
        !key ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1 ||
        typeof resetMs !== "number" ||
        !Number.isFinite(resetMs)
      )
        continue;
      const used = Math.round((1 - remaining) * 100);
      rows.set(key, `${key}\t${used}\t${Math.floor(resetMs / 1000)}`);
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
  const ompBin = findExecutable("omp", options.ompBin ?? process.env.OMP_BIN);
  if (!ompBin) return { ...result, error: "找不到 omp 可执行文件" };
  result.attempted = true;
  const tempDir = mkdtempSync(join(tmpdir(), "meterleaf-omp-usage-"));
  const outFile = join(tempDir, "usage.json");
  const provider = "--provider=google-antigravity";
  try {
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
    mkdirSync(sources.statuslineDir, { recursive: true, mode: 0o700 });
    for (const [label, rows] of accounts)
      mergeQuotaFile(
        join(sources.statuslineDir, agyQuotaFileName(label)),
        rows,
      );
    return { ...result, refreshed: true, labels: [...accounts.keys()].sort() };
  } catch (error) {
    return {
      ...result,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
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
  const lastAttemptAt = state.getMeta("omp_agy_quota_refresh_at");
  if (lastAttemptAt) {
    const elapsed = now.getTime() - Date.parse(lastAttemptAt);
    const interval = trigger.exhausted
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
