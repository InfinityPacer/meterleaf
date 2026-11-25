/**
 * Claude Code 的 OpenTelemetry 日志只用来回答「这次请求属于哪个账户」，
 * Token 用量仍以采集器读取的会话记录为准。OTLP/HTTP JSON 的字段名遵循
 * protobuf JSON 映射，例如属性值为 `{"stringValue": "..."}`。
 */
export const OTEL_LOGS_PATH = "/api/otel/v1/logs";
/** 与采集批次相同上限；解压后的大小也受此约束。 */
export const OTEL_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
/** 记录 body 与 event.name 两种事件标记，任一命中即视为一次 API 请求或请求失败。 */
export const OTEL_API_REQUEST_BODY = "claude_code.api_request";
export const OTEL_API_REQUEST_EVENT = "api_request";
/**
 * 非用户中断的请求失败事件同样带 request_id 与账户，只用于归属；失败耗时不代表
 * 成功请求的官方耗时，因此不读取 duration_ms 与首 Token 延迟。
 */
export const OTEL_API_ERROR_BODY = "claude_code.api_error";
export const OTEL_API_ERROR_EVENT = "api_error";
/** 单次请求最多处理的记录数；超出部分忽略，避免异常客户端放大写入。 */
export const OTEL_MAX_RECORDS = 10_000;

/** 服务端从一条日志记录中保留的字段；其余属性一律不读取、不落库。 */
export interface OtelRequestAccount {
  requestId: string;
  accountUuid: string | null;
  organizationUuid: string | null;
  sessionId: string | null;
  model: string | null;
  /** 请求发生时间；event.timestamp 缺失时取记录时间，仍无法解析时保留 null。 */
  occurredAt: string | null;
  /** 官方 claude_code.api_request 上报的总耗时（毫秒）。 */
  durationMs?: number | null;
  /** 官方 claude_code.api_request 上报的首 Token 延迟（毫秒）。 */
  firstTokenMs?: number | null;
}

/** Codex 官方 OTLP 日志中与单次模型请求耗时相关的只读事件，不含提示词或邮箱等敏感信息。 */
export type CodexOtelEvent =
  | {
      kind: "request_start";
      sessionId: string;
      occurredAtMs: number;
      durationMs: number | null;
    }
  | {
      kind: "response_completed";
      sessionId: string;
      occurredAtMs: number;
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheWriteTokens: number | null;
      outputTokens: number | null;
      reasoningTokens: number | null;
      firstTokenMs: number | null;
      durationMs: number | null;
    };

type JsonObject = Record<string, unknown>;

const requestIdMax = 256;
const attributeMax = 128;
const maxLatencyMs = 24 * 60 * 60 * 1000;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function array(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** OTLP JSON 的 AnyValue 字符串提取。 */
function stringValue(value: unknown): string | null {
  const any = object(value);
  const text = any?.stringValue;
  return typeof text === "string" && text.length > 0 ? text : null;
}

/** OTLP JSON 的 AnyValue 布尔值提取（兼容 stringValue "true"/"false" 与 boolValue）。 */
function boolValue(value: unknown): boolean | null {
  const any = object(value);
  if (!any) return null;
  if (typeof any.boolValue === "boolean") return any.boolValue;
  if (any.stringValue === "true") return true;
  if (any.stringValue === "false") return false;
  return null;
}

/** OTLP JSON 的 AnyValue 非负整毫秒/计数提取（兼容 intValue、doubleValue、stringValue）。 */
function nonNegativeIntValue(value: unknown, max: number): number | null {
  const any = object(value);
  if (!any) return null;
  let parsed: number | null = null;
  if (typeof any.intValue === "number") parsed = any.intValue;
  else if (typeof any.intValue === "string" && /^\d+$/.test(any.intValue))
    parsed = Number(any.intValue);
  else if (typeof any.doubleValue === "number") parsed = any.doubleValue;
  else if (
    typeof any.stringValue === "string" &&
    /^\d+(?:\.\d+)?$/.test(any.stringValue)
  )
    parsed = Number(any.stringValue);
  if (parsed === null || !Number.isFinite(parsed) || parsed < 0 || parsed > max)
    return null;
  return Math.round(parsed);
}

function rawAttributeMap(value: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const item of array(value) ?? []) {
    const entry = object(item);
    const key = entry?.key;
    if (typeof key === "string" && entry?.value !== undefined)
      map.set(key, entry.value);
  }
  return map;
}

function bounded(value: string | null | undefined, max: number): string | null {
  return value && value.length <= max ? value : null;
}

/**
 * 归属时间按文本比较先后，只接受四位年份的 UTC 时间；超出 0000–9999 年时
 * toISOString 会输出带符号的扩展年份，文本序与时间序不一致，视为无效。
 */
// Date.UTC 会把 0–99 年映射到 1900 年代，下界直接按文本解析。
export const MIN_STANDARD_ISO_MS = Date.parse("0000-01-01T00:00:00.000Z");
export const MAX_STANDARD_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** 毫秒时间在四位年份范围内时返回标准 ISO 文本，否则返回 null。 */
export function standardIso(ms: number): string | null {
  if (
    !Number.isFinite(ms) ||
    ms < MIN_STANDARD_ISO_MS ||
    ms > MAX_STANDARD_ISO_MS
  )
    return null;
  return new Date(ms).toISOString();
}

/** event.timestamp 是 ISO 时间；记录时间在 OTLP JSON 里是纳秒字符串。 */
function isoFromText(value: string | null): string | null {
  if (!value) return null;
  return standardIso(Date.parse(value));
}

function isoFromNanos(value: unknown): string | null {
  let nanos: bigint;
  if (typeof value === "string" && /^\d+$/.test(value)) nanos = BigInt(value);
  else if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
    nanos = BigInt(value);
  else return null;
  const millis = Number(nanos / 1_000_000n);
  return standardIso(millis);
}

/**
 * 解析 OTLP/HTTP JSON 中的 Claude Code API 请求与请求失败日志。只提取请求 ID、账户、组织、
 * 会话、模型与时间（成功请求另取官方耗时）；提示词、回复、工具内容和路径即使随请求到达也不读取。
 * 返回 null 表示整体格式无效（400）；单条记录不完整时忽略该条。
 *
 * 服务端直接接收 OTEL 日志和本机中转入队都使用这一份解析，避免两处字段口径不同。
 */
export function parseOtelRequestAccounts(
  payload: unknown,
): OtelRequestAccount[] | null {
  const root = object(payload);
  const resourceLogs = root ? array(root.resourceLogs) : null;
  if (!resourceLogs) return null;
  const records: OtelRequestAccount[] = [];
  for (const resourceLog of resourceLogs) {
    const resourceEntry = object(resourceLog);
    if (!resourceEntry) continue;
    const resourceAttributes = rawAttributeMap(
      object(resourceEntry.resource)?.attributes,
    );
    for (const scopeLog of array(resourceEntry.scopeLogs) ?? []) {
      const scopeEntry = object(scopeLog);
      if (!scopeEntry) continue;
      for (const item of array(scopeEntry.logRecords) ?? []) {
        const logRecord = object(item);
        if (!logRecord) continue;
        // logRecord 与 resource 都可能带属性；同名的以更接近记录的一层为准。
        const attributes = new Map(resourceAttributes);
        for (const [key, value] of rawAttributeMap(logRecord.attributes))
          attributes.set(key, value);
        const str = (key: string) => stringValue(attributes.get(key));
        const body = stringValue(logRecord.body);
        const eventName = str("event.name");
        // 任一层带失败标记就按失败处理：body 与 event.name 可能分别来自记录和 resource。
        const isError =
          body === OTEL_API_ERROR_BODY || eventName === OTEL_API_ERROR_EVENT;
        const isRequest =
          body === OTEL_API_REQUEST_BODY ||
          eventName === OTEL_API_REQUEST_EVENT;
        if (!isRequest && !isError) continue;
        const requestId = bounded(str("request_id"), requestIdMax);
        if (!requestId) continue;
        const durationMs = isError
          ? null
          : nonNegativeIntValue(attributes.get("duration_ms"), maxLatencyMs);
        const firstTokenMs = isError
          ? null
          : (nonNegativeIntValue(attributes.get("ttft_ms"), maxLatencyMs) ??
            nonNegativeIntValue(
              attributes.get("first_token_ms"),
              maxLatencyMs,
            ));
        const entry: OtelRequestAccount = {
          requestId,
          accountUuid: bounded(str("user.account_uuid"), requestIdMax),
          organizationUuid: bounded(str("organization.id"), requestIdMax),
          sessionId: bounded(str("session.id"), requestIdMax),
          model: bounded(str("model"), attributeMax),
          occurredAt:
            isoFromText(str("event.timestamp")) ??
            isoFromNanos(logRecord.timeUnixNano) ??
            isoFromNanos(logRecord.observedTimeUnixNano),
        };
        if (durationMs !== null) entry.durationMs = durationMs;
        if (firstTokenMs !== null) entry.firstTokenMs = firstTokenMs;
        records.push(entry);
        if (records.length >= OTEL_MAX_RECORDS) return records;
      }
    }
  }
  return records;
}

/**
 * 解析 Codex CLI 官方 OTLP/HTTP JSON 日志中的请求起止与 TTFT 事件：
 * - codex.websocket_request / codex.api_request（排除 /models）：记录单次请求的发起时刻；
 * - codex.sse_event（event.kind = response.completed）：携带官方 ttft_ms 与精确 Token 计数。
 * 不读取提示词、回复、邮箱或路径。
 */
export function parseCodexOtelEvents(
  payload: unknown,
): CodexOtelEvent[] | null {
  const root = object(payload);
  const resourceLogs = root ? array(root.resourceLogs) : null;
  if (!resourceLogs) return null;
  const events: CodexOtelEvent[] = [];
  const maxTokens = 1_000_000_000;
  for (const resourceLog of resourceLogs) {
    const resourceEntry = object(resourceLog);
    if (!resourceEntry) continue;
    const resourceAttributes = rawAttributeMap(
      object(resourceEntry.resource)?.attributes,
    );
    for (const scopeLog of array(resourceEntry.scopeLogs) ?? []) {
      const scopeEntry = object(scopeLog);
      if (!scopeEntry) continue;
      for (const item of array(scopeEntry.logRecords) ?? []) {
        const logRecord = object(item);
        if (!logRecord) continue;
        const attributes = new Map(resourceAttributes);
        for (const [key, value] of rawAttributeMap(logRecord.attributes))
          attributes.set(key, value);
        const str = (key: string) => stringValue(attributes.get(key));
        const eventName = str("event.name");
        if (
          eventName !== "codex.websocket_request" &&
          eventName !== "codex.api_request" &&
          eventName !== "codex.sse_event"
        )
          continue;
        const sessionId = bounded(str("conversation.id"), requestIdMax);
        if (!sessionId) continue;
        const occurredIso =
          isoFromText(str("event.timestamp")) ??
          isoFromNanos(logRecord.timeUnixNano) ??
          isoFromNanos(logRecord.observedTimeUnixNano);
        const occurredAtMs = occurredIso ? Date.parse(occurredIso) : Number.NaN;
        if (!Number.isFinite(occurredAtMs)) continue;

        if (
          eventName === "codex.websocket_request" ||
          eventName === "codex.api_request"
        ) {
          if (boolValue(attributes.get("success")) === false) continue;
          const endpoint = str("endpoint");
          if (endpoint === "/models") continue;
          const durationMs = nonNegativeIntValue(
            attributes.get("duration_ms"),
            maxLatencyMs,
          );
          events.push({
            kind: "request_start",
            sessionId,
            occurredAtMs,
            durationMs:
              durationMs !== null && durationMs > 0 ? durationMs : null,
          });
        } else if (
          eventName === "codex.sse_event" &&
          str("event.kind") === "response.completed"
        ) {
          const inputTokens = nonNegativeIntValue(
            attributes.get("input_token_count"),
            maxTokens,
          );
          const cachedTokens = nonNegativeIntValue(
            attributes.get("cached_token_count"),
            maxTokens,
          );
          const cacheWriteTokens = nonNegativeIntValue(
            attributes.get("cache_write_token_count"),
            maxTokens,
          );
          const outputTokens = nonNegativeIntValue(
            attributes.get("output_token_count"),
            maxTokens,
          );
          const reasoningTokens = nonNegativeIntValue(
            attributes.get("reasoning_token_count"),
            maxTokens,
          );
          const firstTokenMs = nonNegativeIntValue(
            attributes.get("ttft_ms"),
            maxLatencyMs,
          );
          const durationMs = nonNegativeIntValue(
            attributes.get("duration_ms"),
            maxLatencyMs,
          );
          // 跳过启动预热空响应（例如 2 input / 0 output 且无 ttft_ms）。
          if (
            (outputTokens ?? 0) === 0 &&
            (inputTokens ?? 0) <= 2 &&
            firstTokenMs === null
          )
            continue;
          events.push({
            kind: "response_completed",
            sessionId,
            occurredAtMs,
            inputTokens,
            cachedTokens,
            cacheWriteTokens,
            outputTokens,
            reasoningTokens,
            firstTokenMs,
            durationMs,
          });
        }
        if (events.length >= OTEL_MAX_RECORDS) return events;
      }
    }
  }
  return events;
}
