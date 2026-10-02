import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SourceAccount,
  UsageFact,
  QuotaFact,
} from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { LedgerStore } from "../src/storage/ledger";
import { liveSnapshot, indexedSnapshot } from "../src/server/snapshot";
import { ReportProjection } from "../src/server/report-projection";
import { createApp } from "../src/server/app";
import { ViewService, ReportBuildingError } from "../src/server/view-service";
import type { ViewQuery } from "../src/shared/ledger-view";

const now = new Date().toISOString();
const query: ViewQuery = {
  filter: { days: 7, model: "all", account: "all", search: "" },
  unit: "usd",
  granularity: "day",
  dimension: "account",
  page: 0,
  pageSize: 12,
  sort: "occurredAt",
  desc: true,
};
function account(
  sourceId: string,
  externalId = "a",
  parentExternalId: string | null = null,
): SourceAccount {
  return {
    sourceId,
    externalId,
    parentExternalId,
    name: `${sourceId} account`,
    platform: "openai",
    kind: "subscription",
    plan: "pro",
    subjectKey: null,
  };
}
function usage(
  sourceId: string,
  externalId = "same-request",
  accountExternalId = "a",
): UsageFact {
  return {
    sourceId,
    externalId,
    accountExternalId,
    occurredAt: now,
    model: "gpt-6-astra",
    upstreamModel: null,
    tier: "standard",
    tokens: {
      input: 100,
      output: 20,
      cacheRead: 10,
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
function quota(
  sourceId: string,
  percent: number | null,
  sampledAt = now,
): QuotaFact {
  return {
    sourceId,
    externalId: "weekly",
    accountExternalId: "a",
    window: "seven-day",
    percent,
    sampledAt,
    resetsAt: new Date(Date.parse(now) + 86400000).toISOString(),
    windowMinutes: 10080,
  };
}
function seed(store: LedgerStore) {
  for (const sourceId of ["local", "gateway", "third"]) {
    store.saveAccounts([account(sourceId)]);
    store.savePage(
      sourceId,
      "incremental",
      { records: [usage(sourceId)], nextCursor: "cursor", hasMore: false },
      now,
    );
  }
  store.saveQuotas(
    [
      quota("local", 75),
      quota("gateway", 20, new Date(Date.parse(now) - 60000).toISOString()),
    ],
    now,
  );
}

test("merge preserves facts, source identities, newest quotas and undo across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-merge-"));
  const path = join(dir, "ledger.sqlite");
  let store = new LedgerStore(path, defaultPriceBook);
  try {
    seed(store);
    const before = liveSnapshot(store, null, 7, now);
    store.setAccountMerge("local:a", "gateway:a");
    const revision = store.revision();
    store.setAccountMerge("local:a", "gateway:a");
    expect(store.revision()).toBe(revision);
    const merged = liveSnapshot(store, null, 7, now);
    expect(merged.accounts.map((a) => a.id).sort()).toEqual([
      "gateway:a",
      "third:a",
    ]);
    expect(
      merged.accounts.find((a) => a.id === "gateway:a")?.sevenDay?.percent,
    ).toBe(75);
    expect(
      merged.accounts.find((a) => a.id === "gateway:a")?.sevenDay
        ?.periodRequests,
    ).toBe(2);
    expect(
      merged.records
        .filter((r) => r.accountId === "gateway:a")
        .map((r) => r.sourceId)
        .sort(),
    ).toEqual(["gateway", "local"]);
    expect(merged.records.length).toBe(before.records.length);
    store.close();
    store = new LedgerStore(path, defaultPriceBook);
    expect(store.accountMerges()).toEqual({ "local:a": "gateway:a" });
    store.saveAccounts([account("local")]);
    store.savePage(
      "local",
      "incremental",
      { records: [usage("local", "new")], nextCursor: "new", hasMore: false },
      now,
    );
    expect(
      liveSnapshot(store, null, 7, now).records.filter(
        (r) => r.accountId === "gateway:a",
      ),
    ).toHaveLength(3);
    store.setAccountMerge("local:a", null);
    expect(liveSnapshot(store, null, 7, now).accounts).toHaveLength(3);
    expect(store.getState<string>("local:incremental:cursor")).toBe("new");
    expect(store.quotas()).toHaveLength(2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation rejects missing, self, merged targets and cycles; chain undo restores subgroup", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    seed(store);
    expect(() => store.setAccountMerge("local:a", "local:a")).toThrow();
    expect(() => store.setAccountMerge("missing:a", "gateway:a")).toThrow();
    expect(() => store.setAccountMerge("local:a", "missing:a")).toThrow();
    store.setAccountMerge("local:a", "gateway:a");
    expect(() => store.setAccountMerge("gateway:a", "local:a")).toThrow();
    store.setAccountMerge("gateway:a", "third:a");
    expect(
      store
        .accountMergeState()
        .links.every((link) => link.rootId === "third:a"),
    ).toBe(true);
    expect(() => store.setAccountMerge("third:a", "local:a")).toThrow();
    store.setAccountMerge("gateway:a", null);
    expect(store.accountMergeState().links).toEqual([
      { id: "local:a", targetId: "gateway:a", rootId: "gateway:a" },
    ]);
  } finally {
    store.close();
  }
});

test("projection rebuilds on merge and undo, with parent usage, unknown and expired quotas", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-merge-index-"));
  const path = join(dir, "ledger.sqlite");
  const store = new LedgerStore(path, defaultPriceBook);
  const projection = new ReportProjection(store, path, ":memory:");
  try {
    seed(store);
    store.saveAccounts([account("local"), account("local", "child", "a")]);
    store.savePage(
      "local",
      "incremental",
      {
        records: [usage("local", "child-request", "child")],
        nextCursor: "child",
        hasMore: false,
      },
      now,
    );
    projection.ensure();
    store.setAccountMerge("local:a", "gateway:a");
    expect(projection.accountsCurrent()).toBe(false);
    projection.ensure();
    expect(projection.accountsCurrent()).toBe(true);
    const meta = indexedSnapshot(
      store,
      null,
      now,
      "subscription",
      (id, from, to, basis, scope) =>
        projection.index.sumWindow(id, from, to, basis, scope),
      projection.accountIds(),
    );
    const view = projection.index.read(meta, {
      ...query,
      filter: { ...query.filter, account: "gateway:a" },
    });
    expect(view.view.count).toBe(3);
    expect(view.records.every((r) => r.accountId === "gateway:a")).toBe(true);
    expect(
      meta.accounts.find((a) => a.id === "gateway:a")?.sevenDay?.periodRequests,
    ).toBe(3);
    store.saveQuotas(
      [quota("gateway", null, new Date(Date.parse(now) + 1000).toISOString())],
      now,
    );
    expect(
      liveSnapshot(store, null, 7, now).accounts.find(
        (a) => a.id === "gateway:a",
      )?.sevenDay?.percent,
    ).toBeNull();
    const later = new Date(Date.parse(now) + 2 * 86400000).toISOString();
    expect(
      liveSnapshot(store, null, 7, later).accounts.find(
        (a) => a.id === "gateway:a",
      )?.sevenDay?.state,
    ).toBe("expired");
    store.setAccountMerge("local:a", null);
    projection.ensure();
    const restored = liveSnapshot(store, null, 7, now);
    expect(
      projection.index.read(restored, {
        ...query,
        filter: { ...query.filter, account: "local:a" },
      }).view.count,
    ).toBe(2);
  } finally {
    projection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge API validates requests and supports reversible writes", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  seed(store);
  const app = createApp({
    snapshot: () => liveSnapshot(store, null, 7, now),
    accountMerge: {
      read: () => store.accountMergeState(),
      write: (id, target) => store.setAccountMerge(id, target),
    },
  });
  try {
    for (const payload of [
      { id: "local:a", targetId: "local:a" },
      { id: "missing", targetId: "gateway:a" },
      { id: "local:a" },
      { id: "local:a", targetId: "gateway:a", extra: true },
    ])
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/accounts/merge",
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/accounts/merge",
          payload: { id: "local:a", targetId: "gateway:a" },
        })
      ).json().links,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/accounts/merge",
          payload: { id: "local:a", targetId: null },
        })
      ).json().links,
    ).toEqual([]);
  } finally {
    await app.close();
    store.close();
  }
});

test("cached and background reports never mix old usage grouping with merged quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-merge-view-"));
  const path = join(dir, "ledger.sqlite");
  const store = new LedgerStore(path, defaultPriceBook);
  seed(store);
  const options = {
    inlineRebuildLimit: 0,
    accountMappingVersion: () => String(store.accountMergeVersion()),
  };
  let service = new ViewService(path, defaultPriceBook, options);
  const read = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        return await service.read(query, "subscription");
      } catch (error) {
        if (!(error instanceof ReportBuildingError)) throw error;
        await Bun.sleep(20);
      }
    }
    throw new Error("report rebuild timed out");
  };
  try {
    expect((await read()).accounts).toHaveLength(3);
    store.setAccountMerge("local:a", "gateway:a");
    const merged = await read();
    expect(merged.accounts).toHaveLength(2);
    expect(
      merged.records.filter((r) => r.accountId === "gateway:a"),
    ).toHaveLength(2);
    await service.close();
    store.setAccountMerge("local:a", null);
    service = new ViewService(path, defaultPriceBook, options);
    expect((await read()).accounts).toHaveLength(3);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
