import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/collector/collect";
import type { CredentialLocation } from "../src/collector/claude-code/credential";
import type { ModelAccountRule } from "../src/collector/model-accounts";
import { CollectorState } from "../src/collector/state";
import type { IngestQuota, IngestUsage } from "../src/shared/ingest";
import {
  assistantLine,
  FIXTURE_ACCOUNT_UUID,
} from "./fixtures/claude-code/lines";

const PROFILE_ACCOUNT = "dddddddd-4444-4444-8444-444444444444";
const PROFILE_ORG = "eeeeeeee-5555-4555-8555-555555555555";
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function accountBody(
  accountUuid: string,
  options: {
    organizationUuid?: string | null;
    organizationType?: string | null;
    rateLimitTier?: string | null;
    usage?: Record<string, unknown>;
  } = {},
) {
  return {
    oauthAccount: {
      accountUuid,
      organizationUuid:
        options.organizationUuid === undefined
          ? "bbbbbbbb-2222-4222-8222-222222222222"
          : options.organizationUuid,
      organizationType: options.organizationType ?? null,
      organizationRateLimitTier: options.rateLimitTier ?? null,
      billingType: "apple_subscription",
    },
    ...(options.usage
      ? {
          cachedUsageUtilization: {
            fetchedAtMs: Date.parse("2026-10-22T10:00:00Z"),
            accountUuid,
            utilization: options.usage,
          },
        }
      : {}),
  };
}

function workspace(
  options: { profile?: boolean; profileAccount?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-collector-profiles-"));
  temporary.push(root);
  const claudeRoot = join(root, "claude");
  const projectsDir = join(claudeRoot, "projects");
  mkdirSync(join(projectsDir, "p"), { recursive: true });
  const claudeJson = join(claudeRoot, ".claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify(
      accountBody(FIXTURE_ACCOUNT_UUID, {
        organizationType: "claude_max",
        rateLimitTier: "default_claude_max_5x",
      }),
    ),
  );
  const session = join(projectsDir, "p", "s.jsonl");
  writeFileSync(
    session,
    `${assistantLine({
      messageId: "m1",
      timestamp: "2026-10-22T10:01:00Z",
      input: 1,
      output: 2,
    })}\n`,
  );

  const profileDir = join(root, "profiles", "work");
  mkdirSync(profileDir, { recursive: true });
  const profileJson = join(profileDir, ".claude.json");
  let statuslineCache: string | null = null;
  let profileCache = join(profileDir, "rate-limits.tsv");
  if (options.profile) {
    writeFileSync(
      profileJson,
      JSON.stringify(
        accountBody(options.profileAccount ?? PROFILE_ACCOUNT, {
          organizationUuid: PROFILE_ORG,
          usage: {
            five_hour: { utilization: 40, resets_at: "2026-10-22T15:00:00Z" },
            seven_day: { utilization: 60, resets_at: "2026-10-27T08:00:00Z" },
          },
        }),
      ),
    );
    statuslineCache = profileCache;
    writeFileSync(
      profileCache,
      `five_hour\t45\t${Math.floor(Date.parse("2026-10-22T15:00:00Z") / 1000)}\nseven_day\t65\t${Math.floor(Date.parse("2026-10-27T08:00:00Z") / 1000)}\n`,
    );
    const at = new Date("2026-10-22T10:02:00Z");
    utimesSync(profileCache, at, at);
  }

  const credential = {
    location: {
      claudeRoot,
      configDir: null,
    } satisfies CredentialLocation,
    read: (location: CredentialLocation) =>
      location.configDir
        ? JSON.stringify({
            claudeAiOauth: { subscriptionType: "pro", accessToken: "secret" },
          })
        : null,
    version: () => null,
  };
  return {
    root,
    projectsDir,
    claudeJson,
    session,
    profileDir,
    profileJson,
    profileCache,
    statuslineCache,
    credential,
  };
}

const later = () => new Date("2026-10-22T10:03:00Z");

function pendingUsage(state: CollectorState) {
  return new Map(
    state
      .pending<IngestUsage>("usage", 100)
      .map((item) => [item.payload.externalId, item.payload]),
  );
}

function pendingQuotas(state: CollectorState) {
  return state.pending<IngestQuota>("quota", 100).map((item) => item.payload);
}

function ackAll(state: CollectorState) {
  state.acknowledge(
    [
      ...state.pending("usage", 100),
      ...state.pending("account", 100),
      ...state.pending("quota", 100),
    ].map((item) => item.seq),
  );
}

describe("额外 Claude 账户", () => {
  test("读取账户、凭据套餐与两个额度来源，但不写入默认账户的时间线", () => {
    const w = workspace({ profile: true });
    const state = new CollectorState(":memory:");
    const sources = {
      ...w,
      // 该缓存只属于额外账户，默认目录不读它。
      statuslineCache: null,
      claudeProfiles: [
        { configDir: w.profileDir, statuslineCache: w.statuslineCache! },
      ],
    };
    try {
      // 凭据套餐需要连续两轮读到同一账户才采用。
      const first = collect(
        state,
        sources,
        new Date("2026-10-22T10:00:00Z"),
        later,
      );
      expect(first.profiles[0]).toMatchObject({
        credentialPlanPending: true,
        quotaRecorded: true,
        statuslineQuotaRecorded: true,
      });
      const second = collect(
        state,
        sources,
        new Date("2026-10-22T10:05:00Z"),
        later,
      );
      const profile = second.profiles[0]!;
      expect(profile).toMatchObject({
        configDir: w.profileDir,
        accountUuid: PROFILE_ACCOUNT,
        skipped: null,
        plan: "pro",
        // 同一采样第二轮不再上报，但仍可读取。
        quotaRecorded: false,
        quotaSkipped: null,
        statuslineQuotaRecorded: false,
        statuslineQuotaSkipped: null,
      });
      expect(state.account(PROFILE_ACCOUNT)).toEqual({
        externalId: PROFILE_ACCOUNT,
        name: "Claude Code",
        platform: "anthropic",
        kind: "subscription",
        plan: "pro",
        subjectKey: expect.stringMatching(/^sha256:/),
      });
      // 额外账户只出现在 accounts 中，不进入默认目录的登录时间线。
      expect(state.segments().map((segment) => segment.accountUuid)).toEqual([
        FIXTURE_ACCOUNT_UUID,
      ]);
      // 默认账户沿用原来的状态键；额外账户使用带摘要后缀的独立键。
      expect(state.getMeta("credential_plan_check")).not.toBeNull();
      expect(
        state.db
          .query<{ key: string }, []>(
            "SELECT key FROM meta WHERE key LIKE 'credential_plan_check:%'",
          )
          .all(),
      ).toHaveLength(1);
      expect(
        pendingQuotas(state).every(
          (quota) => quota.accountExternalId === PROFILE_ACCOUNT,
        ),
      ).toBe(true);
      expect(
        pendingQuotas(state)
          .map((quota) => quota.window)
          .sort(),
      ).toEqual(["five-hour", "five-hour", "seven-day", "seven-day"]);
      expect(pendingUsage(state).get("req_m1:m1")!.accountExternalId).toBe(
        FIXTURE_ACCOUNT_UUID,
      );
    } finally {
      state.close();
    }
  });

  test("与默认账户相同的目录账户、读不到的目录都只跳过该项", () => {
    const same = workspace({
      profile: true,
      profileAccount: FIXTURE_ACCOUNT_UUID,
    });
    const state = new CollectorState(":memory:");
    try {
      const report = collect(
        state,
        {
          ...same,
          statuslineCache: null,
          claudeProfiles: [{ configDir: same.profileDir }],
        },
        new Date("2026-10-22T10:00:00Z"),
        later,
      );
      expect(report.profiles[0]).toMatchObject({
        skipped: "与默认账户相同",
        accountUuid: FIXTURE_ACCOUNT_UUID,
      });
      expect(report.profiles[0]!.quotaRecorded).toBe(false);
      // 默认账户照常处理。
      expect(report.accountUuid).toBe(FIXTURE_ACCOUNT_UUID);

      const missing = workspace();
      const next = collect(
        state,
        {
          ...missing,
          claudeProfiles: [{ configDir: join(missing.root, "absent") }],
        },
        new Date("2026-10-22T10:05:00Z"),
        later,
      );
      expect(next.profiles[0]!.skipped).toContain("未能读取");
      expect(next.accountUuid).toBe(FIXTURE_ACCOUNT_UUID);
    } finally {
      state.close();
    }
  });

  test("升级后把已有用量按新元数据重发一次", () => {
    const w = workspace();
    const state = new CollectorState(":memory:");
    const sources = { ...w, claudeProfiles: [] };
    try {
      collect(state, sources, new Date("2026-10-22T10:00:00Z"), later);
      ackAll(state);
      // 模拟上一版本留下的状态：事件已推送，但没有记录元数据版本。
      state.db.run("DELETE FROM meta WHERE key='usage_metadata_version'");
      const report = collect(
        state,
        sources,
        new Date("2026-10-22T10:05:00Z"),
        later,
      );
      expect(report.reattributed).toBe(0);
      const usage = pendingUsage(state);
      expect(usage.size).toBe(1);
      expect(usage.get("req_m1:m1")!.metadata.attribution).toBe("timeline");
    } finally {
      state.close();
    }
  });

  test("模型映射的用量标记为 model，时间线归属标记为 timeline", () => {
    const w = workspace();
    const rule: ModelAccountRule = {
      match: "deepseek-*",
      id: "opencode-go",
      name: "OpenCode Go",
      platform: "opencode-go",
      kind: "subscription",
      plan: null,
    };
    writeFileSync(
      w.session,
      [
        assistantLine({
          messageId: "claude",
          timestamp: "2026-10-22T10:01:00Z",
          input: 1,
          output: 2,
        }),
        assistantLine({
          messageId: "deepseek",
          timestamp: "2026-10-22T10:02:00Z",
          input: 3,
          output: 4,
          model: "deepseek-v4.1-flash",
        }),
        "",
      ].join("\n"),
    );
    const state = new CollectorState(":memory:");
    try {
      collect(
        state,
        { ...w, modelAccounts: [rule], claudeProfiles: [] },
        new Date("2026-10-22T10:00:00Z"),
        later,
      );
      const usage = pendingUsage(state);
      expect(usage.get("req_claude:claude")!.metadata.attribution).toBe(
        "timeline",
      );
      expect(usage.get("req_deepseek:deepseek")!.metadata.attribution).toBe(
        "model",
      );
    } finally {
      state.close();
    }
  });
});

describe("claude-profiles 配置命令", () => {
  const repoRoot = join(import.meta.dir, "..");

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

  function cliSetup() {
    const root = mkdtempSync(join(tmpdir(), "meterleaf-profiles-cli-"));
    temporary.push(root);
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      METERLEAF_COLLECTOR_HOME: join(root, "data"),
    };
    mkdirSync(env.HOME);
    const init = run(
      env,
      "init",
      "--server",
      "https://meterleaf.example.com",
      "--source-id",
      "claude-code-test",
    );
    expect(init.code).toBe(0);
    const configPath = join(env.METERLEAF_COLLECTOR_HOME, "config.json");
    return { root, env, configPath };
  }

  test("校验绝对路径、默认目录、重复项与 off", () => {
    const { root, env, configPath } = cliSetup();
    const first = join(root, "profiles", "one");
    const second = join(root, "profiles", "two");
    for (const dir of [first, second]) mkdirSync(dir, { recursive: true });

    expect(run(env, "claude-profiles", "relative/path").code).toBe(2);
    expect(run(env, "claude-profiles", join(env.HOME, ".claude")).code).toBe(2);
    expect(run(env, "claude-profiles", first, first).code).toBe(2);
    expect(run(env, "claude-profiles", `${first}=relative-cache`).code).toBe(2);
    expect(run(env, "claude-profiles", first, "off").code).toBe(2);

    expect(
      run(env, "claude-profiles", first, `${second}=${second}.tsv`).code,
    ).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.claudeProfiles).toEqual([
      { configDir: first },
      { configDir: second, statuslineCache: `${second}.tsv` },
    ]);

    // 用户在切换账户的 shell 里导出了 CLAUDE_CONFIG_DIR，不应把该目录误判为默认目录。
    const switched = { ...env, CLAUDE_CONFIG_DIR: second };
    expect(run(switched, "claude-profiles", second).code).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).claudeProfiles).toEqual(
      [{ configDir: second }],
    );

    expect(run(env, "claude-profiles", "off").code).toBe(0);
    expect(
      JSON.parse(readFileSync(configPath, "utf8")).claudeProfiles,
    ).toBeUndefined();
  });

  test("otel-headers 只输出一行鉴权请求头，未初始化时报错", () => {
    const root = mkdtempSync(join(tmpdir(), "meterleaf-otel-headers-"));
    temporary.push(root);
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      METERLEAF_COLLECTOR_HOME: join(root, "data"),
    };
    mkdirSync(env.HOME);

    const missing = run(env, "otel-headers");
    expect(missing.code).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).not.toBe("");

    run(env, "init", "--server", "https://meterleaf.example.com");
    const config = JSON.parse(
      readFileSync(join(env.METERLEAF_COLLECTOR_HOME, "config.json"), "utf8"),
    );
    const headers = run(env, "otel-headers");
    expect(headers.code).toBe(0);
    expect(headers.stdout).toBe(
      `${JSON.stringify({ Authorization: `Bearer ${config.key}` })}\n`,
    );
    expect(headers.stderr).toBe("");
  });
});
