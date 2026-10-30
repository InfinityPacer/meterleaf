#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readAgy, type AgyReaderSources } from "./agy";
import { readClaudeJson } from "./claude-code/account";
import {
  readCredentialText,
  readCredentialVersion,
} from "./claude-code/credential";
import { readStatuslineCache } from "./claude-code/statusline-cache";
import { collect, type CollectReport, type ProfileReport } from "./collect";
import { effectiveChannelAccounts } from "./channel-accounts";
import { readCodex, type CodexReaderSources } from "./codex";
import {
  DEFAULT_OTEL_RELAY_PORT,
  defaultSourceId,
  generateKey,
  isLoopback,
  keyDigest,
  loadConfig,
  normalizeServer,
  saveConfig,
  SOURCE_START,
  type CollectorConfig,
} from "./config";
import {
  appBundleOf,
  appendLog,
  installLaunchd,
  installService,
  legacyAgents,
  otelRelayProgramArguments,
  serviceStatus,
  syncProgramArguments,
  uninstallLaunchd,
  SERVICE_AGENTS,
} from "./launchd";
import { acquireLock } from "./lock";
import type { OpenCodeReaderSources } from "./opencode";
import { readOpenCode } from "./opencode";
import { startOtelRelay, type OtelRelay } from "./otel-relay";
import { resolvePaths, type CollectorPaths } from "./paths";
import { COLLECTOR_VERSION, pushOutbox } from "./push";
import type { SourceReaderReport } from "./sources";
import { CollectorState, type UsageTotals } from "./state";
import {
  checkExecutable,
  DEFAULT_TASK_EVERY_MINUTES,
  DEFAULT_TASK_TIMEOUT_SECONDS,
  describeResult,
  lastTaskResult,
  recordTaskResult,
  runDueTasks,
  runTask,
  taskSchema,
  taskSucceeded,
  type CollectorTask,
} from "./tasks";

const help = `Meterleaf Collector ${COLLECTOR_VERSION}
读取本机 Claude Code、Codex、OpenCode 与 Antigravity 的本地用量记录，推送到 Meterleaf 账本。

用法: meterleaf-collector <命令> [选项]

命令:
  init --server <url> [--source-id <id>] [--force]
                      生成写入密钥与配置，并输出服务端需要添加的密钥摘要
  server <url>        更换服务地址，写入密钥与来源 ID 保持不变
  bind-history        声明首次观察之前的历史用量属于当前登录账户
  statusline-cache <path>|off
                      （可选）读取状态栏脚本写出的额度缓存 TSV，获得比 .claude.json 更新的额度
  claude-profiles <configDir>[=<statuslineCache>] ... | off
                      登记同一台电脑上其他 Claude 账户的 CLAUDE_CONFIG_DIR，
                      读取各自的账户、套餐与额度；off 清除
  otel-headers        直连服务端时输出 otelHeadersHelper 所需的鉴权请求头（JSON 一行）；
                      推荐改用 otel-relay，直连配置仍然可用
  otel-relay          在 127.0.0.1:4319 常驻接收 Claude Code 的 OTEL 日志并排队，
                      由 sync 随用量一起推送；后台任务会自动启动
  scan [--json]       只在本地解析并汇总，不联网、不改变同步进度
  sync                增量采集并推送，再运行到期的额外任务；供后台任务每分钟运行，
                      已有实例运行时直接退出
  tasks [list]        列出额外任务及最近一次结果
  tasks add <name> [--every <分钟>] [--timeout <秒>] [--force] -- <绝对路径> [参数...]
                      登记额外任务，默认每 ${DEFAULT_TASK_EVERY_MINUTES} 分钟运行一次、限时 ${DEFAULT_TASK_TIMEOUT_SECONDS} 秒；--force 覆盖同名任务
  tasks remove <name> 删除额外任务
  tasks run <name>    立即运行一次额外任务并显示输出
  status              查看同步进度、待发送数量与最近结果（不显示密钥）
  install-launchd     安装 macOS 后台任务：每分钟低优先级运行 sync，并常驻运行 OTEL 中继
                      从 Meterleaf.app 运行时以应用身份注册，登录项中显示 Meterleaf
  uninstall-launchd   停止并删除 macOS 后台任务

通用选项:
  --claude-json <path>  指定 .claude.json 位置（默认 ~/.claude.json，也可用 METERLEAF_CLAUDE_JSON）
  --log                 输出追加到数据目录 logs 下的日志文件，供后台任务使用

对 Claude Code 的保证:
  - 只以只读方式打开 ~/.claude/projects 下的 JSONL，以及默认目录和已登记额外账户
    目录中的 .claude.json。不在 Claude Code 目录内写入、改名、加锁或修改权限，
    也不改设置、hooks 或状态栏。
  - 只在登录凭据（macOS 钥匙串或 .credentials.json）被改写或登录账户变化时读取，
    只取订阅类型和速率档位。OAuth 令牌不解析、不保存、不上传，不调用任何
    Anthropic 接口。
  - 只上传计量数字、模型、时间、套餐和账户 UUID 派生信息；不上传对话内容、工具输出、
    文件路径、工作目录、Git 分支、邮箱、显示名或组织名。

对 Codex、OpenCode 与 Antigravity 的保证:
  - 只以只读方式打开 ~/.codex（或 CODEX_HOME）下的会话记录、OpenCode 本地数据库
    ~/.local/share/opencode/opencode.db、Antigravity 会话库 ~/.gemini/antigravity-cli/conversations/*.db
    以及状态栏额度缓存 ~/.cache/agy-statusline。不修改原文件，不调用任何接口。
  - 只上传计量数字、模型、推理档位、时间与套餐；会话标识、消息内容、路径与
    凭据不读取、不上传。
  - 新来源只上传发生时间不早于 ${SOURCE_START.slice(0, 10)} 的记录，更早的历史在读取时丢弃。
  - 以上保证只针对采集器本身。用 tasks add 登记的额外任务由登记者负责，
    采集器只按时运行它们，不检查它们读写什么。

数据目录: $METERLEAF_COLLECTOR_HOME，默认 ~/Library/Application Support/Meterleaf Collector
`;

const integer = new Intl.NumberFormat("en-US");

function format(value: number): string {
  return integer.format(value);
}

function shortId(id: string): string {
  return id === "unattributed" ? id : `${id.slice(0, 8)}…`;
}

/** 任何会重新归属事件的命令都必须带上模型映射，否则映射账户的用量会被改归「其他模型」。 */
function openState(paths: CollectorPaths): CollectorState {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const state = new CollectorState(paths.stateFile);
  state.setModelAccounts(loadConfig(paths.configFile)?.modelAccounts ?? []);
  return state;
}

function printTotals(totals: UsageTotals[]) {
  const sum = totals.reduce(
    (acc, row) => ({
      events: acc.events + row.events,
      input: acc.input + row.input,
      output: acc.output + row.output,
      cacheRead: acc.cacheRead + row.cacheRead,
      cacheWrite: acc.cacheWrite + row.cacheWrite,
      reasoning: acc.reasoning + row.reasoning,
    }),
    {
      events: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
  );
  const rows = [
    ...totals.map((row) => ({ ...row, label: row.model })),
    { ...sum, label: "合计" },
  ];
  console.log(
    ["模型", "事件", "输入", "输出", "缓存读取", "缓存写入", "四桶合计"].join(
      "\t",
    ),
  );
  for (const row of rows) {
    console.log(
      [
        row.label,
        format(row.events),
        format(row.input),
        format(row.output),
        format(row.cacheRead),
        format(row.cacheWrite),
        format(row.input + row.output + row.cacheRead + row.cacheWrite),
      ].join("\t"),
    );
  }
}

/** 额度与额外账户的异常合成一行；没有异常时为空字符串。 */
function quotaIssueText(report: CollectReport) {
  const profileIssues = report.profiles.flatMap((profile) => {
    if (profile.skipped)
      return [`额外账户 ${profile.configDir}: ${profile.skipped}`];
    return [
      profile.quotaSkipped &&
        `额外账户 ${profile.configDir} 额度: ${profile.quotaSkipped}`,
      profile.statuslineQuotaSkipped &&
        `额外账户 ${profile.configDir} 状态栏额度: ${profile.statuslineQuotaSkipped}`,
      profile.statuslineIgnoredLines > 0 &&
        `额外账户 ${profile.configDir} 状态栏额度: 忽略 ${profile.statuslineIgnoredLines} 行`,
    ].filter(Boolean);
  });
  return [
    report.quotaSkipped && `额度: ${report.quotaSkipped}`,
    report.statuslineQuotaSkipped &&
      `状态栏额度: ${report.statuslineQuotaSkipped}`,
    report.statuslineIgnoredLines > 0 &&
      `状态栏额度: 忽略 ${report.statuslineIgnoredLines} 行无法识别的内容`,
    ...profileIssues,
  ]
    .filter(Boolean)
    .join("；");
}

/** scan 与 status 共用的额外账户摘要；只说明账户、套餐与额度是否读到。 */
function profileSummary(profile: {
  configDir: string;
  skipped?: string | null;
  accountUuid?: string | null;
  plan?: string | null;
  credentialPlanPending?: boolean;
  pendingPlan?: string | null;
  quotaRecorded?: boolean;
  quotaSkipped?: string | null;
  statuslineQuotaRecorded?: boolean;
  statuslineQuotaSkipped?: string | null;
}) {
  if (profile.skipped) return `${profile.configDir}: ${profile.skipped}`;
  const parts = [
    `账户 ${profile.accountUuid ? shortId(profile.accountUuid) : "未知"}`,
    `套餐 ${profile.plan ?? "未识别"}`,
  ];
  if (profile.credentialPlanPending)
    parts.push(
      `凭据套餐待确认${profile.pendingPlan ? `（${profile.pendingPlan}）` : ""}`,
    );
  if (profile.quotaSkipped) parts.push(`额度: ${profile.quotaSkipped}`);
  else if (profile.quotaRecorded) parts.push("额度已记录");
  if (profile.statuslineQuotaSkipped)
    parts.push(`状态栏额度: ${profile.statuslineQuotaSkipped}`);
  else if (profile.statuslineQuotaRecorded) parts.push("状态栏额度已记录");
  return `${profile.configDir}: ${parts.join("，")}`;
}

function printReport(report: CollectReport) {
  console.log(
    `文件 ${format(report.files)}（读取 ${format(report.filesRead)}，重读 ${format(report.rewound)}），` +
      `行 ${format(report.lines)}，损坏行 ${format(report.malformed)}，合成行 ${format(report.synthetic)}，` +
      `读取 ${format(report.bytesRead)} 字节`,
  );
}

function runInit(paths: CollectorPaths, values: Record<string, unknown>) {
  const server = values.server;
  if (typeof server !== "string") {
    throw new Error(
      `缺少 --server。例如: meterleaf-collector init --server https://meterleaf.example.com --source-id ${defaultSourceId()}`,
    );
  }
  const existing = loadConfig(paths.configFile);
  if (existing && values.force !== true) {
    throw new Error(
      `已存在配置 ${paths.configFile}。重新生成会使旧密钥失效，确认后加 --force`,
    );
  }
  const normalized = normalizeServer(server);
  const sourceId =
    typeof values["source-id"] === "string"
      ? values["source-id"]
      : defaultSourceId();
  const key = generateKey();
  saveConfig(
    paths.dataDir,
    paths.configFile,
    { server: normalized, sourceId, key, createdAt: new Date().toISOString() },
    existing !== null,
  );
  console.log(`已创建配置 ${paths.configFile}（仅当前用户可读）`);
  console.log(`来源 ID: ${sourceId}`);
  console.log(`服务地址: ${normalized}`);
  if (normalized.startsWith("http:") && !isLoopback(normalized)) {
    console.log("警告: 服务地址未使用 HTTPS，写入密钥与用量将以明文传输。");
  }
  console.log("");
  console.log(
    "请让 Meterleaf 管理员在服务端环境变量中加入下面这一项，然后重启服务:",
  );
  console.log(`  METERLEAF_INGEST_KEYS=${sourceId}:${keyDigest(key)}`);
  console.log(
    "这是写入密钥的 SHA-256 摘要，可以安全转交；完整密钥只保存在本机配置文件中。",
  );
  console.log("");
  console.log("下一步:");
  console.log("  meterleaf-collector scan            先在本地核对解析结果");
  console.log(
    "  meterleaf-collector bind-history    （可选）把首次运行前的历史归属到当前账户",
  );
  console.log("  meterleaf-collector sync            推送一次");
  console.log("  meterleaf-collector install-launchd 安装每分钟运行的后台任务");
}

/** 只换服务地址，写入密钥与来源 ID 不变，服务端无需改配置。 */
function runServer(paths: CollectorPaths, value: string | undefined) {
  const config = loadConfig(paths.configFile);
  if (!config) {
    console.error("尚未初始化，请先运行 meterleaf-collector init");
    return 2;
  }
  if (!value) {
    console.error(
      `用法: meterleaf-collector server <url>\n当前: ${config.server}`,
    );
    return 2;
  }
  const normalized = normalizeServer(value);
  saveConfig(
    paths.dataDir,
    paths.configFile,
    { ...config, server: normalized },
    true,
  );
  console.log(`服务地址: ${config.server} → ${normalized}`);
  if (normalized.startsWith("http:") && !isLoopback(normalized)) {
    console.log("警告: 服务地址未使用 HTTPS，写入密钥与用量将以明文传输。");
  }
  console.log(
    "写入密钥不变。运行 meterleaf-collector sync 确认新地址可以推送。",
  );
  return 0;
}

function runStatuslineCache(paths: CollectorPaths, value: string | undefined) {
  const config = loadConfig(paths.configFile);
  if (!config) {
    console.error("尚未初始化，请先运行 meterleaf-collector init");
    return 2;
  }
  if (!value) {
    console.error(
      "用法: meterleaf-collector statusline-cache <绝对路径>|off\n" +
        `当前: ${config.statuslineCache ?? "未启用"}`,
    );
    return 2;
  }
  const next = { ...config };
  if (value === "off") {
    delete next.statuslineCache;
  } else {
    if (!isAbsolute(value)) {
      console.error("请提供绝对路径");
      return 2;
    }
    next.statuslineCache = value;
  }
  saveConfig(paths.dataDir, paths.configFile, next, true);
  if (value === "off") {
    console.log("已停用状态栏额度缓存。");
    return 0;
  }
  const cache = readStatuslineCache(value);
  console.log(`已启用状态栏额度缓存: ${value}`);
  console.log(
    cache
      ? `当前内容可读取，采样于 ${cache.sampledAt}。`
      : "警告: 文件暂不存在或格式无效，下次状态栏更新后再试。",
  );
  console.log(
    "每行为「窗口名<TAB>已用百分比<TAB>重置时间 Unix 秒」，窗口名为 five_hour 或 seven_day；采样时间取文件修改时间。",
  );
  return 0;
}

/**
 * 登记额外账户。每项是 CLAUDE_CONFIG_DIR 的绝对路径，可选用 `=` 接该账户的状态栏额度缓存。
 * 目录不能是默认 Claude 目录本身，否则会和默认账户重复读取同一份数据。
 */
function runClaudeProfiles(paths: CollectorPaths, args: string[]): number {
  const config = loadConfig(paths.configFile);
  if (!config) {
    console.error("尚未初始化，请先运行 meterleaf-collector init");
    return 2;
  }
  const current = (config.claudeProfiles ?? [])
    .map(
      (profile) =>
        `${profile.configDir}${
          profile.statuslineCache ? `=${profile.statuslineCache}` : ""
        }`,
    )
    .join(" ");
  if (args.length === 0) {
    console.error(
      "用法: meterleaf-collector claude-profiles <configDir>[=<statuslineCache>] ... | off\n" +
        `当前: ${current || "未配置"}`,
    );
    return 2;
  }
  const next = { ...config };
  if (args.length === 1 && args[0] === "off") {
    delete next.claudeProfiles;
  } else {
    // 默认目录取用户主目录下的 .claude，而不是当前 shell 的 CLAUDE_CONFIG_DIR：
    // 用户切换账户时可能在 shell 里先导出这个变量，后台任务仍以主目录为默认账户。
    const defaultDir = resolve(process.env.HOME || homedir(), ".claude");
    const profiles: NonNullable<CollectorConfig["claudeProfiles"]> = [];
    const seen = new Set<string>();
    for (const arg of args) {
      if (arg === "off") {
        console.error("off 只能单独使用");
        return 2;
      }
      const separator = arg.indexOf("=");
      const configDir = separator >= 0 ? arg.slice(0, separator) : arg;
      const statuslineCache =
        separator >= 0 ? arg.slice(separator + 1) : undefined;
      if (!isAbsolute(configDir)) {
        console.error(`请提供绝对路径: ${configDir}`);
        return 2;
      }
      if (resolve(configDir) === defaultDir) {
        console.error("额外账户不能使用默认 Claude 配置目录");
        return 2;
      }
      if (statuslineCache !== undefined && !isAbsolute(statuslineCache)) {
        console.error(`请提供额度缓存的绝对路径: ${statuslineCache}`);
        return 2;
      }
      const key = resolve(configDir);
      if (seen.has(key)) {
        console.error(`重复的配置目录: ${configDir}`);
        return 2;
      }
      seen.add(key);
      profiles.push({
        configDir,
        ...(statuslineCache ? { statuslineCache } : {}),
      });
    }
    if (profiles.length > 20) {
      console.error("最多登记 20 个额外账户");
      return 2;
    }
    next.claudeProfiles = profiles;
  }
  saveConfig(paths.dataDir, paths.configFile, next, true);
  if (args.length === 1 && args[0] === "off") {
    console.log("已清除额外 Claude 账户。");
    return 0;
  }
  console.log("已配置额外 Claude 账户:");
  for (const profile of next.claudeProfiles ?? []) {
    console.log(
      `  ${profile.configDir}${
        profile.statuslineCache
          ? `（状态栏额度: ${profile.statuslineCache}）`
          : ""
      }`,
    );
  }
  return 0;
}

/** Claude Code 的 otelHeadersHelper 直接读取这一行 JSON，不作为其他输出。 */
function runOtelHeaders(paths: CollectorPaths): number {
  const config = loadConfig(paths.configFile);
  if (!config) {
    console.error("尚未初始化，请先运行 meterleaf-collector init");
    return 2;
  }
  console.log(JSON.stringify({ Authorization: `Bearer ${config.key}` }));
  return 0;
}

/**
 * 常驻接收 Claude Code 的 OTEL 日志。只监听回环地址，不与 sync 争用同步锁；
 * 两个进程通过 WAL 和 busy_timeout 并发读写同一个状态库。
 */
async function runOtelRelay(paths: CollectorPaths): Promise<number> {
  const config = loadConfig(paths.configFile);
  if (!config) {
    console.error("尚未初始化，请先运行 meterleaf-collector init");
    return 2;
  }
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const state = openState(paths);
  const port = config.otelRelay?.port ?? DEFAULT_OTEL_RELAY_PORT;
  let relay: OtelRelay;
  try {
    relay = startOtelRelay(state, { port });
  } catch (error) {
    state.close();
    const message = error instanceof Error ? error.message : String(error);
    const inUse =
      (error as { code?: unknown }).code === "EADDRINUSE" ||
      /in use|address already/i.test(message);
    console.error(
      inUse
        ? `无法启动 OTEL 本机中转: 127.0.0.1:${port} 已被占用。可修改 config.json 的 otelRelay.port，或停止占用该端口的程序。`
        : `无法启动 OTEL 本机中转: ${message}`,
    );
    return 1;
  }
  console.log(`OTEL 本机中转已启动: http://127.0.0.1:${relay.port}/v1/logs`);
  // 长时间保持运行，收到停止信号后先关闭监听与数据库再退出。
  return await new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      console.log(
        `${new Date().toISOString()} 收到 ${signal}，正在停止 OTEL 本机中转`,
      );
      void relay.stop().finally(() => {
        state.close();
        resolve(0);
      });
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
}

function collectSources(
  paths: CollectorPaths,
  config: Pick<
    CollectorConfig,
    "statuslineCache" | "modelAccounts" | "claudeProfiles"
  > | null,
) {
  return {
    ...paths,
    statuslineCache: config?.statuslineCache ?? null,
    modelAccounts: config?.modelAccounts ?? [],
    claudeProfiles: config?.claudeProfiles ?? [],
    credential: {
      location: {
        claudeRoot: paths.claudeRoot,
        configDir: process.env.CLAUDE_CONFIG_DIR || null,
      },
      read: readCredentialText,
      version: readCredentialVersion,
    },
  };
}

/** 每个来源一份读取器配置；路径缺失只让该来源本轮为空，不报错。 */
export function codexReaderConfig(
  config: CollectorConfig | null,
): CodexReaderSources | null {
  if (config?.codex?.enabled === false) return null;
  return {
    home: resolve(
      config?.codex?.home ??
        process.env.CODEX_HOME ??
        join(homedir(), ".codex"),
    ),
    start: SOURCE_START,
    channelAccounts: effectiveChannelAccounts(config),
  };
}

export function opencodeReaderConfig(
  config: CollectorConfig | null,
): OpenCodeReaderSources | null {
  if (config?.opencode?.enabled === false) return null;
  return {
    database:
      config?.opencode?.database ??
      resolve(homedir(), ".local", "share", "opencode", "opencode.db"),
    start: SOURCE_START,
    channelAccounts: effectiveChannelAccounts(config),
  };
}

export function agyReaderConfig(
  config: CollectorConfig | null,
): AgyReaderSources | null {
  if (config?.agy?.enabled === false) return null;
  const home = process.env.HOME || homedir();
  const cacheHome = process.env.XDG_CACHE_HOME || join(home, ".cache");
  return {
    conversationsDir: resolve(
      config?.agy?.conversationsDir ??
        join(home, ".gemini", "antigravity-cli", "conversations"),
    ),
    statuslineDir: resolve(
      config?.agy?.statuslineDir ?? join(cacheHome, "agy-statusline"),
    ),
    start: SOURCE_START,
  };
}

/** 一轮同步里的新来源读取；来源停用或入口缺失时为空。 */
export async function readNewSources(
  state: CollectorState,
  config: CollectorConfig | null,
): Promise<SourceReaderReport[]> {
  const reports: SourceReaderReport[] = [];
  const codex = codexReaderConfig(config);
  if (codex) reports.push(await readCodex(state, codex));
  const opencode = opencodeReaderConfig(config);
  if (opencode) reports.push(readOpenCode(state, opencode));
  const agy = agyReaderConfig(config);
  if (agy) reports.push(readAgy(state, agy));
  return reports;
}

/** 同步报告里的来源摘要行；没有活动时省略。 */
export function sourceReportText(
  reports: readonly SourceReaderReport[],
): string {
  return reports
    .map((report) => {
      const parts = [`读取 ${report.read}`, `入账 ${report.recorded}`];
      const skipped = Object.entries(report.skipped);
      if (skipped.length > 0)
        parts.push(
          `跳过 ${skipped.map(([key, count]) => `${key} ${count}`).join("、")}`,
        );
      if (report.invalid > 0) parts.push(`无效 ${report.invalid}`);
      return `${report.source}: ${parts.join("，")}`;
    })
    .join("；");
}

async function runScan(paths: CollectorPaths, json: boolean) {
  const state = new CollectorState(":memory:");
  try {
    let config: CollectorConfig | null = null;
    try {
      config = loadConfig(paths.configFile);
    } catch {
      config = null;
    }
    const report = collect(
      state,
      collectSources(paths, config),
      new Date(),
      () => new Date(),
    );
    // scan 只跑一轮：先解析 Claude Code，再按来源读取 Codex、OpenCode 与 Antigravity。
    const sources = await readNewSources(state, config);
    const totals = state.usageTotals();
    const quotas = state
      .pending<{
        account?: string;
        window: string;
        percent: number | null;
        sampledAt: string;
      }>("quota", 50)
      .map((item) => item.payload);
    if (json) {
      console.log(
        JSON.stringify(
          {
            report,
            sources,
            totals,
            quotas,
            pending: state.pendingCounts(),
            bySource: state.sourcePendingCounts(),
          },
          null,
          2,
        ),
      );
      return;
    }
    printReport(report);
    console.log(
      report.accountUuid
        ? `当前账户: ${shortId(report.accountUuid)}`
        : report.claudeJsonRead
          ? "当前账户: 未登录订阅账户"
          : "当前账户: 未能读取 .claude.json",
    );
    if (report.accountUuid) {
      // scan 只跑一轮，凭据套餐总是待确认；显示换算结果，同步时连续两轮一致才上报。
      const plan =
        report.pendingPlan ??
        state.account(report.accountUuid)?.plan ??
        "未识别";
      console.log(
        `套餐: ${plan}（${
          report.credentialPlanRead
            ? "来自登录凭据"
            : report.credentialPlanPending
              ? "来自登录凭据，同步时连续两轮一致后采用"
              : "未读到登录凭据"
        }）`,
      );
    }
    for (const item of sources) {
      const skipped = Object.entries(item.skipped);
      console.log(
        `来源 ${item.source}: 读取 ${format(item.read)}，入账 ${format(item.recorded)}，` +
          (skipped.length
            ? `跳过 ${skipped.map(([key, count]) => `${key} ${format(count)}`).join("、")}，`
            : "") +
          `无效 ${format(item.invalid)}`,
      );
    }
    const pendingBySource = state.sourcePendingCounts();
    console.log(
      `新来源待发送: codex ${format(pendingBySource.codex)}，opencode ${format(pendingBySource.opencode)}，agy ${format(pendingBySource.agy)}`,
    );
    for (const quota of quotas) {
      const accountPrefix = quota.account ? `${quota.account} ` : "";
      console.log(
        `额度 ${accountPrefix}${quota.window}: ${quota.percent ?? "未知"}%（采样于 ${quota.sampledAt}）`,
      );
    }
    const quotaIssue = quotaIssueText(report);
    if (quotaIssue) console.log(quotaIssue);
    for (const profile of report.profiles)
      console.log(`额外账户 ${profileSummary(profile)}`);
    console.log("");
    printTotals(totals);
    console.log("");
    console.log("scan 只读取本地文件，不联网，也不改变同步进度。");
  } finally {
    state.close();
  }
}

async function runSync(paths: CollectorPaths): Promise<number> {
  const config = loadConfig(paths.configFile);
  if (!config) {
    console.error("尚未初始化，请先运行 meterleaf-collector init");
    return 2;
  }
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(paths.lockFile);
  if (!release) return 0;
  let state: CollectorState | null = null;
  try {
    state = openState(paths);
    const report = collect(
      state,
      collectSources(paths, config),
      new Date(),
      () => new Date(),
    );
    // 新来源读取：Claude Code 之后处理 Codex 与 OpenCode，最后统一上传。
    const sources = await readNewSources(state, config);
    const now = new Date().toISOString();
    // 额度来源的问题与推送无关，每轮都会重复，只在情况变化时记一行，恢复时也记一行。
    const quotaIssue = quotaIssueText(report);
    if (quotaIssue !== (state.getMeta("last_quota_issue") ?? "")) {
      state.setMeta("last_quota_issue", quotaIssue);
      console.log(`${now} ${quotaIssue || "额度来源已恢复正常"}`);
    }
    // status 不运行采集，保留本轮结果供它显示额外账户与各来源的状态。
    const profileState = JSON.stringify(report.profiles);
    if (profileState !== (state.getMeta("last_profiles") ?? ""))
      state.setMeta("last_profiles", profileState);
    const summary = sourceReportText(sources);
    if (summary !== (state.getMeta("last_sources") ?? ""))
      state.setMeta("last_sources", summary);
    const result = await pushOutbox(state, config);
    if (result.error) {
      state.setMeta("last_failure_at", now);
      state.setMeta("last_failure", result.error.message);
      console.error(
        `${now} 推送失败（${result.error.kind}）: ${result.error.message}`,
      );
      return 1;
    }
    state.setMeta("last_success_at", now);
    if (
      result.batches > 0 ||
      report.rewound > 0 ||
      report.malformed > 0 ||
      sources.some((item) => item.read > 0)
    ) {
      console.log(
        `${now} 已推送 ${result.batches} 批: 用量 ${result.usage}，账户 ${result.accounts}，额度 ${result.quotas}，OTEL ${result.otel}` +
          (summary ? `；来源 ${summary}` : "") +
          (report.rewound > 0 ? `；重读文件 ${report.rewound}` : "") +
          (report.malformed > 0 ? `；损坏行 ${report.malformed}` : ""),
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state?.setMeta("last_failure_at", new Date().toISOString());
    state?.setMeta("last_failure", message);
    console.error(`${new Date().toISOString()} 同步失败: ${message}`);
    return 1;
  } finally {
    if (state) {
      try {
        await runDueTasks(
          state,
          paths,
          config.tasks ?? [],
          claudeConfigDirs(paths, config),
        );
      } catch (error) {
        console.error(
          `${new Date().toISOString()} 额外任务调度失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    state?.close();
    release();
  }
}

/** 传给额外任务的 Claude 配置目录：默认目录在前，随后是登记的额外账户。 */
function claudeConfigDirs(
  paths: CollectorPaths,
  config: Pick<CollectorConfig, "claudeProfiles">,
): string[] {
  return [
    paths.claudeRoot,
    ...(config.claudeProfiles ?? []).map((profile) => profile.configDir),
  ];
}

function parseTaskNumber(
  raw: string | undefined,
  fallback: number,
  label: string,
): number | string {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) ? value : `${label}必须是整数: ${raw}`;
}

async function runTasks(
  paths: CollectorPaths,
  args: string[],
  command: string[] | null,
  values: { every?: string; timeout?: string; force?: boolean },
): Promise<number> {
  const config = loadConfig(paths.configFile);
  if (!config) {
    console.error("尚未初始化，请先运行 meterleaf-collector init");
    return 2;
  }
  const tasks = config.tasks ?? [];
  const action = args[0] ?? "list";
  const name = args[1];
  const usage =
    "用法: meterleaf-collector tasks [list] | add <name> [--every <分钟>] [--timeout <秒>] [--force] -- <绝对路径> [参数...] | remove <name> | run <name>";
  if (action === "list") {
    if (tasks.length === 0) {
      console.log("额外任务: 未配置");
      return 0;
    }
    const state = existsSync(paths.stateFile)
      ? new CollectorState(paths.stateFile)
      : null;
    try {
      for (const task of tasks) {
        const last = state ? lastTaskResult(state, task.name) : null;
        console.log(
          `${task.name}: 每 ${task.everyMinutes} 分钟，限时 ${task.timeoutSeconds} 秒\n` +
            `  命令: ${task.command.join(" ")}\n` +
            `  最近一次: ${
              last
                ? `${last.startedAt} ${describeResult({ ...last, output: "" })}`
                : "尚未运行"
            }`,
        );
      }
    } finally {
      state?.close();
    }
    return 0;
  }
  if (!name || args.length > 2) {
    console.error(usage);
    return 2;
  }
  if (action === "add") {
    if (!command || command.length === 0) {
      console.error(`缺少要运行的命令，命令写在 -- 之后。\n${usage}`);
      return 2;
    }
    const everyMinutes = parseTaskNumber(
      values.every,
      DEFAULT_TASK_EVERY_MINUTES,
      "--every ",
    );
    const timeoutSeconds = parseTaskNumber(
      values.timeout,
      DEFAULT_TASK_TIMEOUT_SECONDS,
      "--timeout ",
    );
    if (
      typeof everyMinutes === "string" ||
      typeof timeoutSeconds === "string"
    ) {
      console.error(
        [everyMinutes, timeoutSeconds]
          .filter((v) => typeof v === "string")
          .join("\n"),
      );
      return 2;
    }
    const parsed = taskSchema.safeParse({
      name,
      command,
      everyMinutes,
      timeoutSeconds,
    });
    if (!parsed.success) {
      console.error(
        `任务无效: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "命令"} ${issue.message}`).join("；")}\n` +
          "名称只能用小写字母、数字和 -；间隔 1 到 1440 分钟；限时 1 到 600 秒。",
      );
      return 2;
    }
    const missing = checkExecutable(command[0]!);
    if (missing) {
      console.error(missing);
      return 2;
    }
    const exists = tasks.some((task) => task.name === name);
    if (exists && !values.force) {
      console.error(`已有同名任务 ${name}，用 --force 覆盖`);
      return 2;
    }
    if (!exists && tasks.length >= 20) {
      console.error("最多登记 20 个额外任务");
      return 2;
    }
    const next: CollectorTask[] = exists
      ? tasks.map((task) => (task.name === name ? parsed.data : task))
      : [...tasks, parsed.data];
    saveConfig(
      paths.dataDir,
      paths.configFile,
      { ...config, tasks: next },
      true,
    );
    console.log(
      `已登记任务 ${name}: 每 ${everyMinutes} 分钟，限时 ${timeoutSeconds} 秒，下一次 sync 开始运行。`,
    );
    return 0;
  }
  const task = tasks.find((item) => item.name === name);
  if (!task) {
    console.error(`没有名为 ${name} 的任务`);
    return 2;
  }
  if (action === "remove") {
    const rest = tasks.filter((item) => item.name !== name);
    const next = { ...config };
    if (rest.length) next.tasks = rest;
    else delete next.tasks;
    saveConfig(paths.dataDir, paths.configFile, next, true);
    console.log(
      `已删除任务 ${name}，它在数据目录 tasks/${name} 下留下的状态未删除。`,
    );
    return 0;
  }
  if (action === "run") {
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    // 与后台 sync 共用运行锁，手动运行不会与同一任务的定时运行重叠。
    const release = acquireLock(paths.lockFile);
    if (!release) {
      console.error("后台同步正在运行，稍后再试");
      return 1;
    }
    let state: CollectorState | null = null;
    try {
      state = openState(paths);
      const result = await runTask(
        paths,
        task,
        claudeConfigDirs(paths, config),
      );
      recordTaskResult(state, task.name, result);
      if (result.output) console.log(result.output);
      console.log(`任务 ${task.name}: ${describeResult(result)}`);
      return taskSucceeded(result) ? 0 : 1;
    } finally {
      state?.close();
      release();
    }
  }
  console.error(usage);
  return 2;
}

function runBindHistory(paths: CollectorPaths): number {
  const snapshot = readClaudeJson(paths.claudeJson);
  if (!snapshot?.account) {
    console.error("未能从 .claude.json 读取当前登录账户，无法绑定历史。");
    return 1;
  }
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(paths.lockFile);
  if (!release) {
    console.error("sync 正在运行，请稍后重试。");
    return 1;
  }
  const state = openState(paths);
  try {
    const accountUuid = snapshot.account.accountUuid;
    state.observeAccount(accountUuid, new Date().toISOString());
    const before = state.segments()[0]!.firstSeen;
    const previous = state.binding();
    state.setBinding({ accountUuid, before });
    const changed = state.reattribute(null);
    if (previous) {
      console.log(
        `已替换原有绑定（${shortId(previous.accountUuid)}，${previous.before} 之前）。`,
      );
    }
    console.log(
      `已声明 ${before} 之前的历史用量属于当前账户 ${shortId(accountUuid)}。`,
    );
    console.log(
      `${changed} 条已采集事件改变归属，下次 sync 时上传；尚未采集的历史会在读取时按此归属。`,
    );
    return 0;
  } finally {
    state.close();
    release();
  }
}

const serviceStatusLabels = {
  enabled: "已启用（Meterleaf.app）",
  "requires-approval": "等待在「登录项与扩展」中批准",
  "not-registered": "未安装",
  "not-found": "应用包内缺少后台任务",
  unknown: "状态未知",
} as const;

function backgroundTaskStatus(): string {
  const legacy = new Map(
    legacyAgents().map((agent) => [agent.label, agent.path]),
  );
  const bundle = process.platform === "darwin" ? appBundleOf() : null;
  return SERVICE_AGENTS.map((agent) => {
    const legacyPath = legacy.get(agent.label);
    const status =
      legacyPath && existsSync(legacyPath)
        ? "已安装（旧式 LaunchAgent）"
        : bundle
          ? serviceStatusLabels[serviceStatus(bundle, agent.plistName)]
          : "未安装";
    return `${agent.name} ${status}`;
  }).join("，");
}

/** 自定义路径只能通过环境变量传给后台任务，应用包内的固定 plist 无法携带。 */
function customEnvironment(
  paths: CollectorPaths,
  claudeJsonOption: string | undefined,
): Record<string, string> | null {
  const environment: Record<string, string> = {};
  if (process.env.METERLEAF_COLLECTOR_HOME) {
    environment.METERLEAF_COLLECTOR_HOME = paths.dataDir;
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    // 绝对路径保留原值，钥匙串条目名按原值计算；相对路径在后台任务里无法按原工作目录解析。
    environment.CLAUDE_CONFIG_DIR = isAbsolute(process.env.CLAUDE_CONFIG_DIR)
      ? process.env.CLAUDE_CONFIG_DIR
      : paths.claudeRoot;
  }
  if (claudeJsonOption || process.env.METERLEAF_CLAUDE_JSON) {
    environment.METERLEAF_CLAUDE_JSON = paths.claudeJson;
  }
  return Object.keys(environment).length > 0 ? environment : null;
}

function runInstall(
  paths: CollectorPaths,
  claudeJsonOption: string | undefined,
): number {
  if (!loadConfig(paths.configFile)) {
    throw new Error("尚未初始化，请先运行 meterleaf-collector init");
  }
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const environment = customEnvironment(paths, claudeJsonOption);
  const bundle = appBundleOf();
  const legacy = legacyAgents();
  let steps: string[];
  if (bundle && !environment) {
    steps = installService(bundle, legacy);
  } else {
    if (bundle) {
      console.log(
        "使用了自定义路径，改为安装旧式 LaunchAgent；登录项中会显示为可执行文件名。",
      );
    }
    steps = installLaunchd([
      {
        plistPath: legacy[0]!.path,
        programArguments: syncProgramArguments(),
        environment: environment ?? {},
      },
      {
        plistPath: legacy[1]!.path,
        programArguments: otelRelayProgramArguments(),
        environment: environment ?? {},
        label: legacy[1]!.label,
        keepAlive: true,
      },
    ]);
  }
  for (const step of steps) console.log(step);
  console.log(`日志: ${paths.logDir}`);
  return 0;
}

/** 后台任务没有终端，把标准输出与错误分别追加到日志目录。 */
function redirectToLog(paths: CollectorPaths) {
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const out = `${paths.logDir}/collector.log`;
  const err = `${paths.logDir}/collector.err.log`;
  const text = (items: unknown[]) => items.map(String).join(" ");
  console.log = (...items: unknown[]) => appendLog(out, text(items));
  console.error = (...items: unknown[]) => appendLog(err, text(items));
}

function runStatus(paths: CollectorPaths) {
  const config = loadConfig(paths.configFile);
  console.log(`数据目录: ${paths.dataDir}`);
  if (config) {
    console.log(`服务地址: ${config.server}`);
    console.log(`来源 ID: ${config.sourceId}`);
    console.log(
      `服务端密钥摘要: METERLEAF_INGEST_KEYS=${config.sourceId}:${keyDigest(config.key)}`,
    );
  } else {
    console.log("配置: 尚未初始化");
  }
  if (config) {
    console.log(`状态栏额度缓存: ${config.statuslineCache ?? "未启用"}`);
    const rules = config.modelAccounts ?? [];
    console.log(
      `模型账户映射: ${
        rules.length
          ? rules.map((rule) => `${rule.match} → ${rule.name}`).join("，")
          : "未配置（非 claude- 模型归入「其他模型」）"
      }`,
    );
    const channels = config.channelAccounts;
    console.log(
      `渠道账户规则: ${
        channels
          ? channels
              .map(
                (rule) =>
                  `${rule.source}:${rule.channel} → ${rule.name} (${rule.platform})`,
              )
              .join("，")
          : "未配置（使用内置默认：codex:openai → Codex，codex:go 与 opencode:opencode-go → OpenCode Go）"
      }`,
    );
    const codex = codexReaderConfig(config);
    const opencode = opencodeReaderConfig(config);
    const agy = agyReaderConfig(config);
    console.log(
      `读取来源: ${
        codex ? `Codex（${codex.home}）` : "Codex 已停用"
      }，${opencode ? `OpenCode（${opencode.database}）` : "OpenCode 已停用"}，${
        agy
          ? `Antigravity（${agy.conversationsDir}，额度 ${agy.statuslineDir}）`
          : "Antigravity 已停用"
      }`,
    );
    const profiles = config.claudeProfiles ?? [];
    console.log(
      `额外 Claude 账户: ${
        profiles.length
          ? profiles
              .map(
                (profile) =>
                  `${profile.configDir}${
                    profile.statuslineCache ? `=${profile.statuslineCache}` : ""
                  }`,
              )
              .join("，")
          : "未配置"
      }`,
    );
  }
  if (config) {
    const tasks = config.tasks ?? [];
    console.log(
      `额外任务: ${
        tasks.length
          ? tasks
              .map((task) => `${task.name}（每 ${task.everyMinutes} 分钟）`)
              .join("，")
          : "未配置"
      }`,
    );
  }
  console.log(`后台任务: ${backgroundTaskStatus()}`);
  if (!existsSync(paths.stateFile)) {
    console.log("同步状态: 尚未运行 sync");
    return;
  }
  const state = new CollectorState(paths.stateFile);
  try {
    const cursors = state.cursors();
    const pending = state.pendingCounts();
    const codexPending = state.codexFilePaths().length;
    const agyPending = state.agyFilePaths().length;
    console.log(
      `已跟踪文件: ${cursors.length}（另有 Codex ${codexPending}，Antigravity ${agyPending}），已读取 ${format(cursors.reduce((sum, row) => sum + row.offset, 0))} 字节`,
    );
    const bySource = state.sourcePendingCounts();
    console.log(
      `待发送: 用量 ${pending.usage}（Claude ${pending.usage - bySource.codex - bySource.opencode - bySource.agy}，Codex ${bySource.codex}，OpenCode ${bySource.opencode}，Antigravity ${bySource.agy}），账户 ${pending.account}，额度 ${pending.quota}，OTEL ${pending.otel}`,
    );
    console.log(`最近成功: ${state.getMeta("last_success_at") ?? "无"}`);
    const failureAt = state.getMeta("last_failure_at");
    if (failureAt) {
      console.log(
        `最近失败: ${failureAt} ${state.getMeta("last_failure") ?? ""}`,
      );
    }
    const lastSources = state.getMeta("last_sources");
    if (lastSources) console.log(`上轮来源: ${lastSources}`);
    for (const segment of state.segments()) {
      console.log(
        `账户区间: ${shortId(segment.accountUuid)} ${segment.firstSeen} → ${segment.lastSeen}`,
      );
    }
    const binding = state.binding();
    if (binding) {
      console.log(
        `历史绑定: ${binding.before} 之前归 ${shortId(binding.accountUuid)}`,
      );
    }
    for (const row of state.eventsByAccount()) {
      console.log(`事件归属: ${shortId(row.account)} ${format(row.events)}`);
    }
    const lastProfiles = state.getMeta("last_profiles");
    if (lastProfiles) {
      try {
        for (const profile of JSON.parse(lastProfiles) as ProfileReport[])
          console.log(`额外账户 ${profileSummary(profile)}`);
      } catch {
        // 旧版本或损坏的记录不影响其他状态输出。
      }
    }
  } finally {
    state.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  // tasks add 的命令写在 -- 之后，原样保存，不当作采集器自己的选项解析。
  const separator = argv.indexOf("--");
  const trailing = separator >= 0 ? argv.slice(separator + 1) : null;
  const { positionals, values } = parseArgs({
    args: separator >= 0 ? argv.slice(0, separator) : argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "source-id": { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      "claude-json": { type: "string" },
      log: { type: "boolean" },
      every: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (!command || values.help || command === "help") {
    console.log(help);
    return 0;
  }
  const paths = resolvePaths(process.env, {
    claudeJson: values["claude-json"],
  });
  if (values.log) redirectToLog(paths);
  switch (command) {
    case "init":
      runInit(paths, values);
      return 0;
    case "server":
      return runServer(paths, positionals[1]);
    case "statusline-cache":
      return runStatuslineCache(paths, positionals[1]);
    case "claude-profiles":
      return runClaudeProfiles(paths, positionals.slice(1));
    case "otel-headers":
      return runOtelHeaders(paths);
    case "otel-relay":
      return await runOtelRelay(paths);
    case "bind-history":
      return runBindHistory(paths);
    case "scan":
      await runScan(paths, values.json === true);
      return 0;
    case "sync":
      return runSync(paths);
    case "status":
      runStatus(paths);
      return 0;
    case "tasks":
      return await runTasks(paths, positionals.slice(1), trailing, values);
    case "install-launchd":
      return runInstall(paths, values["claude-json"]);
    case "uninstall-launchd":
      for (const step of uninstallLaunchd(appBundleOf(), legacyAgents())) {
        console.log(step);
      }
      return 0;
    default:
      console.error(`未知命令: ${command}\n`);
      console.error(help);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
