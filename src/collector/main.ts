#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { readClaudeJson } from "./claude-code/account";
import { readStatuslineCache } from "./claude-code/statusline-cache";
import { collect, type CollectReport } from "./collect";
import {
  defaultSourceId,
  generateKey,
  isLoopback,
  keyDigest,
  loadConfig,
  normalizeServer,
  saveConfig,
} from "./config";
import {
  installLaunchd,
  plistPath,
  syncProgramArguments,
  uninstallLaunchd,
} from "./launchd";
import { acquireLock } from "./lock";
import { resolvePaths, type CollectorPaths } from "./paths";
import { COLLECTOR_VERSION, pushOutbox } from "./push";
import { CollectorState, type UsageTotals } from "./state";

const help = `Meterleaf Collector ${COLLECTOR_VERSION}
读取本机 Claude Code 的用量记录，推送到 Meterleaf 账本。

用法: meterleaf-collector <命令> [选项]

命令:
  init --server <url> [--source-id <id>] [--force]
                      生成写入密钥与配置，并输出服务端需要添加的密钥摘要
  bind-history        声明首次观察之前的历史用量属于当前登录账户
  statusline-cache <path>|off
                      （可选）读取状态栏脚本写出的额度缓存 TSV，获得比 .claude.json 更新的额度
  scan [--json]       只在本地解析并汇总，不联网、不改变同步进度
  sync                增量采集并推送；供后台任务每分钟运行，已有实例运行时直接退出
  status              查看同步进度、待发送数量与最近结果（不显示密钥）
  install-launchd     安装 macOS 后台任务，每 60 秒以低优先级运行 sync
  uninstall-launchd   停止并删除 macOS 后台任务

通用选项:
  --claude-json <path>  指定 .claude.json 位置（默认 ~/.claude.json，也可用 METERLEAF_CLAUDE_JSON）

对 Claude Code 的保证:
  - 只以只读方式打开 ~/.claude/projects 下的 JSONL 与 ~/.claude.json，
    不在 Claude Code 目录内写入、改名、加锁或修改权限，也不改设置、hooks 或状态栏。
  - 不读取也不使用 OAuth 令牌、钥匙串或 .credentials.json，不调用任何 Anthropic 接口。
  - 只上传计量数字、模型、时间和账户 UUID 派生信息；不上传对话内容、工具输出、
    文件路径、工作目录、Git 分支、邮箱、显示名或组织名。

数据目录: $METERLEAF_COLLECTOR_HOME，默认 ~/Library/Application Support/Meterleaf Collector
`;

const integer = new Intl.NumberFormat("en-US");

function format(value: number): string {
  return integer.format(value);
}

function shortId(id: string): string {
  return id === "unattributed" ? id : `${id.slice(0, 8)}…`;
}

function openState(paths: CollectorPaths): CollectorState {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  return new CollectorState(paths.stateFile);
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

function collectSources(paths: CollectorPaths) {
  let statuslineCache: string | null = null;
  try {
    statuslineCache = loadConfig(paths.configFile)?.statuslineCache ?? null;
  } catch {
    statuslineCache = null;
  }
  return { ...paths, statuslineCache };
}

function runScan(paths: CollectorPaths, json: boolean) {
  const state = new CollectorState(":memory:");
  try {
    const report = collect(state, collectSources(paths));
    const totals = state.usageTotals();
    const quotas = state
      .pending<{ window: string; percent: number | null; sampledAt: string }>(
        "quota",
        10,
      )
      .map((item) => item.payload);
    if (json) {
      console.log(
        JSON.stringify(
          { report, totals, quotas, pending: state.pendingCounts() },
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
    for (const quota of quotas) {
      console.log(
        `额度 ${quota.window}: ${quota.percent ?? "未知"}%（采样于 ${quota.sampledAt}）`,
      );
    }
    if (report.quotaSkipped) console.log(`额度: ${report.quotaSkipped}`);
    if (report.statuslineQuotaSkipped)
      console.log(`状态栏额度: ${report.statuslineQuotaSkipped}`);
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
    const report = collect(state, {
      ...paths,
      statuslineCache: config.statuslineCache,
    });
    const result = await pushOutbox(state, config);
    const now = new Date().toISOString();
    if (result.error) {
      state.setMeta("last_failure_at", now);
      state.setMeta("last_failure", result.error.message);
      console.error(
        `${now} 推送失败（${result.error.kind}）: ${result.error.message}`,
      );
      return 1;
    }
    state.setMeta("last_success_at", now);
    if (result.batches > 0 || report.rewound > 0 || report.malformed > 0) {
      console.log(
        `${now} 已推送 ${result.batches} 批: 用量 ${result.usage}，账户 ${result.accounts}，额度 ${result.quotas}` +
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
    state?.close();
    release();
  }
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
  if (config)
    console.log(`状态栏额度缓存: ${config.statuslineCache ?? "未启用"}`);
  console.log(`后台任务: ${existsSync(plistPath()) ? "已安装" : "未安装"}`);
  if (!existsSync(paths.stateFile)) {
    console.log("同步状态: 尚未运行 sync");
    return;
  }
  const state = new CollectorState(paths.stateFile);
  try {
    const cursors = state.cursors();
    const pending = state.pendingCounts();
    console.log(
      `已跟踪文件: ${cursors.length}，已读取 ${format(cursors.reduce((sum, row) => sum + row.offset, 0))} 字节`,
    );
    console.log(
      `待发送: 用量 ${pending.usage}，账户 ${pending.account}，额度 ${pending.quota}`,
    );
    console.log(`最近成功: ${state.getMeta("last_success_at") ?? "无"}`);
    const failureAt = state.getMeta("last_failure_at");
    if (failureAt) {
      console.log(
        `最近失败: ${failureAt} ${state.getMeta("last_failure") ?? ""}`,
      );
    }
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
  } finally {
    state.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "source-id": { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      "claude-json": { type: "string" },
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
  switch (command) {
    case "init":
      runInit(paths, values);
      return 0;
    case "statusline-cache":
      return runStatuslineCache(paths, positionals[1]);
    case "bind-history":
      return runBindHistory(paths);
    case "scan":
      runScan(paths, values.json === true);
      return 0;
    case "sync":
      return runSync(paths);
    case "status":
      runStatus(paths);
      return 0;
    case "install-launchd": {
      if (!loadConfig(paths.configFile)) {
        throw new Error("尚未初始化，请先运行 meterleaf-collector init");
      }
      const environment: Record<string, string> = {
        METERLEAF_COLLECTOR_HOME: paths.dataDir,
      };
      if (process.env.CLAUDE_CONFIG_DIR) {
        environment.CLAUDE_CONFIG_DIR = paths.claudeRoot;
      }
      if (values["claude-json"] || process.env.METERLEAF_CLAUDE_JSON) {
        environment.METERLEAF_CLAUDE_JSON = paths.claudeJson;
      }
      const steps = installLaunchd({
        plistPath: plistPath(),
        programArguments: syncProgramArguments(),
        logDir: paths.logDir,
        environment,
      });
      for (const step of steps) console.log(step);
      console.log(`日志: ${paths.logDir}`);
      return 0;
    }
    case "uninstall-launchd":
      for (const step of uninstallLaunchd(plistPath())) console.log(step);
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
