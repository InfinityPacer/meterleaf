import { gunzipSync } from "node:zlib";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  OTEL_API_REQUEST_BODY,
  OTEL_API_REQUEST_EVENT,
  OTEL_BODY_LIMIT_BYTES,
  OTEL_LOGS_PATH,
  OTEL_MAX_RECORDS,
  type OtelRequestAccount,
} from "../shared/otel";
import { matchIngestKey, type IngestTarget } from "./ingest";
import type { DiagnosticsLogger } from "./diagnostics";

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

interface OtelRequestState {
  ingestKey?: ReturnType<typeof matchIngestKey>;
  bodyError?: 400 | 413;
}

function headerText(value: string | string[] | undefined): string {
  return (
    (Array.isArray(value) ? value[0] : value)
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

/**
 * OTLP/HTTP 日志入口：与采集批次共用写入密钥，密钥决定 sourceId。
 * 接受 application/json（可 gzip），成功返回空的 ExportLogsServiceResponse。
 * 与推送接口一样只写不读，不提供任何查询能力。
 */
export function registerOtelRoutes(
  app: FastifyInstance,
  target: IngestTarget,
  diagnostics: DiagnosticsLogger,
) {
  if (!target.keys.length) return;
  app.register(async (scope) => {
    scope.addHook("onRequest", async (request, reply) => {
      const key = matchIngestKey(request.headers.authorization, target.keys);
      if (!key) return reply.code(401).send({ error: "invalid ingest key" });
      (request as FastifyRequest & OtelRequestState).ingestKey = key;
      if (headerText(request.headers["content-type"]) !== "application/json")
        return reply.code(415).send({ error: "unsupported media type" });
      const encoding = headerText(request.headers["content-encoding"]);
      if (encoding && encoding !== "identity" && encoding !== "gzip")
        return reply.code(415).send({ error: "unsupported content encoding" });
    });

    // 先按字节接收，再自行解压并解析，使 gzip 与解压后大小都能在落库前受控。
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: OTEL_BODY_LIMIT_BYTES },
      (request, body, done) => {
        const encoding = headerText(request.headers["content-encoding"]);
        if (!encoding || encoding === "identity") {
          done(null, body);
          return;
        }
        try {
          done(
            null,
            gunzipSync(body as Buffer, {
              maxOutputLength: OTEL_BODY_LIMIT_BYTES,
            }),
          );
        } catch (error) {
          (request as FastifyRequest & OtelRequestState).bodyError =
            error instanceof RangeError ||
            (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
              ? 413
              : 400;
          done(null, Buffer.alloc(0));
        }
      },
    );

    scope.post(
      OTEL_LOGS_PATH,
      { bodyLimit: OTEL_BODY_LIMIT_BYTES },
      (request, reply) => {
        const state = request as FastifyRequest & OtelRequestState;
        if (state.bodyError)
          return reply
            .code(state.bodyError)
            .send({ error: "invalid compressed body" });
        const key = state.ingestKey!;
        if (!Buffer.isBuffer(request.body))
          return reply.code(400).send({ error: "invalid otlp payload" });
        let payload: unknown;
        try {
          payload = JSON.parse(request.body.toString("utf8"));
        } catch {
          return reply.code(400).send({ error: "invalid otlp payload" });
        }
        const records = parseOtelRequestAccounts(payload);
        if (!records)
          return reply.code(400).send({ error: "invalid otlp payload" });
        const result = target.saveOtel?.(
          key.sourceId,
          records,
          new Date().toISOString(),
        );
        // 只记条数，不记请求 ID、账户或任何属性内容。
        diagnostics.info("otel.accepted", {
          records: records.length,
          rewritten: result?.rewritten ?? 0,
        });
        return {};
      },
    );
  });
}
