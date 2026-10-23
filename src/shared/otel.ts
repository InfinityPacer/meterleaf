/**
 * Claude Code 的 OpenTelemetry 日志只用来回答「这次请求属于哪个账户」，
 * Token 用量仍以采集器读取的会话记录为准。OTLP/HTTP JSON 的字段名遵循
 * protobuf JSON 映射，例如属性值为 `{"stringValue": "..."}`。
 */
export const OTEL_LOGS_PATH = "/api/otel/v1/logs";
/** 与采集批次相同上限；解压后的大小也受此约束。 */
export const OTEL_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
/** 记录 body 与 event.name 两种事件标记，任一命中即视为一次 API 请求。 */
export const OTEL_API_REQUEST_BODY = "claude_code.api_request";
export const OTEL_API_REQUEST_EVENT = "api_request";
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
}

type JsonObject = Record<string, unknown>;

const requestIdMax = 256;
const attributeMax = 128;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function array(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** OTLP JSON 的 AnyValue 只取字符串；其余类型不是这些属性会用的形态。 */
function stringValue(value: unknown): string | null {
  const any = object(value);
  const text = any?.stringValue;
  return typeof text === "string" && text.length > 0 ? text : null;
}

function attributeMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of array(value) ?? []) {
    const entry = object(item);
    const key = entry?.key;
    const text = stringValue(entry?.value);
    if (typeof key === "string" && text !== null) map.set(key, text);
  }
  return map;
}

function bounded(value: string | undefined, max: number): string | null {
  return value !== undefined && value.length <= max ? value : null;
}

/** event.timestamp 是 ISO 时间；记录时间在 OTLP JSON 里是纳秒字符串。 */
function isoFromText(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
  if (!Number.isFinite(millis)) return null;
  const at = new Date(millis);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/**
 * 解析 OTLP/HTTP JSON 中的 Claude Code API 请求日志。只提取请求 ID、账户、组织、
 * 会话、模型与时间；提示词、回复、工具内容和路径即使随请求到达也不读取。
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
    const resourceAttributes = attributeMap(
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
        for (const [key, value] of attributeMap(logRecord.attributes))
          attributes.set(key, value);
        const body = stringValue(logRecord.body);
        if (
          body !== OTEL_API_REQUEST_BODY &&
          attributes.get("event.name") !== OTEL_API_REQUEST_EVENT
        )
          continue;
        const requestId = bounded(attributes.get("request_id"), requestIdMax);
        if (!requestId) continue;
        records.push({
          requestId,
          accountUuid: bounded(
            attributes.get("user.account_uuid"),
            requestIdMax,
          ),
          organizationUuid: bounded(
            attributes.get("organization.id"),
            requestIdMax,
          ),
          sessionId: bounded(attributes.get("session.id"), requestIdMax),
          model: bounded(attributes.get("model"), attributeMax),
          occurredAt:
            isoFromText(attributes.get("event.timestamp") ?? null) ??
            isoFromNanos(logRecord.timeUnixNano) ??
            isoFromNanos(logRecord.observedTimeUnixNano),
        });
        if (records.length >= OTEL_MAX_RECORDS) return records;
      }
    }
  }
  return records;
}
