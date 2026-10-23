import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageFact } from "../src/domain/connector";
import type { PriceBook } from "../src/domain/pricing";
import { priceBookKey } from "../src/domain/pricing";
import { ReportProjection } from "../src/server/report-projection";
import { prunableChangeLogThrough } from "../src/storage/change-log-retention";
import { CHANGE_LOG_SUPPRESSION_KEY, LedgerStore } from "../src/storage/ledger";
import { LifetimeIndex } from "../src/storage/lifetime-index";
import { DATABASE_SCHEMA_REVISION } from "../src/storage/schema";

function book(version: string, inputRate = "10"): PriceBook {
  return {
    schemaVersion: 1,
    id: "test",
    unit: "per_million_tokens",
    version,
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
      rates: {
        input: inputRate,
        cacheRead: "1",
        cacheWrite: "12.5",
        output: "50",
      },
    })),
  };
}

function fact(
  externalId: string,
  occurredAt = "2026-09-08T01:00:00.000Z",
  input = 100,
): UsageFact {
  return {
    sourceId: "test",
    externalId,
    accountExternalId: "a",
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
      output: 10,
      reasoning: null,
    },
    gatewayCost: "999",
    gatewayBilled: "500",
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
}

function saveFacts(store: LedgerStore, facts: UsageFact[]) {
  store.savePage(
    "test",
    "incremental",
    {
      records: facts,
      nextCursor: facts.at(-1)?.externalId ?? null,
      hasMore: false,
    },
    "2026-09-09T00:00:00Z",
  );
}

function valuationCount(store: LedgerStore, version: string, stale: boolean) {
  return (
    store.db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM valuations WHERE version ${
          stale ? "<>" : "="
        } ?`,
      )
      .get(version)?.count ?? 0
  );
}

function changeLogCount(store: LedgerStore) {
  return (
    store.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM usage_change_log",
      )
      .get()?.count ?? 0
  );
}

function missingSuppressionMarker(store: LedgerStore) {
  return (
    store.db
      .query<{ key: string }, [string]>(
        "SELECT key FROM sync_state WHERE key=?",
      )
      .get(CHANGE_LOG_SUPPRESSION_KEY) ?? null
  );
}

test("pruning superseded valuations keeps current report output and the change log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-retention-"));
  const path = join(dir, "meterleaf.sqlite");
  const current = book("test-v1", "10");
  const superseded = book("test-v2", "20");
  try {
    const facts = [fact("a"), fact("b"), fact("c")];
    const first = new LedgerStore(path, current);
    saveFacts(first, facts);
    first.close();

    // 第二个价格表版本写完就关掉；之后的读取只使用当前版本。
    const second = new LedgerStore(path, superseded);
    saveFacts(second, [...facts, fact("v2-only")]);
    second.close();

    const store = new LedgerStore(path, current);
    try {
      const key = priceBookKey(current);
      const stale = valuationCount(store, key, true);
      const currentRows = valuationCount(store, key, false);
      expect(stale).toBeGreaterThan(0);
      expect(currentRows).toBeGreaterThan(0);

      const metricsBefore = store.reportUsageMetrics();
      const usageBefore = store.usage();
      const logBefore = changeLogCount(store);

      expect(await store.pruneStaleValuations()).toBe(stale);

      expect(valuationCount(store, key, true)).toBe(0);
      expect(valuationCount(store, key, false)).toBe(currentRows);
      expect(store.reportUsageMetrics()).toEqual(metricsBefore);
      expect(store.usage()).toEqual(usageBefore);
      // 旧估值删除不能制造索引变更。
      expect(changeLogCount(store)).toBe(logBefore);
      // 抑制标记只在维护事务内可见，不能残留到状态表。
      expect(missingSuppressionMarker(store)).toBeNull();

      // 正常写入当前版本估值仍然照常记录变更。
      const row = store.db
        .query<{ rowid: number; payload: string }, [string]>(
          "SELECT rowid, payload FROM valuations WHERE version=? LIMIT 1",
        )
        .get(key)!;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      payload.usd = { ...(payload.usd as object), amount: "1e-7" };
      store.db
        .query("UPDATE valuations SET payload=? WHERE rowid=?")
        .run(JSON.stringify(payload), row.rowid);
      expect(changeLogCount(store)).toBe(logBefore + 1);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upgrading the previous revision adds the suppression condition to valuation triggers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-retention-"));
  const path = join(dir, "meterleaf.sqlite");
  const priceBook = book("test-v1");
  const triggerNames = [
    "valuations_report_insert",
    "valuations_report_update",
    "valuations_report_delete",
  ] as const;
  try {
    const store = new LedgerStore(path, priceBook);
    saveFacts(store, [fact("kept")]);
    const usageBefore = store.usage();
    store.close();

    // 模拟上一修订：没有新修订记录，三个触发器也还没有 WHEN 条件。
    const legacy = new Database(path, { strict: true });
    legacy
      .query("DELETE FROM schema_revisions WHERE revision=?")
      .run(DATABASE_SCHEMA_REVISION);
    for (const name of triggerNames) {
      legacy.exec(`DROP TRIGGER IF EXISTS ${name}`);
      legacy.exec(`
        CREATE TRIGGER ${name}
        AFTER ${name.endsWith("insert") ? "INSERT" : name.endsWith("update") ? "UPDATE" : "DELETE"}
        ON valuations
        BEGIN
          INSERT INTO usage_change_log (revision, source_id, external_id)
          VALUES (0, ${name.endsWith("delete") ? "OLD" : "NEW"}.source_id, ${name.endsWith("delete") ? "OLD" : "NEW"}.external_id);
        END;
      `);
    }
    legacy.close();

    const upgraded = new LedgerStore(path, priceBook);
    try {
      for (const name of triggerNames) {
        const sql =
          upgraded.db
            .query<{ sql: string }, [string]>(
              "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
            )
            .get(name)?.sql ?? "";
        expect(sql).toContain("WHEN NOT EXISTS");
        expect(sql).toContain(CHANGE_LOG_SUPPRESSION_KEY);
      }
      expect(upgraded.usage()).toEqual(usageBefore);
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("change log pruning deletes strictly below the cursor and always keeps the maximum row", async () => {
  const store = new LedgerStore(":memory:", book("test-v1"));
  try {
    saveFacts(store, [fact("a"), fact("b"), fact("c")]);
    const ids = store.db
      .query<{ change_id: number }, []>(
        "SELECT change_id FROM usage_change_log ORDER BY change_id",
      )
      .all()
      .map((row) => row.change_id);
    const max = ids.at(-1)!;
    const cursor = ids[Math.floor(ids.length / 2)]!;

    expect(await store.pruneUsageChangeLog(cursor)).toBe(
      ids.filter((id) => id < cursor).length,
    );
    expect(
      store.db
        .query<{ change_id: number }, []>(
          "SELECT change_id FROM usage_change_log ORDER BY change_id",
        )
        .all()
        .map((row) => row.change_id),
    ).toEqual(ids.filter((id) => id >= cursor));
    expect(store.reportUsageChangeState().lastSequence).toBe(max);

    // 游标超过现存最大序号时仍然保留最大的一行，避免索引把空日志误判为全量重建。
    const remaining = ids.filter((id) => id >= cursor).length;
    expect(await store.pruneUsageChangeLog(max + 1_000)).toBe(remaining - 1);
    expect(
      store.db
        .query<{ change_id: number }, []>(
          "SELECT change_id FROM usage_change_log",
        )
        .all()
        .map((row) => row.change_id),
    ).toEqual([max]);
    expect(store.reportUsageChangeState().lastSequence).toBe(max);

    expect(await store.pruneUsageChangeLog(Number.NaN)).toBe(0);
  } finally {
    store.close();
  }
});

test("both indexes catch up incrementally after consumed changes are pruned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-retention-"));
  const path = join(dir, "meterleaf.sqlite");
  const priceBook = book("test-v1");
  const store = new LedgerStore(path, priceBook);
  const projection = new ReportProjection(
    store,
    path,
    join(dir, "reports.sqlite"),
  );
  const lifetime = new LifetimeIndex(join(dir, "lifetime.sqlite"), store, {
    priceBookKey: priceBookKey(priceBook),
  });
  try {
    saveFacts(store, [fact("a")]);
    projection.ensure();
    lifetime.ensure({ identity: "ledger", stamp: "1" });
    const through = prunableChangeLogThrough({
      reportSequence: projection.committedSequence(),
      lifetimeSequence: lifetime.committedCheckpoint(),
      indexState: "current",
    });
    expect(through).not.toBeNull();
    expect(await store.pruneUsageChangeLog(through!)).toBeGreaterThan(0);

    const replace = spyOn(projection.index, "replace");
    const metricScan = spyOn(store, "reportUsageMetricStream");
    saveFacts(store, [fact("b", "2026-09-08T02:00:00.000Z")]);

    expect(projection.ensure()).toBe(true);
    expect(lifetime.ensure({ identity: "ledger", stamp: "2" })).toBe(true);

    // 两个索引都从自己的游标继续追赶，没有触发全量重建。
    expect(replace).not.toHaveBeenCalled();
    expect(metricScan).not.toHaveBeenCalled();
    expect(
      projection.index.accountLifetime("test:a", "subscription").count,
    ).toBe(2);
    expect(
      lifetime.value("subscription", "2026-09-09T00:00:00Z"),
    ).toMatchObject({ count: 2 });
    expect(projection.committedSequence()).toBe(
      store.reportUsageChangeState().lastSequence,
    );
  } finally {
    lifetime.close();
    projection.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cursor behind the surviving change log floor forces a full rebuild", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-retention-"));
  const path = join(dir, "meterleaf.sqlite");
  const priceBook = book("test-v1");
  const store = new LedgerStore(path, priceBook);
  const projection = new ReportProjection(
    store,
    path,
    join(dir, "reports.sqlite"),
  );
  const lifetime = new LifetimeIndex(join(dir, "lifetime.sqlite"), store, {
    priceBookKey: priceBookKey(priceBook),
  });
  try {
    saveFacts(store, [fact("a")]);
    projection.ensure();
    lifetime.ensure({ identity: "ledger", stamp: "1" });
    const checkpoint = store.reportUsageChangeState().lastSequence;

    saveFacts(store, [fact("b", "2026-09-08T02:00:00.000Z")]);
    const max = store.reportUsageChangeState().lastSequence;
    // 模拟已被清理的中间记录：只剩最大的一行，两个索引需要的增量已不可读。
    store.db.query("DELETE FROM usage_change_log WHERE change_id<?").run(max);
    expect(max).toBeGreaterThan(checkpoint + 1);
    expect(store.reportUsageChangeFloor()).toBe(max);

    const replace = spyOn(projection.index, "replace");
    const metricScan = spyOn(store, "reportUsageMetricStream");
    expect(projection.ensure()).toBe(true);
    expect(lifetime.ensure({ identity: "ledger", stamp: "2" })).toBe(true);

    expect(replace).toHaveBeenCalled();
    expect(metricScan).toHaveBeenCalled();
    expect(
      projection.index.accountLifetime("test:a", "subscription").count,
    ).toBe(2);
    expect(
      lifetime.value("subscription", "2026-09-09T00:00:00Z"),
    ).toMatchObject({ count: 2 });
  } finally {
    lifetime.close();
    projection.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pruning is withheld while an index is unbuilt or rebuilding", () => {
  expect(
    prunableChangeLogThrough({
      reportSequence: 10,
      lifetimeSequence: 8,
      indexState: "current",
    }),
  ).toBe(8);
  for (const indexState of ["building", "transitional"] as const)
    expect(
      prunableChangeLogThrough({
        reportSequence: 10,
        lifetimeSequence: 8,
        indexState,
      }),
    ).toBeNull();
  expect(
    prunableChangeLogThrough({
      reportSequence: null,
      lifetimeSequence: 8,
      indexState: "current",
    }),
  ).toBeNull();
  expect(
    prunableChangeLogThrough({
      reportSequence: 10,
      lifetimeSequence: null,
      indexState: "current",
    }),
  ).toBeNull();
  expect(
    prunableChangeLogThrough({
      reportSequence: 0,
      lifetimeSequence: 0,
      indexState: "current",
    }),
  ).toBeNull();
});
