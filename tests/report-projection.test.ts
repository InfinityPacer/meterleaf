import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "../src/storage/ledger";
import { ReportProjection } from "../src/server/report-projection";
import { defaultPriceBook } from "../src/domain/default-prices";
import { createDemoLedger } from "../src/web/demo/ledger";
import type { UsageFact } from "../src/domain/connector";
import type { ViewQuery } from "../src/shared/ledger-view";

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
const meta = { ...createDemoLedger(), asOf: "2026-09-08T12:00:00.000Z" };
function fact(id: string, input = 10): UsageFact {
  return {
    sourceId: "test",
    externalId: id,
    accountExternalId: "child",
    occurredAt: "2026-09-08T11:00:00.000Z",
    model: "gpt-6-astra",
    upstreamModel: null,
    tier: "standard",
    tokens: {
      input,
      cacheRead: 0,
      cacheWrite: 0,
      output: 5,
      reasoning: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-projection-"));
  const path = join(dir, "ledger.sqlite");
  const cache = join(dir, "reports.sqlite");
  const store = new LedgerStore(path, defaultPriceBook);
  const save = (rows: UsageFact[]) =>
    store.savePage(
      "test",
      "incremental",
      {
        records: rows,
        nextCursor: "fixture",
        hasMore: false,
      },
      meta.asOf,
    );
  return { dir, path, cache, store, save };
}

test("projection reopens without scanning facts and incrementally applies corrections and deletions", () => {
  const { dir, path, cache, store, save } = setup();
  let projection = new ReportProjection(store, path, cache);
  try {
    save([fact("1"), fact("2")]);
    expect(projection.ensure()).toBe(true);
    expect(projection.index.read(meta, query).view.count).toBe(2);
    projection.close();
    projection = new ReportProjection(store, path, cache);
    const scan = spyOn(store, "reportUsages").mockImplementation(() => {
      throw new Error("Unexpected full scan");
    });
    expect(projection.ensure()).toBe(false);
    save([fact("1", 77)]);
    expect(projection.ensure()).toBe(true);
    expect(
      projection.index
        .read(meta, query)
        .records.find((row) => row.id === "test:1")?.input,
    ).toBe(77);
    store.db.query("DELETE FROM valuations WHERE external_id='2'").run();
    store.db.query("DELETE FROM usage_facts WHERE external_id='2'").run();
    // 同连接直接SQL不改变PRAGMA data_version，显式revision代表后台事实修订提交。
    store.setState("ledger:dataRevision", store.revision() + 1);
    expect(projection.ensure()).toBe(true);
    expect(projection.index.read(meta, query).view.count).toBe(1);
    expect(projection.ensure()).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  } finally {
    projection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projection rolls back data and checkpoint together then retries the same delta", () => {
  const { dir, path, cache, store, save } = setup();
  const projection = new ReportProjection(store, path, cache);
  try {
    save([fact("1")]);
    projection.ensure();
    const before = projection.index.read(meta, query).view;
    save([fact("2")]);
    const apply = projection.index.applyChanges.bind(projection.index);
    const injected = spyOn(projection.index, "applyChanges").mockImplementation(
      (changes) => {
        apply(changes);
        throw new Error("fixture failure after index writes");
      },
    );
    expect(() => projection.ensure()).toThrow("fixture failure");
    expect(projection.index.read(meta, query).view).toEqual(before);
    injected.mockRestore();
    expect(projection.ensure()).toBe(true);
    expect(projection.index.read(meta, query).view.count).toBe(2);
  } finally {
    projection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed change stream rolls back partial records and can replay the same checkpoint", () => {
  const { dir, path, cache, store, save } = setup();
  const projection = new ReportProjection(store, path, cache);
  try {
    save([fact("1")]);
    projection.ensure();
    const before = projection.index.read(meta, query);
    save([{ ...fact("1", 77), metadata: { duration_ms: 123 } }, fact("2")]);
    const materialized = spyOn(store, "storedUsageChanges").mockImplementation(
      () => {
        throw new Error("array path forbidden");
      },
    );
    const stream = store.storedUsageChangeStream.bind(store);
    const failed = spyOn(store, "storedUsageChangeStream").mockImplementation(
      (sequence) => {
        const delta = stream(sequence);
        return {
          ...delta,
          changes: (function* () {
            for (const change of delta.changes) {
              yield change;
              throw new Error("interrupted stream");
            }
          })(),
        };
      },
    );
    expect(() => projection.ensure()).toThrow("interrupted stream");
    expect(projection.index.read(meta, query)).toEqual(before);
    failed.mockRestore();
    expect(projection.ensure()).toBe(true);
    expect(projection.index.read(meta, query).view.count).toBe(2);
    expect(
      projection.index
        .read(meta, query)
        .records.find((row) => row.id === "test:1")?.input,
    ).toBe(77);
    expect(
      projection.index
        .read(meta, query)
        .records.find((row) => row.id === "test:1")?.details?.durationMs,
    ).toBe(123);
    expect(projection.ensure()).toBe(false);
    expect(materialized).not.toHaveBeenCalled();
    materialized.mockRestore();
  } finally {
    projection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account parent changes rebuild projected ownership without losing historical requests", () => {
  const { dir, path, cache, store, save } = setup();
  const projection = new ReportProjection(store, path, cache);
  try {
    save([fact("1")]);
    projection.ensure();
    expect(projection.index.read(meta, query).records[0]?.accountId).toBe(
      "test:child",
    );
    store.saveAccountsSnapshot("test", [
      {
        sourceId: "test",
        externalId: "parent",
        name: "parent",
        platform: "openai",
        kind: "subscription",
        plan: "pro",
        parentExternalId: null,
        subjectKey: null,
      },
      {
        sourceId: "test",
        externalId: "child",
        name: "child",
        platform: "openai",
        kind: "subscription",
        plan: "pro",
        parentExternalId: "parent",
        subjectKey: null,
      },
    ]);
    expect(projection.ensure()).toBe(true);
    expect(projection.index.read(meta, query).records[0]?.accountId).toBe(
      "test:parent",
    );
    store.saveAccountsSnapshot("test", [
      {
        sourceId: "test",
        externalId: "child",
        name: "child",
        platform: "openai",
        kind: "subscription",
        plan: "pro",
        parentExternalId: "parent",
        subjectKey: null,
      },
    ]);
    expect(projection.ensure()).toBe(true);
    expect(projection.index.read(meta, query).records[0]).toMatchObject({
      id: "test:1",
      accountId: "test:child",
    });
    expect(store.usage()).toHaveLength(1);
  } finally {
    projection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema revision preserves compatible rows and rebuilds an outdated checkpoint", () => {
  const { dir, path, cache, store, save } = setup();
  let projection = new ReportProjection(store, path, cache);
  try {
    save([fact("1")]);
    projection.ensure();
    projection.close();
    projection = new ReportProjection(store, path, cache);
    expect(projection.ensure()).toBe(false);
    projection.index.db.exec("PRAGMA user_version=0");
    projection.close();
    projection = new ReportProjection(store, path, cache);
    expect(projection.ensure()).toBe(false);
    // 结构兼容不代表检查点有效，旧检查点必须触发投影重建。
    projection.index.db.exec(
      "UPDATE projection_checkpoint SET payload=json_set(payload,'$.schemaRevision','000000000000')",
    );
    projection.close();
    projection = new ReportProjection(store, path, cache);
    expect(projection.index.read(meta, query).view.count).toBe(1);
    expect(projection.ensure()).toBe(true);
    expect(projection.index.read(meta, query).view.count).toBe(1);
  } finally {
    projection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
