import type { DateRange } from "./date-range";

/** 请求审计详情只包含允许进入报表的来源字段；缺少证据保持 null。 */
export interface LedgerRecordDetails {
  /** 请求侧模型；旧事实缺少明确请求值时可能是 fact.model 的兼容回退。 */
  requestedModel: string | null;
  /** 实际发送给上游的模型；缺少独立上游字段时回退到 fact.model。 */
  sentModel: string | null;
  /** 上游返回的响应模型，不覆盖计价模型。 */
  responseModel: string | null;
  /** 响应模型是否与发送模型不匹配；未知时为 null。 */
  responseModelMismatch: boolean | null;
  /** 请求侧原始推理强度，尚未经过策略映射。 */
  requestedReasoningEffort: string | null;
  /** 策略映射后实际生效的推理强度。 */
  reasoningEffort: string | null;
  /** 从请求开始到完成响应的耗时。 */
  durationMs: number | null;
  /** 从请求开始到收到首个 token 的耗时。 */
  firstTokenMs: number | null;
}

/** 报表契约不包含网关字段；金额以十进制字符串跨越 API 边界。 */
export interface LedgerRecord {
  id: string;
  occurredAt: string;
  accountId: string;
  model: string;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  usd: string | null;
  credits: string | null;
  tier: "standard" | "priority" | "flex" | "unknown";
  quality: "estimated" | "unpriced";
  priceVersion: string;
  sourceId?: string;
  sourceRecordId?: string;
  gatewayCost?: string | null;
  gatewayBilled?: string | null;
  valuation?: import("../domain/pricing").Valuation;
  details?: LedgerRecordDetails;
}

/** 额度与请求是独立能力，未提供窗口不代表额度为零。 */
export interface AccountWindow {
  percent: number | null;
  resetsAt: string | null;
  sampledAt?: string | null;
  state?: "active" | "expired" | "unknown";
  stale?: boolean;
  periodUsd?: string | null;
  periodCredits?: string | null;
  /** 当前额度周期的用量，与页面时间筛选和全历史累计相互独立。 */
  periodRequests?: number | null;
  periodTokens?: number | null;
  estimate?: import("../domain/quota").QuotaView["estimate"];
}

export interface LedgerAccount {
  id: string;
  name: string;
  plan: string;
  /** 上游平台，例如 anthropic、openai；同名套餐在不同平台代表不同档位。 */
  platform?: string;
  kind: "subscription" | "api" | "unknown";
  sampledAt: string | null;
  fiveHour: AccountWindow | null;
  sevenDay: AccountWindow | null;
  /** 全历史账户用量，不受报表筛选影响；缺失表示该来源尚未提供累计汇总。 */
  lifetime?: AccountLifetime;
}

/** 美元金额沿用当前估算口径；未知金额保留 null，部分已计价金额显式标记。 */
export interface AccountLifetime {
  count: number;
  tokens: number | null;
  usd: string | null;
  incompleteTokens: number;
  incompleteUsd: number;
}

/** 演示与实时模式显式区分，不允许网络错误时回退至演示账本。 */
export interface LedgerSnapshot {
  mode: "demo" | "live";
  asOf: string;
  accounts: LedgerAccount[];
  records: LedgerRecord[];
  resets: { accountId: string; at: string }[];
  sync?: {
    lastAttempt?: string | null;
    running?: boolean;
    lastSuccess: string | null;
    error: string | null;
    initialComplete: boolean;
    lastSweep: string | null;
  };
  pricing?: { version: string; publishedAt: string; sources: string[] };
  /** 默认展示口径；切换不会修改源事实或已保存的另一套估值。 */
  usdBasis?: UsdBasis;
}

export type { UsdBasis } from "../domain/pricing";
import type { UsdBasis } from "../domain/pricing";
export type ReportUnit = "usd" | "credits" | "tokens";
export type Granularity = "hour" | "day" | "week";

export interface ReportFilter {
  days: number;
  dateRange?: DateRange;
  model: string;
  account: string;
  search: string;
}
