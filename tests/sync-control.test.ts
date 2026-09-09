import { expect, test } from "bun:test";
import type { UsageConnector, UsageFact } from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { LedgerStore } from "../src/storage/ledger";
import {
  createDiagnosticsLogger,
  type LogEvent,
} from "../src/server/diagnostics";
import { SyncRunner } from "../src/server/sync";
import {
  createSyncPresenceRequestInit,
  formatSyncStatusReadError,
  getSyncStatusRefetchInterval,
  isSyncStatusAuthenticationError,
  isSyncStatusAuthenticationResponse,
  shouldRetrySyncStatusRead,
} from "../src/web/components/SyncControl";

test("authentication redirects stop status retries and preserve ordinary retry behavior", () => {
  const authenticationError = {
    syncStatusReadError: "authentication" as const,
    status: 401,
  };
  const timeoutError = {
    syncStatusReadError: "gateway-timeout" as const,
    status: 504,
  };

  expect(
    isSyncStatusAuthenticationResponse({ type: "opaqueredirect", status: 0 }),
  ).toBe(true);
  expect(
    isSyncStatusAuthenticationResponse({ type: "basic", status: 401 }),
  ).toBe(true);
  expect(
    isSyncStatusAuthenticationResponse({ type: "basic", status: 403 }),
  ).toBe(true);
  expect(
    isSyncStatusAuthenticationResponse({ type: "basic", status: 200 }),
  ).toBe(false);
  expect(isSyncStatusAuthenticationError(authenticationError)).toBe(true);
  expect(formatSyncStatusReadError(authenticationError)).toBe(
    "同步状态认证失败，请重新认证",
  );

  expect(shouldRetrySyncStatusRead(0, authenticationError)).toBe(false);
  expect(shouldRetrySyncStatusRead(0, timeoutError)).toBe(true);
  expect(shouldRetrySyncStatusRead(1, timeoutError)).toBe(false);
  expect(
    getSyncStatusRefetchInterval(
      {
        status: "error",
        fetchFailureCount: 0,
        error: authenticationError,
      },
      false,
    ),
  ).toBe(false);
  expect(
    getSyncStatusRefetchInterval(
      {
        status: "error",
        fetchFailureCount: 0,
        error: timeoutError,
      },
      false,
    ),
  ).toBe(15_000);

  const request = createSyncPresenceRequestInit("page-1", true);
  expect(request.redirect).toBe("manual");
  expect(JSON.parse(String(request.body))).toEqual({
    id: "page-1",
    visible: true,
  });
});

function fact(id: string, sourceId = "control"): UsageFact {
  return {
    sourceId,
    externalId: id,
    accountExternalId: "account",
    occurredAt: "2026-09-08T01:00:00.000Z",
    model: "test-model",
    upstreamModel: null,
    tier: null,
    tokens: {
      input: 1,
      output: 1,
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

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("presence adjusts one automatic schedule without postponing it or enabling sync", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  seedPendingIncremental(store, "presence");
  store.setState("presence:incremental:caughtUp", true);
  let reads = 0;
  const sync = new SyncRunner(
    {
      sourceId: "presence",
      readAccounts: async () => [],
      readUsage: async () => {
        reads += 1;
        return { records: [], nextCursor: "1", hasMore: false };
      },
      close: async () => {},
    },
    store,
    { intervalMs: 40, hiddenIntervalMs: 180, sweepMs: Number.MAX_SAFE_INTEGER },
  );
  try {
    sync.start();
    sync.updatePresence("a", true);
    await Bun.sleep(50);
    expect(reads).toBe(0);
    sync.setAutoSync(true);
    await waitFor(() => reads === 1 && !sync.status().running);
    sync.updatePresence("b", true);
    sync.updatePresence("a", false);
    await waitFor(() => reads >= 2, 130);
    sync.updatePresence("b", false);
    await waitFor(() => !sync.status().running);
    const hiddenReads = reads;
    await Bun.sleep(90);
    expect(reads).toBe(hiddenReads);
    // 已等待超过前台间隔，恢复可见应立即推进，而不是再等一个完整周期。
    sync.updatePresence("a", true);
    await waitFor(() => reads > hiddenReads, 100);
    sync.setAutoSync(false);
    await waitFor(() => !sync.status().running);
    const stoppedReads = reads;
    sync.updatePresence("a", true);
    await Bun.sleep(60);
    expect(reads).toBe(stoppedReads);
  } finally {
    await sync.stop();
    store.close();
  }
});

function seedPendingIncremental(store: LedgerStore, sourceId: string) {
  store.setState(`${sourceId}:status`, {
    lastAttempt: "2026-09-08T00:00:00.000Z",
    lastSuccess: "2026-09-08T00:00:00.000Z",
    error: null,
    quotaError: null,
    lastError: null,
    initialComplete: true,
    initialCompleteAt: "2026-09-08T00:00:00.000Z",
    lastSweep: "2099-01-01T00:00:00.000Z",
    hasSynced: true,
    batchRecords: 0,
    batchPages: 0,
  });
  store.setState(`${sourceId}:incremental:cursor`, "1");
  store.setState(`${sourceId}:incremental:caughtUp`, false);
}

function backlogConnector(reads: { count: number }): UsageConnector {
  return {
    sourceId: "backlog",
    readAccounts: async () => [],
    readUsage: async (cursor) => {
      reads.count += 1;
      const next = Number(cursor ?? "1") + 1;
      return {
        records: [fact(String(next), "backlog")],
        nextCursor: String(next),
        hasMore: next < 5,
      };
    },
    close: async () => {},
  };
}

test("start defaults to idle and requestSync completes bounded initial and sweep work", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  let accounts = 0;
  let usageReads = 0;
  const connector: UsageConnector = {
    sourceId: "control",
    readAccounts: async () => {
      accounts += 1;
      return [];
    },
    readUsage: async (cursor) => {
      usageReads += 1;
      if (cursor === null && usageReads === 1) {
        return { records: [fact("1")], nextCursor: "1", hasMore: true };
      }
      if (cursor === "1") {
        return { records: [], nextCursor: "1", hasMore: false };
      }
      return { records: [fact("1")], nextCursor: "1", hasMore: false };
    },
    close: async () => {},
  };
  const sync = new SyncRunner(connector, store, {
    backlogIntervalMs: 1,
    pageSize: 1,
    pagesPerPoll: 1,
  });

  try {
    sync.start();
    await Bun.sleep(15);
    expect(accounts).toBe(0);
    expect(usageReads).toBe(0);
    expect(sync.status()).toMatchObject({
      autoEnabled: false,
      running: false,
      phase: "idle",
      localRecords: 0,
      hasSynced: false,
      lastAttempt: null,
      lastError: null,
    });

    const requested = sync.requestSync();
    expect(requested.running).toBe(true);
    await waitFor(() => !sync.status().running);

    expect(accounts).toBe(1);
    expect(usageReads).toBe(3);
    expect(sync.status()).toMatchObject({
      autoEnabled: false,
      phase: "idle",
      localRecords: 1,
      hasSynced: true,
      initialComplete: true,
      error: null,
    });
  } finally {
    await sync.stop();
    store.close();
  }
});

test("setAutoSync persists the choice and disabling does not cancel a manual task", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const connector: UsageConnector = {
    sourceId: "control",
    readAccounts: async () => [],
    readUsage: async () => {
      reads += 1;
      await barrier;
      return { records: [], nextCursor: null, hasMore: false };
    },
    close: async () => {},
  };
  const sync = new SyncRunner(connector, store, {
    backlogIntervalMs: 1,
    pageSize: 1,
    pagesPerPoll: 1,
  });

  try {
    expect(sync.setAutoSync(true).autoEnabled).toBe(true);
    expect(store.getState<boolean>("control:autoEnabled")).toBe(true);
    sync.start();
    await waitFor(() => reads === 1);
    expect(sync.status().running).toBe(true);

    sync.setAutoSync(false);
    expect(sync.status().autoEnabled).toBe(false);
    release();
    await waitFor(() => !sync.status().running);
    const completedReads = reads;
    await Bun.sleep(30);
    expect(reads).toBe(completedReads);
  } finally {
    release();
    await sync.stop();
    store.close();
  }
});

test("manual sync keeps running until a new incremental backlog is caught up", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const reads = { count: 0 };
  seedPendingIncremental(store, "backlog");
  const sync = new SyncRunner(backlogConnector(reads), store, {
    backlogIntervalMs: 1,
    sweepMs: Number.MAX_SAFE_INTEGER,
    pageSize: 1,
    pagesPerPoll: 2,
  });

  try {
    sync.requestSync();
    await waitFor(() => !sync.status().running);
    expect(reads.count).toBe(4);
    expect(store.usage()).toHaveLength(4);
    expect(store.getState<boolean>("backlog:incremental:caughtUp")).toBe(true);
  } finally {
    await sync.stop();
    store.close();
  }
});

test("automatic backlog recovery uses the short interval until incremental catches up", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const reads = { count: 0 };
  seedPendingIncremental(store, "backlog");
  const sync = new SyncRunner(backlogConnector(reads), store, {
    intervalMs: 1000,
    backlogIntervalMs: 1,
    sweepMs: Number.MAX_SAFE_INTEGER,
    pageSize: 1,
    pagesPerPoll: 2,
  });

  try {
    sync.setAutoSync(true);
    sync.start();
    await waitFor(
      () => store.getState<boolean>("backlog:incremental:caughtUp") === true,
    );
    expect(reads.count).toBe(4);
    expect(store.usage()).toHaveLength(4);
  } finally {
    await sync.stop();
    store.close();
  }
});

test("quota failures are visible but do not block usage, and sampling is throttled", async () => {
  const events: LogEvent[] = [];
  const logger = createDiagnosticsLogger({
    level: "info",
    sink: (event) => events.push(event),
  });
  const store = new LedgerStore(":memory:", defaultPriceBook);
  let quotaReads = 0;
  const connector: UsageConnector = {
    sourceId: "control",
    readAccounts: async () => [],
    readQuotas: async () => {
      quotaReads += 1;
      if (quotaReads === 1)
        throw Object.assign(new Error("private quota details"), {
          code: "ETIMEDOUT",
        });
      return [];
    },
    readUsage: async (cursor) =>
      cursor === null
        ? { records: [fact("1")], nextCursor: "1", hasMore: false }
        : { records: [], nextCursor: cursor, hasMore: false },
    close: async () => {},
  };
  const sync = new SyncRunner(
    connector,
    store,
    { quotaIntervalMs: 30_000, sweepMs: 24 * 60 * 60 * 1000 },
    logger,
  );

  try {
    await sync.poll("2026-09-08T12:00:00.000Z");
    expect(quotaReads).toBe(1);
    expect(sync.status()).toMatchObject({
      error: null,
      quotaError: "source-quota-failed",
      initialComplete: true,
      localRecords: 1,
      lastError: {
        stage: "quotas",
        kind: "timeout",
        code: "ETIMEDOUT",
      },
    });
    const quotaFailure = events.find(
      (event) => event.event === "sync.fail" && event.stage === "quotas",
    );
    expect(quotaFailure).toMatchObject({
      errorId: sync.status().lastError?.id,
      trigger: "manual",
      taskId: expect.any(String),
      error: { kind: "timeout", code: "ETIMEDOUT" },
    });
    expect(JSON.stringify(quotaFailure)).not.toContain("private quota details");

    await sync.poll("2026-09-08T12:00:01.000Z");
    expect(quotaReads).toBe(1);
    await sync.poll("2026-09-08T12:00:31.000Z");
    expect(quotaReads).toBe(2);
    expect(sync.status().quotaError).toBeNull();
    expect(sync.status().lastError).toBeNull();
  } finally {
    await sync.stop();
    store.close();
  }
});

test("manual quota failure does not stop history and remains visible separately", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const connector: UsageConnector = {
    sourceId: "manual-quota",
    readAccounts: async () => [],
    readQuotas: async () => {
      throw Object.assign(new Error("private quota details"), {
        code: "ETIMEDOUT",
      });
    },
    readUsage: async (cursor) =>
      cursor === null
        ? {
            records: [fact("1", "manual-quota")],
            nextCursor: "1",
            hasMore: false,
          }
        : { records: [], nextCursor: cursor, hasMore: false },
    close: async () => {},
  };
  const sync = new SyncRunner(connector, store, {
    quotaIntervalMs: 30_000,
    sweepMs: Number.MAX_SAFE_INTEGER,
  });

  try {
    sync.requestSync();
    await waitFor(() => !sync.status().running);
    expect(sync.status()).toMatchObject({
      error: null,
      quotaError: "source-quota-failed",
      initialComplete: true,
      localRecords: 1,
      lastError: { stage: "quotas", code: "ETIMEDOUT" },
    });
  } finally {
    await sync.stop();
    store.close();
  }
});

test("manual failure stops the task instead of retrying indefinitely", async () => {
  const events: LogEvent[] = [];
  const logger = createDiagnosticsLogger({
    level: "info",
    sink: (event) => events.push(event),
  });
  const store = new LedgerStore(":memory:", defaultPriceBook);
  let usageReads = 0;
  const connector: UsageConnector = {
    sourceId: "control",
    readAccounts: async () => [],
    readUsage: async () => {
      usageReads += 1;
      throw new Error("private source details");
    },
    close: async () => {},
  };
  const sync = new SyncRunner(
    connector,
    store,
    { backlogIntervalMs: 1, pageSize: 1, pagesPerPoll: 1 },
    logger,
  );

  try {
    sync.requestSync();
    await waitFor(() => !sync.status().running);
    const failedReads = usageReads;
    await Bun.sleep(20);
    expect(usageReads).toBe(failedReads);
    expect(sync.status()).toMatchObject({
      error: "source-sync-failed",
      lastError: { stage: "incremental", kind: "unknown" },
    });
    expect(events.filter((event) => event.event === "sync.fail")).toHaveLength(
      1,
    );
  } finally {
    await sync.stop();
    store.close();
  }
});
