import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { QuotaFact, SourceAccount, UsageFact } from "../domain/connector";
import {
  INGEST_BATCHES_PATH,
  INGEST_BODY_LIMIT_BYTES,
  INGEST_KEY_PREFIX,
  ingestBatchSchema,
  type IngestBatch,
  type IngestResult,
} from "../shared/ingest";
import type { IngestKey } from "./config";
import type { DiagnosticsLogger } from "./diagnostics";

export interface IngestTarget {
  keys: readonly IngestKey[];
  save(
    sourceId: string,
    batch: {
      batchId: string;
      collector: { name: string; version: string };
      accounts: SourceAccount[];
      usage: UsageFact[];
      quotas: QuotaFact[];
    },
  ): void;
}

/** 推送来源没有网关扣费或上游金额，这些字段固定为未知，由本地价格表独立估值。 */
export function ingestToDomain(sourceId: string, batch: IngestBatch) {
  return {
    batchId: batch.batchId,
    collector: batch.collector,
    accounts: batch.accounts.map((account): SourceAccount => ({
      sourceId,
      ...account,
      parentExternalId: null,
    })),
    usage: batch.usage.map((usage): UsageFact => ({
      sourceId,
      ...usage,
      upstreamModel: null,
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
    })),
    quotas: batch.quotas.map((quota): QuotaFact => ({
      sourceId,
      externalId: `${quota.accountExternalId}:${quota.window}`,
      ...quota,
    })),
  };
}

/** 只比较摘要；密钥明文不落盘、不进日志。 */
function matchKey(
  header: string | undefined,
  keys: readonly IngestKey[],
): IngestKey | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith(INGEST_KEY_PREFIX)) return null;
  const digest = createHash("sha256").update(token).digest();
  return (
    keys.find((key) =>
      timingSafeEqual(digest, Buffer.from(key.sha256, "hex")),
    ) ?? null
  );
}

/**
 * 写入接口只接受推送批次，不提供任何读取能力；密钥决定来源，正文中的 sourceId 只用于核对。
 * 未配置密钥时不注册路由。
 */
export function registerIngestRoutes(
  app: FastifyInstance,
  target: IngestTarget,
  diagnostics: DiagnosticsLogger,
) {
  if (!target.keys.length) return;
  app.post(
    INGEST_BATCHES_PATH,
    { bodyLimit: INGEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const key = matchKey(request.headers.authorization, target.keys);
      if (!key) return reply.code(401).send({ error: "invalid ingest key" });
      const parsed = ingestBatchSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "invalid ingest batch",
          fields: [
            ...new Set(
              parsed.error.issues.map((issue) => issue.path.join(".")),
            ),
          ].slice(0, 20),
        });
      const batch = parsed.data;
      if (batch.sourceId !== key.sourceId)
        return reply
          .code(403)
          .send({ error: "ingest key is not bound to this source" });
      target.save(key.sourceId, ingestToDomain(key.sourceId, batch));
      diagnostics.info("ingest.accepted", {
        sourceId: key.sourceId,
        batchId: batch.batchId,
        usage: batch.usage.length,
        accounts: batch.accounts.length,
        quotas: batch.quotas.length,
      });
      const result: IngestResult = {
        batchId: batch.batchId,
        accepted: {
          usage: batch.usage.length,
          accounts: batch.accounts.length,
          quotas: batch.quotas.length,
        },
      };
      return result;
    },
  );
}
