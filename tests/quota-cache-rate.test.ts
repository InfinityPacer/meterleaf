import { expect, test } from "bun:test";
import type { UsageFact } from "../src/domain/connector";
import { quotaView, type PricedUsage } from "../src/domain/quota";
import type { Valuation } from "../src/domain/pricing";

const now = "2026-10-20T12:00:00.000Z";

function usage(
  id: string,
  tokens: Pick<UsageFact["tokens"], "input" | "cacheRead" | "cacheWrite"> & {
    output?: number | null;
  },
): PricedUsage {
  return {
    fact: {
      sourceId: "test",
      externalId: id,
      accountExternalId: "account",
      occurredAt: "2026-10-20T10:00:00.000Z",
      model: "claude-opus-5-5",
      upstreamModel: null,
      tier: "standard",
      tokens: {
        input: tokens.input,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        output: tokens.output === undefined ? 10 : tokens.output,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: null,
      },
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
      metadata: {},
    },
    valuation: {
      usd: { amount: null },
      credits: { amount: null },
    } as unknown as Valuation,
  };
}

const history = [
  {
    collectedAt: now,
    fact: {
      sourceId: "test",
      externalId: "five-hour",
      accountExternalId: "account",
      window: "five-hour" as const,
      percent: 20,
      sampledAt: now,
      resetsAt: "2026-10-20T14:00:00.000Z",
      windowMinutes: 300,
    },
  },
];

test("quota cache rate counts only requests whose three input buckets are known", () => {
  const view = quotaView(
    history,
    [
      usage("complete", { input: 10, cacheRead: 90, cacheWrite: 0 }),
      // 缓存写入未知的请求不进分子也不进分母，不能把未知当作 0 拉低命中率。
      usage("partial", { input: 1000, cacheRead: 0, cacheWrite: null }),
    ],
    now,
  );
  expect(view!.periodCacheRate).toBe(90);
  expect(view!.periodRequests).toBe(2);
});

test("quota cache rate stays unknown when no request has complete input buckets", () => {
  const view = quotaView(
    history,
    [usage("partial", { input: null, cacheRead: 50, cacheWrite: 0 })],
    now,
  );
  expect(view!.periodCacheRate).toBeNull();
});

test("quota period tokens sum known buckets across incomplete rows and stay null when all buckets are unknown", () => {
  const mixed = quotaView(
    history,
    [
      usage("complete", {
        input: 100,
        cacheRead: 400,
        cacheWrite: 0,
        output: 50,
      }),
      // 单条缺失输出桶的请求不能把整段窗口的 token 合计抹成 null。
      usage("missing-output", {
        input: 45_479,
        cacheRead: 202_732,
        cacheWrite: 0,
        output: null,
      }),
    ],
    now,
  );
  expect(mixed!.periodRequests).toBe(2);
  expect(mixed!.periodTokens).toBe(550 + 45_479 + 202_732);

  const allUnknown = quotaView(
    history,
    [
      usage("all-null", {
        input: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
      }),
    ],
    now,
  );
  expect(allUnknown!.periodRequests).toBe(1);
  expect(allUnknown!.periodTokens).toBeNull();
});
