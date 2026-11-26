import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasAgyExpiredQuota,
  maybeRefreshAgyQuota,
  maybeRefreshAgyTiers,
  maybeRefreshOmpAgyQuota,
  readAgy,
  refreshAgyQuota,
} from "../src/collector/agy";
import {
  COMMAND_CODE_MIN_INTERVAL_MS,
  COMMAND_CODE_REJECTED_COOLDOWN_MS,
  maybeRefreshCommandCodeQuota,
} from "../src/collector/commandcode";
import { SOURCE_START } from "../src/collector/config";
import { CollectorState } from "../src/collector/state";
import { CommandCodeQuotaRefresher } from "../src/server/commandcode";
import { silentLogger } from "../src/server/diagnostics";
import { GoQuotaRefresher } from "../src/server/opencode-go";
import type { IngestQuota } from "../src/shared/ingest";

const temps: string[] = [];
const states: CollectorState[] = [];

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix = "meterleaf-refresh-opt-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function openState() {
  const state = new CollectorState(":memory:");
  states.push(state);
  return state;
}

function fakeUsageAgy(dir: string, options: { resetIso?: string } = {}) {
  const logPath = join(dir, "usage-calls.jsonl");
  const scriptPath = join(dir, "fake-agy-usage");
  const resetIso = options.resetIso ?? "2026-12-01T00:00:00Z";
  const script = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const logIdx = args.indexOf("--log-file");
const record = {
  args,
  xdg: process.env.XDG_CONFIG_HOME ?? null,
  geminiHome: process.env.GEMINI_CLI_HOME ?? null,
  agyHome: process.env.ANTIGRAVITY_HOME ?? null,
  ssh: process.env.SSH_CONNECTION ?? null,
  wsl: process.env.WSL_INTEROP ?? null,
};
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(record) + "\\n");
if (logIdx !== -1 && args[logIdx + 1]) {
  writeFileSync(args[logIdx + 1]!, "authenticated successfully as alice@example.com\\n");
}
process.stdout.write(JSON.stringify({
  status: "SUCCESS",
  command: {
    data: {
      groups: [
        {
          buckets: [
            { id: "gemini-5h", remaining_fraction: 0.9, reset_time: ${JSON.stringify(resetIso)} },
            { id: "3p-5h", remaining_fraction: 0.8, reset_time: ${JSON.stringify(resetIso)} },
          ],
        },
      ],
    },
  },
}));
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return {
    scriptPath,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  args: string[];
                  xdg: string | null;
                  geminiHome: string | null;
                  agyHome: string | null;
                  ssh: string | null;
                  wsl: string | null;
                },
            )
        : [],
  };
}

function fakeTierAgy(dir: string) {
  const logPath = join(dir, "tier-calls.jsonl");
  const scriptPath = join(dir, "fake-agy-tier");
  const script = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
let buf = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let idx = buf.indexOf("\\n");
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
      } else if (msg.method === "session/new") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: "s-1", _meta: { antigravity: { tier: { id: "g1-pro-tier", name: "Google AI Pro" } } } },
        }) + "\\n");
      } else if (msg.method === "session/close") {
        appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
        process.exit(0);
      }
    }
    idx = buf.indexOf("\\n");
  }
}
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return {
    scriptPath,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { args: string[] })
        : [],
  };
}

describe("Antigravity 池额度缓存复用与刷新优化", () => {
  test("poolAccountsFile 模式下直接复用同目录 quota-cache.json 并跳过重复 agy /usage 探测", async () => {
    const root = tempDir();
    const geminiDir = join(root, ".gemini");
    const statuslineDir = join(root, "statusline");
    const poolDir = join(geminiDir, "antigravity-cli-pool-p-1");
    mkdirSync(join(geminiDir, "antigravity-cli", "conversations"), {
      recursive: true,
    });
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    mkdirSync(statuslineDir, { recursive: true });
    writeFileSync(
      join(poolDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "alice@example.com" }),
    );
    const poolFile = join(root, "accounts.json");
    writeFileSync(
      poolFile,
      JSON.stringify({
        accounts: [
          {
            id: "p-1",
            kind: "managed",
            appDataDir: "antigravity-cli-pool-p-1",
            enabled: true,
            status: "ready",
          },
        ],
      }),
    );
    const now = new Date("2026-11-26T08:16:00.000Z");
    writeFileSync(
      join(root, "quota-cache.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "p-1": {
            accountId: "p-1",
            appDataDir: "antigravity-cli-pool-p-1",
            sampledAt: "2026-11-26T08:14:00.000Z",
            quota: {
              sampledAt: "2026-11-26T08:14:00.000Z",
              gemini: {
                fiveHourUsedPct: 18,
                fiveHourResetsAt: "2026-11-26T12:00:00.000Z",
                weeklyUsedPct: 42,
                weeklyResetsAt: "2026-12-03T08:00:00.000Z",
              },
              thirdParty: {
                fiveHourUsedPct: 0,
                fiveHourResetsAt: null,
                weeklyUsedPct: 7,
                weeklyResetsAt: "2026-11-29T12:00:00.000Z",
              },
            },
          },
        },
      }),
    );

    const state = openState();
    const sources = {
      conversationsDir: join(geminiDir, "antigravity-cli", "conversations"),
      statuslineDir,
      start: SOURCE_START,
      defaultGeminiDir: geminiDir,
      poolAccountsFile: poolFile,
    };
    const report = readAgy(state, sources, now);
    expect(report.quotas).toBe(4);
    expect(report.missingQuotaProfiles).toBe(0);
    expect(hasAgyExpiredQuota(state)).toBe(false);

    const queued = state
      .pending<IngestQuota>("quota", 10)
      .map((row) => [row.payload.window, row.payload.percent]);
    expect(queued).toEqual([
      ["five-hour", 18],
      ["seven-day", 42],
      ["five-hour-3p", 0],
      ["seven-day-3p", 7],
    ]);

    // quota-cache.json 在 5 分钟内有效，即使显式请求刷新也跳过启动 agy 进程。
    const agy = fakeUsageAgy(root);
    const refresh = await maybeRefreshAgyQuota(state, sources, now, {
      agyBin: agy.scriptPath,
      profiles: ["pool-p-1"],
    });
    expect(refresh.attempted).toBe(false);
    expect(agy.calls()).toHaveLength(0);
  });

  test("本地 TSV 窗口过期后自动标记待补刷，并在刷新后解除过期状态", async () => {
    const root = tempDir();
    const geminiDir = join(root, ".gemini");
    const statuslineDir = join(root, "statusline");
    const poolDir = join(geminiDir, "antigravity-cli-pool-p-1");
    mkdirSync(join(geminiDir, "antigravity-cli", "conversations"), {
      recursive: true,
    });
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    mkdirSync(statuslineDir, { recursive: true });
    writeFileSync(
      join(poolDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "alice@example.com" }),
    );
    const quotaPath = join(statuslineDir, "quota-alice.tsv");
    // 窗口重置时间为 1795680000（早于 now），且文件 mtime 也在重置前。
    writeFileSync(quotaPath, "gemini_5h\t100\t1795680000\n");
    const beforeReset = new Date(1_795_679_900_000);
    // 模拟 TSV 在重置前 100 秒写入，now 在重置后 60 秒（仍小于 5 分钟 cacheAge，但窗口已过期）。
    const afterReset = new Date(1_795_680_060_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(quotaPath, beforeReset, beforeReset);

    const state = openState();
    const sources = {
      conversationsDir: join(geminiDir, "antigravity-cli", "conversations"),
      statuslineDir,
      start: SOURCE_START,
      defaultGeminiDir: geminiDir,
      appDataDirs: [poolDir],
    };
    readAgy(state, sources, afterReset);
    expect(hasAgyExpiredQuota(state)).toBe(true);

    const agy = fakeUsageAgy(root, { resetIso: "2026-12-05T00:00:00Z" });
    const res = await maybeRefreshAgyQuota(state, sources, afterReset, {
      agyBin: agy.scriptPath,
    });
    expect(res.attempted).toBe(true);
    expect(res.refreshed).toBe(true);
    expect(agy.calls()).toHaveLength(1);

    readAgy(state, sources, afterReset);
    expect(hasAgyExpiredQuota(state)).toBe(false);
  });

  test("refreshAgyQuota 与 probeAgyTier 统一清除宿主 XDG/GEMINI_CLI_HOME/ANTIGRAVITY 覆盖变量", async () => {
    const root = tempDir();
    const geminiDir = join(root, ".gemini");
    const statuslineDir = join(root, "statusline");
    const poolDir = join(geminiDir, "antigravity-cli-pool-p-env");
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    mkdirSync(statuslineDir, { recursive: true });
    writeFileSync(
      join(poolDir, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "alice@example.com" }),
    );
    const agy = fakeUsageAgy(root);
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevGemini = process.env.GEMINI_CLI_HOME;
    const prevAgy = process.env.ANTIGRAVITY_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/polluted-xdg";
    process.env.GEMINI_CLI_HOME = "/tmp/polluted-gemini";
    process.env.ANTIGRAVITY_HOME = "/tmp/polluted-agy";
    try {
      const res = await refreshAgyQuota(
        { statuslineDir },
        {
          agyBin: agy.scriptPath,
          profileName: "pool-p-env",
          geminiDir,
          appDataDir: poolDir,
        },
      );
      expect(res.refreshed).toBe(true);
      expect(agy.calls()[0]).toMatchObject({
        xdg: null,
        geminiHome: null,
        agyHome: null,
        ssh: null,
        wsl: "1",
      });
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevGemini === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prevGemini;
      if (prevAgy === undefined) delete process.env.ANTIGRAVITY_HOME;
      else process.env.ANTIGRAVITY_HOME = prevAgy;
    }
  });

  test("maybeRefreshAgyTiers 按每轮预算分批探测，避免多账号同步阻塞", async () => {
    const root = tempDir();
    const geminiDir = join(root, ".gemini");
    const statuslineDir = join(root, "statusline");
    mkdirSync(join(geminiDir, "antigravity-cli", "conversations"), {
      recursive: true,
    });
    mkdirSync(statuslineDir, { recursive: true });
    const dirs: string[] = [];
    for (const i of [1, 2, 3]) {
      const dir = join(geminiDir, `antigravity-cli-pool-p-${i}`);
      mkdirSync(join(dir, "conversations"), { recursive: true });
      writeFileSync(
        join(dir, "antigravity-oauth-token"),
        JSON.stringify({ id_token_email: `user${i}@example.com` }),
      );
      dirs.push(dir);
    }
    const agy = fakeTierAgy(root);
    const state = openState();
    const sources = {
      conversationsDir: join(geminiDir, "antigravity-cli", "conversations"),
      statuslineDir,
      start: SOURCE_START,
      defaultGeminiDir: geminiDir,
      appDataDirs: dirs,
    };
    const t0 = new Date("2026-11-26T08:00:00.000Z");
    const r1 = await maybeRefreshAgyTiers(state, sources, t0, {
      agyBin: agy.scriptPath,
      maxProbesPerRound: 2,
      concurrency: 2,
    });
    expect(r1.attempted).toBe(2);
    expect(r1.updatedLabels).toEqual(["user1", "user2"]);

    const r2 = await maybeRefreshAgyTiers(
      state,
      sources,
      new Date(t0.getTime() + 60_000),
      { agyBin: agy.scriptPath, maxProbesPerRound: 2, concurrency: 2 },
    );
    expect(r2.attempted).toBe(1);
    expect(r2.updatedLabels).toEqual(["user3"]);
  });

  test("找不到 omp 可执行文件时按 30 分钟退避，不每 1/5 分钟反复报错", async () => {
    const root = tempDir();
    const state = openState();
    const missingBin = join(root, "no-such-omp");
    const t0 = new Date("2026-11-26T08:00:00.000Z");

    const r1 = await maybeRefreshOmpAgyQuota(
      state,
      { statuslineDir: root },
      { exhausted: true },
      t0,
      { ompBin: missingBin },
    );
    expect(r1.error).toBe("找不到 omp 可执行文件");

    // 10 分钟后（即使 exhausted=true）仍在 30 分钟退避期内。
    const r2 = await maybeRefreshOmpAgyQuota(
      state,
      { statuslineDir: root },
      { exhausted: true },
      new Date(t0.getTime() + 10 * 60_000),
      { ompBin: missingBin },
    );
    expect(r2.attempted).toBe(false);
    expect(r2.error).toBeNull();

    // 31 分钟后允许复查。
    const r3 = await maybeRefreshOmpAgyQuota(
      state,
      { statuslineDir: root },
      { exhausted: true },
      new Date(t0.getTime() + 31 * 60_000),
      { ompBin: missingBin },
    );
    expect(r3.error).toBe("找不到 omp 可执行文件");
  });
});

describe("Command Code 与 OpenCode Go 401/403 退避优化", () => {
  test("采集器 Command Code 401 冷却绑定凭据摘要：旧 Key 冷却 30 分钟，换新 Key 立即恢复", async () => {
    const state = openState();
    const T0 = Date.parse("2026-11-26T08:00:00.000Z");
    const calls: string[] = [];
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      calls.push(`${url.pathname}:${auth}`);
      if (auth === "Bearer bad-key") return new Response("{}", { status: 401 });
      if (url.pathname === "/alpha/whoami") {
        return new Response(
          JSON.stringify({ org: { id: "org_1" }, user: { userName: "u" } }),
          { status: 200 },
        );
      }
      if (url.pathname === "/alpha/billing/subscriptions") {
        return new Response(JSON.stringify({ data: { planId: "pro" } }), {
          status: 200,
        });
      }
      if (url.pathname === "/alpha/billing/credits") {
        return new Response(JSON.stringify({ data: { used: 1, limit: 10 } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof globalThis.fetch;

    const r1 = await maybeRefreshCommandCodeQuota(state, null, {
      fetch,
      now: () => T0,
      env: { COMMAND_CODE_API_KEY: "bad-key" },
      home: "/nonexistent",
    });
    expect(r1).toEqual({ attempted: true, status: "rejected", quotas: 0 });

    // 同一个坏 Key 即使过了 4 分钟仍在 30 分钟冷却期内。
    const r2 = await maybeRefreshCommandCodeQuota(state, null, {
      fetch,
      now: () => T0 + COMMAND_CODE_MIN_INTERVAL_MS + 1000,
      env: { COMMAND_CODE_API_KEY: "bad-key" },
      home: "/nonexistent",
    });
    expect(r2).toEqual({ attempted: false, status: "cooldown", quotas: 0 });
    expect(calls).toHaveLength(1);

    // 换用新 Key 后无需等待 30 分钟，立即解除冷却并成功拉取。
    const r3 = await maybeRefreshCommandCodeQuota(state, null, {
      fetch,
      now: () => T0 + 10_000,
      env: { COMMAND_CODE_API_KEY: "good-key" },
      home: "/nonexistent",
    });
    expect(r3.attempted).toBe(true);
    expect(r3.status).toBe("ok");

    // 确认状态库中没有明文保存任何 API Key。
    const dump = JSON.stringify(state.db.query("SELECT * FROM meta").all());
    expect(dump).not.toContain("bad-key");
    expect(dump).not.toContain("good-key");
    void COMMAND_CODE_REJECTED_COOLDOWN_MS;
  });

  test("服务端 CommandCodeQuotaRefresher 与 GoQuotaRefresher 在 401/403 后进入长冷却", async () => {
    let now = Date.parse("2026-11-26T08:00:00.000Z");
    let ccCalls = 0;
    let ccStatus = 401;
    const ccRefresher = new CommandCodeQuotaRefresher({
      key: "cc-key",
      account: { sourceId: "s", accountExternalId: "commandcode" },
      save: () => "saved",
      diagnostics: silentLogger,
      now: () => now,
      intervalMs: 120_000,
      rejectedCooldownMs: 30 * 60_000,
      fetch: (async () => {
        ccCalls += 1;
        return new Response("{}", { status: ccStatus });
      }) as unknown as typeof fetch,
    });

    ccRefresher.updatePresence("p", true);
    await ccRefresher.settled();
    expect(ccCalls).toBe(1);

    // 10 分钟后虽然大于 2 分钟普通间隔，但仍在 30 分钟 401 冷却中。
    now += 10 * 60_000;
    ccRefresher.updatePresence("p", true);
    await ccRefresher.settled();
    expect(ccCalls).toBe(1);

    // 31 分钟后冷却结束允许重试。
    now += 21 * 60_000;
    ccRefresher.updatePresence("p", true);
    await ccRefresher.settled();
    expect(ccCalls).toBe(2);

    // OpenCode Go 同理。
    let goNow = Date.parse("2026-11-26T08:00:00.000Z");
    let goCalls = 0;
    const goRefresher = new GoQuotaRefresher({
      key: "go-key",
      account: { sourceId: "s", accountExternalId: "opencode-go" },
      save: () => {},
      diagnostics: silentLogger,
      now: () => goNow,
      intervalMs: 120_000,
      rejectedCooldownMs: 30 * 60_000,
      fetch: (async () => {
        goCalls += 1;
        return new Response("{}", { status: 403 });
      }) as unknown as typeof fetch,
    });
    goRefresher.updatePresence("p", true);
    await goRefresher.settled();
    expect(goCalls).toBe(1);

    goNow += 15 * 60_000;
    goRefresher.updatePresence("p", true);
    await goRefresher.settled();
    expect(goCalls).toBe(1);

    goNow += 16 * 60_000;
    goRefresher.updatePresence("p", true);
    await goRefresher.settled();
    expect(goCalls).toBe(2);
  });
});
