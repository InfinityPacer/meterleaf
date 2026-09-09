import { expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { readConfig } from "../src/server/config";
import { defaultPriceBook } from "../src/domain/default-prices";
import { priceBookSchema, valueUsage } from "../src/domain/pricing";
import type { UsageFact } from "../src/domain/connector";
import type { DateRange } from "../src/shared/date-range";
import type { UsdBasis } from "../src/shared/report";

test("live config is explicit and errors never repeat credentials", () => {
  expect(() => readConfig({})).toThrow("SUB2API_DATABASE_URL is required");
  expect(readConfig({ METERLEAF_DEMO: "true" })).toMatchObject({
    METERLEAF_PORT: 4318,
    METERLEAF_REPORT_REFRESH_INTERVAL_MS: 300_000,
  });
  expect(
    readConfig({
      METERLEAF_DEMO: "true",
      METERLEAF_REPORT_REFRESH_INTERVAL_MS: "30000",
    }).METERLEAF_REPORT_REFRESH_INTERVAL_MS,
  ).toBe(30_000);
  expect(
    readConfig({
      METERLEAF_DEMO: "true",
      METERLEAF_REPORT_REFRESH_INTERVAL_MS: "86400000",
    }).METERLEAF_REPORT_REFRESH_INTERVAL_MS,
  ).toBe(86_400_000);
  expect(() =>
    readConfig({
      METERLEAF_DEMO: "true",
      METERLEAF_REPORT_REFRESH_INTERVAL_MS: "29999",
    }),
  ).toThrow("METERLEAF_REPORT_REFRESH_INTERVAL_MS");
  expect(() =>
    readConfig({
      METERLEAF_DEMO: "true",
      METERLEAF_REPORT_REFRESH_INTERVAL_MS: "86400001",
    }),
  ).toThrow("METERLEAF_REPORT_REFRESH_INTERVAL_MS");
  expect(() =>
    readConfig({ SUB2API_DATABASE_URL: "secret-invalid-url" }),
  ).toThrow("SUB2API_DATABASE_URL");
  try {
    readConfig({ SUB2API_DATABASE_URL: "secret-invalid-url" });
  } catch (error) {
    expect(String(error)).not.toContain("secret-invalid-url");
  }
});
test("ledger route validates range and never falls back to demonstration on failure", async () => {
  let broken = false;
  const app = createApp({
    snapshot: (days) => {
      if (broken) throw new Error("private source details");
      expect(days).toBe(7);
      return {
        mode: "live",
        asOf: "2026-09-08T00:00:00Z",
        records: [],
        accounts: [],
        resets: [],
      };
    },
  });
  try {
    const result = await app.inject("/api/ledger?days=7");
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json<{ mode: string }>().mode).toBe("live");
    expect((await app.inject("/api/ledger?days=365")).statusCode).toBe(400);
    broken = true;
    const failed = await app.inject("/api/ledger?days=7");
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("private");
    expect(failed.body).not.toContain("demo");
  } finally {
    await app.close();
  }
});
test("ledger route validates and forwards custom date ranges", async () => {
  const calls: {
    days: number;
    usdBasis: UsdBasis | undefined;
    dateRange: DateRange | undefined;
  }[] = [];
  const app = createApp({
    snapshot: (days, usdBasis, dateRange) => {
      calls.push({ days, usdBasis, dateRange });
      return {
        mode: "live",
        asOf: "2026-09-08T00:00:00Z",
        records: [],
        accounts: [],
        resets: [],
      };
    },
  });
  try {
    const accepted = await app.inject(
      "/api/ledger?from=2026-02-28&to=2026-03-02&usdBasis=api",
    );
    expect(accepted.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        days: 30,
        usdBasis: "api",
        dateRange: { from: "2026-02-28", to: "2026-03-02" },
      },
    ]);

    for (const path of [
      "/api/ledger?from=2026-02-28",
      "/api/ledger?to=2026-03-02",
      "/api/ledger?days=7&from=2026-02-28&to=2026-03-02",
      "/api/ledger?from=2026-02-30&to=2026-03-02",
      "/api/ledger?from=2026-03-02&to=2026-02-28",
    ]) {
      expect((await app.inject(path)).statusCode).toBe(400);
    }
    expect(calls).toHaveLength(1);
  } finally {
    await app.close();
  }
});
test("Astra subscription long context does not inherit the API 2x rate", () => {
  const book = priceBookSchema.parse(defaultPriceBook);
  const fact: UsageFact = {
    sourceId: "test",
    externalId: "1",
    accountExternalId: "a",
    occurredAt: "2026-09-08T12:00:00Z",
    model: "gpt-6-astra",
    upstreamModel: null,
    tier: "default",
    tokens: {
      input: 300000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: 0,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
  expect(valueUsage(fact, book).credits.amount).toBe("76.25");
  expect(valueUsage(fact, book).usd.amount).toBe("3.05");
  expect(valueUsage(fact, book, "api").usd.amount).toBe("6.075");
  expect(valueUsage(fact, book, "api").credits.amount).toBe("76.25");
  fact.tokens.cacheWrite = 1;
  expect(valueUsage(fact, book).credits.amount).toBeNull();
});
test("Sol uses published promotional rates without an extra uniform 20 percent discount", () => {
  const fact: UsageFact = {
    sourceId: "test",
    externalId: "sol",
    accountExternalId: "a",
    occurredAt: "2026-09-08T12:00:00Z",
    model: "gpt-5.6-sol",
    upstreamModel: null,
    tier: "default",
    tokens: {
      input: 100000,
      cacheRead: 100000,
      cacheWrite: 0,
      output: 100000,
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
  expect(valueUsage(fact, defaultPriceBook).usd.amount).toBe("2.44");
  expect(valueUsage(fact, defaultPriceBook).credits.amount).toBe("61");
});
