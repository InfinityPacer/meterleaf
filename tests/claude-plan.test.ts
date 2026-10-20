import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountFact,
  type ClaudeAccount,
} from "../src/collector/claude-code/account";
import {
  credentialPlanFrom,
  keychainService,
  type CredentialTextReader,
} from "../src/collector/claude-code/credential";
import { collect } from "../src/collector/collect";
import { CollectorState } from "../src/collector/state";
import { ref } from "../src/domain/account-merge";
import type { QuotaFact, SourceAccount } from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { quotaView, type QuotaChargeReader } from "../src/domain/quota";
import type { IngestAccount } from "../src/shared/ingest";
import { LedgerStore } from "../src/storage/ledger";

/** 新版 Claude Code 写入的账户资料：没有组织类型和速率档位。 */
const current: ClaudeAccount = {
  accountUuid: "team-account",
  organizationUuid: "org",
  organizationType: null,
  rateLimitTier: null,
  billingType: "stripe_subscription",
  seatTier: null,
};

function credential(subscriptionType: string, rateLimitTier: string | null) {
  return { subscriptionType, rateLimitTier };
}

describe("Claude 套餐识别", () => {
  test("凭据中的订阅类型和速率档位决定套餐", () => {
    const cases: [ReturnType<typeof credential>, string][] = [
      [credential("pro", "default_claude_ai"), "pro"],
      [credential("max", "default_claude_max_5x"), "max-5x"],
      [credential("max", "default_claude_max_20x"), "max-20x"],
      [credential("max", null), "max"],
      [credential("team", "default_claude_max_5x"), "team-premium"],
      [credential("team", null), "team"],
      [credential("enterprise", null), "enterprise"],
    ];
    for (const [plan, expected] of cases) {
      const fact = accountFact(current, plan);
      expect(fact.plan).toBe(expected);
      expect(fact.kind).toBe("subscription");
    }
  });

  test("凭据不可用时 Team 席位档位仍能识别 Team", () => {
    expect(accountFact({ ...current, seatTier: "team_tier_1" }).plan).toBe(
      "team-premium",
    );
    expect(accountFact({ ...current, seatTier: "team_standard" }).plan).toBe(
      "team-standard",
    );
    expect(accountFact({ ...current, seatTier: "team_tier_9" }).plan).toBe(
      "team",
    );
    expect(
      accountFact(
        { ...current, seatTier: "team_standard" },
        credential("team", "default_claude_ai"),
      ).plan,
    ).toBe("team-standard");
  });

  test("没有任何套餐字段时保留未知，订阅计费方式仍认定为订阅", () => {
    const fact = accountFact(current);
    expect(fact.plan).toBeNull();
    expect(fact.kind).toBe("subscription");
    expect(accountFact({ ...current, billingType: null }).kind).toBe("unknown");
    expect(accountFact(current, credential("free", null)).kind).toBe("unknown");
  });

  test("旧版 .claude.json 的组织字段照常识别", () => {
    const legacy = {
      ...current,
      organizationType: "claude_team",
      rateLimitTier: "default_claude_max_5x",
      seatTier: "team_tier_1",
    };
    expect(accountFact(legacy).plan).toBe("team-premium");
    expect(
      accountFact({ ...legacy, organizationType: "claude_max" }).plan,
    ).toBe("max-5x");
  });

  test("凭据只取套餐字段，令牌不进入结果", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "secret-access",
        refreshToken: "secret-refresh",
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x",
      },
    });
    const plan = credentialPlanFrom(raw);
    expect(plan).toEqual(credential("team", "default_claude_max_5x"));
    expect(JSON.stringify(plan)).not.toContain("secret");
    expect(credentialPlanFrom("{not json")).toBeNull();
    expect(
      credentialPlanFrom(JSON.stringify({ claudeAiOauth: {} })),
    ).toBeNull();
    expect(credentialPlanFrom(null)).toBeNull();
  });

  test("钥匙串条目名与 Claude Code 一致", () => {
    expect(
      keychainService({
        claudeRoot: "/Users/a/.claude",
        customConfigDir: false,
      }),
    ).toBe("Claude Code-credentials");
    expect(
      keychainService({ claudeRoot: "/tmp/claude", customConfigDir: true }),
    ).toBe(
      `Claude Code-credentials-${new Bun.CryptoHasher("sha256")
        .update("/tmp/claude")
        .digest("hex")
        .slice(0, 8)}`,
    );
  });
});

describe("采集轮次中的凭据套餐", () => {
  function setup() {
    const directory = mkdtempSync(join(tmpdir(), "meterleaf-claude-plan-"));
    const claudeJson = join(directory, "claude.json");
    const writeAccount = (accountUuid: string) =>
      writeFileSync(
        claudeJson,
        JSON.stringify({
          oauthAccount: {
            accountUuid,
            organizationUuid: "org",
            billingType: "stripe_subscription",
            seatTier: "team_tier_1",
          },
        }),
      );
    writeAccount("team-account");
    const state = new CollectorState(":memory:");
    const run = (read: CredentialTextReader) =>
      collect(state, {
        projectsDir: join(directory, "projects"),
        claudeJson,
        credential: {
          location: { claudeRoot: directory, customConfigDir: false },
          read,
        },
      });
    const plan = (accountUuid: string) =>
      (state.account(accountUuid) as IngestAccount | null)?.plan;
    return {
      run,
      plan,
      writeAccount,
      cleanup: () => {
        state.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  }
  const teamPremium = JSON.stringify({
    claudeAiOauth: {
      subscriptionType: "team",
      rateLimitTier: "default_claude_max_5x",
    },
  });
  const max20x = JSON.stringify({
    claudeAiOauth: {
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  });

  test("读到凭据时记录套餐，之后读不到凭据也不回退", () => {
    const { run, plan, cleanup } = setup();
    try {
      expect(run(() => teamPremium).credentialPlanRead).toBe(true);
      expect(plan("team-account")).toBe("team-premium");
      expect(run(() => null).credentialPlanRead).toBe(false);
      expect(plan("team-account")).toBe("team-premium");
    } finally {
      cleanup();
    }
  });

  test("读取凭据期间切换了账户时不采用凭据", () => {
    const { run, plan, writeAccount, cleanup } = setup();
    try {
      const report = run(() => {
        writeAccount("other-account");
        return max20x;
      });
      expect(report.credentialPlanRead).toBe(false);
      // 没有凭据时只靠席位档位识别，Max 20x 不会被记到 Team 账户上。
      expect(plan("team-account")).toBe("team-premium");
    } finally {
      cleanup();
    }
  });
});

describe("补上套餐后额度预估不丢已有数据", () => {
  const start = Date.parse("2026-10-18T14:00:00.000Z");
  const at = (minutes: number) =>
    new Date(start + minutes * 60_000).toISOString();
  const resetsAt = new Date(start + 7 * 24 * 60 * 60_000).toISOString();
  const account: SourceAccount = {
    sourceId: "source",
    externalId: "team",
    name: "Claude Code",
    platform: "anthropic",
    kind: "subscription",
    plan: null,
    parentExternalId: null,
    subjectKey: null,
  };
  // 已用到 20%，每 1% 约 $13.5，带一点真实波动。
  const readings = Array.from({ length: 21 }, (_, percent) => ({
    sampledAt: at(percent * 10),
    percent,
    usd: percent * 13.5 + (percent % 3) * 0.8,
  }));
  const quotas: QuotaFact[] = readings.map((reading) => ({
    sourceId: "source",
    externalId: `q-${reading.percent}`,
    accountExternalId: "team",
    window: "seven-day",
    percent: reading.percent,
    sampledAt: reading.sampledAt,
    resetsAt,
    windowMinutes: 10080,
  }));
  const charges: QuotaChargeReader = (_from, until) => {
    const reading = readings.filter((entry) => entry.sampledAt <= until).at(-1);
    const usd = reading ? String(reading.usd) : "0";
    return { usd, credits: null };
  };
  const now = at(210);
  const estimate = (store: LedgerStore) =>
    quotaView(store.quotas(), charges, now)!.estimate;

  function store() {
    const ledger = new LedgerStore(":memory:", defaultPriceBook);
    ledger.saveAccounts([account], at(0));
    ledger.saveQuotas(quotas, at(200));
    return ledger;
  }

  test("采集器识别出套餐后，预估与识别前一致", () => {
    const ledger = store();
    try {
      const before = estimate(ledger);
      expect(before.usd).not.toBeNull();
      ledger.saveAccounts([{ ...account, plan: "team-premium" }], at(205));
      expect(estimate(ledger)).toEqual(before);
    } finally {
      ledger.close();
    }
  });

  test("手动指定套餐后，预估与指定前一致，报表显示指定套餐", () => {
    const ledger = store();
    try {
      const before = estimate(ledger);
      const revision = ledger.revision();
      ledger.setAccountPlan(ref("source", "team"), "team-premium");
      expect(ledger.revision()).toBeGreaterThan(revision);
      expect(estimate(ledger)).toEqual(before);
      expect(ledger.quotas()[0]?.planHistory?.[0]?.plan).toBe("team-premium");
      expect(ledger.accounts()[0]?.plan).toBe("team-premium");
      ledger.setAccountPlan(ref("source", "team"), null);
      expect(ledger.accounts()[0]?.plan).toBeNull();
    } finally {
      ledger.close();
    }
  });
});
