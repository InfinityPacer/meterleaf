import Decimal from "decimal.js";
import type { LedgerRecord, LedgerSnapshot, UsdBasis } from "../../shared/report";
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
      });
    }
  }
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
        kind: "subscription",
        sampledAt: asOf,
        fiveHour: { percent: 28, resetsAt: "2026-09-08T18:40:00+08:00" },
        sevenDay: { percent: 64, resetsAt: "2026-09-11T09:20:00+08:00" },
      },
      {
        id: "studio",
        name: "Studio",
        plan: "Plus",
        kind: "subscription",
        sampledAt: asOf,
        fiveHour: { percent: 12, resetsAt: "2026-09-08T20:10:00+08:00" },
        sevenDay: { percent: 21, resetsAt: "2026-09-14T14:00:00+08:00" },
      },
      {
        id: "api",
        name: "Development",
        plan: "API",
        kind: "api",
        sampledAt: asOf,
        fiveHour: null,
        sevenDay: null,
      },
    ],
    resets: [
      { accountId: "personal", at: "2026-09-04T09:20:00+08:00" },
      { accountId: "studio", at: "2026-09-07T14:00:00+08:00" },
    ],
  };
}
