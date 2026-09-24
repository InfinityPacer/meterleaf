import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export interface CollectorPaths {
  dataDir: string;
  configFile: string;
  stateFile: string;
  lockFile: string;
  logDir: string;
  claudeRoot: string;
  projectsDir: string;
  claudeJson: string;
}

type Env = Record<string, string | undefined>;

function defaultDataDir(env: Env, platform: NodeJS.Platform): string {
  const home = env.HOME || homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Meterleaf Collector");
  }
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(stateHome, "meterleaf-collector");
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

/**
 * 解析采集器自身数据目录与 Claude Code 只读来源。数据目录不能落在 Claude Code 目录内，
 * 也不能与 .claude.json 同级，避免在 Claude Code 管理的位置创建任何文件。
 */
export function resolvePaths(
  env: Env = process.env,
  options: { claudeJson?: string; platform?: NodeJS.Platform } = {},
): CollectorPaths {
  const home = env.HOME || homedir();
  const dataDir = resolve(
    env.METERLEAF_COLLECTOR_HOME ||
      defaultDataDir(env, options.platform ?? process.platform),
  );
  const claudeRoot = resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  const claudeJson = resolve(
    options.claudeJson ||
      env.METERLEAF_CLAUDE_JSON ||
      (env.CLAUDE_CONFIG_DIR
        ? join(claudeRoot, ".claude.json")
        : join(home, ".claude.json")),
  );
  if (isInside(claudeRoot, dataDir) || dataDir === dirname(claudeJson)) {
    throw new Error(
      `数据目录 ${dataDir} 位于 Claude Code 目录内或与 .claude.json 同级；请设置 METERLEAF_COLLECTOR_HOME 到其他位置`,
    );
  }
  return {
    dataDir,
    configFile: join(dataDir, "config.json"),
    stateFile: join(dataDir, "state.sqlite"),
    lockFile: join(dataDir, "sync.lock"),
    logDir: join(dataDir, "logs"),
    claudeRoot,
    projectsDir: join(claudeRoot, "projects"),
    claudeJson,
  };
}
