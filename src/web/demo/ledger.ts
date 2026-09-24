import Decimal from "decimal.js";
import type {
  AccountLifetime,
  AccountWindow,
  LedgerRecord,
  LedgerSnapshot,
  UsdBasis,
} from "../../shared/report";
import type { LifetimeTotals } from "../../shared/ledger-view";
import type { Charge, Valuation } from "../../domain/pricing";

export const modelNames = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

/** 可复现的虚构数据，仅用于交互原型；不得用作实时数据回退或计费费率源。 */
export function createDemoLedger(usdBasis: UsdBasis = "subscription"): LedgerSnapshot {
  const asOf = "2026-09-08T16:00:00+08:00";
  const end = new Date(asOf).getTime();
  const records: LedgerRecord[] = [];
  const rates = [10, 4, 2, 0.2];
  const efforts = ["medium", "high", "low", "xhigh", "high"];
  for (let h = 0; h < 24 * 60; h++) {
    const hour = (16 - (h % 24) + 24) % 24;
    const count = hour >= 8 && hour <= 22 ? 5 + (h % 7) : 1;
    for (let j = 0; j < count; j++) {
      const m = (h * 7 + j * 3) % 11;
      const modelIndex = m < 5 ? 0 : m < 8 ? 1 : m < 10 ? 2 : 3;
      const longContext = h === 0 && j === 0;
      const input = longContext
        ? 80_000
        : 200 + ((h * 193 + j * 827) % 8400);
      const cacheRead = longContext
        ? 300_000
        : 1700 + ((h * 1037 + j * 5197) % 65000);
      const cacheWrite = (h + j) % 7 === 0 ? 1200 : 0;
      const output = 130 + ((h * 73 + j * 199) % 1700);
      const rate = rates[modelIndex]!;
      const weighted = new Decimal(input)
        .add(new Decimal(cacheRead).mul(0.1))
        .add(new Decimal(output).mul(5));
      const subscriptionUsd = weighted.mul(rate).div(1e6).toFixed(6);
      const apiUsd = weighted
        .mul(longContext ? 2 : 1)
        .mul(rate)
        .div(1e6)
        .toFixed(6);
      const credits = weighted.mul(rate).mul(25).div(1e6).toFixed(6);
      const charge = (value: string, reason: string): Charge => ({
        amount: value,
        basis: "estimated",
        reason,
        assumedStandard: true,
      });
      const valuation: Valuation = {
        version: "demo-2026-09",
        usdBasis,
        usd: charge(
          usdBasis === "api" ? apiUsd : subscriptionUsd,
          longContext ? "demo-long-context-rule" : "demo-rate",
        ),
        apiUsd: charge(
          apiUsd,
          longContext ? "demo-long-context-rule" : "demo-rate",
        ),
        subscriptionUsd: charge(subscriptionUsd, "demo-rate"),
        credits: charge(credits, "demo-rate"),
      };
      records.push({
        id: `demo-${String(h * 20 + j + 1).padStart(6, "0")}`,
        occurredAt: new Date(end - h * 3600000 - j * 457000).toISOString(),
        accountId:
          (h + j) % 13 === 0
            ? "api"
            : (h + j) % 4 === 0
              ? "studio"
              : "personal",
        model: modelNames[modelIndex]!,
        input,
        cacheRead,
        cacheWrite,
        output,
        usd: valuation.usd.amount,
        credits: valuation.credits.amount,
        tier: "unknown",
        quality: "estimated",
        priceVersion: "demo-2026-09",
        valuation,
        details: {
          requestedModel: modelNames[modelIndex]!,
          sentModel: modelNames[modelIndex]!,
          responseModel: modelNames[modelIndex]!,
          responseModelMismatch: false,
          requestedReasoningEffort: efforts[(h + j) % efforts.length]!,
          reasoningEffort: efforts[(h + j) % efforts.length]!,
          durationMs: 1800 + ((h * 311 + j * 97) % 24000),
          firstTokenMs: 350 + ((h * 53 + j * 29) % 1800),
        },
      });
    }
  }
  const lifetime = (accountId?: string): AccountLifetime =>
    usage(records.filter((row) => !accountId || row.accountId === accountId));
  // 演示额度沿用服务端口径，周期用量从窗口起点累计到采样时刻，7d 预估按用量占百分比外推。
  const window = (
    accountId: string,
    percent: number,
    resetsAt: string,
    hours: number,
  ): AccountWindow => {
    const start = Date.parse(resetsAt) - hours * 3600000;
    const period = usage(
      records.filter(
        (row) =>
          row.accountId === accountId && Date.parse(row.occurredAt) >= start,
      ),
    );
    const credits = records
      .filter(
        (row) =>
          row.accountId === accountId && Date.parse(row.occurredAt) >= start,
      )
      .reduce((sum, row) => sum.add(row.credits ?? 0), new Decimal(0));
    const project = (value: Decimal.Value) =>
      new Decimal(value).mul(100).div(percent).toFixed(6);
    return {
      percent,
      resetsAt,
      sampledAt: asOf,
      state: "active",
      periodUsd: period.usd,
      periodCredits: credits.toFixed(6),
      periodRequests: period.count,
      periodTokens: period.tokens,
      ...(hours === 168
        ? {
            estimate: {
              usd: project(period.usd ?? 0),
              credits: project(credits),
              deltaPercent: null,
              reason: "eligible" as const,
            },
          }
        : {}),
    };
  };
  return {
    mode: "demo",
    usdBasis,
    asOf,
    records,
    accounts: [
      {
        id: "personal",
        name: "Personal",
        plan: "Pro",
        platform: "openai",
        kind: "subscription",
        sampledAt: asOf,
        fiveHour: window("personal", 28, "2026-09-08T18:40:00+08:00", 5),
        sevenDay: window("personal", 64, "2026-09-11T09:20:00+08:00", 168),
        lifetime: lifetime("personal"),
      },
      {
        id: "studio",
        name: "Studio",
        plan: "Plus",
        platform: "openai",
        kind: "subscription",
        sampledAt: asOf,
        fiveHour: window("studio", 12, "2026-09-08T20:10:00+08:00", 5),
        sevenDay: window("studio", 21, "2026-09-14T14:00:00+08:00", 168),
        lifetime: lifetime("studio"),
      },
      {
        id: "api",
        name: "Development",
        plan: "API",
        kind: "api",
        sampledAt: asOf,
        fiveHour: null,
        sevenDay: null,
        lifetime: lifetime("api"),
      },
    ],
    resets: [
      { accountId: "personal", at: "2026-09-04T09:20:00+08:00" },
      { accountId: "studio", at: "2026-09-07T14:00:00+08:00" },
    ],
  };
}

function tokens(row: LedgerRecord) {
  return (
    (row.input ?? 0) +
    (row.cacheRead ?? 0) +
    (row.cacheWrite ?? 0) +
    (row.output ?? 0)
  );
}

function usage(rows: LedgerRecord[]): AccountLifetime {
  return {
    count: rows.length,
    tokens: rows.reduce((sum, row) => sum + tokens(row), 0),
    usd: rows
      .reduce((sum, row) => sum.add(row.usd ?? 0), new Decimal(0))
      .toFixed(6),
    incompleteTokens: 0,
    incompleteUsd: 0,
  };
}

/** 演示账本的全历史累计，对应服务端累计索引给出的汇总。 */
export function demoLifetimeTotals(snapshot: LedgerSnapshot): LifetimeTotals {
  const rows = snapshot.records;
  const sum = (pick: (row: LedgerRecord) => Decimal.Value | null | undefined) =>
    rows
      .reduce((total, row) => total.add(pick(row) ?? 0), new Decimal(0))
      .toFixed(6);
  const bucket = (key: "input" | "cacheRead" | "cacheWrite" | "output") =>
    rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const times = rows.map((row) => Date.parse(row.occurredAt));
  return {
    asOf: snapshot.asOf,
    from: new Date(Math.min(...times)).toISOString(),
    to: new Date(Math.max(...times)).toISOString(),
    count: rows.length,
    tokens: {
      input: bucket("input"),
      cacheRead: bucket("cacheRead"),
      cacheWrite: bucket("cacheWrite"),
      output: bucket("output"),
      total: rows.reduce((total, row) => total + tokens(row), 0),
      incomplete: 0,
    },
    usd: sum((row) => row.usd),
    apiUsd: sum((row) => row.valuation?.apiUsd.amount),
    subscriptionUsd: sum((row) => row.valuation?.subscriptionUsd.amount),
    credits: sum((row) => row.credits),
    incomplete: { usd: 0, apiUsd: 0, subscriptionUsd: 0, credits: 0 },
    usdBasis: snapshot.usdBasis ?? "subscription",
    priceVersion: "demo-2026-09",
  };
}
