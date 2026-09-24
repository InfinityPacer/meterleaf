import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const LAUNCHD_LABEL = "io.meterleaf.collector";
export const BUNDLE_IDENTIFIER = "io.meterleaf.collector";

export interface LaunchdPlan {
  plistPath: string;
  programArguments: string[];
  logDir: string;
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
    return [executable, realpathSync(mainScript), "sync"];
  }
  return [executable, "sync"];
}

/**
 * 后台任务以低优先级运行：ProcessType Background、低优先级 IO 与 Nice 10，
 * 不与 Claude Code 争抢资源。AssociatedBundleIdentifiers 让系统“登录项与后台”
 * 显示 Meterleaf 的名称与图标。
 */
export function renderPlist(plan: LaunchdPlan): string {
  const environment = Object.entries(plan.environment)
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
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
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(plan.logDir, "collector.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(plan.logDir, "collector.err.log"))}</string>
</dict>
</plist>
`;
}

export function plistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function launchctl(args: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync(["/bin/launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export function installLaunchd(plan: LaunchdPlan): string[] {
  if (process.platform !== "darwin") {
    throw new Error("install-launchd 仅支持 macOS");
  }
  const steps: string[] = [];
  mkdirSync(plan.logDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(plan.plistPath, ".."), { recursive: true });
  if (existsSync(plan.plistPath)) {
    launchctl(["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
    steps.push("已停止旧的后台任务");
  }
  writeFileSync(plan.plistPath, renderPlist(plan), { mode: 0o644 });
  steps.push(`已写入 ${plan.plistPath}`);
  const loaded = launchctl(["bootstrap", domain(), plan.plistPath]);
  if (!loaded.ok) {
    throw new Error(`launchctl bootstrap 失败: ${loaded.output}`);
  }
  steps.push(`已加载后台任务 ${LAUNCHD_LABEL}，每 60 秒运行一次 sync`);
  return steps;
}

export function uninstallLaunchd(path: string): string[] {
  if (process.platform !== "darwin") {
    throw new Error("uninstall-launchd 仅支持 macOS");
  }
  const steps: string[] = [];
  const stopped = launchctl(["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
  steps.push(stopped.ok ? "已停止后台任务" : "后台任务未在运行");
  if (existsSync(path)) {
    rmSync(path);
    steps.push(`已删除 ${path}`);
  }
  return steps;
}
