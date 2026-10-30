import { expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  quotaView,
  type CollectedQuota,
  type QuotaChargeReader,
} from "../src/domain/quota";

const iso = (day: number, hour = 0) =>
  new Date(Date.UTC(2026, 8, day, hour)).toISOString();
const now = iso(8, 4);

function sample(
  window: "seven-day" | "monthly",
  percent: number | null,
  resetsAt = window === "seven-day" ? iso(15) : iso(31),
): CollectedQuota {
  return {
    fact: {
      sourceId: "test",
      externalId: `${window}-${percent}-${resetsAt}`,
      accountExternalId: "opencode-go",
      window,
      percent,
      sampledAt: now,
      resetsAt,
      windowMinutes: window === "seven-day" ? 10080 : 43200,
    },
    collectedAt: now,
  };
}

/**
 * 按模型汇总本周期费用；金额为 null 表示该模型缺价，与索引一致，缺价请求
 * 计入次数但不计入金额。scope 为空时返回账户全部模型。
 */
const spends =
  (byModel: Record<string, string | null>): QuotaChargeReader =>
  (_start, _end, scope) => {
    const rows = Object.entries(byModel).filter(
      ([model]) => !scope || scope(model),
    );
    const priced = rows.filter(([, usd]) => usd !== null);
    return {
      usd: priced.length
        ? priced
            .reduce((total, [, usd]) => total.add(usd!), new Decimal(0))
            .toString()
        : rows.length
          ? null
          : "0",
      credits: null,
      count: rows.length,
    };
  };

/**
 * Go 额度与其他账户同一处理：同一周期会更换或混用模型，上游百分比是唯一可靠依据。
 * 七天窗口按已花费用外推整窗价值，不再按任何单一模型的公布上限反推。
 */
test("go weekly estimate extrapolates the percent across mixed models", () => {
  const history = [sample("seven-day", 1)];
  const result = quotaView(
    history,
    spends({ "deepseek-v4.1-flash": "0.44", "glm-5.3-flash": "0.01" }),
    now,
  )!;
  expect(result.estimate.usd).toBe("45");
  expect(result.estimate.methods?.usd).toBe("rough");
  expect(result.estimate.reason).toBe("eligible");
  expect(result.estimate.credits).toBeNull();
});

test("monthly estimate is the percent extrapolation of the observed spend", () => {
  const result = quotaView(
    [sample("monthly", 1)],
    spends({ "deepseek-v4.1-flash": "0.8" }),
    now,
  )!;
  expect(result.estimate.usd).toBe("80");
});

test("an unpriced model stays counted and the estimate keeps the extrapolation", () => {
  const history = [sample("seven-day", 2)];
  const reader = spends({
    "deepseek-v4.1-flash": "0.66",
    "gemini-4-argon": null,
  });
  const result = quotaView(history, reader, now)!;
  expect(result.estimate.usd).not.toBeNull();
  expect(result.estimate.methods?.usd).toBe("rough");
});

test("a window without requests does not guess what will be used", () => {
  const history = [sample("seven-day", 0)];
  const result = quotaView(history, spends({}), now)!;
  expect(result.estimate.usd).toBeNull();
  expect(result.estimate.methods?.usd).toBeNull();
  expect(result.estimate.reason).toBe("percent-unavailable");
});

test("an expired window never carries an estimate", () => {
  const result = quotaView([sample("seven-day", 0, now)], spends({}), now)!;
  expect(result.state).toBe("expired");
  expect(result.estimate.usd).toBeNull();
  expect(result.estimate.reason).toBe("expired");
});

test("the five-hour window keeps its existing behaviour", () => {
  const base = sample("seven-day", 1);
  const fiveHour: CollectedQuota = {
    ...base,
    fact: {
      ...base.fact,
      window: "five-hour",
      windowMinutes: 300,
      resetsAt: iso(8, 9),
    },
  };
  const result = quotaView(
    [fiveHour],
    spends({ "deepseek-v4.1-flash": "0.44" }),
    now,
  )!;
  expect(result.estimate.usd).toBeNull();
});
