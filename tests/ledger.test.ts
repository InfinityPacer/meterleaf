import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SourceAccount,
  UsageConnector,
  UsageFact,
  QuotaFact,
} from "../src/domain/connector";
import { valueUsage, type PriceBook } from "../src/domain/pricing";
import { quotaView } from "../src/domain/quota";
import { LedgerStore } from "../src/storage/ledger";
import { SyncRunner } from "../src/server/sync";

const book: PriceBook = {
  schemaVersion: 1,
  id: "test",
  unit: "per_million_tokens",
  version: "test-v1",
  publishedAt: "2026-01-01T00:00:00Z",
  sources: ["test fixture, not real prices"],
  rules: ["api", "subscription", "credits"].map((basis) => ({
    model: "test-model",
    tier: "standard",
    currency: basis === "credits" ? "credits" : "usd",
    ...(basis !== "credits"
      ? { usdBasis: basis as "api" | "subscription" }
      : {}),
    effectiveFrom: "2000-01-01T00:00:00Z",
    rates: { input: "10", cacheRead: "1", cacheWrite: "12.5", output: "50" },
    longContext: {
      threshold: 272000,
      rates: { input: "20", cacheRead: "2", cacheWrite: "25", output: "75" },
    },
  })),
};
test("account archive and hide persist independently of source snapshots and usage", () => {
  const store = new LedgerStore(":memory:", book);
  try {
    store.savePage("test", "incremental", { records: [fact()], nextCursor: "1", hasMore: false }, "2026-09-09T00:00:00Z");
    store.setAccountArchived("test:a", true);
    store.hideAccount("test:a");
    store.saveAccountsSnapshot("test", []);
    expect(store.archivedAccounts()).toEqual(["test:a"]);
    expect(store.hiddenAccounts()).toEqual(["test:a"]);
    expect(store.countUsage("test")).toBe(1);
    store.setAccountArchived("test:a", false);
    expect(store.archivedAccounts()).toEqual([]);
    expect(store.hiddenAccounts()).toEqual(["test:a"]);
    expect(store.countUsage("test")).toBe(1);
  } finally { store.close(); }
});

function fact(id = "1"): UsageFact {
  return {
    sourceId: "test",
    externalId: id,
    accountExternalId: "a",
    occurredAt: "2026-09-08T01:00:00.000Z",
    model: "test-model",
    upstreamModel: null,
    tier: null,
    tokens: {
      input: 50,
      cacheRead: 20,
      cacheWrite: 30,
      output: 7,
      cacheWrite5m: 30,
      cacheWrite1h: 0,
      reasoning: 4,
    },
    gatewayCost: "999",
    gatewayBilled: "500",
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
}
function account(
  sourceId: string,
  externalId: string,
  parentExternalId: string | null = null,
): SourceAccount {
  return {
    sourceId,
    externalId,
    name: externalId,
    platform: "test",
    kind: "subscription",
    plan: "pro",
    parentExternalId,
    subjectKey: null,
  };
}

test("pricing sums exclusive buckets, never gateway cost or reasoning twice", () => {
  expect(valueUsage(fact(), book).usd).toEqual({
    amount: "0.001245",
    basis: "estimated",
    reason: "tier-not-declared",
    assumedStandard: true,
  });
  expect(
    valueUsage({ ...fact(), model: "unknown" }, book).usd.amount,
  ).toBeNull();
  expect(
    valueUsage({ ...fact(), tier: "priority" }, book).usd.amount,
  ).toBeNull();
  expect(
    valueUsage({ ...fact(), tokens: { ...fact().tokens, input: null } }, book)
      .usd.amount,
  ).toBeNull();
  expect(
    valueUsage({ ...fact(), upstreamCredits: "0.125" }, book).credits.basis,
  ).toBe("upstream");
});
test("long context applies strictly above total input threshold including cache", () => {
  const row = fact();
  row.tokens = {
    ...row.tokens,
    input: 1000,
    cacheRead: 271000,
    cacheWrite: 0,
    output: 0,
  };
  expect(valueUsage(row, book).usd.amount).toBe("0.281");
  row.tokens.cacheRead!++;
  expect(valueUsage(row, book).usd.amount).toBe("0.562002");
});
test("SQLite persists independent facts, versions, idempotent replay and atomic cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-test-"));
  const path = join(dir, "ledger.sqlite");
  let store = new LedgerStore(path, book);
  try {
    const page = { records: [fact()], nextCursor: "1", hasMore: false };
    store.savePage("test", "incremental", page, "2026-09-08T02:00:00Z");
    store.savePage("test", "incremental", page, "2026-09-08T02:01:00Z");
    expect(store.usage()).toHaveLength(1);
    expect(() =>
      store.savePage(
        "test",
        "incremental",
        {
          records: [fact("2"), { ...fact("3"), sourceId: "other" }],
          nextCursor: "3",
          hasMore: false,
        },
        "2026-09-08T02:02:00Z",
      ),
    ).toThrow();
    expect(store.usage()).toHaveLength(1);
    expect(store.getState<string>("test:incremental:cursor")).toBe("1");
    store.close();
    store = new LedgerStore(path, book);
    expect(store.usage()[0]!.valuation.usd.amount).toBe("0.001245");
    expect(
      () => new LedgerStore(path, { ...book, sources: ["changed"] }),
    ).toThrow("new version");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("full account snapshots reconcile one source, including empty snapshots, without deleting history", () => {
  const store = new LedgerStore(":memory:", book);
  try {
    store.saveAccounts([
      account("source-a", "keep"),
      account("source-a", "remove"),
      account("source-b", "same-id"),
    ]);
    store.savePage(
      "source-a",
      "incremental",
      {
        records: [
          {
            ...fact("historical"),
            sourceId: "source-a",
            accountExternalId: "remove",
          },
        ],
        nextCursor: "historical",
        hasMore: false,
      },
      "2026-09-08T02:00:00Z",
    );

    store.saveAccountsSnapshot("source-a", [account("source-a", "keep")]);
    const revision = store.revision();
    store.saveAccountsSnapshot("source-a", [account("source-a", "keep")]);
    expect(store.revision()).toBe(revision);
    expect(
      store.accounts().map((row) => `${row.sourceId}:${row.externalId}`),
    ).toEqual(["source-a:keep", "source-b:same-id"]);
    expect(store.usage()).toHaveLength(1);

    store.saveAccountsSnapshot("source-a", []);
    expect(store.accounts()).toEqual([account("source-b", "same-id")]);
    expect(store.usage()).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("account snapshot validation is source-scoped and leaves existing rows unchanged", () => {
  const store = new LedgerStore(":memory:", book);
  try {
    store.saveAccounts([
      account("source-a", "keep"),
      account("source-b", "other"),
    ]);
    expect(() =>
      store.saveAccountsSnapshot("source-a", [
        account("source-a", "new"),
        account("source-b", "foreign"),
      ]),
    ).toThrow("foreign source account");
    expect(store.accounts()).toEqual([
      account("source-a", "keep"),
      account("source-b", "other"),
    ]);
  } finally {
    store.close();
  }
});

test("account snapshot rolls back upserts and revision when removal fails", () => {
  const store = new LedgerStore(":memory:", book);
  try {
    store.saveAccounts([account("source-a", "old")]);
    const revision = store.revision();
    store.db
      .exec(`CREATE TRIGGER reject_account_delete BEFORE DELETE ON accounts
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    expect(() =>
      store.saveAccountsSnapshot("source-a", [account("source-a", "new")]),
    ).toThrow();
    expect(store.accounts()).toEqual([account("source-a", "old")]);
    expect(store.revision()).toBe(revision);
    store.db.exec("DROP TRIGGER reject_account_delete");
    store.saveAccountsSnapshot("source-a", [account("source-a", "new")]);
    expect(store.accounts()).toEqual([account("source-a", "new")]);
  } finally {
    store.close();
  }
});

test("sync does not reconcile accounts after a source failure, then applies the next full snapshot", async () => {
  const store = new LedgerStore(":memory:", book);
  let accounts = [
    account("sync-source", "keep"),
    account("sync-source", "remove"),
  ];
  let failed = false;
  const connector: UsageConnector = {
    sourceId: "sync-source",
    readAccounts: async () => {
      if (failed) throw new Error("source unavailable");
      return accounts;
    },
    readUsage: async (cursor) => ({
      records: [],
      nextCursor: cursor,
      hasMore: false,
    }),
    close: async () => {},
  };
  const sync = new SyncRunner(connector, store, {
    quotaIntervalMs: 30_000,
    sweepMs: Number.MAX_SAFE_INTEGER,
    pagesPerPoll: 1,
  });
  try {
    await sync.poll("2026-09-08T02:00:00Z");
    expect(store.accounts()).toEqual(accounts);

    failed = true;
    await sync.poll("2026-09-08T02:00:31Z");
    expect(sync.status().error).toBe("source-sync-failed");
    expect(store.accounts()).toEqual(accounts);

    failed = false;
    accounts = [account("sync-source", "keep")];
    await sync.poll("2026-09-08T02:01:02Z");
    expect(sync.status().error).toBeNull();
    expect(store.accounts()).toEqual(accounts);
  } finally {
    await sync.stop();
    store.close();
  }
});

test("report change log preserves identity when a fact is deleted", () => {
  const store = new LedgerStore(":memory:", book);
  try {
    const row = fact();
    store.savePage(
      "test",
      "incremental",
      { records: [row], nextCursor: "1", hasMore: false },
      "2026-09-08T02:00:00Z",
    );
    const afterInsert = store.reportUsageChanges(0).lastSequence;
    store.db.query("DELETE FROM valuations").run();
    store.db
      .query("DELETE FROM usage_facts WHERE source_id=? AND external_id=?")
      .run("test", row.externalId);

    const deleted = store.reportUsageChanges(afterInsert);
    expect(deleted.changes).toHaveLength(1);
    expect(deleted.changes[0]).toMatchObject({
      sourceId: "test",
      externalId: row.externalId,
      metric: null,
    });
    expect(store.storedUsageChanges(afterInsert).changes).toEqual([
      { sourceId: "test", externalId: row.externalId, usage: null },
    ]);
  } finally {
    store.close();
  }
});

test("report projection reads stream facts and coalesce updates with current valuation", () => {
  const store = new LedgerStore(":memory:", book);
  try {
    const save = (row: UsageFact) =>
      store.savePage(
        "test",
        "incremental",
        {
          records: [row],
          nextCursor: row.externalId,
          hasMore: false,
        },
        "2026-09-08T02:00:00Z",
      );
    save(fact());
    const sequence = store.reportUsageChangeState().lastSequence;
    save({ ...fact(), tokens: { ...fact().tokens, input: 123 } });
    save({ ...fact(), tokens: { ...fact().tokens, input: 456 } });
    save(fact("2"));
    const changes = store.db.transaction(() =>
      store.storedUsageChanges(sequence),
    )();
    expect(changes.tracked).toBe(true);
    expect(changes.changes).toHaveLength(2);
    const streamed = [...store.reportUsages()];
    expect(streamed).toHaveLength(2);
    expect(
      changes.changes.find((row) => row.externalId === "1")?.usage,
    ).toEqual(streamed[0]);
    expect(streamed[0]!.fact.tokens.input).toBe(456);
    expect(streamed[0]!.valuation).toEqual(valueUsage(streamed[0]!.fact, book));
    expect(store.storedUsageChanges(changes.lastSequence).changes).toEqual([]);
  } finally {
    store.close();
  }
});

test("report change log tracks valuation-only mutations and decimal exponents", () => {
  const store = new LedgerStore(":memory:", book);
  try {
    const row = fact("valuation-only");
    store.savePage(
      "test",
      "incremental",
      { records: [row], nextCursor: "1", hasMore: false },
      "2026-09-08T02:00:00Z",
    );
    let sequence = store.reportUsageChangeState().lastSequence;
    expect(store.reportUsageChangeState().tracked).toBe(true);

    store.db
      .query("DELETE FROM valuations WHERE source_id=? AND external_id=?")
      .run("test", row.externalId);
    const deleted = store.reportUsageChanges(sequence);
    expect(deleted.changes).toHaveLength(1);
    expect(deleted.changes[0]).toMatchObject({
      sourceId: "test",
      externalId: row.externalId,
    });
    sequence = deleted.lastSequence;

    const original = valueUsage(row, book);
    const scientific = {
      ...original,
      usd: { ...original.usd, amount: "1e-7" },
      subscriptionUsd: { ...original.subscriptionUsd, amount: "1e-7" },
    };
    store.db
      .query("INSERT INTO valuations VALUES (?, ?, ?, ?)")
      .run(
        "test",
        row.externalId,
        original.version,
        JSON.stringify(scientific),
      );
    const inserted = store.reportUsageChanges(sequence);
    expect(inserted.changes).toHaveLength(1);
    expect(inserted.changes[0]?.metric?.subscriptionUsd).toBe("1e-7");
    sequence = inserted.lastSequence;

    const updated = {
      ...scientific,
      usd: { ...scientific.usd, amount: "2.5E-8" },
      subscriptionUsd: { ...scientific.subscriptionUsd, amount: "2.5E-8" },
    };
    store.db
      .query(
        "UPDATE valuations SET payload=? WHERE source_id=? AND external_id=? AND version=?",
      )
      .run(JSON.stringify(updated), "test", row.externalId, original.version);
    const changed = store.reportUsageChanges(sequence);
    expect(changed.changes).toHaveLength(1);
    expect(changed.changes[0]?.metric?.subscriptionUsd).toBe("2.5e-8");
  } finally {
    store.close();
  }
});

test("incremental and full sweep recover late lower IDs; failures retain cursor", async () => {
  const store = new LedgerStore(":memory:", book);
  let rows = [fact("2")];
  let fail = false;
  const connector: UsageConnector = {
    sourceId: "test",
    readAccounts: async () => [],
    close: async () => {},
    readUsage: async (cursor) => {
      if (fail) throw new Error("private connection details");
      const records = rows.filter(
        (row) => BigInt(row.externalId) > BigInt(cursor ?? "0"),
      );
      return {
        records,
        nextCursor: records.at(-1)?.externalId ?? cursor,
        hasMore: false,
      };
    },
  };
  const sync = new SyncRunner(connector, store, {
    intervalMs: 30_000,
    sweepMs: 1000,
    pageSize: 10,
    pagesPerPoll: 1,
  });
  try {
    await sync.poll("2026-09-08T02:00:00Z");
    rows = [fact("1"), fact("2")];
    await sync.poll("2026-09-08T02:00:02Z");
    expect(store.usage()).toHaveLength(2);
    fail = true;
    await sync.poll("2026-09-08T02:00:03Z");
    expect(sync.status().error).toBe("source-sync-failed");
    expect(store.getState<string>("test:incremental:cursor")).toBe("2");
  } finally {
    await sync.stop();
    store.close();
  }
});
function quota(
  percent: number,
  sampledAt: string,
  resetsAt = "2026-09-14T00:00:00Z",
) {
  const fact: QuotaFact = {
    sourceId: "test",
    externalId: `${sampledAt}:7d`,
    accountExternalId: "a",
    window: "seven-day",
    percent,
    sampledAt,
    resetsAt,
    windowMinutes: 10080,
  };
  return { fact, collectedAt: sampledAt };
}
test("expired snapshots never carry old percent or spend into new window", () => {
  const row = fact();
  const usage = [{ fact: row, valuation: valueUsage(row, book) }];
  const view = quotaView(
    [quota(80, "2026-09-08T00:00:00Z", "2026-09-08T01:00:00Z")],
    usage,
    "2026-09-08T02:00:00Z",
  )!;
  expect(view.percent).toBe(0);
  expect(view.periodUsd).toBeNull();
  expect(view.estimate.reason).toBe("expired");
});
test("seven day estimate uses one sample without a minimum percentage or delta", () => {
  const row = fact();
  const usage = [{ fact: row, valuation: valueUsage(row, book) }];
  const history = [
    quota(20, "2026-09-08T00:00:00Z"),
    quota(25, "2026-09-08T02:00:00Z"),
  ];
  const view = quotaView(history, usage, "2026-09-08T02:01:00Z")!;
  expect(view.estimate.usd).toBe("0.00498");
  expect(
    quotaView([history[1]!], usage, "2026-09-08T02:01:00Z")!.estimate.usd,
  ).toBe(view.estimate.usd);
  expect(
    quotaView(
      [...history, quota(1, "2026-09-08T02:02:00Z")],
      usage,
      "2026-09-08T02:03:00Z",
    )!.estimate.usd,
  ).toBe("0.1245");
  expect(
    quotaView(
      [...history, quota(30, "2026-09-08T02:02:00Z", "2026-09-15T02:00:00Z")],
      usage,
      "2026-09-08T02:03:00Z",
    )!.estimate.usd,
  ).toBeNull();
});

test("estimate excludes post-sample spend and does not divide by zero", () => {
  const row = fact();
  const usage = [{ fact: row, valuation: valueUsage(row, book) }];
  expect(
    quotaView(
      [quota(19, "2026-09-08T00:00:00Z")],
      usage,
      "2026-09-08T02:01:00Z",
    )!.estimate.usd,
  ).toBeNull();
  expect(
    quotaView(
      [quota(0, "2026-09-08T02:00:00Z")],
      usage,
      "2026-09-08T02:01:00Z",
    )!.estimate.reason,
  ).toBe("percent-unavailable");
});
