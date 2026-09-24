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
  expect(subscription.version).toBe("meterleaf@2026-09-25.1");
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
      expect(result.credits.amount).toBeNull();
    }
    const write = valueUsage(
      { ...usage, model, tokens: { ...usage.tokens, cacheWrite: 1 } },
      defaultPriceBook,
    );
    expect(write.usd.reason).toBe("unsupported-rate-bucket");
    expect(write.credits.amount).toBeNull();
  }
  for (const model of ["codex-auto-review", "gpt-reserve"]) {
    expect(
      valueUsage({ ...usage, model }, defaultPriceBook).usd.amount,
    ).toBeNull();
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
