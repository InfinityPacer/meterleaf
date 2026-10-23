import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const BUNDLE_IDENTIFIER = "io.meterleaf.collector";
/** 包内后台任务的标签。系统按标签记住被启动程序的签名，修改注册助手后需换新标签。 */
export const SERVICE_LABEL = "io.meterleaf.collector.background";
export const SERVICE_PLIST = `${SERVICE_LABEL}.plist`;
/** 常驻接收 Claude Code OTEL 日志的本机中转。 */
export const OTEL_RELAY_LABEL = "io.meterleaf.collector.otel-relay";
export const OTEL_RELAY_PLIST = `${OTEL_RELAY_LABEL}.plist`;
export const SERVICE_HELPER = "meterleaf-service";
/** 旧式 LaunchAgent，只在无法使用应用包注册时安装。 */
export const LAUNCHD_LABEL = "io.meterleaf.collector";

/** 后台运行时自己写日志，包内 plist 无法写入按用户展开的日志路径。 */
export const LOG_FLAG = "--log";

export interface LaunchdPlan {
  plistPath: string;
  programArguments: string[];
  environment: Record<string, string>;
  /** 省略时为每分钟一次同步任务；本机 OTEL 中继使用常驻任务。 */
  label?: string;
  keepAlive?: boolean;
}

export interface LegacyAgent {
  path: string;
  label: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stringArray(values: readonly string[]): string {
  return values
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
}

/**
 * 后台任务的程序参数。编译后的可执行文件（含 Meterleaf.app 内的
 * Contents/MacOS/meterleaf-collector）直接运行；用 bun 运行源码时带上入口脚本。
 */
function programArguments(
  command: "sync" | "otel-relay",
  execPath: string,
  mainScript: string,
): string[] {
  const executable = realpathSync(execPath);
  const name = basename(executable);
  if (
    (name === "bun" || name === "bun.exe") &&
    !mainScript.startsWith("/$bunfs/")
  ) {
    return [executable, realpathSync(mainScript), command, LOG_FLAG];
  }
  return [executable, command, LOG_FLAG];
}

export function syncProgramArguments(
  execPath: string = process.execPath,
  mainScript: string = Bun.main,
): string[] {
  return programArguments("sync", execPath, mainScript);
}

export function otelRelayProgramArguments(
  execPath: string = process.execPath,
  mainScript: string = Bun.main,
): string[] {
  return programArguments("otel-relay", execPath, mainScript);
}

/**
 * 同步任务的调度：每 60 秒一次，ProcessType Background、低优先级 IO
 * 与 Nice 10，不与 Claude Code 争抢资源。
 */
const syncSchedule = `  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>`;

/** 本机中转是常驻服务，由 launchd 保持运行，不按间隔启动。 */
const relaySchedule = `  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>`;

const plistHeader = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">`;

function renderServiceAgent(
  label: string,
  command: string,
  schedule: string,
): string {
  return `${plistHeader}
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${BUNDLE_IDENTIFIER}</string>
  </array>
  <key>BundleProgram</key>
  <string>Contents/MacOS/${SERVICE_HELPER}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${SERVICE_HELPER}</string>
    <string>exec</string>
    <string>${command}</string>
    <string>${LOG_FLAG}</string>
  </array>
${schedule}
</dict>
</plist>
`;
}

/**
 * 打包在 Meterleaf.app/Contents/Library/LaunchAgents 内的 plist。BundleProgram 相对
 * 应用包解析，因此应用移动后仍然有效；内容固定，不能携带环境变量。启动的是注册助手，
 * 由它 exec 采集器，原因见 macos/meterleaf-service.swift。
 */
export function renderServicePlist(): string {
  return renderServiceAgent(SERVICE_LABEL, "sync", syncSchedule);
}

/** 常驻接收 Claude Code OTEL 日志的包内任务，与同步任务各自独立注册。 */
export function renderOtelRelayServicePlist(): string {
  return renderServiceAgent(OTEL_RELAY_LABEL, "otel-relay", relaySchedule);
}

/** 旧式 LaunchAgent：可携带自定义环境变量，但登录项中显示为可执行文件名。 */
export function renderPlist(plan: LaunchdPlan): string {
  const environment = Object.entries(plan.environment)
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");
  return `${plistHeader}
<dict>
  <key>Label</key>
  <string>${plan.label ?? LAUNCHD_LABEL}</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${BUNDLE_IDENTIFIER}</string>
  </array>
  <key>ProgramArguments</key>
  <array>
${stringArray(plan.programArguments)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
${plan.keepAlive ? relaySchedule : syncSchedule}
</dict>
</plist>
`;
}

export function renderOtelRelayPlist(plan: LaunchdPlan): string {
  return renderPlist({ ...plan, label: OTEL_RELAY_LABEL, keepAlive: true });
}

export function plistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function otelRelayPlistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${OTEL_RELAY_LABEL}.plist`);
}

/** 旧式安装路径下的两个后台任务；应用包方式使用包内 plist。 */
export function legacyAgents(home: string = homedir()): LegacyAgent[] {
  return [
    { path: plistPath(home), label: LAUNCHD_LABEL },
    { path: otelRelayPlistPath(home), label: OTEL_RELAY_LABEL },
  ];
}

export interface ServiceAgent {
  name: string;
  label: string;
  plistName: string;
  summary: string;
  render(): string;
}

/** 包内后台任务的完整清单；构建脚本按此写入 plist，安装与状态也按此遍历。 */
export const SERVICE_AGENTS: readonly ServiceAgent[] = [
  {
    name: "同步",
    label: SERVICE_LABEL,
    plistName: SERVICE_PLIST,
    summary: "每 60 秒运行一次 sync",
    render: renderServicePlist,
  },
  {
    name: "OTEL 中继",
    label: OTEL_RELAY_LABEL,
    plistName: OTEL_RELAY_PLIST,
    summary: "常驻接收 Claude Code 的 OTEL 日志",
    render: renderOtelRelayServicePlist,
  },
];

/** 构建应用包时写入包内 LaunchAgents 目录。 */
export function writeServicePlists(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return SERVICE_AGENTS.map((agent) => {
    writeFileSync(join(dir, agent.plistName), agent.render(), { mode: 0o644 });
    return agent.plistName;
  });
}

/**
 * 当前可执行文件所在的 Meterleaf.app。只有包内同时带注册助手与后台任务 plist 时
 * 才返回，否则回退到旧式 LaunchAgent。
 */
export function appBundleOf(
  execPath: string = process.execPath,
): string | null {
  let executable: string;
  try {
    executable = realpathSync(execPath);
  } catch {
    return null;
  }
  const macos = dirname(executable);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (basename(macos) !== "MacOS" || basename(contents) !== "Contents") {
    return null;
  }
  if (!bundle.endsWith(".app")) return null;
  const complete =
    existsSync(join(macos, SERVICE_HELPER)) &&
    SERVICE_AGENTS.every((agent) =>
      existsSync(join(contents, "Library", "LaunchAgents", agent.plistName)),
    );
  return complete ? bundle : null;
}

export type ServiceStatus =
  "enabled" | "requires-approval" | "not-registered" | "not-found" | "unknown";

function spawn(command: string[]): {
  ok: boolean;
  stdout: string;
  output: string;
} {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  return {
    ok: result.exitCode === 0,
    stdout,
    output: `${stdout}\n${result.stderr.toString()}`.trim(),
  };
}

function helper(
  bundle: string,
  action: "register" | "unregister" | "status",
  plistName: string = SERVICE_PLIST,
): { ok: boolean; status: ServiceStatus; output: string } {
  const result = spawn([
    join(bundle, "Contents", "MacOS", SERVICE_HELPER),
    action,
    plistName,
  ]);
  const last = result.stdout.split("\n").pop() ?? "";
  const known: ServiceStatus[] = [
    "enabled",
    "requires-approval",
    "not-registered",
    "not-found",
  ];
  return {
    ok: result.ok,
    status: known.includes(last as ServiceStatus)
      ? (last as ServiceStatus)
      : "unknown",
    output: result.output,
  };
}

export function serviceStatus(
  bundle: string,
  plistName: string = SERVICE_PLIST,
): ServiceStatus {
  return helper(bundle, "status", plistName).status;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function removeLegacy(agent: LegacyAgent, steps: string[]) {
  const stopped = spawn([
    "/bin/launchctl",
    "bootout",
    `${domain()}/${agent.label}`,
  ]);
  if (stopped.ok) steps.push(`已停止旧式后台任务 ${agent.label}`);
  if (existsSync(agent.path)) {
    rmSync(agent.path);
    steps.push(`已删除 ${agent.path}`);
  }
}

function requireDarwin(command: string) {
  if (process.platform !== "darwin") {
    throw new Error(`${command} 仅支持 macOS`);
  }
}

/**
 * 通过应用包注册两个后台任务（同步与 OTEL 中转），并清理旧式 LaunchAgent，
 * 保证同一时刻只有一种在运行。
 */
export function installService(
  bundle: string,
  legacy: readonly LegacyAgent[],
): string[] {
  requireDarwin("install-launchd");
  const steps: string[] = [];
  for (const agent of legacy) removeLegacy(agent, steps);
  // 已登记时先注销再注册，让系统按当前应用包重新登记。
  for (const agent of SERVICE_AGENTS) {
    if (serviceStatus(bundle, agent.plistName) !== "not-registered") {
      helper(bundle, "unregister", agent.plistName);
    }
  }
  for (const agent of SERVICE_AGENTS) {
    const result = helper(bundle, "register", agent.plistName);
    if (result.status === "requires-approval") {
      steps.push(
        `后台任务 ${agent.label} 已登记，等待批准: 请在「系统设置 → 通用 → 登录项与扩展」中打开 Meterleaf`,
      );
      continue;
    }
    if (!result.ok || result.status !== "enabled") {
      throw new Error(
        `注册后台任务 ${agent.label} 失败（${result.status}）: ${result.output}`,
      );
    }
    steps.push(`已注册后台任务 ${agent.label}，${agent.summary}`);
  }
  return steps;
}

export function installLaunchd(plans: readonly LaunchdPlan[]): string[] {
  requireDarwin("install-launchd");
  const steps: string[] = [];
  for (const plan of plans) {
    const label = plan.label ?? LAUNCHD_LABEL;
    mkdirSync(dirname(plan.plistPath), { recursive: true });
    if (existsSync(plan.plistPath)) {
      spawn(["/bin/launchctl", "bootout", `${domain()}/${label}`]);
      steps.push(`已停止旧的后台任务 ${label}`);
    }
    writeFileSync(plan.plistPath, renderPlist(plan), { mode: 0o644 });
    steps.push(`已写入 ${plan.plistPath}`);
    const loaded = spawn([
      "/bin/launchctl",
      "bootstrap",
      domain(),
      plan.plistPath,
    ]);
    if (!loaded.ok) {
      throw new Error(`launchctl bootstrap 失败: ${loaded.output}`);
    }
    steps.push(
      `已加载后台任务 ${label}，${
        plan.keepAlive ? "常驻运行" : "每 60 秒运行一次 sync"
      }`,
    );
  }
  return steps;
}

/** 两种形式都尝试停止，任何一种残留都会继续运行。 */
export function uninstallLaunchd(
  bundle: string | null,
  legacy: readonly LegacyAgent[],
): string[] {
  requireDarwin("uninstall-launchd");
  const steps: string[] = [];
  if (bundle) {
    for (const agent of SERVICE_AGENTS) {
      if (serviceStatus(bundle, agent.plistName) === "not-registered") continue;
      const result = helper(bundle, "unregister", agent.plistName);
      if (!result.ok) {
        throw new Error(`注销后台任务 ${agent.label} 失败: ${result.output}`);
      }
      steps.push(`已注销后台任务 ${agent.label}`);
    }
  }
  for (const agent of legacy) removeLegacy(agent, steps);
  if (steps.length === 0) steps.push("后台任务未安装");
  return steps;
}

const logLimitBytes = 1024 * 1024;

/** 追加一行日志；超过 1 MiB 时保留一份 .1 旧文件，避免后台任务无限增长。 */
export function appendLog(path: string, line: string) {
  try {
    if (statSync(path).size > logLimitBytes) renameSync(path, `${path}.1`);
  } catch {
    // 文件尚不存在
  }
  appendFileSync(path, `${line}\n`, { mode: 0o600 });
}
