import { expect, test } from "bun:test";
import type { TokenUsage, UsageFact } from "../src/domain/connector";
import {
  normalizeSub2ApiImageUsage,
  withSub2ApiImageUsage,
} from "../src/connectors/sub2api-usage";
import { defaultPriceBook } from "../src/domain/default-prices";
import { LedgerStore } from "../src/storage/ledger";

function tokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: null,
    ...overrides,
  };
}

function legacyFact(
  metadata: UsageFact["metadata"] = {
    image_input_tokens: 100,
    image_output_tokens: 4,
  },
): UsageFact {
  return {
    sourceId: "sub2api",
    externalId: "1",
    accountExternalId: "account",
    occurredAt: "2026-09-01T00:00:00.000Z",
    model: "unknown-model",
    upstreamModel: null,
    tier: null,
    tokens: tokens(),
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata,
  };
}

function imageFact(
  externalId: string,
  metadata: UsageFact["metadata"],
): UsageFact {
  return {
    ...legacyFact(metadata),
    externalId,
    model: "gpt-image-2",
    tokens: tokens({ input: 1000, output: 150, cacheRead: 200 }),
  };
}

test("normalizes image metadata to aggregate cache mode without guessing a split", () => {
  expect(
    normalizeSub2ApiImageUsage({
      image_input_tokens: "not-a-number",
      image_output_tokens: 4,
    }),
  ).toEqual({
    input: null,
    output: 4,
    cacheRead: null,
    cacheReadMode: "aggregate",
  });
  expect(normalizeSub2ApiImageUsage({ image_input_tokens: 100 })).toEqual({
    input: 100,
    output: null,
    cacheRead: null,
    cacheReadMode: "aggregate",
  });
  expect(normalizeSub2ApiImageUsage({ image_input_tokens: 0 })).toEqual({
    input: 0,
    output: null,
    cacheRead: null,
    cacheReadMode: "aggregate",
  });
  expect(
    normalizeSub2ApiImageUsage({
      image_input_tokens: Number.MAX_SAFE_INTEGER + 1,
      image_output_tokens: 1,
    }),
  ).toEqual({
    input: null,
    output: 1,
    cacheRead: null,
    cacheReadMode: "aggregate",
  });
});

test("supplements a legacy fact without mutating its stored shape", () => {
  const fact = legacyFact();
  const original = structuredClone(fact);

  const normalized = withSub2ApiImageUsage(fact);

  expect(fact).toEqual(original);
  expect(fact.tokens.image).toBeUndefined();
  expect(normalized).not.toBe(fact);
  expect(normalized.tokens.image).toEqual({
    input: 100,
    output: 4,
    cacheRead: null,
    cacheReadMode: "aggregate",
  });
});

test("requires explicit legacy image metadata and keeps an existing image unchanged", () => {
  const missing = legacyFact({});
  expect(withSub2ApiImageUsage(missing)).toBe(missing);

  const existing = legacyFact({
    image_input_tokens: 2,
    image_output_tokens: 1,
  });
  existing.tokens.image = { input: 1, output: 1, cacheRead: 0 };
  expect(withSub2ApiImageUsage(existing)).toBe(existing);
  expect(existing.tokens.image).toEqual({ input: 1, output: 1, cacheRead: 0 });
});

test("accepts a source-optional usage-shaped object", () => {
  const usage = {
    tokens: tokens({ cacheRead: 0 }),
    metadata: { image_input_tokens: 8, image_output_tokens: 2 },
  };

  expect(withSub2ApiImageUsage(usage).tokens.image).toEqual({
    input: 8,
    output: 2,
    cacheRead: null,
    cacheReadMode: "aggregate",
  });
});

test("values aggregate Sub2API image cache without fabricating an image cache split", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const facts = [
    imageFact("priced", { image_input_tokens: 400, image_output_tokens: 150 }),
    imageFact("oversized", {
      image_input_tokens: 1500,
      image_output_tokens: 150,
    }),
    imageFact("missing", {}),
    imageFact("invalid", {
      image_input_tokens: "not-a-number",
      image_output_tokens: 150,
    }),
  ];
  const originals = structuredClone(facts);

  try {
    store.savePage(
      "sub2api",
      "incremental",
      { records: facts, nextCursor: "invalid", hasMore: false },
      "2026-09-01T00:01:00.000Z",
    );

    const firstRead = store.usage();
    const priced = firstRead.find(
      (usage) => usage.fact.externalId === "priced",
    )!;
    const oversized = firstRead.find(
      (usage) => usage.fact.externalId === "oversized",
    )!;
    const missing = firstRead.find(
      (usage) => usage.fact.externalId === "missing",
    )!;
    const invalid = firstRead.find(
      (usage) => usage.fact.externalId === "invalid",
    )!;

    expect(priced.valuation.usd.amount).toBe("0.01095");
    expect(priced.valuation.credits.amount).toBe("0.27375");
    expect(oversized.valuation.usd.amount).toBe("0.01275");
    expect(oversized.valuation.credits.amount).toBe("0.31875");
    expect(missing.valuation.usd.amount).toBeNull();
    expect(missing.valuation.credits.amount).toBeNull();
    expect(invalid.valuation.usd.amount).toBeNull();
    expect(invalid.valuation.credits.amount).toBeNull();
    expect(withSub2ApiImageUsage(priced.fact).tokens.image).toEqual({
      input: 400,
      output: 150,
      cacheRead: null,
      cacheReadMode: "aggregate",
    });
    expect(withSub2ApiImageUsage(invalid.fact).tokens.image).toEqual({
      input: null,
      output: 150,
      cacheRead: null,
      cacheReadMode: "aggregate",
    });

    expect(firstRead.map((usage) => usage.fact)).toEqual(
      expect.arrayContaining(originals),
    );
    const stored = store.db
      .query<{ payload: string }, [string, string]>(
        "SELECT payload FROM usage_facts WHERE source_id=? AND external_id=?",
      )
      .get("sub2api", "priced");
    expect(JSON.parse(stored!.payload)).toEqual(originals[0]);

    const revision = store.revision();
    store.savePage(
      "sub2api",
      "incremental",
      { records: facts, nextCursor: "invalid", hasMore: false },
      "2026-09-01T00:02:00.000Z",
    );
    expect(store.revision()).toBe(revision);
    expect(store.usage()).toEqual(firstRead);
    expect(store.usage()).toEqual(store.usage());
  } finally {
    store.close();
  }
});

test("LedgerStore keeps the raw legacy fact when valuing it", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const fact = legacyFact();
  const original = structuredClone(fact);

  try {
    store.savePage(
      "sub2api",
      "incremental",
      { records: [fact], nextCursor: "1", hasMore: false },
      "2026-09-01T00:01:00.000Z",
    );

    expect(store.usage()[0]!.fact).toEqual(original);
    const row = store.db
      .query<{ payload: string }, [string, string]>(
        "SELECT payload FROM usage_facts WHERE source_id=? AND external_id=?",
      )
      .get("sub2api", "1");
    expect(row!.payload).toBe(JSON.stringify(original));
    expect(JSON.parse(row!.payload)).toEqual(original);
  } finally {
    store.close();
  }
});
