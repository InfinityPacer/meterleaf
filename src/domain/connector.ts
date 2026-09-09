/** 全局标识由 sourceId 与外部稳定键组成，不把网关行 ID 当作跨来源身份。 */
export interface SourceRef {
  sourceId: string;
  externalId: string;
}

/** 图像计量是现有总桶的子集，不能作为累计桶再次相加。 */
export interface ImageTokenUsage {
  /** 图像输入总量，已包含图像缓存输入。 */
  input: number | null;
  /** 图像输出，属于普通 output 桶的子集。 */
  output: number | null;
  /** 可确认的图像缓存输入；无法从来源拆分时保留 null。 */
  cacheRead: number | null;
  /** 缺省按明确模态细分计价；aggregate 沿用来源缓存统一计价、图像从非缓存输入拆出的口径。 */
  cacheReadMode?: "split" | "aggregate";
}

/** 四桶互斥；reasoning 为输出子集，TTL 写入为 cacheWrite 子集，均不重复相加。 */
export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  reasoning: number | null;
  image?: ImageTokenUsage;
}

/** 源计量事实不可混入本地估值；元数据只能包含明确允许的计量字段。 */
export interface UsageFact extends SourceRef {
  occurredAt: string;
  accountExternalId: string;
  model: string;
  upstreamModel: string | null;
  tier: string | null;
  tokens: TokenUsage;
  gatewayCost: string | null;
  gatewayBilled: string | null;
  upstreamUsd: string | null;
  /** 只有来源能证明币种估值口径时，才可优先使用上游 USD 数值。 */
  upstreamUsdBasis?: "subscription" | "api" | null;
  upstreamCredits: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

/** 上游订阅主体可缺失；shadow 的 parent 归属由适配器提供，不从名字猜测。 */
export interface SourceAccount extends SourceRef {
  name: string;
  platform: string;
  /** 来源侧接入类型，不证明真正上游采用订阅或按量付费，不能据此选择费率。 */
  kind: "subscription" | "api" | "unknown";
  plan: string | null;
  parentExternalId: string | null;
  subjectKey: string | null;
}

/** 快照时间与本地采集时间分离。无 resetAt 时仍可展示百分比，但不得推断周期。 */
export interface QuotaFact extends SourceRef {
  accountExternalId: string;
  window: "five-hour" | "seven-day";
  percent: number | null;
  sampledAt: string | null;
  resetsAt: string | null;
  windowMinutes: number | null;
}

/** 游标对核心是不透明字符串；单页与游标在本地事务中一并提交。 */
export interface UsagePage {
  records: UsageFact[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** 客户端连接器可以只有 usage 能力，不能因为缺少额度而无法接入。 */
export interface UsageConnector {
  sourceId: string;
  readUsage(cursor: string | null, limit: number): Promise<UsagePage>;
  /** 成功结果是该 sourceId 的完整账户快照；空数组表示来源当前没有账户，拒绝不构成快照。 */
  readAccounts(): Promise<SourceAccount[]>;
  readQuotas?: () => Promise<QuotaFact[]>;
  close(): Promise<void>;
}
