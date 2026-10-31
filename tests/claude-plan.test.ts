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
import { planRelation } from "../src/domain/quota-plan";
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
      // 改名为 Ultra 后可能出现的取值，仍归到 max-20x，已有账户的套餐不变。
      [credential("ultra", "default_claude_ultra"), "max-20x"],
      [credential("ultra", null), "max-20x"],
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
        configDir: null,
      }),
    ).toBe("Claude Code-credentials");
    expect(
      keychainService({ claudeRoot: "/tmp/claude", configDir: "/tmp/claude/" }),
    ).toBe(
      `Claude Code-credentials-${new Bun.CryptoHasher("sha256")
        .update("/tmp/claude/")
        .digest("hex")
        .slice(0, 8)}`,
    );
  });
});

describe("采集轮次中的凭据套餐", () => {
  function setup() {
    const directory = mkdtempSync(join(tmpdir(), "meterleaf-claude-plan-"));
    const claudeJson = join(directory, "claude.json");
    const writeAccount = (accountUuid: string, seatTier?: string) =>
      writeFileSync(
        claudeJson,
        JSON.stringify({
          oauthAccount: {
            accountUuid,
            organizationUuid: "org",
            billingType: "stripe_subscription",
            seatTier,
          },
        }),
      );
    writeAccount("team-account");
    const state = new CollectorState(":memory:");
    // 每轮相隔一分钟，与后台任务一致；advance 模拟更长的间隔。
    let clock = Date.parse("2026-10-21T00:00:00Z");
    const advance = (minutes: number) => (clock += minutes * 60_000);
    // 凭据修改标记；rewrite 模拟 Claude Code 改写凭据（登录、刷新令牌、套餐变化）。
    let version: string | null = "v0";
    let rewrites = 0;
    const rewrite = () => (version = `v${++rewrites}`);
    const hideVersion = () => (version = null);
    const run = (read: CredentialTextReader) => {
      advance(1);
      return collect(
        state,
        {
          projectsDir: join(directory, "projects"),
          claudeJson,
          credential: {
            location: { claudeRoot: directory, configDir: null },
            read,
            version: () => version,
          },
        },
        new Date(clock),
      );
    };
    const plan = (accountUuid: string) =>
      (state.account(accountUuid) as IngestAccount | null)?.plan;
    return {
      run,
      plan,
      writeAccount,
      advance,
      rewrite,
      hideVersion,
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

  test("连续两轮读到同一套餐才采用，之后读不到凭据也不回退", () => {
    const { run, plan, rewrite, cleanup } = setup();
    try {
      const first = run(() => teamPremium);
      expect(first.credentialPlanPending).toBe(true);
      expect(first.credentialPlanRead).toBe(false);
      expect(plan("team-account")).toBeNull();
      expect(run(() => teamPremium).credentialPlanRead).toBe(true);
      expect(plan("team-account")).toBe("team-premium");
      rewrite();
      const denied = run(() => null);
      expect(denied.credentialChecked).toBe(true);
      expect(plan("team-account")).toBe("team-premium");
    } finally {
      cleanup();
    }
  });

  test("凭据未被改写时不再读取，改写后只读一次", () => {
    const { run, plan, advance, rewrite, cleanup } = setup();
    try {
      let reads = 0;
      const read = () => {
        reads += 1;
        return teamPremium;
      };
      run(read);
      run(read);
      expect(reads).toBe(2);
      for (let round = 0; round < 50; round++) {
        const report = run(read);
        expect(report.credentialChecked).toBe(false);
        expect(report.credentialPlanRead).toBe(true);
      }
      advance(7 * 24 * 60);
      run(read);
      expect(reads).toBe(2);
      expect(plan("team-account")).toBe("team-premium");
      rewrite();
      expect(run(read).credentialChecked).toBe(true);
      expect(run(read).credentialChecked).toBe(false);
      expect(reads).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("凭据改写后发现同一账户升级，连续两轮一致才改用新套餐", () => {
    const { run, plan, rewrite, cleanup } = setup();
    try {
      run(() => teamPremium);
      run(() => teamPremium);
      rewrite();
      const changed = run(() => max20x);
      expect(changed.credentialPlanPending).toBe(true);
      expect(plan("team-account")).toBe("team-premium");
      // 待确认时下一轮立即再读，不等凭据再次改写。
      expect(run(() => max20x).credentialChecked).toBe(true);
      expect(plan("team-account")).toBe("max-20x");
    } finally {
      cleanup();
    }
  });

  test("读不到凭据时等凭据改写再试，账户资料变化时立即重读", () => {
    const { run, plan, advance, rewrite, writeAccount, cleanup } = setup();
    try {
      let reads = 0;
      const denied = () => {
        reads += 1;
        return null;
      };
      run(denied);
      for (let round = 0; round < 30; round++) run(denied);
      advance(24 * 60);
      run(denied);
      expect(reads).toBe(1);
      rewrite();
      run(denied);
      expect(reads).toBe(2);
      writeAccount("team-account", "team_tier_1");
      run(() => teamPremium);
      run(() => teamPremium);
      expect(plan("team-account")).toBe("team-premium");
    } finally {
      cleanup();
    }
  });

  test("读不到凭据修改标记时每天复查一次", () => {
    const { run, advance, hideVersion, cleanup } = setup();
    try {
      hideVersion();
      run(() => teamPremium);
      run(() => teamPremium);
      advance(23 * 60);
      expect(run(() => teamPremium).credentialChecked).toBe(false);
      advance(60);
      expect(run(() => teamPremium).credentialChecked).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("读取凭据期间切换了账户时不采用凭据", () => {
    const { run, plan, writeAccount, cleanup } = setup();
    try {
      run(() => teamPremium);
      const report = run(() => {
        writeAccount("other-account");
        return max20x;
      });
      expect(report.credentialPlanRead).toBe(false);
      expect(plan("team-account")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("先写凭据、后写 .claude.json 的登录切换不会把新账户的套餐记到旧账户", () => {
    const { run, plan, rewrite, writeAccount, cleanup } = setup();
    try {
      run(() => teamPremium);
      run(() => teamPremium);
      expect(plan("team-account")).toBe("team-premium");
      // 钥匙串已换成新账户，.claude.json 还是旧账户：这一轮只记为待确认。
      rewrite();
      expect(run(() => max20x).credentialPlanPending).toBe(true);
      expect(plan("team-account")).toBe("team-premium");
      writeAccount("max-account");
      run(() => max20x);
      expect(run(() => max20x).credentialPlanRead).toBe(true);
      expect(plan("max-account")).toBe("max-20x");
      expect(plan("team-account")).toBe("team-premium");
    } finally {
      cleanup();
    }
  });
});

describe("套餐标识的改名与细化", () => {
  test("planRelation 区分同一套餐的不同写法与真实变化", () => {
    expect(planRelation("max-5x", "team-premium")).toBe("refine");
    expect(planRelation("team-premium", "max-5x")).toBe("coarser");
    expect(planRelation("claude_team", "team")).toBe("refine");
    expect(planRelation("claude_team", "team-standard")).toBe("refine");
    expect(planRelation("claude_enterprise", "enterprise")).toBe("refine");
    expect(planRelation("max", "max-20x")).toBe("refine");
    expect(planRelation("max-20x", "max")).toBe("coarser");
    expect(planRelation("pro", "max-5x")).toBe("change");
    expect(planRelation("max-5x", "max-20x")).toBe("change");
    expect(planRelation("team-standard", "team-premium")).toBe("change");
    expect(planRelation(null, "pro")).toBe("unknown");
  });

  function history(plans: (string | null)[]) {
    const ledger = new LedgerStore(":memory:", defaultPriceBook);
    const account: SourceAccount = {
      sourceId: "source",
      externalId: "a",
      name: "Claude Code",
      platform: "anthropic",
      kind: "subscription",
      plan: null,
      parentExternalId: null,
      subjectKey: null,
    };
    ledger.saveQuotas(
      [
        {
          sourceId: "source",
          externalId: "q",
          accountExternalId: "a",
          window: "seven-day",
          percent: 1,
          sampledAt: "2026-10-01T00:00:00.000Z",
          resetsAt: "2026-10-05T00:00:00.000Z",
          windowMinutes: 10080,
        },
      ],
      "2026-10-01T00:00:00.000Z",
    );
    plans.forEach((plan, index) =>
      ledger.saveAccounts(
        [{ ...account, plan }],
        `2026-10-01T0${index}:00:00.000Z`,
      ),
    );
    const result = ledger.quotas()[0]?.planHistory;
    const shown = ledger.accounts()[0]?.plan;
    ledger.close();
    return { history: result, shown };
  }

  test("更笼统的同一套餐不覆盖已知的具体套餐", () => {
    expect(history(["max-20x", "max"]).shown).toBe("max-20x");
    expect(history(["max", "max-20x"]).shown).toBe("max-20x");
  });

  test("旧版标识换成新标识时改写标签，不追加边界", () => {
    expect(history(["max-5x", "team-premium"]).history).toEqual([
      {
        plan: "team-premium",
        observedAt: "2026-10-01T00:00:00.000Z",
        changed: false,
      },
    ]);
    expect(
      history(["claude_enterprise", "enterprise", "claude_enterprise"]).history,
    ).toEqual([
      {
        plan: "enterprise",
        observedAt: "2026-10-01T00:00:00.000Z",
        changed: false,
      },
    ]);
    expect(history(["max-20x", "max"]).history).toEqual([
      {
        plan: "max-20x",
        observedAt: "2026-10-01T00:00:00.000Z",
        changed: false,
      },
    ]);
  });

  test("旧版以未知结尾的历史：同一套餐恢复连续区间，不同套餐在当前时刻追加边界", () => {
    const legacy = (plan: string) => {
      const ledger = new LedgerStore(":memory:", defaultPriceBook);
      const key = 'quota:planHistory:["source","a"]';
      ledger.saveQuotas(
        [
          {
            sourceId: "source",
            externalId: "q",
            accountExternalId: "a",
            window: "seven-day",
            percent: 1,
            sampledAt: "2026-10-01T00:00:00.000Z",
            resetsAt: "2026-10-05T00:00:00.000Z",
            windowMinutes: 10080,
          },
        ],
        "2026-10-01T00:00:00.000Z",
      );
      ledger.db.query("INSERT INTO sync_state (key, value) VALUES (?, ?)").run(
        key,
        JSON.stringify([
          {
            plan: "max-5x",
            observedAt: "2026-10-01T00:00:00.000Z",
            changed: false,
          },
          { plan: null, observedAt: "2026-10-01T01:00:00.000Z", changed: true },
        ]),
      );
      ledger.saveAccounts(
        [
          {
            sourceId: "source",
            externalId: "a",
            name: "Claude Code",
            platform: "anthropic",
            kind: "subscription",
            plan,
            parentExternalId: null,
            subjectKey: null,
          },
        ],
        "2026-10-01T02:00:00.000Z",
      );
      const result = ledger.quotas()[0]?.planHistory;
      ledger.close();
      return result;
    };
    expect(legacy("max-5x")).toEqual([
      {
        plan: "max-5x",
        observedAt: "2026-10-01T00:00:00.000Z",
        changed: false,
      },
    ]);
    expect(legacy("max-20x")?.at(-1)).toEqual({
      plan: "max-20x",
      observedAt: "2026-10-01T02:00:00.000Z",
      changed: true,
    });
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

  test("旧版记为 max-5x 的 Team Premium 换成新标识后，预估与改名前一致", () => {
    const ledger = new LedgerStore(":memory:", defaultPriceBook);
    try {
      ledger.saveAccounts([{ ...account, plan: "max-5x" }], at(0));
      ledger.saveQuotas(quotas, at(200));
      const before = estimate(ledger);
      expect(before.usd).not.toBeNull();
      ledger.saveAccounts([{ ...account, plan: "team-premium" }], at(205));
      expect(estimate(ledger)).toEqual(before);
    } finally {
      ledger.close();
    }
  });

  test("在合并目标上指定套餐，被合并账户的额度历史同样补全", () => {
    const ledger = store();
    try {
      ledger.saveAccounts(
        [{ ...account, externalId: "target", plan: null }],
        at(0),
      );
      ledger.setAccountMerge(ref("source", "team"), ref("source", "target"));
      ledger.setAccountPlan(ref("source", "target"), "team-premium");
      expect(ledger.quotas()[0]?.planHistory?.[0]?.plan).toBe("team-premium");
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

  test("Antigravity 账户指定 Ultra 5x 后，报表显示指定倍数，预估不变", () => {
    const ledger = new LedgerStore(":memory:", defaultPriceBook);
    try {
      ledger.saveAccounts(
        [{ ...account, platform: "google", plan: "Google AI Ultra" }],
        at(0),
      );
      ledger.saveQuotas(quotas, at(200));
      const before = estimate(ledger);
      expect(before.usd).not.toBeNull();
      ledger.setAccountPlan(ref("source", "team"), "ultra-5x");
      expect(ledger.accounts()[0]?.plan).toBe("ultra-5x");
      expect(estimate(ledger)).toEqual(before);
    } finally {
      ledger.close();
    }
  });
});
