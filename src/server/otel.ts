import { gunzipSync } from "node:zlib";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  OTEL_BODY_LIMIT_BYTES,
  OTEL_LOGS_PATH,
  parseOtelRequestAccounts,
} from "../shared/otel";
import { matchIngestKey, type IngestTarget } from "./ingest";
import type { DiagnosticsLogger } from "./diagnostics";

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
