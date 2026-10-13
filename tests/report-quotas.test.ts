import { expect, test } from "bun:test";
import type { QuotaFact } from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { quotaView, type QuotaChargeReader } from "../src/domain/quota";
import { quotaPlanHistoryKey } from "../src/domain/quota-plan";
import { LedgerStore } from "../src/storage/ledger";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const reset = Date.parse("2026-10-18T08:00:00.000Z");
const now = new Date(reset - 6 * 24 * HOUR).toISOString();
const iso = (time: number) => new Date(time).toISOString();

function reading(
  accountExternalId: string,
  sampledAt: string | null,
  resetsAt: string,
  percent: number,
  window: QuotaFact["window"] = "seven-day",
): QuotaFact {
  return {
    sourceId: "source",
    externalId: `${accountExternalId}:${window}:${sampledAt}`,
    accountExternalId,
    window,
    percent,
    sampledAt,
    resetsAt,
    windowMinutes: window === "five-hour" ? 300 : 10080,
  };
}

/** 费用与窗口长度成正比，模型范围不同则单价不同，两条路径得到同一组金额。 */
const reader: QuotaChargeReader = (start, end, scope) => {
  const minutes = (Date.parse(end) - Date.parse(start)) / 60_000;
  return {
    usd: (minutes * (scope ? 0.01 : 0.03)).toFixed(4),
    credits: (minutes * 0.5).toFixed(2),
  };
};

test("report quota reads keep the cycles quota views use and match full history", () => {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    store.setState(quotaPlanHistoryKey("source", "active"), [
      { plan: "max", observedAt: iso(reset - 6 * WEEK), changed: false },
    ]);
    // 五个周期每 6 小时一条读数，当前周期刚开始一天，估值需要借用上一周期。
    for (let cycle = 4; cycle >= 0; cycle--) {
      const cycleReset = reset - cycle * WEEK;
      const end = Math.min(cycleReset, Date.parse(now));
      for (let at = cycleReset - WEEK + HOUR; at < end; at += 6 * HOUR) {
        const percent = Math.floor(((at - cycleReset + WEEK) / WEEK) * 80);
        store.saveQuotas(
          [reading("active", iso(at), iso(cycleReset), percent)],
          iso(at + 60_000),
        );
      }
    }
    // 没有采样时间的读数按采集时间排序，始终保留。
    store.saveQuotas(
      [reading("active", null, iso(reset), 1)],
      iso(reset - 5 * WEEK),
    );
    // 已到期的窗口只需最新读数。
    for (const hours of [30, 20, 10])
      store.saveQuotas(
        [
          reading(
            "idle",
            iso(reset - 2 * WEEK - hours * HOUR),
            iso(reset - 2 * WEEK - hours * HOUR + 2 * HOUR),
            hours,
            "five-hour",
          ),
        ],
        iso(reset - 2 * WEEK),
      );
    // 带时区偏移的采样时间不能按文本比较，整个窗口保留全部历史。
    store.saveQuotas(
      [
        reading("offset", iso(reset - 5 * WEEK), iso(reset), 5),
        reading("offset", "2026-10-12T10:00:00+08:00", iso(reset), 6),
      ],
      iso(reset - WEEK),
    );

    const full = store.quotas();
    const reported = store.reportQuotas(now);
    const cutoff = reset - 3 * WEEK - HOUR;
    const expected = full.filter(({ fact }) => {
      if (fact.accountExternalId === "offset") return true;
      if (fact.accountExternalId === "idle")
        return fact.sampledAt === iso(reset - 2 * WEEK - 10 * HOUR);
      return fact.sampledAt === null || Date.parse(fact.sampledAt) >= cutoff;
    });
    expect(reported.length).toBeLessThan(full.length);
    expect(reported).toEqual(expected);

    for (const account of ["active", "idle", "offset"]) {
      const view = (rows: typeof full) =>
        ["five-hour", "seven-day"].map((window) =>
          quotaView(
            rows.filter(
              ({ fact }) =>
                fact.accountExternalId === account && fact.window === window,
            ),
            reader,
            now,
          ),
        );
      expect(view(reported)).toEqual(view(full));
    }
    const active = quotaView(
      reported.filter(
        ({ fact }) =>
          fact.accountExternalId === "active" && fact.window === "seven-day",
      ),
      reader,
      now,
    )!;
    expect(["blended", "previous-period"]).toContain(
      active.estimate.methods!.usd!,
    );
  } finally {
    store.close();
  }
});
