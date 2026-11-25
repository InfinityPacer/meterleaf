import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuotaFact, SourceAccount } from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import {
  COMMAND_CODE_API_BASE,
  COMMAND_CODE_TIMEOUT_MS,
  commandCodeSubjectKey,
  commandCodeTimestampMs,
  fetchCommandCodeQuota,
  sanitizeCommandCodePlanId,
} from "../src/shared/commandcode";
import {
  CommandCodeQuotaRefresher,
  commandCodeQuotaFacts,
} from "../src/server/commandcode";
import { readConfig } from "../src/server/config";
import { liveSnapshot } from "../src/server/snapshot";
import { ingestQuotaSchema } from "../src/shared/ingest";
import { silentLogger } from "../src/server/diagnostics";
import { ref } from "../src/domain/account-merge";
import {
  commandCodeIdentityStateKey,
  LedgerStore,
  type CommandCodeWarning,
} from "../src/storage/ledger";

const API_KEY = "cc_live_secret_key_value_1234567890";
const WHOAMI = {
  org: { id: "org_123", login: "acme" },
  user: { userName: "alice" },
};
const CREDITS = {
  credits: { monthlyCredits: 30, purchasedCredits: 10, freeCredits: 0 },
  windowLimits: {
    fiveHour: { used: 5, cap: 20, resetAt: 1_795_000_000 },
    weekly: { used: 33, cap: 99, resetAt: "2026-11-30T00:00:00Z" },
  },
};
const SUBSCRIPTION = {
  data: {
    planId: "pro",
    currentPeriodStart: "2026-11-01T00:00:00Z",
    currentPeriodEnd: "2026-12-01T00:00:00Z",
  },
};
const SUMMARY = { totalCost: 60 };

/** 入账协议里的额度不带 sourceId 与 externalId（由批次与账户窗口推出）。 */
function wire({
  sourceId: _sourceId,
  externalId: _externalId,
  ...rest
}: QuotaFact) {
  return rest;
}

type Route = (url: URL) => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 按路径返回固定响应的假 fetch，记录每次请求的地址与选项。 */
function fakeApi(overrides: Partial<Record<string, Route>> = {}) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const routes: Record<string, Route> = {
    "/alpha/whoami": () => json(WHOAMI),
    "/alpha/billing/credits": () => json(CREDITS),
    "/alpha/billing/subscriptions": () => json(SUBSCRIPTION),
    "/alpha/usage/summary": () => json(SUMMARY),
    ...overrides,
  } as Record<string, Route>;
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected ${url.pathname}`);
    return route(url);
  }) as typeof globalThis.fetch;
  return { fetch, calls, paths: () => calls.map((call) => call.url.pathname) };
}

describe("Command Code 共享请求与解析", () => {
  test("四个接口按顺序读取，固定地址、禁止重定向，换算三个窗口", async () => {
    const api = fakeApi();
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    expect(api.paths()[0]).toBe("/alpha/whoami");
    expect(new Set(api.paths().slice(1, 3))).toEqual(
      new Set(["/alpha/billing/credits", "/alpha/billing/subscriptions"]),
    );
    expect(api.paths()[3]).toBe("/alpha/usage/summary");
    for (const call of api.calls) {
      expect(call.url.origin).toBe(COMMAND_CODE_API_BASE);
      expect(call.init?.redirect).toBe("error");
      expect(new Headers(call.init?.headers).get("authorization")).toBe(
        `Bearer ${API_KEY}`,
      );
      if (call.url.pathname !== "/alpha/whoami")
        expect(call.url.searchParams.get("orgId")).toBe("org_123");
    }
    // since 原样使用上游的周期起点。
    expect(api.calls[3]!.url.searchParams.get("since")).toBe(
      "2026-11-01T00:00:00Z",
    );
    expect(result).toEqual({
      status: "ok",
      subjectKey: commandCodeSubjectKey("org_123", "acme"),
      planId: "pro",
      windows: [
        {
          window: "five-hour",
          percent: 25,
          resetsAt: new Date(1_795_000_000_000).toISOString(),
          windowMinutes: 300,
        },
        {
          window: "seven-day",
          percent: (33 / 99) * 100,
          resetsAt: "2026-11-30T00:00:00.000Z",
          windowMinutes: 10080,
        },
        {
          window: "monthly",
          percent: 60,
          resetsAt: "2026-12-01T00:00:00.000Z",
          windowMinutes: 30 * 24 * 60,
        },
      ],
    });
    if (result.status === "ok") {
      expect(result.subjectKey).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.subjectKey).toHaveLength(71);
      expect(JSON.stringify(result)).not.toContain("org_123");
      expect(JSON.stringify(result)).not.toContain("acme");
    }
  });

  test("whoami 失败立即终止，不读后续接口", async () => {
    for (const [route, expected] of [
      [() => json({}, 500), { status: "error", kind: "http", httpStatus: 500 }],
      [() => json({}, 401), { status: "rejected", httpStatus: 401 }],
      [() => json({}, 403), { status: "rejected", httpStatus: 403 }],
      [() => json({ org: {}, user: {} }), { status: "error", kind: "invalid" }],
      [
        () => {
          throw new TypeError("fetch failed");
        },
        { status: "error", kind: "network" },
      ],
      [
        () => {
          throw new TypeError("unexpected redirect");
        },
        { status: "error", kind: "redirect" },
      ],
      [
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example" },
          }),
        { status: "error", kind: "redirect", httpStatus: 302 },
      ],
    ] as const) {
      const api = fakeApi({ "/alpha/whoami": route as Route });
      expect(
        await fetchCommandCodeQuota({ apiKey: API_KEY, fetch: api.fetch }),
      ).toEqual(expected as never);
      expect(api.paths()).toEqual(["/alpha/whoami"]);
    }
  });

  test("没有组织时用登录名摘要，且不带 orgId 查询", async () => {
    const api = fakeApi({
      "/alpha/whoami": () => json({ user: { userName: "solo" } }),
    });
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    expect(result).toMatchObject({
      status: "ok",
      subjectKey: commandCodeSubjectKey(null, "solo"),
    });
    for (const call of api.calls.slice(1))
      expect(call.url.searchParams.has("orgId")).toBe(false);
  });

  test("credits、subscriptions 或 summary 返回 401/403 时整体判为被拒", async () => {
    for (const path of [
      "/alpha/billing/credits",
      "/alpha/billing/subscriptions",
      "/alpha/usage/summary",
    ]) {
      const api = fakeApi({ [path]: () => json({}, 403) });
      expect(
        await fetchCommandCodeQuota({ apiKey: API_KEY, fetch: api.fetch }),
      ).toEqual({ status: "rejected", httpStatus: 403 });
    }
  });

  test("并行读取中 credits 返回 401 时立即中止仍挂起的 subscriptions 并判为被拒", async () => {
    let aborted = false;
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/alpha/whoami") return json(WHOAMI);
      if (url.pathname === "/alpha/billing/credits") return json({}, 401);
      if (url.pathname === "/alpha/billing/subscriptions")
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof globalThis.fetch;
    const started = Date.now();
    const result = await fetchCommandCodeQuota({ apiKey: API_KEY, fetch });
    expect(result).toEqual({ status: "rejected", httpStatus: 401 });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(COMMAND_CODE_TIMEOUT_MS);
  });

  test("credits 返回 401 时，即使 subscriptions 不理会中止信号也立即整体返回", async () => {
    let signal: AbortSignal | undefined;
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/alpha/whoami") return json(WHOAMI);
      if (url.pathname === "/alpha/billing/credits") return json({}, 401);
      if (url.pathname === "/alpha/billing/subscriptions") {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof globalThis.fetch;
    const started = performance.now();
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch,
      timeoutMs: 10_000,
    });
    const elapsed = performance.now() - started;
    expect(result).toEqual({ status: "rejected", httpStatus: 401 });
    expect(signal?.aborted).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("非 401/403 失败只省略对应部分，未知不补零", async () => {
    const api = fakeApi({
      "/alpha/billing/credits": () => json({}, 500),
      "/alpha/usage/summary": () => json({}, 502),
    });
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    // 只剩周期：monthly 有重置无百分比；套餐仍可用。
    expect(result).toEqual({
      status: "ok",
      subjectKey: commandCodeSubjectKey("org_123", "acme"),
      planId: "pro",
      windows: [
        {
          window: "monthly",
          percent: null,
          resetsAt: "2026-12-01T00:00:00.000Z",
          windowMinutes: 30 * 24 * 60,
        },
      ],
    });
  });

  test("缺少或非法的周期起点时不读 summary，不把全部历史当作本期已花", async () => {
    for (const start of [
      undefined,
      "next week",
      "2026/11/01",
      -5,
      0,
      "9".repeat(20),
    ]) {
      const api = fakeApi({
        "/alpha/billing/subscriptions": () =>
          json({
            data: {
              planId: "pro",
              ...(start !== undefined ? { currentPeriodStart: start } : {}),
              currentPeriodEnd: "2026-12-01T00:00:00Z",
            },
          }),
      });
      const result = await fetchCommandCodeQuota({
        apiKey: API_KEY,
        fetch: api.fetch,
      });
      expect(api.paths()).not.toContain("/alpha/usage/summary");
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      const monthly = result.windows.find(
        (window) => window.window === "monthly",
      );
      // 有重置无百分比；周期不完整时不写窗口长度。
      expect(monthly).toEqual({
        window: "monthly",
        percent: null,
        resetsAt: "2026-12-01T00:00:00.000Z",
        windowMinutes: null,
      });
    }
  });

  test("数字周期起点按 Unix 秒/毫秒校验，since 发送上游原值", async () => {
    const start = 1_793_491_200; // 2026-11-01T00:00:00Z（秒）
    const end = 1_796_083_200_000; // 2026-12-01T00:00:00Z（毫秒）
    const api = fakeApi({
      "/alpha/billing/subscriptions": () =>
        json({
          data: {
            planId: "max",
            currentPeriodStart: start,
            currentPeriodEnd: end,
          },
        }),
    });
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    expect(api.calls.at(-1)!.url.searchParams.get("since")).toBe(String(start));
    expect(result).toMatchObject({ status: "ok", planId: "max" });
    if (result.status === "ok")
      expect(result.windows.at(-1)).toEqual({
        window: "monthly",
        percent: 60,
        resetsAt: "2026-12-01T00:00:00.000Z",
        windowMinutes: 30 * 24 * 60,
      });
  });

  test("时间戳解析只接受 ISO 或纯数字，并限制在合法范围", () => {
    expect(commandCodeTimestampMs("2026-11-01T00:00:00Z")).toBe(
      Date.parse("2026-11-01T00:00:00Z"),
    );
    expect(commandCodeTimestampMs(1_793_491_200)).toBe(1_793_491_200_000);
    expect(commandCodeTimestampMs("1793491200000")).toBe(1_793_491_200_000);
    for (const value of [
      0,
      -1,
      "",
      "abc",
      "2026-11-01",
      8_640_000_000_001_000,
      null,
      {},
    ])
      expect(commandCodeTimestampMs(value)).toBeNull();
  });

  test("时间戳先取整再按 (0, 8.64e12] 毫秒校验，日历非法的 ISO 拒绝", () => {
    // 上限本身可用：毫秒与秒两种写法。
    expect(commandCodeTimestampMs(8_640_000_000_000)).toBe(8_640_000_000_000);
    expect(commandCodeTimestampMs(8_640_000_000)).toBe(8_640_000_000_000);
    expect(commandCodeTimestampMs("2026-02-28T23:59:59Z")).toBe(
      Date.parse("2026-02-28T23:59:59Z"),
    );
    expect(commandCodeTimestampMs("2028-02-29T00:00:00+08:00")).toBe(
      Date.parse("2028-02-29T00:00:00+08:00"),
    );
    for (const value of [
      8_640_000_000_001,
      999_999_999_999,
      "999999999999",
      3e14,
      0.0001,
      "0.0001",
      "2026-02-30T00:00:00Z",
      "2027-02-29T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-11-01T24:00:00Z",
      "2026-11-01T23:60:00Z",
      "2026-11-01T23:59:60Z",
      "2026-11-01T00:00:00+24:00",
      "+275760-09-13T00:00:00.001Z",
    ])
      expect(commandCodeTimestampMs(value)).toBeNull();
  });

  test("越界时间戳不进入窗口，产出的额度都能通过入账协议校验", async () => {
    const api = fakeApi({
      "/alpha/billing/credits": () =>
        json({
          credits: CREDITS.credits,
          windowLimits: {
            fiveHour: { used: 5, cap: 20, resetAt: 999_999_999_999 },
            weekly: { used: 33, cap: 99, resetAt: 3e14 },
          },
        }),
      "/alpha/billing/subscriptions": () =>
        json({
          data: {
            planId: "pro",
            currentPeriodStart: "2026-02-30T00:00:00Z",
            currentPeriodEnd: 8_640_000_000_001,
          },
        }),
    });
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(
      result.windows.map((window) => [
        window.window,
        window.resetsAt,
        window.windowMinutes,
      ]),
    ).toEqual([
      ["five-hour", null, 300],
      ["seven-day", null, 10080],
    ]);
    // 周期起点非法时不读 summary，月窗既无百分比也无周期，不产出。
    expect(api.paths()).not.toContain("/alpha/usage/summary");
    for (const fact of commandCodeQuotaFacts(
      result.windows,
      { sourceId: SOURCE, accountExternalId: ACCOUNT },
      NOW,
    ))
      expect(ingestQuotaSchema.safeParse(wire(fact)).success).toBe(true);
  });

  test("合法上限附近的周期仍能通过入账协议并参与快照计算", async () => {
    const api = fakeApi({
      "/alpha/billing/subscriptions": () =>
        json({
          data: {
            planId: "pro",
            currentPeriodStart: 8_639_000_000_000,
            currentPeriodEnd: 8_640_000_000_000,
          },
        }),
    });
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    const monthly = result.windows.find(
      (window) => window.window === "monthly",
    )!;
    expect(monthly.resetsAt).toBe(new Date(8_640_000_000_000).toISOString());
    expect(Number.isSafeInteger(monthly.windowMinutes)).toBe(true);
    const facts = commandCodeQuotaFacts(
      result.windows,
      { sourceId: SOURCE, accountExternalId: ACCOUNT },
      NOW,
    );
    for (const fact of facts)
      expect(ingestQuotaSchema.safeParse(wire(fact)).success).toBe(true);
    const { store } = managedStore();
    expect(
      store.saveProviderQuotaUpdate(
        {
          sourceId: SOURCE,
          accountExternalId: ACCOUNT,
          identityDigest: DIGEST_A,
          observedPlan: "pro",
          quotas: facts,
        },
        NOW,
      ),
    ).toBe("saved");
    const snapshot = liveSnapshot(store, null, 60, NOW);
    expect(
      snapshot.accounts.find((item) => item.platform === "commandcode")?.monthly
        ?.resetsAt,
    ).toBe(new Date(8_640_000_000_000).toISOString());
  });

  test("周期结束不晚于开始时不写窗口长度", async () => {
    const api = fakeApi({
      "/alpha/billing/subscriptions": () =>
        json({
          data: {
            currentPeriodStart: "2026-12-01T00:00:00Z",
            currentPeriodEnd: "2026-11-01T00:00:00Z",
          },
        }),
    });
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.windows.at(-1)!.windowMinutes).toBeNull();
    expect(result.planId).toBeNull();
  });

  test("used=0 且 cap=0 省略窗口，cap=0 而 used>0 记 100%", async () => {
    const api = fakeApi({
      "/alpha/billing/credits": () =>
        json({
          credits: CREDITS.credits,
          windowLimits: {
            fiveHour: { used: 0, cap: 0, resetAt: 1_795_000_000 },
            weekly: { used: 3, cap: 0, resetAt: null },
          },
        }),
    });
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.windows.map((window) => window.window)).toEqual([
      "seven-day",
      "monthly",
    ]);
    expect(result.windows[0]).toEqual({
      window: "seven-day",
      percent: 100,
      resetsAt: null,
      windowMinutes: 10080,
    });
  });

  test("没有任何窗口也没有套餐时判为 invalid", async () => {
    const api = fakeApi({
      "/alpha/billing/credits": () => json({}),
      "/alpha/billing/subscriptions": () => json({ data: {} }),
    });
    expect(
      await fetchCommandCodeQuota({ apiKey: API_KEY, fetch: api.fetch }),
    ).toEqual({ status: "error", kind: "invalid" });
    expect(api.paths()).not.toContain("/alpha/usage/summary");
  });

  test("planId 回显凭据或疑似凭据时丢弃", async () => {
    for (const planId of [
      API_KEY,
      `plan ${API_KEY}`,
      "Bearer abc",
      "cc_abc",
      "user_123",
      "sk-proj-1",
      "rk-1",
      "ghp_x",
      "eyJhbGciOi.eyJzdWIi",
      "-pro",
      "x".repeat(65),
    ])
      expect(sanitizeCommandCodePlanId(planId, { apiKey: API_KEY })).toBeNull();
    expect(
      sanitizeCommandCodePlanId("  pro_annual ", { apiKey: API_KEY }),
    ).toBe("pro_annual");
    const secrets = { apiKey: API_KEY, login: "acme", orgId: "org_123" };
    for (const planId of [
      "acme",
      "ACME",
      "team-acme",
      "org_123",
      "Org_123-pro",
    ])
      expect(sanitizeCommandCodePlanId(planId, secrets)).toBeNull();
    // 1–2 个字符的身份：完全相同或作为分隔段出现都拦截，落在普通词内部时保留。
    for (const planId of ["plan-li", "li_team", "org.li", "LI", "Pro-Li"])
      expect(
        sanitizeCommandCodePlanId(planId, { apiKey: API_KEY, login: "li" }),
      ).toBeNull();
    expect(
      sanitizeCommandCodePlanId("ab-pro", { apiKey: API_KEY, orgId: "ab" }),
    ).toBeNull();
    expect(
      sanitizeCommandCodePlanId("max", { apiKey: API_KEY, login: "a" }),
    ).toBe("max");
    expect(
      sanitizeCommandCodePlanId("pro", { apiKey: API_KEY, login: "pr" }),
    ).toBe("pro");
    expect(
      sanitizeCommandCodePlanId("PR", { apiKey: API_KEY, login: "pr" }),
    ).toBeNull();
    expect(sanitizeCommandCodePlanId("pro", secrets)).toBe("pro");
    const api = fakeApi({
      "/alpha/billing/subscriptions": () =>
        json({ data: { ...SUBSCRIPTION.data, planId: API_KEY } }),
    });
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: api.fetch,
    });
    expect(result).toMatchObject({ status: "ok", planId: null });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    for (const echoed of ["acme", "org_123"]) {
      const echo = fakeApi({
        "/alpha/billing/subscriptions": () =>
          json({ data: { ...SUBSCRIPTION.data, planId: echoed } }),
      });
      expect(
        await fetchCommandCodeQuota({ apiKey: API_KEY, fetch: echo.fetch }),
      ).toMatchObject({ status: "ok", planId: null });
    }
  });

  test("总超时后返回固定的 timeout", async () => {
    const started = Date.now();
    const result = await fetchCommandCodeQuota({
      apiKey: API_KEY,
      fetch: (async (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as typeof fetch,
      timeoutMs: 20,
    });
    expect(result).toEqual({ status: "error", kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(COMMAND_CODE_TIMEOUT_MS).toBe(15_000);
  });

  test("错误结果只含固定字面量，不泄漏上游原文或凭据", async () => {
    const leaky =
      "secret body org_123 acme cc_live_secret_key_value_1234567890";
    const results = [
      await fetchCommandCodeQuota({
        apiKey: API_KEY,
        fetch: fakeApi({
          "/alpha/whoami": () => new Response(leaky, { status: 500 }),
        }).fetch,
      }),
      await fetchCommandCodeQuota({
        apiKey: API_KEY,
        fetch: fakeApi({
          "/alpha/whoami": () => {
            throw new Error(leaky);
          },
        }).fetch,
      }),
      await fetchCommandCodeQuota({
        apiKey: API_KEY,
        fetch: fakeApi({ "/alpha/whoami": () => new Response("not json") })
          .fetch,
      }),
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain("secret");
      expect(text).not.toContain("org_123");
      expect(text).not.toContain(API_KEY);
      expect(Object.keys(result).sort()).toEqual(
        result.status === "error" && "httpStatus" in result
          ? ["httpStatus", "kind", "status"]
          : ["kind", "status"],
      );
    }
  });
});

describe("服务端 Command Code 配置", () => {
  const ingest = (id: string) => `${id}:${"a".repeat(64)}`;

  test("只配置 Key 即可纯服务端启动，额度挂在保留来源", () => {
    const config = readConfig({ METERLEAF_COMMAND_CODE_KEY: "cc_key" });
    expect(config.commandCode).toEqual({
      key: "cc_key",
      account: { sourceId: "commandcode", accountExternalId: "commandcode" },
    });
    expect(config.ingestKeys).toEqual([]);
    // Compose 未填写时为空串，按未配置处理。
    expect(() =>
      readConfig({
        METERLEAF_COMMAND_CODE_KEY: "",
        METERLEAF_COMMAND_CODE_ACCOUNT: "",
      }),
    ).toThrow("Live mode needs");
  });

  test("一个推送来源时默认挂到该来源的 commandcode 账户", () => {
    expect(
      readConfig({
        METERLEAF_INGEST_KEYS: ingest("mac"),
        METERLEAF_COMMAND_CODE_KEY: "cc_key",
      }).commandCode?.account,
    ).toEqual({ sourceId: "mac", accountExternalId: "commandcode" });
    expect(
      readConfig({
        METERLEAF_INGEST_KEYS: ingest("mac"),
        METERLEAF_COMMAND_CODE_KEY: "cc_key",
        METERLEAF_COMMAND_CODE_ACCOUNT: "mac:cc-team",
      }).commandCode?.account,
    ).toEqual({ sourceId: "mac", accountExternalId: "cc-team" });
  });

  test("多个推送来源时必须显式指定账户，格式错误报错且不回显 Key", () => {
    expect(() =>
      readConfig({
        METERLEAF_INGEST_KEYS: `${ingest("mac")},${ingest("mini")}`,
        METERLEAF_COMMAND_CODE_KEY: "cc_secret_value",
      }),
    ).toThrow("METERLEAF_COMMAND_CODE_ACCOUNT is required");
    for (const value of ["mac", "mac:a:b", "bad source:x", "mac:"]) {
      try {
        readConfig({
          METERLEAF_INGEST_KEYS: ingest("mac"),
          METERLEAF_COMMAND_CODE_KEY: "cc_secret_value",
          METERLEAF_COMMAND_CODE_ACCOUNT: value,
        });
        throw new Error("expected failure");
      } catch (error) {
        expect((error as Error).message).toContain(
          "Invalid METERLEAF_COMMAND_CODE_ACCOUNT",
        );
        expect((error as Error).message).not.toContain("cc_secret_value");
      }
    }
  });

  test("与 Sub2API 来源或 OpenCode Go 账户冲突时拒绝启动", () => {
    expect(() =>
      readConfig({
        SUB2API_DATABASE_URL: "postgres://u:p@localhost/db",
        METERLEAF_COMMAND_CODE_KEY: "cc_key",
        METERLEAF_COMMAND_CODE_ACCOUNT: "sub2api:commandcode",
      }),
    ).toThrow("must differ from METERLEAF_SOURCE_ID");
    expect(() =>
      readConfig({
        METERLEAF_INGEST_KEYS: ingest("mac"),
        METERLEAF_OPENCODE_GO_KEY: "go_key",
        METERLEAF_OPENCODE_GO_ACCOUNT: "mac:shared",
        METERLEAF_COMMAND_CODE_KEY: "cc_key",
        METERLEAF_COMMAND_CODE_ACCOUNT: "mac:shared",
      }),
    ).toThrow("must differ from METERLEAF_OPENCODE_GO_ACCOUNT");
    // 两者共存于不同账户。
    const both = readConfig({
      METERLEAF_INGEST_KEYS: ingest("mac"),
      METERLEAF_OPENCODE_GO_KEY: "go_key",
      METERLEAF_COMMAND_CODE_KEY: "cc_key",
    });
    expect(both.openCodeGo?.account.accountExternalId).toBe("opencode-go");
    expect(both.commandCode?.account.accountExternalId).toBe("commandcode");
  });
});

const SOURCE = "mac";
const ACCOUNT = "commandcode";
const DIGEST_A = commandCodeSubjectKey("org_a", "a");
const DIGEST_B = commandCodeSubjectKey("org_b", "b");

function managedStore(managed = true) {
  const warnings: CommandCodeWarning[] = [];
  const store = new LedgerStore(":memory:", defaultPriceBook, {
    serverManagedQuotaAccounts: new Set(managed ? [ref(SOURCE, ACCOUNT)] : []),
    onCommandCodeWarning: (event) => warnings.push(event),
  });
  return { store, warnings };
}

function quota(
  window: QuotaFact["window"],
  percent: number | null,
  sampledAt: string,
  overrides: Partial<QuotaFact> = {},
): QuotaFact {
  return {
    sourceId: SOURCE,
    externalId: `${ACCOUNT}:${window}`,
    accountExternalId: ACCOUNT,
    window,
    percent,
    sampledAt,
    resetsAt: "2026-12-01T00:00:00.000Z",
    windowMinutes: 30 * 24 * 60,
    ...overrides,
  };
}

function account(overrides: Partial<SourceAccount> = {}): SourceAccount {
  return {
    sourceId: SOURCE,
    externalId: ACCOUNT,
    name: "Command Code",
    platform: "commandcode",
    kind: "subscription",
    plan: null,
    parentExternalId: null,
    subjectKey: null,
    ...overrides,
  };
}

function usageFact(id: string, accountId = ACCOUNT) {
  return {
    sourceId: SOURCE,
    externalId: id,
    occurredAt: "2026-11-10T00:00:00.000Z",
    accountExternalId: accountId,
    model: "deepseek-v4.1-flash",
    upstreamModel: null,
    tier: null,
    tokens: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
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
}

function ingestBatch(parts: {
  accounts?: SourceAccount[];
  usage?: ReturnType<typeof usageFact>[];
  quotas?: QuotaFact[];
}) {
  return {
    batchId: crypto.randomUUID(),
    collector: { name: "meterleaf-collector", version: "test" },
    accounts: parts.accounts ?? [],
    usage: parts.usage ?? [],
    quotas: parts.quotas ?? [],
  };
}

const NOW = "2026-11-10T01:00:00.000Z";

function storedQuotas(store: LedgerStore) {
  return store
    .quotas()
    .filter((row) => row.fact.accountExternalId === ACCOUNT)
    .map((row) => [row.fact.window, row.fact.percent, row.fact.sampledAt]);
}

describe("服务端 Command Code 额度刷新与账本单写入方", () => {
  test("空账本首次刷新原子建户并写入额度", async () => {
    const { store } = managedStore();
    const api = fakeApi();
    const refresher = new CommandCodeQuotaRefresher({
      key: API_KEY,
      account: { sourceId: SOURCE, accountExternalId: ACCOUNT },
      save: (update, at) => store.saveProviderQuotaUpdate(update, at),
      diagnostics: silentLogger,
      fetch: api.fetch,
      now: () => Date.parse(NOW),
    });
    refresher.updatePresence("page", true);
    await refresher.settled();
    expect(store.accounts()).toEqual([
      account({
        plan: "pro",
        subjectKey: commandCodeSubjectKey("org_123", "acme"),
      }),
    ]);
    expect(store.getState(commandCodeIdentityStateKey(SOURCE, ACCOUNT))).toBe(
      commandCodeSubjectKey("org_123", "acme"),
    );
    expect(storedQuotas(store).map(([window]) => window)).toEqual([
      "five-hour",
      "seven-day",
      "monthly",
    ]);
    expect(store.revision()).toBeGreaterThan(0);
  });

  test("已有账户首次绑定时没有 planId，主体摘要仍落盘且保留已知套餐", () => {
    const { store } = managedStore();
    store.saveAccounts([account({ plan: "max" })], NOW);
    const result = store.saveProviderQuotaUpdate(
      {
        sourceId: SOURCE,
        accountExternalId: ACCOUNT,
        identityDigest: DIGEST_A,
        observedPlan: null,
        quotas: [],
      },
      NOW,
    );
    expect(result).toBe("saved");
    expect(store.accounts()[0]).toMatchObject({
      plan: "max",
      subjectKey: DIGEST_A,
    });
    expect(store.getState(commandCodeIdentityStateKey(SOURCE, ACCOUNT))).toBe(
      DIGEST_A,
    );
  });

  test("异平台或 unknown 账户整体拒绝，主体摘要变化拒绝混户", () => {
    for (const platform of ["unknown", "opencode-go"]) {
      const { store, warnings } = managedStore();
      store.saveAccounts([account({ platform })], NOW);
      expect(
        store.saveProviderQuotaUpdate(
          {
            sourceId: SOURCE,
            accountExternalId: ACCOUNT,
            identityDigest: DIGEST_A,
            observedPlan: "pro",
            quotas: [quota("monthly", 10, NOW)],
          },
          NOW,
        ),
      ).toBe("platform_conflict");
      expect(warnings).toEqual(["command_code.account_platform_conflict"]);
      expect(store.accounts()[0]!.platform).toBe(platform);
      expect(store.quotas()).toHaveLength(0);
      expect(
        store.getState(commandCodeIdentityStateKey(SOURCE, ACCOUNT)),
      ).toBeNull();
    }
    const { store, warnings } = managedStore();
    const update = (digest: string, percent: number) =>
      store.saveProviderQuotaUpdate(
        {
          sourceId: SOURCE,
          accountExternalId: ACCOUNT,
          identityDigest: digest,
          observedPlan: "pro",
          quotas: [quota("monthly", percent, NOW)],
        },
        NOW,
      );
    expect(update(DIGEST_A, 10)).toBe("saved");
    expect(update(DIGEST_B, 50)).toBe("identity_mismatch");
    expect(warnings).toEqual(["command_code.identity_mismatch"]);
    expect(storedQuotas(store)).toEqual([["monthly", 10, NOW]]);
  });

  test("服务端托管账户：采集器额度被跳过、异平台资料不能占坑、套餐以服务端为准", () => {
    // ingest 先到（异平台、unknown）：不建户，用量照常入账。
    for (const platform of ["unknown", "openai"]) {
      const { store, warnings } = managedStore();
      store.saveIngestBatch(
        SOURCE,
        ingestBatch({
          accounts: [account({ platform, plan: "plus" })],
          usage: [usageFact("u1")],
          quotas: [quota("monthly", 99, NOW)],
        }),
        NOW,
      );
      expect(store.accounts()).toEqual([]);
      expect(store.usage("2026-11-01T00:00:00Z", NOW)).toHaveLength(1);
      expect(store.quotas()).toHaveLength(0);
      expect(warnings).toEqual(["command_code.account_platform_conflict"]);
      // 服务端随后建户成功。
      expect(
        store.saveProviderQuotaUpdate(
          {
            sourceId: SOURCE,
            accountExternalId: ACCOUNT,
            identityDigest: DIGEST_A,
            observedPlan: "pro",
            quotas: [quota("monthly", 20, NOW)],
          },
          NOW,
        ),
      ).toBe("saved");
      expect(store.accounts()[0]).toMatchObject({
        platform: "commandcode",
        plan: "pro",
      });
    }
    // ingest 先到（同平台）：允许建户，但不采用采集器套餐与额度。
    const { store, warnings } = managedStore();
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [
          account({ name: "我的 CC", plan: "team", subjectKey: DIGEST_A }),
        ],
        usage: [usageFact("u1")],
        quotas: [quota("monthly", 99, NOW)],
      }),
      NOW,
    );
    expect(store.accounts()).toEqual([account({ name: "我的 CC" })]);
    expect(store.quotas()).toHaveLength(0);
    expect(warnings).toEqual([]);
    // 服务端先到之后，较旧采集器批次不能覆盖服务端套餐、主体或额度。
    const serverAt = "2026-11-10T00:30:00.000Z";
    store.saveProviderQuotaUpdate(
      {
        sourceId: SOURCE,
        accountExternalId: ACCOUNT,
        identityDigest: DIGEST_A,
        observedPlan: "max",
        quotas: [quota("monthly", 30, serverAt)],
      },
      serverAt,
    );
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ name: "改名", plan: "free", subjectKey: null })],
        usage: [usageFact("u2")],
        quotas: [quota("monthly", 5, "2026-11-10T00:10:00.000Z")],
      }),
      NOW,
    );
    expect(store.accounts()[0]).toMatchObject({
      name: "改名",
      plan: "max",
      subjectKey: DIGEST_A,
    });
    expect(storedQuotas(store)).toEqual([["monthly", 30, serverAt]]);
    expect(store.usage("2026-11-01T00:00:00Z", NOW)).toHaveLength(2);
    // 采集器带来不同主体时拒绝改写账户。
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ name: "别的组织", subjectKey: DIGEST_B })],
      }),
      NOW,
    );
    expect(store.accounts()[0]!.name).toBe("改名");
    expect(warnings).toEqual(["command_code.identity_mismatch"]);
  });

  test("服务端停用后采集器以不同组织接手被拒绝，同组织可继续", () => {
    const dir = mkdtempSync(join(tmpdir(), "meterleaf-cc-"));
    const path = join(dir, "ledger.sqlite");
    const first = new LedgerStore(path, defaultPriceBook, {
      serverManagedQuotaAccounts: new Set([ref(SOURCE, ACCOUNT)]),
    });
    first.saveProviderQuotaUpdate(
      {
        sourceId: SOURCE,
        accountExternalId: ACCOUNT,
        identityDigest: DIGEST_A,
        observedPlan: "pro",
        quotas: [quota("monthly", 30, "2026-11-10T00:00:00.000Z")],
      },
      "2026-11-10T00:00:00.000Z",
    );
    first.close();
    // 重启后不再托管：同一个账本由采集器接手。
    const collectorWarnings: CommandCodeWarning[] = [];
    const second = new LedgerStore(path, defaultPriceBook, {
      onCommandCodeWarning: (event) => collectorWarnings.push(event),
    });
    second.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "team", subjectKey: DIGEST_B })],
        usage: [usageFact("u1")],
        quotas: [quota("monthly", 80, "2026-11-10T00:40:00.000Z")],
      }),
      NOW,
    );
    expect(second.accounts()[0]).toMatchObject({
      plan: "pro",
      subjectKey: DIGEST_A,
    });
    expect(storedQuotas(second)).toEqual([
      ["monthly", 30, "2026-11-10T00:00:00.000Z"],
    ]);
    expect(second.usage("2026-11-01T00:00:00Z", NOW)).toHaveLength(1);
    expect(collectorWarnings).toEqual(["command_code.identity_mismatch"]);
    second.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "max", subjectKey: DIGEST_A })],
        quotas: [quota("monthly", 40, "2026-11-10T00:45:00.000Z")],
      }),
      NOW,
    );
    expect(second.accounts()[0]).toMatchObject({
      plan: "max",
      subjectKey: DIGEST_A,
    });
    expect(storedQuotas(second).at(-1)).toEqual([
      "monthly",
      40,
      "2026-11-10T00:45:00.000Z",
    ]);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("已绑定账户的额度批次缺账户条目或 subjectKey 为 null 时跳过额度与套餐，用量照常", () => {
    const { store, warnings } = managedStore(false);
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "pro", subjectKey: DIGEST_A })],
        quotas: [quota("monthly", 10, "2026-11-10T00:00:00.000Z")],
      }),
      NOW,
    );
    expect(store.getState(commandCodeIdentityStateKey(SOURCE, ACCOUNT))).toBe(
      DIGEST_A,
    );
    // 缺账户条目。
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        usage: [usageFact("u1")],
        quotas: [quota("monthly", 20, "2026-11-10T00:10:00.000Z")],
      }),
      NOW,
    );
    // 账户条目没有摘要，还想改套餐。
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "max", subjectKey: null })],
        usage: [usageFact("u2")],
        quotas: [quota("monthly", 30, "2026-11-10T00:20:00.000Z")],
      }),
      NOW,
    );
    expect(storedQuotas(store)).toEqual([
      ["monthly", 10, "2026-11-10T00:00:00.000Z"],
    ]);
    expect(store.accounts()[0]).toMatchObject({
      plan: "pro",
      subjectKey: DIGEST_A,
    });
    expect(store.usage("2026-11-01T00:00:00Z", NOW)).toHaveLength(2);
    expect(warnings).toEqual([
      "command_code.identity_mismatch",
      "command_code.identity_mismatch",
    ]);
    // 只带用量的无摘要账户条目不会把主体与套餐改回未知。
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: null, subjectKey: null })],
        usage: [usageFact("u3")],
      }),
      NOW,
    );
    expect(store.accounts()[0]).toMatchObject({
      plan: "pro",
      subjectKey: DIGEST_A,
    });
  });

  test("未绑定主体时，不带摘要的 Command Code 额度不写入", () => {
    const { store, warnings } = managedStore(false);
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "pro" })],
        usage: [usageFact("u1")],
        quotas: [quota("monthly", 10, NOW)],
      }),
      NOW,
    );
    expect(store.quotas()).toHaveLength(0);
    expect(store.accounts()[0]).toMatchObject({ plan: "pro" });
    expect(store.usage("2026-11-01T00:00:00Z", NOW)).toHaveLength(1);
    expect(warnings).toEqual(["command_code.identity_mismatch"]);
  });

  test("非 Command Code 账户的推送行为不变", () => {
    const { store, warnings } = managedStore(false);
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [
          account({
            externalId: "opencode-go",
            platform: "opencode-go",
            plan: "go",
          }),
        ],
        quotas: [
          quota("monthly", 10, NOW, {
            externalId: "opencode-go:monthly",
            accountExternalId: "opencode-go",
          }),
        ],
      }),
      NOW,
    );
    expect(store.quotas()).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("未变化防抖签名包含 planId 与 windowMinutes", async () => {
    let now = Date.parse(NOW);
    let subscription: unknown = SUBSCRIPTION;
    const saves: string[] = [];
    const api = fakeApi({
      "/alpha/billing/subscriptions": () => json(subscription),
    });
    const { store } = managedStore();
    const refresher = new CommandCodeQuotaRefresher({
      key: API_KEY,
      account: { sourceId: SOURCE, accountExternalId: ACCOUNT },
      save: (update, at) => {
        saves.push(String(update.observedPlan));
        return store.saveProviderQuotaUpdate(update, at);
      },
      diagnostics: silentLogger,
      fetch: api.fetch,
      now: () => now,
      intervalMs: 60_000,
    });
    const tick = async (ms: number) => {
      now += ms;
      refresher.updatePresence("page", true);
      await refresher.settled();
    };
    await tick(0);
    await tick(61_000); // 读数未变，不写。
    expect(saves).toEqual(["pro"]);
    subscription = { data: { ...SUBSCRIPTION.data, planId: "max" } };
    await tick(61_000);
    expect(saves).toEqual(["pro", "max"]);
    subscription = {
      data: {
        ...SUBSCRIPTION.data,
        planId: "max",
        currentPeriodStart: "2026-11-02T00:00:00Z",
      },
    };
    await tick(61_000);
    expect(saves).toEqual(["pro", "max", "max"]);
    await tick(61_000);
    await tick(61_000);
    await tick(61_000);
    await tick(61_000); // 超过 4 分钟未变也写一次，推进采样时间。
    expect(saves).toHaveLength(4);
  });

  test("刷新失败只记固定告警，不写入", async () => {
    const warnings: { event: string; fields: unknown }[] = [];
    const { store } = managedStore();
    const refresher = new CommandCodeQuotaRefresher({
      key: API_KEY,
      account: { sourceId: SOURCE, accountExternalId: ACCOUNT },
      save: (update, at) => store.saveProviderQuotaUpdate(update, at),
      diagnostics: {
        ...silentLogger,
        warn: (event, fields) => warnings.push({ event, fields }),
      },
      fetch: fakeApi({ "/alpha/whoami": () => json({ error: API_KEY }, 401) })
        .fetch,
      now: () => Date.parse(NOW),
    });
    refresher.updatePresence("page", true);
    await refresher.settled();
    expect(warnings).toEqual([
      { event: "command_code.quota_rejected", fields: { status: 401 } },
    ]);
    expect(JSON.stringify(warnings)).not.toContain(API_KEY);
    expect(store.accounts()).toEqual([]);
  });

  test("额度快照按账户与窗口生成外部标识", () => {
    expect(
      commandCodeQuotaFacts(
        [
          {
            window: "monthly",
            percent: 1.5,
            resetsAt: null,
            windowMinutes: null,
          },
        ],
        { sourceId: "s", accountExternalId: "a" },
        NOW,
      ),
    ).toEqual([
      {
        sourceId: "s",
        externalId: "a:monthly",
        accountExternalId: "a",
        window: "monthly",
        percent: 1.5,
        sampledAt: NOW,
        resetsAt: null,
        windowMinutes: null,
      },
    ]);
  });
});

describe("账本对 Command Code 账户的平台、主体与套餐约束", () => {
  test("服务端托管账户已存在且平台为 unknown 或 openai 时，采集器的 commandcode 资料被拒，用量照常", () => {
    for (const platform of ["unknown", "openai"]) {
      const { store, warnings } = managedStore();
      store.saveAccounts([account({ platform })], NOW);
      store.saveIngestBatch(
        SOURCE,
        ingestBatch({
          accounts: [account({ subjectKey: DIGEST_A, plan: "pro" })],
          usage: [usageFact("u1")],
          quotas: [quota("monthly", 10, NOW)],
        }),
        NOW,
      );
      expect(store.accounts()[0]).toMatchObject({ platform, plan: null });
      expect(storedQuotas(store)).toEqual([]);
      expect(warnings).toContain("command_code.account_platform_conflict");
      expect(
        store
          .usage()
          .map((row) => row.fact)
          .map((fact) => fact.externalId),
      ).toEqual(["u1"]);
    }
  });

  test("OTEL 映射到服务端托管账户时不补 anthropic 占位，服务端仍可建户", () => {
    const { store, warnings } = managedStore();
    store.saveRequestAccounts(
      SOURCE,
      [
        {
          requestId: "req_1",
          accountUuid: ACCOUNT,
          organizationUuid: null,
          sessionId: null,
          model: null,
          occurredAt: NOW,
        },
      ],
      NOW,
    );
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({ usage: [usageFact("req_1:a", "other")] }),
      NOW,
    );
    // 先有用量、后到映射的改写路径同样不补占位。
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({ usage: [usageFact("req_2:a", "other")] }),
      NOW,
    );
    store.saveRequestAccounts(
      SOURCE,
      [
        {
          requestId: "req_2",
          accountUuid: ACCOUNT,
          organizationUuid: null,
          sessionId: null,
          model: null,
          occurredAt: NOW,
        },
      ],
      NOW,
    );
    expect(store.accounts()).toEqual([]);
    expect(
      store
        .usage()
        .map((row) => row.fact)
        .map((fact) => [fact.externalId, fact.accountExternalId])
        .sort(),
    ).toEqual([
      ["req_1:a", ACCOUNT],
      ["req_2:a", ACCOUNT],
    ]);
    expect(warnings).toContain("command_code.request_account_skipped");
    expect(
      store.saveProviderQuotaUpdate(
        {
          sourceId: SOURCE,
          accountExternalId: ACCOUNT,
          identityDigest: DIGEST_A,
          observedPlan: "pro",
          quotas: [quota("monthly", 10, NOW)],
        },
        NOW,
      ),
    ).toBe("saved");
    expect(store.accounts()[0]).toMatchObject({ platform: "commandcode" });
  });

  test("过时的套餐变化只丢弃套餐，主体摘要仍与 sync_state 同一事务落盘", () => {
    const { store } = managedStore(false);
    store.saveAccounts([account({ plan: "pro" })], "2026-11-09T00:00:00.000Z");
    // 先观察到更新的额度快照，使之后采样更早的套餐变化判为过时。
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "pro", subjectKey: DIGEST_A })],
        quotas: [quota("monthly", 10, "2026-11-10T00:30:00.000Z")],
      }),
      NOW,
    );
    expect(store.accounts()[0]).toMatchObject({
      plan: "pro",
      subjectKey: DIGEST_A,
    });
    const fresh = managedStore(false).store;
    fresh.saveAccounts([account({ plan: "pro" })], "2026-11-09T00:00:00.000Z");
    fresh.saveQuotas([quota("seven-day", 5, "2026-11-10T00:30:00.000Z")], NOW);
    fresh.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "max", subjectKey: DIGEST_A })],
        quotas: [quota("monthly", 10, "2026-11-10T00:10:00.000Z")],
      }),
      NOW,
    );
    expect(fresh.accounts()[0]).toMatchObject({
      plan: "pro",
      subjectKey: DIGEST_A,
    });
    expect(fresh.getState(commandCodeIdentityStateKey(SOURCE, ACCOUNT))).toBe(
      DIGEST_A,
    );
  });

  test("已绑定账户：纯用量批次改平台被拒，保留平台、父账户、主体与套餐", () => {
    const { store, warnings } = managedStore(false);
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "pro", subjectKey: DIGEST_A })],
        quotas: [quota("monthly", 10, NOW)],
      }),
      NOW,
    );
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [
          account({
            platform: "openai",
            plan: "plus",
            parentExternalId: "parent",
            subjectKey: null,
          }),
        ],
        usage: [usageFact("u1")],
        quotas: [quota("monthly", 50, "2026-11-10T00:59:00.000Z")],
      }),
      NOW,
    );
    expect(store.accounts()[0]).toEqual(
      account({ plan: "pro", subjectKey: DIGEST_A }),
    );
    expect(warnings).toContain("command_code.account_platform_conflict");
    expect(storedQuotas(store).map(([, percent]) => percent)).toEqual([10]);
    expect(
      store
        .usage()
        .map((row) => row.fact)
        .map((fact) => fact.externalId),
    ).toEqual(["u1"]);
  });

  test("已绑定账户：纯用量批次换主体被拒，不改写主体与套餐", () => {
    const { store, warnings } = managedStore(false);
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "pro", subjectKey: DIGEST_A })],
      }),
      NOW,
    );
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [account({ plan: "max", subjectKey: DIGEST_B })],
        usage: [usageFact("u1")],
      }),
      NOW,
    );
    expect(store.accounts()[0]).toMatchObject({
      plan: "pro",
      subjectKey: DIGEST_A,
    });
    expect(store.getState(commandCodeIdentityStateKey(SOURCE, ACCOUNT))).toBe(
      DIGEST_A,
    );
    expect(warnings).toEqual(["command_code.identity_mismatch"]);
    expect(
      store
        .usage()
        .map((row) => row.fact)
        .map((fact) => fact.externalId),
    ).toEqual(["u1"]);
  });

  test("服务端观测到更笼统的套餐（team-premium → team）也如实覆盖", () => {
    const { store } = managedStore();
    const save = (plan: string | null) =>
      store.saveProviderQuotaUpdate(
        {
          sourceId: SOURCE,
          accountExternalId: ACCOUNT,
          identityDigest: DIGEST_A,
          observedPlan: plan,
          quotas: [],
        },
        NOW,
      );
    expect(save("team-premium")).toBe("saved");
    expect(store.accounts()[0]!.plan).toBe("team-premium");
    expect(save("team")).toBe("saved");
    expect(store.accounts()[0]!.plan).toBe("team");
    // 没有 planId 时保留已知套餐。
    save(null);
    expect(store.accounts()[0]!.plan).toBe("team");
  });

  test("采集器托管账户同摘要的非过时批次把 team-premium 改为 team；过时与异摘要批次保留原套餐", () => {
    const { store, warnings } = managedStore(false);
    // 每批在采样后一分钟入账。
    const push = (plan: string, subjectKey: string, sampledAt: string) =>
      store.saveIngestBatch(
        SOURCE,
        ingestBatch({
          accounts: [account({ plan, subjectKey })],
          quotas: [quota("monthly", 10, sampledAt)],
        }),
        new Date(Date.parse(sampledAt) + 60_000).toISOString(),
      );
    push("team-premium", DIGEST_A, "2026-11-10T00:10:00.000Z");
    expect(store.accounts()[0]!.plan).toBe("team-premium");
    push("team", DIGEST_A, "2026-11-10T00:20:00.000Z");
    expect(store.accounts()[0]!.plan).toBe("team");
    // 采样早于已观察到的套餐边界：过时，保留 team（细化写法也不能借过时批次改回）。
    push("team-premium", DIGEST_A, "2026-11-10T00:15:00.000Z");
    expect(store.accounts()[0]!.plan).toBe("team");
    // 换主体的批次不改写套餐。
    push("enterprise", DIGEST_B, "2026-11-10T00:30:00.000Z");
    expect(store.accounts()[0]).toMatchObject({
      plan: "team",
      subjectKey: DIGEST_A,
    });
    expect(warnings).toEqual(["command_code.identity_mismatch"]);
  });

  test("账户 id 与 planId 为原型键 constructor 时按普通字符串处理", () => {
    const { store } = managedStore(false);
    store.saveIngestBatch(
      SOURCE,
      ingestBatch({
        accounts: [
          account({
            externalId: "constructor",
            plan: "constructor",
            subjectKey: DIGEST_A,
          }),
        ],
      }),
      NOW,
    );
    expect(
      store.saveProviderQuotaUpdate(
        {
          sourceId: SOURCE,
          accountExternalId: "constructor",
          identityDigest: DIGEST_A,
          observedPlan: "toString",
          quotas: [],
        },
        NOW,
      ),
    ).toBe("saved");
    expect(store.accounts()[0]).toMatchObject({
      externalId: "constructor",
      plan: "toString",
    });
  });
});
