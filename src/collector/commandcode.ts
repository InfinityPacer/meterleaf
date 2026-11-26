import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  fetchCommandCodeQuota,
  type CommandCodeQuotaResult,
} from "../shared/commandcode";
import { ingestQuotaSchema, type IngestQuota } from "../shared/ingest";
import {
  effectiveChannelAccounts,
  type ChannelAccountRule,
} from "./channel-accounts";
import type { CollectorConfig } from "./config";
import type { ModelAccountRule } from "./model-accounts";
import {
  COMMAND_CODE_PLANS_META,
  commandCodeIdentityMetaKey,
  type CollectorState,
} from "./state";

/**
 * 两次读取之间的最短间隔。读取在请求前记下时间，失败也计入；sync 每分钟运行，
 * 调度延迟或上游故障时两次成功采样仍可能相隔超过 5 分钟，页面会把额度标为过时。
 */
export const COMMAND_CODE_MIN_INTERVAL_MS = 4 * 60_000;
/** Key 被拒（401/403）后的冷却；绑定凭据摘要，换了新凭据时立即解除冷却重试。 */
export const COMMAND_CODE_REJECTED_COOLDOWN_MS = 30 * 60_000;

const REFRESH_AT_META = "commandcode_quota_refresh_at";
const REJECTED_AT_META = "commandcode_rejected_at";
/** 最近一次额度读取的状态，只含固定枚举，供 status 显示。 */
export const COMMAND_CODE_STATUS_META = "commandcode_status";

export interface CommandCodeCredential {
  apiKey: string;
  /** 登录过期时刻（毫秒）；凭据文件未提供时缺省。 */
  expires?: number;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 从凭据存储的一个字段取出 Key，规则与 pi 的 commandcode 提供方一致：字符串即 Key；
 * 对象按 oauth 的 access、api 的 key、再任意 access 或 key 的顺序取第一个非空字符串。
 */
export function credentialFromValue(
  value: unknown,
): CommandCodeCredential | undefined {
  if (typeof value === "string")
    return value.length > 0 ? { apiKey: value } : undefined;
  if (!isRecord(value)) return undefined;
  const apiKey =
    (str(value.type) === "oauth" ? str(value.access) : undefined) ??
    (str(value.type) === "api" ? str(value.key) : undefined) ??
    str(value.access) ??
    str(value.key);
  if (!apiKey) return undefined;
  return typeof value.expires === "number" && Number.isFinite(value.expires)
    ? { apiKey, expires: value.expires }
    : { apiKey };
}

/** 逐字段回退：前一个字段为空串或无效对象时继续看下一个。 */
export function credentialFromStore(
  parsed: unknown,
): CommandCodeCredential | undefined {
  if (!isRecord(parsed)) return undefined;
  return (
    credentialFromValue(parsed.apiKey) ??
    credentialFromValue(parsed.commandcode) ??
    credentialFromValue(parsed["command-code"])
  );
}

function readStore(path: string): CommandCodeCredential | undefined {
  try {
    return credentialFromStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export type CredentialLookup =
  { status: "none" } | { status: "expired" } | { status: "ok"; apiKey: string };

/**
 * 选出唯一的凭据存储：配置了 authFile 时只读它；否则按环境变量 COMMAND_CODE_API_KEY、
 * COMMANDCODE_API_KEY，再 ~/.commandcode、~/.pi/agent、~/.omp/agent 下的 auth.json 取第一个有凭据的。
 * 选中后过期或被拒都不换下一个存储，避免悄悄换成另一个人的凭据。只读，不改写任何文件。
 */
export function findCommandCodeCredential(options: {
  authFile?: string;
  env: Record<string, string | undefined>;
  home: string;
  now: number;
}): CredentialLookup {
  let credential: CommandCodeCredential | undefined;
  if (options.authFile) credential = readStore(options.authFile);
  else {
    for (const name of ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"]) {
      const value = options.env[name];
      if (value) {
        credential = { apiKey: value };
        break;
      }
    }
    if (!credential)
      for (const path of [
        join(options.home, ".commandcode", "auth.json"),
        join(options.home, ".pi", "agent", "auth.json"),
        join(options.home, ".omp", "agent", "auth.json"),
      ]) {
        credential = readStore(path);
        if (credential) break;
      }
  }
  if (!credential) return { status: "none" };
  if (credential.expires !== undefined && credential.expires <= options.now)
    return { status: "expired" };
  return { status: "ok", apiKey: credential.apiKey };
}

export type CommandCodeTarget =
  | {
      status: "ok";
      rule: Pick<ChannelAccountRule, "id" | "name" | "kind" | "plan">;
    }
  | {
      status: "skip";
      reason: "account-missing" | "account-platform" | "ambiguous" | "none";
    };

/**
 * 额度挂到哪个账户：在生效的渠道规则与模型映射中找 commandcode 平台的账户。显式 accountId 必须
 * 存在且是 commandcode 平台；未指定时恰好一个候选才绑定，多个或没有都跳过，不盲选也不新建。
 */
export function commandCodeTarget(
  config: Pick<
    CollectorConfig,
    "channelAccounts" | "modelAccounts" | "commandcode"
  > | null,
): CommandCodeTarget {
  const rules: (ChannelAccountRule | ModelAccountRule)[] = [
    ...effectiveChannelAccounts(config),
    ...(config?.modelAccounts ?? []),
  ];
  const explicit = config?.commandcode?.accountId;
  if (explicit) {
    const matches = rules.filter((rule) => rule.id === explicit);
    if (matches.length === 0)
      return { status: "skip", reason: "account-missing" };
    const rule = matches.find(
      (candidate) => candidate.platform === "commandcode",
    );
    if (
      !rule ||
      matches.some((candidate) => candidate.platform !== "commandcode")
    )
      return { status: "skip", reason: "account-platform" };
    return { status: "ok", rule };
  }
  const candidates = new Map<string, ChannelAccountRule | ModelAccountRule>();
  for (const rule of rules)
    if (rule.platform === "commandcode" && !candidates.has(rule.id))
      candidates.set(rule.id, rule);
  if (candidates.size === 0) return { status: "skip", reason: "none" };
  if (candidates.size > 1) return { status: "skip", reason: "ambiguous" };
  return { status: "ok", rule: [...candidates.values()][0]! };
}

export type CommandCodeRefreshStatus =
  | "disabled"
  | "account-missing"
  | "account-platform"
  | "ambiguous"
  | "none"
  | "no-credential"
  | "expired"
  | "cooldown"
  | "rejected"
  | "identity-changed"
  | "timeout"
  | "redirect"
  | "http"
  | "network"
  | "invalid"
  | "storage-error"
  | "ok";

export interface CommandCodeRefreshReport {
  /** 本轮是否发出了供应商请求。 */
  attempted: boolean;
  status: CommandCodeRefreshStatus;
  /** 本轮新入队的额度条数。 */
  quotas: number;
}

/** status 命令显示的中文说明；只依据固定枚举。 */
export function commandCodeStatusText(status: string | null): string | null {
  switch (status) {
    case null:
    case "":
      return null;
    case "ok":
      return "最近一次读取成功";
    case "disabled":
      return "已停用";
    case "account-missing":
      return "配置的 commandcode.accountId 不在账户规则中，未读取额度";
    case "account-platform":
      return "配置的 commandcode.accountId 不是 commandcode 平台，未读取额度";
    case "ambiguous":
      return "有多个 commandcode 平台账户，请用 commandcode.accountId 指定一个";
    case "none":
      return "账户规则中没有 commandcode 平台账户，未读取额度";
    case "no-credential":
      return "未找到本地凭据";
    case "expired":
      return "本地凭据已过期，请重新登录";
    case "rejected":
      return "凭据被拒绝（401/403），冷却后再试";
    case "identity-changed":
      return "凭据对应的组织与已绑定的不同，已拒绝写入；如确需切换请改用新的账户 id";
    case "timeout":
      return "读取超时";
    case "redirect":
      return "接口返回重定向，已拒绝";
    case "http":
      return "接口返回错误";
    case "network":
      return "网络错误";
    case "invalid":
      return "接口没有返回可识别的额度";
    case "storage-error":
      return "本地状态写入失败";
    default:
      return null;
  }
}

export interface CommandCodeRefreshOptions {
  fetch?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
  home?: string;
}

function setStatus(state: CollectorState, status: CommandCodeRefreshStatus) {
  if (state.getMeta(COMMAND_CODE_STATUS_META) !== status)
    state.setMeta(COMMAND_CODE_STATUS_META, status);
}

/**
 * 读取过程意外抛错（例如本地状态库写入失败）时记下固定状态，替换掉上一次的「成功」，
 * 让 status 如实显示；状态本身也写不进去时放弃，不影响本轮用量推送。
 */
export function markCommandCodeStorageError(state: CollectorState) {
  try {
    setStatus(state, "storage-error");
  } catch {
    // 见函数说明。
  }
}

interface RejectedCooldownRecord {
  at: number;
  keyHash: string | null;
}

function readRejectedCooldown(
  raw: string | null,
): RejectedCooldownRecord | null {
  if (!raw) return null;
  const legacyAt = Number(raw);
  if (Number.isFinite(legacyAt)) return { at: legacyAt, keyHash: null };
  try {
    const parsed = JSON.parse(raw) as Partial<RejectedCooldownRecord>;
    if (typeof parsed.at === "number" && Number.isFinite(parsed.at)) {
      return {
        at: parsed.at,
        keyHash: typeof parsed.keyHash === "string" ? parsed.keyHash : null,
      };
    }
  } catch {
    // 忽略损坏的冷却记录。
  }
  return null;
}

function credentialKeyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * sync 中按需读取 Command Code 额度。停用、没有目标账户或没有凭据时不联网；
 * 成功时在同一事务内写入主体摘要、套餐缓存、账户资料（含主体摘要）与带冻结身份的额度。
 * 凭据对应的主体与已绑定的不同时拒绝写入。失败只记固定状态，保留上一次有效采样。
 */
export async function maybeRefreshCommandCodeQuota(
  state: CollectorState,
  config: Pick<
    CollectorConfig,
    "channelAccounts" | "modelAccounts" | "commandcode"
  > | null,
  options: CommandCodeRefreshOptions = {},
): Promise<CommandCodeRefreshReport> {
  const report = (
    status: CommandCodeRefreshStatus,
    attempted = false,
    quotas = 0,
  ): CommandCodeRefreshReport => {
    setStatus(state, status);
    return { attempted, status, quotas };
  };
  if (config?.commandcode?.enabled === false) return report("disabled");
  const target = commandCodeTarget(config);
  if (target.status === "skip") return report(target.reason);
  const now = (options.now ?? Date.now)();
  const credential = findCommandCodeCredential({
    authFile: config?.commandcode?.authFile,
    env: options.env ?? process.env,
    home: options.home ?? (process.env.HOME || homedir()),
    now,
  });
  if (credential.status === "none") return report("no-credential");
  if (credential.status === "expired") return report("expired");
  const keyHash = credentialKeyHash(credential.apiKey);
  const rejected = readRejectedCooldown(state.getMeta(REJECTED_AT_META));
  const sameRejectedKey =
    rejected !== null &&
    (rejected.keyHash === null || rejected.keyHash === keyHash);
  if (
    sameRejectedKey &&
    now - rejected.at < COMMAND_CODE_REJECTED_COOLDOWN_MS
  ) {
    return { attempted: false, status: "cooldown", quotas: 0 };
  }
  const refreshedAt = Number(state.getMeta(REFRESH_AT_META) ?? "");
  const bypassedCooldownWithNewKey =
    rejected !== null &&
    rejected.keyHash !== null &&
    rejected.keyHash !== keyHash;
  if (
    !bypassedCooldownWithNewKey &&
    Number.isFinite(refreshedAt) &&
    now - refreshedAt < COMMAND_CODE_MIN_INTERVAL_MS
  ) {
    return { attempted: false, status: "cooldown", quotas: 0 };
  }
  // 请求前记下时间：失败、超时或进程中断也计入间隔。
  state.setMeta(REFRESH_AT_META, String(now));

  let result: CommandCodeQuotaResult;
  try {
    result = await fetchCommandCodeQuota({
      apiKey: credential.apiKey,
      fetch: options.fetch,
    });
  } catch {
    result = { status: "error", kind: "network" };
  }
  if (result.status === "rejected") {
    state.setMeta(
      REJECTED_AT_META,
      JSON.stringify({ at: now, keyHash } satisfies RejectedCooldownRecord),
    );
    return report("rejected", true);
  }
  if (result.status === "error") return report(result.kind, true);
  if (state.getMeta(REJECTED_AT_META)) state.deleteMeta(REJECTED_AT_META);

  const { rule } = target;
  const identityKey = commandCodeIdentityMetaKey(rule.id);
  const bound = state.getMeta(identityKey);
  if (bound && bound !== result.subjectKey)
    return report("identity-changed", true);

  const sampledAt = new Date(now).toISOString();
  // 入队前逐条按 ingest 协议校验：不合协议的条目会让服务端拒收整批，堵住待发送队列。
  const quotas: IngestQuota[] = result.windows.flatMap((window) => {
    const parsed = ingestQuotaSchema.safeParse({
      accountExternalId: rule.id,
      window: window.window,
      percent: window.percent,
      sampledAt,
      resetsAt: window.resetsAt,
      windowMinutes: window.windowMinutes,
    });
    return parsed.success ? [parsed.data] : [];
  });
  // 每次成功读取都有新的采样时刻，百分比不变也会推进 sampledAt；同一次观测重放时哈希不变，不重复入队。
  const hash = createHash("sha256")
    .update(JSON.stringify([result.subjectKey, quotas]))
    .digest("hex");
  let queued = 0;
  state.write(() => {
    if (bound !== result.subjectKey)
      state.setMeta(identityKey, result.subjectKey);
    // 规则写死了套餐时以规则为准，观测到的套餐不进缓存，免得规则改回 null 后冒出过时的值。
    if (result.planId !== null && rule.plan === null) {
      const plans = state.commandCodePlans();
      if (plans[rule.id] !== result.planId) {
        plans[rule.id] = result.planId;
        state.setMeta(COMMAND_CODE_PLANS_META, JSON.stringify(plans));
      }
    }
    // 规则写死的套餐优先；规则为 null 时 upsertAccount 补上刚缓存的套餐，缺 planId 时沿用旧缓存。
    state.upsertAccount({
      externalId: rule.id,
      name: rule.name,
      platform: "commandcode",
      kind: rule.kind,
      plan: rule.plan,
      subjectKey: result.subjectKey,
    });
    if (
      quotas.length &&
      state.recordQuota({ hash, quotas }, `commandcode:${rule.id}`, {
        platform: "commandcode",
        subjectKey: result.subjectKey,
      })
    )
      queued = quotas.length;
    setStatus(state, "ok");
  });
  return { attempted: true, status: "ok", quotas: queued };
}
