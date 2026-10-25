#!/usr/bin/env bun
/**
 * 让 Paseo 里与你对话过的 Claude Code 会话出现在 `claude --resume` 的会话列表里。
 *
 * Paseo 以无界面模式启动 Claude Code，会话记录的每一行都标着 "entrypoint":"sdk-cli"。
 * Claude Code 的会话列表只看文件前 64 KiB 里第一次出现的 entrypoint，是 sdk-cli、
 * sdk-ts 或 sdk-py 就不列出，但仍可以用会话 ID 直接恢复。本脚本把开头这一段里的
 * 这些值改成 "cli"，并在值后补空格保持字节数不变。
 *
 * 只处理同时满足下列条件的会话：被某个 Paseo 代理记录为它恢复的 Claude 会话；
 * 记录里至少有一条你直接发出的消息（子代理只收到其他代理转来的任务，不处理）；
 * 没有正在运行的 Claude Code 进程登记这个会话。
 *
 * 写入方式是原地覆盖等长字节：文件身份与长度不变，Claude Code 只在文件末尾追加，
 * 不会与这里的写入重叠；Meterleaf 采集器按文件身份与已读位置之前的字节续读，
 * 也不会因此重读。每处修改记在任务状态目录的 changes.jsonl，`--revert` 按它改回。
 *
 * 用法: bun scripts/claude-resume-visibility.ts [--dry-run | --revert]
 * 作为采集器额外任务运行时，从环境读取 METERLEAF_CLAUDE_CONFIG_DIRS 与
 * METERLEAF_TASK_STATE_DIR；单独运行时使用 CLAUDE_CONFIG_DIR 与 ~/.claude。
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code 读取会话列表摘要时读入的文件开头字节数。 */
const HEAD_BYTES = 65536;
const PROGRAMMATIC = ["sdk-cli", "sdk-ts", "sdk-py"];

type Env = Record<string, string | undefined>;

export interface Change {
  at: string;
  path: string;
  offset: number;
  from: string;
  to: string;
}

export interface Report {
  revealed: string[];
  skippedLive: string[];
  notEligible: number;
  changes: Change[];
}

interface CheckedEntry {
  size: number;
  mtimeMs: number;
}

function configDirs(env: Env): string[] {
  const listed = (env.METERLEAF_CLAUDE_CONFIG_DIRS ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (listed.length) return listed;
  // 单独运行时当前 shell 可能指向某个额外账户，默认目录里的运行登记也要算上。
  const fallback = join(env.HOME || homedir(), ".claude");
  return [...new Set([env.CLAUDE_CONFIG_DIR || fallback, fallback])];
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
      "resume-visibility",
    )
  );
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Claude Code 在每个配置目录的 sessions 下登记正在运行的进程与它的会话。 */
function liveSessions(dirs: string[]): Set<string> {
  const live = new Set<string>();
  for (const dir of dirs) {
    const sessions = join(dir, "sessions");
    if (!existsSync(sessions)) continue;
    for (const name of readdirSync(sessions)) {
      if (!name.endsWith(".json")) continue;
      const record = readJson(join(sessions, name)) as {
        pid?: unknown;
        sessionId?: unknown;
      } | null;
      const pid = Number(record?.pid);
      if (
        typeof record?.sessionId === "string" &&
        Number.isInteger(pid) &&
        pid > 0 &&
        alive(pid)
      )
        live.add(record.sessionId);
    }
  }
  return live;
}

/** Paseo 每个代理一个 JSON；persistence.sessionId 是它恢复的会话。 */
function paseoClaudeSessions(paseoHome: string): Set<string> {
  const ids = new Set<string>();
  const agents = join(paseoHome, "agents");
  if (!existsSync(agents)) return ids;
  for (const workspace of readdirSync(agents, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const dir = join(agents, workspace.name);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const record = readJson(join(dir, name)) as {
        provider?: unknown;
        persistence?: { provider?: unknown; sessionId?: unknown };
      } | null;
      const provider = String(
        record?.persistence?.provider ?? record?.provider ?? "",
      );
      const sessionId = record?.persistence?.sessionId;
      if (provider.startsWith("claude") && typeof sessionId === "string")
        ids.add(sessionId);
    }
  }
  return ids;
}

/** 各配置目录的 projects 常软链接到同一处，按真实路径去重。 */
function transcriptIndex(dirs: string[]): Map<string, string> {
  const index = new Map<string, string>();
  const seen = new Set<string>();
  for (const dir of dirs) {
    let projects: string;
    try {
      projects = realpathSync(join(dir, "projects"));
    } catch {
      continue;
    }
    if (seen.has(projects)) continue;
    seen.add(projects);
    for (const project of readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectDir = join(projects, project.name);
      for (const name of readdirSync(projectDir)) {
        if (name.endsWith(".jsonl") && !index.has(name.slice(0, -6)))
          index.set(name.slice(0, -6), join(projectDir, name));
      }
    }
  }
  return index;
}

function readHead(fd: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, filled);
    if (read <= 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/**
 * 找出开头一段里需要改写的位置。与 Claude Code 一致，只认紧凑写法和冒号后带一个
 * 空格的写法。对话正文里的引号都被转义，同样的文字出现在正文里不会匹配。
 */
export function findProgrammaticEntrypoints(
  head: Buffer,
): { offset: number; from: string; to: string }[] {
  const found: { offset: number; from: string; to: string }[] = [];
  for (const prefix of ['"entrypoint":"', '"entrypoint": "']) {
    for (const value of PROGRAMMATIC) {
      const from = `${prefix}${value}"`;
      const to = `${prefix}cli"`.padEnd(from.length, " ");
      const needle = Buffer.from(from);
      let at = head.indexOf(needle);
      while (at >= 0) {
        if (at < HEAD_BYTES) found.push({ offset: at, from, to });
        at = head.indexOf(needle, at + 1);
      }
    }
  }
  return found.sort((a, b) => a.offset - b.offset);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join(" ");
}

/**
 * 是否有你直接发出的消息。其他代理转来的任务、命令输出和注入的上下文都以
 * 尖括号标签开头，不算；侧链是子代理自己的记录，上下文压缩摘要和中断提示
 * 由 Claude Code 生成，也不算。
 */
export function hasHumanMessage(path: string): boolean {
  const text = readFileSync(path, "utf8");
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line.includes('"type":"user"')) continue;
    let record: {
      type?: unknown;
      isMeta?: unknown;
      isSidechain?: unknown;
      isCompactSummary?: unknown;
      isVisibleInTranscriptOnly?: unknown;
      message?: { content?: unknown };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      record.type !== "user" ||
      record.isMeta ||
      record.isSidechain ||
      record.isCompactSummary ||
      record.isVisibleInTranscriptOnly
    )
      continue;
    const body = messageText(record.message?.content).trim();
    if (
      body &&
      !body.startsWith("<") &&
      !body.startsWith("[Request interrupted")
    )
      return true;
  }
  return false;
}

function loadChecked(path: string): Record<string, CheckedEntry> {
  const raw = readJson(path);
  return raw && typeof raw === "object"
    ? (raw as Record<string, CheckedEntry>)
    : {};
}

function saveJson(path: string, value: unknown) {
  const pending = `${path}.tmp`;
  writeFileSync(pending, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(pending, path);
}

/** 原地写入前再确认一次原字节仍在，避免覆盖期间被改动的内容。 */
function rewrite(fd: number, offset: number, from: string, to: string) {
  const expected = Buffer.from(from);
  const current = Buffer.alloc(expected.length);
  readSync(fd, current, 0, expected.length, offset);
  if (!current.equals(expected)) return false;
  const replacement = Buffer.from(to);
  if (replacement.length !== expected.length) return false;
  writeSync(fd, replacement, 0, replacement.length, offset);
  return true;
}

export function reveal(
  env: Env = process.env,
  options: { dryRun?: boolean; now?: () => Date } = {},
): Report {
  const now = options.now ?? (() => new Date());
  const dirs = configDirs(env);
  const state = stateDir(env);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const checkedPath = join(state, "checked.json");
  const checked = loadChecked(checkedPath);
  const live = liveSessions(dirs);
  const index = transcriptIndex(dirs);
  const report: Report = {
    revealed: [],
    skippedLive: [],
    notEligible: 0,
    changes: [],
  };
  for (const sessionId of paseoClaudeSessions(
    env.PASEO_HOME || join(env.HOME || homedir(), ".paseo"),
  )) {
    const path = index.get(sessionId);
    if (!path) continue;
    let fd: number;
    try {
      fd = openSync(path, options.dryRun ? "r" : "r+");
    } catch {
      continue;
    }
    try {
      const stat = fstatSync(fd);
      const targets = findProgrammaticEntrypoints(
        readHead(fd, Math.min(stat.size, HEAD_BYTES + 32)),
      );
      if (targets.length === 0) continue;
      if (live.has(sessionId)) {
        report.skippedLive.push(sessionId);
        continue;
      }
      // 不符合条件的会话只在文件变化后重新判断，避免每轮都通读大文件。
      const previous = checked[path];
      if (
        previous &&
        previous.size === stat.size &&
        previous.mtimeMs === stat.mtimeMs
      ) {
        report.notEligible += 1;
        continue;
      }
      if (!hasHumanMessage(path)) {
        checked[path] = { size: stat.size, mtimeMs: stat.mtimeMs };
        report.notEligible += 1;
        continue;
      }
      const at = now().toISOString();
      const applied: Change[] = [];
      for (const target of targets) {
        if (
          options.dryRun ||
          rewrite(fd, target.offset, target.from, target.to)
        )
          applied.push({ at, path, ...target });
      }
      if (applied.length === 0) continue;
      delete checked[path];
      report.revealed.push(sessionId);
      report.changes.push(...applied);
    } finally {
      closeSync(fd);
    }
  }
  if (!options.dryRun) {
    for (const change of report.changes)
      appendFileSync(
        join(state, "changes.jsonl"),
        `${JSON.stringify(change)}\n`,
        {
          mode: 0o600,
        },
      );
    saveJson(checkedPath, checked);
  }
  return report;
}

/** 按修改记录逐处改回；当前字节已不是当初写入的内容时跳过该处。 */
export function revert(env: Env = process.env): {
  reverted: number;
  skipped: number;
} {
  const state = stateDir(env);
  const log = join(state, "changes.jsonl");
  if (!existsSync(log)) return { reverted: 0, skipped: 0 };
  let reverted = 0;
  let skipped = 0;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let change: Change;
    try {
      change = JSON.parse(line) as Change;
    } catch {
      skipped += 1;
      continue;
    }
    let fd: number;
    try {
      fd = openSync(change.path, "r+");
    } catch {
      skipped += 1;
      continue;
    }
    try {
      if (rewrite(fd, change.offset, change.to, change.from)) reverted += 1;
      else skipped += 1;
    } finally {
      closeSync(fd);
    }
  }
  renameSync(log, join(state, `changes.reverted-${Date.now()}.jsonl`));
  return { reverted, skipped };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter(
    (arg) => arg !== "--dry-run" && arg !== "--revert",
  );
  if (unknown.length || args.length > 1) {
    console.error(
      "用法: bun scripts/claude-resume-visibility.ts [--dry-run | --revert]",
    );
    process.exit(2);
  }
  if (args[0] === "--revert") {
    const result = revert();
    console.log(`已改回 ${result.reverted} 处，跳过 ${result.skipped} 处。`);
    process.exit(0);
  }
  const dryRun = args[0] === "--dry-run";
  const report = reveal(process.env, { dryRun });
  const short = (ids: string[]) => ids.map((id) => id.slice(0, 8)).join("，");
  if (report.revealed.length)
    console.log(
      `${dryRun ? "将显示" : "已显示"} ${report.revealed.length} 个会话: ${short(report.revealed)}`,
    );
  if (dryRun && report.skippedLive.length)
    console.log(
      `正在运行，暂不处理 ${report.skippedLive.length} 个: ${short(report.skippedLive)}`,
    );
  if (dryRun) console.log(`不符合条件 ${report.notEligible} 个。`);
}
