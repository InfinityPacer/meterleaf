import type { IngestUsage } from "../../shared/ingest";

/** 事件在归属账户和首次出现时间确定前的计量部分。 */
export type UsageFact = Omit<IngestUsage, "accountExternalId" | "occurredAt">;

/**
 * 一行 JSONL 对某个 API 响应的一次观测。Claude Code 把同一响应按内容块拆成多行，
 * 每行携带同一份完整 usage，部分分组先写全零占位行；因此同一 key 只保留四桶合计最大的一行。
 */
export interface UsageObservation {
  key: string;
  timestamp: string;
  /** 普通输入、输出、缓存读取、缓存写入四个互斥桶之和，未知桶不计入。 */
  total: number;
  fact: UsageFact;
}

export type LineResult =
  | { kind: "usage"; observations: UsageObservation[] }
  | { kind: "malformed" }
  | { kind: "synthetic" }
  | { kind: "ignored" };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function bucketTotal(tokens: UsageFact["tokens"]): number {
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.cacheRead ?? 0) +
    (tokens.cacheWrite ?? 0)
  );
}

function tokensFrom(
  usage: JsonObject,
  reasoning: number | null,
): UsageFact["tokens"] {
  const split = object(usage.cache_creation);
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite5m: split ? count(split.ephemeral_5m_input_tokens) : null,
    cacheWrite1h: split ? count(split.ephemeral_1h_input_tokens) : null,
    reasoning,
  };
}

/** fast 是 Claude Code 的快速模式，按独立档位计价；其余沿用上游服务档位，缺失保留未知。 */
function tierFrom(usage: JsonObject): string | null {
  if (usage.speed === "fast") return "fast";
  return text(usage.service_tier, 32);
}

/** 只放计量相关短值；对话、路径、工作目录和分支都不进入元数据。 */
function metadataFrom(line: JsonObject, usage: JsonObject | null) {
  const metadata: UsageFact["metadata"] = {};
  const effort = text(line.effort);
  if (effort) metadata.reasoning_effort = effort;
  if (typeof line.isSidechain === "boolean") {
    metadata.is_sidechain = line.isSidechain;
  }
  const serverTools = usage ? object(usage.server_tool_use) : null;
  const searches = serverTools ? count(serverTools.web_search_requests) : null;
  const fetches = serverTools ? count(serverTools.web_fetch_requests) : null;
  if (searches !== null) metadata.web_search_requests = searches;
  if (fetches !== null) metadata.web_fetch_requests = fetches;
  const geo = usage ? text(usage.inference_geo) : null;
  if (geo && geo !== "not_available") metadata.inference_geo = geo;
  const version = text(line.version);
  if (version) metadata.client_version = version;
  return metadata;
}

/** 缺少 requestId 的行退回会话内消息 ID，仍能在重复写入的多行之间去重。 */
export function eventKey(line: JsonObject, messageId: string): string | null {
  const requestId = text(line.requestId, 128);
  if (requestId) return `${requestId}:${messageId}`;
  const sessionId = text(line.sessionId, 64);
  return sessionId ? `nr:${sessionId}:${messageId}` : null;
}

export function parseLine(raw: string): LineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  const line = object(parsed);
  if (!line || line.type !== "assistant") return { kind: "ignored" };
  const message = object(line.message);
  const usage = message ? object(message.usage) : null;
  if (!message || !usage) return { kind: "ignored" };
  if (message.model === "<synthetic>") return { kind: "synthetic" };
  const model = text(message.model, 128);
  const messageId = text(message.id, 120);
  const at = timestamp(line.timestamp);
  if (!model || !messageId || !at) return { kind: "ignored" };
  const key = eventKey(line, messageId);
  if (!key) return { kind: "ignored" };

  const details = object(usage.output_tokens_details);
  const tokens = tokensFrom(
    usage,
    details ? count(details.thinking_tokens) : null,
  );
  const observations: UsageObservation[] = [
    {
      key,
      timestamp: at,
      total: bucketTotal(tokens),
      fact: {
        externalId: key,
        model,
        tier: tierFrom(usage),
        tokens,
        metadata: metadataFrom(line, usage),
      },
    },
  ];

  // advisor 迭代由另一模型完成，按独立事件记账，键从父事件派生以保持幂等。
  if (Array.isArray(usage.iterations)) {
    usage.iterations.forEach((entry, index) => {
      const iteration = object(entry);
      if (!iteration || iteration.type !== "advisor_message") return;
      const advisorModel = text(iteration.model, 128);
      if (!advisorModel) return;
      const advisorTokens = tokensFrom(iteration, null);
      const advisorKey = `${key}:advisor:${index}`;
      const metadata: UsageFact["metadata"] = { is_advisor: true };
      if (typeof line.isSidechain === "boolean") {
        metadata.is_sidechain = line.isSidechain;
      }
      const version = text(line.version);
      if (version) metadata.client_version = version;
      observations.push({
        key: advisorKey,
        timestamp: at,
        total: bucketTotal(advisorTokens),
        fact: {
          externalId: advisorKey,
          model: advisorModel,
          tier: tierFrom(iteration),
          tokens: advisorTokens,
          metadata,
        },
      });
    });
  }
  return { kind: "usage", observations };
}

/** 行级预筛：只有含 usage 的行才可能是计费响应，避免解析大段工具输出。 */
export function mayContainUsage(raw: string): boolean {
  return raw.includes('"usage"');
}
