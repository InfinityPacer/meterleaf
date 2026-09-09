import type { FastifyInstance, FastifyReply } from "fastify";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

const LEDGER_ROUTES = new Set(["/api/ledger", "/api/view"]);
const COMPRESSION_THRESHOLD_BYTES = 1024;
const GZIP_INPUT_CHUNK_BYTES = 64 * 1024;

type CompressiblePayload = string | Buffer;
type AcceptEncodingHeader = string | string[] | undefined;

/** 为大账本 JSON 响应注册协商式 gzip；其他路由保持原有传输行为。 */
export function registerResponseCompression(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      !LEDGER_ROUTES.has(request.routeOptions.url ?? "") ||
      !isJsonResponse(reply)
    )
      return payload;

    appendVary(reply, "Accept-Encoding");
    if (
      hasContentEncoding(reply) ||
      !acceptsGzip(request.headers["accept-encoding"]) ||
      !isCompressiblePayload(payload)
    )
      return payload;

    const payloadBytes =
      typeof payload === "string"
        ? Buffer.byteLength(payload)
        : payload.byteLength;
    if (payloadBytes < COMPRESSION_THRESHOLD_BYTES) return payload;

    // 单次流式压缩不预先缓存结果；删除原始 JSON 的长度后由 HTTP 分块传输。
    reply.header("Content-Encoding", "gzip");
    reply.removeHeader("Content-Length");
    return createPayloadStream(payload).pipe(createGzip());
  });
}

function isJsonResponse(reply: FastifyReply): boolean {
  const contentType = reply.getHeader("content-type");
  if (typeof contentType !== "string") return false;
  return (
    contentType.split(";", 1)[0].trim().toLowerCase() === "application/json"
  );
}

function isCompressiblePayload(
  payload: unknown,
): payload is CompressiblePayload {
  return typeof payload === "string" || Buffer.isBuffer(payload);
}

function hasContentEncoding(reply: FastifyReply): boolean {
  const value = reply.getHeader("content-encoding");
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => item.trim() !== "");
  return String(value).trim() !== "";
}

function appendVary(reply: FastifyReply, field: string): void {
  const current = reply.getHeader("vary");
  const values = (Array.isArray(current) ? current : [current])
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.some((value) => value.toLowerCase() === field.toLowerCase()))
    return;
  reply.header("Vary", [...values, field].join(", "));
}

function acceptsGzip(header: AcceptEncodingHeader): boolean {
  if (header === undefined) return false;

  let explicitGzipQuality: number | undefined;
  let wildcardQuality: number | undefined;
  for (const value of Array.isArray(header) ? header : [header]) {
    for (const item of value.split(",")) {
      const [codingPart, ...parameters] = item.split(";");
      const coding = codingPart.trim().toLowerCase();
      if (!coding) continue;
      const quality = parseQuality(parameters);
      if (coding === "gzip") {
        explicitGzipQuality =
          explicitGzipQuality === undefined
            ? quality
            : Math.max(explicitGzipQuality, quality);
      } else if (coding === "*") {
        wildcardQuality =
          wildcardQuality === undefined
            ? quality
            : Math.max(wildcardQuality, quality);
      }
    }
  }

  return (explicitGzipQuality ?? wildcardQuality ?? 0) > 0;
}

function parseQuality(parameters: string[]): number {
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0) continue;
    if (parameter.slice(0, separator).trim().toLowerCase() !== "q") continue;
    const value = Number(parameter.slice(separator + 1).trim());
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
  }
  return 1;
}

function createPayloadStream(payload: CompressiblePayload): Readable {
  return Readable.from(
    Buffer.isBuffer(payload) ? bufferChunks(payload) : stringChunks(payload),
  );
}

function* bufferChunks(payload: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < payload.byteLength;) {
    const end = Math.min(offset + GZIP_INPUT_CHUNK_BYTES, payload.byteLength);
    yield payload.subarray(offset, end);
    offset = end;
  }
}

function* stringChunks(payload: string): Generator<string> {
  for (let offset = 0; offset < payload.length;) {
    let end = Math.min(offset + GZIP_INPUT_CHUNK_BYTES, payload.length);
    if (end < payload.length && isHighSurrogate(payload.charCodeAt(end - 1)))
      end -= 1;
    yield payload.slice(offset, end);
    offset = end;
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}
