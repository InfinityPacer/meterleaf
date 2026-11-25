import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CHANNEL_ACCOUNTS,
  effectiveChannelAccounts,
  type ChannelAccountRule,
} from "../src/collector/channel-accounts";
import {
  COMMAND_CODE_MIN_INTERVAL_MS,
  COMMAND_CODE_STATUS_META,
  commandCodeStatusText,
  commandCodeTarget,
  credentialFromStore,
  credentialFromValue,
  findCommandCodeCredential,
  markCommandCodeStorageError,
  maybeRefreshCommandCodeQuota,
} from "../src/collector/commandcode";
import { SOURCE_START, type CollectorConfig } from "../src/collector/config";
import { main, readNewSources } from "../src/collector/main";
import {
  OMP_RULES_DIGEST_META,
  OMP_RULES_PENDING_META,
  ompRulesDigest,
  readOmp,
} from "../src/collector/omp";
import { pushOutbox } from "../src/collector/push";
import {
  CollectorState,
  COMMAND_CODE_PLANS_META,
  commandCodeIdentityMetaKey,
} from "../src/collector/state";
import { defaultPriceBook } from "../src/domain/default-prices";
import { valueUsage } from "../src/domain/pricing";
import type { UsageFact } from "../src/domain/connector";
import { commandCodeSubjectKey } from "../src/shared/commandcode";
import {
  INGEST_BATCHES_PATH,
  ingestBatchSchema,
  type IngestAccount,
  type IngestBatch,
  type IngestUsage,
} from "../src/shared/ingest";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openState() {
  const state = new CollectorState(":memory:");
  cleanup.push(() => state.close());
  return state;
}

const KEY = "cc_test_key_not_a_secret_0001";
const DIGEST = commandCodeSubjectKey("org_1", "acme");
const OTHER_DIGEST = commandCodeSubjectKey("org_2", "other");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

interface ApiState {
  whoami: unknown;
  whoamiStatus: number;
  planId: unknown;
  spent: number;
}

/** Command Code 接口桩；记录每次请求的路径与 Authorization。 */
function commandCodeApi(initial: Partial<ApiState> = {}) {
  const api: ApiState = {
    whoami: { org: { id: "org_1", login: "acme" } },
    whoamiStatus: 200,
    planId: "pro",
    spent: 25,
    ...initial,
  };
  const calls: { path: string; auth: string | null }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      auth: new Headers(init?.headers).get("authorization"),
    });
    switch (url.pathname) {
      case "/alpha/whoami":
        return json(api.whoami, api.whoamiStatus);
      case "/alpha/billing/credits":
        return json({
          credits: { monthlyCredits: 75 },
          windowLimits: {
            fiveHour: { used: 1, cap: 3, resetAt: 1_795_000_000 },
          },
        });
      case "/alpha/billing/subscriptions":
        return json({
          data: {
            ...(api.planId === undefined ? {} : { planId: api.planId }),
            currentPeriodStart: "2026-11-01T00:00:00Z",
            currentPeriodEnd: "2026-12-01T00:00:00Z",
          },
        });
      case "/alpha/usage/summary":
        return json({ totalCost: api.spent });
      default:
        throw new Error("unexpected path");
    }
  }) as typeof globalThis.fetch;
  return { api, calls, fetch };
}

function refreshOptions(
  fetch: typeof globalThis.fetch,
  now: number,
  env: Record<string, string> = { COMMAND_CODE_API_KEY: KEY },
  home = "/nonexistent-home",
) {
  return { fetch, now: () => now, env, home };
}

const T0 = Date.parse("2026-11-10T00:00:00Z");

interface QueuedQuota {
  accountExternalId: string;
  window: string;
  percent: number | null;
  sampledAt: string;
  resetsAt: string | null;
  windowMinutes: number | null;
  _identity?: { platform: string; subjectKey: string };
}

function queuedQuotas(state: CollectorState) {
  return state.pending<QueuedQuota>("quota", 1000).map((item) => item.payload);
}

describe("本地凭据发现", () => {
  test("逐字段回退：空串或无效对象不阻断后续有效字段", () => {
    expect(credentialFromValue("")).toBeUndefined();
    expect(credentialFromValue([])).toBeUndefined();
    expect(
      credentialFromValue({ type: "oauth", access: "a", key: "k" }),
    ).toEqual({
      apiKey: "a",
    });
    expect(credentialFromValue({ type: "api", access: "a", key: "k" })).toEqual(
      {
        apiKey: "k",
      },
    );
    expect(
      credentialFromValue({ type: "oauth", key: "k", expires: 5 }),
    ).toEqual({
      apiKey: "k",
      expires: 5,
    });
    expect(credentialFromValue({ access: "", key: "" })).toBeUndefined();
    expect(
      credentialFromStore({
        apiKey: "",
        commandcode: { type: "x" },
        "command-code": "z",
      }),
    ).toEqual({ apiKey: "z" });
    expect(
      credentialFromStore({ apiKey: { access: "" }, commandcode: "y" }),
    ).toEqual({
      apiKey: "y",
    });
    expect(credentialFromStore("x")).toBeUndefined();
  });

  test("按环境变量与三个 auth.json 的顺序选中第一个，过期不顺延，文件只读", () => {
    const home = tempDir("meterleaf-cc-home-");
    const write = (dir: string, body: unknown) => {
      mkdirSync(join(home, dir), { recursive: true });
      const path = join(home, dir, "auth.json");
      writeFileSync(path, JSON.stringify(body));
      return path;
    };
    const now = T0;
    expect(findCommandCodeCredential({ env: {}, home, now })).toEqual({
      status: "none",
    });
    const pi = write(".pi/agent", {
      commandcode: { type: "api", key: "pi-key" },
    });
    const omp = write(".omp/agent", { commandcode: "omp-key" });
    expect(findCommandCodeCredential({ env: {}, home, now })).toEqual({
      status: "ok",
      apiKey: "pi-key",
    });
    const cc = write(".commandcode", {
      apiKey: { type: "oauth", access: "cc-key", expires: now - 1 },
    });
    // 选中的存储已过期：不换下一个存储。
    expect(findCommandCodeCredential({ env: {}, home, now })).toEqual({
      status: "expired",
    });
    expect(
      findCommandCodeCredential({
        env: { COMMANDCODE_API_KEY: "env2", COMMAND_CODE_API_KEY: "env1" },
        home,
        now,
      }),
    ).toEqual({ status: "ok", apiKey: "env1" });
    expect(
      findCommandCodeCredential({
        env: { COMMANDCODE_API_KEY: "env2" },
        home,
        now,
      }),
    ).toEqual({ status: "ok", apiKey: "env2" });
    // 显式 authFile 时只读它：缺失也不回退到环境变量或其他文件。
    expect(
      findCommandCodeCredential({
        authFile: join(home, "missing.json"),
        env: { COMMAND_CODE_API_KEY: "env1" },
        home,
        now,
      }),
    ).toEqual({ status: "none" });
    expect(
      findCommandCodeCredential({ authFile: omp, env: {}, home, now }),
    ).toEqual({ status: "ok", apiKey: "omp-key" });
    for (const path of [pi, omp, cc]) {
      const before = statSync(path);
      findCommandCodeCredential({ env: {}, home, now });
      expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
      expect(readFileSync(path, "utf8")).toContain("{");
    }
  });
});

describe("目标账户绑定", () => {
  const custom = (rules: Partial<ChannelAccountRule>[]): ChannelAccountRule[] =>
    rules.map((rule) => ({
      source: "omp",
      channel: "x",
      id: "x",
      name: "X",
      platform: "x",
      kind: "subscription",
      plan: null,
      ...rule,
    }));

  test("默认规则恰好一个 commandcode 账户", () => {
    expect(commandCodeTarget(null)).toMatchObject({
      status: "ok",
      rule: { id: "commandcode", plan: null },
    });
  });

  test("多个、缺失或落到其他平台都跳过", () => {
    expect(
      commandCodeTarget({
        channelAccounts: custom([
          { channel: "commandcode", id: "cc-a", platform: "commandcode" },
          {
            source: "opencode",
            channel: "commandcode",
            id: "cc-b",
            platform: "commandcode",
          },
        ]),
      }),
    ).toEqual({ status: "skip", reason: "ambiguous" });
    expect(commandCodeTarget({ channelAccounts: custom([{}]) })).toEqual({
      status: "skip",
      reason: "none",
    });
    expect(
      commandCodeTarget({
        channelAccounts: custom([
          { channel: "commandcode", id: "cc-a", platform: "commandcode" },
        ]),
        commandcode: { enabled: true, accountId: "cc-z" },
      }),
    ).toEqual({ status: "skip", reason: "account-missing" });
    expect(
      commandCodeTarget({
        channelAccounts: custom([{ id: "cc-a", platform: "openai" }]),
        commandcode: { enabled: true, accountId: "cc-a" },
      }),
    ).toEqual({ status: "skip", reason: "account-platform" });
    expect(
      commandCodeTarget({
        channelAccounts: custom([
          { channel: "commandcode", id: "cc-a", platform: "commandcode" },
          {
            source: "opencode",
            channel: "commandcode",
            id: "cc-b",
            platform: "commandcode",
          },
        ]),
        commandcode: { enabled: true, accountId: "cc-b" },
      }),
    ).toMatchObject({ status: "ok", rule: { id: "cc-b" } });
    // 模型映射中的 commandcode 账户也是候选。
    expect(
      commandCodeTarget({
        channelAccounts: custom([{}]),
        modelAccounts: [
          {
            match: "deepseek/*",
            id: "cc-model",
            name: "CC",
            platform: "commandcode",
            kind: "subscription",
            plan: "max",
          },
        ],
      }),
    ).toMatchObject({ status: "ok", rule: { id: "cc-model", plan: "max" } });
  });

  test("跳过时不联网", async () => {
    const state = openState();
    const { calls, fetch } = commandCodeApi();
    const report = await maybeRefreshCommandCodeQuota(
      state,
      { channelAccounts: [] },
      refreshOptions(fetch, T0),
    );
    expect(report).toEqual({ attempted: false, status: "none", quotas: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("采集器额度刷新", () => {
  test("成功时单事务写入主体、套餐缓存、账户与带冻结身份的额度", async () => {
    const state = openState();
    const { fetch } = commandCodeApi();
    const report = await maybeRefreshCommandCodeQuota(
      state,
      null,
      refreshOptions(fetch, T0),
    );
    expect(report).toEqual({ attempted: true, status: "ok", quotas: 2 });
    expect(state.getMeta(commandCodeIdentityMetaKey("commandcode"))).toBe(
      DIGEST,
    );
    expect(JSON.parse(state.getMeta(COMMAND_CODE_PLANS_META)!)).toEqual({
      commandcode: "pro",
    });
    expect(state.account("commandcode")).toEqual({
      externalId: "commandcode",
      name: "Command Code",
      platform: "commandcode",
      kind: "subscription",
      plan: "pro",
      subjectKey: DIGEST,
    });
    expect(queuedQuotas(state)).toEqual([
      {
        accountExternalId: "commandcode",
        window: "five-hour",
        percent: (1 / 3) * 100,
        sampledAt: new Date(T0).toISOString(),
        resetsAt: new Date(1_795_000_000_000).toISOString(),
        windowMinutes: 300,
        _identity: { platform: "commandcode", subjectKey: DIGEST },
      },
      {
        accountExternalId: "commandcode",
        window: "monthly",
        percent: 25,
        sampledAt: new Date(T0).toISOString(),
        resetsAt: "2026-12-01T00:00:00.000Z",
        windowMinutes: 30 * 24 * 60,
        _identity: { platform: "commandcode", subjectKey: DIGEST },
      },
    ]);
    // 状态里不保存登录名、组织 ID 或凭据。
    const dump =
      JSON.stringify(state.db.query("SELECT * FROM meta").all()) +
      JSON.stringify(state.db.query("SELECT * FROM outbox").all());
    for (const secret of ["org_1", "acme", KEY])
      expect(dump).not.toContain(secret);
  });

  test("事务中途失败时整体回滚", async () => {
    const state = openState();
    const { fetch } = commandCodeApi();
    const original = state.recordQuota.bind(state);
    state.recordQuota = () => {
      throw new Error("disk full");
    };
    await expect(
      maybeRefreshCommandCodeQuota(state, null, refreshOptions(fetch, T0)),
    ).rejects.toThrow("disk full");
    state.recordQuota = original;
    expect(state.getMeta(commandCodeIdentityMetaKey("commandcode"))).toBeNull();
    expect(state.getMeta(COMMAND_CODE_PLANS_META)).toBeNull();
    expect(state.account("commandcode")).toBeNull();
    expect(queuedQuotas(state)).toEqual([]);
  });

  test("最短 4 分钟尝试间隔，失败也计入；相同百分比推进采样时间", async () => {
    const state = openState();
    const { api, calls, fetch } = commandCodeApi();
    await maybeRefreshCommandCodeQuota(state, null, refreshOptions(fetch, T0));
    const whoamiCalls = () =>
      calls.filter((call) => call.path === "/alpha/whoami").length;
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        null,
        refreshOptions(fetch, T0 + COMMAND_CODE_MIN_INTERVAL_MS - 1),
      ),
    ).toMatchObject({ attempted: false, status: "cooldown" });
    expect(whoamiCalls()).toBe(1);
    const later = T0 + COMMAND_CODE_MIN_INTERVAL_MS;
    await maybeRefreshCommandCodeQuota(
      state,
      null,
      refreshOptions(fetch, later),
    );
    const monthly = queuedQuotas(state).filter(
      (quota) => quota.window === "monthly",
    );
    expect(monthly.map((quota) => [quota.percent, quota.sampledAt])).toEqual([
      [25, new Date(T0).toISOString()],
      [25, new Date(later).toISOString()],
    ]);
    // 失败也计入间隔。
    api.whoamiStatus = 500;
    const failedAt = later + COMMAND_CODE_MIN_INTERVAL_MS;
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        null,
        refreshOptions(fetch, failedAt),
      ),
    ).toEqual({ attempted: true, status: "http", quotas: 0 });
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        null,
        refreshOptions(fetch, failedAt + 1000),
      ),
    ).toMatchObject({ attempted: false, status: "cooldown" });
    // 失败保留上一次有效采样。
    expect(queuedQuotas(state)).toHaveLength(4);
  });

  test("同一次观测重放保留原采样时间与哈希，不重复入队", async () => {
    const state = openState();
    const quota = {
      accountExternalId: "commandcode",
      window: "monthly" as const,
      percent: 10,
      sampledAt: new Date(T0).toISOString(),
      resetsAt: null,
      windowMinutes: null,
    };
    const identity = { platform: "commandcode" as const, subjectKey: DIGEST };
    expect(
      state.recordQuota(
        { hash: "h1", quotas: [quota] },
        "commandcode:commandcode",
        identity,
      ),
    ).toBe(true);
    expect(
      state.recordQuota(
        { hash: "h1", quotas: [quota] },
        "commandcode:commandcode",
        identity,
      ),
    ).toBe(false);
    expect(queuedQuotas(state)).toHaveLength(1);
    expect(queuedQuotas(state)[0]!.sampledAt).toBe(quota.sampledAt);
  });

  test("401/403 进入冷却且不换其他存储的凭据", async () => {
    const home = tempDir("meterleaf-cc-home-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "auth.json"),
      JSON.stringify({ commandcode: "second-key" }),
    );
    const state = openState();
    const { calls, fetch } = commandCodeApi({ whoamiStatus: 401 });
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        null,
        refreshOptions(fetch, T0, { COMMAND_CODE_API_KEY: KEY }, home),
      ),
    ).toEqual({ attempted: true, status: "rejected", quotas: 0 });
    expect(calls.map((call) => call.auth)).toEqual([`Bearer ${KEY}`]);
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        null,
        refreshOptions(
          fetch,
          T0 + COMMAND_CODE_MIN_INTERVAL_MS + 1,
          { COMMAND_CODE_API_KEY: KEY },
          home,
        ),
      ),
    ).toMatchObject({ attempted: false, status: "cooldown" });
    expect(calls).toHaveLength(1);
  });

  test("过期凭据不联网；显式 authFile 不顺延", async () => {
    const home = tempDir("meterleaf-cc-home-");
    const authFile = join(home, "cc.json");
    writeFileSync(
      authFile,
      JSON.stringify({ apiKey: { access: "x", expires: T0 - 1 } }),
    );
    const state = openState();
    const { calls, fetch } = commandCodeApi();
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        { commandcode: { enabled: true, authFile } },
        refreshOptions(fetch, T0),
      ),
    ).toEqual({ attempted: false, status: "expired", quotas: 0 });
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        { commandcode: { enabled: true, authFile: join(home, "none.json") } },
        refreshOptions(fetch, T0),
      ),
    ).toEqual({ attempted: false, status: "no-credential", quotas: 0 });
    expect(calls).toHaveLength(0);
  });

  test("显式套餐优先；规则未写死时采用观测并缓存，缺 planId 沿用缓存", async () => {
    const explicit = openState();
    const first = commandCodeApi({ planId: "max" });
    await maybeRefreshCommandCodeQuota(
      explicit,
      {
        channelAccounts: [
          { ...DEFAULT_CHANNEL_ACCOUNTS.at(-1)!, plan: "team" },
        ],
      },
      refreshOptions(first.fetch, T0),
    );
    expect(explicit.account("commandcode")!.plan).toBe("team");

    const state = openState();
    const api = commandCodeApi({ planId: "max" });
    await maybeRefreshCommandCodeQuota(
      state,
      null,
      refreshOptions(api.fetch, T0),
    );
    expect(state.account("commandcode")!.plan).toBe("max");
    api.api.planId = undefined;
    await maybeRefreshCommandCodeQuota(
      state,
      null,
      refreshOptions(api.fetch, T0 + COMMAND_CODE_MIN_INTERVAL_MS),
    );
    expect(state.account("commandcode")!.plan).toBe("max");
    // omp、OpenCode、Codex 写同一账户时保留缓存的套餐与主体。
    state.upsertAccount({
      externalId: "commandcode",
      name: "Command Code",
      platform: "commandcode",
      kind: "subscription",
      plan: null,
      subjectKey: null,
    });
    expect(state.account("commandcode")).toMatchObject({
      plan: "max",
      subjectKey: DIGEST,
    });
  });

  test("首次绑定时没有 planId，主体摘要仍落盘", async () => {
    const state = openState();
    const { fetch } = commandCodeApi({ planId: undefined });
    await maybeRefreshCommandCodeQuota(state, null, refreshOptions(fetch, T0));
    expect(state.account("commandcode")).toMatchObject({
      plan: null,
      subjectKey: DIGEST,
    });
    expect(state.getMeta(COMMAND_CODE_PLANS_META)).toBeNull();
  });

  test("凭据换成其他组织时拒绝写入额度与套餐", async () => {
    const state = openState();
    const { api, fetch } = commandCodeApi();
    await maybeRefreshCommandCodeQuota(state, null, refreshOptions(fetch, T0));
    const before = queuedQuotas(state).length;
    api.whoami = { org: { id: "org_2", login: "other" } };
    api.planId = "enterprise";
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        null,
        refreshOptions(fetch, T0 + COMMAND_CODE_MIN_INTERVAL_MS),
      ),
    ).toEqual({ attempted: true, status: "identity-changed", quotas: 0 });
    expect(queuedQuotas(state)).toHaveLength(before);
    expect(state.account("commandcode")).toMatchObject({
      plan: "pro",
      subjectKey: DIGEST,
    });
    expect(state.getMeta(commandCodeIdentityMetaKey("commandcode"))).toBe(
      DIGEST,
    );
    void OTHER_DIGEST;
  });

  test("停用后零供应商请求，排空后再刷新不新增月度额度", async () => {
    const state = openState();
    const { calls, fetch } = commandCodeApi();
    // 启用期间真实入队一条带冻结身份的月度额度。
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        null,
        refreshOptions(fetch, T0),
      ),
    ).toMatchObject({ attempted: true, status: "ok" });
    expect(queuedQuotas(state).map((quota) => quota.window)).toContain(
      "monthly",
    );
    const providerCallsBefore = calls.length;

    const root = tempDir("meterleaf-cc-rollback-");
    const sessionsDir = join(root, "sessions");
    mkdirSync(join(sessionsDir, "w"), { recursive: true });
    writeFileSync(
      join(sessionsDir, "w", "a.jsonl"),
      JSON.stringify({
        type: "message",
        id: "go-1",
        message: {
          role: "assistant",
          provider: "opencode-go",
          model: "glm-5",
          completedAt: Date.parse("2026-10-30T10:00:00Z"),
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        },
      }) + "\n",
    );
    const server = fakeMeterleaf();
    // 其余来源停用或指向临时目录，测试不读取本机真实记录。
    const disabled = collectorConfig(server.url, {
      commandcode: { enabled: false },
      codex: { enabled: false },
      opencode: { enabled: false },
      agy: { enabled: false, statuslineDir: join(root, "statusline") },
      omp: { enabled: true, sessionsDir },
    });
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        disabled,
        refreshOptions(fetch, T0 + COMMAND_CODE_MIN_INTERVAL_MS),
      ),
    ).toEqual({ attempted: false, status: "disabled", quotas: 0 });
    expect(calls).toHaveLength(providerCallsBefore);

    // 停用不丢弃已入队的额度：兼容服务端照常接收并排空。
    const drained = await pushOutbox(state, disabled);
    expect(drained).toMatchObject({ droppedQuotas: 0, error: null });
    expect(state.pendingCounts().quota).toBe(0);
    const monthlyAt = () =>
      server.batches
        .flatMap((batch) => batch.quotas)
        .filter((quota) => quota.window === "monthly").length;
    expect(monthlyAt()).toBe(1);

    // 之后按 sync 的顺序读取、刷新额度、推送：只带普通用量，不再新增月度额度。
    await readNewSources(state, disabled, { allowQuotaRefresh: true });
    expect(
      await maybeRefreshCommandCodeQuota(
        state,
        disabled,
        refreshOptions(fetch, T0 + 2 * COMMAND_CODE_MIN_INTERVAL_MS),
      ),
    ).toEqual({ attempted: false, status: "disabled", quotas: 0 });
    const again = await pushOutbox(state, disabled);
    expect(again).toMatchObject({ quotas: 0, error: null });
    expect(again.usage).toBeGreaterThan(0);
    expect(monthlyAt()).toBe(1);
    expect(calls).toHaveLength(providerCallsBefore);
  });

  test("状态写入失败时记为 storage-error，不保留上一次的成功状态", async () => {
    const state = openState();
    const { fetch } = commandCodeApi();
    await maybeRefreshCommandCodeQuota(state, null, refreshOptions(fetch, T0));
    expect(state.getMeta(COMMAND_CODE_STATUS_META)).toBe("ok");
    markCommandCodeStorageError(state);
    expect(state.getMeta(COMMAND_CODE_STATUS_META)).toBe("storage-error");
    expect(commandCodeStatusText("storage-error")).toBe("本地状态写入失败");
  });

  test("规则写死套餐时不缓存观测到的 planId", async () => {
    const state = openState();
    const { fetch } = commandCodeApi({ planId: "max" });
    await maybeRefreshCommandCodeQuota(
      state,
      {
        channelAccounts: [
          { ...DEFAULT_CHANNEL_ACCOUNTS.at(-1)!, plan: "team" },
        ],
      },
      refreshOptions(fetch, T0),
    );
    expect(state.account("commandcode")!.plan).toBe("team");
    expect(state.getMeta(COMMAND_CODE_PLANS_META)).toBeNull();
    // 规则改回 null 后不冒出过时的 max。
    state.upsertAccount({
      externalId: "commandcode",
      name: "Command Code",
      platform: "commandcode",
      kind: "subscription",
      plan: null,
      subjectKey: DIGEST,
    });
    expect(state.account("commandcode")!.plan).toBeNull();
  });

  test("账户 id 与 planId 为原型键时套餐缓存按普通字符串处理", async () => {
    const state = openState();
    const { fetch } = commandCodeApi({ planId: "constructor" });
    const rule = {
      ...DEFAULT_CHANNEL_ACCOUNTS.at(-1)!,
      id: "constructor",
      plan: null,
    };
    const result = await maybeRefreshCommandCodeQuota(
      state,
      { channelAccounts: [rule] },
      refreshOptions(fetch, T0),
    );
    expect(result).toMatchObject({ attempted: true, status: "ok" });
    expect(state.account("constructor")).toMatchObject({
      platform: "commandcode",
      plan: "constructor",
    });
    expect(JSON.parse(state.getMeta(COMMAND_CODE_PLANS_META)!)).toEqual({
      constructor: "constructor",
    });
    // 原型键也不会被当成已缓存的套餐。
    const fresh = openState();
    fresh.upsertAccount({
      externalId: "toString",
      name: "x",
      platform: "commandcode",
      kind: "subscription",
      plan: null,
      subjectKey: null,
    });
    expect(fresh.account("toString")!.plan).toBeNull();
  });
});

interface FakeMeterleaf {
  url: string;
  batches: IngestBatch[];
  bodies: string[];
}

function fakeMeterleaf(): FakeMeterleaf {
  const batches: IngestBatch[] = [];
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== INGEST_BATCHES_PATH)
        return new Response("not found", { status: 404 });
      const body = await request.text();
      const parsed = ingestBatchSchema.safeParse(JSON.parse(body));
      if (!parsed.success)
        return Response.json({ error: parsed.error.message }, { status: 400 });
      bodies.push(body);
      batches.push(parsed.data);
      return Response.json({ batchId: parsed.data.batchId, accepted: {} });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, batches, bodies };
}

const KEY_INGEST = "mlk_test-key-not-a-secret";
function collectorConfig(server: string, extra: Partial<CollectorConfig> = {}) {
  return {
    server,
    sourceId: "mac",
    key: KEY_INGEST,
    createdAt: "2026-09-01T00:00:00Z",
    ...extra,
  } as CollectorConfig;
}

function ccAccount(subjectKey: string | null = DIGEST): IngestAccount {
  return {
    externalId: "commandcode",
    name: "Command Code",
    platform: "commandcode",
    kind: "subscription",
    plan: "pro",
    subjectKey,
  };
}

function usage(id: string, account: string): IngestUsage {
  return {
    externalId: id,
    occurredAt: "2026-11-10T00:00:00.000Z",
    accountExternalId: account,
    model: "deepseek-v4.1-flash",
    tier: null,
    tokens: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    metadata: { origin: "omp_local" },
  };
}

function seedQuota(state: CollectorState, subjectKey = DIGEST, sampledAt = T0) {
  state.recordQuota(
    {
      hash: `h-${subjectKey}-${sampledAt}`,
      quotas: [
        {
          accountExternalId: "commandcode",
          window: "monthly",
          percent: 40,
          sampledAt: new Date(sampledAt).toISOString(),
          resetsAt: "2026-12-01T00:00:00.000Z",
          windowMinutes: 43200,
        },
      ],
    },
    "commandcode:commandcode",
    { platform: "commandcode", subjectKey },
  );
}

describe("pushOutbox 采样身份守卫", () => {
  test("发出的额度剥离本机字段，且与匹配的账户条目同批", async () => {
    const server = fakeMeterleaf();
    const state = openState();
    state.upsertAccount(ccAccount());
    seedQuota(state);
    const result = await pushOutbox(state, collectorConfig(server.url));
    expect(result).toMatchObject({ quotas: 1, droppedQuotas: 0, error: null });
    expect(server.bodies[0]).not.toContain("_identity");
    expect(server.batches[0]!.accounts).toEqual([ccAccount()]);
    expect(server.batches[0]!.quotas[0]).toMatchObject({
      window: "monthly",
      percent: 40,
    });
  });

  test("账户名额已满时额度顺延到下一批，并与账户条目一同抵达", async () => {
    const server = fakeMeterleaf();
    const state = openState();
    state.upsertAccount(ccAccount());
    state.acknowledge(state.pending("account", 10).map((item) => item.seq));
    state.upsertAccount({
      ...ccAccount(null),
      externalId: "other",
      platform: "openai",
      plan: null,
    });
    seedQuota(state);
    state.recordSourceUsage("omp", usage("u1", "other"));
    const result = await pushOutbox(state, collectorConfig(server.url), {
      limits: { accounts: 1 },
    });
    expect(result.error).toBeNull();
    expect(server.batches).toHaveLength(2);
    expect(server.batches[0]!.quotas).toEqual([]);
    expect(server.batches[0]!.accounts.map((item) => item.externalId)).toEqual([
      "other",
    ]);
    expect(server.batches[1]!.quotas).toHaveLength(1);
    expect(server.batches[1]!.accounts).toEqual([ccAccount()]);
    expect(state.pendingCounts()).toMatchObject({
      quota: 0,
      usage: 0,
      account: 0,
    });
  });

  test("离线期间账户被改为其他平台或其他主体时丢弃旧额度，普通用量照常推送", async () => {
    for (const rewrite of [
      { ...ccAccount(null), platform: "openai" },
      ccAccount(OTHER_DIGEST),
    ]) {
      const server = fakeMeterleaf();
      const state = openState();
      state.upsertAccount(ccAccount());
      seedQuota(state);
      // 改写同一 id 的账户资料。
      state.upsertAccount(rewrite);
      state.recordSourceUsage("omp", usage("u1", "commandcode"));
      const warnings: string[] = [];
      const result = await pushOutbox(state, collectorConfig(server.url), {
        warn: (message) => warnings.push(message),
      });
      expect(result).toMatchObject({
        droppedQuotas: 1,
        quotas: 0,
        usage: 1,
        error: null,
      });
      expect(server.batches).toHaveLength(1);
      expect(server.batches[0]!.quotas).toEqual([]);
      expect(server.batches[0]!.accounts).toEqual([rewrite]);
      expect(state.pendingCounts()).toMatchObject({ quota: 0, usage: 0 });
      expect(warnings.join("")).toContain("command_code.quota_dropped");
      expect(warnings.join("")).not.toContain(DIGEST);
    }
  });

  test("配置已把账户改为其他平台时，没有新用量也丢弃旧额度；仅停用 Command Code 仍照常排空", async () => {
    const openaiRule = {
      ...DEFAULT_CHANNEL_ACCOUNTS.at(-1)!,
      platform: "openai",
    };
    for (const extra of [
      { channelAccounts: [openaiRule] },
      {
        modelAccounts: [
          {
            id: "commandcode",
            name: "Command Code",
            platform: "openai",
            kind: "subscription" as const,
            plan: null,
          },
        ],
      },
    ]) {
      const server = fakeMeterleaf();
      const state = openState();
      state.upsertAccount(ccAccount());
      seedQuota(state);
      const result = await pushOutbox(
        state,
        collectorConfig(server.url, extra as Partial<CollectorConfig>),
        { warn: () => {} },
      );
      expect(result).toMatchObject({ droppedQuotas: 1, error: null });
      expect(server.batches.flatMap((batch) => batch.quotas)).toEqual([]);
      expect(state.pendingCounts().quota).toBe(0);
    }
    const server = fakeMeterleaf();
    const state = openState();
    state.upsertAccount(ccAccount());
    seedQuota(state);
    const result = await pushOutbox(
      state,
      collectorConfig(server.url, { commandcode: { enabled: false } }),
    );
    expect(result).toMatchObject({ quotas: 1, droppedQuotas: 0, error: null });
    expect(state.pendingCounts().quota).toBe(0);
  });

  test("丢弃旧额度的告警写入失败时，同批普通用量照常推送", async () => {
    const server = fakeMeterleaf();
    const state = openState();
    state.upsertAccount(ccAccount());
    seedQuota(state);
    state.upsertAccount({ ...ccAccount(null), platform: "openai" });
    state.recordSourceUsage("omp", usage("u1", "commandcode"));
    const result = await pushOutbox(state, collectorConfig(server.url), {
      warn: () => {
        throw new Error("log append failed");
      },
    });
    expect(result).toMatchObject({ droppedQuotas: 1, usage: 1, error: null });
    expect(state.pendingCounts()).toMatchObject({ quota: 0, usage: 0 });
  });

  test("账户已不存在时丢弃，不会无限重试", async () => {
    const server = fakeMeterleaf();
    const state = openState();
    seedQuota(state);
    const result = await pushOutbox(state, collectorConfig(server.url), {
      warn: () => {},
    });
    expect(result).toMatchObject({ droppedQuotas: 1, batches: 0, error: null });
    expect(state.pendingCounts().quota).toBe(0);
  });
});

describe("omp 渠道规则补录", () => {
  function workspace() {
    const root = tempDir("meterleaf-cc-omp-");
    const sessionsDir = join(root, "sessions");
    mkdirSync(join(sessionsDir, "w"), { recursive: true });
    return {
      sessionsDir,
      credentialsDb: join(root, "agent.db"),
      statuslineDir: join(root, "statusline"),
    };
  }
  const message = (
    id: string,
    provider: string,
    model: string,
    minute: number,
  ) =>
    JSON.stringify({
      type: "message",
      id,
      message: {
        role: "assistant",
        provider,
        model,
        completedAt: Date.parse("2026-10-30T10:00:00Z") + minute * 60_000,
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      },
    }) + "\n";
  const read = (
    state: CollectorState,
    dirs: ReturnType<typeof workspace>,
    rules: readonly ChannelAccountRule[],
    maxBytes?: number,
  ) =>
    readOmp(
      state,
      { ...dirs, start: SOURCE_START, channelAccounts: rules },
      maxBytes,
    );
  const noCommandCode = DEFAULT_CHANNEL_ACCOUNTS.filter(
    (rule) => rule.channel !== "commandcode",
  );
  const usages = (state: CollectorState) =>
    state.pending<IngestUsage>("usage", 1000).map((item) => item.payload);

  test("规则新增 commandcode 后补录已推进游标、曾因无路由跳过的请求，并按 deepseek 计价", async () => {
    const dirs = workspace();
    writeFileSync(
      join(dirs.sessionsDir, "w", "a.jsonl"),
      message("m1", "commandcode", "deepseek/deepseek-v4.1-flash", 0) +
        message("m2", "opencode-go", "glm-5", 1),
    );
    const state = openState();
    const first = await read(state, dirs, noCommandCode);
    expect(first.skipped).toEqual({ commandcode: 1 });
    expect(usages(state).map((item) => item.accountExternalId)).toEqual([
      "opencode-go",
    ]);
    expect(state.getMeta(OMP_RULES_DIGEST_META)).toBe(
      ompRulesDigest(noCommandCode),
    );
    // 游标已推进：同规则再读不会补上。
    await read(state, dirs, noCommandCode);
    expect(usages(state)).toHaveLength(1);
    // 换成默认规则：从头重读，补上 commandcode 请求；已入账的 opencode-go 请求不重复。
    const second = await read(state, dirs, DEFAULT_CHANNEL_ACCOUNTS);
    expect(second.recorded).toBe(1);
    const recorded = usages(state);
    expect(recorded.map((item) => item.accountExternalId)).toEqual([
      "opencode-go",
      "commandcode",
    ]);
    expect(state.getMeta(OMP_RULES_DIGEST_META)).toBe(
      ompRulesDigest(DEFAULT_CHANNEL_ACCOUNTS),
    );
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBeNull();
    expect(state.account("commandcode")).toMatchObject({
      platform: "commandcode",
      plan: null,
    });
    const fact: UsageFact = {
      ...recorded[1]!,
      sourceId: "mac",
      upstreamModel: null,
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
    };
    expect(fact.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(valueUsage(fact, defaultPriceBook).usd.amount).not.toBeNull();
  });

  test("已由自定义规则归账的请求保持原归属", async () => {
    const dirs = workspace();
    writeFileSync(
      join(dirs.sessionsDir, "w", "a.jsonl"),
      message("m1", "commandcode", "deepseek/deepseek-v4.1-flash", 0),
    );
    const state = openState();
    const customRules: ChannelAccountRule[] = [
      {
        source: "omp",
        channel: "commandcode",
        id: "my-cc",
        name: "My CC",
        platform: "commandcode",
        kind: "subscription",
        plan: "max",
      },
    ];
    await read(state, dirs, customRules);
    await read(state, dirs, DEFAULT_CHANNEL_ACCOUNTS);
    expect(usages(state).map((item) => item.accountExternalId)).toEqual([
      "my-cc",
    ]);
  });

  test("超过单轮预算顺延，中途重启续扫完成后才提交", async () => {
    const dirs = workspace();
    for (const name of ["a", "b", "c"])
      writeFileSync(
        join(dirs.sessionsDir, "w", `${name}.jsonl`),
        message(`m-${name}`, "commandcode", "deepseek/deepseek-v4.1-flash", 0),
      );
    const root = tempDir("meterleaf-cc-state-");
    const path = join(root, "state.sqlite");
    let state = new CollectorState(path);
    const digest = ompRulesDigest(DEFAULT_CHANNEL_ACCOUNTS);
    const first = await read(state, dirs, DEFAULT_CHANNEL_ACCOUNTS, 1);
    expect(first.deferred).toBe(true);
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBe(digest);
    expect(state.getMeta(OMP_RULES_DIGEST_META)).toBeNull();
    state.close();
    // 重启后续扫，不清空已有进度。
    state = new CollectorState(path);
    cleanup.push(() => state.close());
    const second = await read(state, dirs, DEFAULT_CHANNEL_ACCOUNTS, 1);
    expect(second.filesRead).toBe(1);
    expect(second.deferred).toBe(true);
    const third = await read(state, dirs, DEFAULT_CHANNEL_ACCOUNTS, 1);
    expect(third.deferred).toBe(false);
    expect(state.getMeta(OMP_RULES_DIGEST_META)).toBe(digest);
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBeNull();
    expect(usages(state)).toHaveLength(3);
  });

  test("A → B（未完成）→ A → B 每次切换都清空进度，最终按 B 完成；切回 A 扫完也清除进行中标记", async () => {
    const dirs = workspace();
    for (const name of ["a", "b"])
      writeFileSync(
        join(dirs.sessionsDir, "w", `${name}.jsonl`),
        message(`m-${name}`, "commandcode", "deepseek/deepseek-v4.1-flash", 0),
      );
    const rulesA = DEFAULT_CHANNEL_ACCOUNTS;
    const rulesB = DEFAULT_CHANNEL_ACCOUNTS.map((rule) =>
      rule.channel === "commandcode" ? { ...rule, name: "CC renamed" } : rule,
    );
    const digestA = ompRulesDigest(rulesA);
    const digestB = ompRulesDigest(rulesB);
    const state = openState();
    /** 单轮预算只够读一个文件；未变化的文件不耗预算，最多若干轮读完。 */
    const finish = async (rules: readonly ChannelAccountRule[]) => {
      for (let round = 0; round < 10; round++)
        if (!(await read(state, dirs, rules, 1)).deferred) return round + 1;
      throw new Error("never finished");
    };
    // 完成 A。
    await finish(rulesA);
    expect(state.getMeta(OMP_RULES_DIGEST_META)).toBe(digestA);
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBeNull();
    // A → B（未完成）。
    const b1 = await read(state, dirs, rulesB, 1);
    expect(b1).toMatchObject({ filesRead: 1, deferred: true });
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBe(digestB);
    // 切回 A：进行中的 B 失效，重新从头读。
    const a2 = await read(state, dirs, rulesA, 1);
    expect(a2).toMatchObject({ filesRead: 1, deferred: true });
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBe(digestA);
    expect(state.getMeta(OMP_RULES_DIGEST_META)).toBe(digestA);
    // 再切到 B 并读完。
    const b2 = await read(state, dirs, rulesB, 1);
    expect(b2.filesRead).toBe(1);
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBe(digestB);
    await finish(rulesB);
    expect(state.getMeta(OMP_RULES_DIGEST_META)).toBe(digestB);
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBeNull();
    // B 完成后再切回 A 并扫完：提交 A，清除进行中标记。
    const a3 = await read(state, dirs, rulesA, 1);
    expect(a3).toMatchObject({ filesRead: 1, deferred: true });
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBe(digestA);
    await finish(rulesA);
    expect(state.getMeta(OMP_RULES_DIGEST_META)).toBe(digestA);
    expect(state.getMeta(OMP_RULES_PENDING_META)).toBeNull();
    // 稳定后增量读取不重读文件。
    const stable = await read(state, dirs, rulesA, 1);
    expect(stable.filesRead).toBe(0);
    // 全程同一请求只入账一次。
    expect(usages(state)).toHaveLength(2);
  });

  test("omp 写 Command Code 账户时保留缓存的套餐与主体，显式套餐优先", async () => {
    const dirs = workspace();
    writeFileSync(
      join(dirs.sessionsDir, "w", "a.jsonl"),
      message("m1", "commandcode", "deepseek/deepseek-v4.1-flash", 0),
    );
    const state = openState();
    state.setMeta(
      COMMAND_CODE_PLANS_META,
      JSON.stringify({ commandcode: "pro" }),
    );
    state.setMeta(commandCodeIdentityMetaKey("commandcode"), DIGEST);
    await read(state, dirs, DEFAULT_CHANNEL_ACCOUNTS);
    expect(state.account("commandcode")).toMatchObject({
      plan: "pro",
      subjectKey: DIGEST,
    });
    const explicit = DEFAULT_CHANNEL_ACCOUNTS.map((rule) =>
      rule.channel === "commandcode" ? { ...rule, plan: "team" } : rule,
    );
    await read(state, dirs, explicit);
    expect(state.account("commandcode")).toMatchObject({
      plan: "team",
      subjectKey: DIGEST,
    });
  });
});

describe("命令行网络边界", () => {
  /** 在进程内运行采集器命令，拦截全部 fetch：Meterleaf 请求转发到本地假服务，其余记录后按桩返回。 */
  async function runCli(
    args: string[],
    options: {
      config?: Partial<CollectorConfig>;
      server?: FakeMeterleaf;
      api?: ReturnType<typeof commandCodeApi>;
      /** 运行前对临时数据目录做准备，例如预置本地状态。 */
      prepare?: (data: string) => void;
      /** 模拟标准错误写入失败：返回 true 的行在写入时抛错。 */
      stderrFails?: (line: string) => boolean;
    } = {},
  ) {
    const root = tempDir("meterleaf-cc-cli-");
    const home = join(root, "home");
    const data = join(root, "data");
    mkdirSync(join(home, ".commandcode"), { recursive: true });
    mkdirSync(join(root, "claude"), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(home, ".commandcode", "auth.json"),
      JSON.stringify({ apiKey: KEY }),
    );
    // 一条普通 omp 用量，用来确认 sync 照常推送 Meterleaf。
    mkdirSync(join(home, ".omp", "agent", "sessions", "w"), {
      recursive: true,
    });
    writeFileSync(
      join(home, ".omp", "agent", "sessions", "w", "a.jsonl"),
      JSON.stringify({
        type: "message",
        id: "go-1",
        message: {
          role: "assistant",
          provider: "opencode-go",
          model: "glm-5",
          completedAt: Date.parse("2026-10-30T10:00:00Z"),
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        },
      }) + "\n",
    );
    // 其余来源一律停用或指向临时目录，测试不读取本机真实记录。
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify(
        collectorConfig(options.server?.url ?? "http://127.0.0.1:9", {
          codex: { enabled: false },
          opencode: { enabled: false },
          agy: { enabled: false },
          omp: {
            enabled: true,
            sessionsDir: join(home, ".omp", "agent", "sessions"),
          },
          ...options.config,
        }),
      ),
    );
    options.prepare?.(data);
    const providerCalls: string[] = [];
    const meterleafCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const api = options.api ?? commandCodeApi();
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") {
        meterleafCalls.push(url.pathname);
        return originalFetch(input, init);
      }
      providerCalls.push(url.href);
      return api.fetch(url, init);
    }) as typeof fetch;
    process.env.HOME = home;
    process.env.METERLEAF_COLLECTOR_HOME = data;
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    delete process.env.COMMAND_CODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    delete process.env.CODEX_HOME;
    delete process.env.XDG_CACHE_HOME;
    const log = console.log;
    const error = console.error;
    const output: string[] = [];
    console.log = (...items: unknown[]) => output.push(items.join(" "));
    console.error = (...items: unknown[]) => {
      const line = items.join(" ");
      if (options.stderrFails?.(line)) throw new Error("log append failed");
      output.push(line);
    };
    try {
      const code = await main(args);
      return {
        code,
        providerCalls,
        meterleafCalls,
        output: output.join("\n"),
        data,
      };
    } finally {
      console.log = log;
      console.error = error;
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env))
        if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  }

  test("scan 与 status 不发出任何网络请求", async () => {
    const server = fakeMeterleaf();
    const scan = await runCli(["scan"], { server });
    expect(scan.code).toBe(0);
    expect(scan.providerCalls).toEqual([]);
    expect(scan.meterleafCalls).toEqual([]);
    const status = await runCli(["status"], { server });
    expect(status.code).toBe(0);
    expect(status.providerCalls).toEqual([]);
    expect(status.meterleafCalls).toEqual([]);
  });

  test("默认启用时 sync 读取额度并随账户推送；读取失败不阻塞用量推送", async () => {
    const server = fakeMeterleaf();
    const sync = await runCli(["sync"], { server });
    expect(sync.code).toBe(0);
    expect(
      sync.providerCalls.every((href) =>
        href.startsWith("https://api.commandcode.ai/"),
      ),
    ).toBe(true);
    expect(sync.providerCalls.length).toBe(4);
    const quotas = server.batches.flatMap((batch) => batch.quotas);
    expect(quotas.map((quota) => quota.window)).toEqual([
      "five-hour",
      "monthly",
    ]);
    expect(server.batches.flatMap((batch) => batch.usage)).toHaveLength(1);
    expect(server.batches.flatMap((batch) => batch.accounts)).toContainEqual(
      expect.objectContaining({
        externalId: "commandcode",
        subjectKey: DIGEST,
      }),
    );

    const failing = fakeMeterleaf();
    const broken = await runCli(["sync"], {
      server: failing,
      api: commandCodeApi({ whoamiStatus: 500 }),
    });
    expect(broken.code).toBe(0);
    expect(failing.batches.flatMap((batch) => batch.usage)).toHaveLength(1);
    expect(failing.batches.flatMap((batch) => batch.quotas)).toEqual([]);
    expect(broken.output).toContain("Command Code 额度读取失败");
    expect(broken.output).not.toContain(KEY);
  });

  test("enabled: false 时零供应商请求，正常 sync 仍推送 Meterleaf", async () => {
    const server = fakeMeterleaf();
    const sync = await runCli(["sync"], {
      server,
      config: { commandcode: { enabled: false } },
    });
    expect(sync.code).toBe(0);
    expect(sync.providerCalls).toEqual([]);
    expect(sync.meterleafCalls).toContain(INGEST_BATCHES_PATH);
    expect(server.batches.flatMap((batch) => batch.usage)).toHaveLength(1);
    expect(server.batches.flatMap((batch) => batch.quotas)).toEqual([]);
    // 状态里登记的停用信息由 status 显示，status 本身不联网。
    const status = await runCli(["status"], {
      server,
      config: { commandcode: { enabled: false } },
    });
    expect(status.output).toContain("Command Code 额度: 已停用");
    expect(status.providerCalls).toEqual([]);
  });

  test("额度写入本地状态时抛错：状态记为 storage-error 替换旧的成功，用量照常推送", async () => {
    const server = fakeMeterleaf();
    const original = CollectorState.prototype.recordQuota;
    CollectorState.prototype.recordQuota = function () {
      throw new Error("disk full");
    };
    let sync: Awaited<ReturnType<typeof runCli>>;
    try {
      sync = await runCli(["sync"], {
        server,
        prepare: (data) => {
          const seeded = new CollectorState(join(data, "state.sqlite"));
          seeded.setMeta(COMMAND_CODE_STATUS_META, "ok");
          seeded.close();
        },
      });
    } finally {
      CollectorState.prototype.recordQuota = original;
    }
    expect(sync.code).toBe(0);
    expect(sync.output).toContain("Command Code 额度状态写入失败: Error");
    expect(sync.output).not.toContain("disk full");
    expect(sync.output).not.toContain(KEY);
    expect(server.batches.flatMap((batch) => batch.usage)).toHaveLength(1);
    expect(server.batches.flatMap((batch) => batch.quotas)).toEqual([]);
    const after = new CollectorState(join(sync.data, "state.sqlite"));
    try {
      expect(after.getMeta(COMMAND_CODE_STATUS_META)).toBe("storage-error");
    } finally {
      after.close();
    }
  });

  test("Command Code 诊断日志写入失败时不阻断普通用量推送", async () => {
    const failsOnCommandCode = (line: string) => line.includes("Command Code");
    // 刷新返回非 ok 时的诊断日志写入失败。
    const refreshFailed = fakeMeterleaf();
    const broken = await runCli(["sync"], {
      server: refreshFailed,
      api: commandCodeApi({ whoamiStatus: 500 }),
      stderrFails: failsOnCommandCode,
    });
    expect(broken.code).toBe(0);
    expect(refreshFailed.batches.flatMap((batch) => batch.usage)).toHaveLength(
      1,
    );
    // 本地状态写入抛错时的诊断日志写入失败。
    const storageFailed = fakeMeterleaf();
    const original = CollectorState.prototype.recordQuota;
    CollectorState.prototype.recordQuota = function () {
      throw new Error("disk full");
    };
    let sync: Awaited<ReturnType<typeof runCli>>;
    try {
      sync = await runCli(["sync"], {
        server: storageFailed,
        stderrFails: failsOnCommandCode,
      });
    } finally {
      CollectorState.prototype.recordQuota = original;
    }
    expect(sync.code).toBe(0);
    expect(storageFailed.batches.flatMap((batch) => batch.usage)).toHaveLength(
      1,
    );
    const after = new CollectorState(join(sync.data, "state.sqlite"));
    try {
      expect(after.getMeta(COMMAND_CODE_STATUS_META)).toBe("storage-error");
    } finally {
      after.close();
    }
  });

  test("help 声明后台外发与停用方式", async () => {
    const help = await runCli(["--help"]);
    expect(help.output).toContain("https://api.commandcode.ai");
    expect(help.output).toContain("4 分钟");
    expect(help.output).toContain('"commandcode": { "enabled": false }');
    expect(help.providerCalls).toEqual([]);
  });

  test("升级前 modelAccounts 已将 commandcode 指向异平台时跳过默认渠道不混账", async () => {
    const legacyConfig = {
      modelAccounts: [
        {
          id: "commandcode",
          name: "Existing OpenAI",
          platform: "openai",
          kind: "subscription" as const,
          plan: "plus",
          match: "gpt-*",
        },
      ],
    };
    const effective = effectiveChannelAccounts(legacyConfig);
    expect(effective.filter((rule) => rule.channel === "commandcode")).toEqual(
      [],
    );
    expect(commandCodeTarget(legacyConfig)).toEqual({
      status: "skip",
      reason: "none",
    });

    const root = tempDir("meterleaf-cc-legacy-model-");
    const sessionsDir = join(root, "sessions");
    mkdirSync(join(sessionsDir, "w"), { recursive: true });
    writeFileSync(
      join(sessionsDir, "w", "a.jsonl"),
      JSON.stringify({
        type: "message",
        id: "cc-1",
        message: {
          role: "assistant",
          provider: "commandcode",
          model: "deepseek/deepseek-v4.1-flash",
          completedAt: Date.parse("2026-10-30T10:00:00Z"),
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
        },
      }) + "\n",
    );
    const state = openState();
    const report = await readOmp(state, {
      sessionsDir,
      credentialsDb: join(root, "missing.db"),
      statuslineDir: join(root, "statusline"),
      start: SOURCE_START,
      channelAccounts: effective,
    });
    expect(report.recorded).toBe(0);
    expect(report.skipped.commandcode).toBe(1);
    expect(state.pending("usage", 10)).toEqual([]);

    // 同 ID 且平台本来就是 commandcode 时仍正常继承名称与套餐。
    const samePlatform = effectiveChannelAccounts({
      modelAccounts: [
        {
          id: "commandcode",
          name: "My Command Code",
          platform: "commandcode",
          kind: "subscription",
          plan: "pro",
          match: "deepseek-*",
        },
      ],
    });
    expect(
      samePlatform.filter((rule) => rule.channel === "commandcode"),
    ).toHaveLength(3);
    expect(
      samePlatform.find(
        (rule) => rule.source === "omp" && rule.channel === "commandcode",
      ),
    ).toMatchObject({
      id: "commandcode",
      name: "My Command Code",
      platform: "commandcode",
      plan: "pro",
    });
  });
});
