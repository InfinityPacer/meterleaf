/** 服务器观察到的套餐边界；首次观察不证明该套餐在此前已经生效。 */
export interface QuotaPlanObservation {
  plan: string | null;
  observedAt: string;
  /** 两个不同的已知套餐之间的变化，改名、细化与未知都不算，见 planRelation。 */
  changed: boolean;
}

/** 来源和账户键允许包含分隔符，数组序列化保留完整身份。 */
export function quotaPlanHistoryKey(
  sourceId: string,
  accountExternalId: string,
) {
  return `quota:planHistory:${JSON.stringify([sourceId, accountExternalId])}`;
}

/**
 * 旧版采集器上报的组织类型与新标识的对应关系。旧版 Team Premium 席位按速率档位记为 max-5x，
 * 与 team-premium 是同一套餐的不同写法。
 */
const planAliases: Record<string, string> = {
  claude_pro: "pro",
  claude_max: "max",
  claude_team: "team",
  claude_enterprise: "enterprise",
};
/** 只知道订阅类型时的标识，以及它可以细化成的具体套餐。 */
const planFamilies: Record<string, readonly string[]> = {
  max: ["max-5x", "max-20x"],
  team: ["team-standard", "team-premium"],
};

function canonicalPlan(plan: string) {
  return planAliases[plan] ?? plan;
}

/**
 * 两次套餐观测的关系：same 是同一套餐的同一或等价写法；refine 表示新值更具体，例如 max
 * 变为 max-20x；coarser 表示新值更笼统；change 才是上游套餐真的变了。任一方未知时为 unknown。
 * 改名和细化不能当作套餐变化，否则额度预估会丢弃本周期已有读数。
 */
export function planRelation(
  previous: string | null,
  next: string | null,
): "same" | "refine" | "coarser" | "change" | "unknown" {
  if (previous === null || next === null) return "unknown";
  const before = canonicalPlan(previous);
  const after = canonicalPlan(next);
  if (previous === next) return "same";
  // 旧写法换成新写法算细化；反过来保留已有的新写法。
  if (before === after) return planAliases[previous] ? "refine" : "same";
  if (
    (before === "max-5x" && after === "team-premium") ||
    (before === "team-premium" && after === "max-5x")
  )
    return after === "team-premium" ? "refine" : "coarser";
  if (planFamilies[before]?.includes(after)) return "refine";
  if (planFamilies[after]?.includes(before)) return "coarser";
  return "change";
}
