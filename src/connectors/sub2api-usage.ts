import type { ImageTokenUsage, TokenUsage } from "../domain/connector";

export type Sub2ApiUsageMetadata = Record<string, unknown>;

const imageInputKey = "image_input_tokens";
const imageOutputKey = "image_output_tokens";

function metadataObject(value: unknown): Sub2ApiUsageMetadata | null {
  return value !== null && typeof value === "object"
    ? (value as Sub2ApiUsageMetadata)
    : null;
}

function hasMetadataField(
  metadata: Sub2ApiUsageMetadata | null,
  field: string,
): boolean {
  return metadata !== null && Object.hasOwn(metadata, field);
}

function tokenCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** 将历史 Sub2API metadata 解释为规范图像计量，不从普通 input 桶反推图像输入。 */
export function normalizeSub2ApiImageUsage(
  metadataValue: unknown,
): ImageTokenUsage | undefined {
  const metadata = metadataObject(metadataValue);
  const hasInput = hasMetadataField(metadata, imageInputKey);
  const hasOutput = hasMetadataField(metadata, imageOutputKey);
  if (!hasInput && !hasOutput) {
    return undefined;
  }

  const input = tokenCount(metadata?.[imageInputKey]);
  const output = tokenCount(metadata?.[imageOutputKey]);
  return {
    input,
    output,
    // Sub2API 不拆图像缓存，缓存统一计价；不将其计费口径伪装成观测到的零缓存。
    cacheRead: null,
    cacheReadMode: "aggregate",
  };
}

type UsageWithMetadata = {
  tokens: TokenUsage;
  metadata?: unknown;
};

/** 为未迁移的 Sub2API 历史事实生成计价副本；原事实与 metadata 均保持只读。 */
export function withSub2ApiImageUsage<T extends UsageWithMetadata>(fact: T): T {
  const existing = fact.tokens.image;
  if (
    existing !== undefined &&
    (existing.cacheReadMode !== undefined || existing.cacheRead !== null)
  ) {
    return fact;
  }

  const metadata = metadataObject(fact.metadata);
  const image = normalizeSub2ApiImageUsage(metadata);
  if (image === undefined) {
    return fact;
  }
  return {
    ...fact,
    tokens: {
      ...fact.tokens,
      // 已存图像计量缺少缓存口径时，只补来源规则，不覆盖原计量。
      image: existing ? { ...existing, cacheReadMode: "aggregate" } : image,
    },
  } as T;
}
