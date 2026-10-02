import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { sourceIdSchema } from "../shared/ingest";
import { CodexCollector } from "./codex";
import {
  generateKey,
  keyDigest,
  loadConfig,
  normalizeServer,
  saveConfig,
} from "./config";
import { acquireLock } from "./lock";
import {
  appendLog,
  LAUNCHD_LABEL,
  renderPlist,
  syncProgramArguments,
} from "./launchd";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    server: { type: "string" },
    "source-id": { type: "string" },
    log: { type: "boolean" },
  },
});
const root = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
const home = resolve(
  process.env.METERLEAF_CODEX_HOME ||
    join(
      homedir(),
      "Library",
      "Application Support",
      "Meterleaf Codex Collector",
    ),
);
const relativeHome = relative(root, home);
if (
  !relativeHome ||
  (!relativeHome.startsWith("..") && !isAbsolute(relativeHome))
) {
  throw new Error("采集器数据目录不能位于 Codex 目录内");
}
const configFile = join(home, "config.json");
const command = positionals[0];
const label = "io.meterleaf.collector.codex";
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
function output(text: string) {
  if (values.log) {
    mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
    appendLog(
      join(home, "logs", "sync.log"),
      `${new Date().toISOString()} ${text}`,
    );
  } else console.log(text);
}

async function main() {
  process.umask(0o077);
  if (command === "init") {
    if (!values.server) throw new Error("需要 --server 服务地址");
    const config = {
      server: normalizeServer(values.server),
      sourceId: sourceIdSchema.parse(values["source-id"] || "codex-local"),
      key: generateKey(),
      createdAt: new Date().toISOString(),
    };
    saveConfig(home, configFile, config, false);
    console.log(
      `METERLEAF_INGEST_KEYS=${config.sourceId}:${keyDigest(config.key)}`,
    );
    return;
  }
  if (command === "uninstall-launchd") {
    if (process.platform !== "darwin") throw new Error("后台任务仅支持 macOS");
    Bun.spawnSync(
      ["launchctl", "bootout", `gui/${process.getuid!()}/${label}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (existsSync(plist)) rmSync(plist);
    console.log("已停止 Codex 本地采集器后台任务");
    return;
  }
  if (!["sync", "status", "install-launchd"].includes(command ?? "")) {
    console.log(
      "meterleaf-codex-collector init --server URL [--source-id codex-local]\nmeterleaf-codex-collector sync\nmeterleaf-codex-collector status\nmeterleaf-codex-collector install-launchd\nmeterleaf-codex-collector uninstall-launchd",
    );
    return;
  }
  const config = loadConfig(configFile);
  if (!config) throw new Error("请先运行 init");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (command === "install-launchd") {
    if (process.platform !== "darwin") throw new Error("后台任务仅支持 macOS");
    const domain = `gui/${process.getuid!()}`;
    Bun.spawnSync(["launchctl", "bootout", `${domain}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      plist,
      renderPlist({
        plistPath: plist,
        programArguments: syncProgramArguments(),
        environment: {
          CODEX_HOME: root,
          METERLEAF_CODEX_HOME: home,
        },
      }).replaceAll(LAUNCHD_LABEL, label),
      { mode: 0o644 },
    );
    const result = Bun.spawnSync(["launchctl", "bootstrap", domain, plist], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0)
      throw new Error("后台任务加载失败，请检查 launchctl 状态");
    console.log("Codex 本地采集器已启用，每分钟低优先级同步，首次历史分批补采");
    return;
  }
  const lock = acquireLock(join(home, "sync.lock"));
  if (!lock) {
    output("同步已在运行");
    return;
  }
  const collector = new CodexCollector(join(home, "state.sqlite"));
  try {
    if (command === "sync") {
      output(JSON.stringify({ scan: await collector.scan(root) }));
      output(JSON.stringify({ sent: await collector.push(config) }));
    }
    output(JSON.stringify(collector.status()));
  } finally {
    collector.db.close();
    lock();
  }
}

main().catch((error: unknown) => {
  output(error instanceof Error ? error.message : "同步失败");
  process.exitCode = 1;
});
