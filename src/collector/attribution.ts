import { UNATTRIBUTED_ACCOUNT_ID } from "./claude-code/account";

/** 采集器在运行时观察到的登录账户区间；时间为 ISO UTC 字符串，可按字典序比较。 */
export interface AccountSegment {
  accountUuid: string;
  firstSeen: string;
  lastSeen: string;
}

/** 用户明确声明：首个观察区间之前的历史事件属于该账户。 */
export interface HistoryBinding {
  accountUuid: string;
  before: string;
}

/**
 * JSONL 行不带账户，只能用观察时间线推断：区间内归该账户；两段同账户区间之间的空档
 * 视为未切换；不同账户之间、首段之前（未绑定）和最后一次观察之后都无法判断，归入未归属。
 */
export function attribute(
  occurredAt: string,
  segments: readonly AccountSegment[],
  binding: HistoryBinding | null,
): string {
  const first = segments[0];
  if (!first || occurredAt < first.firstSeen) {
    return binding && occurredAt < binding.before
      ? binding.accountUuid
      : UNATTRIBUTED_ACCOUNT_ID;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (occurredAt < segment.firstSeen) break;
    if (occurredAt <= segment.lastSeen) return segment.accountUuid;
    const next = segments[index + 1];
    if (next && occurredAt < next.firstSeen) {
      return next.accountUuid === segment.accountUuid
        ? segment.accountUuid
        : UNATTRIBUTED_ACCOUNT_ID;
    }
  }
  return UNATTRIBUTED_ACCOUNT_ID;
}
