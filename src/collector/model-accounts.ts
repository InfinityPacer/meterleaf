import { createHash } from "node:crypto";
import { z } from "zod";
import type { IngestAccount } from "../shared/ingest";

/**
 * 把模型名映射到独立账户。Claude Code 也能通过兼容接口调用其他供应商的模型（例如经
 * OpenCode Go 调用 DeepSeek），会话记录与 Claude 订阅写在同一目录，却不带账户或请求地址，
 * 模型名是唯一能区分供应商的依据。
 */
export const modelAccountRuleSchema = z
  .object({
    /** 模型名匹配式，`*` 匹配任意字符，其余按字面比较，区分大小写。 */
    match: z.string().min(1).max(128),
    /** 账户在本来源内的稳定标识；改名不影响归属，改标识会把历史用量移到新账户。 */
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().min(1).max(200),
    platform: z.string().min(1).max(64),
    kind: z.enum(["subscription", "api", "unknown"]).default("unknown"),
    plan: z.string().min(1).max(64).nullable().default(null),
  })
  .strict();

export type ModelAccountRule = z.infer<typeof modelAccountRuleSchema>;

/** 不以 claude- 开头且没有映射的模型，与 Claude 订阅账户分开，避免虚增其用量。 */
export const OTHER_MODELS_ACCOUNT: IngestAccount = {
  externalId: "other-models",
  name: "其他模型",
  platform: "unknown",
  kind: "unknown",
  plan: null,
  subjectKey: null,
};

function matches(pattern: string, model: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(model);
}

function accountFromRule(rule: ModelAccountRule): IngestAccount {
  return {
    externalId: rule.id,
    name: rule.name,
    platform: rule.platform,
    kind: rule.kind,
    plan: rule.plan,
    subjectKey: null,
  };
}

/**
 * 返回模型固定归属的账户；返回 null 表示 Claude 模型，按登录时间线归属。
 * 映射按顺序取第一条命中的规则，因此也能把某个 claude- 模型单独分出去。
 */
export function routeModel(
  model: string,
  rules: readonly ModelAccountRule[],
): IngestAccount | null {
  const rule = rules.find((candidate) => matches(candidate.match, model));
  if (rule) return accountFromRule(rule);
  return model.startsWith("claude-") ? null : OTHER_MODELS_ACCOUNT;
}

/** 映射内容的摘要；映射变化时采集器按新映射重新归属全部事件。 */
export function modelAccountsDigest(rules: readonly ModelAccountRule[]) {
  return createHash("sha256")
    .update(JSON.stringify(rules))
    .digest("hex")
    .slice(0, 16);
}
