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
/** 包内后台任务的标签，与旧式 LaunchAgent 不同名，避免系统沿用旧登记。 */
export const SERVICE_LABEL = "io.meterleaf.collector.sync";
export const SERVICE_PLIST = `${SERVICE_LABEL}.plist`;
export const SERVICE_HELPER = "meterleaf-service";
/** 旧式 LaunchAgent，只在无法使用应用包注册时安装。 */
export const LAUNCHD_LABEL = "io.meterleaf.collector";

/** 后台运行时自己写日志，包内 plist 无法写入按用户展开的日志路径。 */
export const LOG_FLAG = "--log";

export interface LaunchdPlan {
  plistPath: string;
  programArguments: string[];
  environment: Record<string, string>;
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
 * 定时运行 sync 的程序参数。编译后的可执行文件（含 Meterleaf.app 内的
 * Contents/MacOS/meterleaf-collector）直接运行；用 bun 运行源码时带上入口脚本。
 */
export function syncProgramArguments(
  execPath: string = process.execPath,
  mainScript: string = Bun.main,
): string[] {
  const executable = realpathSync(execPath);
  const name = basename(executable);
  if (
    (name === "bun" || name === "bun.exe") &&
    !mainScript.startsWith("/$bunfs/")
  ) {
    return [executable, realpathSync(mainScript), "sync", LOG_FLAG];
  }
  return [executable, "sync", LOG_FLAG];
}

/**
 * 两种后台任务共用的调度：每 60 秒一次，ProcessType Background、低优先级 IO
 * 与 Nice 10，不与 Claude Code 争抢资源。
 */
const schedule = `  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>`;

const plistHeader = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">`;

/**
 * 打包在 Meterleaf.app/Contents/Library/LaunchAgents 内的 plist。BundleProgram 相对
 * 应用包解析，因此应用移动后仍然有效；内容固定，不能携带环境变量。
 */
export function renderServicePlist(): string {
  return `${plistHeader}
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${BUNDLE_IDENTIFIER}</string>
  </array>
  <key>BundleProgram</key>
  <string>Contents/MacOS/meterleaf-collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>meterleaf-collector</string>
    <string>sync</string>
    <string>${LOG_FLAG}</string>
  </array>
${schedule}
</dict>
</plist>
`;
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
  <string>${LAUNCHD_LABEL}</string>
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
${schedule}
</dict>
</plist>
`;
}

export function plistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
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
    existsSync(join(contents, "Library", "LaunchAgents", SERVICE_PLIST));
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
): { ok: boolean; status: ServiceStatus; output: string } {
  const result = spawn([
    join(bundle, "Contents", "MacOS", SERVICE_HELPER),
    SERVICE_PLIST,
    action,
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

export function serviceStatus(bundle: string): ServiceStatus {
  return helper(bundle, "status").status;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function removeLegacy(path: string, steps: string[]) {
  const stopped = spawn([
    "/bin/launchctl",
    "bootout",
    `${domain()}/${LAUNCHD_LABEL}`,
  ]);
  if (stopped.ok) steps.push("已停止旧式后台任务");
  if (existsSync(path)) {
    rmSync(path);
    steps.push(`已删除 ${path}`);
  }
}

function requireDarwin(command: string) {
  if (process.platform !== "darwin") {
    throw new Error(`${command} 仅支持 macOS`);
  }
}

/** 通过应用包注册后台任务，并清理旧式 LaunchAgent，保证同一时刻只有一种在运行。 */
export function installService(bundle: string, legacyPath: string): string[] {
  requireDarwin("install-launchd");
  const steps: string[] = [];
  removeLegacy(legacyPath, steps);
  const result = helper(bundle, "register");
  if (result.status === "requires-approval") {
    steps.push(
      "后台任务已登记，等待批准: 请在「系统设置 → 通用 → 登录项与扩展」中打开 Meterleaf",
    );
    return steps;
  }
  if (!result.ok || result.status !== "enabled") {
    throw new Error(`注册后台任务失败（${result.status}）: ${result.output}`);
  }
  steps.push(`已注册后台任务 ${SERVICE_LABEL}，每 60 秒运行一次 sync`);
  return steps;
}

export function installLaunchd(plan: LaunchdPlan): string[] {
  requireDarwin("install-launchd");
  const steps: string[] = [];
  mkdirSync(dirname(plan.plistPath), { recursive: true });
  if (existsSync(plan.plistPath)) {
    spawn(["/bin/launchctl", "bootout", `${domain()}/${LAUNCHD_LABEL}`]);
    steps.push("已停止旧的后台任务");
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
  steps.push(`已加载后台任务 ${LAUNCHD_LABEL}，每 60 秒运行一次 sync`);
  return steps;
}

/** 两种形式都尝试停止，任何一种残留都会继续定时运行。 */
export function uninstallLaunchd(
  bundle: string | null,
  legacyPath: string,
): string[] {
  requireDarwin("uninstall-launchd");
  const steps: string[] = [];
  if (bundle && serviceStatus(bundle) !== "not-registered") {
    const result = helper(bundle, "unregister");
    if (!result.ok) {
      throw new Error(`注销后台任务失败: ${result.output}`);
    }
    steps.push(`已注销后台任务 ${SERVICE_LABEL}`);
  }
  removeLegacy(legacyPath, steps);
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
