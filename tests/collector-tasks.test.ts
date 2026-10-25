import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTaskDue,
  taskSchema,
  type CollectorTask,
} from "../src/collector/tasks";

const repoRoot = join(import.meta.dir, "..");
const fixtureProjects = join(import.meta.dir, "fixtures/claude-code/projects");
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-collector-tasks-"));
  const claudeDir = join(root, "claude");
  const home = join(root, "home");
  mkdirSync(join(claudeDir, "projects"), { recursive: true });
  mkdirSync(home);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    METERLEAF_COLLECTOR_HOME: join(root, "data"),
  };
  return { root, claudeDir, env, dataDir: env.METERLEAF_COLLECTOR_HOME };
}

function script(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function run(env: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, join(repoRoot, "src/collector/main.ts"), ...args],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function config(dataDir: string) {
  return JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
    tasks?: CollectorTask[];
    claudeProfiles?: unknown;
  };
}

describe("额外任务的调度间隔", () => {
  const task: CollectorTask = {
    name: "demo",
    command: ["/bin/true"],
    everyMinutes: 10,
    timeoutSeconds: 60,
  };
  const now = new Date("2026-10-25T12:00:00Z");

  test("从未运行或记录无效时立即运行", () => {
    expect(isTaskDue(task, null, now)).toBe(true);
    expect(isTaskDue(task, "坏数据", now)).toBe(true);
  });

  test("未到间隔不运行，后台任务启动的几秒抖动不推迟一轮", () => {
    expect(isTaskDue(task, "2026-10-25T11:51:00Z", now)).toBe(false);
    expect(isTaskDue(task, "2026-10-25T11:50:03Z", now)).toBe(true);
  });

  test("手改配置写出空命令或非数组时按格式无效处理，不抛异常", () => {
    for (const command of [[], "/bin/true", undefined])
      expect(taskSchema.safeParse({ ...task, command }).success).toBe(false);
  });

  test("系统时间回拨后不会一直等下去", () => {
    expect(isTaskDue(task, "2026-10-25T13:00:00Z", now)).toBe(true);
  });
});

describe("采集器额外任务", () => {
  test("登记后由 sync 运行，推送失败也照常运行，并拿到状态目录和 Claude 配置目录", async () => {
    const { root, claudeDir, env, dataDir } = setup();
    // 有待推送的用量而服务端不可达：本轮同步失败，任务仍然运行。
    cpSync(fixtureProjects, join(claudeDir, "projects"), { recursive: true });
    expect(
      (await run(env, "init", "--server", "http://127.0.0.1:9")).code,
    ).toBe(0);
    const profile = join(root, "profile-b");
    mkdirSync(profile);
    expect((await run(env, "claude-profiles", profile)).code).toBe(0);
    const out = join(root, "env.txt");
    const task = script(
      root,
      "task.sh",
      `printf '%s|%s|%s|%s\\n' "$METERLEAF_TASK_NAME" "$METERLEAF_TASK_STATE_DIR" "$(pwd)" "$1" >> "${out}"
printf '%s' "$METERLEAF_CLAUDE_CONFIG_DIRS" > "${out}.dirs"`,
    );
    const added = await run(
      env,
      "tasks",
      "add",
      "demo",
      "--every",
      "5",
      "--",
      task,
      "--flag",
    );
    expect(added.code).toBe(0);
    expect(config(dataDir).tasks).toEqual([
      {
        name: "demo",
        command: [task, "--flag"],
        everyMinutes: 5,
        timeoutSeconds: 60,
      },
    ]);

    const first = await run(env, "sync");
    expect(first.code).toBe(1);
    const stateDir = join(dataDir, "tasks", "demo");
    const realState = realpathSync(stateDir);
    expect(readFileSync(out, "utf8").trim()).toBe(
      `demo|${stateDir}|${realState}|--flag`,
    );
    expect(readFileSync(`${out}.dirs`, "utf8")).toBe(
      `${claudeDir}\n${profile}`,
    );

    // 间隔未到，第二轮 sync 不再运行。
    await run(env, "sync");
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(1);

    const listed = await run(env, "tasks");
    expect(listed.stdout).toContain("demo: 每 5 分钟，限时 60 秒");
    expect(listed.stdout).toContain("成功");
    expect((await run(env, "status")).stdout).toContain(
      "额外任务: demo（每 5 分钟）",
    );
  });

  test("超时连同任务启动的子进程一起终止，结果记为超时，不拖住 sync", async () => {
    const { root, env, dataDir } = setup();
    await run(env, "init", "--server", "http://127.0.0.1:9");
    const marker = join(root, "survived");
    // 子 shell 在后台继续持有输出管道；只终止父进程时 sync 会等它结束。
    const task = script(
      root,
      "slow.sh",
      `(sleep 5; touch "${marker}") &\nsleep 5`,
    );
    await run(env, "tasks", "add", "slow", "--timeout", "1", "--", task);
    const started = Date.now();
    const result = await run(env, "sync", "--log");
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.code).toBe(0);
    expect(
      readFileSync(join(dataDir, "logs", "collector.err.log"), "utf8"),
    ).toContain("任务 slow: 超时，已终止");
    await Bun.sleep(5500);
    expect(() => readFileSync(marker)).toThrow();
  }, 15000);

  test("任务自己正常退出时保留退出码，留在进程组里的子进程一起结束", async () => {
    const { root, env } = setup();
    await run(env, "init", "--server", "http://127.0.0.1:9");
    const marker = join(root, "survived");
    const task = script(
      root,
      "quick.sh",
      `(sleep 3; touch "${marker}") &\necho 完成`,
    );
    await run(env, "tasks", "add", "quick", "--timeout", "5", "--", task);
    const started = Date.now();
    const result = await run(env, "tasks", "run", "quick");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("完成");
    expect(result.stdout).toContain("任务 quick: 成功");
    await Bun.sleep(3500);
    expect(() => readFileSync(marker)).toThrow();
  }, 15000);

  test("脱离进程组、一直占着输出的子进程不会拖住 sync", async () => {
    const { root, env, dataDir } = setup();
    await run(env, "init", "--server", "http://127.0.0.1:9");
    // perl 在新会话里继续持有标准输出 8 秒，进程组终止不到它。
    const task = script(
      root,
      "escape.sh",
      `perl -MPOSIX -e 'if (fork() == 0) { POSIX::setsid(); sleep 8; exit 0 }'\nsleep 30`,
    );
    await run(env, "tasks", "add", "escape", "--timeout", "1", "--", task);
    const started = Date.now();
    await run(env, "sync", "--log");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(
      readFileSync(join(dataDir, "logs", "collector.err.log"), "utf8"),
    ).toContain("任务 escape: 超时，已终止");
  }, 15000);

  test("任务失败只记日志，不影响后面的任务", async () => {
    const { root, env, dataDir } = setup();
    await run(env, "init", "--server", "http://127.0.0.1:9");
    const ran = join(root, "second-ran");
    await run(
      env,
      "tasks",
      "add",
      "broken",
      "--",
      script(root, "broken.sh", "echo 出错了 >&2; exit 3"),
    );
    await run(
      env,
      "tasks",
      "add",
      "second",
      "--",
      script(root, "second.sh", `touch "${ran}"`),
    );
    await run(env, "sync", "--log");
    expect(readFileSync(ran)).toBeDefined();
    const errors = readFileSync(
      join(dataDir, "logs", "collector.err.log"),
      "utf8",
    );
    expect(errors).toContain("任务 broken: 失败，退出码 3");
    expect(errors).toContain("出错了");
  });

  test("tasks run 立即运行并显示输出，后台同步持锁时拒绝", async () => {
    const { root, env, dataDir } = setup();
    await run(env, "init", "--server", "http://127.0.0.1:9");
    await run(
      env,
      "tasks",
      "add",
      "hello",
      "--",
      script(root, "hello.sh", "echo 你好"),
    );
    const now = await run(env, "tasks", "run", "hello");
    expect(now.code).toBe(0);
    expect(now.stdout).toContain("你好");
    expect(now.stdout).toContain("任务 hello: 成功");

    writeFileSync(join(dataDir, "sync.lock"), `${process.pid}\n`);
    const locked = await run(env, "tasks", "run", "hello");
    expect(locked.code).toBe(1);
    expect(locked.stderr).toContain("后台同步正在运行");
  });

  test("拒绝相对路径、不可执行文件、重名和无效间隔；remove 只删登记", async () => {
    const { root, env, dataDir } = setup();
    await run(env, "init", "--server", "http://127.0.0.1:9");
    const task = script(root, "ok.sh", "true");
    const plain = join(root, "plain.txt");
    writeFileSync(plain, "");

    expect((await run(env, "tasks", "add", "a", "--", "ok.sh")).code).toBe(2);
    expect((await run(env, "tasks", "add", "a", "--", plain)).code).toBe(2);
    expect((await run(env, "tasks", "add", "a", task)).code).toBe(2);
    expect(
      (await run(env, "tasks", "add", "A_b", "--", task)).stderr,
    ).toContain("名称只能用小写字母");
    expect(
      (await run(env, "tasks", "add", "a", "--every", "0", "--", task)).code,
    ).toBe(2);
    expect(
      (await run(env, "tasks", "add", "a", "--every", "1.5", "--", task))
        .stderr,
    ).toContain("必须是整数");

    expect((await run(env, "tasks", "add", "a", "--", task)).code).toBe(0);
    expect((await run(env, "tasks", "add", "a", "--", task)).stderr).toContain(
      "已有同名任务",
    );
    expect(
      (
        await run(
          env,
          "tasks",
          "add",
          "a",
          "--every",
          "30",
          "--force",
          "--",
          task,
        )
      ).code,
    ).toBe(0);
    expect(config(dataDir).tasks?.[0]?.everyMinutes).toBe(30);

    await run(env, "tasks", "run", "a");
    expect((await run(env, "tasks", "remove", "a")).code).toBe(0);
    expect(config(dataDir).tasks).toBeUndefined();
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).not.toContain(
      '"tasks"',
    );
    expect((await run(env, "tasks", "remove", "a")).code).toBe(2);
  });

  test("帮助说明额外任务不在只读保证之内", async () => {
    const { env } = setup();
    const help = await run(env, "help");
    expect(help.stdout).toContain("tasks add <name>");
    expect(help.stdout).toContain("以上保证只针对采集器本身");
  });
});
