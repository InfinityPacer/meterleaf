import { describe, expect, test } from "bun:test";
import type { QuotaFact } from "../src/domain/connector";
import { readConfig } from "../src/server/config";
import { silentLogger } from "../src/server/diagnostics";
import {
  goQuotaFacts,
  GoQuotaRefresher,
  monthMinutes,
  OPENCODE_GO_USAGE_URL,
} from "../src/server/opencode-go";

const ACCOUNT = {
  sourceId: "claude-code-mac",
  accountExternalId: "opencode-go",
};
const BODY = {
  usage: {
    rolling: { percent: 12, resetsAt: "2026-10-23T05:43:00Z" },
    weekly: { percent: 30, resetsAt: "2026-10-26T00:00:00Z" },
    monthly: { percent: 45.5, resetsAt: "2026-11-23T00:23:00Z" },
  },
};

describe("OpenCode Go 额度", () => {
  test("三个窗口换成 5 小时、每周和月额度快照", () => {
    const facts = goQuotaFacts(BODY, ACCOUNT, "2026-10-23T01:00:00.000Z");
    expect(
      facts.map((fact) => [fact.window, fact.percent, fact.windowMinutes]),
    ).toEqual([
      ["five-hour", 12, 300],
      ["seven-day", 30, 10080],
      // 10 月 23 日至 11 月 23 日共 31 天。
      ["monthly", 45.5, 31 * 24 * 60],
    ]);
    expect(facts[0]).toMatchObject({
      sourceId: "claude-code-mac",
      accountExternalId: "opencode-go",
      externalId: "opencode-go:five-hour",
      sampledAt: "2026-10-23T01:00:00.000Z",
      resetsAt: "2026-10-23T05:43:00.000Z",
    });
  });

  test("响应缺少窗口时报错，不写入部分快照", () => {
    expect(() =>
      goQuotaFacts({ usage: { rolling: BODY.usage.rolling } }, ACCOUNT, "x"),
    ).toThrow();
  });

  test("只在页面在线且间隔已到时读取，失败也计入间隔", async () => {
    let now = Date.parse("2026-10-23T01:00:00Z");
    const calls: { url: string; auth: string | null }[] = [];
    let status = 200;
    const saved: QuotaFact[][] = [];
    const warnings: unknown[] = [];
    const refresher = new GoQuotaRefresher({
      key: "sk-go-test",
      account: ACCOUNT,
      save: (quotas) => saved.push(quotas),
      diagnostics: {
        ...silentLogger,
        warn: (_event, fields) => warnings.push(fields),
      },
      now: () => now,
      intervalMs: 120_000,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(JSON.stringify(BODY), { status });
      }) as typeof fetch,
    });

    refresher.updatePresence("page", false);
    await refresher.settled();
    expect(calls).toHaveLength(0);

    refresher.updatePresence("page", true);
    refresher.updatePresence("page", true);
    await refresher.settled();
    expect(calls).toEqual([
      { url: OPENCODE_GO_USAGE_URL, auth: "Bearer sk-go-test" },
    ]);
    expect(saved).toHaveLength(1);

    now += 60_000;
    refresher.updatePresence("page", true);
    await refresher.settled();
    expect(calls).toHaveLength(1);

    now += 60_000;
    status = 401;
    refresher.updatePresence("page", true);
    await refresher.settled();
    expect(calls).toHaveLength(2);
    expect(saved).toHaveLength(1);
    expect(warnings).toEqual([{ status: 401 }]);
    expect(JSON.stringify(warnings)).not.toContain("sk-go-test");

    now += 30_000;
    refresher.updatePresence("page", true);
    await refresher.settled();
    expect(calls).toHaveLength(2);
  });

  test("月额度周期从上月同一天起算，上月没有这一天时取月末", () => {
    const days = (resetsAt: string) => monthMinutes(resetsAt) / (24 * 60);
    expect(days("2026-11-23T00:23:00Z")).toBe(31);
    expect(days("2027-03-31T00:00:00Z")).toBe(31);
    expect(days("2028-03-30T00:00:00Z")).toBe(30);
    expect(days("2027-01-15T00:00:00Z")).toBe(31);
  });

  test("读数未变时间隔几分钟才再写一次快照", async () => {
    let now = Date.parse("2026-10-23T01:00:00Z");
    const saved: string[] = [];
    let body = BODY;
    const refresher = new GoQuotaRefresher({
      key: "sk-go-test",
      account: ACCOUNT,
      save: (_quotas, at) => saved.push(at),
      diagnostics: silentLogger,
      now: () => now,
      intervalMs: 120_000,
      fetch: (async () =>
        new Response(JSON.stringify(body))) as unknown as typeof fetch,
    });
    const tick = async () => {
      refresher.updatePresence("page", true);
      await refresher.settled();
      now += 120_000;
    };
    await tick();
    await tick();
    expect(saved).toHaveLength(1);
    await tick();
    expect(saved).toHaveLength(2);
    body = {
      usage: { ...BODY.usage, rolling: { ...BODY.usage.rolling, percent: 13 } },
    };
    await tick();
    expect(saved).toHaveLength(3);
  });

  test("请求异常只记录错误类型，不带出密钥", async () => {
    const warnings: unknown[] = [];
    const refresher = new GoQuotaRefresher({
      key: "sk-go-secret",
      account: ACCOUNT,
      save: () => {},
      diagnostics: { ...silentLogger, warn: (_e, f) => warnings.push(f) },
      fetch: (async () => {
        throw new TypeError(
          "Header 'Authorization' has invalid value: 'Bearer sk-go-secret'",
        );
      }) as unknown as typeof fetch,
    });
    refresher.updatePresence("page", true);
    await refresher.settled();
    expect(warnings).toEqual([{ error: "TypeError" }]);
  });

  test("配置：只有一个推送来源时默认挂到该来源的 opencode-go 账户", () => {
    const base = {
      METERLEAF_INGEST_KEYS: `claude-code-mac:${"0".repeat(64)}`,
      METERLEAF_OPENCODE_GO_KEY: "sk-go-test",
    };
    expect(readConfig(base).openCodeGo).toEqual({
      key: "sk-go-test",
      account: ACCOUNT,
    });
    expect(
      readConfig({ ...base, METERLEAF_OPENCODE_GO_ACCOUNT: "other:go" })
        .openCodeGo?.account,
    ).toEqual({ sourceId: "other", accountExternalId: "go" });
    expect(() =>
      readConfig({ ...base, METERLEAF_OPENCODE_GO_ACCOUNT: "bad" }),
    ).toThrow();
    expect(
      readConfig({ ...base, METERLEAF_OPENCODE_GO_KEY: "" }).openCodeGo,
    ).toBeUndefined();
    expect(() =>
      readConfig({
        METERLEAF_INGEST_KEYS: `a:${"0".repeat(64)},b:${"1".repeat(64)}`,
        METERLEAF_OPENCODE_GO_KEY: "sk-go-test",
      }),
    ).toThrow("METERLEAF_OPENCODE_GO_ACCOUNT");
  });
});
