import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPriceBook as book } from "../src/domain/default-prices";
import { valueUsage } from "../src/domain/pricing";
import type { UsageFact } from "../src/domain/connector";
import { LedgerStore } from "../src/storage/ledger";

function imageFact(): UsageFact {
  return {
    sourceId: "test",
    externalId: "image-1",
    accountExternalId: "account",
    occurredAt: "2026-09-08T12:00:00Z",
    model: "gpt-image-2",
    upstreamModel: null,
    tier: null,
    tokens: {
      input: 1000,
      cacheRead: 200,
      cacheWrite: 0,
      output: 150,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
      image: { input: 400, cacheRead: 100, output: 150 },
    },
    gatewayCost: "99",
    gatewayBilled: "42",
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
}

test("image and text sub-buckets are independently priced without double counting", () => {
  const fact = imageFact();
  const before = structuredClone(fact);
  const valued = valueUsage(fact, book);
  expect(valued.apiUsd.amount).toBe("0.010725");
  expect(valued.subscriptionUsd.amount).toBe("0.010725");
  expect(valued.credits.amount).toBe("0.268125");
  expect(fact).toEqual(before);
});

test("aggregate cache pricing preserves cached-only image requests without inventing a split", () => {
  const fact = imageFact();
  fact.tokens.input = 0;
  fact.tokens.image = {
    input: 400,
    output: 150,
    cacheRead: null,
    cacheReadMode: "aggregate",
  };
  const before = structuredClone(fact);
  const valued = valueUsage(fact, book);
  expect(valued.apiUsd.amount).toBe("0.00475");
  expect(valued.subscriptionUsd.amount).toBe("0.00475");
  expect(valued.credits.amount).toBe("0.11875");
  expect(fact).toEqual(before);
});

test("aggregate cache pricing does not replace missing or invalid usage with zero", () => {
  for (const input of [null, -1, 0.5]) {
    const fact = imageFact();
    fact.tokens.image = {
      input,
      output: 150,
      cacheRead: null,
      cacheReadMode: "aggregate",
    };
    expect(valueUsage(fact, book).usd.reason).toBe(
      "missing-or-invalid-image-token-bucket",
    );
  }
  const fact = imageFact();
  fact.tokens.cacheRead = null;
  fact.tokens.image = {
    input: 400,
    output: 150,
    cacheRead: null,
    cacheReadMode: "aggregate",
  };
  expect(valueUsage(fact, book).usd.reason).toBe(
    "missing-or-invalid-token-bucket",
  );
});

test("Image 2.5 variants and snapshots share Image 2 rates without adding generic aliases", () => {
  for (const model of [
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-sunburst-2026-09-08",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-flare-2026-09-08",
  ]) {
    const result = valueUsage({ ...imageFact(), model }, book);
    expect(result.apiUsd.amount).toBe("0.010725");
    expect(result.subscriptionUsd.amount).toBe("0.010725");
    expect(result.credits.amount).toBe("0.268125");
    const textOutput = imageFact();
    textOutput.model = model;
    textOutput.tokens.output! += 1;
    expect(valueUsage(textOutput, book).usd.amount).toBe("0.010725");
  }
  expect(
    valueUsage({ ...imageFact(), model: "gpt-image-2-2026-04-21" }, book)
      .credits.amount,
  ).toBe("0.268125");
  expect(
    valueUsage({ ...imageFact(), model: "gpt-image-2.5" }, book).usd.amount,
  ).toBeNull();
  expect(
    valueUsage({ ...imageFact(), tier: "fast" }, book).usd.amount,
  ).toBeNull();
});

test("image price completeness is checked against modality evidence, not gateway charges", () => {
  const fact = imageFact();
  delete fact.tokens.image;
  expect(valueUsage(fact, book).usd.reason).toBe(
    "missing-or-invalid-image-token-bucket",
  );
  fact.tokens.image = { input: 400, output: 150, cacheRead: null };
  expect(valueUsage(fact, book).usd.reason).toBe("missing-image-cache-split");
  fact.tokens.cacheRead = 0;
  expect(valueUsage(fact, book).usd.amount).toBe("0.0107");
  fact.tokens.image.input = 0;
  fact.tokens.cacheRead = 200;
  expect(valueUsage(fact, book).usd.amount).toBe("0.00975");
  for (const image of [
    { input: 1500, output: 150, cacheRead: 0 },
    { input: 10, output: 150, cacheRead: 20 },
    { input: 400, output: 151, cacheRead: 100 },
    { input: -1, output: 150, cacheRead: 0 },
    { input: 1.5, output: 150, cacheRead: 0 },
  ])
    expect(
      valueUsage({ ...fact, tokens: { ...fact.tokens, image } }, book).usd
        .amount,
    ).toBeNull();
});

test("unpublished image text-output and cache-write rates are not treated as free", () => {
  const fact = imageFact();
  fact.tokens.output! += 1;
  expect(valueUsage(fact, book).usd.reason).toBe("unsupported-rate-bucket");
  expect(valueUsage(fact, book).credits.amount).toBe("0.268375");
  fact.tokens.cacheWrite = 1;
  expect(valueUsage(fact, book).credits.reason).toBe("unsupported-rate-bucket");
});

test("GPT-5.6 Credits retain the published token prices beyond 272K", () => {
  for (const [model, expected] of [
    ["gpt-5.6-luna", "1.5305"],
    ["gpt-5.6-terra", "15.305"],
    ["gpt-5.6-sol", "30.51"],
  ]) {
    const fact = imageFact();
    fact.model = model!;
    fact.tokens = {
      ...fact.tokens,
      input: 300000,
      cacheRead: 1000,
      output: 1000,
    };
    delete fact.tokens.image;
    const value = valueUsage(fact, book);
    expect(value.credits.amount).toBe(expected!);
    expect(value.apiUsd.amount).not.toBe(value.subscriptionUsd.amount);
    expect(valueUsage(fact, book, "api").credits).toEqual(value.credits);
  }
});

test("price revision revalues legacy image facts without replacing facts or sync state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-image-prices-"));
  const path = join(dir, "ledger.sqlite");
  const prior = {
    ...book,
    version: "before-images",
    rules: book.rules.filter((rule) => !rule.model.startsWith("gpt-image-")),
  };
  let store = new LedgerStore(path, prior);
  const fact = imageFact();
  fact.tokens = { ...fact.tokens, input: 15, output: 229, cacheRead: 0 };
  delete fact.tokens.image;
  fact.metadata = { image_input_tokens: 0, image_output_tokens: 229 };
  const normalizedFact = imageFact();
  normalizedFact.externalId = "image-2";
  normalizedFact.tokens.image = { input: 400, output: 150, cacheRead: null };
  normalizedFact.metadata = {
    image_input_tokens: 400,
    image_output_tokens: 150,
  };
  try {
    store.savePage(
      "test",
      "incremental",
      { records: [fact, normalizedFact], nextCursor: "1", hasMore: false },
      fact.occurredAt,
    );
    store.setState("test:auto", true);
    expect(store.usage()[0]!.valuation.usd.amount).toBeNull();
    store.close();
    store = new LedgerStore(path, book);
    const revised = store.usage();
    expect(revised).toHaveLength(2);
    for (const [expected, usd, credits] of [
      [fact, "0.006945", "0.173625"],
      [normalizedFact, "0.01095", "0.27375"],
    ] as const) {
      const row = revised.find(
        (item) => item.fact.externalId === expected.externalId,
      )!;
      expect(row.fact).toEqual(expected);
      expect(row.valuation.usd.amount).toBe(usd);
      expect(row.valuation.credits.amount).toBe(credits);
      const stored = store.db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM usage_facts WHERE external_id=?",
        )
        .get(expected.externalId);
      expect(JSON.parse(stored!.payload)).toEqual(expected);
    }
    expect(store.getState<boolean>("test:auto")).toBe(true);
    expect(store.getState<string>("test:incremental:cursor")).toBe("1");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
