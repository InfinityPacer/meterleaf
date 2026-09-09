import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageFact } from "../src/domain/connector";
import type { PriceBook } from "../src/domain/pricing";
import { LedgerStore } from "../src/storage/ledger";
import {
  LifetimeIndex,
  type LifetimeIndexSource,
} from "../src/storage/lifetime-index";

const book: PriceBook = {
  schemaVersion: 1,
  id: "test",
  version: "test-v1",
  unit: "per_million_tokens",
  publishedAt: "2026-01-01T00:00:00Z",
  sources: ["test fixture, not real prices"],
  rules: ["api", "subscription", "credits"].map((basis) => ({
    model: "test-model",
    tier: "standard" as const,
    currency: basis === "credits" ? ("credits" as const) : ("usd" as const),
    ...(basis !== "credits"
      ? { usdBasis: basis as "api" | "subscription" }
      : {}),
    effectiveFrom: "2000-01-01T00:00:00Z",
    rates: { input: "10", cacheRead: "1", cacheWrite: "12.5", output: "50" },
  })),
};

function fact(
  externalId: string,
  occurredAt: string,
  input = 100,
  output = 10,
): UsageFact {
  return {
    sourceId: "test",
    externalId,
    accountExternalId: "account",
    occurredAt,
    model: "test-model",
    upstreamModel: null,
    tier: "standard",
    tokens: {
      input,
      cacheRead: 20,
      cacheWrite: 30,
      cacheWrite5m: null,
      cacheWrite1h: null,
      output,
      reasoning: null,
    },
    gatewayCost: "999",
    gatewayBilled: "500",
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
}

function instrument(
  store: LedgerStore,
  tracked = true,
): {
  source: LifetimeIndexSource;
  scans: () => number;
  changeStateReads: () => number;
} {
  let scanCount = 0;
  let changeStateReadCount = 0;
  return {
    source: {
      db: store.db,
      revision: () => store.revision(),
      reportUsageMetrics: () => {
        scanCount += 1;
        return store.reportUsageMetrics();
      },
      reportUsageChangeState: tracked
        ? () => {
            changeStateReadCount += 1;
            return store.reportUsageChangeState();
          }
        : () => {
            changeStateReadCount += 1;
            return { tracked: false, lastSequence: 0 };
          },
      reportUsageChanges: tracked
        ? (afterSequence) => store.reportUsageChanges(afterSequence)
        : () => ({ tracked: false, lastSequence: 0, changes: [] }),
    },
    scans: () => scanCount,
    changeStateReads: () => changeStateReadCount,
  };
}

function save(store: LedgerStore, records: UsageFact[]) {
  store.savePage(
    "test",
    "incremental",
    { records, nextCursor: records.at(-1)?.externalId ?? null, hasMore: false },
    "2026-09-09T00:00:00Z",
  );
}

function sourceState(identity: string, stamp: string, dataVersion?: string) {
  return { identity, stamp, dataVersion };
}

test("time bounds expand without reads and seek only after boundary corrections or deletion", () => {
  const store = new LedgerStore(":memory:", book);
  const index = new LifetimeIndex(":memory:", store, {
    priceBookKey: "test@test-v1",
  });
  const first = "2026-09-01T00:00:00Z";
  const middle = "2026-09-02T00:00:00Z";
  const last = "2026-09-03T00:00:00Z";
  const later = "2026-09-04T00:00:00Z";
  let revision = 0;
  const refresh = () =>
    index.ensure(sourceState("db", String(++revision), String(revision)));
  try {
    save(store, [fact("first", first), fact("last", last)]);
    refresh();
    const queries = spyOn(index.db, "query");
    const lookups = () =>
      queries.mock.calls.filter(([sql]) => sql.includes("AS from_at")).length;
    save(store, [fact("middle", middle), fact("later", later)]);
    refresh();
    expect(index.value("subscription", later)).toMatchObject({
      from: first,
      to: later,
      count: 4,
    });
    save(store, [fact("middle", middle, 700)]);
    refresh();
    expect(lookups()).toBe(0);
    save(store, [fact("first", "2026-09-02T12:00:00Z")]);
    refresh();
    expect(lookups()).toBe(1);
    expect(index.value("subscription", later)).toMatchObject({
      from: middle,
      to: later,
      count: 4,
    });
    store.db.exec("DELETE FROM valuations; DELETE FROM usage_facts");
    store.setState("ledger:dataRevision", store.revision() + 1);
    refresh();
    expect(lookups()).toBe(2);
    expect(index.value("subscription", later)).toMatchObject({
      from: null,
      to: null,
      count: 0,
    });
    queries.mockRestore();
  } finally {
    index.close();
    store.close();
  }
});

test("streamed cumulative metrics retain the source transaction and roll back interrupted changes", () => {
  const store = new LedgerStore(":memory:", book);
  const index = new LifetimeIndex(":memory:", store, {
    priceBookKey: "test@test-v1",
  });
  const now = "2026-09-09T00:00:00Z";
  const metrics = spyOn(store, "reportUsageMetrics").mockImplementation(() => {
    throw new Error("array path forbidden");
  });
  const changes = spyOn(store, "reportUsageChanges").mockImplementation(() => {
    throw new Error("array path forbidden");
  });
  try {
    save(store, [fact("one", now)]);
    index.ensure(sourceState("db", "1", "1"));
    const before = index.value("subscription", now);
    save(store, [fact("one", now, 300), fact("two", now)]);
    const stream = store.reportUsageChangeStream.bind(store);
    const failed = spyOn(store, "reportUsageChangeStream").mockImplementation(
      (sequence) => {
        const delta = stream(sequence);
        return {
          ...delta,
          changes: (function* () {
            for (const change of delta.changes) {
              expect(store.db.inTransaction).toBe(true);
              yield change;
              throw new Error("interrupted stream");
            }
          })(),
        };
      },
    );
    expect(() => index.ensure(sourceState("db", "2", "2"))).toThrow(
      "interrupted stream",
    );
    expect(index.value("subscription", now)).toEqual(before);
    failed.mockRestore();
    expect(index.ensure(sourceState("db", "2", "2"))).toBe(true);
    expect(index.value("subscription", now)).toMatchObject({
      count: 2,
      tokens: { input: 400 },
    });
    expect(index.ensure(sourceState("db", "2", "2"))).toBe(false);
    expect(metrics).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
  } finally {
    metrics.mockRestore();
    changes.mockRestore();
    index.close();
    store.close();
  }
});

test("evidence-only corrections advance the checkpoint without rewriting cumulative metrics", () => {
  const store = new LedgerStore(":memory:", book);
  const source = instrument(store);
  const index = new LifetimeIndex(":memory:", source.source, {
    priceBookKey: "test@test-v1",
  });
  const now = "2026-09-09T00:00:00Z";
  const original = fact("evidence", "2026-09-08T01:00:00.000Z");
  const writes = () =>
    index.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  try {
    save(store, [original]);
    index.ensure(sourceState("db-a", "stat-1", "1"));
    const totals = index.value("subscription", now);
    const before = writes();
    save(store, [{ ...original, metadata: { duration_ms: 123 } }]);
    expect(index.ensure(sourceState("db-a", "stat-2", "2"))).toBe(true);
    expect(writes() - before).toBe(1);
    expect(index.value("subscription", now)).toEqual(totals);
    expect(index.ensure(sourceState("db-a", "stat-2", "2"))).toBe(false);
    expect(writes() - before).toBe(1);
    save(store, [fact("evidence", original.occurredAt, 300, 30)]);
    expect(index.ensure(sourceState("db-a", "stat-3", "3"))).toBe(true);
    expect(index.value("subscription", now).tokens.total).toBe(380);
    expect(source.scans()).toBe(1);
  } finally {
    index.close();
    store.close();
  }
});

test("persists totals and materialized rows across a restart without rescanning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-lifetime-index-"));
  const ledgerPath = join(dir, "ledger.sqlite");
  const indexPath = join(dir, "lifetime.sqlite");
  const store = new LedgerStore(ledgerPath, book);
  let index: LifetimeIndex | undefined;
  let reopened: LifetimeIndex | undefined;
  try {
    const occurredAt = "2026-09-08T01:00:00.000Z";
    save(store, [fact("one", occurredAt)]);
    const first = instrument(store);
    index = new LifetimeIndex(indexPath, first.source, {
      priceBookKey: "test@test-v1",
    });
    expect(index.ensure(sourceState("db-a", "stat-a", "1"))).toBe(true);
    expect(first.scans()).toBe(1);
    expect(index.value("subscription", "2026-09-09T00:00:00Z")).toMatchObject({
      count: 1,
      from: occurredAt,
      to: occurredAt,
      tokens: { total: 160, incomplete: 0 },
      priceVersion: "test@test-v1",
    });
    index.close();
    index = undefined;

    const second = instrument(store);
    reopened = new LifetimeIndex(indexPath, second.source, {
      priceBookKey: "test@test-v1",
    });
    // A new source connection may report data_version=1; it is not persisted as identity.
    expect(reopened.ensure(sourceState("db-a", "stat-a", "1"))).toBe(false);
    expect(second.scans()).toBe(0);
    expect(reopened.value("subscription", "2026-09-09T00:00:00Z").count).toBe(
      1,
    );
  } finally {
    reopened?.close();
    index?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("applies corrections and deletions from the change log without double counting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-lifetime-index-"));
  const ledgerPath = join(dir, "ledger.sqlite");
  const indexPath = join(dir, "lifetime.sqlite");
  const store = new LedgerStore(ledgerPath, book);
  const source = instrument(store);
  const index = new LifetimeIndex(indexPath, source.source, {
    priceBookKey: "test@test-v1",
  });
  try {
    const occurredAt = "2026-09-08T01:00:00.000Z";
    const original = fact("corrected", occurredAt, 100, 10);
    save(store, [original]);
    expect(index.ensure(sourceState("db-a", "stat-1", "1"))).toBe(true);
    expect(index.value("subscription", occurredAt).tokens.total).toBe(160);

    save(store, [fact("corrected", occurredAt, 300, 30)]);
    expect(index.ensure(sourceState("db-a", "stat-2", "2"))).toBe(true);
    expect(index.value("subscription", occurredAt)).toMatchObject({
      count: 1,
      tokens: { input: 300, output: 30, total: 380 },
    });

    save(store, [fact("corrected", occurredAt, 300, 30)]);
    expect(index.ensure(sourceState("db-a", "stat-3", "3"))).toBe(false);
    expect(index.value("subscription", occurredAt).tokens.total).toBe(380);

    store.db
      .query("DELETE FROM valuations WHERE source_id=? AND external_id=?")
      .run("test", "corrected");
    store.db
      .query("DELETE FROM usage_facts WHERE source_id=? AND external_id=?")
      .run("test", "corrected");
    expect(index.ensure(sourceState("db-a", "stat-4", "4"))).toBe(true);
    expect(index.value("subscription", occurredAt)).toMatchObject({
      count: 0,
      from: null,
      to: null,
      tokens: { total: null, incomplete: 0 },
      usd: null,
      incomplete: { usd: 0, apiUsd: 0, subscriptionUsd: 0, credits: 0 },
    });
  } finally {
    index.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps null metrics incomplete and sums decimal amounts exactly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-lifetime-index-"));
  const store = new LedgerStore(join(dir, "ledger.sqlite"), book);
  const index = new LifetimeIndex(
    join(dir, "lifetime.sqlite"),
    instrument(store).source,
    { priceBookKey: "test@test-v1" },
  );
  try {
    const known = {
      ...fact("known", "2026-09-08T01:00:00.000Z"),
      upstreamUsd: "0.1",
      upstreamUsdBasis: "subscription" as const,
      upstreamCredits: "0.2",
    };
    const unknown = {
      ...fact("unknown", "2026-09-08T02:00:00.000Z"),
      model: "not-priced",
      tokens: {
        input: null,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        output: null,
        reasoning: null,
      },
    };
    save(store, [known, unknown]);
    expect(index.ensure(sourceState("db-a", "stat-1"))).toBe(true);
    expect(index.value("subscription", "2026-09-09T00:00:00Z")).toMatchObject({
      count: 2,
      tokens: {
        input: 100,
        cacheRead: 20,
        cacheWrite: 30,
        output: 10,
        total: 160,
        incomplete: 1,
      },
      usd: "0.1",
      apiUsd: expect.any(String),
      credits: "0.2",
      incomplete: { usd: 1, apiUsd: 1, subscriptionUsd: 1, credits: 1 },
    });

    const valuation = store.db
      .query<{ payload: string }, [string, string, string]>(
        "SELECT payload FROM valuations WHERE source_id=? AND external_id=? AND version=?",
      )
      .get("test", "known", "test@test-v1");
    const revised = JSON.parse(valuation!.payload) as Record<string, unknown>;
    revised.usd = {
      ...(revised.usd as Record<string, unknown>),
      amount: "1e-7",
    };
    revised.subscriptionUsd = {
      ...(revised.subscriptionUsd as Record<string, unknown>),
      amount: "1e-7",
    };
    store.db
      .query(
        "UPDATE valuations SET payload=? WHERE source_id=? AND external_id=? AND version=?",
      )
      .run(JSON.stringify(revised), "test", "known", "test@test-v1");
    expect(index.ensure(sourceState("db-a", "stat-2", "2"))).toBe(true);
    expect(index.value("subscription", "2026-09-09T00:00:00Z").usd).toBe(
      "1e-7",
    );
  } finally {
    index.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("isolates price book keys and rejects a different source identity even with data_version=1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-lifetime-index-"));
  const firstPath = join(dir, "first.sqlite");
  const secondPath = join(dir, "second.sqlite");
  const indexPath = join(dir, "lifetime.sqlite");
  const firstStore = new LedgerStore(firstPath, book);
  const secondStore = new LedgerStore(secondPath, book);
  const firstSource = instrument(firstStore);
  const secondSource = instrument(secondStore);
  let firstIndex: LifetimeIndex | undefined;
  let secondIndex: LifetimeIndex | undefined;
  try {
    save(firstStore, [fact("first", "2026-09-08T01:00:00.000Z")]);
    save(secondStore, [fact("second", "2026-09-08T02:00:00.000Z", 200, 20)]);
    firstIndex = new LifetimeIndex(indexPath, firstSource.source, {
      priceBookKey: "test@test-v1",
    });
    secondIndex = new LifetimeIndex(indexPath, firstSource.source, {
      priceBookKey: "test@test-v2",
    });
    expect(firstIndex.ensure(sourceState("db-first", "stat-first", "1"))).toBe(
      true,
    );
    expect(secondIndex.ensure(sourceState("db-first", "stat-first", "1"))).toBe(
      true,
    );
    expect(firstIndex.value("subscription", "now").priceVersion).toBe(
      "test@test-v1",
    );
    expect(secondIndex.value("subscription", "now").priceVersion).toBe(
      "test@test-v2",
    );

    firstIndex.close();
    firstIndex = undefined;
    firstStore.close();
    const replacement = new LifetimeIndex(indexPath, secondSource.source, {
      priceBookKey: "test@test-v1",
    });
    try {
      expect(
        replacement.ensure(sourceState("db-second", "stat-second", "1")),
      ).toBe(true);
      expect(secondSource.scans()).toBe(1);
      expect(replacement.value("subscription", "now").count).toBe(1);
    } finally {
      replacement.close();
    }
  } finally {
    secondIndex?.close();
    firstIndex?.close();
    secondStore.close();
    try {
      firstStore.close();
    } catch {
      // The first store is closed before the source identity replacement check.
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuses an unchanged legacy no-change-log snapshot and rebuilds after its stamp changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-lifetime-index-"));
  const store = new LedgerStore(join(dir, "ledger.sqlite"), book);
  const first = instrument(store, false);
  let index = new LifetimeIndex(join(dir, "lifetime.sqlite"), first.source, {
    priceBookKey: "test@test-v1",
  });
  try {
    save(store, [fact("legacy", "2026-09-08T01:00:00.000Z")]);
    expect(index.ensure(sourceState("legacy-db", "size-1"))).toBe(true);
    expect(first.scans()).toBe(1);
    index.close();

    const second = instrument(store, false);
    index = new LifetimeIndex(join(dir, "lifetime.sqlite"), second.source, {
      priceBookKey: "test@test-v1",
    });
    expect(index.ensure(sourceState("legacy-db", "size-1"))).toBe(false);
    expect(second.scans()).toBe(0);

    save(store, [fact("legacy", "2026-09-08T01:00:00.000Z", 300, 30)]);
    expect(index.ensure(sourceState("legacy-db", "size-2"))).toBe(true);
    expect(index.value("subscription", "now").tokens.total).toBe(380);
    expect(second.scans()).toBe(1);
  } finally {
    index.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retries the same data version after an atomic index write failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-lifetime-index-"));
  const store = new LedgerStore(join(dir, "ledger.sqlite"), book);
  const source = instrument(store);
  const index = new LifetimeIndex(join(dir, "lifetime.sqlite"), source.source, {
    priceBookKey: "test@test-v1",
  });
  try {
    const occurredAt = "2026-09-08T01:00:00.000Z";
    save(store, [fact("retry", occurredAt, 100, 10)]);
    expect(index.ensure(sourceState("db-a", "stat-1", "1"))).toBe(true);
    const checkpointBefore = index.db
      .query<{ checkpoint: number }, [string]>(
        "SELECT checkpoint FROM lifetime_index_state WHERE price_book_key=?",
      )
      .get("test@test-v1")?.checkpoint;

    save(store, [fact("retry", occurredAt, 300, 30)]);
    index.db.exec(`
      CREATE TRIGGER lifetime_index_injected_failure
      BEFORE UPDATE ON lifetime_index_state
      BEGIN
        SELECT RAISE(ABORT, 'injected lifetime index failure');
      END;
    `);
    expect(() => index.ensure(sourceState("db-a", "stat-2", "2"))).toThrow(
      "injected lifetime index failure",
    );
    index.db.exec("DROP TRIGGER lifetime_index_injected_failure");

    // The failed transaction leaves both the old row and the old checkpoint intact.
    expect(index.value("subscription", occurredAt).tokens.total).toBe(160);
    expect(
      index.db
        .query<{ checkpoint: number }, [string]>(
          "SELECT checkpoint FROM lifetime_index_state WHERE price_book_key=?",
        )
        .get("test@test-v1")?.checkpoint,
    ).toBe(checkpointBefore);
    expect(index.ensure(sourceState("db-a", "stat-2", "2"))).toBe(true);
    expect(index.value("subscription", occurredAt).tokens.total).toBe(380);
  } finally {
    try {
      index.db.exec("DROP TRIGGER IF EXISTS lifetime_index_injected_failure");
    } finally {
      index.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("checks revision before trusting an unchanged data version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-lifetime-index-"));
  const store = new LedgerStore(join(dir, "ledger.sqlite"), book);
  const source = instrument(store);
  const index = new LifetimeIndex(join(dir, "lifetime.sqlite"), source.source, {
    priceBookKey: "test@test-v1",
  });
  try {
    save(store, [fact("revision", "2026-09-08T01:00:00.000Z")]);
    const state = sourceState("db-a", "stat-1", "same-connection-version");
    expect(index.ensure(state)).toBe(true);
    const readsBefore = source.changeStateReads();
    store.setState("ledger:dataRevision", store.revision() + 1);

    expect(index.ensure(state)).toBe(false);
    expect(source.changeStateReads()).toBe(readsBefore + 1);
    const persisted = index.db
      .query<{ source_revision: number }, [string]>(
        "SELECT source_revision FROM lifetime_index_state WHERE price_book_key=?",
      )
      .get("test@test-v1");
    expect(persisted?.source_revision).toBe(store.revision());
  } finally {
    index.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
