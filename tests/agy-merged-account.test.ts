import { expect, test } from "bun:test";
import { defaultPriceBook } from "../src/domain/default-prices";
import { ingestToDomain } from "../src/server/ingest";
import {
  createAccountResolver,
  indexedSnapshot,
  liveSnapshot,
  toLedgerRecord,
} from "../src/server/snapshot";
import type {
  IngestAccount,
  IngestBatch,
  IngestQuota,
  IngestUsage,
} from "../src/shared/ingest";
import { agyAccountsForLabel } from "../src/collector/agy";
import { LedgerStore } from "../src/storage/ledger";
import { ReportIndex } from "../src/storage/report-index";

const now = "2026-10-31T12:00:00.000Z";
const weekReset = "2026-11-05T00:00:00.000Z";

function usage(
  id: string,
  account: string,
  model: string,
  at: string,
): IngestUsage {
  return {
    externalId: id,
    occurredAt: at,
    accountExternalId: account,
    model,
    tier: null,
    tokens: {
      input: 10_000,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    metadata: { origin: "agy_local" },
  };
}

function weekly(
  account: string,
  window: IngestQuota["window"],
  percent: number,
  sampledAt: string,
): IngestQuota {
  return {
    accountExternalId: account,
    window,
    percent,
    sampledAt,
    resetsAt: weekReset,
    windowMinutes: 10080,
  };
}

function batch(
  id: string,
  accounts: IngestAccount[],
  quotas: IngestQuota[],
  records: IngestUsage[],
): IngestBatch {
  return {
    schemaVersion: 1,
    sourceId: "mac",
    batchId: `00000000-0000-4000-8000-00000000000${id}`,
    collector: { name: "meterleaf-collector", version: "test" },
    accounts,
    quotas,
    usage: records,
  };
}

test("an Antigravity account shows both pools on one account and keeps the history recorded under the split accounts", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const index = new ReportIndex(":memory:");
  try {
    const legacyAccount = (pool: "gemini" | "3p"): IngestAccount => ({
      externalId: `agy-alice-${pool}`,
      name: `Antigravity (alice) · ${pool}`,
      platform: "google",
      kind: "subscription",
      plan: "Google AI Ultra",
      subjectKey: null,
    });
    // 旧版采集器：两个池各是一个账户，各自上报 five-hour 与 seven-day。
    store.saveIngestBatch(
      "mac",
      ingestToDomain(
        "mac",
        batch(
          "1",
          [legacyAccount("gemini"), legacyAccount("3p")],
          [
            weekly(
              "agy-alice-gemini",
              "seven-day",
              10,
              "2026-10-30T10:00:00.000Z",
            ),
            weekly("agy-alice-3p", "seven-day", 70, "2026-10-30T10:00:00.000Z"),
          ],
          [
            usage(
              "old-gemini",
              "agy-alice-gemini",
              "gemini-4-argon",
              "2026-10-30T09:00:00.000Z",
            ),
            usage(
              "old-claude",
              "agy-alice-3p",
              "claude-opus-5-5",
              "2026-10-30T09:30:00.000Z",
            ),
          ],
        ),
      ),
      "2026-10-30T10:00:00.000Z",
    );
    // 新版采集器：一个账户，第三方池用 -3p 窗口，旧账户指向它。
    const accounts = agyAccountsForLabel("alice", "Google AI Ultra");
    store.saveIngestBatch(
      "mac",
      ingestToDomain(
        "mac",
        batch(
          "2",
          [accounts.account, ...accounts.legacy],
          [
            weekly("agy-alice", "seven-day", 20, "2026-10-31T11:00:00.000Z"),
            weekly("agy-alice", "seven-day-3p", 40, "2026-10-31T11:00:00.000Z"),
          ],
          [
            usage(
              "new-gemini",
              "agy-alice",
              "gemini-4-argon",
              "2026-10-31T10:00:00.000Z",
            ),
            usage(
              "new-claude",
              "agy-alice",
              "claude-sonnet-5-5",
              "2026-10-31T10:30:00.000Z",
            ),
          ],
        ),
      ),
      "2026-10-31T11:00:00.000Z",
    );

    const resolver = createAccountResolver(
      store.accounts(),
      store.accountMerges(),
    );
    index.replace(store.usage().map((row) => toLedgerRecord(row, resolver)));
    const rows = liveSnapshot(store, null, 7, now);
    const indexed = indexedSnapshot(
      store,
      null,
      now,
      "subscription",
      (id, start, end, basis, scope) =>
        index.sumWindow(id, start, end, basis, scope),
    );

    for (const snapshot of [rows, indexed]) {
      const google = snapshot.accounts.filter((a) => a.platform === "google");
      expect(google.map((a) => a.id)).toEqual(["mac:agy-alice"]);
      const account = google[0]!;
      expect(account.name).toBe("Antigravity (alice)");
      // 最新读数来自合并后的账户，旧的第三方池周读数不冒充 Gemini 池。
      expect(account.sevenDay!.percent).toBe(20);
      expect(account.sevenDayThirdParty!.percent).toBe(40);
      // 每个池的本期花费只计自己的模型，旧账户名下的历史一并计入。
      expect(account.sevenDay!.periodRequests).toBe(2);
      expect(account.sevenDayThirdParty!.periodRequests).toBe(2);
    }
    expect(
      indexed.accounts.find((a) => a.platform === "google")!.sevenDay,
    ).toEqual(rows.accounts.find((a) => a.platform === "google")!.sevenDay);
  } finally {
    index.close();
    store.close();
  }
});
