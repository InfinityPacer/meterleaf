import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp } from "../src/server/app";
import { readConfig } from "../src/server/config";
import { defaultPriceBook } from "../src/domain/default-prices";
import { valueUsage } from "../src/domain/pricing";
import type { UsageFact } from "../src/domain/connector";
import { LedgerStore } from "../src/storage/ledger";
import {
  INGEST_BATCHES_PATH,
  type IngestBatch,
  type IngestUsage,
} from "../src/shared/ingest";

const key = "mlk_test-key-for-ingest-only";
const digest = createHash("sha256").update(key).digest("hex");
const otherKey = "mlk_other-device-key";
const otherDigest = createHash("sha256").update(otherKey).digest("hex");

function usage(overrides: Partial<IngestUsage> = {}): IngestUsage {
  return {
    externalId: "req_1:msg_1",
    occurredAt: "2026-09-24T10:00:00.000Z",
    accountExternalId: "acct-1",
    model: "claude-opus-5-5",
    tier: "standard",
    tokens: {
      input: 2,
      output: 100,
      cacheRead: 1_000_000,
      cacheWrite: 300_000,
      cacheWrite5m: 100_000,
      cacheWrite1h: 200_000,
      reasoning: 40,
    },
    metadata: { is_sidechain: false },
    ...overrides,
  };
}

function batch(overrides: Partial<IngestBatch> = {}): IngestBatch {
  return {
    schemaVersion: 1,
    sourceId: "claude-code-mac",
    batchId: crypto.randomUUID(),
    collector: { name: "meterleaf-collector", version: "0.0.0-test" },
    accounts: [
      {
        externalId: "acct-1",
        name: "Claude Max 5x",
        platform: "anthropic",
        kind: "subscription",
        plan: "max-5x",
        subjectKey: null,
      },
    ],
    usage: [usage()],
    quotas: [
      {
        accountExternalId: "acct-1",
        window: "five-hour",
        percent: 9,
        sampledAt: "2026-09-24T16:10:17.109Z",
        resetsAt: "2026-09-24T19:20:00.030Z",
        windowMinutes: 300,
      },
    ],
    ...overrides,
  };
}

function setup() {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const app = createApp({
    snapshot: () => {
      throw new Error("not used");
    },
    ingest: {
      keys: [
        { sourceId: "claude-code-mac", sha256: digest },
        { sourceId: "claude-code-mini", sha256: otherDigest },
      ],
      save: (sourceId, value) =>
        store.saveIngestBatch(sourceId, value, "2026-09-24T16:11:00.000Z"),
    },
  });
  const post = (payload: unknown, token: string | null = key) =>
    app.inject({
      method: "POST",
      url: INGEST_BATCHES_PATH,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: payload as object,
    });
  return { store, app, post };
}

test("ingest keys are digests bound to one source and cannot reuse the pull source", () => {
  const base = { SUB2API_DATABASE_URL: "postgresql://ro@db/sub2api" };
  expect(
    readConfig({
      ...base,
      METERLEAF_INGEST_KEYS: `claude-code-mac:${digest}`,
    }).ingestKeys,
  ).toEqual([{ sourceId: "claude-code-mac", sha256: digest }]);
  expect(readConfig(base).ingestKeys).toEqual([]);
  expect(() =>
    readConfig({ ...base, METERLEAF_INGEST_KEYS: `claude-code-mac:${key}` }),
  ).toThrow("METERLEAF_INGEST_KEYS");
  expect(() =>
    readConfig({ ...base, METERLEAF_INGEST_KEYS: `sub2api:${digest}` }),
  ).toThrow("METERLEAF_SOURCE_ID");
  expect(() =>
    readConfig({
      ...base,
      METERLEAF_INGEST_KEYS: `a:${digest},a:${otherDigest}`,
    }),
  ).toThrow("duplicate");
});

test("ingest rejects missing keys, foreign sources and invalid batches without writing", async () => {
  const { store, post } = setup();
  expect((await post(batch(), null)).statusCode).toBe(401);
  expect((await post(batch(), "mlk_wrong")).statusCode).toBe(401);
  expect((await post(batch(), otherKey)).statusCode).toBe(403);
  const invalid = await post(
    batch({ usage: [usage({ tokens: { ...usage().tokens, input: -1 } })] }),
  );
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().fields).toContain("usage.0.tokens.input");
  const leaked = await post({
    ...batch(),
    usage: [{ ...usage(), cwd: "/Users/someone/project" }],
  });
  expect(leaked.statusCode).toBe(400);
  expect(store.usage()).toHaveLength(0);
  expect(store.accounts()).toHaveLength(0);
});

test("ingest is idempotent and a more complete observation replaces the earlier one", async () => {
  const { store, post } = setup();
  const first = await post(batch());
  expect(first.statusCode).toBe(200);
  expect(first.json().accepted).toEqual({ usage: 1, accounts: 1, quotas: 1 });
  const revision = store.revision();
  expect((await post(batch())).statusCode).toBe(200);
  expect(store.revision()).toBe(revision);
  expect(store.usage()).toHaveLength(1);
  expect(store.quotas()).toHaveLength(1);

  const completed = usage({
    tokens: { ...usage().tokens, output: 900, reasoning: 300 },
  });
  expect((await post(batch({ usage: [completed] }))).statusCode).toBe(200);
  const [row] = store.usage();
  expect(row!.fact).toMatchObject({
    sourceId: "claude-code-mac",
    externalId: "req_1:msg_1",
    gatewayCost: null,
    upstreamUsd: null,
  });
  expect(row!.fact.tokens.output).toBe(900);
  expect(store.revision()).toBeGreaterThan(revision);
  expect(store.accounts()[0]).toMatchObject({
    sourceId: "claude-code-mac",
    kind: "subscription",
    parentExternalId: null,
  });
  expect(store.getState("claude-code-mac:ingest:last")).toMatchObject({
    collector: { name: "meterleaf-collector" },
  });
});

test("account updates from a push source never delete other accounts", async () => {
  const { store, post } = setup();
  await post(batch());
  await post(
    batch({
      accounts: [
        {
          externalId: "unattributed",
          name: "未归属",
          platform: "anthropic",
          kind: "unknown",
          plan: null,
          subjectKey: null,
        },
      ],
      usage: [],
      quotas: [],
    }),
  );
  expect(
    store
      .accounts()
      .map((account) => account.externalId)
      .sort(),
  ).toEqual(["acct-1", "unattributed"]);
});

function fact(tokens: Partial<UsageFact["tokens"]>, tier = "standard") {
  return {
    sourceId: "claude-code-mac",
    externalId: "x",
    occurredAt: "2026-09-25T00:00:00Z",
    accountExternalId: "acct-1",
    model: "claude-opus-5-5",
    upstreamModel: null,
    tier,
    tokens: {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 3_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 2_000_000,
      reasoning: null,
      ...tokens,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  } satisfies UsageFact;
}

test("Claude valuation prices 1-hour cache writes separately and never guesses a missing TTL split", () => {
  // Opus 5.5 官方价：输入 4、5 分钟写入 5、1 小时写入 8、缓存读取 0.2（0.05x）、输出 20。
  const standard = valueUsage(fact({}), defaultPriceBook, "api");
  expect(standard.apiUsd.amount).toBe(String(4 + 0.2 + 5 + 2 * 8 + 20));
  expect(standard.subscriptionUsd.amount).toBe(standard.apiUsd.amount);

  // 快速模式对应 priority 档，缓存倍率叠加在快速模式基础价上。
  const fast = valueUsage(fact({}, "fast"), defaultPriceBook, "api");
  expect(fast.apiUsd.amount).toBe(String(8 + 0.4 + 10 + 2 * 16 + 40));

  const unknownSplit = valueUsage(
    fact({ cacheWrite1h: null }),
    defaultPriceBook,
    "api",
  );
  expect(unknownSplit.apiUsd).toMatchObject({
    amount: null,
    reason: "missing-cache-ttl-split",
  });
  expect(
    valueUsage(fact({ cacheWrite1h: 4_000_000 }), defaultPriceBook, "api")
      .apiUsd.reason,
  ).toBe("invalid-cache-ttl-subset");
  // 没有缓存写入时不需要 TTL 拆分。
  expect(
    valueUsage(
      fact({ cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null }),
      defaultPriceBook,
      "api",
    ).apiUsd.amount,
  ).toBe(String(4 + 0.2 + 20));
});

test("Opus 4.8 uses its own standard and fast-mode rates", () => {
  // Opus 4.8 官方价与 Opus 5 相同：标准档 5 / 6.25 / 10 / 0.5 / 25，快速模式 10 / 50 再叠加缓存倍率。
  const opus48 = { ...fact({}), model: "claude-opus-4-8" };
  expect(valueUsage(opus48, defaultPriceBook, "api").apiUsd.amount).toBe(
    String(5 + 0.5 + 6.25 + 2 * 10 + 25),
  );
  const fast = { ...fact({}, "fast"), model: "claude-opus-4-8" };
  expect(valueUsage(fast, defaultPriceBook, "api").apiUsd.amount).toBe(
    String(10 + 1 + 12.5 + 2 * 20 + 50),
  );
});

test("models without a 1-hour rate stay unpriced instead of using the 5-minute price", () => {
  const openai = {
    ...fact({ cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: 5 }),
    model: "gpt-5.4",
  };
  expect(valueUsage(openai, defaultPriceBook, "api").apiUsd.reason).toBe(
    "unsupported-rate-bucket",
  );
  const unknownModel = { ...fact({}), model: "claude-opus-4-7" };
  expect(valueUsage(unknownModel, defaultPriceBook, "api").apiUsd.reason).toBe(
    "missing-rate",
  );
});
