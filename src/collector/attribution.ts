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
 * 登录发生时刻的线索。transcript 来自会话记录里 /login 成功的那一行，是登录完成的时刻；
 * credential 来自凭据的修改时间，令牌刷新也会改写，只在没有会话记录线索时使用。
 */
export interface LoginHint {
  at: string;
  source: "transcript" | "credential";
}

/**
 * 两段不同账户区间之间的切换时刻：取空档内最后一次登录，会话记录优先于凭据修改时间。
 * 没有线索时返回 null，整段空档归后一个账户：通常是前一个账户额度用完才切换，
 * 空档里能成功的请求多半来自新账户。
 */
function switchMoment(
  previous: AccountSegment,
  next: AccountSegment,
  hints: readonly LoginHint[],
): string | null {
  const inGap = hints.filter(
    (hint) => hint.at > previous.lastSeen && hint.at <= next.firstSeen,
  );
  const latest = (source: LoginHint["source"]) =>
    inGap
      .filter((hint) => hint.source === source)
      .map((hint) => hint.at)
      .sort()
      .at(-1) ?? null;
  return latest("transcript") ?? latest("credential");
}

/**
 * JSONL 行不带账户，只能用观察时间线推断：区间内归该账户；两段同账户区间之间的空档
 * 视为未切换；首段之前（未绑定）和最后一次观察之后无法判断，归入未归属。
 *
 * 不同账户之间的空档：传入 hints 时按切换时刻分给前后两个账户，用于用量；
 * 不传时保持无法判断，用于额度采样，避免把切换前账户的额度读数挂到新账户上。
 */
export function attribute(
  occurredAt: string,
  segments: readonly AccountSegment[],
  binding: HistoryBinding | null,
  hints: readonly LoginHint[] | null = null,
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
      if (next.accountUuid === segment.accountUuid) return segment.accountUuid;
      if (!hints) return UNATTRIBUTED_ACCOUNT_ID;
      const switchedAt = switchMoment(segment, next, hints);
      return switchedAt !== null && occurredAt < switchedAt
        ? segment.accountUuid
        : next.accountUuid;
    }
  }
  return UNATTRIBUTED_ACCOUNT_ID;
}
