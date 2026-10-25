import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CollectorPaths } from "./paths";
import type { CollectorState } from "./state";

/**
 * 额外任务：用户登记的本机命令，由 sync 在同一把运行锁里按间隔顺序执行。
 * 采集器只负责调度、限时和记录结果；任务做什么由登记它的人负责，
 * 不在采集器对 Claude Code 的只读保证之内。
 */
export const taskSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    /** 第一项是可执行文件的绝对路径，其余原样作为参数，不经过 shell。 */
    command: z.array(z.string().min(1)).min(1).max(50),
    everyMinutes: z.number().int().min(1).max(1440),
    timeoutSeconds: z.number().int().min(1).max(600),
  })
  .strict()
  .refine((task) => task.command?.[0]?.startsWith("/") ?? false, {
    message: "命令必须以可执行文件的绝对路径开头",
  });

export type CollectorTask = z.infer<typeof taskSchema>;

export const DEFAULT_TASK_EVERY_MINUTES = 10;
export const DEFAULT_TASK_TIMEOUT_SECONDS = 60;

/** 日志只保留输出末尾，避免任务刷屏撑大采集器日志。 */
const outputLimit = 4000;

/**
 * 后台任务每 60 秒启动一次，启动时刻有几秒抖动；留出余量，
 * 否则 10 分钟的任务会被推迟到第 11 分钟。
 */
const scheduleSlackMs = 5000;

export interface TaskResult {
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  output: string;
}

const lastRunKey = (name: string) => `task:${name}:last_run_at`;
const lastResultKey = (name: string) => `task:${name}:last_result`;

export function isTaskDue(
  task: CollectorTask,
  lastRunAt: string | null,
  now: Date,
): boolean {
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (Number.isNaN(last) || last > now.getTime()) return true;
  return now.getTime() - last >= task.everyMinutes * 60_000 - scheduleSlackMs;
}

export function checkExecutable(path: string): string | null {
  try {
    accessSync(path, constants.X_OK);
    return null;
  } catch {
    return `找不到可执行文件或没有执行权限: ${path}`;
  }
}

export function taskStateDir(paths: CollectorPaths, name: string): string {
  return join(paths.dataDir, "tasks", name);
}

/**
 * 任务拿到的环境：沿用采集器自身的环境，另外告诉它自己的名字、可写的状态目录，
 * 以及采集器已知的全部 Claude 配置目录（默认目录在前，每行一个）。
 */
function taskEnvironment(
  paths: CollectorPaths,
  task: CollectorTask,
  claudeConfigDirs: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const stateDir = taskStateDir(paths, task.name);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  env.METERLEAF_TASK_NAME = task.name;
  env.METERLEAF_TASK_STATE_DIR = stateDir;
  env.METERLEAF_CLAUDE_CONFIG_DIRS = claudeConfigDirs.join("\n");
  return env;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > outputLimit
    ? `…${trimmed.slice(-outputLimit)}`
    : trimmed;
}

export async function runTask(
  paths: CollectorPaths,
  task: CollectorTask,
  claudeConfigDirs: string[],
  now: () => Date = () => new Date(),
): Promise<TaskResult> {
  const started = now();
  const base = { startedAt: started.toISOString(), timedOut: false };
  const missing = checkExecutable(task.command[0]!);
  if (missing) {
    return {
      ...base,
      durationMs: 0,
      exitCode: null,
      error: missing,
      output: "",
    };
  }
  const outputPath = taskOutputPath(paths, task.name);
  let outputFd: number | null = null;
  try {
    const env = taskEnvironment(paths, task, claudeConfigDirs);
    // 输出写进文件而不是管道：任务留下的子进程即使脱离进程组、一直占着输出，
    // 也不会让 sync 等它们，限时才真正限制得住 sync 持锁的时间。
    outputFd = openSync(outputPath, "w", 0o600);
    const child = Bun.spawn(task.command, {
      cwd: taskStateDir(paths, task.name),
      env,
      stdin: "ignore",
      stdout: outputFd,
      stderr: outputFd,
      // 独立进程组：结束时可以连同任务启动的子进程一起终止。
      detached: true,
    });
    closeSync(outputFd);
    outputFd = null;
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 进程组已全部退出。
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), task.timeoutSeconds * 1000);
    });
    // 只有限时到了任务本身还没退出才算超时；自己正常退出的任务保留真实退出码。
    const outcome = await Promise.race([child.exited, deadline]);
    clearTimeout(timer);
    const timedOut = outcome === "timeout";
    // 任务结束后，它留在同一进程组里的子进程一起结束，不在后台越积越多。
    killGroup();
    if (timedOut) {
      await Promise.race([child.exited, Bun.sleep(2000)]);
    }
    return {
      ...base,
      durationMs: now().getTime() - started.getTime(),
      exitCode: timedOut ? null : (outcome as number),
      timedOut,
      output: tail(readOutput(outputPath)),
    };
  } catch (error) {
    if (outputFd !== null) closeSync(outputFd);
    return {
      ...base,
      durationMs: now().getTime() - started.getTime(),
      exitCode: null,
      error: error instanceof Error ? error.message : String(error),
      output: "",
    };
  }
}

/** 任务输出放在任务自己的状态目录之外，不与任务保存的文件混在一起。 */
function taskOutputPath(paths: CollectorPaths, name: string): string {
  return join(paths.dataDir, "tasks", `${name}.output`);
}

function readOutput(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function taskSucceeded(result: TaskResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.error;
}

export function describeResult(result: TaskResult): string {
  if (result.error) return `未能启动（${result.error}）`;
  if (result.timedOut) return `超时，已终止（运行 ${result.durationMs} ms）`;
  return result.exitCode === 0
    ? `成功（${result.durationMs} ms）`
    : `失败，退出码 ${result.exitCode}（${result.durationMs} ms）`;
}

export function recordTaskResult(
  state: CollectorState,
  name: string,
  result: TaskResult,
) {
  state.setMeta(lastRunKey(name), result.startedAt);
  const { output: _output, ...summary } = result;
  state.setMeta(lastResultKey(name), JSON.stringify(summary));
}

export function lastTaskResult(
  state: CollectorState,
  name: string,
): Omit<TaskResult, "output"> | null {
  const raw = state.getMeta(lastResultKey(name));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Omit<TaskResult, "output">;
  } catch {
    return null;
  }
}

/**
 * sync 收尾时调用：按登记顺序逐个运行到期任务。单个任务失败或超时只记日志，
 * 不影响其他任务，也不改变这一轮同步的结果。
 */
export async function runDueTasks(
  state: CollectorState,
  paths: CollectorPaths,
  tasks: CollectorTask[],
  claudeConfigDirs: string[],
  now: () => Date = () => new Date(),
) {
  for (const task of tasks) {
    if (!isTaskDue(task, state.getMeta(lastRunKey(task.name)) ?? null, now()))
      continue;
    const result = await runTask(paths, task, claudeConfigDirs, now);
    recordTaskResult(state, task.name, result);
    const line = `${result.startedAt} 任务 ${task.name}: ${describeResult(result)}`;
    const output = result.output ? `\n${result.output}` : "";
    if (taskSucceeded(result)) {
      // 成功且没有输出的轮次不写日志，任务每几分钟跑一次也不会把日志撑大。
      if (output) console.log(line + output);
    } else {
      console.error(line + output);
    }
  }
}
