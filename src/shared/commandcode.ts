import { createHash } from "node:crypto";

/**
 * Command Code 只读额度接口的共享请求与解析。服务端轮询与本机采集器共用同一份实现：
 * 地址固定、不可配置，凭据只随请求头发往这里；任何重定向都会被拒绝，避免 Bearer 凭据被转发。
 */
export const COMMAND_CODE_API_BASE = "https://api.commandcode.ai";
/** 四个接口共用的总超时。 */
export const COMMAND_CODE_TIMEOUT_MS = 15_000;

/** 账单周期内百分比允许保留小数；5 小时与每周窗口按上游给的已用量与上限换算。 */
export interface CommandCodeWindow {
  window: "five-hour" | "seven-day" | "monthly";
  percent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
}

/**
 * 结果只有固定字面量，不带任何上游原文、异常文本、登录名或组织标识，调用方可以直接记日志或落盘。
 * subjectKey 是组织（缺失时为登录名）的单向摘要，用来识别是否仍是同一个 Command Code 主体。
 */
export type CommandCodeQuotaResult =
  | {
      status: "ok";
      subjectKey: string;
      planId: string | null;
      windows: CommandCodeWindow[];
    }
  | { status: "rejected"; httpStatus: 401 | 403 }
  | {
      status: "error";
      kind: "timeout" | "redirect" | "http" | "network" | "invalid";
      httpStatus?: number;
    };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** JavaScript Date 能表示的最大毫秒数。 */
/**
 * 可信时间戳的上限（毫秒，约公元 2243 年）。远超这个值的读数不是真实的周期边界，
 * 而且会让下游按周期倍数回推的日期运算越界。
 */
const MAX_TIMESTAMP_MS = 8_640_000_000_000;

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

/** 年月日时分秒都必须是真实的日历值；Date.parse 会把 2 月 30 日自动进位成 3 月 2 日。 */
function isoTimestampMs(text: string): number | null {
  const match = ISO_DATETIME.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second ?? "0") > 59 ||
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59)
  )
    return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 解析上游时间戳：ISO 日期时间，或纯数字的 Unix 秒/毫秒（不小于 1e12 按毫秒）。
 * 先换算并取整到毫秒，再要求落在 (0, 8.64e12] 毫秒内，否则视为不可信，返回 null。
 */
export function commandCodeTimestampMs(value: unknown): number | null {
  let raw: number | null;
  if (typeof value === "number") raw = Number.isFinite(value) ? value : null;
  else if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) raw = Number(trimmed);
    else {
      const ms = isoTimestampMs(trimmed);
      return ms !== null && ms > 0 && ms <= MAX_TIMESTAMP_MS ? ms : null;
    }
  } else raw = null;
  if (raw === null) return null;
  const ms = Math.round(raw >= 1e12 ? raw : raw * 1000);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMESTAMP_MS
    ? ms
    : null;
}

function isoTimestamp(value: unknown): string | null {
  const ms = commandCodeTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * 组织（没有组织时为登录名）的单向摘要。只保存这个摘要，用来判断额度是否仍来自同一主体；
 * 明文组织 ID 与登录名不落盘、不上传。长度 71，满足账户 subjectKey 的 1..128 约束。
 */
export function commandCodeSubjectKey(
  orgId: string | null,
  login: string,
): string {
  const subject = orgId ? `org:${orgId}` : `login:${login}`;
  return `sha256:${createHash("sha256")
    .update(`commandcode-identity:v1:${subject}`)
    .digest("hex")}`;
}

export function isValidSha256SubjectKey(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

const PLAN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/;
/** 常见凭据形态：上游若把凭据回显在套餐字段里，宁可丢弃也不能落盘。 */
const CREDENTIAL_PATTERNS = [
  /bearer\s/i,
  /(?:^|[^a-z0-9])(?:cc_|user_|sk-|rk-|ghp_)/i,
  /eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/,
];

/** 本次观测里不能出现在套餐字段中的原文：当前 Key、登录名与组织 ID。 */
export interface CommandCodePlanSecrets {
  apiKey: string;
  login?: string | null;
  orgId?: string | null;
}

/**
 * 只接受形如套餐名的短标识。疑似凭据、当前 Key，以及本次观测的登录名或组织 ID 回显都丢弃为
 * null，这些原文不能借套餐字段落盘或上传。登录名/组织 ID 的判定不区分大小写：任意长度完全相等、
 * 任意长度作为按非字母数字切出的一段（例如登录名 li 时的 plan-li、li_team、org.li），或长度不短于
 * 3 的子串，都算回显；只有 1–2 个字符的身份恰好落在普通词内部（例如登录名 pr 遇 pro、a 遇 max）
 * 时保留套餐名。
 */
export function sanitizeCommandCodePlanId(
  value: unknown,
  secrets: CommandCodePlanSecrets,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!PLAN_ID_PATTERN.test(trimmed)) return null;
  const { apiKey } = secrets;
  if (apiKey && (trimmed === apiKey || trimmed.includes(apiKey))) return null;
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(trimmed))) return null;
  const lower = trimmed.toLowerCase();
  const segments = lower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const identity of [secrets.login, secrets.orgId]) {
    const text = identity?.trim().toLowerCase();
    if (!text) continue;
    if (
      lower === text ||
      segments.includes(text) ||
      (text.length >= 3 && lower.includes(text))
    )
      return null;
  }
  return trimmed;
}

/** 5 小时与每周窗口：已用量与上限都要是有限非负数，两者都为 0 表示没有这个窗口。 */
function limitWindow(
  value: unknown,
  window: "five-hour" | "seven-day",
  windowMinutes: number,
): CommandCodeWindow | null {
  if (!isRecord(value)) return null;
  const used = nonNegative(value.used);
  const cap = nonNegative(value.cap);
  if (used === undefined || cap === undefined || (used === 0 && cap === 0))
    return null;
  const percent =
    cap === 0 ? 100 : Math.min(Math.max((used / cap) * 100, 0), 100);
  return {
    window,
    percent,
    resetsAt: isoTimestamp(value.resetAt ?? value.resetsAt),
    windowMinutes,
  };
}

interface Subscription {
  planId: unknown;
  start: unknown;
  end: unknown;
}

function parseSubscription(body: unknown): Subscription | null {
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  if (!data) return null;
  return {
    planId: data.planId,
    start: data.currentPeriodStart,
    end: data.currentPeriodEnd,
  };
}

/** 账单周期剩余额度：月度、购买与赠送三类中已上报部分之和，全部缺失时未知。 */
function remainingCredits(body: unknown): number | undefined {
  const credits =
    isRecord(body) && isRecord(body.credits) ? body.credits : null;
  if (!credits) return undefined;
  const values = [
    nonNegative(credits.monthlyCredits),
    nonNegative(credits.purchasedCredits),
    nonNegative(credits.freeCredits),
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

/**
 * 账单周期窗口。百分比只用本期已花（usage/summary 按周期起点限定）与剩余额度换算；
 * 周期起止都可信且结束晚于开始时才写窗口长度，否则不推断周期。
 */
function monthlyWindow(
  remaining: number | undefined,
  spent: number | undefined,
  subscription: Subscription | null,
): CommandCodeWindow | null {
  const percent =
    spent !== undefined && remaining !== undefined && spent + remaining > 0
      ? Math.min(Math.max((spent / (spent + remaining)) * 100, 0), 100)
      : null;
  const startMs = subscription
    ? commandCodeTimestampMs(subscription.start)
    : null;
  const endMs = subscription ? commandCodeTimestampMs(subscription.end) : null;
  const resetsAt = endMs === null ? null : new Date(endMs).toISOString();
  if (percent === null && resetsAt === null) return null;
  return {
    window: "monthly",
    percent,
    resetsAt,
    windowMinutes:
      startMs !== null && endMs !== null && endMs > startMs
        ? Math.max(1, Math.round((endMs - startMs) / 60_000))
        : null,
  };
}

function withQuery(path: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value) search.set(key, value);
  const query = search.toString();
  return `${COMMAND_CODE_API_BASE}${path}${query ? `?${query}` : ""}`;
}

type Outcome =
  | { ok: true; body: unknown }
  | {
      ok: false;
      kind: "timeout" | "redirect" | "http" | "network" | "invalid";
      httpStatus?: number;
    };

export interface CommandCodeFetchOptions {
  apiKey: string;
  /** 仅供测试注入；地址固定为 COMMAND_CODE_API_BASE。 */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 依次读取 whoami、并行的 billing/credits 与 billing/subscriptions，再按周期起点读取 usage/summary。
 * whoami 任何失败都立即结束，避免在不知道组织时读到别的主体；任一接口 401/403 整体判为凭据被拒；
 * 其余失败只省略对应部分，未知不补零。
 */
export async function fetchCommandCodeQuota(
  options: CommandCodeFetchOptions,
): Promise<CommandCodeQuotaResult> {
  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? COMMAND_CODE_TIMEOUT_MS,
  );
  const request = async (url: string): Promise<Outcome> => {
    if (controller.signal.aborted) return { ok: false, kind: "timeout" };
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, kind: "timeout" };
      // 运行时对 redirect: "error" 抛出的是普通 TypeError，只能按错误文本区分；文本本身不外传。
      const message = error instanceof Error ? error.message : "";
      return {
        ok: false,
        kind: /redirect/i.test(message) ? "redirect" : "network",
      };
    }
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    )
      return { ok: false, kind: "redirect", httpStatus: response.status };
    if (!response.ok)
      return { ok: false, kind: "http", httpStatus: response.status };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      if (controller.signal.aborted) return { ok: false, kind: "timeout" };
      return { ok: false, kind: "invalid" };
    }
  };
  const rejected = (outcome: Outcome) =>
    !outcome.ok && (outcome.httpStatus === 401 || outcome.httpStatus === 403)
      ? ({
          status: "rejected",
          httpStatus: outcome.httpStatus,
        } as CommandCodeQuotaResult)
      : null;
  try {
    const whoami = await request(`${COMMAND_CODE_API_BASE}/alpha/whoami`);
    if (!whoami.ok)
      return (
        rejected(whoami) ?? {
          status: "error",
          kind: whoami.kind,
          ...(whoami.httpStatus !== undefined
            ? { httpStatus: whoami.httpStatus }
            : {}),
        }
      );
    const body = isRecord(whoami.body) ? whoami.body : null;
    const org = body && isRecord(body.org) ? body.org : null;
    const user = body && isRecord(body.user) ? body.user : null;
    const login =
      text(org?.login) ?? text(user?.userName) ?? text(user?.name) ?? null;
    if (!login) return { status: "error", kind: "invalid" };
    const orgId = text(org?.id) ?? null;

    // 两个账单接口并行；任一被拒（401/403）立即中止另一个仍在进行的请求并整体返回，
    // 不等对端结算（即使它不理会中止信号）或总超时。
    let blocked: CommandCodeQuotaResult | null = null;
    let resolveBlocked!: (result: CommandCodeQuotaResult) => void;
    const blockedPromise = new Promise<CommandCodeQuotaResult>((resolve) => {
      resolveBlocked = resolve;
    });
    const billing = async (url: string) => {
      const outcome = await request(url);
      const denial = rejected(outcome);
      if (denial && !blocked) {
        blocked = denial;
        controller.abort();
        resolveBlocked(denial);
      }
      return outcome;
    };
    const pairPromise = Promise.all([
      billing(
        withQuery("/alpha/billing/credits", { orgId: orgId ?? undefined }),
      ),
      billing(
        withQuery("/alpha/billing/subscriptions", {
          orgId: orgId ?? undefined,
        }),
      ),
    ]);
    // 被拒后不再等待这一对请求，它们之后的结算或异常都不能成为未处理的拒绝。
    pairPromise.catch(() => {});
    const settled = await Promise.race([
      pairPromise.then((pair) => ({ pair }) as const),
      blockedPromise.then((denial) => ({ denial }) as const),
    ]);
    if ("denial" in settled) return settled.denial;
    if (blocked) return blocked;
    const [credits, subscriptions] = settled.pair;
    const subscription = subscriptions.ok
      ? parseSubscription(subscriptions.body)
      : null;

    // 没有可信的周期起点时不读 summary：不带 since 的 totalCost 是全部历史，不能当作本期已花。
    let spent: number | undefined;
    if (
      subscription &&
      commandCodeTimestampMs(subscription.start) !== null &&
      (typeof subscription.start === "string" ||
        typeof subscription.start === "number")
    ) {
      const summary = await request(
        withQuery("/alpha/usage/summary", {
          orgId: orgId ?? undefined,
          since: String(subscription.start),
        }),
      );
      const blockedSummary = rejected(summary);
      if (blockedSummary) return blockedSummary;
      spent =
        summary.ok && isRecord(summary.body)
          ? nonNegative(summary.body.totalCost)
          : undefined;
    }

    const limits =
      credits.ok &&
      isRecord(credits.body) &&
      isRecord(credits.body.windowLimits)
        ? credits.body.windowLimits
        : null;
    const windows: CommandCodeWindow[] = [];
    const fiveHour = limitWindow(limits?.fiveHour, "five-hour", 300);
    if (fiveHour) windows.push(fiveHour);
    const weekly = limitWindow(limits?.weekly, "seven-day", 7 * 24 * 60);
    if (weekly) windows.push(weekly);
    const monthly = monthlyWindow(
      credits.ok ? remainingCredits(credits.body) : undefined,
      spent,
      subscription,
    );
    if (monthly) windows.push(monthly);
    const planId = sanitizeCommandCodePlanId(subscription?.planId, {
      apiKey: options.apiKey,
      login,
      orgId,
    });
    if (windows.length === 0 && planId === null)
      return {
        status: "error",
        kind: controller.signal.aborted ? "timeout" : "invalid",
      };
    return {
      status: "ok",
      subjectKey: commandCodeSubjectKey(orgId, login),
      planId,
      windows,
    };
  } catch {
    return {
      status: "error",
      kind: controller.signal.aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}
