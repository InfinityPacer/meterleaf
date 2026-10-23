import { expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  quotaView,
  type CollectedQuota,
  type QuotaChargeReader,
} from "../src/domain/quota";
import { goPlanBudget } from "../src/domain/opencode-go-plan";
import { estimateDescription } from "../src/web/lib/quota-display";

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
 * 按模型汇总本周期费用，每个模型记一次请求；金额为 null 表示该模型缺价，
 * 与索引一致，缺价请求计入次数但不计入金额。scope 为空时返回账户全部模型。
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

test("go weekly cap replaces the percent extrapolation with the published limit", () => {
  const result = quotaView(
    [sample("seven-day", 1)],
    spends({ "deepseek-v4.1-flash": "0.44" }),
    now,
    goPlanBudget("opencode-go", "go"),
  )!;
  expect(result.estimate).toMatchObject({
    usd: "40",
    credits: null,
    methods: { usd: "plan-limit", credits: null },
    reason: "eligible",
  });
});

test("go-plus monthly cap is the published monthly limit", () => {
  const result = quotaView(
    [sample("monthly", 1)],
    spends({ "deepseek-v4.1-flash": "0.8" }),
    now,
    goPlanBudget("opencode-go", "go-plus"),
  )!;
  expect(result.estimate.usd).toBe("160");
  expect(result.estimate.methods?.usd).toBe("plan-limit");
});

test("a window without requests does not assume which model will be used", () => {
  const history = [sample("seven-day", 0)];
  const result = quotaView(
    history,
    spends({}),
    now,
    goPlanBudget("opencode-go", "go"),
  )!;
  expect(result.estimate.methods?.usd).not.toBe("plan-limit");
  expect(result).toEqual(quotaView(history, spends({}), now)!);
});

test("unpriced requests from another model keep the extrapolated estimate", () => {
  // 缺价模型不计入金额，按金额对账会误以为本周期只用了表内模型。
  const history = [sample("seven-day", 2)];
  const reader = spends({
    "deepseek-v4.1-flash": "0.44",
    "gemini-4-argon": null,
  });
  const result = quotaView(
    history,
    reader,
    now,
    goPlanBudget("opencode-go", "go"),
  )!;
  expect(result.estimate.methods?.usd).not.toBe("plan-limit");
  expect(result).toEqual(quotaView(history, reader, now)!);
});

test("spend from a model outside the plan table falls back to the old estimate", () => {
  const history = [sample("seven-day", 1)];
  const reader = spends({
    "deepseek-v4.1-flash": "0.44",
    "glm-5.3": "0.5",
  });
  const result = quotaView(
    history,
    reader,
    now,
    goPlanBudget("opencode-go", "go"),
  )!;
  expect(result.estimate.methods?.usd).not.toBe("plan-limit");
  expect(result).toEqual(quotaView(history, reader, now)!);
});

test("unknown platform or plan leaves the existing estimate untouched", () => {
  for (const budget of [
    goPlanBudget("anthropic", "go"),
    goPlanBudget("opencode-go", "未提供"),
    goPlanBudget("opencode-go", null),
    goPlanBudget("opencode-go", undefined),
  ]) {
    expect(budget).toBeNull();
    const history = [sample("seven-day", 1)];
    const reader = spends({ "deepseek-v4.1-flash": "0.44" });
    expect(quotaView(history, reader, now, budget)).toEqual(
      quotaView(history, reader, now),
    );
  }
});

test("an expired window never uses the plan limit", () => {
  const result = quotaView(
    [sample("seven-day", 0, now)],
    spends({}),
    now,
    goPlanBudget("opencode-go", "go"),
  )!;
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
    goPlanBudget("opencode-go", "go"),
  )!;
  expect(result.estimate.usd).toBeNull();
});

test("the plan-limit method has its own description", () => {
  expect(
    estimateDescription({
      percent: 1,
      resetsAt: iso(15),
      sampledAt: now,
      state: "active",
      stale: false,
      estimate: {
        usd: "40",
        credits: null,
        deltaPercent: null,
        reason: "eligible",
        methods: { usd: "plan-limit", credits: null },
      },
    }),
  ).toBe("按 OpenCode Go 套餐公布的模型上限计算，不是外推值");
});
