import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp } from "../src/server/app";
import { defaultPriceBook } from "../src/domain/default-prices";
import { LedgerStore } from "../src/storage/ledger";
import {
  QUOTA_SUMMARY_PATH,
  buildQuotaSummary,
  type QuotaSummary,
} from "../src/shared/quota-summary";
import type {
  AccountWindow,
  LedgerAccount,
  LedgerSnapshot,
} from "../src/shared/report";

const key = "mlk_quota-summary-key";
const digest = createHash("sha256").update(key).digest("hex");

function window(overrides: Partial<AccountWindow> = {}): AccountWindow {
  return {
    percent: 40,
    resetsAt: "2026-11-20T00:00:00.000Z",
    sampledAt: "2026-11-17T08:00:00.000Z",
    state: "active",
    periodUsd: "120",
    periodCredits: null,
    ...overrides,
  };
}

function account(overrides: Partial<LedgerAccount>): LedgerAccount {
  return {
    id: "mac:acct",
    name: "Claude Max 20x",
    plan: "max-20x",
    platform: "anthropic",
    kind: "subscription",
    sampledAt: null,
    fiveHour: null,
    sevenDay: null,
    ...overrides,
  };
}

test("summary lists visible subscription accounts with remaining value per window", () => {
  const summary = buildQuotaSummary(
    "2026-11-17T08:01:00.000Z",
    [
      account({
        id: "mac:alice",
        fiveHour: window({
          percent: 12,
          estimate: {
            usd: null,
            credits: null,
            deltaPercent: null,
            reason: "window-unknown",
          },
        }),
        sevenDay: window({
          estimate: {
            usd: "300",
            credits: null,
            deltaPercent: null,
            reason: "eligible",
          },
        }),
      }),
      account({ id: "gateway:key", kind: "api", plan: "api" }),
      account({ id: "mac:archived" }),
      account({ id: "mac:hidden" }),
    ],
    {
      archived: ["mac:archived"],
      hidden: ["mac:hidden"],
      aliases: { "mac:alice": "alice" },
    },
    { "mac:alice": ["mac:alice", "mac:bob"] },
  );
  expect(summary.accounts).toEqual([
    {
      id: "mac:alice",
      name: "alice",
      plan: "max-20x",
      platform: "anthropic",
      members: ["mac:alice", "mac:bob"],
      windows: {
        fiveHour: {
          percent: 12,
          resetsAt: "2026-11-20T00:00:00.000Z",
          sampledAt: "2026-11-17T08:00:00.000Z",
          state: "active",
          remaining: { usd: null, credits: null },
        },
        sevenDay: {
          percent: 40,
          resetsAt: "2026-11-20T00:00:00.000Z",
          sampledAt: "2026-11-17T08:00:00.000Z",
          state: "active",
          remaining: { usd: "180", credits: null },
        },
      },
    },
  ]);
});

test("members follow merges so a collector can find the account it is logged into", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const accounts = ["alice", "bob"].map((externalId) => ({
    externalId,
    name: externalId,
    platform: "google",
    kind: "subscription" as const,
    plan: "Google AI Ultra",
    subjectKey: null,
  }));
  store.saveIngestBatch(
    "mac",
    {
      batchId: "b1",
      collector: { name: "test", version: "0" },
      accounts: accounts.map((item) => ({
        ...item,
        sourceId: "mac",
        parentExternalId: null,
      })),
      usage: [],
      quotas: [],
    },
    "2026-11-17T08:00:00.000Z",
  );
  store.setAccountMerge("mac:bob", "mac:alice");
  expect(store.accountMembers()).toEqual({
    "mac:alice": ["mac:alice", "mac:bob"],
  });
});

function setup(read: () => Promise<QuotaSummary>) {
  return createApp({
    snapshot: () => ({}) as LedgerSnapshot,
    ingest: { keys: [{ sourceId: "mac", sha256: digest }], save() {} },
    quotaSummary: read,
    githubAuth: {
      clientId: "client-id",
      clientSecret: "client-secret-value",
      users: ["someone"],
      publicUrl: "https://meterleaf.example.test",
      sessionDays: 30,
    },
  });
}

test("only a collector key reads the summary, even when GitHub login guards the site", async () => {
  const summary: QuotaSummary = {
    schemaVersion: 1,
    asOf: "2026-11-17T08:01:00.000Z",
    accounts: [],
  };
  const app = setup(async () => summary);
  const get = (token?: string) =>
    app.inject({
      method: "GET",
      url: QUOTA_SUMMARY_PATH,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  expect((await get()).statusCode).toBe(401);
  expect((await get("mlk_wrong")).statusCode).toBe(401);
  const ok = await get(key);
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual(summary);
  // 写入密钥不能借此读取网页报表。
  const view = await app.inject({
    method: "GET",
    url: "/api/view",
    headers: { authorization: `Bearer ${key}` },
  });
  expect(view.statusCode).toBe(401);
});

test("a report still being built answers 202 so the collector keeps its last summary", async () => {
  const app = setup(async () => {
    throw Object.assign(new Error("building"), {
      code: "ERR_REPORT_BUILDING",
      since: "2026-11-17T08:00:00.000Z",
    });
  });
  const response = await app.inject({
    method: "GET",
    url: QUOTA_SUMMARY_PATH,
    headers: { authorization: `Bearer ${key}` },
  });
  expect(response.statusCode).toBe(202);
});

test("summary includes active account credits when reported", () => {
  const credits = {
    hasCredits: true,
    unlimited: false,
    balance: "10859.9461050000",
    sampledAt: "2026-11-26T04:40:11.300Z",
  };
  const summary = buildQuotaSummary(
    "2026-11-26T04:45:00.000Z",
    [
      account({
        id: "mac:codex",
        name: "Codex",
        plan: "prolite",
        platform: "openai",
        credits,
      }),
    ],
    { archived: [], hidden: [], aliases: {} },
    {},
  );
  expect(summary.accounts[0]?.credits).toEqual(credits);
});
