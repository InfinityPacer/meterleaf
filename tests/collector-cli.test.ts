import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INGEST_BATCHES_PATH,
  ingestBatchSchema,
  type IngestBatch,
} from "../src/shared/ingest";
import { keyDigest } from "../src/collector/config";
import { renderPlist, syncProgramArguments } from "../src/collector/launchd";
import { FIXTURE_ACCOUNT_UUID } from "./fixtures/claude-code/lines";

const repoRoot = join(import.meta.dir, "..");
const fixtureRoot = join(import.meta.dir, "fixtures/claude-code");
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-collector-cli-"));
  const claudeDir = join(root, "claude");
  const home = join(root, "home");
  mkdirSync(claudeDir);
  mkdirSync(home);
  cpSync(join(fixtureRoot, "projects"), join(claudeDir, "projects"), {
    recursive: true,
  });
  cpSync(join(fixtureRoot, "claude.json"), join(claudeDir, ".claude.json"));
  // Claude Code 目录整体只读：任何写入、改名或建锁都会失败。
  const setMode = (dir: string, mode: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) setMode(path, mode | 0o111);
      else chmodSync(path, mode);
    }
    chmodSync(dir, mode | 0o111);
  };
  setMode(claudeDir, 0o444);
  cleanup.push(() => {
    setMode(claudeDir, 0o644);
    rmSync(root, { recursive: true, force: true });
  });
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    METERLEAF_COLLECTOR_HOME: join(root, "data"),
  };
  return { root, claudeDir, env, dataDir: env.METERLEAF_COLLECTOR_HOME };
}

function snapshot(dir: string): string[] {
  const entries: string[] = [];
  const walk = (path: string) => {
    const stat = statSync(path);
    entries.push(`${path}:${stat.size}:${stat.mtimeMs}:${stat.mode}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    }
  };
  walk(dir);
  return entries;
}

function run(env: Record<string, string>, ...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, join(repoRoot, "src/collector/main.ts"), ...args],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function runAsync(env: Record<string, string>, ...args: string[]) {
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

function fakeServer() {
  const batches: IngestBatch[] = [];
  const keys = new Set<string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname !== INGEST_BATCHES_PATH) {
        return new Response("not found", { status: 404 });
      }
      const auth = request.headers.get("authorization") ?? "";
      const digest = keyDigest(auth.replace(/^Bearer /, ""));
      if (!keys.has(digest))
        return new Response("unauthorized", { status: 401 });
      const parsed = ingestBatchSchema.safeParse(await request.json());
      if (!parsed.success) return new Response("bad", { status: 400 });
      batches.push(parsed.data);
      return Response.json({ batchId: parsed.data.batchId, accepted: {} });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, batches, keys };
}

describe("采集器命令行", () => {
  test("在只读的 Claude Code 目录上完成 init、sync、bind-history 与 status", async () => {
    const { claudeDir, env, dataDir } = setup();
    const server = fakeServer();
    const before = snapshot(claudeDir);

    const init = run(
      env,
      "init",
      "--server",
      server.url,
      "--source-id",
      "claude-code-test",
    );
    expect(init.code).toBe(0);
    const digest = /METERLEAF_INGEST_KEYS=claude-code-test:([0-9a-f]{64})/.exec(
      init.stdout,
    )?.[1];
    expect(digest).toBeDefined();
    expect(init.stdout).not.toContain("mlk_");
    expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);
    expect(run(env, "init", "--server", server.url).code).toBe(1);

    const unauthorized = await runAsync(env, "sync");
    expect(unauthorized.code).toBe(1);
    expect(unauthorized.stderr).toContain("401");
    server.keys.add(digest!);

    const sync = await runAsync(env, "sync");
    expect(sync.stderr).toBe("");
    expect(sync.code).toBe(0);
    const usage = server.batches.flatMap((batch) => batch.usage);
    expect(usage).toHaveLength(5);
    // 首次运行前的历史无法判断账户。
    expect(new Set(usage.map((u) => u.accountExternalId))).toEqual(
      new Set(["unattributed"]),
    );

    const bind = run(env, "bind-history");
    expect(bind.code).toBe(0);
    expect(bind.stdout).toContain("5 条");
    const rebound = await runAsync(env, "sync");
    expect(rebound.code).toBe(0);
    const latest = server.batches.at(-1)!;
    expect(latest.usage).toHaveLength(5);
    expect(new Set(latest.usage.map((u) => u.accountExternalId))).toEqual(
      new Set([FIXTURE_ACCOUNT_UUID]),
    );

    const status = run(env, "status");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("待发送: 用量 0");
    expect(status.stdout).not.toContain("mlk_");

    const batchesBefore = server.batches.length;
    const idle = await runAsync(env, "sync");
    expect(idle.code).toBe(0);
    expect(idle.stdout).toBe("");
    expect(server.batches.length).toBe(batchesBefore);

    expect(snapshot(claudeDir)).toEqual(before);
  });

  test("已有实例持锁时 sync 静默退出", async () => {
    const { env, dataDir } = setup();
    const server = fakeServer();
    expect(run(env, "init", "--server", server.url).code).toBe(0);
    writeFileSync(join(dataDir, "sync.lock"), `${process.pid}\n`);
    const locked = await runAsync(env, "sync");
    expect(locked.code).toBe(0);
    expect(locked.stdout + locked.stderr).toBe("");
    expect(server.batches).toHaveLength(0);
  });

  test("残留锁（进程已退出）会被接管", async () => {
    const { env, dataDir } = setup();
    const server = fakeServer();
    const init = run(env, "init", "--server", server.url);
    server.keys.add(
      /METERLEAF_INGEST_KEYS=[^:]+:([0-9a-f]{64})/.exec(init.stdout)![1]!,
    );
    writeFileSync(join(dataDir, "sync.lock"), "999999\n");
    expect((await runAsync(env, "sync")).code).toBe(0);
    expect(server.batches.length).toBeGreaterThan(0);
  });

  test("scan 不联网也不创建数据目录", () => {
    const { env, dataDir } = setup();
    const scan = run(env, "scan", "--json");
    expect(scan.code).toBe(0);
    const parsed = JSON.parse(scan.stdout) as {
      totals: { events: number }[];
    };
    expect(parsed.totals.reduce((sum, row) => sum + row.events, 0)).toBe(5);
    expect(() => statSync(dataDir)).toThrow();
  });

  test("帮助说明对 Claude Code 的只读保证", () => {
    const help = run({ PATH: process.env.PATH ?? "" }, "help");
    expect(help.stdout).toContain("只读");
    expect(help.stdout).toContain("OAuth");
  });

  test("后台任务以包内可执行文件低优先级运行并关联 Meterleaf 包标识", () => {
    const { root } = setup();
    const executable = join(
      root,
      "Meterleaf.app/Contents/MacOS/meterleaf-collector",
    );
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "");
    const programArguments = syncProgramArguments(
      executable,
      "/$bunfs/root/main",
    );
    expect(programArguments).toEqual([
      expect.stringMatching(
        /Meterleaf\.app\/Contents\/MacOS\/meterleaf-collector$/,
      ),
      "sync",
    ]);
    const plist = renderPlist({
      plistPath: join(root, "io.meterleaf.collector.plist"),
      programArguments,
      logDir: join(root, "logs"),
      environment: { METERLEAF_COLLECTOR_HOME: join(root, "data & more") },
    });
    for (const fragment of [
      "<key>AssociatedBundleIdentifiers</key>",
      "<string>io.meterleaf.collector</string>",
      "<key>ProcessType</key>\n  <string>Background</string>",
      "<key>LowPriorityIO</key>\n  <true/>",
      "<key>Nice</key>\n  <integer>10</integer>",
      "<key>StartInterval</key>\n  <integer>60</integer>",
      "data &amp; more",
    ]) {
      expect(plist).toContain(fragment);
    }
    const plistFile = join(root, "check.plist");
    writeFileSync(plistFile, plist);
    if (process.platform === "darwin") {
      const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", plistFile]);
      expect(lint.exitCode).toBe(0);
    }
  });
});
