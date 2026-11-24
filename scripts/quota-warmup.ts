#!/usr/bin/env bun
/**
 * 在 Antigravity CLI（各实例的 Gemini / 第三方池）与 Codex 的额度窗口到期后，
 * 自动用对应池最便宜的模型发一条极简短语（如 ok、hi）触发新周期开窗。
 *
 * Antigravity 与 Codex 的周额度（7 天）和 5 小时窗口都是从窗口到期后的第一笔请求起算。
 * 如果窗口在睡眠或闲置期间到期，直到人手动发消息才开始新周期，周期轮转时间就会顺延。
 * 本脚本作为采集器的额外任务运行（每 5 分钟一次，睡眠唤醒后随下一轮 sync 自动补跑）。
 * 平时依靠本地额度缓存与会话文件判断窗口是否到期或处于未开窗状态（`0\t0`）；
 * 当某已启用 Antigravity 账号的额度缓存缺失或陈旧时，按带随机抖动的间隔（默认 50–80 分钟）
 * 发一次只读 `agy -p /usage` 刷新缓存（不调用模型、不消耗额度），以便及时发现上游中途重置。
 * 未开窗目标（`resetEpoch === 0`）按 30 分钟冷却重试，避免上游持续返回未开窗时每 5 分钟刷屏。
 *
 * 窗口与账号开关可在状态目录的 `config.json`（或环境变量 `METERLEAF_WARMUP_CONFIG` 指定路径）
 * 中按账号、按池子与窗口（`5h` / `7d`）独立配置。无配置文件时默认只预热周窗口
 * （`gemini_weekly`、`3p_weekly`、`codex:seven-day`），传入 `--codex-5h`（或
 * `METERLEAF_WARMUP_CODEX_5H=1`）开启 Codex 5 小时预热，传入 `--include-5h`（或
 * `METERLEAF_WARMUP_5H=1`）开启全部 5 小时预热。
 * 优先级：配置文件账号/池明确项 > 命令行参数与环境变量 > 配置文件 `defaults` > 内置默认。
 *
 * 用法: bun scripts/quota-warmup.ts [--dry-run] [--codex-5h] [--include-5h]
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
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
import { basename, dirname, join, resolve } from "node:path";

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

const COMMAND_TIMEOUT_MS = 45_000;

/** 未开窗目标（resetEpoch === 0）预热后的冷却秒数，避免上游迟迟不返回重置时间时每 5 分钟重复预热。 */
export const UNOPENED_WARMUP_COOLDOWN_SEC = 30 * 60;

/** Antigravity 闲置账号只读 /usage 刷新的默认随机抖动区间（分钟）。 */
export const DEFAULT_USAGE_REFRESH_MIN_MINUTES = 50;
export const DEFAULT_USAGE_REFRESH_MAX_MINUTES = 80;

const quotaBuckets: Record<string, AgyWindowKey> = {
  "gemini-5h": "gemini_5h",
  "gemini-weekly": "gemini_weekly",
  "3p-5h": "3p_5h",
  "3p-weekly": "3p_weekly",
};
const tsvOrder = [...Object.values(quotaBuckets), "plan"];
const agyWindowSeconds: Record<AgyWindowKey, number> = {
  gemini_5h: 5 * 3600,
  gemini_weekly: 7 * 24 * 3600,
  "3p_5h": 5 * 3600,
  "3p_weekly": 7 * 24 * 3600,
};
/** 查询本身与秒级截断的余量：重置时间离现在不少于「整个窗口长度减去它」即视为尚未开窗。 */
const UNOPENED_RESET_SLACK_SEC = 120;

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
  refreshedAgyAccounts: string[];
  checkedCodex: boolean;
  eligible: WarmupTarget[];
  actions: WarmupAction[];
  skippedHandled: string[];
}

export interface WindowRuleConfig {
  enabled?: boolean;
  "5h"?: boolean;
  "7d"?: boolean;
}

export interface AgyAccountRuleConfig extends WindowRuleConfig {
  gemini?: WindowRuleConfig;
  "3p"?: WindowRuleConfig;
}

export interface UsageRefreshMinutesConfig {
  min?: number;
  max?: number;
}

export interface WarmupConfig {
  usageRefreshMinutes?: UsageRefreshMinutesConfig;
  defaults?: WindowRuleConfig;
  accounts?: Record<string, AgyAccountRuleConfig>;
}

interface StateFile {
  /** 已成功预热的 `target.key -> resetEpoch`，同一旧周期只触发一次。 */
  handled: Record<string, number>;
  /** 未开窗目标（resetEpoch === 0）最近一次成功预热的 Unix 秒，用于冷却防刷屏。 */
  unopenedWarmupAt: Record<string, number>;
  /** 各 Antigravity 账号下次允许执行只读 /usage 刷新的 Unix 秒（含随机抖动与失败退避）。 */
  nextUsageRefreshAt: Record<string, number>;
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

function configFilePath(env: Env, stateDirectory: string): string {
  return env.METERLEAF_WARMUP_CONFIG || join(stateDirectory, "config.json");
}

function parseWindowRule(raw: unknown): WindowRuleConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const rule: WindowRuleConfig = {};
  if (typeof obj.enabled === "boolean") rule.enabled = obj.enabled;
  if (typeof obj["5h"] === "boolean") rule["5h"] = obj["5h"];
  if (typeof obj["7d"] === "boolean") rule["7d"] = obj["7d"];
  return rule;
}

function parseAccountRule(raw: unknown): AgyAccountRuleConfig | undefined {
  const base = parseWindowRule(raw);
  if (!base) return undefined;
  const obj = raw as Record<string, unknown>;
  const rule: AgyAccountRuleConfig = { ...base };
  const gemini = parseWindowRule(obj.gemini);
  if (gemini) rule.gemini = gemini;
  const thirdParty = parseWindowRule(obj["3p"]);
  if (thirdParty) rule["3p"] = thirdParty;
  return rule;
}

/** 读取可选的预热配置文件；文件不存在时返回空对象，格式错误时抛出明确报错。 */
export function loadWarmupConfig(path: string): WarmupConfig {
  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `预热配置文件不是有效 JSON (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`预热配置文件根节点必须是 JSON 对象 (${path})`);
  }
  const obj = parsed as Record<string, unknown>;
  const config: WarmupConfig = {};
  if (
    obj.usageRefreshMinutes &&
    typeof obj.usageRefreshMinutes === "object" &&
    !Array.isArray(obj.usageRefreshMinutes)
  ) {
    const minutes = obj.usageRefreshMinutes as Record<string, unknown>;
    config.usageRefreshMinutes = {
      ...(typeof minutes.min === "number" ? { min: minutes.min } : {}),
      ...(typeof minutes.max === "number" ? { max: minutes.max } : {}),
    };
  }
  const defaults = parseWindowRule(obj.defaults);
  if (defaults) config.defaults = defaults;
  if (
    obj.accounts &&
    typeof obj.accounts === "object" &&
    !Array.isArray(obj.accounts)
  ) {
    const accounts: Record<string, AgyAccountRuleConfig> = {};
    for (const [key, value] of Object.entries(
      obj.accounts as Record<string, unknown>,
    )) {
      const rule = parseAccountRule(value);
      if (rule) accounts[key] = rule;
    }
    config.accounts = accounts;
  }
  return config;
}

function resolveUsageRefreshBoundsSec(
  config: UsageRefreshMinutesConfig | undefined,
): { minSec: number; maxSec: number } {
  const rawMin =
    typeof config?.min === "number" &&
    Number.isFinite(config.min) &&
    config.min >= 1
      ? config.min
      : undefined;
  const rawMax =
    typeof config?.max === "number" &&
    Number.isFinite(config.max) &&
    config.max >= 1
      ? config.max
      : undefined;
  let minMinutes =
    rawMin ??
    (rawMax !== undefined
      ? Math.min(DEFAULT_USAGE_REFRESH_MIN_MINUTES, rawMax)
      : DEFAULT_USAGE_REFRESH_MIN_MINUTES);
  let maxMinutes =
    rawMax ?? Math.max(DEFAULT_USAGE_REFRESH_MAX_MINUTES, minMinutes);
  if (minMinutes > maxMinutes) {
    [minMinutes, maxMinutes] = [maxMinutes, minMinutes];
  }
  return {
    minSec: Math.round(minMinutes * 60),
    maxSec: Math.round(maxMinutes * 60),
  };
}

function pickUsageRefreshIntervalSec(
  minSec: number,
  maxSec: number,
  random: () => number,
): number {
  if (maxSec <= minSec) return minSec;
  const sample = random();
  const clamped = Number.isFinite(sample)
    ? Math.min(1, Math.max(0, sample))
    : 0;
  return Math.round(minSec + clamped * (maxSec - minSec));
}

function parseOptionalEnvFlag(value: string | undefined): boolean | undefined {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function findAgyAccountRule(
  accounts: Record<string, AgyAccountRuleConfig> | undefined,
  label: string,
  profileName: string | null,
): AgyAccountRuleConfig | undefined {
  if (!accounts) return undefined;
  const byLabel = accounts[`agy:${label}`];
  if (byLabel) return byLabel;
  if (profileName !== null) {
    return accounts[`agy:@${profileName}`] ?? accounts[`agy:${profileName}`];
  }
  return undefined;
}

function findCodexAccountRule(
  accounts: Record<string, AgyAccountRuleConfig> | undefined,
): WindowRuleConfig | undefined {
  if (!accounts) return undefined;
  return accounts.codex ?? accounts["codex:default"];
}

function resolveAgyPoolPolicy(
  defaults: WindowRuleConfig | undefined,
  accountRule: AgyAccountRuleConfig | undefined,
  pool: "gemini" | "3p",
  cliInclude5h: boolean | undefined,
): { enabled: boolean; fiveHour: boolean; sevenDay: boolean } {
  const accountEnabled = accountRule?.enabled ?? defaults?.enabled ?? true;
  const poolRule = accountRule?.[pool];
  return {
    enabled: accountEnabled && (poolRule?.enabled ?? true),
    fiveHour:
      poolRule?.["5h"] ??
      accountRule?.["5h"] ??
      cliInclude5h ??
      defaults?.["5h"] ??
      false,
    sevenDay:
      poolRule?.["7d"] ?? accountRule?.["7d"] ?? defaults?.["7d"] ?? true,
  };
}

function resolveCodexPolicy(
  defaults: WindowRuleConfig | undefined,
  accountRule: WindowRuleConfig | undefined,
  cliInclude5h: boolean | undefined,
  cliIncludeCodex5h: boolean | undefined,
): { enabled: boolean; fiveHour: boolean; sevenDay: boolean } {
  const cli5h =
    cliInclude5h === true ? true : (cliIncludeCodex5h ?? cliInclude5h);
  return {
    enabled: accountRule?.enabled ?? defaults?.enabled ?? true,
    fiveHour: accountRule?.["5h"] ?? cli5h ?? defaults?.["5h"] ?? false,
    sevenDay: accountRule?.["7d"] ?? defaults?.["7d"] ?? true,
  };
}

function readNumberMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    }
  }
  return result;
}

function loadState(path: string, legacyRefreshIntervalSec: number): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<
      StateFile & { usageRefreshAt?: Record<string, number> }
    >;
    const nextUsageRefreshAt = readNumberMap(parsed?.nextUsageRefreshAt);
    // 兼容旧版 state.json 的 usageRefreshAt（上次刷新时间），按最小间隔折算为下次允许时间。
    const legacyUsageRefreshAt = readNumberMap(parsed?.usageRefreshAt);
    for (const [label, lastAt] of Object.entries(legacyUsageRefreshAt)) {
      if (nextUsageRefreshAt[label] === undefined) {
        nextUsageRefreshAt[label] = lastAt + legacyRefreshIntervalSec;
      }
    }
    return {
      handled: readNumberMap(parsed?.handled),
      unopenedWarmupAt: readNumberMap(parsed?.unopenedWarmupAt),
      nextUsageRefreshAt,
    };
  } catch {
    return { handled: {}, unopenedWarmupAt: {}, nextUsageRefreshAt: {} };
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
  const absDefaultConvDir = resolve(defaultConvDir);
  const appDataDir = dirname(absDefaultConvDir);
  const geminiDir = dirname(appDataDir);
  const rawInstances: Omit<AgyInstance, "label">[] = [
    {
      profileName: null,
      appDataDir,
      geminiDir,
      conversationsDir: absDefaultConvDir,
    },
  ];
  if (
    basename(absDefaultConvDir) === "conversations" &&
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
        if (
          /(?:^|[-_])(backup|bak)(?:$|[-_])/i.test(profileName) ||
          !hasNonEmptyOAuthTokenFile(profileAppDataDir)
        ) {
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

/** 额外实例目录必须存在非空普通文件 antigravity-oauth-token（不跟随符号链接），否则严禁拉起 agy。 */
function hasNonEmptyOAuthTokenFile(appDataDir: string): boolean {
  try {
    const tokenStat = lstatSync(join(appDataDir, "antigravity-oauth-token"));
    return (
      !tokenStat.isSymbolicLink() && tokenStat.isFile() && tokenStat.size > 0
    );
  } catch {
    return false;
  }
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
    const percentText = second.trim();
    const resetText = third.trim();
    if (!/^\d+$/.test(percentText) || !/^\d+$/.test(resetText)) continue;
    const percent = Number(percentText);
    const resetEpoch = Number(resetText);
    // 0\t0 表示窗口刚被重置或新账号尚未开窗，保留为 resetEpoch = 0 以便触发首次预热。
    if (
      !Number.isSafeInteger(percent) ||
      percent < 0 ||
      percent > 100 ||
      !Number.isSafeInteger(resetEpoch) ||
      resetEpoch < 0 ||
      (resetEpoch === 0 && percent !== 0)
    )
      continue;
    windows.set(key, { percent, resetEpoch });
  }
  return windows.size > 0 || plan ? { windows, plan } : null;
}

/** 剩余不足 1% 时上游已拒绝请求，按 100% 计，与采集器口径一致。 */
function usedPercent(remaining: number): number {
  return remaining < 0.01 ? 100 : Math.round((1 - remaining) * 100);
}

/**
 * 解析 /usage 桶的 reset_time 为 Unix 秒。
 * remaining_fraction 为 1 且 reset_time 缺失、为 null/空字符串/0 时表示未开窗或刚重置，记为 0。
 */
function parseAgyUsageResetEpoch(
  resetTime: unknown,
  remaining: number,
): number | null {
  if (
    resetTime === undefined ||
    resetTime === null ||
    resetTime === "" ||
    resetTime === 0 ||
    resetTime === "0"
  ) {
    return remaining === 1 ? 0 : null;
  }
  if (typeof resetTime !== "string") return null;
  const resetMs = Date.parse(resetTime);
  if (!Number.isFinite(resetMs)) return null;
  const sec = Math.floor(resetMs / 1000);
  return sec > 0 ? sec : remaining === 1 ? 0 : null;
}

export function parseUsageBuckets(
  output: string,
  unopenedCheckAtSec?: number,
): Map<string, string> | string {
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
      if (
        !key ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1
      )
        continue;
      let resetEpoch = parseAgyUsageResetEpoch(bucket?.reset_time, remaining);
      if (resetEpoch === null) continue;
      // 上游重置后还没有请求的窗口，agy 也可能报一个「从查询时刻起算整个窗口」的重置时间，
      // 每次查询都往后顺延；只读巡检时按未开窗记为 0，否则预热永远等不到它到期。
      // 预热刚发出请求后的查询不做这项判断，那时窗口确实刚开、重置时间照实记录。
      if (
        unopenedCheckAtSec !== undefined &&
        remaining === 1 &&
        resetEpoch > 0 &&
        resetEpoch - unopenedCheckAtSec >=
          agyWindowSeconds[key] - UNOPENED_RESET_SLACK_SEC
      ) {
        resetEpoch = 0;
      }
      rows.set(key, `${key}\t${usedPercent(remaining)}\t${resetEpoch}`);
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
  includeCodex5h?: boolean;
  now?: () => Date;
  random?: () => number;
  pickPrompt?: (prompts: readonly string[]) => string;
  runner?: CommandRunner;
}

export async function runWarmup(
  env: Env = process.env,
  options: WarmupOptions = {},
): Promise<WarmupReport> {
  const now = options.now ?? (() => new Date());
  const nowSec = Math.floor(now().getTime() / 1000);
  const random = options.random ?? Math.random;
  const cliInclude5h =
    options.include5h ?? parseOptionalEnvFlag(env.METERLEAF_WARMUP_5H);
  const cliIncludeCodex5h =
    options.includeCodex5h ??
    parseOptionalEnvFlag(env.METERLEAF_WARMUP_CODEX_5H);
  const pickPrompt =
    options.pickPrompt ??
    ((prompts) => prompts[Math.floor(Math.random() * prompts.length)]!);
  const runner = options.runner ?? defaultCommandRunner;

  const stateDirectory = stateDir(env);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const config = loadWarmupConfig(configFilePath(env, stateDirectory));
  const { minSec: refreshMinSec, maxSec: refreshMaxSec } =
    resolveUsageRefreshBoundsSec(config.usageRefreshMinutes);
  const statePath = join(stateDirectory, "state.json");
  const state = loadState(statePath, refreshMinSec);

  const statusDir = statuslineDir(env);
  const defaultConvDir = conversationsDir(env);
  const instances = discoverAgyInstances(defaultConvDir, statusDir);

  const report: WarmupReport = {
    checkedAgyAccounts: [],
    refreshedAgyAccounts: [],
    checkedCodex: false,
    eligible: [],
    actions: [],
    skippedHandled: [],
  };

  let stateModified = false;
  const unopenedTargetKeys = new Set<string>();

  // 1. 收集 Antigravity 各实例已到期或未开窗的池子（同一池子的 weekly 与 5h 共用一次请求）。
  const seenAgyLabels = new Set<string>();
  for (const instance of instances) {
    const label = instance.label;
    if (!label || seenAgyLabels.has(label)) continue;
    seenAgyLabels.add(label);

    const accountRule = findAgyAccountRule(
      config.accounts,
      label,
      instance.profileName,
    );
    const poolPolicies = {
      gemini: resolveAgyPoolPolicy(
        config.defaults,
        accountRule,
        "gemini",
        cliInclude5h,
      ),
      "3p": resolveAgyPoolPolicy(
        config.defaults,
        accountRule,
        "3p",
        cliInclude5h,
      ),
    };
    const accountActive =
      (poolPolicies.gemini.enabled &&
        (poolPolicies.gemini.fiveHour || poolPolicies.gemini.sevenDay)) ||
      (poolPolicies["3p"].enabled &&
        (poolPolicies["3p"].fiveHour || poolPolicies["3p"].sevenDay));
    // 账号停用或全部池子窗口均关闭时，跳过陈旧 /usage 巡检与全部预热。
    if (!accountActive) continue;

    const quotaPath = join(statusDir, `quota-${label}.tsv`);

    // 闲置账号的本地缓存可能保留旧的未来重置时间，无法发现上游中途重置；
    // 缓存缺失或 mtime 超过最小刷新阈值且到达该账号的随机抖动时间点时，做一次只读 /usage 刷新。
    if (!options.dryRun) {
      let fileMtimeSec: number | null = null;
      try {
        const st = statSync(quotaPath);
        if (st.isFile()) fileMtimeSec = Math.floor(st.mtimeMs / 1000);
      } catch {
        // 缓存尚未生成。
      }
      const cacheStale =
        fileMtimeSec === null || nowSec - fileMtimeSec >= refreshMinSec;
      const nextRefreshAt = state.nextUsageRefreshAt[label];
      const refreshDue =
        nextRefreshAt === undefined ||
        nowSec >= nextRefreshAt ||
        nextRefreshAt - nowSec > refreshMaxSec;
      if (cacheStale && refreshDue) {
        const intervalSec = pickUsageRefreshIntervalSec(
          refreshMinSec,
          refreshMaxSec,
          random,
        );
        state.nextUsageRefreshAt[label] = nowSec + intervalSec;
        stateModified = true;
        const refreshed = await refreshStaleAgyQuota(
          instance,
          label,
          statusDir,
          env,
          runner,
          nowSec,
        );
        if (refreshed) {
          report.refreshedAgyAccounts.push(label);
        }
      }
    }

    const quota = readAgyQuotaTsv(quotaPath);
    if (!quota) continue;
    report.checkedAgyAccounts.push(label);

    for (const pool of ["gemini", "3p"] as const) {
      const policy = poolPolicies[pool];
      if (!policy.enabled) continue;
      const weeklyKey: AgyWindowKey =
        pool === "gemini" ? "gemini_weekly" : "3p_weekly";
      const fiveHourKey: AgyWindowKey =
        pool === "gemini" ? "gemini_5h" : "3p_5h";
      const candidates: { window: AgyWindowKey; resetEpoch: number }[] = [];
      if (policy.sevenDay) {
        const weekly = quota.windows.get(weeklyKey);
        if (weekly && weekly.resetEpoch <= nowSec) {
          candidates.push({ window: weeklyKey, resetEpoch: weekly.resetEpoch });
        }
      }
      if (policy.fiveHour) {
        const fiveHour = quota.windows.get(fiveHourKey);
        if (fiveHour && fiveHour.resetEpoch <= nowSec) {
          candidates.push({
            window: fiveHourKey,
            resetEpoch: fiveHour.resetEpoch,
          });
        }
      }
      if (candidates.length === 0) continue;
      const key = `agy:${label}:${pool}`;
      if (candidates.some((c) => c.resetEpoch === 0)) {
        unopenedTargetKeys.add(key);
      }
      const maxResetEpoch = Math.max(...candidates.map((c) => c.resetEpoch));
      report.eligible.push({
        key,
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
  const codexPolicy = resolveCodexPolicy(
    config.defaults,
    findCodexAccountRule(config.accounts),
    cliInclude5h,
    cliIncludeCodex5h,
  );
  if (codexPolicy.enabled && (codexPolicy.fiveHour || codexPolicy.sevenDay)) {
    const codexLimits = readLatestCodexLimits(codexHome(env));
    if (codexLimits) {
      report.checkedCodex = true;
      const candidates: { window: CodexWindowKey; resetEpoch: number }[] = [];
      if (codexPolicy.sevenDay) {
        const weekly = codexLimits.windows.get("seven-day");
        if (weekly && weekly.resetEpoch <= nowSec) {
          candidates.push({
            window: "seven-day",
            resetEpoch: weekly.resetEpoch,
          });
        }
      }
      if (codexPolicy.fiveHour) {
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
  }

  // 3. 逐个执行预热。
  for (const target of report.eligible) {
    const handledEpoch = state.handled[target.key];
    const hasUnopened = unopenedTargetKeys.has(target.key);
    const expiredAlreadyHandled =
      target.resetEpoch > 0 &&
      handledEpoch !== undefined &&
      handledEpoch >= target.resetEpoch;

    // 未开窗目标（resetEpoch === 0）不能与历史 handledEpoch 比较，否则记录一次后就会永久锁死；
    // 改按 30 分钟冷却，避免上游持续返回 0\t0 时每 5 分钟重复预热。
    if (expiredAlreadyHandled && !hasUnopened) {
      report.skippedHandled.push(target.key);
      continue;
    }
    if (target.resetEpoch === 0 || (expiredAlreadyHandled && hasUnopened)) {
      const lastUnopenedAt = state.unopenedWarmupAt[target.key];
      if (
        lastUnopenedAt !== undefined &&
        nowSec >= lastUnopenedAt &&
        nowSec - lastUnopenedAt < UNOPENED_WARMUP_COOLDOWN_SEC
      ) {
        report.skippedHandled.push(target.key);
        continue;
      }
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

    const action =
      target.provider === "agy"
        ? await warmupAgyTarget(target, prompt, statusDir, env, runner)
        : await warmupCodexTarget(target, prompt, env, runner);
    report.actions.push(action);
    if (action.succeeded) {
      if (target.resetEpoch > 0) {
        state.handled[target.key] = Math.max(
          state.handled[target.key] ?? 0,
          target.resetEpoch,
        );
      }
      if (target.resetEpoch === 0 || hasUnopened) {
        state.unopenedWarmupAt[target.key] = nowSec;
      }
      if (target.provider === "agy" && action.refreshedQuota) {
        state.nextUsageRefreshAt[target.account] =
          nowSec +
          pickUsageRefreshIntervalSec(refreshMinSec, refreshMaxSec, random);
      }
      stateModified = true;
    }
  }

  if (stateModified && !options.dryRun) {
    saveState(statePath, state);
  }
  return report;
}

function buildAgyExec(
  agyBin: string,
  instance: AgyInstance,
  env: Env,
): { execEnv: Record<string, string>; prefixArgs: string[] } {
  const execEnv = childEnv(env);
  delete execEnv.SSH_CONNECTION;
  delete execEnv.SSH_CLIENT;
  delete execEnv.SSH_TTY;
  execEnv.METERLEAF_AGY_PROBE = "1";
  execEnv.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  execEnv.BROWSER = "/usr/bin/false";

  const prefixArgs = [agyBin];
  if (instance.profileName !== null) {
    execEnv.WSL_INTEROP = "1";
    prefixArgs.push("--gemini_dir", resolve(instance.geminiDir));
    prefixArgs.push(
      "--app_data_dir",
      `antigravity-cli-${instance.profileName}`,
    );
  } else {
    delete execEnv.WSL_INTEROP;
  }
  return { execEnv, prefixArgs };
}

async function runAgyUsageRefresh(
  label: string,
  prefixArgs: string[],
  execEnv: Record<string, string>,
  tempDir: string,
  statusDir: string,
  runner: CommandRunner,
  unopenedCheckAtSec?: number,
): Promise<boolean> {
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
  if (usageRes.exitCode !== 0) return false;
  const buckets = parseUsageBuckets(usageRes.stdout, unopenedCheckAtSec);
  if (typeof buckets === "string") return false;
  mkdirSync(statusDir, { recursive: true, mode: 0o700 });
  mergeQuotaFile(join(statusDir, `quota-${label}.tsv`), buckets);
  return true;
}

async function refreshStaleAgyQuota(
  instance: AgyInstance,
  label: string,
  statusDir: string,
  env: Env,
  runner: CommandRunner,
  nowSec: number,
): Promise<boolean> {
  if (
    instance.profileName !== null &&
    !hasNonEmptyOAuthTokenFile(instance.appDataDir)
  ) {
    return false;
  }
  const agyBin = findExecutable("agy", env.AGY_BIN, env);
  if (!agyBin) return false;
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "meterleaf-warmup-usage-"));
    const { execEnv, prefixArgs } = buildAgyExec(agyBin, instance, env);
    return await runAgyUsageRefresh(
      label,
      prefixArgs,
      execEnv,
      tempDir,
      statusDir,
      runner,
      nowSec,
    );
  } catch {
    return false;
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 清理失败不覆盖已取得的刷新结果。
      }
    }
  }
}

async function warmupAgyTarget(
  target: WarmupTarget,
  prompt: string,
  statusDir: string,
  env: Env,
  runner: CommandRunner,
): Promise<WarmupAction> {
  const instance = target.instance!;
  const missingTokenError =
    "额外实例缺少有效的 antigravity-oauth-token，已跳过 agy 预热";
  if (
    instance.profileName !== null &&
    !hasNonEmptyOAuthTokenFile(instance.appDataDir)
  ) {
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
      error: missingTokenError,
    };
  }
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

  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "meterleaf-warmup-agy-"));
    const { execEnv, prefixArgs } = buildAgyExec(agyBin, instance, env);

    let chosenModel = target.models[0]!;
    let lastError: string | null = null;
    let promptSucceeded = false;

    for (const model of target.models) {
      if (
        instance.profileName !== null &&
        !hasNonEmptyOAuthTokenFile(instance.appDataDir)
      ) {
        lastError = missingTokenError;
        break;
      }
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

    // 派发 /usage 前再次复核令牌，防止预热 await 期间令牌被移除后弹浏览器；
    // 紧随的 /usage 或写缓存失败只影响 refreshedQuota，不覆盖已成功的预热结果。
    const canRefresh =
      instance.profileName === null ||
      hasNonEmptyOAuthTokenFile(instance.appDataDir);
    let refreshedQuota = false;
    if (canRefresh) {
      try {
        refreshedQuota = await runAgyUsageRefresh(
          target.account,
          prefixArgs,
          execEnv,
          tempDir,
          statusDir,
          runner,
        );
      } catch {
        refreshedQuota = false;
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
  } catch (error) {
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
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 清理失败不覆盖本次预热结果。
      }
    }
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
      "--ignore-user-config",
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
      'base_instructions="Reply with one word only and do not call any tools."',
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
    (arg) =>
      arg !== "--dry-run" && arg !== "--include-5h" && arg !== "--codex-5h",
  );
  if (unknown.length > 0) {
    console.error(
      "用法: bun scripts/quota-warmup.ts [--dry-run] [--codex-5h] [--include-5h]",
    );
    process.exit(2);
  }
  const dryRun = args.includes("--dry-run");
  const include5h = args.includes("--include-5h") ? true : undefined;
  const includeCodex5h = args.includes("--codex-5h") ? true : undefined;
  const report = await runWarmup(process.env, {
    dryRun,
    include5h,
    includeCodex5h,
  });
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
