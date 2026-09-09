import { expect, test } from "bun:test";
import type {
  SourceAccount,
  UsageConnector,
  UsageFact,
} from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import {
  createDiagnosticsLogger,
  summarizeError,
  type LogEvent,
} from "../src/server/diagnostics";
import { SyncRunner } from "../src/server/sync";
import { LedgerStore } from "../src/storage/ledger";

const account: SourceAccount = {
  sourceId: "test",
  externalId: "account-1",
  name: "fixture",
  platform: "test",
  kind: "unknown",
  plan: null,
  parentExternalId: null,
  subjectKey: null,
};

const fact: UsageFact = {
  sourceId: "test",
  externalId: "usage-1",
  occurredAt: "2026-09-08T01:00:00.000Z",
  accountExternalId: "account-1",
  model: "unknown-model",
  upstreamModel: null,
  tier: null,
  tokens: {
    input: null,
    output: null,
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
};

test("diagnostic logger filters levels and summarizes cause-chain SQLSTATE safely", () => {
  const events: LogEvent[] = [];
  const logger = createDiagnosticsLogger({
    level: "warn",
    now: () => "2026-09-08T12:00:00.000Z",
    sink: (event) => events.push(event),
  });
  const sqlError = Object.assign(
    new Error(
      "password=fixture-password postgresql://readonly:fixture-password@db/app SELECT * FROM usage_logs",
    ),
    { code: "42P01" },
  );
  const wrapped = new Error(
    "connector failed for postgresql://readonly:fixture-password@db/app",
    { cause: sqlError },
  );

  logger.info("ignored.info");
  logger.error("sync.fail", { error: wrapped });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    time: "2026-09-08T12:00:00.000Z",
    level: "error",
    event: "sync.fail",
    error: {
      kind: "sql",
      code: "42P01",
      causeDepth: 1,
    },
  });
  const output = JSON.stringify(events[0]);
  expect(output).not.toContain("fixture-password");
  expect(output).not.toContain("SELECT");
  expect(output).not.toContain("stack");
  expect(summarizeError(wrapped)).toEqual({
    name: "Error",
    kind: "sql",
    code: "42P01",
    causeDepth: 1,
  });
});

test("sync logs stage counts and emits recovery without per-record events", async () => {
  const events: LogEvent[] = [];
  const logger = createDiagnosticsLogger({
    level: "info",
    now: () => "2026-09-08T12:00:00.000Z",
    sink: (event) => events.push(event),
  });
  let failAccounts = true;
  const connector: UsageConnector = {
    sourceId: "test",
    readAccounts: async () => {
      if (failAccounts) {
        throw new Error("account source contains fixture-password");
      }
      return [account];
    },
    readQuotas: async () => [],
    readUsage: async (cursor) =>
      cursor === null
        ? { records: [fact], nextCursor: "usage-1", hasMore: false }
        : { records: [], nextCursor: cursor, hasMore: false },
    close: async () => {},
  };
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const sync = new SyncRunner(
    connector,
    store,
    { intervalMs: 30_000, sweepMs: 24 * 60 * 60 * 1000, pageSize: 10, pagesPerPoll: 1 },
    logger,
  );

  try {
    await sync.poll("2026-09-08T12:00:00.000Z");
    const firstFailure = events.find((event) => event.event === "sync.fail");
    expect(firstFailure).toMatchObject({ stage: "accounts" });
    expect(sync.status().lastError).toMatchObject({
      id: firstFailure?.errorId,
      stage: "accounts",
      kind: "unknown",
    });
    failAccounts = false;
    await sync.poll("2026-09-08T12:00:01.000Z");

    const stages = events.filter((event) => event.event === "sync.stage");
    expect(stages.map((event) => event.stage)).toEqual([
      "quotas",
      "accounts",
      "quotas",
      "incremental",
      "sweep",
    ]);
    expect(stages.find((event) => event.stage === "accounts")).toMatchObject({
      count: 1,
      initialComplete: false,
    });
    expect(stages.find((event) => event.stage === "incremental")).toMatchObject({
      count: 1,
      pages: 1,
      records: 1,
      initialComplete: true,
    });
    expect(
      stages.every(
        (event) => typeof event.durationMs === "number" && event.durationMs >= 0,
      ),
    ).toBe(true);

    const failure = firstFailure;
    expect(failure).toMatchObject({
      stage: "accounts",
      trigger: "manual",
      errorId: expect.any(String),
      taskId: expect.any(String),
    });
    expect(sync.status().lastError).toBeNull();
    expect(JSON.stringify(failure)).not.toContain("fixture-password");

    const complete = events.find((event) => event.event === "sync.complete");
    expect(complete).toMatchObject({ initialComplete: true, recovered: true });
    expect(events.find((event) => event.event === "sync.recover")).toMatchObject({
      recovered: true,
      initialComplete: true,
    });
    expect(events.filter((event) => event.event === "sync.record")).toHaveLength(0);
  } finally {
    await sync.stop();
    store.close();
  }
});

test("sync attributes savePage SQLite failures to the usage stage", async () => {
  const events: LogEvent[] = [];
  const logger = createDiagnosticsLogger({
    level: "debug",
    sink: (event) => events.push(event),
  });
  const connector: UsageConnector = {
    sourceId: "test",
    readAccounts: async () => [],
    readQuotas: async () => [],
    readUsage: async () => ({ records: [fact], nextCursor: "usage-1", hasMore: false }),
    close: async () => {},
  };
  const store = new LedgerStore(":memory:", defaultPriceBook);
  store.savePage = () => {
    const sqliteError = Object.assign(new Error("SQLITE constraint at secret SQL"), {
      code: "SQLITE_CONSTRAINT",
    });
    throw new Error("SQLite write failed for fixture-password", { cause: sqliteError });
  };
  const sync = new SyncRunner(connector, store, undefined, logger);

  try {
    await sync.poll("2026-09-08T12:00:00.000Z");
    const failure = events.find((event) => event.event === "sync.fail");
    expect(failure).toMatchObject({
      stage: "incremental",
      error: { kind: "storage", code: "SQLITE_CONSTRAINT" },
    });
    expect(JSON.stringify(failure)).not.toContain("secret SQL");
    expect(JSON.stringify(failure)).not.toContain("fixture-password");
  } finally {
    await sync.stop();
    store.close();
  }
});
