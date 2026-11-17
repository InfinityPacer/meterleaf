import Decimal from "decimal.js";
import type { AccountWindow, LedgerAccount } from "./report";

/**
 * 采集器用写入密钥读取的订阅额度摘要，供本机会话判断该切换哪个账户。
 * 只含订阅账户的展示名、套餐和额度窗口，不含邮箱或用量明细；
 * 归档、隐藏与别名按网页同样的规则在服务端应用，本机不必复制这套展示状态。
 */
export const QUOTA_SUMMARY_PATH = "/api/collector/v1/quota-summary";
export const QUOTA_SUMMARY_SCHEMA_VERSION = 1;

const windowKeys = [
  "fiveHour",
  "sevenDay",
  "sevenDayFable",
  "fiveHourThirdParty",
  "sevenDayThirdParty",
  "monthly",
] as const;
export type QuotaSummaryWindowKey = (typeof windowKeys)[number];

export interface QuotaSummaryWindow {
  percent: number | null;
  resetsAt: string | null;
  sampledAt: string | null;
  state: "active" | "expired" | "unknown";
  /** 本周期剩余部分按当前花费速度折算的金额；5h、已到期或未计价的窗口为 null。 */
  remaining: { usd: string | null; credits: string | null };
}

export interface QuotaSummaryAccount {
  id: string;
  name: string;
  plan: string;
  platform: string | null;
  /** 合并到该账户的全部来源账户，格式同 id，本机用它找到自己登录的账户。 */
  members: string[];
  windows: Partial<Record<QuotaSummaryWindowKey, QuotaSummaryWindow>>;
}

export interface QuotaSummary {
  schemaVersion: typeof QUOTA_SUMMARY_SCHEMA_VERSION;
  asOf: string;
  accounts: QuotaSummaryAccount[];
}

export interface AccountDisplayState {
  archived: readonly string[];
  hidden: readonly string[];
  aliases: Readonly<Record<string, string>>;
}

function remaining(window: AccountWindow, unit: "usd" | "credits") {
  const estimate = window.estimate?.[unit] ?? null;
  const spent = unit === "usd" ? window.periodUsd : window.periodCredits;
  if (estimate === null || spent === null || spent === undefined) return null;
  return Decimal.max(new Decimal(estimate).sub(spent), 0).toString();
}

export function buildQuotaSummary(
  asOf: string,
  accounts: readonly LedgerAccount[],
  display: AccountDisplayState,
  members: Readonly<Record<string, readonly string[]>>,
): QuotaSummary {
  const excluded = new Set([...display.archived, ...display.hidden]);
  return {
    schemaVersion: QUOTA_SUMMARY_SCHEMA_VERSION,
    asOf,
    accounts: accounts
      .filter(
        (account) =>
          account.kind === "subscription" && !excluded.has(account.id),
      )
      .map((account) => {
        const windows: QuotaSummaryAccount["windows"] = {};
        for (const key of windowKeys) {
          const window = account[key];
          if (!window) continue;
          windows[key] = {
            percent: window.percent,
            resetsAt: window.resetsAt,
            sampledAt: window.sampledAt ?? null,
            state: window.state ?? "unknown",
            remaining: {
              usd: remaining(window, "usd"),
              credits: remaining(window, "credits"),
            },
          };
        }
        return {
          id: account.id,
          name: display.aliases[account.id] ?? account.name,
          plan: account.plan,
          platform: account.platform ?? null,
          members: [...(members[account.id] ?? [account.id])],
          windows,
        };
      }),
  };
}
