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
