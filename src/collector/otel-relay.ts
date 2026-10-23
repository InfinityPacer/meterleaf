import { gunzipSync } from "node:zlib";
import {
  OTEL_BODY_LIMIT_BYTES,
  parseOtelRequestAccounts,
} from "../shared/otel";
import type { CollectorState } from "./state";

/** Claude Code 的 OTLP 导出器发到这台电脑的回环地址，不经过网络。 */
export const OTEL_RELAY_HOST = "127.0.0.1";
/** 本地入口使用 OTLP 标准路径；服务端入口仍是 /api/otel/v1/logs。 */
export const OTEL_RELAY_PATH = "/v1/logs";

export interface OtelRelayOptions {
  port: number;
  /** 测试可改成其他回环地址或端口 0；默认只监听 127.0.0.1。 */
  hostname?: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface OtelRelay {
  readonly server: ReturnType<typeof Bun.serve>;
  /** 实际监听端口；传入 0 时由系统分配。 */
  readonly port: number;
  stop(): Promise<void>;
}

function headerText(value: string | null): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function invalid(error: string, status: 400 | 404 | 405 | 413 | 415 | 503) {
  return Response.json({ error }, { status });
}

/** gzip 解压超过上限时 Bun 抛 RangeError，也可能带 ERR_BUFFER_TOO_LARGE。 */
function isTooLarge(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

/**
 * 本机 OTEL 中继：Claude Code 把日志发到 127.0.0.1，中继只保留请求归属字段并按
 * requestId 写入采集器的 outbox，随后由每分钟一次的 sync 和用量一起推送。
 *
 * 只监听回环地址，因此不校验鉴权；请求里即使带着旧的 otelHeadersHelper 提供的
 * Authorization 头也直接忽略。写库失败返回 503，让 Claude Code 自己重试。
 */
export function startOtelRelay(
  state: CollectorState,
  options: OtelRelayOptions,
): OtelRelay {
  const log = options.log ?? console.log;
  const now = options.now ?? (() => new Date());
  const server = Bun.serve({
    hostname: options.hostname ?? OTEL_RELAY_HOST,
    port: options.port,
    // 压缩前的请求体也受同一上限约束；解压后的大小在下面单独检查。
    maxRequestBodySize: OTEL_BODY_LIMIT_BYTES,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== OTEL_RELAY_PATH) return invalid("not found", 404);
      if (request.method !== "POST")
        return new Response(JSON.stringify({ error: "method not allowed" }), {
          status: 405,
          headers: { "content-type": "application/json", allow: "POST" },
        });
      if (
        headerText(request.headers.get("content-type")) !== "application/json"
      )
        return invalid("unsupported media type", 415);
      const encoding = headerText(request.headers.get("content-encoding"));
      if (encoding && encoding !== "identity" && encoding !== "gzip")
        return invalid("unsupported content encoding", 415);

      let body: Buffer;
      try {
        const raw = Buffer.from(await request.arrayBuffer());
        if (raw.byteLength > OTEL_BODY_LIMIT_BYTES)
          return invalid("request body too large", 413);
        body =
          !encoding || encoding === "identity"
            ? raw
            : gunzipSync(raw, { maxOutputLength: OTEL_BODY_LIMIT_BYTES });
      } catch (error) {
        return isTooLarge(error)
          ? invalid("request body too large", 413)
          : invalid("invalid compressed body", 400);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return invalid("invalid otlp payload", 400);
      }
      const records = parseOtelRequestAccounts(payload);
      if (!records) return invalid("invalid otlp payload", 400);

      try {
        state.enqueueOtel(records);
      } catch {
        // 数据库暂时不可写时让 Claude Code 按导出器的重试策略再发一次。
        log(`${now().toISOString()} 本机 OTEL 中转写库失败，返回 503 等待重试`);
        return invalid("temporarily unavailable", 503);
      }
      // 每个会话约 5 秒导出一次，成功不逐次写日志；条数随 sync 的推送结果记录。
      return Response.json({});
    },
  });
  return {
    server,
    port: server.port ?? options.port,
    stop: () => server.stop(true),
  };
}
