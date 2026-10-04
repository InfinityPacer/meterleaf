import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  QuotaFact,
  SourceAccount,
  UsageFact,
} from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { LedgerStore } from "../src/storage/ledger";

const first = "2026-10-01T01:00:00.000Z";
const second = "2026-10-01T02:00:00.000Z";
const third = "2026-10-01T03:00:00.000Z";

function account(
  plan: string | null,
  sourceId = "source",
  externalId = "account",
): SourceAccount {
  return {
    sourceId,
    externalId,
    name: "fixture",
    platform: "anthropic",
    kind: "subscription",
    plan,
    parentExternalId: null,
    subjectKey: null,
  };
}

function quota(
  sampledAt = first,
  sourceId = "source",
  accountExternalId = "account",
): QuotaFact {
  return {
    sourceId,
    externalId: `quota-${sampledAt}`,
    accountExternalId,
    window: "five-hour",
    percent: 10,
    sampledAt,
    resetsAt: "2026-10-01T05:00:00.000Z",
    windowMinutes: 300,
  };
}

function ingest(
  store: LedgerStore,
  plan: string | null,
  sampledAt: string,
  now: string,
) {
  store.saveIngestBatch(
    "source",
    {
      batchId: `batch-${sampledAt}`,
      collector: { name: "fixture", version: "test" },
      accounts: [account(plan)],
      usage: [],
      quotas: [quota(sampledAt)],
    },
    now,
  );
}

function history(store: LedgerStore) {
  return store.quotas()[0]?.planHistory;
}

test("plan observations persist without changing quota payload or identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meterleaf-quota-plan-"));
  const path = join(directory, "ledger.db");
  let store = new LedgerStore(path, defaultPriceBook);
  try {
    store.saveQuotas([quota()], first);
    expect(history(store)).toBeUndefined();
    store.saveAccounts([account("pro")], first);
    store.saveAccountsSnapshot("source", [account("max-5x")], second);
    store.close();
    store = new LedgerStore(path, defaultPriceBook);
    expect(history(store)).toEqual([
      { plan: "pro", observedAt: first, changed: false },
      { plan: "max-5x", observedAt: second, changed: true },
    ]);
    expect(store.quotas()[0]?.fact).toEqual(quota());
    const stored = store.db
      .query<{ id: string; payload: string }, []>(
        "SELECT id, payload FROM quota_snapshots",
      )
      .get()!;
    expect(stored.payload).toBe(JSON.stringify(quota()));
    expect(stored.id).toBe(
      createHash("sha256").update(stored.payload).digest("hex"),
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("A to B to A and unknown plans retain boundaries while retries do not write", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    store.saveQuotas([quota()], first);
    store.saveAccounts([account("pro")], first);
    store.saveAccounts([account("max-5x")], second);
    store.saveAccounts([account("pro")], third);
    store.saveAccounts([account(null)], "2026-10-01T04:00:00.000Z");
    const totalChanges = store.db
      .query<{ total: number }, []>("SELECT total_changes() AS total")
      .get()!.total;
    const revision = store.revision();
    store.saveAccounts([account(null)], "2026-10-01T04:30:00.000Z");
    expect(
      store.db
        .query<{ total: number }, []>("SELECT total_changes() AS total")
        .get()!.total,
    ).toBe(totalChanges);
    expect(store.revision()).toBe(revision);
    expect(history(store)).toEqual([
      { plan: "pro", observedAt: first, changed: false },
      { plan: "max-5x", observedAt: second, changed: true },
      { plan: "pro", observedAt: third, changed: true },
      { plan: null, observedAt: "2026-10-01T04:00:00.000Z", changed: true },
    ]);
    store.saveAccounts([account("pro")], "2026-10-01T04:40:00.000Z");
    expect(history(store)?.at(-1)?.changed).toBe(true);
  } finally {
    store.close();
  }
});

test("first observation compares the existing account without backfilling its plan", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    store.db
      .query("INSERT INTO accounts VALUES (?, ?, ?)")
      .run("source", "account", JSON.stringify(account("pro")));
    store.saveQuotas([quota()], first);
    store.saveAccounts([account("max-5x")], second);
    expect(history(store)).toEqual([
      { plan: "max-5x", observedAt: second, changed: true },
    ]);
  } finally {
    store.close();
  }
});

test("replayed and late quota batches cannot revert the current account plan", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    ingest(store, "pro", first, first);
    ingest(store, "max-5x", second, second);
    const revision = store.revision();
    ingest(store, "pro", first, third);
    ingest(store, "pro", second, third);
    ingest(store, "pro", "2026-10-01T01:30:00.000Z", third);
    expect(store.accounts()[0]?.plan).toBe("max-5x");
    expect(history(store)).toEqual([
      { plan: "pro", observedAt: first, changed: false },
      { plan: "max-5x", observedAt: second, changed: true },
    ]);
    expect(store.revision()).toBe(revision + 1);
    ingest(store, "pro", third, third);
    expect(store.accounts()[0]?.plan).toBe("pro");
    expect(history(store)?.at(-1)).toEqual({
      plan: "pro",
      observedAt: third,
      changed: true,
    });
  } finally {
    store.close();
  }
});

test("future quota dates cannot block a legitimate subsequent plan update", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    ingest(store, "pro", "2099-01-01T00:00:00.000Z", first);
    ingest(store, "max-5x", second, second);
    expect(store.accounts()[0]?.plan).toBe("max-5x");
    expect(history(store)?.at(-1)?.changed).toBe(true);
  } finally {
    store.close();
  }
});

test("late quotas cannot revert an account-only plan change newer than the sample", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    ingest(store, "pro", first, first);
    store.saveIngestBatch(
      "source",
      {
        batchId: "account-only-upgrade",
        collector: { name: "fixture", version: "test" },
        accounts: [account("max-5x")],
        usage: [],
        quotas: [],
      },
      third,
    );
    store.saveIngestBatch(
      "source",
      {
        batchId: "late-quotas-with-usage",
        collector: { name: "fixture", version: "test" },
        accounts: [account("pro")],
        usage: [
          {
            sourceId: "source",
            externalId: "late-usage",
            occurredAt: second,
            accountExternalId: "account",
            model: "claude-opus-4-6",
            upstreamModel: null,
            tier: "standard",
            tokens: {
              input: 10,
              output: 10,
              cacheRead: null,
              cacheWrite: null,
              cacheWrite5m: null,
              cacheWrite1h: null,
              reasoning: null,
            },
            gatewayCost: null,
            gatewayBilled: null,
            upstreamUsd: null,
            upstreamCredits: null,
            metadata: {},
          },
        ],
        quotas: [quota(second)],
      },
      "2026-10-01T04:00:00.000Z",
    );
    expect(store.accounts()[0]?.plan).toBe("max-5x");
    expect(history(store)).toEqual([
      { plan: "pro", observedAt: first, changed: false },
      { plan: "max-5x", observedAt: third, changed: true },
    ]);
    expect(store.quotas().map((row) => row.fact.sampledAt)).toEqual([
      first,
      second,
    ]);
    expect(store.countUsage("source")).toBe(1);
    ingest(store, "pro", third, "2026-10-01T04:30:00.000Z");
    expect(store.accounts()[0]?.plan).toBe("max-5x");
    expect(history(store)).toHaveLength(2);
    expect(store.quotas()).toHaveLength(3);
    ingest(
      store,
      "pro",
      "2026-10-01T04:00:00.000Z",
      "2026-10-01T05:00:00.000Z",
    );
    expect(store.accounts()[0]?.plan).toBe("pro");
    expect(history(store)?.at(-1)).toEqual({
      plan: "pro",
      observedAt: "2026-10-01T05:00:00.000Z",
      changed: true,
    });
  } finally {
    store.close();
  }
});

test("batch freshness uses the maximum valid sample for each individual account", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    store.saveAccounts(
      [account("pro"), account("pro", "source", "other")],
      first,
    );
    store.saveQuotas([quota(second), quota(third, "source", "other")], third);
    store.saveIngestBatch(
      "source",
      {
        batchId: "mixed-accounts",
        collector: { name: "fixture", version: "test" },
        accounts: [account("max-5x"), account("max-5x", "source", "other")],
        usage: [],
        quotas: [quota(first), quota(third), quota(second, "source", "other")],
      },
      third,
    );
    expect(store.accounts().map((item) => item.plan)).toEqual([
      "max-5x",
      "pro",
    ]);
    expect(history(store)?.at(-1)).toEqual({
      plan: "max-5x",
      observedAt: third,
      changed: true,
    });
    expect(
      store.quotas().find((item) => item.fact.accountExternalId === "other")
        ?.planHistory,
    ).toEqual([{ plan: "pro", observedAt: first, changed: false }]);
  } finally {
    store.close();
  }
});

test("quota-only batches preserve plan history and timestamp-less accounts record observations", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    ingest(store, "pro", first, first);
    store.saveIngestBatch(
      "source",
      {
        batchId: "quota-only",
        collector: { name: "fixture", version: "test" },
        accounts: [],
        usage: [],
        quotas: [quota(second)],
      },
      second,
    );
    expect(history(store)).toHaveLength(1);
    store.saveIngestBatch(
      "source",
      {
        batchId: "account-only",
        collector: { name: "fixture", version: "test" },
        accounts: [account("max-5x")],
        usage: [],
        quotas: [],
      },
      third,
    );
    expect(history(store)?.at(-1)).toEqual({
      plan: "max-5x",
      observedAt: third,
      changed: true,
    });
  } finally {
    store.close();
  }
});

test("history keys distinguish source/account pairs containing separators", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    store.saveAccounts(
      [account("pro", "a:b", "c"), account("max-5x", "a", "b:c")],
      first,
    );
    store.saveQuotas(
      [quota(first, "a:b", "c"), quota(first, "a", "b:c")],
      first,
    );
    for (const row of store.quotas())
      expect(row.planHistory?.[0]?.plan).toBe(
        row.fact.sourceId === "a:b" ? "pro" : "max-5x",
      );
  } finally {
    store.close();
  }
});

test("ingest failure rolls back account, observations, quotas and revision", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    ingest(store, "pro", first, first);
    const revision = store.revision();
    expect(() =>
      store.saveIngestBatch(
        "source",
        {
          batchId: "failed",
          collector: { name: "fixture", version: "test" },
          accounts: [account("max-5x")],
          usage: [{ sourceId: "foreign" } as UsageFact],
          quotas: [quota(second)],
        },
        second,
      ),
    ).toThrow("foreign source record");
    expect(store.accounts()[0]?.plan).toBe("pro");
    expect(history(store)).toEqual([
      { plan: "pro", observedAt: first, changed: false },
    ]);
    expect(store.quotas()).toHaveLength(1);
    expect(store.revision()).toBe(revision);
  } finally {
    store.close();
  }
});

test("full account snapshot failure rolls back newly observed plans", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    store.saveAccounts(
      [account("pro"), account("pro", "source", "removed")],
      first,
    );
    store.saveQuotas([quota()], first);
    const revision = store.revision();
    store.db.exec(
      "CREATE TRIGGER reject_account_delete BEFORE DELETE ON accounts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    expect(() =>
      store.saveAccountsSnapshot("source", [account("max-5x")], second),
    ).toThrow("fixture failure");
    expect(history(store)).toEqual([
      { plan: "pro", observedAt: first, changed: false },
    ]);
    expect(store.accounts()[0]?.plan).toBe("pro");
    expect(store.revision()).toBe(revision);
  } finally {
    store.close();
  }
});
