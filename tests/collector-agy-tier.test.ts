import { afterEach, expect, test } from "bun:test";
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
  extractAcpSessionTier,
  maybeRefreshAgyTiers,
  normalizeAgyTierPlan,
  probeAgyTier,
  readAgy,
} from "../src/collector/agy";
import { SOURCE_START } from "../src/collector/config";
import { CollectorState } from "../src/collector/state";
import { planBadge } from "../src/web/lib/plan";

const temps: string[] = [];
const states: CollectorState[] = [];

afterEach(() => {
  for (const s of states.splice(0)) s.close();
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-agy-tier-test-"));
  temps.push(dir);
  return dir;
}

function openState() {
  const state = new CollectorState(":memory:");
  states.push(state);
  return state;
}

/** 构造模拟 `agy acp` 的可执行脚本，记录调用参数、关键环境变量与 JSON-RPC 请求。 */
function fakeAgyAcp(
  dir: string,
  options: {
    tier?: { id?: string; name?: string } | null;
    hang?: boolean;
    errorOnInit?: boolean;
  } = {},
) {
  const logPath = join(dir, "acp-calls.jsonl");
  const scriptPath = join(dir, "fake-agy");
  const tierLiteral = JSON.stringify(options.tier ?? null);
  const script = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const record = {
  args,
  ssh: process.env.SSH_CONNECTION ?? null,
  wsl: process.env.WSL_INTEROP ?? null,
  browser: process.env.BROWSER ?? null,
  xdg: process.env.XDG_CONFIG_HOME ?? null,
  methods: [] as string[],
};
if (${Boolean(options.hang)}) {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(record) + "\\n");
  await new Promise(() => {});
}
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
      record.methods.push(msg.method);
      if (msg.method === "initialize") {
        if (${Boolean(options.errorOnInit)}) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "boom" } }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
        }
      } else if (msg.method === "session/new") {
        const tier = ${tierLiteral};
        const result = tier
          ? { sessionId: "sess-1", _meta: { antigravity: { tier } } }
          : { sessionId: "sess-1" };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
      } else if (msg.method === "session/close") {
        appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(record) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
        process.exit(0);
      }
    }
    idx = buf.indexOf("\\n");
  }
}
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(record) + "\\n");
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  const calls = () => {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            ssh: string | null;
            wsl: string | null;
            browser: string | null;
            xdg: string | null;
            methods: string[];
          },
      );
  };
  return { scriptPath, calls };
}

test("extractAcpSessionTier sanitizes control chars and handles single-field fallback", () => {
  expect(
    extractAcpSessionTier({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: "s1",
        _meta: {
          antigravity: {
            tier: {
              id: "g1-ultra-tier\u0000",
              name: "  Google AI Ultra\n ",
              upgradeUri: "",
            },
          },
        },
      },
    }),
  ).toEqual({ id: "g1-ultra-tier", name: "Google AI Ultra" });

  expect(
    extractAcpSessionTier({
      result: { _meta: { antigravity: { tier: { id: "g1-pro-tier" } } } },
    }),
  ).toEqual({ id: "g1-pro-tier", name: "g1-pro-tier" });

  expect(extractAcpSessionTier({ id: 1, result: {} })).toBeNull();
  expect(extractAcpSessionTier(null)).toBeNull();
});

test("normalizeAgyTierPlan maps known official tiers and renders matching Google plan badges", () => {
  expect(
    normalizeAgyTierPlan({ id: "g1-ultra-tier", name: "Google AI Ultra" }),
  ).toBe("Google AI Ultra");
  expect(
    normalizeAgyTierPlan({
      id: "g1-ultra-20x-tier",
      name: "Google AI Ultra 20x",
    }),
  ).toBe("ultra-20x");
  expect(
    normalizeAgyTierPlan({ id: "g1-pro-tier", name: "Google AI Pro" }),
  ).toBe("Google AI Pro");
  expect(normalizeAgyTierPlan({ id: "free-tier", name: "Individual" })).toBe(
    "free",
  );
  expect(
    normalizeAgyTierPlan({ id: "ge-standard", name: "Gemini Enterprise" }),
  ).toBe("Gemini Enterprise");
  expect(
    normalizeAgyTierPlan({ id: "ge-plus", name: "Gemini Enterprise Plus" }),
  ).toBe("Gemini Enterprise Plus");

  expect(
    planBadge({ platform: "google", kind: "subscription", plan: "free" }),
  ).toEqual({ label: "Free", tier: null });
  expect(
    planBadge({
      platform: "google",
      kind: "subscription",
      plan: "Gemini Enterprise",
    }),
  ).toEqual({ label: "Enterprise", tier: null });
  expect(
    planBadge({
      platform: "google",
      kind: "subscription",
      plan: "Gemini Enterprise Plus",
    }),
  ).toEqual({ label: "Enterprise Plus", tier: null });
});

test("probeAgyTier runs JSON-RPC handshake with strict credential isolation for pool vs default instances", async () => {
  const root = tempDir();
  const geminiDir = join(root, ".gemini");
  const poolAppDir = join(geminiDir, "antigravity-cli-pool-p-test");
  mkdirSync(poolAppDir, { recursive: true });

  const agy = fakeAgyAcp(root, {
    tier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
  });

  // 缺少非空 antigravity-oauth-token 时拒绝启动非默认实例探测。
  const missingToken = await probeAgyTier({
    agyBin: agy.scriptPath,
    profileName: "pool-p-test",
    geminiDir,
    appDataDir: poolAppDir,
  });
  expect(missingToken.attempted).toBe(false);
  expect(missingToken.tier).toBeNull();
  expect(agy.calls()).toHaveLength(0);

  // 非默认实例：强制携带 SSH_CONNECTION + WSL_INTEROP=1 与 --app-data-dir / --gemini-dir。
  writeFileSync(
    join(poolAppDir, "antigravity-oauth-token"),
    JSON.stringify({ id_token_email: "alice@example.com" }),
  );
  const poolRes = await probeAgyTier({
    agyBin: agy.scriptPath,
    profileName: "pool-p-test",
    geminiDir,
    appDataDir: poolAppDir,
  });
  expect(poolRes).toEqual({
    attempted: true,
    tier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
    error: null,
  });
  expect(agy.calls()[0]).toMatchObject({
    args: [
      "acp",
      "--disable-telemetry",
      "--gemini-dir",
      geminiDir,
      "--app-data-dir",
      "antigravity-cli-pool-p-test",
    ],
    wsl: "1",
    browser: "/usr/bin/false",
    xdg: null,
    methods: ["initialize", "session/new", "session/close"],
  });
  expect(agy.calls()[0]!.ssh).toBeTruthy();

  // 默认实例：清除 SSH_* 与 WSL_INTEROP，不传 --app-data-dir。
  const defaultRes = await probeAgyTier({
    agyBin: agy.scriptPath,
    profileName: null,
  });
  expect(defaultRes.tier).toEqual({
    id: "g1-ultra-tier",
    name: "Google AI Ultra",
  });
  expect(agy.calls()[1]).toMatchObject({
    args: ["acp", "--disable-telemetry"],
    ssh: null,
    wsl: null,
    methods: ["initialize", "session/new", "session/close"],
  });
});

test("maybeRefreshAgyTiers respects 24h TTL, 1h failure backoff, existing quota TSV merge, and routing-state cache", async () => {
  const root = tempDir();
  const geminiDir = join(root, ".gemini");
  const statuslineDir = join(root, "statusline");
  mkdirSync(join(geminiDir, "antigravity-cli", "conversations"), {
    recursive: true,
  });
  mkdirSync(statuslineDir, { recursive: true });

  const poolDir1 = join(geminiDir, "antigravity-cli-pool-p-1");
  const poolDir2 = join(geminiDir, "antigravity-cli-pool-p-2");
  mkdirSync(join(poolDir1, "conversations"), { recursive: true });
  mkdirSync(join(poolDir2, "conversations"), { recursive: true });
  writeFileSync(
    join(poolDir1, "antigravity-oauth-token"),
    JSON.stringify({ id_token_email: "cached@example.com" }),
  );
  writeFileSync(
    join(poolDir2, "antigravity-oauth-token"),
    JSON.stringify({ id_token_email: "probed@example.com" }),
  );

  // p-1 已在 routing-state.json 中有套餐；p-2 没有，需走 agy acp 探测。
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
        {
          id: "p-2",
          kind: "managed",
          appDataDir: "antigravity-cli-pool-p-2",
          enabled: true,
          status: "ready",
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "routing-state.json"),
    JSON.stringify({
      version: 1,
      accounts: {
        "p-1": { tier: { id: "g1-ultra-tier", name: "Google AI Ultra" } },
      },
    }),
  );

  // 给 p-2 预先放好 quota-probed.tsv，验证 plan 行合并写入；p-1 无 TSV 时不凭空创建。
  const probedTsv = join(statuslineDir, "quota-probed.tsv");
  writeFileSync(probedTsv, "gemini_5h\t12\t1796000000\n");

  const agy = fakeAgyAcp(root, {
    tier: { id: "g1-pro-tier", name: "Google AI Pro" },
  });
  const state = openState();
  const sources = {
    conversationsDir: join(geminiDir, "antigravity-cli", "conversations"),
    statuslineDir,
    start: SOURCE_START,
    defaultGeminiDir: geminiDir,
    poolAccountsFile: poolFile,
    defaultPlan: "ultra-20x",
  };

  // readAgy 直接零开销读取 routing-state.json，并保留 defaultPlan 对 Ultra 的细化。
  const t0 = new Date("2026-11-26T06:00:00.000Z");
  readAgy(state, sources, t0);
  expect(state.account("agy-cached")?.plan).toBe("ultra-20x");
  expect(agy.calls()).toHaveLength(0);

  // maybeRefreshAgyTiers 只探测没有 routing-state 缓存的 p-2。
  const r1 = await maybeRefreshAgyTiers(state, sources, t0, {
    agyBin: agy.scriptPath,
  });
  expect(r1).toEqual({
    attempted: 1,
    refreshed: true,
    updatedLabels: ["probed"],
  });
  expect(agy.calls()).toHaveLength(1);
  expect(readFileSync(probedTsv, "utf8")).toContain("plan\tGoogle AI Pro\t-");
  expect(existsSync(join(statuslineDir, "quota-cached.tsv"))).toBe(false);

  // 重读后 p-2 为 Google AI Pro（不被 defaultPlan: ultra-20x 覆盖）。
  readAgy(state, sources, t0);
  expect(state.account("agy-probed")?.plan).toBe("Google AI Pro");

  // 24 小时 TTL 内不再重复探测；超过 24 小时后再次探测。
  const rWithinTtl = await maybeRefreshAgyTiers(
    state,
    sources,
    new Date(t0.getTime() + 12 * 60 * 60_000),
    { agyBin: agy.scriptPath },
  );
  expect(rWithinTtl.attempted).toBe(0);
  const rAfterTtl = await maybeRefreshAgyTiers(
    state,
    sources,
    new Date(t0.getTime() + 25 * 60 * 60_000),
    { agyBin: agy.scriptPath },
  );
  expect(rAfterTtl.attempted).toBe(1);
  expect(rAfterTtl.refreshed).toBe(false);

  // 旧版 CLI 返回 null 时按 1 小时退避，避免死循环。
  const state2 = openState();
  const sourcesNoPool = {
    conversationsDir: join(geminiDir, "antigravity-cli", "conversations"),
    statuslineDir,
    start: SOURCE_START,
    defaultGeminiDir: geminiDir,
    appDataDirs: [poolDir2],
  };
  mkdirSync(join(root, "null-bin"), { recursive: true });
  const nullScript = fakeAgyAcp(join(root, "null-bin"), { tier: null });
  // 清理先前写入的 plan 行。
  writeFileSync(probedTsv, "gemini_5h\t12\t1796000000\n");
  const miss1 = await maybeRefreshAgyTiers(state2, sourcesNoPool, t0, {
    agyBin: nullScript.scriptPath,
  });
  expect(miss1.attempted).toBe(1);
  expect(miss1.refreshed).toBe(false);
  const missSoon = await maybeRefreshAgyTiers(
    state2,
    sourcesNoPool,
    new Date(t0.getTime() + 30 * 60_000),
    { agyBin: nullScript.scriptPath },
  );
  expect(missSoon.attempted).toBe(0);
  const missLater = await maybeRefreshAgyTiers(
    state2,
    sourcesNoPool,
    new Date(t0.getTime() + 61 * 60_000),
    { agyBin: nullScript.scriptPath },
  );
  expect(missLater.attempted).toBe(1);
});

test("probeAgyTier terminates hung or failing ACP process cleanly", async () => {
  const root = tempDir();
  const hangDir = join(root, "hang");
  const errDir = join(root, "err");
  mkdirSync(hangDir, { recursive: true });
  mkdirSync(errDir, { recursive: true });
  const hangAgy = fakeAgyAcp(hangDir, { hang: true });
  const errAgy = fakeAgyAcp(errDir, { errorOnInit: true });

  const hangRes = await probeAgyTier({
    agyBin: hangAgy.scriptPath,
    profileName: null,
    timeoutMs: 300,
  });
  expect(hangRes.tier).toBeNull();
  expect(hangRes.error).toContain("超时");

  const errRes = await probeAgyTier({
    agyBin: errAgy.scriptPath,
    profileName: null,
    timeoutMs: 3_000,
  });
  expect(errRes.tier).toBeNull();
  expect(errRes.error).toContain("boom");
});
