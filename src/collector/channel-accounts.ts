import { z } from "zod";
import {
  modelAccountRuleSchema,
  type ModelAccountRule,
} from "./model-accounts";

/**
 * 按「来源加通道」决定账户。Codex、OpenCode 与 omp 的本地记录自带供应商字段，账户在读取时
 * 就能确定；每个来源由此返回一个读取器共用的规则。账户字段与模型映射相同，复用其定义。
 */
export const channelAccountRuleSchema = z
  .object({
    source: z.enum(["codex", "opencode", "omp"]),
    /** 通道值：Codex 会话的 model_provider，OpenCode 消息的 model.providerID，或 omp 助手消息的 provider。 */
    channel: z.string().min(1).max(128),
    ...modelAccountRuleSchema.omit({ match: true }).shape,
  })
  .strict();

export type ChannelAccountRule = z.infer<typeof channelAccountRuleSchema>;

/** 规则命中的账户资料，随用量与额度一起上报。 */
export interface ChannelAccount {
  id: string;
  name: string;
  platform: string;
  kind: "subscription" | "api" | "unknown";
  plan: string | null;
}

/**
 * 未配置渠道规则时的内置路由。用户配置了 channelAccounts 后这份规则完全被替代，
 * 不与自定义规则合并；后续接入别的供应商只改配置，不改代码。
 */
export const DEFAULT_CHANNEL_ACCOUNTS: readonly ChannelAccountRule[] = [
  {
    source: "codex",
    channel: "openai",
    id: "codex",
    name: "Codex",
    platform: "openai",
    kind: "subscription",
    plan: null,
  },
  {
    source: "codex",
    channel: "go",
    id: "opencode-go",
    name: "OpenCode Go",
    platform: "opencode-go",
    kind: "subscription",
    plan: "go",
  },
  {
    source: "opencode",
    channel: "opencode-go",
    id: "opencode-go",
    name: "OpenCode Go",
    platform: "opencode-go",
    kind: "subscription",
    plan: "go",
  },
  {
    source: "omp",
    channel: "opencode-go",
    id: "opencode-go",
    name: "OpenCode Go",
    platform: "opencode-go",
    kind: "subscription",
    plan: "go",
  },
];

/**
 * 生效的渠道规则。配置了 channelAccounts 时原样使用；否则用内置默认，但默认规则的账户
 * 若在模型映射里也有同一 id，就沿用模型映射的资料，避免两个写入方让服务端账户资料来回变化，
 * 也不让升级前自定义过账户名称的配置因此无法加载。
 */
export function effectiveChannelAccounts(
  config: {
    channelAccounts?: readonly ChannelAccountRule[];
    modelAccounts?: readonly ModelAccountRule[];
  } | null,
): readonly ChannelAccountRule[] {
  if (config?.channelAccounts) return config.channelAccounts;
  return DEFAULT_CHANNEL_ACCOUNTS.map((rule) => {
    const model = config?.modelAccounts?.find(
      (candidate) => candidate.id === rule.id,
    );
    return model
      ? {
          ...rule,
          name: model.name,
          platform: model.platform,
          kind: model.kind,
          plan: model.plan,
        }
      : rule;
  });
}

/** 返回此来源与通道固定归属的账户；返回 null 表示该通道没有路由规则，读取时跳过。 */
export function routeChannel(
  source: ChannelAccountRule["source"],
  channel: string | null,
  rules: readonly ChannelAccountRule[],
): ChannelAccount | null {
  const rule = rules.find(
    (candidate) => candidate.source === source && candidate.channel === channel,
  );
  return rule
    ? {
        id: rule.id,
        name: rule.name,
        platform: rule.platform,
        kind: rule.kind,
        plan: rule.plan,
      }
    : null;
}

/** 一条配置规则的账户资料与它登记的位置，供冲突提示指认。 */
export interface AccountProfileEntry {
  id: string;
  name: string;
  platform: string;
  kind: string;
  plan: string | null;
  /** 规则来源位置，例如 `codex:openai` 或 `模型 deepseek-*`。 */
  label: string;
}

/**
 * 配置校验：两个列表中同一账户 id 的资料必须一致，不一致直接报配置错误。
 * 否则两条路由会让服务端的账户资料来回变化。
 */
export function accountProfileConflict(
  entries: readonly AccountProfileEntry[],
): string | null {
  const profiles = new Map<string, { profile: string; label: string }>();
  for (const entry of entries) {
    const ahead = profiles.get(entry.id);
    if (ahead) {
      const profile = JSON.stringify({
        name: entry.name,
        platform: entry.platform,
        kind: entry.kind,
        plan: entry.plan,
      });
      if (ahead.profile !== profile)
        return `账户 ${entry.id} 在 ${ahead.label} 与 ${entry.label} 两条规则中的资料不一致`;
    } else {
      profiles.set(entry.id, {
        profile: JSON.stringify({
          name: entry.name,
          platform: entry.platform,
          kind: entry.kind,
          plan: entry.plan,
        }),
        label: entry.label,
      });
    }
  }
  return null;
}
