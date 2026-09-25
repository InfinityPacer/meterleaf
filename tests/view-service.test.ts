import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import Decimal from "decimal.js";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "../src/storage/ledger";
import {
  ReportBuildingError,
  ViewService,
} from "../src/server/view-service";
import { loadPriceBook } from "../src/server/price-book";
import { priceBookKey, valueUsage } from "../src/domain/pricing";
import { createApp } from "../src/server/app";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createLedgerView, type ViewQuery } from "../src/shared/ledger-view";
import type { SyncStatus } from "../src/server/sync";
import type { QuotaFact, UsageFact } from "../src/domain/connector";
import {
  createDiagnosticsLogger,
  type LogEvent,
} from "../src/server/diagnostics";

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
const sync: SyncStatus = {
  autoEnabled: false,
  running: false,
  phase: "idle",
  localRecords: 40,
  batchRecords: 0,
  batchPages: 0,
  hasSynced: true,
  lastAttempt: null,
  lastSuccess: null,
  error: null,
  quotaError: null,
  lastError: null,
  initialComplete: true,
  initialCompleteAt: null,
  lastSweep: null,
};

async function waitForCount(
  reports: ViewService,
  expected: number,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  let result = await reports.read(query, "subscription", sync, false);
  while (result.view.count !== expected && Date.now() < deadline) {
    await Bun.sleep(10);
    result = await reports.read(query, "subscription", sync, false);
  }
  expect(result.view.count).toBe(expected);
  return result;
}

function viewUsage(
  externalId: string,
  occurredAt: string,
  input = 100,
  output = 10,
): UsageFact {
  return {
    sourceId: "test",
    externalId,
    accountExternalId: "a",
    occurredAt,
    model: "gpt-6-astra",
    upstreamModel: null,
    tier: "standard",
    tokens: {
      input,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      output,
      reasoning: null,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
}

test("worker stage timings are logged without entering report data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-timing-"));
  const path = join(dir, "ledger.sqlite");
  const book = await loadPriceBook();
  const store = new LedgerStore(path, book);
  const events: LogEvent[] = [];
  const reports = new ViewService(path, book, {
    refreshIntervalMs: 0,
    diagnostics: createDiagnosticsLogger({
      level: "debug",
      sink: (event) => events.push(event),
    }),
  });
  try {
    const result = await reports.read(query, "subscription", sync);
    const timing = events.find(
      (event) => event.event === "report.query_timing",
    );
    expect(timing).toBeDefined();
    for (const key of [
      "queueMs",
      "indexMs",
      "readMs",
      "snapshotMs",
      "aggregateMs",
      "materializeMs",
    ]) {
      expect(Number.isFinite(timing![key])).toBe(true);
      expect(timing![key]).toBeGreaterThanOrEqual(0);
    }
    expect(result).not.toHaveProperty("timings");
    expect(timing).toMatchObject({
      sort: "occurredAt",
      hasSearch: false,
      hasAccount: false,
      hasModel: false,
    });
    expect(timing!.queryId).toMatch(/^[a-f0-9]+$/);
    const cached = await reports.read(query, "subscription", sync, false);
    expect(cached).not.toHaveProperty("timings");
    expect(
      events.filter((event) => event.event === "report.query_timing"),
    ).toHaveLength(1);
    await reports.read(
      {
        ...query,
        filter: {
          ...query.filter,
          search: "private-search-value",
          account: "private-account-id",
        },
      },
      "subscription",
      sync,
    );
    const filtered = events
      .filter((event) => event.event === "report.query_timing")
      .at(-1)!;
    expect(filtered).toMatchObject({ hasSearch: true, hasAccount: true });
    expect(filtered.queryId).not.toBe(timing!.queryId);
    expect(JSON.stringify(filtered)).not.toContain("private-search-value");
    expect(JSON.stringify(filtered)).not.toContain("private-account-id");
  } finally {
    await reports.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart serves the previous successful price version immediately while rebuilding asynchronously", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-restart-cache-"));
  const path = join(dir, "ledger.sqlite");
  const book = await loadPriceBook();
  const store = new LedgerStore(path, book);
  let reports: ViewService | undefined;
  try {
    const now = new Date().toISOString();
    store.savePage(
      "test",
      "incremental",
      { records: [viewUsage("1", now)], nextCursor: "1", hasMore: false },
      now,
    );
    reports = new ViewService(path, book, { refreshIntervalMs: 0 });
    const before = await reports.read(query, "subscription", sync);
    await reports.close();
    const nextBook = {
      ...book,
      version: `${book.version}-revised`,
      rules: book.rules.map((rule) => ({
        ...rule,
        rates: {
          ...rule.rates,
          input:
            rule.rates.input === null
              ? null
              : new Decimal(rule.rates.input).mul(2).toString(),
        },
      })),
    };
    reports = new ViewService(path, nextBook, { refreshIntervalMs: 0 });
    let immediately = false;
    const pending = reports.read(query, "subscription", sync).then((value) => {
      immediately = true;
      return value;
    });
    await Promise.resolve();
    expect(immediately).toBe(true);
    const restored = await pending;
    expect(restored.asOf).toBe(before.asOf);
    expect(restored.pricing!.version).toBe(priceBookKey(book));
    expect(restored.view.usdSummary).toEqual(before.view.usdSummary);
    expect(restored.reportStatus?.refreshing).toBe(true);
    let fresh = restored;
    const deadline = Date.now() + 3000;
    while (
      fresh.pricing!.version !== priceBookKey(nextBook) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
      fresh = await reports.read(query, "subscription", sync, false);
    }
    expect(fresh.pricing!.version).toBe(priceBookKey(nextBook));
    expect(fresh.view.usdSummary.value).toBeGreaterThan(
      before.view.usdSummary.value!,
    );
    expect(fresh.reportStatus?.refreshing).toBe(false);
    await reports.close();
    reports = new ViewService(path, nextBook, { refreshIntervalMs: 0 });
    const persisted = await reports.read(query, "subscription", sync, false);
    expect(persisted.pricing!.version).toBe(priceBookKey(nextBook));
    expect(persisted.view.usdSummary).toEqual(fresh.view.usdSummary);
    expect(persisted.reportStatus?.refreshing).toBe(false);
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a price change rebuilds in the background and answers uncached queries from the previous index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-background-"));
  const path = join(dir, "ledger.sqlite");
  const book = await loadPriceBook();
  const store = new LedgerStore(path, book);
  let reports: ViewService | undefined;
  try {
    const now = new Date().toISOString();
    store.savePage(
      "test",
      "incremental",
      { records: [viewUsage("1", now)], nextCursor: "1", hasMore: false },
      now,
    );
    reports = new ViewService(path, book, { refreshIntervalMs: 0 });
    await reports.read(query, "subscription", sync);
    await reports.close();
    const nextBook = {
      ...book,
      version: `${book.version}-revised`,
      rules: book.rules.map((rule) => ({
        ...rule,
        rates: {
          ...rule.rates,
          input:
            rule.rates.input === null
              ? null
              : new Decimal(rule.rates.input).mul(2).toString(),
        },
      })),
    };
    reports = new ViewService(path, nextBook, {
      refreshIntervalMs: 0,
      inlineRebuildLimit: 0,
    });
    // 缓存里没有的查询不再等待全量重建，先由旧索引回答并标记为刷新中。
    const uncached = { ...query, pageSize: 5 };
    const transitional = await reports.read(uncached, "subscription", sync);
    expect(transitional.reportStatus?.refreshing).toBe(true);
    expect(transitional.pricing!.version).toBe(priceBookKey(book));
    let fresh = transitional;
    const deadline = Date.now() + 5000;
    while (
      (fresh.reportStatus?.refreshing ||
        fresh.pricing!.version !== priceBookKey(nextBook)) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
      fresh = await reports.read(uncached, "subscription", sync, false);
    }
    expect(fresh.pricing!.version).toBe(priceBookKey(nextBook));
    expect(fresh.reportStatus?.refreshing).toBe(false);
    expect(fresh.view.usdSummary.value).toBeGreaterThan(
      transitional.view.usdSummary.value!,
    );
    expect(
      (await readdir(dir)).filter((name) => name.includes(".next")),
    ).toEqual([]);

    // 替换后的索引继续接收增量。
    const later = new Date().toISOString();
    store.savePage(
      "test",
      "incremental",
      { records: [viewUsage("2", later)], nextCursor: "2", hasMore: false },
      later,
    );
    await reports.read(query, "subscription", sync);
    await waitForCount(reports, 2);
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function readWhenBuilt(
  reports: ViewService,
  selected: ViewQuery,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await reports.read(selected, "subscription", sync, false);
      if (!result.reportStatus?.refreshing || Date.now() > deadline)
        return result;
    } catch (error) {
      if (!(error instanceof ReportBuildingError) || Date.now() > deadline)
        throw error;
    }
    await Bun.sleep(20);
  }
}

test("a first build without any index answers building instead of blocking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-first-build-"));
  const path = join(dir, "ledger.sqlite");
  const book = await loadPriceBook();
  const store = new LedgerStore(path, book);
  let reports: ViewService | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  try {
    const now = new Date().toISOString();
    store.savePage(
      "test",
      "incremental",
      { records: [viewUsage("1", now)], nextCursor: "1", hasMore: false },
      now,
    );
    reports = new ViewService(path, book, {
      refreshIntervalMs: 0,
      inlineRebuildLimit: 0,
    });
    const service = reports;
    app = createApp({
      snapshot: () => createDemoLedger(),
      view: (selected, basis, refresh) =>
        service.read(selected, basis ?? "subscription", sync, refresh),
    });
    const first = await app.inject({ method: "GET", url: "/api/view?days=7" });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: "building" });
    expect(Number.isFinite(Date.parse(first.json().since))).toBe(true);

    const built = await readWhenBuilt(reports, query);
    expect(built.view.count).toBe(1);
    expect(built.reportStatus?.refreshing).toBe(false);
  } finally {
    await app?.close();
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("switching to an unrelated price book keeps showing the previous results under their own version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-other-book-"));
  const path = join(dir, "ledger.sqlite");
  const book = await loadPriceBook();
  const store = new LedgerStore(path, book);
  let reports: ViewService | undefined;
  try {
    const now = new Date().toISOString();
    store.savePage(
      "test",
      "incremental",
      { records: [viewUsage("1", now)], nextCursor: "1", hasMore: false },
      now,
    );
    reports = new ViewService(path, book, { refreshIntervalMs: 0 });
    await reports.read(query, "subscription", sync);
    await reports.close();
    const otherBook = {
      ...book,
      id: "custom-book",
      version: "1",
      supersedes: undefined,
    };
    reports = new ViewService(path, otherBook, {
      refreshIntervalMs: 0,
      inlineRebuildLimit: 0,
    });
    const transitional = await reports.read(query, "subscription", sync);
    expect(transitional.reportStatus?.refreshing).toBe(true);
    expect(transitional.pricing!.version).toBe(priceBookKey(book));
    expect(transitional.view.count).toBe(1);
    const fresh = await readWhenBuilt(reports, query);
    expect(fresh.pricing!.version).toBe(priceBookKey(otherBook));
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a replaced ledger never shows the previous ledger's index while rebuilding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-replaced-"));
  const path = join(dir, "ledger.sqlite");
  const book = await loadPriceBook();
  let store = new LedgerStore(path, book);
  let reports: ViewService | undefined;
  try {
    const now = new Date().toISOString();
    store.savePage(
      "test",
      "incremental",
      { records: [viewUsage("1", now)], nextCursor: "1", hasMore: false },
      now,
    );
    reports = new ViewService(path, book, {
      refreshIntervalMs: 0,
      cachePath: null,
    });
    await reports.read(query, "subscription", sync);
    await reports.close();
    store.close();
    // 用另一份账本替换同名文件：旧索引属于旧账本，不能作为过渡结果。
    const replacement = join(dir, "replacement.sqlite");
    store = new LedgerStore(replacement, book);
    store.savePage(
      "test",
      "incremental",
      {
        records: [viewUsage("1", now), viewUsage("2", now)],
        nextCursor: "2",
        hasMore: false,
      },
      now,
    );
    store.close();
    await rm(path, { force: true });
    await rename(replacement, path);
    store = new LedgerStore(path, book);
    reports = new ViewService(path, book, {
      refreshIntervalMs: 0,
      cachePath: null,
      inlineRebuildLimit: 0,
    });
    await expect(
      reports.read(query, "subscription", sync),
    ).rejects.toBeInstanceOf(ReportBuildingError);
    const built = await readWhenBuilt(reports, query);
    expect(built.view.count).toBe(2);
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache writes blocked by SQLite do not delay cached reads or control APIs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-cache-lock-"));
  const path = join(dir, "ledger.sqlite");
  const cachePath = `${path}.reports.sqlite.views`;
  const book = await loadPriceBook();
  const store = new LedgerStore(path, book);
  const events: LogEvent[] = [];
  const reportsLogger = createDiagnosticsLogger({
    level: "debug",
    sink: (event) => events.push(event),
  });
  let reports: ViewService | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let lock: Database | undefined;
  try {
    const observedAt = new Date().toISOString();
    store.savePage(
      "test",
      "incremental",
      {
        records: [viewUsage("1", observedAt)],
        nextCursor: "1",
        hasMore: false,
      },
      observedAt,
    );
    reports = new ViewService(path, book, {
      refreshIntervalMs: 0,
      diagnostics: reportsLogger,
    });
    await reports.read(query, "subscription", sync);
    await reports.close();

    reports = new ViewService(path, book, {
      refreshIntervalMs: 0,
      diagnostics: reportsLogger,
    });
    const cacheWritesBefore = events.filter(
      (event) => event.event === "report.cache_write_timing",
    ).length;
    const queryTimingsBefore = events.filter(
      (event) => event.event === "report.query_timing",
    ).length;

    lock = new Database(cachePath, { create: false, strict: true });
    lock.exec("BEGIN IMMEDIATE");
    const nextObservedAt = new Date(Date.now() - 1_000).toISOString();
    store.savePage(
      "test",
      "incremental",
      {
        records: [viewUsage("2", nextObservedAt)],
        nextCursor: "2",
        hasMore: false,
      },
      nextObservedAt,
    );
    const currentSync = {
      ...sync,
      lastSuccess: "2026-09-09T02:34:56.000Z",
    };
    app = createApp({
      snapshot: () => {
        throw new Error("snapshot must not run during cache write lock");
      },
      sync: {
        status: () => currentSync,
        requestSync: () => {},
        setAutoSync: () => {},
      },
    });

    const started = performance.now();
    const cached = await reports.read(query, "subscription", currentSync);
    expect(performance.now() - started).toBeLessThan(500);
    expect(cached.view.count).toBe(1);
    expect(cached.sync).toEqual(currentSync);

    const queryDeadline = Date.now() + 2_000;
    while (
      events.filter((event) => event.event === "report.query_timing").length <=
        queryTimingsBefore &&
      Date.now() < queryDeadline
    ) {
      await Bun.sleep(10);
    }
    expect(
      events.filter((event) => event.event === "report.query_timing").length,
    ).toBeGreaterThan(queryTimingsBefore);
    expect(
      events.filter((event) => event.event === "report.cache_write_timing"),
    ).toHaveLength(cacheWritesBefore);

    let refreshed = await reports.read(
      query,
      "subscription",
      currentSync,
      false,
    );
    const refreshDeadline = Date.now() + 2_000;
    while (refreshed.view.count !== 2 && Date.now() < refreshDeadline) {
      await Bun.sleep(10);
      refreshed = await reports.read(query, "subscription", currentSync, false);
    }
    expect(refreshed.view.count).toBe(2);

    const controlStarted = performance.now();
    const [syncResponse, healthResponse] = await Promise.all([
      app.inject("/api/sync"),
      app.inject("/api/health"),
    ]);
    expect(performance.now() - controlStarted).toBeLessThan(500);
    expect(syncResponse.statusCode).toBe(200);
    expect(syncResponse.json<SyncStatus>()).toEqual(currentSync);
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json<{ status: string }>()).toEqual({ status: "ok" });

    lock.exec("ROLLBACK");
    lock.close();
    lock = undefined;
    const writeDeadline = Date.now() + 2_000;
    while (
      events.filter((event) => event.event === "report.cache_write_timing")
        .length <= cacheWritesBefore &&
      Date.now() < writeDeadline
    ) {
      await Bun.sleep(10);
    }
    expect(
      events.filter((event) => event.event === "report.cache_write_timing")
        .length,
    ).toBeGreaterThan(cacheWritesBefore);

    await reports.close();
    reports = new ViewService(path, book, {
      refreshIntervalMs: 0,
      diagnostics: reportsLogger,
    });
    const restored = await reports.read(
      query,
      "subscription",
      currentSync,
      false,
    );
    expect(restored.view.count).toBe(2);
  } finally {
    try {
      lock?.exec("ROLLBACK");
    } catch {
      /* 测试清理不遮蔽断言失败。 */
    }
    lock?.close();
    await app?.close();
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("an unusable persisted cache logs a diagnostic without failing a report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-cache-failure-"));
  const book = await loadPriceBook();
  const path = join(dir, "ledger.sqlite");
  const store = new LedgerStore(path, book);
  const events: LogEvent[] = [];
  const reports = new ViewService(path, book, {
    cachePath: dir,
    refreshIntervalMs: 0,
    diagnostics: createDiagnosticsLogger({
      sink: (event) => events.push(event),
    }),
  });
  try {
    const result = await reports.read(query, "subscription", sync);
    expect(result.view.count).toBe(0);
    expect(events.some((event) => event.event === "report.cache_failed")).toBe(
      true,
    );
  } finally {
    await reports.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restored views never cross a replaced source database or a different price book identity", async () => {
  for (const replacement of ["source", "book"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-identity-"));
    const path = join(dir, "ledger.sqlite");
    const book = await loadPriceBook();
    let store = new LedgerStore(path, book);
    let reports: ViewService | undefined;
    try {
      const now = new Date().toISOString();
      store.savePage(
        "test",
        "incremental",
        { records: [viewUsage("1", now)], nextCursor: "1", hasMore: false },
        now,
      );
      reports = new ViewService(path, book, { refreshIntervalMs: 0 });
      const old = await reports.read(query, "subscription", sync);
      expect(old.view.count).toBe(1);
      await reports.close();
      store.close();
      const nextBook =
        replacement === "book" ? { ...book, id: "another-book" } : book;
      if (replacement === "source")
        await rename(path, join(dir, "prior.sqlite"));
      store = new LedgerStore(path, nextBook);
      reports = new ViewService(path, nextBook, { refreshIntervalMs: 0 });
      const next = await reports.read(query, "subscription", sync, false);
      expect(next.pricing!.version).toBe(priceBookKey(nextBook));
      expect(next.view.count).toBe(replacement === "source" ? 0 : 1);
      expect(next.reportStatus?.refreshing).toBe(false);
    } finally {
      await reports?.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("view API validates bounds and returns summaries with a bounded page", async () => {
  const app = createApp({ snapshot: () => createDemoLedger() });
  try {
    const result = await app.inject("/api/view?days=7&pageSize=5");
    expect(result.statusCode).toBe(200);
    expect(result.json().records).toHaveLength(5);
    expect(result.json().view.count).toBe(1215);
    for (const suffix of [
      "pageSize=101",
      "page=-1",
      "desc=no",
      "refresh=no",
      "sort=payload",
      "from=2026-09-01",
      "days=7&from=2026-09-01&to=2026-09-02",
    ])
      expect((await app.inject(`/api/view?${suffix}`)).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

test("view API forwards observation mode without forcing another refresh", async () => {
  const refreshes: (boolean | undefined)[] = [];
  const app = createApp({
    snapshot: () => createDemoLedger(),
    view: async (query, _basis, refresh) => {
      refreshes.push(refresh);
      return createLedgerView(createDemoLedger(), query);
    },
  });
  try {
    expect((await app.inject("/api/view")).statusCode).toBe(200);
    expect((await app.inject("/api/view?refresh=false")).statusCode).toBe(200);
    expect(refreshes).toEqual([true, false]);
  } finally {
    await app.close();
  }
});

test("view timing distinguishes report reads from response preparation on success and failure", async () => {
  let fail = false;
  const app = createApp({
    snapshot: () => createDemoLedger(),
    view: async (query) => {
      await Bun.sleep(10);
      if (fail) throw new Error("fixture read failure");
      return createLedgerView(createDemoLedger(), query);
    },
  });
  try {
    for (const encoding of ["identity", "gzip"]) {
      const result = await app.inject({
        url: "/api/view",
        headers: { "accept-encoding": encoding },
      });
      expect(result.statusCode).toBe(200);
      const timing = String(result.headers["server-timing"]);
      expect(timing).toMatch(/^report;dur=\d+\.\d{2}, app;dur=\d+\.\d{2}$/);
      const durations = [...timing.matchAll(/dur=(\d+\.\d+)/g)].map((match) =>
        Number(match[1]),
      );
      expect(durations[0]).toBeGreaterThanOrEqual(5);
      expect(durations[1]).toBeGreaterThanOrEqual(durations[0]!);
    }
    fail = true;
    const failure = await app.inject("/api/view");
    expect(failure.statusCode).toBe(500);
    expect(String(failure.headers["server-timing"])).toMatch(
      /^report;dur=\d+\.\d{2}, app;dur=\d+\.\d{2}$/,
    );
    expect(
      (await app.inject("/api/health")).headers["server-timing"],
    ).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("read-only report worker pages independently and invalidates changed facts, not replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    const records: UsageFact[] = Array.from({ length: 40 }, (_, i) => ({
      sourceId: "test",
      externalId: String(i),
      accountExternalId: "a",
      occurredAt: new Date(Date.now() - 60_000 - i * 1000).toISOString(),
      model: "gpt-6-astra",
      upstreamModel: null,
      tier: "standard",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: null,
        cacheWrite1h: null,
        output: 10,
        reasoning: null,
      },
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
      metadata: {},
    }));
    const page = { records, nextCursor: "40", hasMore: false };
    store.savePage("test", "incremental", page, new Date().toISOString());
    const revision = store.revision();
    store.savePage("test", "sweep", page, new Date().toISOString());
    expect(store.revision()).toBe(revision);
    reports = new ViewService(join(dir, "test.sqlite"), book);
    const firstRead = reports.read(query, "subscription", sync);
    const secondRead = reports.read(query, "subscription", sync);
    expect(
      (reports as unknown as { active: Map<string, unknown> }).active.size,
    ).toBe(1);
    const [first, secondCold] = await Promise.all([firstRead, secondRead]);
    expect(first.records).toHaveLength(12);
    expect(first.view.count).toBe(40);
    expect(secondCold.view.count).toBe(40);
    const second = await reports.read(
      { ...query, page: 1 },
      "subscription",
      sync,
    );
    expect(second.records).toHaveLength(12);
    expect(
      second.records.some((r) => first.records.some((f) => f.id === r.id)),
    ).toBe(false);
    store.savePage(
      "test",
      "incremental",
      { ...page, records: [{ ...records[0]!, externalId: "new" }] },
      new Date().toISOString(),
    );
    expect(store.revision()).toBe(revision + 1);
    const stale = await reports.read(query, "subscription", sync);
    expect(stale.view.count).toBe(40);
    expect(stale.reportStatus).toMatchObject({ refreshing: true });
    const completed = await waitForCount(reports, 41);
    expect(completed.reportStatus?.refreshing).toBe(false);
    const peek = await reports.read(query, "subscription", sync, false);
    expect(peek.reportStatus?.refreshing).toBe(false);
    expect(
      (reports as unknown as { active: Map<string, unknown> }).active.size,
    ).toBe(0);
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("failed refresh keeps the last successful view and records a safe diagnostic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-error-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  const events: LogEvent[] = [];
  const logger = createDiagnosticsLogger({
    level: "debug",
    sink: (event) => events.push(event),
  });
  let reports: ViewService | undefined;
  try {
    const record: UsageFact = {
      sourceId: "test",
      externalId: "1",
      accountExternalId: "a",
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      model: "gpt-6-astra",
      upstreamModel: null,
      tier: "standard",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: null,
        cacheWrite1h: null,
        output: 10,
        reasoning: null,
      },
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
      metadata: {},
    };
    store.savePage(
      "test",
      "incremental",
      { records: [record], nextCursor: "1", hasMore: false },
      new Date().toISOString(),
    );
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      diagnostics: logger,
    });
    const successful = await reports.read(query, "subscription", sync);
    store.db.query("UPDATE usage_facts SET payload=?").run("{");

    const stale = await reports.read(query, "subscription", sync);
    expect(stale.view.count).toBe(successful.view.count);
    expect(stale.reportStatus?.refreshing).toBe(true);

    let failed = stale;
    const deadline = Date.now() + 2_000;
    while (!failed.reportStatus?.lastError && Date.now() < deadline) {
      await Bun.sleep(10);
      failed = await reports.read(query, "subscription", sync, false);
    }
    expect(failed.view.count).toBe(successful.view.count);
    expect(failed.reportStatus?.refreshing).toBe(false);
    expect(failed.reportStatus?.lastError).toMatchObject({
      code: "ERR_REPORT_READ_FAILED",
    });
    const refreshFailure = events.find(
      (event) => event.event === "report.refresh_failed",
    );
    expect(refreshFailure).toBeDefined();
    expect(JSON.stringify(refreshFailure)).not.toContain("payload");
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("timer refreshes cached queries sequentially", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-timer-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    const records: UsageFact[] = Array.from({ length: 2 }, (_, i) => ({
      sourceId: "test",
      externalId: String(i),
      accountExternalId: "a",
      occurredAt: new Date(Date.now() - 60_000 - i * 1000).toISOString(),
      model: "gpt-6-astra",
      upstreamModel: null,
      tier: "standard",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: null,
        cacheWrite1h: null,
        output: 10,
        reasoning: null,
      },
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
      metadata: {},
    }));
    store.savePage(
      "test",
      "incremental",
      { records, nextCursor: "2", hasMore: false },
      new Date().toISOString(),
    );
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      refreshIntervalMs: 30,
      getSyncStatus: () => sync,
    });
    await reports.read(query, "subscription", sync);
    store.savePage(
      "test",
      "incremental",
      {
        records: [{ ...records[0]!, externalId: "new" }],
        nextCursor: "3",
        hasMore: false,
      },
      new Date().toISOString(),
    );
    const cache = (
      reports as unknown as {
        cache: Map<string, { value: { view: { count: number } } }>;
      }
    ).cache;
    // 等待定时刷新提交结果，不把 CI 的 worker 调度速度当作业务约束。
    const deadline = Date.now() + 5000;
    while ([...cache.values()][0]?.value.view.count !== 3 && Date.now() < deadline)
      await Bun.sleep(20);
    expect([...cache.values()][0]?.value.view.count).toBe(3);
    expect(
      (reports as unknown as { active: Map<string, unknown> }).active.size,
    ).toBe(0);
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("close cancels the refresh timer and rejects later reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-close-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      refreshIntervalMs: 30,
      getSyncStatus: () => sync,
    });
    await reports.read(query, "subscription", sync);
    await reports.close();
    expect(
      (
        reports as unknown as {
          refreshTimer: ReturnType<typeof setInterval> | null;
        }
      ).refreshTimer,
    ).toBeNull();
    await expect(reports.read(query, "subscription", sync)).rejects.toThrow(
      "report-worker-unavailable",
    );
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cached quota windows expire without changing the report asOf", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-expired-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    const observedAt = new Date().toISOString();
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const record: UsageFact = {
      sourceId: "test",
      externalId: "1",
      accountExternalId: "a",
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      model: "gpt-6-astra",
      upstreamModel: null,
      tier: "standard",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: null,
        cacheWrite1h: null,
        output: 10,
        reasoning: null,
      },
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
      metadata: {},
    };
    const quota: QuotaFact = {
      sourceId: "test",
      externalId: "quota-1",
      accountExternalId: "a",
      window: "seven-day",
      percent: 50,
      sampledAt: observedAt,
      resetsAt: resetAt,
      windowMinutes: 10_080,
    };
    store.savePage(
      "test",
      "incremental",
      { records: [record], nextCursor: "1", hasMore: false },
      observedAt,
    );
    store.saveQuotas([quota], observedAt);
    let clock = Date.now();
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      now: () => clock,
      refreshIntervalMs: 86_400_000,
    });
    const fresh = await reports.read(query, "subscription", sync);
    expect(fresh.accounts[0]!.sevenDay!.periodUsd).not.toBeNull();
    clock = Date.parse(resetAt) + 1;
    await reports.close();
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      now: () => clock,
      refreshIntervalMs: 86_400_000,
    });
    const expired = await reports.read(query, "subscription", sync);
    const window = expired.accounts[0]!.sevenDay!;
    expect(expired.asOf).toBe(fresh.asOf);
    expect(window.state).toBe("expired");
    expect(window.percent).toBe(0);
    expect(window.periodUsd).toBeNull();
    expect(window.periodCredits).toBeNull();
    expect(window.estimate?.usd).toBeNull();
    expect(window.estimate?.credits).toBeNull();
    expect(window.estimate?.reason).toBe("expired");
    for (const basis of ["subscription", "api"] as const) {
      const variantWindow = expired.usdVariants?.[basis].accounts[0]?.sevenDay;
      expect(variantWindow?.state).toBe("expired");
      expect(variantWindow?.periodUsd).toBeNull();
      expect(variantWindow?.estimate?.usd).toBeNull();
    }
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("lifetime totals stay global across range filters and USD basis changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-lifetime-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    const now = Date.now();
    const old = viewUsage(
      "old",
      new Date(now - 40 * 86_400_000).toISOString(),
      200,
      20,
    );
    const recent = viewUsage(
      "recent",
      new Date(now - 60_000).toISOString(),
      100,
      10,
    );
    store.savePage(
      "test",
      "incremental",
      { records: [old, recent], nextCursor: "2", hasMore: false },
      new Date(now).toISOString(),
    );
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      refreshIntervalMs: 86_400_000,
    });

    const current = await reports.read(query, "subscription", sync);
    expect(current.view.count).toBe(1);
    expect(current.lifetimeTotals).toMatchObject({
      count: 2,
      from: old.occurredAt,
      to: recent.occurredAt,
      tokens: { total: 330, incomplete: 0 },
      usdBasis: "subscription",
    });
    expect(current.lifetimeTotals?.usd).not.toBeNull();
    expect(current.lifetimeTotals?.incomplete.usd).toBe(0);
    expect(current.accounts[0]?.lifetime).toMatchObject({
      count: 2,
      tokens: 330,
      incompleteUsd: 0,
    });

    const filtered = await reports.read(
      {
        ...query,
        filter: {
          ...query.filter,
          model: "not-present",
          account: "not-present",
          search: "not-present",
        },
      },
      "api",
      sync,
    );
    expect(filtered.view.count).toBe(0);
    expect(filtered.lifetimeTotals?.count).toBe(2);
    expect(filtered.lifetimeTotals?.tokens.total).toBe(330);
    expect(filtered.lifetimeTotals?.usdBasis).toBe("api");
    expect(filtered.lifetimeTotals?.apiUsd).toBe(filtered.lifetimeTotals?.usd);
    expect(filtered.accounts[0]?.lifetime).toMatchObject({
      count: 2,
      tokens: 330,
    });
    expect(filtered.accounts[0]?.lifetime?.usd).toBe(
      filtered.lifetimeTotals?.usd,
    );

    const tokens = await reports.read(
      { ...query, unit: "tokens" },
      "api",
      sync,
    );
    expect(tokens.view.count).toBe(1);
    expect(tokens.lifetimeTotals?.count).toBe(2);
    expect(tokens.lifetimeTotals?.tokens.total).toBe(330);
    const apiRecord = tokens.records[0]!;
    expect(apiRecord.valuation?.usdBasis).toBe("api");
    expect(apiRecord.valuation?.usd).toEqual(apiRecord.valuation?.apiUsd);
    expect(apiRecord.usd).toBe(apiRecord.valuation?.apiUsd.amount ?? null);
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("worker keeps quota period and estimate amounts aligned with USD basis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-quota-basis-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    const now = Date.now();
    const record = viewUsage(
      "long-context-quota",
      new Date(now - 60_000).toISOString(),
      300_000,
      1_000,
    );
    const sampledAt = new Date(now - 30_000).toISOString();
    const resetsAt = new Date(
      now + 6 * 86_400_000 + 23 * 3_600_000,
    ).toISOString();
    store.saveAccounts([
      {
        sourceId: "test",
        externalId: "a",
        name: "a",
        kind: "subscription",
        platform: "test",
        plan: "pro",
        parentExternalId: null,
        subjectKey: null,
      },
    ]);
    store.savePage(
      "test",
      "incremental",
      { records: [record], nextCursor: "1", hasMore: false },
      new Date(now).toISOString(),
    );
    store.saveQuotas(
      [
        {
          sourceId: "test",
          externalId: "quota-long-context",
          accountExternalId: "a",
          window: "seven-day",
          percent: 80,
          sampledAt,
          resetsAt,
          windowMinutes: 10_080,
        },
      ],
      sampledAt,
    );
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      refreshIntervalMs: 86_400_000,
    });

    const subscription = await reports.read(query, "subscription", sync);
    const api = await reports.read(query, "api", sync);
    const valuation = valueUsage(record, book);
    const subscriptionQuota = subscription.accounts[0]!.sevenDay!;
    const apiQuota = api.accounts[0]!.sevenDay!;
    expect(subscriptionQuota.periodUsd).toBe(valuation.subscriptionUsd.amount);
    expect(apiQuota.periodUsd).toBe(valuation.apiUsd.amount);
    expect(apiQuota.periodUsd).not.toBe(subscriptionQuota.periodUsd);
    expect(apiQuota.periodCredits).toBe(subscriptionQuota.periodCredits);
    expect(subscriptionQuota.estimate?.usd).toBe(
      new Decimal(valuation.subscriptionUsd.amount!)
        .mul(100)
        .div(80)
        .toString(),
    );
    expect(apiQuota.estimate?.usd).toBe(
      new Decimal(valuation.apiUsd.amount!).mul(100).div(80).toString(),
    );
    expect(api.records[0]!.valuation?.usdBasis).toBe("api");
    expect(api.records[0]!.valuation?.usd).toEqual(
      api.records[0]!.valuation?.apiUsd,
    );
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("lifetime token totals include known buckets from partial rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-partial-tokens-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    const now = Date.now();
    const complete = viewUsage(
      "complete-tokens",
      new Date(now - 60_000).toISOString(),
      100,
      10,
    );
    const partial = {
      ...viewUsage(
        "partial-tokens",
        new Date(now - 30_000).toISOString(),
        200,
        20,
      ),
      tokens: {
        ...viewUsage(
          "partial-tokens",
          new Date(now - 30_000).toISOString(),
          200,
          20,
        ).tokens,
        output: null,
      },
    };
    store.savePage(
      "test",
      "incremental",
      { records: [complete, partial], nextCursor: "2", hasMore: false },
      new Date(now).toISOString(),
    );
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      refreshIntervalMs: 86_400_000,
    });

    const result = await reports.read(query, "subscription", sync);
    expect(result.view.tokenSummary.value).toBe(310);
    expect(result.view.tokenSummary.incompleteRows).toBe(1);
    expect(result.lifetimeTotals?.tokens.total).toBe(
      result.view.tokenSummary.value,
    );
    expect(result.lifetimeTotals?.tokens.incomplete).toBe(
      result.view.tokenSummary.incompleteRows,
    );
    expect(result.lifetimeTotals?.tokens.output).toBe(10);
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("lifetime totals apply corrected facts incrementally and idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-lifetime-update-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    const original = viewUsage("corrected", observedAt, 100, 10);
    store.savePage(
      "test",
      "incremental",
      { records: [original], nextCursor: "1", hasMore: false },
      observedAt,
    );
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      refreshIntervalMs: 86_400_000,
    });
    const first = await reports.read(query, "subscription", sync);
    expect(first.lifetimeTotals?.tokens.total).toBe(110);
    const firstChangeSequence = store.reportUsageChanges(0).lastSequence;

    const corrected = viewUsage("corrected", observedAt, 300, 30);
    store.savePage(
      "test",
      "incremental",
      { records: [corrected], nextCursor: "1", hasMore: false },
      new Date().toISOString(),
    );
    const stale = await reports.read(query, "subscription", sync);
    expect(stale.lifetimeTotals?.tokens.total).toBe(110);
    expect(stale.reportStatus?.refreshing).toBe(true);

    let updated = stale;
    const deadline = Date.now() + 2_000;
    while (
      updated.lifetimeTotals?.tokens.total !== 330 &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
      updated = await reports.read(query, "subscription", sync, false);
    }
    expect(updated.lifetimeTotals?.tokens.total).toBe(330);
    expect(updated.lifetimeTotals?.count).toBe(1);

    store.savePage(
      "test",
      "incremental",
      { records: [corrected], nextCursor: "1", hasMore: false },
      new Date().toISOString(),
    );
    const changes = store.reportUsageChanges(firstChangeSequence);
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]?.metric?.input).toBe(300);
    expect(changes.lastSequence).toBeGreaterThan(firstChangeSequence);
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("lifetime totals refresh after a valuation-only update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-valuation-update-"));
  const book = await loadPriceBook();
  const store = new LedgerStore(join(dir, "test.sqlite"), book);
  let reports: ViewService | undefined;
  try {
    const record = viewUsage(
      "valuation-update",
      new Date(Date.now() - 60_000).toISOString(),
    );
    store.savePage(
      "test",
      "incremental",
      { records: [record], nextCursor: "1", hasMore: false },
      new Date().toISOString(),
    );
    reports = new ViewService(join(dir, "test.sqlite"), book, {
      refreshIntervalMs: 86_400_000,
    });
    const first = await reports.read(query, "subscription", sync);
    const original = valueUsage(record, book);
    const revised = {
      ...original,
      usd: { ...original.usd, amount: "1e-7" },
      subscriptionUsd: { ...original.subscriptionUsd, amount: "1e-7" },
    };
    store.db
      .query(
        "UPDATE valuations SET payload=? WHERE source_id=? AND external_id=? AND version=?",
      )
      .run(
        JSON.stringify(revised),
        "test",
        record.externalId,
        original.version,
      );

    const stale = await reports.read(query, "subscription", sync);
    expect(stale.lifetimeTotals?.usd).toBe(first.lifetimeTotals?.usd);
    expect(stale.reportStatus?.refreshing).toBe(true);

    let updated = stale;
    const deadline = Date.now() + 2_000;
    while (updated.lifetimeTotals?.usd !== "1e-7" && Date.now() < deadline) {
      await Bun.sleep(10);
      updated = await reports.read(query, "subscription", sync, false);
    }
    expect(updated.lifetimeTotals?.usd).toBe("1e-7");
    expect(updated.records[0]?.usd).toBe("1e-7");
  } finally {
    await reports?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("lifetime totals rebuild against a new price version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-view-price-version-"));
  const path = join(dir, "test.sqlite");
  const book = await loadPriceBook();
  const firstStore = new LedgerStore(path, book);
  let firstStoreClosed = false;
  let revisedStore: LedgerStore | undefined;
  let reports: ViewService | undefined;
  try {
    const record = viewUsage(
      "repriced",
      new Date(Date.now() - 60_000).toISOString(),
    );
    firstStore.savePage(
      "test",
      "incremental",
      { records: [record], nextCursor: "1", hasMore: false },
      new Date().toISOString(),
    );
    firstStore.close();
    firstStoreClosed = true;

    const revisedBook = {
      ...book,
      version: `${book.version}-reprice`,
      rules: book.rules.map((rule) =>
        rule.model === "gpt-6-astra" &&
        rule.currency === "usd" &&
        rule.usdBasis === "subscription"
          ? { ...rule, rates: { ...rule.rates, input: "999" } }
          : rule,
      ),
    };
    revisedStore = new LedgerStore(path, revisedBook);
    reports = new ViewService(path, revisedBook, {
      refreshIntervalMs: 86_400_000,
    });
    const result = await reports.read(query, "subscription", sync);
    const expected = valueUsage(record, revisedBook).subscriptionUsd.amount;
    expect(result.lifetimeTotals?.priceVersion).toBe(
      `${revisedBook.id}@${revisedBook.version}`,
    );
    expect(result.lifetimeTotals?.usd).toBe(expected);
    expect(result.records[0]?.usd).toBe(expected);
  } finally {
    await reports?.close();
    revisedStore?.close();
    if (!firstStoreClosed) firstStore.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
