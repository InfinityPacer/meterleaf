import { expect, test } from "bun:test";
import { SyncPresence } from "../src/server/sync-presence";
import { readConfig } from "../src/server/config";
import { createApp } from "../src/server/app";
import { SyncRunner } from "../src/server/sync";
import { LedgerStore } from "../src/storage/ledger";
import { defaultPriceBook } from "../src/domain/default-prices";

test("page leases expire independently and hiding one page preserves other viewers", () => {
  const presence = new SyncPresence(45);
  expect(presence.hasVisible(0)).toBe(false);
  presence.update("a", true, 0);
  presence.update("b", true, 10);
  presence.update("a", false, 20);
  expect(presence.hasVisible(45)).toBe(true);
  expect(presence.hasVisible(55)).toBe(false);
  presence.update("a", true, 60);
  presence.update("a", true, 90);
  expect(presence.hasVisible(110)).toBe(true);
  expect(presence.hasVisible(135)).toBe(false);
});

test("sync intervals default to 15/60 seconds and accept bounded overrides", () => {
  const defaults = readConfig({ METERLEAF_DEMO: "true" });
  expect(defaults.METERLEAF_SYNC_VISIBLE_INTERVAL_MS).toBe(15000);
  expect(defaults.METERLEAF_SYNC_HIDDEN_INTERVAL_MS).toBe(60000);
  expect(
    readConfig({
      METERLEAF_DEMO: "true",
      METERLEAF_SYNC_VISIBLE_INTERVAL_MS: "20000",
    }).METERLEAF_SYNC_VISIBLE_INTERVAL_MS,
  ).toBe(20000);
  for (const value of ["0", "-1", "abc", "3600001"]) {
    expect(() =>
      readConfig({
        METERLEAF_DEMO: "true",
        METERLEAF_SYNC_HIDDEN_INTERVAL_MS: value,
      }),
    ).toThrow();
  }
});

test("presence endpoint validates leases and never starts source collection", async () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  let reads = 0;
  const sync = new SyncRunner(
    {
      sourceId: "presence",
      readAccounts: async () => {
        reads += 1;
        return [];
      },
      readUsage: async () => ({
        records: [],
        hasMore: false,
        nextCursor: null,
      }),
      close: async () => {},
    },
    store,
  );
  const app = createApp({
    sync,
    snapshot: () => {
      throw new Error("not used");
    },
  });
  try {
    sync.start();
    for (const visible of [true, false]) {
      const result = await app.inject({
        method: "POST",
        url: "/api/sync/presence",
        payload: { id: "page-a", visible },
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json()).toMatchObject({
        autoEnabled: false,
        running: false,
      });
    }
    for (const payload of [
      {},
      { id: "a", visible: "true" },
      { id: "x".repeat(65), visible: true },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/sync/presence",
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(reads).toBe(0);
  } finally {
    await app.close();
    await sync.stop();
    store.close();
  }
});
