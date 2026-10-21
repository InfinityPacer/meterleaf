import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  accountFact,
  readClaudeJson,
  type ClaudeAccount,
} from "./claude-code/account";
import {
  credentialPlanFrom,
  type ClaudeCredentialPlan,
  type CredentialLocation,
  type CredentialTextReader,
  type CredentialVersionReader,
} from "./claude-code/credential";
import { quotaSnapshot } from "./claude-code/quota";
import {
  readStatuslineCache,
  statuslineQuotaSnapshot,
} from "./claude-code/statusline-cache";
import { attribute } from "./attribution";
import { UNATTRIBUTED_ACCOUNT_ID } from "./claude-code/account";
import { mayContainUsage, parseLine } from "./claude-code/usage";
import type { CollectorState, FileCursor, FileObservation } from "./state";

export interface CollectSources {
  /** Claude Code 会话目录，通常是 ~/.claude/projects。 */
  projectsDir: string;
  claudeJson: string;
  /** 可选：用户状态栏脚本写出的额度缓存 TSV。 */
  statuslineCache?: string | null;
  /** 可选：读取登录凭据中的套餐字段；未提供时只用 .claude.json 中的字段。 */
  credential?: {
    location: CredentialLocation;
    read: CredentialTextReader;
    version: CredentialVersionReader;
  } | null;
}

export interface CollectReport {
  files: number;
  filesRead: number;
  bytesRead: number;
  rewound: number;
  lines: number;
  malformed: number;
  synthetic: number;
  changedEvents: number;
  reattributed: number;
  /** 本轮是否成功读取 ~/.claude.json；读不到时账户与额度本轮跳过。 */
  claudeJsonRead: boolean;
  accountUuid: string | null;
  /** 本轮是否读取了登录凭据；不需要时沿用已确认的套餐，不访问钥匙串。 */
  credentialChecked: boolean;
  /** 本轮是否采用了登录凭据中当前账户的套餐字段，含沿用此前确认的结果。 */
  credentialPlanRead: boolean;
  /** 本轮读到了套餐字段，但要等下一轮确认登录账户未变才采用。 */
  credentialPlanPending: boolean;
  /** 待确认的凭据换算出的套餐，供 scan 展示；未采用前不上报。 */
  pendingPlan: string | null;
  quotaRecorded: boolean;
  quotaSkipped: string | null;
  statuslineQuotaRecorded: boolean;
  statuslineQuotaSkipped: string | null;
  /** 状态栏额度缓存中被忽略的行数；其余有效行仍会上报。 */
  statuslineIgnoredLines: number;
}

const chunkBytes = 4 * 1024 * 1024;
const fingerprintBytes = 64;

/** 递归列出会话 JSONL（含子代理目录）；读取期间被删除的目录直接忽略。 */
export function listSessionFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function fingerprint(fd: number, offset: number): string {
  const length = Math.min(fingerprintBytes, offset);
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(
      fd,
      buffer,
      filled,
      length - filled,
      offset - length + filled,
    );
    if (read <= 0) break;
    filled += read;
  }
  return createHash("sha256").update(buffer.subarray(0, filled)).digest("hex");
}

/**
 * 增量读取一个会话文件。只以只读方式打开；只消费以换行结尾的完整行，
 * 末尾未写完的行留到下一轮。解析结果与新进度在同一事务提交。
 */
export function ingestFile(
  state: CollectorState,
  path: string,
  report: CollectReport,
) {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return;
    const identity = `${stat.dev}:${stat.ino}:${Math.round(stat.birthtimeMs)}`;
    const previous = state.cursor(path);
    let start = 0;
    if (previous && previous.identity === identity) {
      if (stat.size === previous.offset && stat.mtimeMs === previous.mtimeMs) {
        return;
      }
      if (
        stat.size >= previous.offset &&
        fingerprint(fd, previous.offset) === previous.fingerprint
      ) {
        start = previous.offset;
      } else {
        report.rewound += 1;
      }
    } else if (previous) {
      report.rewound += 1;
    }

    const observations = new Map<string, FileObservation>();
    const handleLine = (raw: string) => {
      report.lines += 1;
      if (!mayContainUsage(raw)) return;
      const result = parseLine(raw);
      if (result.kind === "malformed") report.malformed += 1;
      if (result.kind === "synthetic") report.synthetic += 1;
      if (result.kind !== "usage") return;
      for (const observation of result.observations) {
        const seen = observations.get(observation.key);
        if (!seen) {
          observations.set(observation.key, {
            key: observation.key,
            firstTimestamp: observation.timestamp,
            total: observation.total,
            fact: observation.fact,
          });
        } else if (observation.total > seen.total) {
          seen.total = observation.total;
          seen.fact = observation.fact;
        }
      }
    };

    // 只读到打开时的文件长度，使记录的修改时间与已读内容对应。
    let position = start;
    let consumed = start;
    let carry: Buffer[] = [];
    while (position < stat.size) {
      const length = Math.min(chunkBytes, stat.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, position);
      if (read <= 0) break;
      const chunkStart = position;
      position += read;
      report.bytesRead += read;
      let lineStart = 0;
      for (;;) {
        const newline = chunk.indexOf(10, lineStart);
        if (newline < 0 || newline >= read) break;
        let line = chunk.subarray(lineStart, newline);
        if (carry.length > 0) {
          line = Buffer.concat([...carry, line]);
          carry = [];
        }
        if (line.length > 0) handleLine(line.toString("utf8"));
        consumed = chunkStart + newline + 1;
        lineStart = newline + 1;
      }
      if (lineStart < read) carry.push(chunk.subarray(lineStart, read));
    }

    const cursor: FileCursor = {
      identity,
      offset: consumed,
      fingerprint: fingerprint(fd, consumed),
      mtimeMs: stat.mtimeMs,
    };
    report.filesRead += 1;
    report.changedEvents += state.applyFile(path, cursor, [
      ...observations.values(),
    ]);
  } finally {
    closeSync(fd);
  }
}

export function emptyReport(): CollectReport {
  return {
    files: 0,
    filesRead: 0,
    bytesRead: 0,
    rewound: 0,
    lines: 0,
    malformed: 0,
    synthetic: 0,
    changedEvents: 0,
    reattributed: 0,
    claudeJsonRead: false,
    accountUuid: null,
    credentialChecked: false,
    credentialPlanRead: false,
    credentialPlanPending: false,
    pendingPlan: null,
    quotaRecorded: false,
    quotaSkipped: null,
    statuslineQuotaRecorded: false,
    statuslineQuotaSkipped: null,
    statuslineIgnoredLines: 0,
  };
}

const credentialCandidateKey = "credential_plan_candidate";
const credentialCheckKey = "credential_plan_check";
/** 读不到凭据修改标记时，退回按此间隔复查。 */
const credentialFallbackMs = 24 * 60 * 60_000;

/** 最近一次为当前账户读取凭据的结果；plan 是已确认的套餐，读取失败时沿用此前的确认结果。 */
interface CredentialCheck {
  accountUuid: string;
  /** .claude.json 中与套餐相关的字段；变化时立即重新读取。 */
  signals: string;
  /** 读取时凭据的修改标记；凭据未被改写时，其中的套餐不会变。 */
  version: string | null;
  checkedAt: string;
  plan: ClaudeCredentialPlan | null;
}

function credentialSignals(account: ClaudeAccount): string {
  return JSON.stringify([
    account.organizationUuid,
    account.organizationType,
    account.rateLimitTier,
    account.billingType,
    account.seatTier,
  ]);
}

function readCredentialCheck(state: CollectorState): CredentialCheck | null {
  const raw = state.getMeta(credentialCheckKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CredentialCheck;
  } catch {
    return null;
  }
}

/**
 * 凭据含访问令牌，只在其中的套餐可能变化时读取：登录账户或其套餐字段变化、等待第二轮
 * 确认，或凭据被改写（登录、令牌刷新、套餐变化都会改写）。修改标记只取条目属性，
 * 不读取令牌；读不到标记时每天复查一次。其余轮次沿用已确认的套餐。
 */
function credentialDue(
  state: CollectorState,
  check: CredentialCheck | null,
  account: ClaudeAccount,
  version: string | null,
  now: Date,
): boolean {
  if (
    !check ||
    check.accountUuid !== account.accountUuid ||
    check.signals !== credentialSignals(account)
  )
    return true;
  const candidate = state.getMeta(credentialCandidateKey) ?? "";
  const confirmed = check.plan
    ? JSON.stringify({ accountUuid: check.accountUuid, plan: check.plan })
    : "";
  if (candidate && candidate !== confirmed) return true;
  if (version !== null) return version !== check.version;
  const elapsed = now.getTime() - Date.parse(check.checkedAt);
  // 时钟回拨或记录损坏时按到期处理。
  return !(elapsed >= 0) || elapsed >= credentialFallbackMs;
}

/**
 * 凭据只代表读取时登录的账户，且不带账户 UUID。Claude Code 登录新账户时先写凭据、
 * 后写 .claude.json，这几秒内两者分属不同账户。读取后再确认一次登录账户，并且只采用
 * 连续两轮都对同一账户读到的同一套餐；切换中途读到的组合不会持续到下一轮，
 * 不会把新账户的套餐记到旧账户上。代价是套餐晚一轮出现。等待确认期间沿用此前确认的套餐。
 */
function currentCredentialPlan(
  state: CollectorState,
  sources: CollectSources,
  account: ClaudeAccount,
  report: CollectReport,
  now: Date,
): ClaudeCredentialPlan | null {
  if (!sources.credential) return null;
  const { location, read, version: readVersion } = sources.credential;
  const check = readCredentialCheck(state);
  const sameAccount =
    check?.accountUuid === account.accountUuid &&
    check.signals === credentialSignals(account);
  const known = sameAccount ? check.plan : null;
  // 先取标记再读原文：两者之间凭据被改写时，下一轮标记不同，会再读一次。
  const version = readVersion(location);
  if (!credentialDue(state, check, account, version, now)) return known;

  report.credentialChecked = true;
  const plan = credentialPlanFrom(read(location));
  const confirmed = readClaudeJson(sources.claudeJson);
  const candidate =
    plan && confirmed?.account?.accountUuid === account.accountUuid
      ? JSON.stringify({ accountUuid: account.accountUuid, plan })
      : "";
  const previous = state.getMeta(credentialCandidateKey);
  if (previous !== candidate) state.setMeta(credentialCandidateKey, candidate);
  const record = (result: ClaudeCredentialPlan | null) =>
    state.setMeta(
      credentialCheckKey,
      JSON.stringify({
        accountUuid: account.accountUuid,
        signals: credentialSignals(account),
        version,
        checkedAt: now.toISOString(),
        plan: result,
      } satisfies CredentialCheck),
    );
  // 读不到时（例如钥匙串拒绝访问）沿用此前的套餐，等凭据下次改写再试。
  if (!candidate) {
    record(known);
    return known;
  }
  if (previous !== candidate) {
    report.credentialPlanPending = true;
    report.pendingPlan = accountFact(account, plan).plan;
    return known;
  }
  record(plan);
  return plan;
}

/**
 * 新版 Claude Code 的 .claude.json 不含组织类型和速率档位，本轮凭据又不可用时，
 * 只能得到不完整的套餐，例如 Team 席位读不出档位。这时沿用此前为该账户记录的套餐与类型，
 * 避免套餐在两次采集之间来回变化；旧版字段齐全或凭据可用时以本轮结果为准。
 */
function stickyAccountFact(
  state: CollectorState,
  account: ClaudeAccount,
  credential: ReturnType<typeof credentialPlanFrom>,
) {
  const fact = accountFact(account, credential);
  if (credential || account.organizationType !== null) return fact;
  const previous = state.account(account.accountUuid);
  if (!previous) return fact;
  return {
    ...fact,
    plan: previous.plan ?? fact.plan,
    kind: fact.kind === "unknown" ? previous.kind : fact.kind,
  };
}

/**
 * 一轮采集：先记录当前登录账户并按新时间线修正归属，再读取会话增量，
 * 使本轮新事件直接使用延长后的区间；最后记录额度快照。
 *
 * 读取期间 Claude Code 仍在写入，晚于开始时刻的记录落在观察区间之外。读完后再确认一次
 * 登录账户：未变化时把区间延长到确认时刻，这些记录与状态栏采样随即归入该账户；
 * 期间切换了账户则保持无法判断。finishedAt 给出确认时刻，测试可固定它。
 */
export function collect(
  state: CollectorState,
  sources: CollectSources,
  now: Date = new Date(),
  finishedAt: () => Date = () => now,
): CollectReport {
  const report = emptyReport();
  const snapshot = readClaudeJson(sources.claudeJson);
  report.claudeJsonRead = snapshot !== null;
  if (snapshot?.account) {
    report.accountUuid = snapshot.account.accountUuid;
    const credential = currentCredentialPlan(
      state,
      sources,
      snapshot.account,
      report,
      now,
    );
    report.credentialPlanRead = credential !== null;
    state.upsertAccount(stickyAccountFact(state, snapshot.account, credential));
    const since = state.observeAccount(
      snapshot.account.accountUuid,
      now.toISOString(),
    );
    report.reattributed += state.reattribute(since);
  }

  const files = listSessionFiles(sources.projectsDir);
  report.files = files.length;
  for (const path of files) ingestFile(state, path, report);
  state.forgetMissingFiles(new Set(files));

  // 先读状态栏缓存再确认账户，使采样时刻不晚于确认时刻。
  const cache = sources.statuslineCache
    ? readStatuslineCache(sources.statuslineCache)
    : undefined;
  if (snapshot?.account) {
    const accountUuid = snapshot.account.accountUuid;
    const confirmedAt = finishedAt().toISOString();
    const confirmed = readClaudeJson(sources.claudeJson);
    if (confirmed?.account?.accountUuid === accountUuid) {
      const since = state.observeAccount(accountUuid, confirmedAt);
      report.reattributed += state.reattribute(since);
    }
  }

  if (snapshot?.utilization) {
    const quota = quotaSnapshot(snapshot.utilization);
    if (!quota) {
      report.quotaSkipped = "额度缓存缺少账户或窗口";
    } else if (!state.account(quota.quotas[0]!.accountExternalId)) {
      // 缓存可能来自此前登录的其他账户，未知账户的额度不能挂到当前账户上。
      report.quotaSkipped = "额度缓存属于未观察到的账户";
    } else {
      report.quotaRecorded = state.recordQuota(quota);
    }
  }

  if (cache !== undefined) {
    if (!cache) {
      report.statuslineQuotaSkipped = "状态栏额度缓存不存在或格式无效";
    } else {
      report.statuslineIgnoredLines = cache.ignoredLines;
      // 文件不带账户，按采样时刻所在的登录区间归属；切换前后无法判断时不上报。
      const account = attribute(
        cache.sampledAt,
        state.segments(),
        state.binding(),
      );
      if (account === UNATTRIBUTED_ACCOUNT_ID || !state.account(account)) {
        report.statuslineQuotaSkipped = "无法确定状态栏额度采样时的登录账户";
      } else {
        report.statuslineQuotaRecorded = state.recordQuota(
          statuslineQuotaSnapshot(cache, account),
          "statusline",
        );
      }
    }
  }
  return report;
}
