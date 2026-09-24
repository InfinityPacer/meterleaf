import { describe, expect, test } from "bun:test";
import { createDemoLedger, demoLifetimeTotals } from "../src/web/demo/ledger";

describe("演示账本", () => {
  const snapshot = createDemoLedger("subscription");

  test("订阅账户的额度窗口带周期用量，只有 7d 带预估", () => {
    const personal = snapshot.accounts.find(({ id }) => id === "personal")!;
    const start = Date.parse(personal.sevenDay!.resetsAt!) - 7 * 24 * 3600000;
    const rows = snapshot.records.filter(
      (row) =>
        row.accountId === "personal" && Date.parse(row.occurredAt) >= start,
    );
    expect(personal.sevenDay!.periodRequests).toBe(rows.length);
    expect(personal.sevenDay!.estimate?.reason).toBe("eligible");
    expect(personal.fiveHour!.estimate).toBeUndefined();
    expect(personal.fiveHour!.periodRequests).toBeGreaterThan(0);
  });

  test("账户累计之和等于全历史累计", () => {
    const totals = demoLifetimeTotals(snapshot);
    const count = snapshot.accounts.reduce(
      (sum, account) => sum + (account.lifetime?.count ?? 0),
      0,
    );
    const tokens = snapshot.accounts.reduce(
      (sum, account) => sum + (account.lifetime?.tokens ?? 0),
      0,
    );
    expect(count).toBe(snapshot.records.length);
    expect(totals.count).toBe(snapshot.records.length);
    expect(tokens).toBe(totals.tokens.total!);
    expect(
      totals.tokens.input! +
        totals.tokens.cacheRead! +
        totals.tokens.cacheWrite! +
        totals.tokens.output!,
    ).toBe(totals.tokens.total!);
  });
});
