import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateOutdatedLedgerQueries } from "../src/web/components/SyncControl";

test("a ledger revision only refetches reports not computed at that revision", async () => {
  const client = new QueryClient();
  const current = ["ledger", { page: "overview" }];
  const older = ["ledger", "account-trend", "src:a"];
  const unversioned = ["ledger", "account-trend", "src:b"];
  const other = ["sync-status"];
  client.setQueryData(current, { ledgerRevision: 7 });
  client.setQueryData(older, { ledgerRevision: 6 });
  client.setQueryData(unversioned, {});
  client.setQueryData(other, { ledger: { revision: 6 } });
  await invalidateOutdatedLedgerQueries(client, 7);
  const invalidated = (key: unknown[]) =>
    client.getQueryState(key)?.isInvalidated;
  // 首屏结果已包含当前版本时不再重读；旧版本、旧缓存或演示数据仍要重读。
  expect(invalidated(current)).toBe(false);
  expect(invalidated(older)).toBe(true);
  expect(invalidated(unversioned)).toBe(true);
  expect(invalidated(other)).toBe(false);
  client.clear();
});
