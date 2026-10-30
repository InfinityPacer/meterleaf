import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPriceBook } from "../src/domain/default-prices";
import {
  priceBookKey,
  priceBookSchema,
  valueUsage,
} from "../src/domain/pricing";
import { loadPriceBook } from "../src/server/price-book";
import { LedgerStore } from "../src/storage/ledger";
import type { UsageFact } from "../src/domain/connector";

const usage: UsageFact = {
  sourceId: "test",
  externalId: "1",
  accountExternalId: "a",
  occurredAt: "2026-09-08T12:00:00.000Z",
  model: "gpt-6-astra",
  upstreamModel: null,
  tier: "default",
  tokens: {
    input: 300000,
    cacheRead: 0,
    cacheWrite: 0,
    output: 1000,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: null,
  },
  gatewayCost: "99",
  gatewayBilled: "42",
  upstreamUsd: null,
  upstreamCredits: null,
  metadata: {},
};

test("bundled JSON contains separate USD branches with unchanged credits", () => {
  const subscription = valueUsage(usage, defaultPriceBook);
  const api = valueUsage(usage, defaultPriceBook, "api");
  expect(subscription.usd.amount).toBe("3.05");
  expect(api.usd.amount).toBe("6.075");
  expect(subscription.credits).toEqual(api.credits);
  expect(subscription.apiUsd).toEqual(api.apiUsd);
  expect(subscription.version).toBe("meterleaf@2026-10-30.1");
  // 0.2 及更早版本的价格表标识为 meterleaf-openai，接替关系让报表缓存跨升级保留。
  expect(defaultPriceBook.supersedes).toEqual(["meterleaf-openai"]);
});

test("GPT-5.4 prices cached input at the exact long-context boundary without changing subscription estimates", () => {
  const fact = {
    ...usage,
    model: "gpt-5.4",
    tokens: { ...usage.tokens, input: 272000, cacheRead: 0 },
  };
  const exact = valueUsage(fact, defaultPriceBook);
  expect(exact.subscriptionUsd.amount).toBe("0.695");
  expect(exact.apiUsd.amount).toBe("0.695");
  expect(exact.credits.amount).toBe("17.375");
  const over = valueUsage(
    { ...fact, tokens: { ...fact.tokens, cacheRead: 1 } },
    defaultPriceBook,
  );
  expect(over.subscriptionUsd.amount).toBe("0.69500025");
  expect(over.apiUsd.amount).toBe("1.3825005");
  expect(over.credits.amount).toBe("17.37500625");
  expect(over.subscriptionUsd.reason).toBe("current-rate-applied-to-history");
});

test("GPT-6 Sol and Luna use the 2026-09-22 rates with long context only in API USD", () => {
  for (const [model, subscriptionUsd, apiUsd, credits] of [
    ["gpt-6-sol", "0.61", "1.215", "15.25"],
    ["gpt-6-luna", "0.0305", "0.06075", "0.7625"],
  ] as const) {
    const fact = { ...usage, model };
    const subscription = valueUsage(fact, defaultPriceBook);
    const api = valueUsage(fact, defaultPriceBook, "api");
    expect(subscription.usd.amount).toBe(subscriptionUsd);
    expect(api.usd.amount).toBe(apiUsd);
    expect(subscription.credits.amount).toBe(credits);
  }
});

test("Codex Fast credits use the published multiplier on Standard credits", () => {
  for (const [model, multiplier] of [
    ["gpt-5.4", "2"],
    ["gpt-5.6-sol", "2.5"],
    ["gpt-5.6-terra", "2.5"],
    ["gpt-5.6-luna", "2.5"],
    ["gpt-6-astra", "2.5"],
    ["gpt-6-sol", "2.5"],
    ["gpt-6-luna", "2.5"],
  ] as const) {
    const standard = valueUsage({ ...usage, model }, defaultPriceBook);
    const fast = valueUsage(
      { ...usage, model, tier: "fast" },
      defaultPriceBook,
    );
    expect(fast.credits.basis).toBe("estimated");
    expect(Number(fast.credits.amount)).toBeCloseTo(
      Number(standard.credits.amount) * Number(multiplier),
      9,
    );
  }
});

test("GPT-5.4 mini has independent USD and credits prices without inherited long-context rates", () => {
  const fact = {
    ...usage,
    model: "gpt-5.4-mini",
    tokens: { ...usage.tokens, input: 300000, cacheRead: 1000 },
  };
  const result = valueUsage(fact, defaultPriceBook);
  expect(result.subscriptionUsd.amount).toBe("0.229575");
  expect(result.apiUsd.amount).toBe("0.229575");
  expect(result.credits.amount).toBe("5.739875");
});

test("new model prices do not guess tiers, cache writes or unrelated model aliases", () => {
  for (const model of ["gpt-5.4", "gpt-5.4-mini"]) {
    for (const tier of ["fast", "priority", "flex"]) {
      const result = valueUsage({ ...usage, model, tier }, defaultPriceBook);
      expect(result.usd.reason).toBe("missing-rate");
      // 只有 GPT-5.4 公布了 Fast credits，Flex 与 mini 都没有。
      if (model === "gpt-5.4" && tier !== "flex") {
        expect(result.credits.amount).not.toBeNull();
      } else {
        expect(result.credits.amount).toBeNull();
      }
    }
    const write = valueUsage(
      { ...usage, model, tokens: { ...usage.tokens, cacheWrite: 1 } },
      defaultPriceBook,
    );
    expect(write.usd.reason).toBe("unsupported-rate-bucket");
    expect(write.credits.amount).toBeNull();
  }
  // codex-auto-review 由 OpenAI 路由到 gpt-6-luna，按 luna 计价；未公布的模型别名单独保留。
  expect(
    valueUsage({ ...usage, model: "gpt-reserve" }, defaultPriceBook).usd.amount,
  ).toBeNull();
  expect(
    valueUsage({ ...usage, model: "codex-auto-review" }, defaultPriceBook).usd
      .amount,
  ).not.toBeNull();
});

test("GLM-5.3-Flash prices both USD branches at the Go teaching rate without a cache write", () => {
  const fact = {
    ...usage,
    occurredAt: "2026-10-30T00:00:00Z",
    model: "glm-5.3-flash",
    tokens: {
      ...usage.tokens,
      input: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    },
  };
  for (const basis of ["subscription", "api"] as const) {
    const result = valueUsage(fact, defaultPriceBook, basis);
    expect(result.usdBasis).toBe(basis);
    expect(result.usd.amount).toBe("0.68");
    expect(result.usd.basis).toBe("estimated");
  }
  // Go 未公布缓存写入价，含写入的记录保留未计价；也没有峰时拆分。
  const write = valueUsage(
    { ...fact, tokens: { ...fact.tokens, cacheWrite: 1 } },
    defaultPriceBook,
  );
  expect(write.usd.reason).toBe("unsupported-rate-bucket");
});

test("GPT-6.1 Sol and Terra prices follow the published pages with long context only in API USD", () => {
  for (const [model, inputRate, cacheRate, writeRate, outputRate] of [
    ["gpt-6.1-sol", "2", "0.1", "2.5", "10"],
    ["gpt-6.1-terra", "1", "0.05", "1.25", "5"],
  ] as const) {
    const fact = {
      ...usage,
      occurredAt: "2026-10-30T00:00:00Z",
      model,
      tokens: {
        input: 50_000,
        cacheRead: 50_000,
        cacheWrite: 50_000,
        output: 50_000,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: null,
      },
    };
    const rateSum =
      Number(inputRate) +
      Number(cacheRate) +
      Number(writeRate) +
      Number(outputRate);
    const subscription = valueUsage(fact, defaultPriceBook);
    const api = valueUsage(fact, defaultPriceBook, "api");
    // 总输入未越过 272K 长上下文档位，两个 USD 分支价格一致。
    expect(subscription.usd.amount).toBe((rateSum / 20).toString());
    expect(api.usd.amount).toBe(subscription.usd.amount);
    // 缓存写入没有 Credits 费率，这条含写入的记录在 Credits 侧整条未计价。
    expect(subscription.credits.amount).toBeNull();
    const fast = valueUsage({ ...fact, tier: "fast" }, defaultPriceBook);
    expect(Number(fast.usd.amount)).toBeCloseTo(
      Number(subscription.usd.amount) * 2,
      9,
    );
  }
  // 计价不猜长上下文：Codex 订阅内没有加价，API 分支有公布档位。
  const longContext = {
    ...usage,
    occurredAt: "2026-10-30T00:00:00Z",
    model: "gpt-6.1-sol",
    tokens: { ...usage.tokens, input: 273_000, cacheRead: 0 },
  };
  expect(valueUsage(longContext, defaultPriceBook).usd.amount).toBe("0.556");
  expect(valueUsage(longContext, defaultPriceBook, "api").usd.amount).toBe(
    "1.107",
  );
});

test("codex-auto-review routes to gpt-6-luna and is priced with its published rates", () => {
  const fact = {
    ...usage,
    model: "codex-auto-review",
    occurredAt: "2026-10-30T00:00:00Z",
  };
  const luna = valueUsage({ ...fact, model: "gpt-6-luna" }, defaultPriceBook);
  const routed = valueUsage(fact, defaultPriceBook);
  expect(routed.usd.amount).toBe(luna.usd.amount);
  expect(routed.credits.amount).toBe(luna.credits.amount);
});

const deepseekRule = defaultPriceBook.rules.find(
  (rule) =>
    rule.model === "deepseek-v4.1-flash" && rule.usdBasis === "subscription",
)!;
function deepseekFact(occurredAt: string): UsageFact {
  return {
    ...usage,
    occurredAt,
    model: "deepseek-v4.1-flash",
    tier: "standard",
    tokens: {
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      output: 1_000_000,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
  };
}
function ruleAccepted(rule: unknown) {
  return priceBookSchema.safeParse({ ...defaultPriceBook, rules: [rule] })
    .success;
}

test("bundled book values DeepSeek V4.1 Flash at Go's weekday peak and off-peak prices", () => {
  // Go 的峰时是 UTC 周一至周五 01:00-04:00 与 06:00-10:00，起点包含、终点不包含。
  for (const [occurredAt, amount] of [
    ["2026-10-30T00:59:00Z", "0.753"],
    ["2026-10-30T01:00:00Z", "1.506"],
    ["2026-10-30T03:59:00Z", "1.506"],
    ["2026-10-30T04:00:00Z", "0.753"],
    ["2026-10-30T06:00:00Z", "1.506"],
    ["2026-10-30T09:59:00Z", "1.506"],
    ["2026-10-30T10:00:00Z", "0.753"],
    ["2026-10-31T02:00:00Z", "0.753"],
    ["2026-11-01T07:00:00Z", "0.753"],
  ] as const) {
    const fact = deepseekFact(occurredAt);
    const subscription = valueUsage(fact, defaultPriceBook);
    const api = valueUsage(fact, defaultPriceBook, "api");
    expect(subscription.usd.amount).toBe(amount);
    expect(api.usd.amount).toBe(amount);
    expect(subscription.usd.reason).toBeNull();
  }
  // 峰时同样不猜测未公布的缓存写入价。
  const write = deepseekFact("2026-10-30T02:00:00Z");
  write.tokens.cacheWrite = 1;
  expect(valueUsage(write, defaultPriceBook).usd.reason).toBe(
    "unsupported-rate-bucket",
  );
});

test("schema rejects malformed peak blocks and combinations with other rate tiers", () => {
  expect(ruleAccepted(deepseekRule)).toBe(true);
  const mutations: ((rule: typeof deepseekRule) => void)[] = [
    (rule) => {
      rule.peak!.hoursUtc[0] = { from: "04:00", until: "04:00" };
    },
    (rule) => {
      rule.peak!.hoursUtc[0] = { from: "10:00", until: "01:00" };
    },
    (rule) => {
      rule.peak!.hoursUtc[0] = { from: "1:00", until: "04:00" };
    },
    (rule) => {
      rule.peak!.hoursUtc[0] = { from: "01:00", until: "24:00" };
    },
    (rule) => {
      rule.peak!.days = [1, 1];
    },
    (rule) => {
      rule.peak!.days = [];
    },
    (rule) => {
      rule.peak!.days = [0];
    },
    (rule) => {
      rule.peak!.hoursUtc = [];
    },
    (rule) => {
      rule.longContext = { threshold: 1000, rates: rule.rates };
    },
    (rule) => {
      rule.imageRates = {
        input: "1",
        cacheRead: "1",
        output: "1",
      };
    },
  ];
  for (const mutate of mutations) {
    const rule = structuredClone(deepseekRule);
    mutate(rule);
    expect(ruleAccepted(rule)).toBe(false);
  }
});

test("price revision revalues missing model history while preserving prior prices and raw facts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-price-revision-"));
  const path = join(dir, "ledger.sqlite");
  const prior = {
    ...defaultPriceBook,
    version: "fixture-before-gpt54",
    rules: defaultPriceBook.rules.filter(
      (rule) => !["gpt-5.4", "gpt-5.4-mini"].includes(rule.model),
    ),
  };
  let store = new LedgerStore(path, prior);
  const fact = { ...usage, model: "gpt-5.4-mini" };
  try {
    store.savePage(
      "test",
      "incremental",
      { records: [fact], nextCursor: "1", hasMore: false },
      usage.occurredAt,
    );
    expect(store.usage()[0]!.valuation.usd.amount).toBeNull();
    store.close();
    store = new LedgerStore(path, defaultPriceBook);
    const revised = store.usage()[0]!;
    expect(revised.fact).toEqual(fact);
    expect(revised.valuation.usd.amount).toBe("0.2295");
    expect(revised.valuation.version).toBe(priceBookKey(defaultPriceBook));
    const old = store.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM price_books WHERE version=?",
      )
      .get(priceBookKey(prior));
    expect(JSON.parse(old!.payload)).toEqual(prior);
    expect(
      store.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM usage_facts",
        )
        .get()!.count,
    ).toBe(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("custom JSON controls one branch without falling back to other rates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-prices-"));
  try {
    const path = join(dir, "custom.json");
    const custom = {
      ...defaultPriceBook,
      id: "custom",
      version: "1",
      rules: [
        {
          ...defaultPriceBook.rules.find(
            (rule) =>
              rule.model === usage.model &&
              rule.currency === "usd" &&
              rule.usdBasis === "subscription" &&
              rule.tier === "standard",
          )!,
          rates: {
            input: "1",
            cacheRead: "0.1",
            cacheWrite: null,
            output: "5",
          },
        },
      ],
    };
    await Bun.write(path, JSON.stringify(custom));
    const loaded = await loadPriceBook(path);
    expect(priceBookKey(loaded)).toBe("custom@1");
    const result = valueUsage(usage, loaded);
    expect(result.subscriptionUsd.amount).toBe("0.305");
    expect(result.apiUsd.amount).toBeNull();
    expect(result.credits.amount).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("schema rejects unsupported format, unknown fields and ambiguous branch ranges", () => {
  expect(
    priceBookSchema.safeParse({ ...defaultPriceBook, schemaVersion: 2 })
      .success,
  ).toBe(false);
  expect(
    priceBookSchema.safeParse({ ...defaultPriceBook, discount: 0.8 }).success,
  ).toBe(false);
  expect(
    priceBookSchema.safeParse({
      ...defaultPriceBook,
      rules: [defaultPriceBook.rules[0], defaultPriceBook.rules[0]],
    }).success,
  ).toBe(false);
  const { usdBasis: _basis, ...missingBasis } = defaultPriceBook.rules[0]!;
  expect(
    priceBookSchema.safeParse({ ...defaultPriceBook, rules: [missingBasis] })
      .success,
  ).toBe(false);
});
test("upstream USD is not silently used for a different estimation basis", () => {
  const result = valueUsage(
    { ...usage, upstreamUsd: "9", upstreamUsdBasis: "api" },
    defaultPriceBook,
  );
  expect(result.apiUsd.amount).toBe("9");
  expect(result.subscriptionUsd.amount).toBe("3.05");
});
test("same identity and revision cannot change rates; independent book identities can share a version", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    store.savePage(
      "test",
      "incremental",
      { records: [usage], nextCursor: "1", hasMore: false },
      usage.occurredAt,
    );
    expect(store.usage()[0]!.valuation.apiUsd.amount).toBe("6.075");
    expect(store.usage()[0]!.valuation.subscriptionUsd.amount).toBe("3.05");
    expect(priceBookKey({ ...defaultPriceBook, id: "custom" })).not.toBe(
      priceBookKey(defaultPriceBook),
    );
  } finally {
    store.close();
  }
});
