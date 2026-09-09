import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ViewCache, type CachedReport } from "../src/storage/view-cache";
import { createLedgerView, type ViewQuery } from "../src/shared/ledger-view";

const query: ViewQuery = {
  filter: { days: 7, model: "all", account: "all", search: "" },
  unit: "usd",
  granularity: "day",
  dimension: "model",
  page: 0,
  pageSize: 12,
  sort: "occurredAt",
  desc: true,
};

function entry(key = "report", lastUsed = 1): CachedReport {
  return {
    key,
    query,
    basis: "subscription",
    lastUsed,
    value: createLedgerView(
      {
        mode: "live",
        asOf: "2026-09-08T12:00:00.000Z",
        accounts: [],
        resets: [],
        pricing: {
          version: "book:old-v1",
          publishedAt: "2026-01-01",
          sources: [],
        },
        records: [
          {
            id: "test:1",
            accountId: "test:a",
            occurredAt: "2026-09-08T11:00:00.000Z",
            model: "fixture",
            input: null,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            usd: "12345678901234567890.1234567890123456789",
            credits: "1e-30",
            tier: "standard",
            quality: "estimated",
            priceVersion: "book:old-v1",
          },
        ],
      },
      query,
    ),
  };
}

function fixture(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-view-cache-"));
  try {
    run(join(dir, "cache.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cache reopens with original query, old price version and exact decimal text without TTL", () => {
  fixture((path) => {
    const original = entry();
    let cache = new ViewCache(path, "format:source:book");
    cache.save(original);
    cache.close();
    cache = new ViewCache(path, "format:source:book");
    try {
      expect(cache.load()).toEqual([original]);
      expect(cache.load()[0]!.value.records[0]!.usd).toBe(
        "12345678901234567890.1234567890123456789",
      );
      expect(cache.load()[0]!.value.records[0]!.credits).toBe("1e-30");
    } finally {
      cache.close();
    }
  });
});

test("namespace changes invalidate old source, book and format caches", () => {
  fixture((path) => {
    for (const namespace of [
      "v1:source-a:book-a",
      "v1:source-b:book-a",
      "v1:source-b:book-b",
      "v2:source-b:book-b",
      "v1:source-a:book-a",
    ]) {
      const cache = new ViewCache(path, namespace);
      try {
        expect(cache.load()).toEqual([]);
        cache.save(entry());
      } finally {
        cache.close();
      }
    }
  });
});

test("upsert and recency eviction persist at most sixteen entries", () => {
  fixture((path) => {
    let cache = new ViewCache(path, "test");
    for (let i = 0; i < 20; i++) cache.save(entry(String(i), i));
    cache.save(entry("4", 100));
    cache.save(entry("new", 99));
    cache.close();
    cache = new ViewCache(path, "test");
    try {
      const loaded = cache.load();
      expect(loaded).toHaveLength(16);
      expect(loaded.map((row) => row.key)).toEqual([
        "4",
        "new",
        ...Array.from({ length: 14 }, (_, i) => String(19 - i)),
      ]);
    } finally {
      cache.close();
    }
  });
});

test("malformed JSON and invalid containers throw rather than synthesizing defaults", () => {
  fixture((path) => {
    const cache = new ViewCache(path, "test");
    const db = new Database(path);
    try {
      cache.save(entry());
      for (const payload of [
        "{broken",
        "null",
        JSON.stringify({
          ...entry(),
          value: { ...entry().value, records: {} },
        }),
        JSON.stringify({ ...entry(), value: { ...entry().value, view: [] } }),
        JSON.stringify({
          ...entry(),
          value: { ...entry().value, resets: null },
        }),
      ]) {
        db.query("UPDATE view_cache SET payload=?").run(payload);
        expect(() => cache.load()).toThrow();
      }
    } finally {
      db.close();
      cache.close();
    }
  });
});

test("only successful results are stored and transient status is omitted without mutating input", () => {
  const cache = new ViewCache(":memory:", "test");
  try {
    const original = entry();
    original.value.reportStatus = { refreshing: false, lastError: null };
    cache.save(original);
    expect(cache.load()[0]!.value.reportStatus).toBeUndefined();
    expect(original.value.reportStatus).toEqual({
      refreshing: false,
      lastError: null,
    });
    for (const status of [
      { refreshing: true, lastError: null },
      { refreshing: false, lastError: { kind: "storage" } },
    ]) {
      expect(() =>
        cache.save({
          ...entry("failed"),
          value: { ...original.value, reportStatus: status },
        }),
      ).toThrow();
    }
    expect(cache.load()).toHaveLength(1);
  } finally {
    cache.close();
  }
});
