#!/usr/bin/env bun
/**
 * 在 Antigravity CLI（各实例的 Gemini / 第三方池）与 Codex 的额度窗口到期后，
 * 自动用对应池最便宜的模型发一条极简短语（如 ok、hi）触发新周期开窗。
 *
 * Antigravity 与 Codex 的周额度（7 天）和 5 小时窗口都是从窗口到期后的第一笔请求起算。
 * 如果窗口在睡眠或闲置期间到期，直到人手动发消息才开始新周期，周期轮转时间就会顺延。
 * 本脚本作为采集器的额外任务运行（每 5 分钟一次，睡眠唤醒后随下一轮 sync 自动补跑），
 * 仅靠本地额度缓存与会话文件判断窗口是否已到期，平时不发起任何探测请求。
 *
 * 默认只预热周窗口（`gemini_weekly`、`3p_weekly`、`codex:seven-day`）；
 * 传入 `--include-5h`（或环境变量 `METERLEAF_WARMUP_5H=1`）时一并预热 5 小时窗口。
 *
 * 用法: bun scripts/quota-warmup.ts [--dry-run] [--include-5h]
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

type Env = Record<string, string | undefined>;

export const WARMUP_PROMPTS = [
  "ok",
  "hi",
  "hey",
  "ping",
  "hello",
  "yo",
  "ack",
  "ready",
] as const;

export type AgyWindowKey =
  "gemini_5h" | "gemini_weekly" | "3p_5h" | "3p_weekly";

export type CodexWindowKey = "five-hour" | "seven-day";

/** Antigravity 各额度池最廉价的模型；主模型不可用时顺序回退备选模型。 */
export const AGY_POOL_MODELS: Record<"gemini" | "3p", readonly string[]> = {
  gemini: ["gemini-3.8-flash-low"],
  "3p": ["gpt-oss-120b-medium", "claude-sonnet-5-5-low"],
};

/** Codex OpenAI 通道最廉价的模型（$0.10/M 输入，2.5 credits/M 输入）。 */
export const CODEX_WARMUP_MODEL = "gpt-6-luna";

const RETRY_COOLDOWN_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 45_000;

const quotaBuckets: Record<string, AgyWindowKey> = {
  "gemini-5h": "gemini_5h",
  "gemini-weekly": "gemini_weekly",
  "3p-5h": "3p_5h",
  "3p-weekly": "3p_weekly",
};
const tsvOrder = [...Object.values(quotaBuckets), "plan"];

export interface AgyInstance {
  profileName: string | null;
  appDataDir: string;
  geminiDir: string;
  conversationsDir: string;
  label: string | null;
}

export interface WarmupTarget {
  key: string;
  provider: "agy" | "codex";
  account: string;
  profileName: string | null;
  pool: "gemini" | "3p" | "codex";
  windows: string[];
  resetEpoch: number;
  models: readonly string[];
  instance?: AgyInstance;
}

export interface WarmupAction {
  key: string;
  provider: "agy" | "codex";
  account: string;
  profileName: string | null;
  pool: "gemini" | "3p" | "codex";
  windows: string[];
  resetEpoch: number;
  model: string;
  prompt: string;
  succeeded: boolean;
  refreshedQuota: boolean;
  error: string | null;
}

export interface WarmupReport {
  checkedAgyAccounts: string[];
  checkedCodex: boolean;
  eligible: WarmupTarget[];
  actions: WarmupAction[];
  skippedHandled: string[];
  skippedCooldown: string[];
}

interface StateFile {
  /** 已成功预热的 `target.key -> resetEpoch`，同一旧周期只触发一次。 */
  handled: Record<string, number>;
  /** 尝试时间 `target.key -> { resetEpoch, atMs, error }`，失败后冷却退避。 */
  attempts: Record<
    string,
    { resetEpoch: number; atMs: number; error?: string | null }
  >;
}

export interface CommandExecution {
  exitCode: number | "timeout";
  stdout: string;
  logText: string;
}

export type CommandRunner = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    logFile?: string;
    timeoutMs?: number;
  },
) => Promise<CommandExecution>;

function isValidAgyLabel(label: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(label);
}

function agyLabelFromEmail(email: string): string | null {
  const local = email
    .split("@")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return local && isValidAgyLabel(local) ? local : null;
}

function stateDir(env: Env): string {
  return (
    env.METERLEAF_TASK_STATE_DIR ||
    join(
      env.HOME || homedir(),
      "Library",
      "Application Support",
      "Meterleaf Collector",
      "tasks",
      "quota-warmup",
    )
  );
}

function statuslineDir(env: Env): string {
  if (env.METERLEAF_AGY_STATUSLINE_DIR) return env.METERLEAF_AGY_STATUSLINE_DIR;
  const home = env.HOME || homedir();
  const cacheHome = env.XDG_CACHE_HOME || join(home, ".cache");
  return join(cacheHome, "agy-statusline");
}

function conversationsDir(env: Env): string {
  if (env.METERLEAF_AGY_CONVERSATIONS_DIR)
    return env.METERLEAF_AGY_CONVERSATIONS_DIR;
  const home = env.HOME || homedir();
  return join(home, ".gemini", "antigravity-cli", "conversations");
}

function codexHome(env: Env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

function loadState(path: string): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>;
    return {
      handled:
        parsed?.handled && typeof parsed.handled === "object"
          ? parsed.handled
          : {},
      attempts:
        parsed?.attempts && typeof parsed.attempts === "object"
          ? parsed.attempts
          : {},
    };
  } catch {
    return { handled: {}, attempts: {} };
  }
}

function replaceFile(path: string, content: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function saveState(path: string, state: StateFile) {
  replaceFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function findExecutable(
  name: string,
  explicit: string | undefined,
  env: Env,
): string | null {
  const home = env.HOME || homedir();
  const candidates = explicit
    ? [explicit]
    : [
        ...[join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"],
        ...(env.PATH ?? "").split(":").filter(Boolean),
      ].map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续查找下一个位置。
    }
  }
  return null;
}

function childEnv(env: Env): Record<string, string> {
  const home = env.HOME || homedir();
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  result.PATH = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    result.PATH ?? "",
  ]
    .filter(Boolean)
    .join(":");
  return result;
}

export const defaultCommandRunner: CommandRunner = async (argv, options) => {
  const outFile = join(
    options.cwd,
    `stdout-${Date.now()}-${Math.random().toString(36).slice(2)}.out`,
  );
  const outputFd = openSync(outFile, "w", 0o600);
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: outputFd,
      stderr: outputFd,
      detached: true,
    });
  } finally {
    closeSync(outputFd);
  }
  const { promise: deadline, resolve } = Promise.withResolvers<"timeout">();
  const timer = setTimeout(
    () => resolve("timeout"),
    options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  );
  const outcome = await Promise.race([child.exited, deadline]);
  clearTimeout(timer);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // 进程组已全部退出。
  }
  if (outcome === "timeout") {
    await Promise.race([child.exited, Bun.sleep(2000)]);
  }
  let stdout = "";
  try {
    stdout = readFileSync(outFile, "utf8");
  } catch {
    // 无输出。
  } finally {
    rmSync(outFile, { force: true });
  }
  let logText = "";
  if (options.logFile) {
    try {
      logText = readFileSync(options.logFile, "utf8");
    } catch {
      // 无日志。
    }
  }
  return { exitCode: outcome, stdout, logText };
};

function labelFromAgyLog(log: string): string | null {
  const emails = [...log.matchAll(/authenticated successfully as ([^\s]+)/g)];
  const email = emails.at(-1)?.[1];
  return email ? agyLabelFromEmail(email) : null;
}

function labelFromOAuthTokenFile(appDataDir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(appDataDir, "antigravity-oauth-token"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      id_token_email?: unknown;
      id_token?: unknown;
    } | null;
    if (
      typeof parsed?.id_token_email === "string" &&
      parsed.id_token_email.length > 0
    ) {
      const label = agyLabelFromEmail(parsed.id_token_email);
      if (label) return label;
    }
    if (typeof parsed?.id_token !== "string") return null;
    const parts = parsed.id_token.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { email?: unknown } | null;
    return typeof claims?.email === "string"
      ? agyLabelFromEmail(claims.email)
      : null;
  } catch {
    return null;
  }
}

function labelFromAppDataLogs(appDataDir: string): string | null {
  const candidates: string[] = [];
  try {
    const logDir = join(appDataDir, "log");
    const names = readdirSync(logDir)
      .filter((name) => name.startsWith("cli-") && name.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 5);
    for (const name of names) candidates.push(join(logDir, name));
  } catch {
    // 没有 log 子目录。
  }
  candidates.push(join(appDataDir, "cli.log"));
  for (const path of candidates) {
    try {
      const label = labelFromAgyLog(readFileSync(path, "utf8"));
      if (label) return label;
    } catch {
      // 继续尝试下一个日志。
    }
  }
  return null;
}

function readCurrentAccount(
  dir: string,
  profileName: string | null,
): string | null {
  const fileName = profileName
    ? `current-account-${profileName}`
    : "current-account";
  try {
    const label = readFileSync(join(dir, fileName), "utf8").trim();
    return isValidAgyLabel(label) ? label : null;
  } catch {
    return null;
  }
}

function listQuotaLabels(dir: string): string[] {
  try {
    return readdirSync(dir)
      .sort()
      .flatMap((name) => {
        const match = /^quota-([a-z0-9][a-z0-9_-]{0,63})\.tsv$/.exec(name);
        return match?.[1] ? [match[1]] : [];
      });
  } catch {
    return [];
  }
}

export function discoverAgyInstances(
  defaultConvDir: string,
  statusDir: string,
): AgyInstance[] {
  const appDataDir = dirname(defaultConvDir);
  const geminiDir = dirname(appDataDir);
  const rawInstances: Omit<AgyInstance, "label">[] = [
    {
      profileName: null,
      appDataDir,
      geminiDir,
      conversationsDir: defaultConvDir,
    },
  ];
  if (
    basename(defaultConvDir) === "conversations" &&
    basename(appDataDir) === "antigravity-cli"
  ) {
    try {
      const prefix = "antigravity-cli-";
      for (const name of readdirSync(geminiDir).sort()) {
        if (!name.startsWith(prefix)) continue;
        const profileName = name.slice(prefix.length);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileName)) continue;
        const profileAppDataDir = join(geminiDir, name);
        try {
          if (!statSync(profileAppDataDir).isDirectory()) continue;
        } catch {
          continue;
        }
        rawInstances.push({
          profileName,
          appDataDir: profileAppDataDir,
          geminiDir,
          conversationsDir: join(profileAppDataDir, "conversations"),
        });
      }
    } catch {
      // 忽略目录不可读。
    }
  }
  const singleQuotaLabel = (() => {
    const labels = listQuotaLabels(statusDir);
    return labels.length === 1 ? labels[0]! : null;
  })();
  return rawInstances.map((inst) => {
    const label =
      inst.profileName !== null
        ? (labelFromOAuthTokenFile(inst.appDataDir) ??
          readCurrentAccount(statusDir, inst.profileName) ??
          labelFromAppDataLogs(inst.appDataDir))
        : (readCurrentAccount(statusDir, null) ??
          labelFromOAuthTokenFile(inst.appDataDir) ??
          labelFromAppDataLogs(inst.appDataDir) ??
          singleQuotaLabel);
    return { ...inst, label };
  });
}

export interface ParsedAgyQuota {
  windows: Map<AgyWindowKey, { percent: number; resetEpoch: number }>;
  plan: string | null;
}

export function readAgyQuotaTsv(path: string): ParsedAgyQuota | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const windows = new Map<
    AgyWindowKey,
    { percent: number; resetEpoch: number }
  >();
  let plan: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = rawLine.split("\t");
    if (parts.length !== 3) continue;
    const [key, second, third] = parts as [string, string, string];
    if (key === "plan") {
      if (second.trim()) plan = second.trim();
      continue;
    }
    if (
      key !== "gemini_5h" &&
      key !== "gemini_weekly" &&
      key !== "3p_5h" &&
      key !== "3p_weekly"
    )
      continue;
    const percent = Number(second.trim());
    const resetEpoch = Number(third.trim());
    if (
      !Number.isInteger(percent) ||
      percent < 0 ||
      percent > 100 ||
      !Number.isInteger(resetEpoch) ||
      resetEpoch <= 0
    )
      continue;
    windows.set(key, { percent, resetEpoch });
  }
  return windows.size > 0 || plan ? { windows, plan } : null;
}

function parseUsageBuckets(output: string): Map<string, string> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return "agy /usage 返回的不是有效 JSON";
  }
  const root = parsed as {
    status?: unknown;
    command?: { data?: { groups?: { buckets?: unknown }[] } };
  } | null;
  if (root?.status !== "SUCCESS") return "agy /usage 没有返回 SUCCESS";
  const rows = new Map<string, string>();
  for (const group of root.command?.data?.groups ?? []) {
    if (!Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets as Record<string, unknown>[]) {
      const key =
        typeof bucket?.id === "string" ? quotaBuckets[bucket.id] : null;
      const remaining = bucket?.remaining_fraction;
      const resetMs =
        typeof bucket?.reset_time === "string"
          ? Date.parse(bucket.reset_time)
          : NaN;
      if (
        !key ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1 ||
        !Number.isFinite(resetMs)
      )
        continue;
      const used = Math.round((1 - remaining) * 100);
      rows.set(key, `${key}\t${used}\t${Math.floor(resetMs / 1000)}`);
    }
  }
  return rows.size > 0 ? rows : "agy /usage 没有可用的额度桶";
}

function mergeQuotaFile(path: string, fresh: Map<string, string>) {
  const rows = new Map<string, string>();
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // 首次写入。
  }
  for (const line of existing.split("\n")) {
    const [name, second, third, extra] = line.replace(/\r$/, "").split("\t");
    if (
      name &&
      second &&
      third &&
      extra === undefined &&
      tsvOrder.includes(name)
    )
      rows.set(name, `${name}\t${second}\t${third}`);
  }
  for (const [name, row] of fresh) rows.set(name, row);
  const lines = tsvOrder.flatMap((name) => rows.get(name) ?? []);
  replaceFile(path, lines.map((line) => `${line}\n`).join(""));
}

export interface CodexLatestLimits {
  sampledAtMs: number;
  windows: Map<CodexWindowKey, { percent: number; resetEpoch: number }>;
}

/**
 * 从 `~/.codex/sessions` 最近修改的 JSONL 会话文件中提取最新一份属于 openai 通道的
 * `codex` 额度快照。按修改时间从新到旧最多检查前 15 个未压缩会话文件。
 */
export function readLatestCodexLimits(
  homeDir: string,
): CodexLatestLimits | null {
  const sessionsRoot = join(homeDir, "sessions");
  if (!existsSync(sessionsRoot)) return null;
  const files: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile() && name.endsWith(".jsonl")) {
          files.push({ path: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // 跳过不可读条目。
      }
    }
  };
  walk(sessionsRoot);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));

  let best: CodexLatestLimits | null = null;
  for (const file of files.slice(0, 15)) {
    if (best && file.mtimeMs < best.sampledAtMs - 60_000) break;
    let text: string;
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    let provider: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.includes("session_meta") && !line.includes("token_count"))
        continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload =
        raw?.payload && typeof raw.payload === "object"
          ? (raw.payload as Record<string, unknown>)
          : null;
      if (!payload) continue;
      if (raw.type === "session_meta") {
        if (typeof payload.model_provider === "string")
          provider = payload.model_provider;
        continue;
      }
      if (raw.type !== "event_msg" || payload.type !== "token_count") continue;
      if (provider !== "openai") continue;
      const limits =
        payload.rate_limits && typeof payload.rate_limits === "object"
          ? (payload.rate_limits as Record<string, unknown>)
          : null;
      if (!limits || (limits.limit_id != null && limits.limit_id !== "codex"))
        continue;
      const sampledAtMs =
        typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
      if (!Number.isFinite(sampledAtMs)) continue;
      const windows = new Map<
        CodexWindowKey,
        { percent: number; resetEpoch: number }
      >();
      for (const slot of ["primary", "secondary"]) {
        const bucket =
          limits[slot] && typeof limits[slot] === "object"
            ? (limits[slot] as Record<string, unknown>)
            : null;
        if (!bucket) continue;
        const minutes = bucket.window_minutes;
        const window: CodexWindowKey | null =
          minutes === 300
            ? "five-hour"
            : minutes === 10080
              ? "seven-day"
              : null;
        const percent = bucket.used_percent;
        const resetEpoch = bucket.resets_at;
        if (
          !window ||
          typeof percent !== "number" ||
          !Number.isFinite(percent) ||
          typeof resetEpoch !== "number" ||
          !Number.isSafeInteger(resetEpoch) ||
          resetEpoch <= 0
        )
          continue;
        windows.set(window, { percent, resetEpoch });
      }
      if (windows.size > 0 && (!best || sampledAtMs >= best.sampledAtMs)) {
        best = { sampledAtMs, windows };
      }
    }
  }
  return best;
}

export interface WarmupOptions {
  dryRun?: boolean;
  include5h?: boolean;
  now?: () => Date;
  pickPrompt?: (prompts: readonly string[]) => string;
  runner?: CommandRunner;
}

export async function runWarmup(
  env: Env = process.env,
  options: WarmupOptions = {},
): Promise<WarmupReport> {
  const now = options.now ?? (() => new Date());
  const nowSec = Math.floor(now().getTime() / 1000);
  const nowMs = now().getTime();
  const include5h =
    options.include5h ??
    (env.METERLEAF_WARMUP_5H === "1" || env.METERLEAF_WARMUP_5H === "true");
  const pickPrompt =
    options.pickPrompt ??
    ((prompts) => prompts[Math.floor(Math.random() * prompts.length)]!);
  const runner = options.runner ?? defaultCommandRunner;

  const stateDirectory = stateDir(env);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const statePath = join(stateDirectory, "state.json");
  const state = loadState(statePath);

  const statusDir = statuslineDir(env);
  const defaultConvDir = conversationsDir(env);
  const instances = discoverAgyInstances(defaultConvDir, statusDir);

  const report: WarmupReport = {
    checkedAgyAccounts: [],
    checkedCodex: false,
    eligible: [],
    actions: [],
    skippedHandled: [],
    skippedCooldown: [],
  };

  // 1. 收集 Antigravity 各实例已到期的池子（同一池子的 weekly 与 5h 共用一次请求）。
  const seenAgyLabels = new Set<string>();
  for (const instance of instances) {
    const label = instance.label;
    if (!label || seenAgyLabels.has(label)) continue;
    seenAgyLabels.add(label);
    const quota = readAgyQuotaTsv(join(statusDir, `quota-${label}.tsv`));
    if (!quota) continue;
    report.checkedAgyAccounts.push(label);

    for (const pool of ["gemini", "3p"] as const) {
      const weeklyKey: AgyWindowKey =
        pool === "gemini" ? "gemini_weekly" : "3p_weekly";
      const fiveHourKey: AgyWindowKey =
        pool === "gemini" ? "gemini_5h" : "3p_5h";
      const candidates: { window: AgyWindowKey; resetEpoch: number }[] = [];
      const weekly = quota.windows.get(weeklyKey);
      if (weekly && weekly.resetEpoch <= nowSec) {
        candidates.push({ window: weeklyKey, resetEpoch: weekly.resetEpoch });
      }
      if (include5h) {
        const fiveHour = quota.windows.get(fiveHourKey);
        if (fiveHour && fiveHour.resetEpoch <= nowSec) {
          candidates.push({
            window: fiveHourKey,
            resetEpoch: fiveHour.resetEpoch,
          });
        }
      }
      if (candidates.length === 0) continue;
      const maxResetEpoch = Math.max(...candidates.map((c) => c.resetEpoch));
      report.eligible.push({
        key: `agy:${label}:${pool}`,
        provider: "agy",
        account: label,
        profileName: instance.profileName,
        pool,
        windows: candidates.map((c) => c.window),
        resetEpoch: maxResetEpoch,
        models: AGY_POOL_MODELS[pool],
        instance,
      });
    }
  }

  // 2. 收集 Codex 已到期的窗口。
  const codexLimits = readLatestCodexLimits(codexHome(env));
  if (codexLimits) {
    report.checkedCodex = true;
    const candidates: { window: CodexWindowKey; resetEpoch: number }[] = [];
    const weekly = codexLimits.windows.get("seven-day");
    if (weekly && weekly.resetEpoch <= nowSec) {
      candidates.push({ window: "seven-day", resetEpoch: weekly.resetEpoch });
    }
    if (include5h) {
      const fiveHour = codexLimits.windows.get("five-hour");
      if (fiveHour && fiveHour.resetEpoch <= nowSec) {
        candidates.push({
          window: "five-hour",
          resetEpoch: fiveHour.resetEpoch,
        });
      }
    }
    if (candidates.length > 0) {
      const maxResetEpoch = Math.max(...candidates.map((c) => c.resetEpoch));
      report.eligible.push({
        key: "codex:default",
        provider: "codex",
        account: "codex",
        profileName: null,
        pool: "codex",
        windows: candidates.map((c) => c.window),
        resetEpoch: maxResetEpoch,
        models: [CODEX_WARMUP_MODEL],
      });
    }
  }

  // 3. 逐个执行预热。
  let stateModified = false;
  for (const target of report.eligible) {
    const handledEpoch = state.handled[target.key];
    if (handledEpoch !== undefined && handledEpoch >= target.resetEpoch) {
      report.skippedHandled.push(target.key);
      continue;
    }
    const lastAttempt = state.attempts[target.key];
    if (
      lastAttempt &&
      lastAttempt.resetEpoch >= target.resetEpoch &&
      nowMs - lastAttempt.atMs >= 0 &&
      nowMs - lastAttempt.atMs < RETRY_COOLDOWN_MS
    ) {
      report.skippedCooldown.push(target.key);
      continue;
    }

    const prompt = pickPrompt(WARMUP_PROMPTS);
    if (options.dryRun) {
      report.actions.push({
        key: target.key,
        provider: target.provider,
        account: target.account,
        profileName: target.profileName,
        pool: target.pool,
        windows: target.windows,
        resetEpoch: target.resetEpoch,
        model: target.models[0]!,
        prompt,
        succeeded: true,
        refreshedQuota: false,
        error: null,
      });
      continue;
    }

    state.attempts[target.key] = {
      resetEpoch: target.resetEpoch,
      atMs: nowMs,
      error: null,
    };
    stateModified = true;

    if (target.provider === "agy") {
      const action = await warmupAgyTarget(
        target,
        prompt,
        statusDir,
        env,
        runner,
      );
      report.actions.push(action);
      if (action.succeeded) {
        state.handled[target.key] = target.resetEpoch;
        delete state.attempts[target.key];
      } else {
        state.attempts[target.key] = {
          resetEpoch: target.resetEpoch,
          atMs: nowMs,
          error: action.error,
        };
      }
    } else {
      const action = await warmupCodexTarget(target, prompt, env, runner);
      report.actions.push(action);
      if (action.succeeded) {
        state.handled[target.key] = target.resetEpoch;
        delete state.attempts[target.key];
      } else {
        state.attempts[target.key] = {
          resetEpoch: target.resetEpoch,
          atMs: nowMs,
          error: action.error,
        };
      }
    }
  }

  if (stateModified && !options.dryRun) {
    saveState(statePath, state);
  }
  return report;
}

async function warmupAgyTarget(
  target: WarmupTarget,
  prompt: string,
  statusDir: string,
  env: Env,
  runner: CommandRunner,
): Promise<WarmupAction> {
  const agyBin = findExecutable("agy", env.AGY_BIN, env);
  if (!agyBin) {
    return {
      key: target.key,
      provider: "agy",
      account: target.account,
      profileName: target.profileName,
      pool: target.pool,
      windows: target.windows,
      resetEpoch: target.resetEpoch,
      model: target.models[0]!,
      prompt,
      succeeded: false,
      refreshedQuota: false,
      error: "找不到 agy 可执行文件",
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "meterleaf-warmup-agy-"));
  try {
    const execEnv = childEnv(env);
    execEnv.METERLEAF_AGY_PROBE = "1";
    execEnv.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
    execEnv.BROWSER = "/usr/bin/false";

    const instance = target.instance!;
    const prefixArgs = [agyBin];
    if (instance.profileName !== null) {
      execEnv.WSL_INTEROP = "1";
      prefixArgs.push("--gemini_dir", instance.geminiDir);
      prefixArgs.push(
        "--app_data_dir",
        `antigravity-cli-${instance.profileName}`,
      );
    }

    let chosenModel = target.models[0]!;
    let lastError: string | null = null;
    let promptSucceeded = false;

    for (const model of target.models) {
      chosenModel = model;
      const logFile = join(tempDir, `prompt-${model}.log`);
      const argv = [
        ...prefixArgs,
        "-p",
        prompt,
        "--model",
        model,
        "--disable-slash-commands",
        "--print-timeout",
        "30s",
        "--log-file",
        logFile,
      ];
      const res = await runner(argv, {
        cwd: tempDir,
        env: execEnv,
        logFile,
      });
      if (res.exitCode === 0) {
        promptSucceeded = true;
        lastError = null;
        break;
      }
      lastError =
        res.exitCode === "timeout"
          ? `agy (${model}) 超时`
          : `agy (${model}) 退出码 ${res.exitCode}`;
    }

    if (!promptSucceeded) {
      return {
        key: target.key,
        provider: "agy",
        account: target.account,
        profileName: target.profileName,
        pool: target.pool,
        windows: target.windows,
        resetEpoch: target.resetEpoch,
        model: chosenModel,
        prompt,
        succeeded: false,
        refreshedQuota: false,
        error: lastError,
      };
    }

    // 紧接着跑一次 /usage 把新周期的 resetsAt 写回 quota-<label>.tsv，避免下一轮任务读到旧的到期秒数。
    const usageLog = join(tempDir, "usage.log");
    const usageArgv = [
      ...prefixArgs,
      "-p",
      "/usage",
      "--output-format",
      "json",
      "--print-timeout",
      "30s",
      "--log-file",
      usageLog,
    ];
    const usageRes = await runner(usageArgv, {
      cwd: tempDir,
      env: execEnv,
      logFile: usageLog,
    });
    let refreshedQuota = false;
    if (usageRes.exitCode === 0) {
      const buckets = parseUsageBuckets(usageRes.stdout);
      if (typeof buckets !== "string") {
        mkdirSync(statusDir, { recursive: true, mode: 0o700 });
        mergeQuotaFile(join(statusDir, `quota-${target.account}.tsv`), buckets);
        refreshedQuota = true;
      }
    }

    return {
      key: target.key,
      provider: "agy",
      account: target.account,
      profileName: target.profileName,
      pool: target.pool,
      windows: target.windows,
      resetEpoch: target.resetEpoch,
      model: chosenModel,
      prompt,
      succeeded: true,
      refreshedQuota,
      error: null,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function warmupCodexTarget(
  target: WarmupTarget,
  prompt: string,
  env: Env,
  runner: CommandRunner,
): Promise<WarmupAction> {
  const codexBin = findExecutable("codex", env.CODEX_BIN, env);
  const model = target.models[0]!;
  if (!codexBin) {
    return {
      key: target.key,
      provider: "codex",
      account: target.account,
      profileName: null,
      pool: "codex",
      windows: target.windows,
      resetEpoch: target.resetEpoch,
      model,
      prompt,
      succeeded: false,
      refreshedQuota: false,
      error: "找不到 codex 可执行文件",
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "meterleaf-warmup-codex-"));
  try {
    const execEnv = childEnv(env);
    execEnv.BROWSER = "/usr/bin/false";
    const argv = [
      codexBin,
      "exec",
      "--skip-git-repo-check",
      "-C",
      tempDir,
      "-c",
      'model_provider="openai"',
      "-c",
      `model=${JSON.stringify(model)}`,
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      "mcp_servers={}",
      prompt,
    ];
    const res = await runner(argv, {
      cwd: tempDir,
      env: execEnv,
    });
    if (res.exitCode !== 0) {
      return {
        key: target.key,
        provider: "codex",
        account: target.account,
        profileName: null,
        pool: "codex",
        windows: target.windows,
        resetEpoch: target.resetEpoch,
        model,
        prompt,
        succeeded: false,
        refreshedQuota: false,
        error:
          res.exitCode === "timeout"
            ? "codex 超时"
            : `codex 退出码 ${res.exitCode}`,
      };
    }
    return {
      key: target.key,
      provider: "codex",
      account: target.account,
      profileName: null,
      pool: "codex",
      windows: target.windows,
      resetEpoch: target.resetEpoch,
      model,
      prompt,
      succeeded: true,
      refreshedQuota: true,
      error: null,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter(
    (arg) => arg !== "--dry-run" && arg !== "--include-5h",
  );
  if (unknown.length > 0) {
    console.error(
      "用法: bun scripts/quota-warmup.ts [--dry-run] [--include-5h]",
    );
    process.exit(2);
  }
  const dryRun = args.includes("--dry-run");
  const include5h = args.includes("--include-5h") ? true : undefined;
  const report = await runWarmup(process.env, { dryRun, include5h });
  let failed = false;
  for (const action of report.actions) {
    const scope = action.profileName
      ? `${action.account} (@${action.profileName})`
      : action.account;
    const windows = action.windows.join(", ");
    if (dryRun) {
      console.log(
        `[dry-run] 将预热 ${action.provider} ${scope} [${windows}]: model=${action.model} prompt=${JSON.stringify(action.prompt)}`,
      );
    } else if (action.succeeded) {
      console.log(
        `已预热 ${action.provider} ${scope} [${windows}]: model=${action.model} prompt=${JSON.stringify(action.prompt)}${action.refreshedQuota ? "（已刷新额度）" : ""}`,
      );
    } else {
      failed = true;
      console.error(
        `预热失败 ${action.provider} ${scope} [${windows}]: ${action.error}`,
      );
    }
  }
  if (dryRun && report.actions.length === 0) {
    console.log(
      `当前无到期窗口需要预热（已检查 Antigravity: ${report.checkedAgyAccounts.join(", ") || "无"}；Codex: ${report.checkedCodex ? "已检查" : "未找到记录"}）。`,
    );
  }
  if (failed) process.exit(1);
}
