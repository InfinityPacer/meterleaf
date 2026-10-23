import { createHash } from "node:crypto";

/**
 * 同一上游主体的稳定摘要，用于跨来源识别同一账户；只含 UUID，不含邮箱或名称。
 * 组织 UUID 缺失时无法构成完整主体，保留未知。采集器与服务端使用同一公式，
 * 否则服务端为 OTEL 覆盖补建的账户无法与之后采集器推来的资料合并。
 */
export function subjectKeyFrom(
  accountUuid: string,
  organizationUuid: string | null,
): string | null {
  if (!organizationUuid) return null;
  const digest = createHash("sha256")
    .update(
      `anthropic_account_uuid=${accountUuid}\nanthropic_organization_uuid=${organizationUuid}`,
    )
    .digest("hex");
  return `sha256:${digest}`;
}
