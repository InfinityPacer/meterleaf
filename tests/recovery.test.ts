import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageConnector, UsageFact } from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { LedgerStore } from "../src/storage/ledger";
import { SyncRunner } from "../src/server/sync";

function usage(id: string): UsageFact {
  return {
    sourceId: "recovery",
    externalId: id,
    accountExternalId: "a",
    occurredAt: "2026-09-08T01:00:00.000Z",
    model: "gpt-6-astra",
    upstreamModel: null,
    tier: null,
    tokens: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
}
const options = {
  intervalMs: 30_000,
  sweepMs: 1000,
  pageSize: 1,
  pagesPerPoll: 10,
};

test("restart resumes the last committed page after a later page fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meterleaf-recovery-"));
  const path = join(directory, "ledger.sqlite");
  let store = new LedgerStore(path, defaultPriceBook);
  let failed = true;
  const cursors: (string | null)[] = [];
  const connector: UsageConnector = {
    sourceId: "recovery",
    readAccounts: async () => [],
    close: async () => {},
    readUsage: async (cursor) => {
      cursors.push(cursor);
      if (failed && cursor === "1") throw new Error("source unavailable");
      const next = Number(cursor ?? 0) + 1;
      return {
        records: next <= 3 ? [usage(String(next))] : [],
        nextCursor: next <= 3 ? String(next) : cursor,
        hasMore: next < 3,
      };
    },
  };
  let sync = new SyncRunner(connector, store, options);
  try {
    await sync.poll("2026-09-08T02:00:00.000Z");
    expect(store.usage()).toHaveLength(1);
    expect(store.getState<string>("recovery:incremental:cursor")).toBe("1");
    expect(sync.status().initialComplete).toBe(false);
    await sync.stop();
    store.close();
    store = new LedgerStore(path, defaultPriceBook);
    sync = new SyncRunner(connector, store, options);
    cursors.length = 0;
    failed = false;
    await sync.poll("2026-09-08T02:05:00.000Z");
    expect(cursors[0]).toBe("1");
    expect(store.usage()).toHaveLength(3);
    expect(store.getState<string>("recovery:incremental:cursor")).toBe("3");
    expect(sync.status().error).toBeNull();
    expect(sync.status().initialComplete).toBe(true);
    await sync.poll("2026-09-08T02:05:30.000Z");
    expect(store.usage()).toHaveLength(3);
    expect(
      sync.covered("2026-09-08T02:00:00.000Z", "2026-09-08T02:05:00.000Z"),
    ).toBe(false);
  } finally {
    await sync.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("overlapping polls share one batch and shutdown waits before closing the source", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let called = 0;
  let closed = false;
  const connector: UsageConnector = {
    sourceId: "recovery",
    readAccounts: async () => [],
    close: async () => {
      closed = true;
    },
    readUsage: async (cursor) => {
      called++;
      await barrier;
      return {
        records: cursor ? [] : [usage("1")],
        nextCursor: "1",
        hasMore: false,
      };
    },
  };
  const sync = new SyncRunner(connector, store, options);
  try {
    const first = sync.poll("2026-09-08T02:00:00.000Z");
    expect(sync.poll("2026-09-08T02:00:01.000Z")).toBe(first);
    await Bun.sleep(0);
    expect(called).toBe(1);
    const stopping = sync.stop();
    expect(closed).toBe(false);
    release();
    await stopping;
    expect(closed).toBe(true);
    expect(store.usage()).toHaveLength(1);
    expect(store.getState<string>("recovery:incremental:cursor")).toBe("1");
  } finally {
    release();
    await sync.stop();
    store.close();
  }
});
