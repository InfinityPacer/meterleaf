import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPriceBook } from "../src/domain/default-prices";
import { buildPriceBook } from "../prices/catalog";
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

test("bundled JSON matches catalog generator and retires built-in credits", () => {
  expect(defaultPriceBook).toEqual(buildPriceBook());
  expect(defaultPriceBook.rules.every((rule) => rule.currency === "usd")).toBe(
    true,
  );
  const subscription = valueUsage(usage, defaultPriceBook);
  const api = valueUsage(usage, defaultPriceBook, "api");
  expect(subscription.usd.amount).toBe("3.05");
  expect(api.usd.amount).toBe("6.075");
  expect(subscription.credits.amount).toBeNull();
  expect(api.credits.amount).toBeNull();
  expect(subscription.apiUsd).toEqual(api.apiUsd);
  expect(subscription.version).toBe("meterleaf@2026-11-23.2");
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
  const over = valueUsage(
    { ...fact, tokens: { ...fact.tokens, cacheRead: 1 } },
    defaultPriceBook,
  );
  expect(over.subscriptionUsd.amount).toBe("0.69500025");
  expect(over.apiUsd.amount).toBe("1.3825005");
  expect(over.subscriptionUsd.reason).toBe("current-rate-applied-to-history");
});

test("GPT-6 Sol and Luna use the 2026-09-22 rates with long context only in API USD", () => {
  for (const [model, subscriptionUsd, apiUsd] of [
    ["gpt-6-sol", "0.61", "1.215"],
    ["gpt-6-luna", "0.0305", "0.06075"],
  ] as const) {
    const fact = { ...usage, model };
    const subscription = valueUsage(fact, defaultPriceBook);
    const api = valueUsage(fact, defaultPriceBook, "api");
    expect(subscription.usd.amount).toBe(subscriptionUsd);
    expect(api.usd.amount).toBe(apiUsd);
    expect(subscription.credits.amount).toBeNull();
  }
});

test("GPT-5.4 mini has independent USD prices without inherited long-context rates", () => {
  const fact = {
    ...usage,
    model: "gpt-5.4-mini",
    tokens: { ...usage.tokens, input: 300000, cacheRead: 1000 },
  };
  const result = valueUsage(fact, defaultPriceBook);
  expect(result.subscriptionUsd.amount).toBe("0.229575");
  expect(result.apiUsd.amount).toBe("0.229575");
  expect(result.credits.amount).toBeNull();
});

test("new model prices do not guess tiers, cache writes or unrelated model aliases", () => {
  for (const model of ["gpt-5.4", "gpt-5.4-mini"]) {
    for (const tier of ["fast", "priority", "flex"]) {
      const result = valueUsage({ ...usage, model, tier }, defaultPriceBook);
      expect(result.usd.reason).toBe("missing-rate");
      expect(result.credits.amount).toBeNull();
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

test("GLM-5.3 prices both USD branches at the published Go and Zhipu rate without cache writes", () => {
  const fact = {
    ...usage,
    occurredAt: "2026-10-30T00:00:00Z",
    model: "glm-5.3",
    tokens: {
      ...usage.tokens,
      input: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    },
  };
  expect(valueUsage(fact, defaultPriceBook).usd.amount).toBe("6.06");
  expect(valueUsage(fact, defaultPriceBook, "api").usd.amount).toBe("6.06");
  expect(
    valueUsage(
      { ...fact, tokens: { ...fact.tokens, cacheWrite: 1 } },
      defaultPriceBook,
    ).usd.reason,
  ).toBe("unsupported-rate-bucket");
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
    ["2026-11-27T00:59:00Z", "0.753"],
    ["2026-11-27T01:00:00Z", "1.506"],
    ["2026-11-27T03:59:00Z", "1.506"],
    ["2026-11-27T04:00:00Z", "0.753"],
    ["2026-11-27T06:00:00Z", "1.506"],
    ["2026-11-27T09:59:00Z", "1.506"],
    ["2026-11-27T10:00:00Z", "0.753"],
    ["2026-11-28T02:00:00Z", "0.753"],
    ["2026-11-29T07:00:00Z", "0.753"],
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

test("Antigravity models use their published Google, Anthropic and Model Garden rates", () => {
  const baseFact: UsageFact = {
    ...usage,
    occurredAt: "2026-10-30T12:00:00Z",
    tier: "standard",
    tokens: {
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      output: 1_000_000,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: 100_000,
    },
  };

  // Gemini 4 Carbon: 促销期至 2026-11-30（$2 / $0.10 / $10），2026-12-01 起（$4 / $0.20 / $20）。
  for (const model of ["gemini-4-carbon", "gemini-4-argon"] as const) {
    const promo = valueUsage({ ...baseFact, model }, defaultPriceBook);
    expect(promo.subscriptionUsd.amount).toBe("12.1");
    expect(promo.apiUsd.amount).toBe("12.1");
    expect(
      valueUsage({ ...baseFact, model, tier: "flex" }, defaultPriceBook)
        .subscriptionUsd.amount,
    ).toBe("6.05");
    const postPromo = valueUsage(
      { ...baseFact, model, occurredAt: "2026-12-01T00:00:00Z" },
      defaultPriceBook,
    );
    expect(postPromo.subscriptionUsd.amount).toBe("24.2");
    expect(postPromo.apiUsd.amount).toBe("24.2");
    expect(
      valueUsage(
        { ...baseFact, model, tokens: { ...baseFact.tokens, cacheWrite: 1 } },
        defaultPriceBook,
      ).usd.reason,
    ).toBe("unsupported-rate-bucket");
  }

  // Gemini 4 Argon: 促销期至 2026-11-30（$2 / $0.10 / $10），2026-12-01 起（$4 / $0.20 / $20）。
  const argonPromo = valueUsage(
    { ...baseFact, model: "gemini-4-argon" },
    defaultPriceBook,
  );
  expect(argonPromo.subscriptionUsd.amount).toBe("12.1");
  expect(argonPromo.apiUsd.amount).toBe("12.1");
  expect(
    valueUsage(
      { ...baseFact, model: "gemini-4-argon", tier: "flex" },
      defaultPriceBook,
    ).subscriptionUsd.amount,
  ).toBe("6.05");
  const argonPostPromo = valueUsage(
    {
      ...baseFact,
      model: "gemini-4-argon",
      occurredAt: "2026-12-01T00:00:00Z",
    },
    defaultPriceBook,
  );
  expect(argonPostPromo.subscriptionUsd.amount).toBe("24.2");
  expect(argonPostPromo.apiUsd.amount).toBe("24.2");
  expect(
    valueUsage(
      {
        ...baseFact,
        model: "gemini-4-argon",
        tokens: { ...baseFact.tokens, cacheWrite: 1 },
      },
      defaultPriceBook,
    ).usd.reason,
  ).toBe("unsupported-rate-bucket");

  // Gemini 3.8 Flash: 促销期至 2026-12-31（$0.75 / $0.075 / $3.75），2027-01-01 起（$1.50 / $0.15 / $7.50）。
  const flashPromo = valueUsage(
    { ...baseFact, model: "gemini-3.8-flash" },
    defaultPriceBook,
  );
  expect(flashPromo.subscriptionUsd.amount).toBe("4.575");
  expect(flashPromo.apiUsd.amount).toBe("4.575");
  expect(
    valueUsage(
      { ...baseFact, model: "gemini-3.8-flash", tier: "flex" },
      defaultPriceBook,
    ).subscriptionUsd.amount,
  ).toBe("2.2875");
  const flashPostPromo = valueUsage(
    {
      ...baseFact,
      model: "gemini-3.8-flash",
      occurredAt: "2027-01-01T00:00:00Z",
    },
    defaultPriceBook,
  );
  expect(flashPostPromo.subscriptionUsd.amount).toBe("9.15");
  expect(flashPostPromo.apiUsd.amount).toBe("9.15");

  // Claude Sonnet 5.5: $2 输入、$0.10 缓存读取、$2.50 (5m) / $4 (1h) 缓存写入、$10 输出。
  const sonnet = valueUsage(
    {
      ...baseFact,
      model: "claude-sonnet-5-5",
      tokens: {
        ...baseFact.tokens,
        cacheWrite: 1_000_000,
        cacheWrite5m: 400_000,
        cacheWrite1h: 600_000,
      },
    },
    defaultPriceBook,
  );
  expect(sonnet.subscriptionUsd.amount).toBe("15.5");
  expect(sonnet.apiUsd.amount).toBe("15.5");

  // GPT-OSS 120B: $0.09 输入、$0.36 输出；未公布缓存读取价，有缓存读取时保留未计价。
  const gptOss = valueUsage(
    {
      ...baseFact,
      model: "gpt-oss-120b",
      tokens: { ...baseFact.tokens, cacheRead: 0 },
    },
    defaultPriceBook,
  );
  expect(gptOss.subscriptionUsd.amount).toBe("0.45");
  expect(gptOss.apiUsd.amount).toBe("0.45");
  expect(
    valueUsage({ ...baseFact, model: "gpt-oss-120b" }, defaultPriceBook).usd
      .reason,
  ).toBe("unsupported-rate-bucket");

  // Gemini 4 Neon: 常态费率 $3.00 / $0.15 / $15.00（Flex $1.50 / $0.075 / $7.50），无促销分段。
  const neon = valueUsage(
    { ...baseFact, model: "gemini-4-neon" },
    defaultPriceBook,
  );
  expect(neon.subscriptionUsd.amount).toBe("18.15");
  expect(neon.apiUsd.amount).toBe("18.15");
  expect(
    valueUsage(
      { ...baseFact, model: "gemini-4-neon", tier: "flex" },
      defaultPriceBook,
    ).subscriptionUsd.amount,
  ).toBe("9.075");
  expect(
    valueUsage(
      {
        ...baseFact,
        model: "gemini-4-neon",
        occurredAt: "2027-02-01T00:00:00Z",
      },
      defaultPriceBook,
    ).subscriptionUsd.amount,
  ).toBe("18.15");
  expect(
    valueUsage(
      {
        ...baseFact,
        model: "gemini-4-neon",
        tokens: { ...baseFact.tokens, cacheWrite: 1 },
      },
      defaultPriceBook,
    ).usd.reason,
  ).toBe("unsupported-rate-bucket");

  // Gemini 4 Hydrogen: 常态费率 $1.50 / $0.075 / $7.50（Flex $0.75 / $0.0375 / $3.75），无促销分段。
  const hydrogen = valueUsage(
    { ...baseFact, model: "gemini-4-hydrogen" },
    defaultPriceBook,
  );
  expect(hydrogen.subscriptionUsd.amount).toBe("9.075");
  expect(hydrogen.apiUsd.amount).toBe("9.075");
  expect(
    valueUsage(
      { ...baseFact, model: "gemini-4-hydrogen", tier: "flex" },
      defaultPriceBook,
    ).subscriptionUsd.amount,
  ).toBe("4.5375");
  expect(
    valueUsage(
      {
        ...baseFact,
        model: "gemini-4-hydrogen",
        occurredAt: "2027-02-01T00:00:00Z",
      },
      defaultPriceBook,
    ).subscriptionUsd.amount,
  ).toBe("9.075");
  expect(
    valueUsage(
      {
        ...baseFact,
        model: "gemini-4-hydrogen",
        tokens: { ...baseFact.tokens, cacheWrite: 1 },
      },
      defaultPriceBook,
    ).usd.reason,
  ).toBe("unsupported-rate-bucket");

  // Gemini 3.5 Flash-Lite: 标准档 $0.30 / $0.03 / $2.50；Flex 档文档舍入不一致，保留未计价。
  const flashLite = valueUsage(
    { ...baseFact, model: "gemini-3.5-flash-lite" },
    defaultPriceBook,
  );
  expect(flashLite.subscriptionUsd.amount).toBe("2.83");
  expect(flashLite.apiUsd.amount).toBe("2.83");
  expect(
    valueUsage(
      { ...baseFact, model: "gemini-3.5-flash-lite", tier: "flex" },
      defaultPriceBook,
    ).usd.reason,
  ).toBe("missing-rate");

  // Claude Fable 5.2: 标准档 $8 / $0.20 (2.5%) / $10 (5m) / $16 (1h) / $40，快速模式翻倍并叠加缓存倍率。
  const fable52Fact: UsageFact = {
    ...baseFact,
    model: "claude-fable-5-2",
    tokens: {
      ...baseFact.tokens,
      cacheWrite: 1_000_000,
      cacheWrite5m: 400_000,
      cacheWrite1h: 600_000,
    },
  };
  expect(valueUsage(fable52Fact, defaultPriceBook).subscriptionUsd.amount).toBe(
    "61.8",
  );
  expect(valueUsage(fable52Fact, defaultPriceBook, "api").usd.amount).toBe(
    "61.8",
  );
  expect(
    valueUsage({ ...fable52Fact, tier: "fast" }, defaultPriceBook)
      .subscriptionUsd.amount,
  ).toBe("123.6");

  // Claude Haiku 5.5: <=100K 为 $0.10/$0.01/$0.125/$0.20/$0.50，API 分支 >100K 升至 5 倍，订阅等价 USD 不加价。
  const haikuAtBoundary: UsageFact = {
    ...baseFact,
    model: "claude-haiku-5-5",
    tokens: {
      input: 80_000,
      cacheRead: 10_000,
      cacheWrite: 10_000,
      output: 20_000,
      cacheWrite5m: 0,
      cacheWrite1h: 10_000,
      reasoning: null,
    },
  };
  expect(
    valueUsage(haikuAtBoundary, defaultPriceBook).subscriptionUsd.amount,
  ).toBe("0.0201");
  expect(valueUsage(haikuAtBoundary, defaultPriceBook, "api").usd.amount).toBe(
    "0.0201",
  );
  const haikuOverBoundary: UsageFact = {
    ...haikuAtBoundary,
    tokens: { ...haikuAtBoundary.tokens, cacheRead: 10_001 },
  };
  expect(
    valueUsage(haikuOverBoundary, defaultPriceBook).subscriptionUsd.amount,
  ).toBe("0.02010001");
  expect(
    valueUsage(haikuOverBoundary, defaultPriceBook, "api").usd.amount,
  ).toBe("0.10050005");

  // GPT Image 2.6 Sunburst / Flare: 公布 USD 文本与图像单价，Codex Credits 未公布前保持未计价。
  for (const model of [
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
  ] as const) {
    const imgFact: UsageFact = {
      ...baseFact,
      model,
      tokens: {
        input: 10_000,
        cacheRead: 4_000,
        cacheWrite: 0,
        output: 5_000,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: null,
        image: { input: 6_000, cacheRead: 2_000, output: 5_000 },
      },
    };
    const priced = valueUsage(imgFact, defaultPriceBook);
    expect(priced.subscriptionUsd.amount).toBe("0.2185");
    expect(priced.apiUsd.amount).toBe("0.2185");
    expect(priced.credits.amount).toBeNull();
  }
});

test("GPT-6.2 Sol and Astra cover standard and priority tiers without guessing flex", () => {
  for (const [model, inputRate, cacheRate, writeRate, outputRate] of [
    ["gpt-6.2-sol", "2", "0.1", "2.5", "10"],
    ["gpt-6.2-astra", "8", "0.4", "10", "40"],
  ] as const) {
    const fact: UsageFact = {
      ...usage,
      occurredAt: "2026-11-23T00:00:00Z",
      model,
      tier: "standard",
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
    const standard = valueUsage(fact, defaultPriceBook);
    const api = valueUsage(fact, defaultPriceBook, "api");
    expect(standard.usd.amount).toBe((rateSum / 20).toString());
    expect(api.usd.amount).toBe(standard.usd.amount);
    expect(standard.usd.reason).toBeNull();
    expect(
      valueUsage(
        { ...fact, occurredAt: "2026-11-22T23:59:59Z" },
        defaultPriceBook,
      ).usd.reason,
    ).toBe("current-rate-applied-to-history");

    const priority = valueUsage({ ...fact, tier: "fast" }, defaultPriceBook);
    expect(Number(priority.usd.amount)).toBeCloseTo(
      Number(standard.usd.amount) * 2,
      9,
    );

    const flex = valueUsage({ ...fact, tier: "flex" }, defaultPriceBook);
    expect(flex.usd.amount).toBeNull();
    expect(flex.usd.reason).toBe("missing-rate");
  }

  // >272K 长上下文仅在标准 API USD 分支加价，订阅等价 USD 保持基础价。
  const longFact: UsageFact = {
    ...usage,
    occurredAt: "2026-11-23T00:00:00Z",
    model: "gpt-6.2-sol",
    tier: "standard",
    tokens: { ...usage.tokens, input: 273_000, cacheRead: 0, output: 1_000 },
  };
  expect(valueUsage(longFact, defaultPriceBook).usd.amount).toBe("0.556");
  expect(valueUsage(longFact, defaultPriceBook, "api").usd.amount).toBe(
    "1.107",
  );
});

test("route-prefix fallback matches trailing official model ID without fuzzy aliasing", () => {
  const routedCases = [
    ["auto/gpt-6.1-sol", "gpt-6.1-sol"],
    ["codex/gpt-6.1-sol", "gpt-6.1-sol"],
    ["google-vertex/gemini-4-hydrogen", "gemini-4-hydrogen"],
    ["agy-cli/claude-opus-5-5", "claude-opus-5-5"],
    ["commandcode/deepseek/deepseek-v4.1-flash", "deepseek-v4.1-flash"],
    ["group/gpt-6.1-sol", "gpt-6.1-sol"],
  ] as const;

  for (const [routedModel, canonicalModel] of routedCases) {
    const baseFact: UsageFact = {
      ...usage,
      occurredAt: "2026-11-23T00:00:00Z",
      model: canonicalModel,
      tier: "standard",
      tokens: {
        input: 100_000,
        cacheRead: 20_000,
        cacheWrite: 0,
        output: 10_000,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: null,
      },
    };
    const direct = valueUsage(baseFact, defaultPriceBook);
    const routed = valueUsage(
      { ...baseFact, model: routedModel },
      defaultPriceBook,
    );
    expect(routed.subscriptionUsd.amount).toBe(direct.subscriptionUsd.amount);
    expect(routed.apiUsd.amount).toBe(direct.apiUsd.amount);
    expect(routed.pricingModel).toBe(canonicalModel);
  }

  // 未配置显式别名的自定义末段及尾部斜杠保持未计价。
  for (const unmapped of ["group/auto-gemini-4-carbon", "codex/"]) {
    const result = valueUsage(
      {
        ...usage,
        occurredAt: "2026-11-23T00:00:00Z",
        model: unmapped,
        tier: "standard",
      },
      defaultPriceBook,
    );
    expect(result.usd.amount).toBeNull();
    expect(result.usd.reason).toBe("missing-rate");
    expect(result.pricingModel).toBeUndefined();
  }

  // 精确规则优先于剥离前缀；原名存在规则时缺失档位不回退到末段规则。
  const customBook = priceBookSchema.parse({
    ...defaultPriceBook,
    version: "2026-11-23.1-custom",
    rules: [
      ...defaultPriceBook.rules,
      {
        model: "codex/gpt-6.1-sol",
        tier: "standard",
        currency: "usd",
        usdBasis: "subscription",
        effectiveFrom: "1970-01-01T00:00:00Z",
        rates: { input: "9", cacheRead: "0", cacheWrite: "0", output: "9" },
      },
      {
        model: "codex/gpt-6.1-sol",
        tier: "standard",
        currency: "usd",
        usdBasis: "api",
        effectiveFrom: "1970-01-01T00:00:00Z",
        rates: { input: "9", cacheRead: "0", cacheWrite: "0", output: "9" },
      },
    ],
  });
  const exactHit = valueUsage(
    {
      ...usage,
      occurredAt: "2026-11-23T00:00:00Z",
      model: "codex/gpt-6.1-sol",
      tier: "standard",
      tokens: { ...usage.tokens, input: 1_000_000, output: 0 },
    },
    customBook,
  );
  expect(exactHit.subscriptionUsd.amount).toBe("9");
  expect(exactHit.pricingModel).toBeUndefined();

  const missingTier = valueUsage(
    {
      ...usage,
      occurredAt: "2026-11-23T00:00:00Z",
      model: "codex/gpt-6.1-sol",
      tier: "priority",
    },
    customBook,
  );
  expect(missingTier.subscriptionUsd.amount).toBeNull();
  expect(missingTier.subscriptionUsd.reason).toBe("missing-rate");
});

test("model aliases overlay prices private groups, applies excludePrefixes, folds notes into 16-char digest, and validates strictly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-aliases-"));
  try {
    const aliasPath = join(dir, "model-aliases.json");
    const dbPath = join(dir, "ledger.sqlite");
    await Bun.write(
      aliasPath,
      JSON.stringify({
        aliases: {
          "group/auto-gemini-4-carbon": "gemini-4-carbon",
          "group/auto-gemini-4-hydrogen": "gemini-4-hydrogen",
        },
        excludePrefixes: ["group", "Pool/"],
        notes: ["Initial note"],
      }),
    );
    const loaded1 = await loadPriceBook(undefined, aliasPath);
    expect(loaded1.version).toMatch(/^2026-11-23\.2\+aliases-[0-9a-f]{16}$/);
    expect(loaded1.excludeRoutePrefixes).toEqual(["group/", "pool/"]);
    expect(priceBookKey(loaded1).split("@")).toHaveLength(2);

    // 显式别名优先级高于 excludePrefixes。
    const groupFact: UsageFact = {
      ...usage,
      occurredAt: "2026-11-23T00:00:00Z",
      model: "group/auto-gemini-4-carbon",
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
    const priced = valueUsage(groupFact, loaded1);
    const direct = valueUsage(
      { ...groupFact, model: "gemini-4-carbon" },
      defaultPriceBook,
    );
    expect(priced.subscriptionUsd.amount).toBe(direct.subscriptionUsd.amount);
    expect(priced.apiUsd.amount).toBe(direct.apiUsd.amount);
    expect(priced.pricingModel).toBe("gemini-4-carbon");

    // 命中 excludePrefixes 时忽略大小写阻止自动前缀剥离，但不误伤不同首段前缀。
    for (const blocked of [
      "group/gpt-6.1-sol",
      "GROUP/gpt-6.1-sol",
      "pool/gpt-6.1-sol",
      "POOL/nested/gpt-6.1-sol",
    ]) {
      const blockedResult = valueUsage(
        { ...groupFact, model: blocked },
        loaded1,
      );
      expect(blockedResult.usd.amount).toBeNull();
      expect(blockedResult.usd.reason).toBe("missing-rate");
      expect(blockedResult.pricingModel).toBeUndefined();
    }
    const siblingPrefix = valueUsage(
      { ...groupFact, model: "group-alt/gpt-6.1-sol" },
      loaded1,
    );
    expect(siblingPrefix.pricingModel).toBe("gpt-6.1-sol");
    expect(siblingPrefix.subscriptionUsd.amount).not.toBeNull();

    // 仅配置 excludePrefixes（省略 aliases）同样派生新版本键并生效。
    const excludeOnlyPath = join(dir, "exclude-only.json");
    await Bun.write(
      excludeOnlyPath,
      JSON.stringify({ excludePrefixes: ["group/"] }),
    );
    const excludeOnly = await loadPriceBook(undefined, excludeOnlyPath);
    expect(excludeOnly.version).toMatch(
      /^2026-11-23\.2\+aliases-[0-9a-f]{16}$/,
    );
    expect(
      valueUsage({ ...groupFact, model: "GROUP/gpt-6.1-sol" }, excludeOnly).usd
        .reason,
    ).toBe("missing-rate");

    // 仅修改 notes 时摘要与版本键必须同步变化，账本重新打开不会报内容冲突。
    const store1 = new LedgerStore(dbPath, loaded1);
    store1.close();
    await Bun.write(
      aliasPath,
      JSON.stringify({
        aliases: {
          "group/auto-gemini-4-hydrogen": "gemini-4-hydrogen",
          "group/auto-gemini-4-carbon": "gemini-4-carbon",
        },
        excludePrefixes: ["pool/", "GROUP"],
        notes: ["Updated note"],
      }),
    );
    const loaded2 = await loadPriceBook(undefined, aliasPath);
    expect(loaded2.version).not.toBe(loaded1.version);
    const store2 = new LedgerStore(dbPath, loaded2);
    store2.close();

    // 仅交换键顺序（含 Unicode 规范等价键、纯数字键及 excludePrefixes 顺序与大小写）时，摘要保持一致。
    const reorderedPath = join(dir, "reordered-aliases.json");
    await Bun.write(
      aliasPath,
      JSON.stringify({
        aliases: {
          "10": "gemini-4-carbon",
          "2": "gemini-4-hydrogen",
          "group/\u00e9": "gemini-4-carbon",
          "group/e\u0301": "gemini-4-hydrogen",
        },
        excludePrefixes: ["Pool", "group/"],
        notes: ["Canonical order"],
      }),
    );
    await Bun.write(
      reorderedPath,
      JSON.stringify({
        aliases: {
          "2": "gemini-4-hydrogen",
          "group/e\u0301": "gemini-4-hydrogen",
          "10": "gemini-4-carbon",
          "group/\u00e9": "gemini-4-carbon",
        },
        excludePrefixes: ["GROUP", "pool///"],
        notes: ["Canonical order"],
      }),
    );
    const canon1 = await loadPriceBook(undefined, aliasPath);
    const canon2 = await loadPriceBook(undefined, reorderedPath);
    expect(canon1.version).toBe(canon2.version);
    const { createHash } = await import("node:crypto");
    const expectedCanonDigest = createHash("sha256")
      .update(
        JSON.stringify({
          aliases: [
            ["10", "gemini-4-carbon"],
            ["2", "gemini-4-hydrogen"],
            ["group/e\u0301", "gemini-4-hydrogen"],
            ["group/\u00e9", "gemini-4-carbon"],
          ],
          excludePrefixes: ["group/", "pool/"],
          notes: ["Canonical order"],
        }),
      )
      .digest("hex")
      .slice(0, 16);
    expect(canon1.version).toBe(
      `${defaultPriceBook.version}+aliases-${expectedCanonDigest}`,
    );

    // 基础价格表版本含 `@` 时拒绝生成非法派生版本键。
    const badBasePath = join(dir, "bad-base-book.json");
    await Bun.write(
      badBasePath,
      JSON.stringify({ ...defaultPriceBook, version: "2026@local" }),
    );
    await expect(loadPriceBook(badBasePath, aliasPath)).rejects.toThrow(
      /must not contain '@'/,
    );

    // 拒绝非法 excludePrefixes、覆盖已有规则的别名、未知目标与缺失文件。
    await Bun.write(aliasPath, JSON.stringify({ excludePrefixes: ["/"] }));
    await expect(loadPriceBook(undefined, aliasPath)).rejects.toThrow(
      /Invalid model aliases fields/,
    );

    await Bun.write(
      aliasPath,
      JSON.stringify({ aliases: { "gpt-6.1-sol": "gpt-6.1-terra" } }),
    );
    await expect(loadPriceBook(undefined, aliasPath)).rejects.toThrow(
      /shadow an existing priced model/,
    );

    await Bun.write(
      aliasPath,
      JSON.stringify({ aliases: { "group/unknown": "nonexistent-model" } }),
    );
    await expect(loadPriceBook(undefined, aliasPath)).rejects.toThrow(
      /must match a priced model/,
    );

    await expect(
      loadPriceBook(undefined, join(dir, "missing.json")),
    ).rejects.toThrow(/Cannot read or parse METERLEAF_MODEL_ALIASES JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LedgerStore upgrades stale same-version missing-rate valuations for routed models on reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-routed-upgrade-"));
  const dbPath = join(dir, "ledger.sqlite");
  try {
    const fact: UsageFact = {
      ...usage,
      occurredAt: "2026-11-23T00:00:00.000Z",
      model: "codex/gpt-6.1-sol",
      tier: "standard",
      tokens: {
        input: 100_000,
        cacheRead: 20_000,
        cacheWrite: 0,
        output: 10_000,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: null,
      },
    };
    const store1 = new LedgerStore(dbPath, defaultPriceBook);
    const groupFact: UsageFact = {
      ...fact,
      externalId: "2",
      model: "group/gpt-6.1-sol",
    };
    store1.savePage(
      "test",
      "incremental",
      { records: [fact, groupFact], nextCursor: "2", hasMore: false },
      "2026-11-23T00:01:00.000Z",
    );
    store1.close();

    // 模拟升级前同一版本键下已落盘的旧 missing-rate 估值，并清除迁移完成标记。
    const { Database } = await import("bun:sqlite");
    const rawDb = new Database(dbPath);
    const version = priceBookKey(defaultPriceBook);
    const staleMissing = JSON.stringify({
      version,
      usdBasis: "subscription",
      usd: {
        amount: null,
        basis: "unpriced",
        reason: "missing-rate",
        assumedStandard: false,
      },
      apiUsd: {
        amount: null,
        basis: "unpriced",
        reason: "missing-rate",
        assumedStandard: false,
      },
      subscriptionUsd: {
        amount: null,
        basis: "unpriced",
        reason: "missing-rate",
        assumedStandard: false,
      },
      credits: {
        amount: null,
        basis: "unpriced",
        reason: "missing-rate",
        assumedStandard: false,
      },
    });
    rawDb
      .query(
        "UPDATE valuations SET payload=? WHERE source_id='test' AND external_id IN ('1', '2') AND version=?",
      )
      .run(staleMissing, version);
    rawDb
      .query("DELETE FROM sync_state WHERE key=?")
      .run(`valuation:route-prefix-v1:${version}`);
    rawDb.close();

    const store2 = new LedgerStore(dbPath, defaultPriceBook);
    const rows = store2.usage();
    const expected = valueUsage(
      { ...fact, model: "gpt-6.1-sol" },
      defaultPriceBook,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.valuation.subscriptionUsd.amount).toBe(
        expected.subscriptionUsd.amount,
      );
      expect(row.valuation.apiUsd.amount).toBe(expected.apiUsd.amount);
      expect(row.valuation.pricingModel).toBe("gpt-6.1-sol");
    }
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
