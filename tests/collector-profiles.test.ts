import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, discoverClaudeProfiles } from "../src/collector/collect";
import {
  readCredentialText,
  readCredentialVersion,
  type CredentialLocation,
} from "../src/collector/claude-code/credential";
import type { ModelAccountRule } from "../src/collector/model-accounts";
import { CollectorState } from "../src/collector/state";
import {
  INGEST_BATCHES_PATH,
  type IngestQuota,
  type IngestUsage,
} from "../src/shared/ingest";
import {
  QUOTA_SUMMARY_PATH,
  QUOTA_SUMMARY_SCHEMA_VERSION,
} from "../src/shared/quota-summary";
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

describe("claude.profilesDir 独占目录采集与状态清理", () => {
  const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
  const OUTSIDE_ACCOUNT = "33333333-3333-4333-8333-333333333333";

  test("只动态发现 profilesDir 内有效子目录，忽略脚本、备份、软链接越界与无 .claude.json 的目录", () => {
    const root = mkdtempSync(join(tmpdir(), "meterleaf-profiles-dir-"));
    temporary.push(root);
    const profilesDir = join(root, "claude-config");
    const cacheDir = join(root, "statusline-cache");
    const outsideDir = join(root, "outside-account");
    mkdirSync(profilesDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const outsideJson = join(outsideDir, ".claude.json");
    writeFileSync(outsideJson, JSON.stringify(accountBody(OUTSIDE_ACCOUNT)));

    const dirA = join(profilesDir, "claude-alpha");
    const dirB = join(profilesDir, "claude-beta");
    const dirBackup = join(profilesDir, "claude-alpha.bak");
    const dirEmpty = join(profilesDir, "empty-dir");
    const dirLinkedJson = join(profilesDir, "claude-linked-json");
    for (const dir of [dirA, dirB, dirBackup, dirEmpty, dirLinkedJson])
      mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dirA, ".claude.json"),
      JSON.stringify(accountBody(ACCOUNT_A)),
    );
    writeFileSync(
      join(dirB, ".claude.json"),
      JSON.stringify(accountBody(ACCOUNT_B)),
    );
    writeFileSync(
      join(dirBackup, ".claude.json"),
      JSON.stringify(accountBody(OUTSIDE_ACCOUNT)),
    );
    // 软链接账号目录和软链接 .claude.json 都必须被拒绝，防止越界采集目录外账户。
    symlinkSync(outsideDir, join(profilesDir, "claude-linked-dir"));
    symlinkSync(outsideJson, join(dirLinkedJson, ".claude.json"));
    writeFileSync(join(profilesDir, "claude-alpha.sh"), "#!/bin/sh\n");
    writeFileSync(join(profilesDir, ".DS_Store"), "");

    const cacheA = join(cacheDir, "claude-alpha.tsv");
    writeFileSync(cacheA, "five_hour\t12\t1790277600\n");

    expect(discoverClaudeProfiles(profilesDir, cacheDir)).toEqual([
      { configDir: dirA, statuslineCache: cacheA },
      { configDir: dirB },
    ]);

    // 独占目录凭据回退：指向范围外默认凭据的 .credentials.json 软链接必须被拒绝，普通文件可读取。
    const outsideCred = join(outsideDir, ".credentials.json");
    writeFileSync(
      outsideCred,
      JSON.stringify({
        claudeAiOauth: { subscriptionType: "max", accessToken: "secret" },
      }),
    );
    symlinkSync(outsideCred, join(dirA, ".credentials.json"));
    const linkedLoc: CredentialLocation = {
      claudeRoot: dirA,
      configDir: dirA,
      rejectSymlinkFile: true,
    };
    expect(readCredentialVersion(linkedLoc)).toBeNull();
    expect(readCredentialText(linkedLoc)).toBeNull();

    writeFileSync(
      join(dirB, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { subscriptionType: "pro", accessToken: "secret" },
      }),
    );
    const regularLoc: CredentialLocation = {
      claudeRoot: dirB,
      configDir: dirB,
      rejectSymlinkFile: true,
    };
    expect(readCredentialVersion(regularLoc)).toMatch(/^file:/);
    expect(readCredentialText(regularLoc)).toContain('"pro"');
  });

  test("从旧模式切到 profilesDir 时彻底清理默认与外部状态、保留非 Claude 状态，并在目录临时不可读时保护既有状态", () => {
    const root = mkdtempSync(join(tmpdir(), "meterleaf-profiles-exclusive-"));
    temporary.push(root);

    // 默认目录（模拟 ~/.claude 与 ~/.claude.json），使用合法但无 organizationUuid 的账户（subjectKey 为 null），
    // 验证迁移到独占模式并变更模型规则后仍完整保留其历史归属。
    const defaultRoot = join(root, "default-claude");
    const defaultProjects = join(defaultRoot, "projects");
    mkdirSync(join(defaultProjects, "p"), { recursive: true });
    const defaultJson = join(root, ".claude.json");
    writeFileSync(
      defaultJson,
      JSON.stringify(
        accountBody(FIXTURE_ACCOUNT_UUID, {
          organizationUuid: null,
          organizationType: "claude_max",
          rateLimitTier: "default_claude_max_5x",
          usage: {
            five_hour: { utilization: 10, resets_at: "2026-10-22T15:00:00Z" },
          },
        }),
      ),
    );
    const defaultSession = join(defaultProjects, "p", "default-only.jsonl");
    writeFileSync(
      defaultSession,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-10-22T09:59:00Z",
          message: {
            role: "user",
            content:
              "<local-command-stdout>Login successful</local-command-stdout>",
          },
        }),
        assistantLine({
          messageId: "default-msg",
          timestamp: "2026-10-22T10:00:30Z",
          input: 5,
          output: 6,
        }),
        assistantLine({
          messageId: "default-haiku",
          timestamp: "2026-10-22T10:00:35Z",
          input: 3,
          output: 4,
          model: "claude-haiku-4-5",
        }),
        assistantLine({
          messageId: "default-deepseek",
          timestamp: "2026-10-22T10:00:40Z",
          input: 7,
          output: 8,
          model: "deepseek-v4.1-flash",
        }),
        "",
      ].join("\n"),
    );
    const defaultStatusline = join(root, "default-statusline.tsv");
    writeFileSync(
      defaultStatusline,
      `five_hour\t15\t${Math.floor(Date.parse("2026-10-22T15:00:00Z") / 1000)}\n`,
    );
    const t0 = new Date("2026-10-22T10:01:00Z");
    utimesSync(defaultStatusline, t0, t0);

    // profilesDir 内两个目录，软链接共享同一个真实 projects 目录。
    const profilesDir = join(root, "claude-config");
    const cacheDir = join(root, "statusline-cache");
    const sharedProjects = join(root, "shared-projects");
    mkdirSync(join(sharedProjects, "proj"), { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    const dirA = join(profilesDir, "claude-a");
    const dirB = join(profilesDir, "claude-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(
      join(dirA, ".claude.json"),
      JSON.stringify(
        accountBody(ACCOUNT_A, {
          usage: {
            five_hour: { utilization: 20, resets_at: "2026-10-22T15:00:00Z" },
          },
        }),
      ),
    );
    writeFileSync(
      join(dirB, ".claude.json"),
      JSON.stringify(
        accountBody(ACCOUNT_B, {
          usage: {
            five_hour: { utilization: 30, resets_at: "2026-10-22T15:00:00Z" },
          },
        }),
      ),
    );
    symlinkSync(sharedProjects, join(dirA, "projects"));
    symlinkSync(sharedProjects, join(dirB, "projects"));
    const sharedSession = join(sharedProjects, "proj", "s.jsonl");
    writeFileSync(
      sharedSession,
      `${assistantLine({
        messageId: "shared-msg",
        timestamp: "2026-10-22T10:01:30Z",
        input: 10,
        output: 20,
      })}\n`,
    );
    const cacheA = join(cacheDir, "claude-a.tsv");
    writeFileSync(
      cacheA,
      `five_hour\t25\t${Math.floor(Date.parse("2026-10-22T15:00:00Z") / 1000)}\n`,
    );
    const t = new Date("2026-10-22T10:02:00Z");
    utimesSync(cacheA, t, t);

    // 外部目录（即使写在旧 claudeProfiles 里也不应被独占模式采集）。
    const outsideDir = join(root, "outside");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      join(outsideDir, ".claude.json"),
      JSON.stringify(
        accountBody(OUTSIDE_ACCOUNT, {
          usage: {
            five_hour: { utilization: 40, resets_at: "2026-10-22T15:00:00Z" },
          },
        }),
      ),
    );

    const state = new CollectorState(":memory:");
    const checkedLocations: (string | null)[] = [];
    const credential = {
      location: { claudeRoot: defaultRoot, configDir: null },
      read: (location: CredentialLocation) => {
        checkedLocations.push(location.configDir);
        return JSON.stringify({
          claudeAiOauth: {
            subscriptionType: "team",
            rateLimitTier: "default_claude_max_5x",
          },
        });
      },
      version: () => null,
    };

    try {
      // 1. 先按旧模式通过真实生产入口跑两轮，生成完整的默认与外部账户状态、登录线索、旧模型规则和文件游标。
      const legacyHaikuRule: ModelAccountRule = {
        match: "claude-haiku-*",
        id: "custom-haiku",
        name: "Custom Haiku",
        platform: "anthropic",
        kind: "api",
        plan: null,
      };
      const legacySources = {
        projectsDir: defaultProjects,
        claudeJson: defaultJson,
        statuslineCache: defaultStatusline,
        claudeProfiles: [{ configDir: outsideDir }],
        modelAccounts: [legacyHaikuRule],
        credential,
      };
      collect(state, legacySources, new Date("2026-10-22T10:00:00Z"), later);
      collect(state, legacySources, new Date("2026-10-22T10:02:00Z"), later);
      // 模拟旧版 state.sqlite 升级场景：既有事件尚未记录 attribution 列，且默认账户无 organizationUuid（subjectKey=null）。
      state.db.run("UPDATE events SET attribution = NULL");
      expect(state.account(FIXTURE_ACCOUNT_UUID)?.subjectKey).toBeNull();
      state.setBinding({
        accountUuid: FIXTURE_ACCOUNT_UUID,
        before: "2026-10-22T10:00:00Z",
      });
      // 同时写入非 Claude 来源的状态，验证独占清理不会波及 Codex / Antigravity。
      state.setMeta("last_quota_hash:codex", "codex-hash");
      state.setMeta("last_quota_hash:agy:demo", "agy-hash");
      state.setMeta("agy_quota_refresh_at:work", "2026-10-22T10:00:00Z");
      state.saveCodexFile({
        path: "/tmp/codex.jsonl",
        offset: 10,
        inode: "1:1",
        tail: "t",
        context: "{}",
        size: 10,
        modified: 1,
      });

      expect(state.cursors().map((c) => c.path)).toEqual([defaultSession]);
      expect(state.loginHints()).toHaveLength(1);
      expect(state.segments()).toHaveLength(1);
      expect(state.getMeta("credential_plan_check")).not.toBeNull();
      expect(state.getMeta("last_quota_hash")).not.toBeNull();
      expect(state.getMeta("last_quota_hash:statusline")).not.toBeNull();
      expect(state.metaByPrefix("credential_plan_check:")).toHaveLength(1);
      expect(state.metaByPrefix("last_quota_hash:claude-json:")).toHaveLength(
        1,
      );
      ackAll(state);
      checkedLocations.length = 0;

      // 2. 切到 claudeProfilesDir 独占模式并新增仅匹配 deepseek-* 的模型映射，触发规则重算。
      const deepseekRule: ModelAccountRule = {
        match: "deepseek-*",
        id: "opencode-go",
        name: "OpenCode Go",
        platform: "opencode-go",
        kind: "subscription",
        plan: "go",
      };
      const exclusiveSources = {
        projectsDir: defaultProjects,
        claudeJson: defaultJson,
        statuslineCache: defaultStatusline,
        claudeProfiles: [{ configDir: outsideDir }],
        claudeProfilesDir: profilesDir,
        claudeStatuslineCacheDir: cacheDir,
        modelAccounts: [deepseekRule],
        credential,
      };
      const report = collect(
        state,
        exclusiveSources,
        new Date("2026-10-22T10:05:00Z"),
        later,
      );

      // 默认目录与外部目录完全跳过，历史默认/外部状态全部清理，非 Claude 状态完好。
      expect(report.claudeJsonRead).toBe(false);
      expect(report.accountUuid).toBeNull();
      expect(checkedLocations.includes(null)).toBe(false);
      expect(checkedLocations.includes(outsideDir)).toBe(false);
      expect(report.profiles.map((p) => p.accountUuid)).toEqual([
        ACCOUNT_A,
        ACCOUNT_B,
      ]);
      expect(state.segments()).toEqual([]);
      expect(state.loginHints()).toEqual([]);
      expect(state.binding()).toBeNull();
      expect(state.getMeta("credential_plan_check")).toBeNull();
      expect(state.getMeta("credential_plan_candidate")).toBeNull();
      expect(state.getMeta("last_quota_hash")).toBeNull();
      expect(state.getMeta("last_quota_hash:statusline")).toBeNull();
      expect(state.getMeta("last_quota_hash:codex")).toBe("codex-hash");
      expect(state.getMeta("last_quota_hash:agy:demo")).toBe("agy-hash");
      expect(state.getMeta("agy_quota_refresh_at:work")).toBe(
        "2026-10-22T10:00:00Z",
      );
      expect(state.codexFilePaths()).toEqual(["/tmp/codex.jsonl"]);

      // 默认目录游标已被 forgetMissingFiles 清理，仅跟踪通过软链接指向的共享目录文件（去重为 1）。
      expect(report.files).toBe(1);
      expect(state.cursors().map((c) => c.path)).toEqual([
        realpathSync(sharedSession),
      ]);

      // 规则重算：新增 deepseek 规则改归 opencode-go；已移除的 claude-haiku 模型规则回退为 unattributed；
      // 而无 organizationUuid（subjectKey=null）的历史 Claude OAuth 账户归属必须完整保留。
      const usage = pendingUsage(state);
      expect(
        usage.get("req_default-deepseek:default-deepseek")?.accountExternalId,
      ).toBe("opencode-go");
      expect(
        usage.get("req_default-haiku:default-haiku")?.accountExternalId,
      ).toBe("unattributed");
      expect(usage.has("req_default-msg:default-msg")).toBe(false);
      expect(
        state.db
          .query<{ account: string }, [string]>(
            "SELECT account FROM events WHERE key = ?",
          )
          .get("req_default-msg:default-msg")?.account,
      ).toBe(FIXTURE_ACCOUNT_UUID);
      expect(usage.get("req_shared-msg:shared-msg")?.accountExternalId).toBe(
        "unattributed",
      );

      // 补跑一轮确认凭据进入 credential_plan_check:<suffix>。
      collect(state, exclusiveSources, new Date("2026-10-22T10:06:00Z"), later);
      expect(state.metaByPrefix("credential_plan_check:")).toHaveLength(2);
      expect(state.metaByPrefix("last_quota_hash:claude-json:")).toHaveLength(
        2,
      );

      // 3. 根目录暂时不可读（EACCES）时不得误删现有档案元信息和会话文件游标。
      chmodSync(profilesDir, 0o000);
      try {
        const unreadable = collect(
          state,
          exclusiveSources,
          new Date("2026-10-22T10:07:00Z"),
          later,
        );
        expect(unreadable.profiles).toEqual([]);
        expect(state.metaByPrefix("credential_plan_check:")).toHaveLength(2);
        expect(state.metaByPrefix("last_quota_hash:claude-json:")).toHaveLength(
          2,
        );
        expect(state.cursors().map((c) => c.path)).toEqual([
          realpathSync(sharedSession),
        ]);
      } finally {
        chmodSync(profilesDir, 0o755);
      }

      // 4. 恢复权限后从 profilesDir 真正移出 dirB，其元信息立即被清理，只保留 dirA。
      rmSync(dirB, { recursive: true, force: true });
      const afterRemove = collect(
        state,
        exclusiveSources,
        new Date("2026-10-22T10:08:00Z"),
        later,
      );
      expect(afterRemove.profiles.map((p) => p.accountUuid)).toEqual([
        ACCOUNT_A,
      ]);
      expect(state.metaByPrefix("credential_plan_check:")).toHaveLength(1);
      expect(state.metaByPrefix("last_quota_hash:claude-json:")).toHaveLength(
        1,
      );
    } finally {
      state.close();
    }
  });

  test("CLI status 过滤已移出账户，scan 遇到无效配置报错不回退默认目录，bind-history 拒绝执行", () => {
    const repoRoot = join(import.meta.dir, "..");
    const root = mkdtempSync(join(tmpdir(), "meterleaf-profiles-dir-cli-"));
    temporary.push(root);
    const profilesDir = join(root, "claude-config");
    const cacheDir = join(root, "statusline-cache");
    const dirA = join(profilesDir, "claude-team");
    const dirRemoved = join(profilesDir, "claude-old");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(dirA, ".claude.json"),
      JSON.stringify(accountBody(ACCOUNT_A)),
    );

    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      METERLEAF_COLLECTOR_HOME: join(root, "data"),
    };
    mkdirSync(env.HOME);
    // 在默认目录放一个可被读取的 .claude.json，用于验证 scan 配置无效时绝不会静默回退读取它。
    writeFileSync(
      join(env.HOME, ".claude.json"),
      JSON.stringify(accountBody(FIXTURE_ACCOUNT_UUID)),
    );
    const run = (...args: string[]) => {
      const result = Bun.spawnSync(
        [process.execPath, join(repoRoot, "src/collector/main.ts"), ...args],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };

    expect(run("init", "--server", "https://meterleaf.example.com").code).toBe(
      0,
    );
    const configPath = join(env.METERLEAF_COLLECTOR_HOME, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.claude = { profilesDir, statuslineCacheDir: cacheDir };
    writeFileSync(configPath, JSON.stringify(config));

    // 写入包含已移出目录的 last_profiles，验证 status 只输出当前仍存在于 profilesDir 的目录。
    const state = new CollectorState(
      join(env.METERLEAF_COLLECTOR_HOME, "state.sqlite"),
    );
    try {
      state.setMeta(
        "last_profiles",
        JSON.stringify([
          { configDir: dirA, accountUuid: ACCOUNT_A, plan: "team-premium" },
          {
            configDir: dirRemoved,
            accountUuid: ACCOUNT_B,
            plan: "team-premium",
          },
        ]),
      );
    } finally {
      state.close();
    }

    const status = run("status");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`仅采集 ${profilesDir}`);
    expect(status.stdout).toContain("claude-team");
    expect(status.stdout).not.toContain("claude-old");

    const bind = run("bind-history");
    expect(bind.code).toBe(1);
    expect(bind.stderr).toContain(profilesDir);

    // 离线推送失败（有待发送数据且服务端不可达）时，sync 保留失败退出码 1，同时仍更新已有 quota-summary.json 的
    // logins.claude 到独占目录范围，并保留原 fetchedAt、summary 与非 Claude 登录映射。
    const summaryPath = join(
      env.METERLEAF_COLLECTOR_HOME,
      "quota-summary.json",
    );
    const priorSummary = {
      schemaVersion: 1,
      fetchedAt: "2026-11-17T08:00:00Z",
      logins: {
        claude: [
          {
            configDir: join(env.HOME, ".claude"),
            account: `${config.sourceId}:${FIXTURE_ACCOUNT_UUID}`,
          },
        ],
        agy: [
          {
            appDataDir: "/h/.gemini/antigravity-cli-work",
            profile: "work",
            account: `${config.sourceId}:agy-work`,
          },
        ],
        codex: [{ channel: "openai", account: `${config.sourceId}:codex` }],
      },
      summary: { schemaVersion: 1, asOf: "2026-11-17T08:00:00Z", accounts: [] },
    };
    writeFileSync(summaryPath, JSON.stringify(priorSummary));
    // 指向未监听的回环端口，使 sync 推送失败。
    config.server = "http://127.0.0.1:1";
    writeFileSync(configPath, JSON.stringify(config));
    const offlineSync = run("sync");
    expect(offlineSync.code).toBe(1);
    expect(JSON.parse(readFileSync(summaryPath, "utf8"))).toEqual({
      ...priorSummary,
      logins: {
        ...priorSummary.logins,
        claude: [
          {
            configDir: dirA,
            account: `${config.sourceId}:${ACCOUNT_A}`,
          },
        ],
      },
    });

    // 破坏独占配置（statuslineCacheDir 改为相对路径），scan 必须以非 0 报错退出，不得读取默认 .claude.json。
    config.claude = { profilesDir, statuslineCacheDir: "relative-cache" };
    writeFileSync(configPath, JSON.stringify(config));
    const badScan = run("scan");
    expect(badScan.code).not.toBe(0);
    expect(badScan.stdout).not.toContain(FIXTURE_ACCOUNT_UUID.slice(0, 8));
    expect(badScan.stderr).toContain("配置文件格式无效");
  });

  test("真实缺列旧库升级与并发重开安全，且按决定性证据区分旧模型规则、时间线与未知旧行", () => {
    const root = mkdtempSync(join(tmpdir(), "meterleaf-legacy-schema-"));
    temporary.push(root);
    const dbPath = join(root, "legacy-state.sqlite");

    // 构造真实 H0 旧版 5 列 events 表（不含 attribution 列）。
    const raw = new Database(dbPath, { create: true });
    try {
      raw.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (path TEXT PRIMARY KEY, identity TEXT NOT NULL, offset INTEGER NOT NULL, fingerprint TEXT NOT NULL, mtime_ms REAL NOT NULL);
        CREATE TABLE events (key TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, total INTEGER NOT NULL, account TEXT NOT NULL, observation TEXT NOT NULL);
        CREATE TABLE timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, account_uuid TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
        CREATE TABLE login_hints (at TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (at, source));
        CREATE TABLE accounts (external_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, item_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE (kind, item_id));
      `);
      // 模拟旧库曾经启用过自定义模型规则（与切换后的 [] 不同）。
      raw
        .query("INSERT INTO meta (key, value) VALUES (?, ?)")
        .run("attribution_rules", "3:1111111111111111");
      raw
        .query("INSERT INTO accounts (external_id, payload) VALUES (?, ?)")
        .run(
          FIXTURE_ACCOUNT_UUID,
          JSON.stringify({
            externalId: FIXTURE_ACCOUNT_UUID,
            name: "Claude Code",
            platform: "anthropic",
            kind: "subscription",
            plan: "max-5x",
            subjectKey: null,
          }),
        );
      // 时间线从 10:00 开始，无历史绑定。
      raw
        .query(
          "INSERT INTO timeline (account_uuid, first_seen, last_seen) VALUES (?, ?, ?)",
        )
        .run(
          FIXTURE_ACCOUNT_UUID,
          "2026-10-22T10:00:00.000Z",
          "2026-10-22T10:05:00.000Z",
        );
      const insertEvent = raw.query(
        "INSERT INTO events (key, occurred_at, total, account, observation) VALUES (?, ?, ?, ?, ?)",
      );
      const makeObs = (externalId: string, model: string, total: number) =>
        JSON.stringify({
          externalId,
          model,
          tier: null,
          tokens: {
            input: Math.floor(total / 2),
            output: total - Math.floor(total / 2),
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
          },
          metadata: {},
        });

      // 1) 09:00 的 Haiku 事件早于时间线起点，却因模型规则把 id 设为同一个 UUID 而归到该账户（已推送）。
      insertEvent.run(
        "req_early-haiku:early-haiku",
        "2026-10-22T09:00:00.000Z",
        10,
        FIXTURE_ACCOUNT_UUID,
        makeObs("req_early-haiku:early-haiku", "claude-haiku-4-5", 10),
      );
      // 2) 10:01 的 Haiku 事件落在时间线区间内且同 UUID，但 outbox 明确记录 metadata.attribution = "model"。
      insertEvent.run(
        "req_in-window-haiku:in-window-haiku",
        "2026-10-22T10:01:00.000Z",
        14,
        FIXTURE_ACCOUNT_UUID,
        makeObs("req_in-window-haiku:in-window-haiku", "claude-haiku-4-5", 14),
      );
      raw
        .query("INSERT INTO outbox (kind, item_id, payload) VALUES (?, ?, ?)")
        .run(
          "usage",
          "req_in-window-haiku:in-window-haiku",
          JSON.stringify({
            externalId: "req_in-window-haiku:in-window-haiku",
            occurredAt: "2026-10-22T10:01:00.000Z",
            accountExternalId: FIXTURE_ACCOUNT_UUID,
            model: "claude-haiku-4-5",
            tier: null,
            tokens: {
              input: 7,
              output: 7,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
            },
            metadata: { attribution: "model" },
          }),
        );
      // 3) 10:01 的 Opus 事件落在区间内且 outbox 明确记录 metadata.attribution = "timeline"（无 organizationUuid）。
      insertEvent.run(
        "req_in-window-opus-pending:opus-pending",
        "2026-10-22T10:01:30.000Z",
        16,
        FIXTURE_ACCOUNT_UUID,
        makeObs(
          "req_in-window-opus-pending:opus-pending",
          "claude-opus-5-5",
          16,
        ),
      );
      raw
        .query("INSERT INTO outbox (kind, item_id, payload) VALUES (?, ?, ?)")
        .run(
          "usage",
          "req_in-window-opus-pending:opus-pending",
          JSON.stringify({
            externalId: "req_in-window-opus-pending:opus-pending",
            occurredAt: "2026-10-22T10:01:30.000Z",
            accountExternalId: FIXTURE_ACCOUNT_UUID,
            model: "claude-opus-5-5",
            tier: null,
            tokens: {
              input: 8,
              output: 8,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
            },
            metadata: { attribution: "timeline" },
          }),
        );
      // 4) 10:02 的已推送 Opus 事件：旧库有自定义规则、无 outbox、时间线可解释同一账户 -> 保持 attribution = NULL（未知），不伪造 timeline。
      insertEvent.run(
        "req_in-window-opus:in-window-opus",
        "2026-10-22T10:02:00.000Z",
        20,
        FIXTURE_ACCOUNT_UUID,
        makeObs("req_in-window-opus:in-window-opus", "claude-opus-5-5", 20),
      );
    } finally {
      raw.close();
    }

    // 两次打开同一旧库：第一次幂等补列，第二次不再重复 DDL 且正常启动。
    const state = new CollectorState(dbPath);
    const secondHandle = new CollectorState(dbPath);
    try {
      const cols = state.db
        .query<{ name: string }, []>("PRAGMA table_info(events)")
        .all()
        .map((c) => c.name);
      expect(cols).toContain("attribution");

      const profilesDir = join(root, "claude-config");
      mkdirSync(profilesDir, { recursive: true });
      collect(
        state,
        {
          projectsDir: join(root, "unused-projects"),
          claudeJson: join(root, "unused.claude.json"),
          claudeProfilesDir: profilesDir,
          modelAccounts: [],
        },
        new Date("2026-10-22T10:10:00.000Z"),
        later,
      );

      const getEvent = (key: string) =>
        state.db
          .query<{ account: string; attribution: string | null }, [string]>(
            "SELECT account, attribution FROM events WHERE key = ?",
          )
          .get(key);
      // 09:00 同 UUID 模型规则事件不得被误标为 timeline，规则移除后正确回退到 unattributed。
      expect(getEvent("req_early-haiku:early-haiku")).toEqual({
        account: "unattributed",
        attribution: "timeline",
      });
      // 10:01 区间内同 UUID 模型事件由 outbox 决定性判定为 model，规则移除后回退到 unattributed 并替换待发送载荷。
      expect(getEvent("req_in-window-haiku:in-window-haiku")).toEqual({
        account: "unattributed",
        attribution: "timeline",
      });
      const pendingUsage = state.pending<{
        externalId: string;
        accountExternalId: string;
        metadata: Record<string, unknown>;
      }>("usage", 20);
      const rewrittenHaiku = pendingUsage.find(
        (item) =>
          item.payload.externalId === "req_in-window-haiku:in-window-haiku",
      );
      expect(rewrittenHaiku?.payload.accountExternalId).toBe("unattributed");
      expect(rewrittenHaiku?.payload.metadata.attribution).toBe("timeline");
      // 10:01 区间内 outbox 证明为 timeline 的 Opus 事件（无 organizationUuid）精确标为 timeline 并保留。
      expect(getEvent("req_in-window-opus-pending:opus-pending")).toEqual({
        account: FIXTURE_ACCOUNT_UUID,
        attribution: "timeline",
      });
      // 10:02 已推送且缺乏决定性来源的旧行标为 unknown（与未评估 NULL 区分，也不伪造 timeline），并按既定策略保留历史账户。
      expect(getEvent("req_in-window-opus:in-window-opus")).toEqual({
        account: FIXTURE_ACCOUNT_UUID,
        attribution: "unknown",
      });

      // 清空当前待发送队列并再跑一轮正常 collect() + 一轮修改无关模型规则的 collect()：
      // unknown 行不得在后续轮次被空时间线误判为 model，也不得降级或重新入队。
      state.acknowledge(pendingUsage.map((item) => item.seq));
      collect(
        state,
        {
          projectsDir: join(root, "unused-projects"),
          claudeJson: join(root, "unused.claude.json"),
          claudeProfilesDir: profilesDir,
          modelAccounts: [],
        },
        new Date("2026-10-22T10:11:00.000Z"),
        later,
      );
      expect(getEvent("req_in-window-opus:in-window-opus")).toEqual({
        account: FIXTURE_ACCOUNT_UUID,
        attribution: "unknown",
      });
      collect(
        state,
        {
          projectsDir: join(root, "unused-projects"),
          claudeJson: join(root, "unused.claude.json"),
          claudeProfilesDir: profilesDir,
          modelAccounts: [
            {
              match: "deepseek-*",
              id: "deepseek-api",
              name: "DeepSeek",
              platform: "deepseek",
              kind: "api",
              plan: null,
            },
          ],
        },
        new Date("2026-10-22T10:12:00.000Z"),
        later,
      );
      expect(getEvent("req_in-window-opus:in-window-opus")).toEqual({
        account: FIXTURE_ACCOUNT_UUID,
        attribution: "unknown",
      });
      expect(getEvent("req_in-window-opus-pending:opus-pending")).toEqual({
        account: FIXTURE_ACCOUNT_UUID,
        attribution: "timeline",
      });
      expect(state.pending("usage", 20)).toEqual([]);
    } finally {
      secondHandle.close();
      state.close();
    }
  });

  test("旧库在规则未变时切入独占模式，已推送的区间内同 UUID 模型事件会被精确标为 model 并在后续删规则时回退", () => {
    const root = mkdtempSync(join(tmpdir(), "meterleaf-legacy-same-rules-"));
    temporary.push(root);
    const dbPath = join(root, "legacy-same-rules.sqlite");
    const haikuRule = {
      match: "claude-haiku-*",
      id: FIXTURE_ACCOUNT_UUID,
      name: "Haiku Override",
      platform: "anthropic",
      kind: "api" as const,
      plan: null,
    };

    const raw = new Database(dbPath, { create: true });
    try {
      raw.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (path TEXT PRIMARY KEY, identity TEXT NOT NULL, offset INTEGER NOT NULL, fingerprint TEXT NOT NULL, mtime_ms REAL NOT NULL);
        CREATE TABLE events (key TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, total INTEGER NOT NULL, account TEXT NOT NULL, observation TEXT NOT NULL);
        CREATE TABLE timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, account_uuid TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
        CREATE TABLE login_hints (at TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (at, source));
        CREATE TABLE accounts (external_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, item_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE (kind, item_id));
      `);
      // 使用与切换首轮完全一致的模型规则摘要，且 outbox 为空（均已推送）。
      const tempState = new CollectorState(":memory:");
      collect(
        tempState,
        {
          projectsDir: join(root, "empty-projects"),
          claudeJson: join(root, "missing.claude.json"),
          modelAccounts: [haikuRule],
        },
        new Date("2026-10-22T10:05:00.000Z"),
        later,
      );
      const exactRules = tempState.getMeta("attribution_rules")!;
      tempState.close();

      raw
        .query("INSERT INTO meta (key, value) VALUES (?, ?)")
        .run("attribution_rules", exactRules);
      raw
        .query(
          "INSERT INTO timeline (account_uuid, first_seen, last_seen) VALUES (?, ?, ?)",
        )
        .run(
          FIXTURE_ACCOUNT_UUID,
          "2026-10-22T10:00:00.000Z",
          "2026-10-22T10:05:00.000Z",
        );
      const insertEvent = raw.query(
        "INSERT INTO events (key, occurred_at, total, account, observation) VALUES (?, ?, ?, ?, ?)",
      );
      insertEvent.run(
        "req_pushed_haiku:m1",
        "2026-10-22T10:01:00.000Z",
        12,
        FIXTURE_ACCOUNT_UUID,
        JSON.stringify({
          externalId: "req_pushed_haiku:m1",
          model: "claude-haiku-4-5",
          tier: null,
          tokens: {
            input: 6,
            output: 6,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
          },
          metadata: {},
        }),
      );
      insertEvent.run(
        "req_pushed_opus:m2",
        "2026-10-22T10:01:00.000Z",
        18,
        FIXTURE_ACCOUNT_UUID,
        JSON.stringify({
          externalId: "req_pushed_opus:m2",
          model: "claude-opus-5-5",
          tier: null,
          tokens: {
            input: 9,
            output: 9,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
          },
          metadata: {},
        }),
      );
    } finally {
      raw.close();
    }

    const state = new CollectorState(dbPath);
    try {
      const profilesDir = join(root, "claude-config");
      mkdirSync(profilesDir, { recursive: true });
      // 首轮以相同规则切入独占模式：haiku 精确回填 model，opus 精确回填 timeline。
      collect(
        state,
        {
          projectsDir: join(root, "unused-projects"),
          claudeJson: join(root, "unused.claude.json"),
          claudeProfilesDir: profilesDir,
          modelAccounts: [haikuRule],
        },
        new Date("2026-10-22T10:10:00.000Z"),
        later,
      );
      const getEvent = (key: string) =>
        state.db
          .query<{ account: string; attribution: string | null }, [string]>(
            "SELECT account, attribution FROM events WHERE key = ?",
          )
          .get(key);
      expect(getEvent("req_pushed_haiku:m1")).toEqual({
        account: FIXTURE_ACCOUNT_UUID,
        attribution: "model",
      });
      expect(getEvent("req_pushed_opus:m2")).toEqual({
        account: FIXTURE_ACCOUNT_UUID,
        attribution: "timeline",
      });

      // 第二轮移除 Haiku 规则：仅 haiku 回退 unattributed，opus 完整保留。
      collect(
        state,
        {
          projectsDir: join(root, "unused-projects"),
          claudeJson: join(root, "unused.claude.json"),
          claudeProfilesDir: profilesDir,
          modelAccounts: [],
        },
        new Date("2026-10-22T10:11:00.000Z"),
        later,
      );
      expect(getEvent("req_pushed_haiku:m1")).toEqual({
        account: "unattributed",
        attribution: "timeline",
      });
      expect(getEvent("req_pushed_opus:m2")).toEqual({
        account: FIXTURE_ACCOUNT_UUID,
        attribution: "timeline",
      });
    } finally {
      state.close();
    }
  });

  test("独占目录临时不可读且额度接口返回 200 时，仅保留根内受管映射并剔除默认与范围外目录", async () => {
    const repoRoot = join(import.meta.dir, "..");
    const root = mkdtempSync(join(tmpdir(), "meterleaf-summary-eacces-"));
    temporary.push(root);
    const profilesDir = join(root, "claude-config");
    const dirA = join(profilesDir, "claude-team");
    mkdirSync(dirA, { recursive: true });
    writeFileSync(
      join(dirA, ".claude.json"),
      JSON.stringify(accountBody(ACCOUNT_A)),
    );

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === INGEST_BATCHES_PATH) {
          return Response.json({ batchId: "b1", accepted: {} });
        }
        if (path === QUOTA_SUMMARY_PATH) {
          return Response.json({
            schemaVersion: QUOTA_SUMMARY_SCHEMA_VERSION,
            asOf: "2026-11-24T14:00:00.000Z",
            accounts: [],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      METERLEAF_COLLECTOR_HOME: join(root, "data"),
    };
    mkdirSync(env.HOME);
    const runAsync = async (...args: string[]) => {
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
    };

    try {
      expect(
        (
          await runAsync(
            "init",
            "--server",
            `http://127.0.0.1:${server.port}`,
            "--source-id",
            "claude-code-test",
          )
        ).code,
      ).toBe(0);
      const configPath = join(env.METERLEAF_COLLECTOR_HOME, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.claude = { profilesDir };
      writeFileSync(configPath, JSON.stringify(config));

      const summaryPath = join(
        env.METERLEAF_COLLECTOR_HOME,
        "quota-summary.json",
      );
      const managedLogin = {
        configDir: dirA,
        account: `claude-code-test:${ACCOUNT_A}`,
      };
      // 旧摘要同时包含默认目录 ~/.claude、根外目录、备份命名目录与当前根内受管目录。
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          fetchedAt: "2026-11-24T13:00:00.000Z",
          logins: {
            claude: [
              {
                configDir: join(env.HOME, ".claude"),
                account: `claude-code-test:${FIXTURE_ACCOUNT_UUID}`,
              },
              {
                configDir: join(root, "outside-claude"),
                account: `claude-code-test:${OUTSIDE_ACCOUNT}`,
              },
              {
                configDir: join(profilesDir, "claude-team.bak"),
                account: `claude-code-test:${ACCOUNT_B}`,
              },
              managedLogin,
            ],
            agy: [],
            codex: [],
          },
          summary: {
            schemaVersion: QUOTA_SUMMARY_SCHEMA_VERSION,
            asOf: "2026-11-24T13:00:00.000Z",
            accounts: [],
          },
        }),
      );

      chmodSync(profilesDir, 0o000);
      try {
        const res = await runAsync("sync");
        expect(res.code).toBe(0);
      } finally {
        chmodSync(profilesDir, 0o755);
      }

      const updated = JSON.parse(readFileSync(summaryPath, "utf8"));
      expect(updated.summary.asOf).toBe("2026-11-24T14:00:00.000Z");
      // 保留当前 profilesDir 内的有效受管目录，同时剔除默认 ~/.claude、根外目录与备份命名目录。
      expect(updated.logins.claude).toEqual([managedLogin]);
    } finally {
      server.stop(true);
    }
  });

  test("受管目录存在且元数据可查但 .claude.json 正文不可读时，GET 200 与失败回退均保留该受管映射且剔除未登录与排除目录", async () => {
    const repoRoot = join(import.meta.dir, "..");
    const root = mkdtempSync(join(tmpdir(), "meterleaf-json-eacces-"));
    temporary.push(root);
    const profilesDir = join(root, "claude-config");
    const dirA = join(profilesDir, "claude-a");
    const dirB = join(profilesDir, "claude-b");
    const dirLoggedOut = join(profilesDir, "claude-logged-out");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    mkdirSync(dirLoggedOut, { recursive: true });
    writeFileSync(
      join(dirA, ".claude.json"),
      JSON.stringify(accountBody(ACCOUNT_A)),
    );
    const dirBJson = join(dirB, ".claude.json");
    writeFileSync(dirBJson, JSON.stringify(accountBody(ACCOUNT_B)));
    // 明确存在、可读但无 oauthAccount（已登出）。
    writeFileSync(join(dirLoggedOut, ".claude.json"), JSON.stringify({}));

    let quotaStatus = 200;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === INGEST_BATCHES_PATH) {
          return Response.json({ batchId: "b1", accepted: {} });
        }
        if (path === QUOTA_SUMMARY_PATH) {
          if (quotaStatus !== 200) {
            return new Response("computing", { status: quotaStatus });
          }
          return Response.json({
            schemaVersion: QUOTA_SUMMARY_SCHEMA_VERSION,
            asOf: "2026-11-24T15:00:00.000Z",
            accounts: [],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      METERLEAF_COLLECTOR_HOME: join(root, "data"),
    };
    mkdirSync(env.HOME);
    const runAsync = async (...args: string[]) => {
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
    };

    try {
      expect(
        (
          await runAsync(
            "init",
            "--server",
            `http://127.0.0.1:${server.port}`,
            "--source-id",
            "claude-code-test",
          )
        ).code,
      ).toBe(0);
      const configPath = join(env.METERLEAF_COLLECTOR_HOME, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.claude = { profilesDir };
      writeFileSync(configPath, JSON.stringify(config));

      const summaryPath = join(
        env.METERLEAF_COLLECTOR_HOME,
        "quota-summary.json",
      );
      const seedSummary = () =>
        writeFileSync(
          summaryPath,
          JSON.stringify({
            schemaVersion: 1,
            fetchedAt: "2026-11-24T13:00:00.000Z",
            logins: {
              claude: [
                {
                  configDir: join(env.HOME, ".claude"),
                  account: `claude-code-test:${FIXTURE_ACCOUNT_UUID}`,
                },
                {
                  configDir: dirA,
                  account: `claude-code-test:${OUTSIDE_ACCOUNT}`,
                },
                { configDir: dirB, account: `claude-code-test:${ACCOUNT_B}` },
                {
                  configDir: dirLoggedOut,
                  account: `claude-code-test:${OUTSIDE_ACCOUNT}`,
                },
                {
                  configDir: join(profilesDir, "claude-removed"),
                  account: `claude-code-test:${OUTSIDE_ACCOUNT}`,
                },
              ],
              agy: [
                {
                  appDataDir: "/tmp/agy",
                  profile: null,
                  account: "claude-code-test:agy-1",
                },
              ],
              codex: [{ channel: "openai", account: "claude-code-test:codex" }],
            },
            summary: {
              schemaVersion: QUOTA_SUMMARY_SCHEMA_VERSION,
              asOf: "2026-11-24T13:00:00.000Z",
              accounts: [],
            },
          }),
        );

      // 仅对 dirB/.claude.json 去除读权限（父目录与 lstat 均正常，但正文读取触发 EACCES）。
      chmodSync(dirBJson, 0o000);
      try {
        // 1) GET 200 分支：dirA 刷新为新账号，dirB 保留既有映射，已登出/已删除/默认目录全部剔除。
        seedSummary();
        quotaStatus = 200;
        expect((await runAsync("sync")).code).toBe(0);
        const after200 = JSON.parse(readFileSync(summaryPath, "utf8"));
        expect(after200.summary.asOf).toBe("2026-11-24T15:00:00.000Z");
        expect(after200.logins.claude).toEqual([
          { configDir: dirA, account: `claude-code-test:${ACCOUNT_A}` },
          { configDir: dirB, account: `claude-code-test:${ACCOUNT_B}` },
        ]);

        // 2) GET 202 失败回退分支：同样保留 dirB 与新 dirA、剔除其余项，同时保留原 fetchedAt/summary/非 Claude 映射。
        seedSummary();
        quotaStatus = 202;
        expect((await runAsync("sync")).code).toBe(0);
        const after202 = JSON.parse(readFileSync(summaryPath, "utf8"));
        expect(after202.fetchedAt).toBe("2026-11-24T13:00:00.000Z");
        expect(after202.summary.asOf).toBe("2026-11-24T13:00:00.000Z");
        expect(after202.logins.agy).toEqual([
          {
            appDataDir: "/tmp/agy",
            profile: null,
            account: "claude-code-test:agy-1",
          },
        ]);
        expect(after202.logins.codex).toEqual([
          { channel: "openai", account: "claude-code-test:codex" },
        ]);
        expect(after202.logins.claude).toEqual([
          { configDir: dirA, account: `claude-code-test:${ACCOUNT_A}` },
          { configDir: dirB, account: `claude-code-test:${ACCOUNT_B}` },
        ]);

        // 3) GET 200 且既有 quota-summary.json 本身暂时不可读（EACCES）时：
        //    不得把读失败当成空列表覆盖原文件，必须保留原摘要文件并记录刷新失败原因。
        seedSummary();
        const rawBefore = readFileSync(summaryPath, "utf8");
        quotaStatus = 200;
        chmodSync(summaryPath, 0o000);
        let unreadableSync: { code: number; stdout: string; stderr: string };
        try {
          unreadableSync = await runAsync("sync");
        } finally {
          chmodSync(summaryPath, 0o600);
        }
        expect(unreadableSync.code).toBe(0);
        expect(unreadableSync.stdout).toContain("额度摘要写入失败");
        expect(readFileSync(summaryPath, "utf8")).toBe(rawBefore);
      } finally {
        chmodSync(dirBJson, 0o644);
      }
    } finally {
      server.stop(true);
    }
  });
});
