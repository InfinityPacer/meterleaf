import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollectorConfig } from "../src/collector/config";
import { pushOutbox } from "../src/collector/push";
import { CollectorState } from "../src/collector/state";
import type {
  QuotaFact,
  SourceAccount,
  UsageFact,
} from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { valueUsage } from "../src/domain/pricing";
import { quotaView, type CollectedQuota } from "../src/domain/quota";
import { createApp } from "../src/server/app";
import { indexedSnapshot, liveSnapshot } from "../src/server/snapshot";
import { commandCodeSubjectKey } from "../src/shared/commandcode";
import type { IngestUsage } from "../src/shared/ingest";
import type { AccountWindow, LedgerAccount } from "../src/shared/report";
import { LedgerStore } from "../src/storage/ledger";
import { QuotaWindow } from "../src/web/components/QuotaWindow";
import {
  accountQuotaWindows,
  monthlyQuotaLabel,
  hasDetailQuota,
  quotaLabel,
  quotaPeriodKnown,
  withExtraQuotaWindows,
  visibleQuotaWindows,
} from "../src/web/lib/quota-display";
import { createHash } from "node:crypto";

const DIGEST = commandCodeSubjectKey("org_1", "acme");
const INGEST_KEY = "mlk_commandcode-e2e-key";
const SOURCE = "mac";

function usage(id: string, occurredAt: string): IngestUsage {
  return {
    externalId: id,
    occurredAt,
    accountExternalId: "commandcode",
    model: "deepseek/deepseek-v4.1-flash",
    tier: null,
    tokens: {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 500_000,
      cacheWrite: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    metadata: { origin: "omp_local" },
  };
}

describe("Command Code 月窗端到端", () => {
  test("pushOutbox → 入账接口 → 账本 → 两条快照路径都给出账单周期与采样时间回退", async () => {
    const store = new LedgerStore(":memory:", defaultPriceBook);
    const app = createApp({
      ledgerStatus: () => ({ revision: store.revision(), updatedAt: null }),
      snapshot: () => {
        throw new Error("not used");
      },
      ingest: {
        keys: [
          {
            sourceId: SOURCE,
            sha256: createHash("sha256").update(INGEST_KEY).digest("hex"),
          },
        ],
        save: (sourceId, batch) =>
          store.saveIngestBatch(sourceId, batch, "2026-11-10T12:00:00.000Z"),
      },
    });
    const state = new CollectorState(":memory:");
    state.upsertAccount({
      externalId: "commandcode",
      name: "Command Code",
      platform: "commandcode",
      kind: "subscription",
      plan: "pro",
      subjectKey: DIGEST,
    });
    state.recordSourceUsage("omp", usage("u1", "2026-11-05T00:00:00.000Z"));
    const sampledAt = "2026-11-10T11:58:00.000Z";
    state.recordQuota(
      {
        hash: "monthly-1",
        quotas: [
          {
            accountExternalId: "commandcode",
            window: "monthly",
            percent: 45.25,
            sampledAt,
            resetsAt: "2026-12-01T00:00:00.000Z",
            windowMinutes: 30 * 24 * 60,
          },
        ],
      },
      "commandcode:commandcode",
      { platform: "commandcode", subjectKey: DIGEST },
    );
    const config = {
      server: "http://meterleaf.test",
      sourceId: SOURCE,
      key: INGEST_KEY,
      createdAt: "2026-09-01T00:00:00Z",
    } as CollectorConfig;
    const result = await pushOutbox(state, config, {
      fetch: (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const response = await app.inject({
          method: "POST",
          url: url.pathname,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          payload: String(init?.body),
        });
        return new Response(response.body, { status: response.statusCode });
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ error: null, quotas: 1, usage: 1 });
    expect(store.accounts()[0]).toMatchObject({
      platform: "commandcode",
      subjectKey: DIGEST,
    });
    const now = "2026-11-10T12:00:00.000Z";
    const live = liveSnapshot(store, null, 30, now);
    const liveAccount = live.accounts.find(
      (item) => item.platform === "commandcode",
    )!;
    const usageRows = store.usage("2026-11-01T00:00:00.000Z", now);
    const indexed = indexedSnapshot(
      store,
      null,
      now,
      "subscription",
      (_id, start, end) => {
        const rows = usageRows.filter(
          (row) => row.fact.occurredAt >= start && row.fact.occurredAt <= end,
        );
        return {
          usd: rows
            .reduce(
              (sum, row) =>
                sum + Number(row.valuation.subscriptionUsd.amount ?? 0),
              0,
            )
            .toString(),
          credits: null,
          count: rows.length,
          tokens: null,
          cacheRate: null,
        };
      },
    );
    const indexedAccount = indexed.accounts.find(
      (item) => item.platform === "commandcode",
    )!;
    for (const account of [liveAccount, indexedAccount]) {
      expect(account.sampledAt).toBe(sampledAt);
      expect(account.monthly).toMatchObject({
        percent: 45.25,
        state: "active",
        startsAt: "2026-11-01T00:00:00.000Z",
        estimate: { usd: null, credits: null, reason: "percent-unavailable" },
      });
      expect(account.monthly!.periodRequests).toBe(1);
      expect(Number(account.monthly!.periodUsd)).toBeGreaterThan(0);
      const windows = accountQuotaWindows(account, now);
      expect(windows.map((item) => [item.key, item.label])).toEqual([
        ["monthly", "账单周期"],
      ]);
      expect(quotaLabel(account.monthly!, now, "commandcode")).toBe(
        "已用 45.3%",
      );
      // 其余平台沿用上游原值，不做位数处理。
      expect(quotaLabel(account.monthly!, now)).toBe("已用 45.25%");
      expect(quotaLabel(account.monthly!, now, "opencode-go")).toBe(
        "已用 45.25%",
      );
    }
    state.close();
    await app.close();
  });
});

const NOW = "2026-11-10T12:00:00.000Z";

function fact(
  window: QuotaFact["window"],
  percent: number | null,
  sampledAt: string,
  overrides: Partial<QuotaFact> = {},
): CollectedQuota {
  return {
    fact: {
      sourceId: SOURCE,
      externalId: `cc:${window}`,
      accountExternalId: "cc",
      window,
      percent,
      sampledAt,
      resetsAt: "2026-12-01T00:00:00.000Z",
      windowMinutes: 30 * 24 * 60,
      ...overrides,
    },
    collectedAt: sampledAt,
  };
}

/**
 * 经生产入口建库：Command Code 走服务端额度入口 saveProviderQuotaUpdate（带有效主体摘要），
 * 其他平台走推送入账 saveIngestBatch，不直接写账户表或额度表。
 */
function storeWith(
  platform: string,
  quotas: CollectedQuota[],
  usageAt: string[] = [],
) {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  if (platform === "commandcode") {
    for (const facts of quotas.length ? quotas.map((row) => [row.fact]) : [[]])
      expect(
        store.saveProviderQuotaUpdate(
          {
            sourceId: SOURCE,
            accountExternalId: "cc",
            identityDigest: DIGEST,
            observedPlan: null,
            quotas: facts,
          },
          NOW,
        ),
      ).toBe("saved");
  } else {
    const account: SourceAccount = {
      sourceId: SOURCE,
      externalId: "cc",
      name: platform,
      platform,
      kind: "subscription",
      plan: null,
      parentExternalId: null,
      subjectKey: null,
    };
    store.saveIngestBatch(
      SOURCE,
      {
        batchId: crypto.randomUUID(),
        collector: { name: "test", version: "0" },
        accounts: [account],
        usage: [],
        quotas: quotas.map((row) => row.fact),
      },
      NOW,
    );
  }
  store.saveIngestBatch(
    SOURCE,
    {
      batchId: crypto.randomUUID(),
      collector: { name: "test", version: "0" },
      accounts: [],
      usage: usageAt.map((at, index): UsageFact => ({
        ...usage(`u${index}`, at),
        accountExternalId: "cc",
        sourceId: SOURCE,
        upstreamModel: null,
        gatewayCost: null,
        gatewayBilled: null,
        upstreamUsd: null,
        upstreamCredits: null,
      })),
      quotas: [],
    },
    NOW,
  );
  return store;
}

function accountOf(
  platform: string,
  quotas: CollectedQuota[],
  usageAt: string[] = [],
) {
  const store = storeWith(platform, quotas, usageAt);
  return liveSnapshot(store, null, 60, NOW).accounts.find(
    (item) => item.platform === platform,
  )!;
}

function render(selection: ReturnType<typeof accountQuotaWindows>[number]) {
  return renderToStaticMarkup(
    createElement(QuotaWindow, { selection, asOf: NOW }),
  );
}

describe("Command Code 月窗展示与估算语义", () => {
  test("有百分比缺重置与周期：仍显示账单周期，本地用量显示 N/A", () => {
    const account = accountOf("commandcode", [
      fact("monthly", 12.5, "2026-11-10T11:59:00.000Z", {
        resetsAt: null,
        windowMinutes: null,
      }),
    ]);
    const windows = accountQuotaWindows(account, NOW);
    expect(windows.map((item) => item.label)).toEqual(["账单周期"]);
    expect(quotaPeriodKnown(account.monthly!, NOW)).toBe(false);
    const html = render(windows[0]!);
    expect(html).toContain("已用 12.5%");
    expect(html).toContain("重置未知");
    expect(html).toContain('aria-label="账单周期费用">N/A');
  });

  test("有完整周期缺百分比：进度显示 N/A，本地费用、Tokens、请求数与命中率照常显示", () => {
    const account = accountOf(
      "commandcode",
      [fact("monthly", null, "2026-11-10T11:59:00.000Z")],
      ["2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
    );
    const windows = accountQuotaWindows(account, NOW);
    expect(windows.map((item) => item.label)).toEqual(["账单周期"]);
    expect(account.monthly).toMatchObject({ percent: null, periodRequests: 2 });
    const html = render(windows[0]!);
    expect(html).toContain('aria-valuetext="N/A"');
    expect(html).toContain("width:0%");
    expect(html).toContain("12/01");
    expect(html).not.toContain('aria-label="账单周期费用">N/A');
    expect(html).toContain("2 次");
    expect(html).toContain("命中 33.3%");
    // OpenCode Go 维持既有规则：缺百分比不显示。
    const go = accountOf("opencode-go", [
      fact("monthly", null, "2026-11-10T11:59:00.000Z"),
    ]);
    expect(accountQuotaWindows(go, NOW)).toEqual([]);
  });

  test("充值后百分比真实下降，OpenCode Go 仍忽略过时回落", () => {
    const readings = [
      fact("monthly", 40, "2026-11-08T00:00:00.000Z"),
      fact("monthly", 30, "2026-11-10T11:00:00.000Z"),
    ];
    expect(accountOf("commandcode", readings).monthly!.percent).toBe(30);
    expect(accountOf("opencode-go", readings).monthly!.percent).toBe(40);
  });

  test("账单周期不外推整周期额度，周期内本地统计照常保留", () => {
    const readings = [5, 10, 15, 20, 25, 30].map((percent, index) =>
      fact(
        "monthly",
        percent,
        new Date(
          Date.parse("2026-11-02T00:00:00Z") + index * 86_400_000,
        ).toISOString(),
      ),
    );
    const usageAt = [0, 1, 2, 3, 4, 5].map((index) =>
      new Date(
        Date.parse("2026-11-01T12:00:00Z") + index * 86_400_000,
      ).toISOString(),
    );
    const cc = accountOf("commandcode", readings, usageAt);
    expect(cc.monthly!.estimate).toEqual({
      usd: null,
      credits: null,
      deltaPercent: null,
      reason: "percent-unavailable",
    });
    expect(Number(cc.monthly!.periodUsd)).toBeGreaterThan(0);
    expect(cc.monthly!.periodRequests).toBe(6);
    expect(cc.monthly!.periodTokens).toBeGreaterThan(0);
    // 其他平台同样数据仍给出预估。
    const go = accountOf("opencode-go", readings, usageAt);
    expect(go.monthly!.estimate?.reason).toBe("eligible");
  });

  test("精确整数读数不做 0.5 到达校正，重复小数原样参与", () => {
    const window = (percent: number, day: number) =>
      fact(
        "seven-day",
        percent,
        new Date(
          Date.parse("2026-11-05T00:00:00Z") + day * 3_600_000,
        ).toISOString(),
        {
          resetsAt: "2026-11-12T00:00:00.000Z",
          windowMinutes: 7 * 24 * 60,
        },
      );
    const history = [window(1, 1), window(2, 2), window(3, 3)];
    const rows = [0, 1, 2, 3].map((hour) => {
      const item: UsageFact = {
        ...usage(
          `r${hour}`,
          new Date(
            Date.parse("2026-11-05T00:30:00Z") + hour * 3_600_000,
          ).toISOString(),
        ),
        accountExternalId: "cc",
        sourceId: SOURCE,
        upstreamModel: null,
        gatewayCost: null,
        gatewayBilled: null,
        upstreamUsd: null,
        upstreamCredits: null,
      };
      return { fact: item, valuation: valueUsage(item, defaultPriceBook) };
    });
    const now = "2026-11-05T04:00:00.000Z";
    const rounded = quotaView(history, rows, now)!;
    const exact = quotaView(history, rows, now, false, {
      roundedPercent: false,
    })!;
    expect(rounded.estimate.usd).not.toBeNull();
    expect(exact.estimate.usd).not.toBeNull();
    expect(exact.estimate.usd).not.toBe(rounded.estimate.usd);
    // 快照路径对 commandcode 的 5h/7d 传入 roundedPercent: false，其他平台沿用默认。
    const ccStore = storeWith(
      "commandcode",
      history,
      rows.map((row) => row.fact.occurredAt),
    );
    const ccWeek = liveSnapshot(ccStore, null, 60, now).accounts.find(
      (item) => item.platform === "commandcode",
    )!.sevenDay!;
    const goStore = storeWith(
      "opencode-go",
      history,
      rows.map((row) => row.fact.occurredAt),
    );
    const goWeek = liveSnapshot(goStore, null, 60, now).accounts.find(
      (item) => item.platform === "opencode-go",
    )!.sevenDay!;
    expect(ccWeek.estimate?.usd).toBe(exact.estimate.usd);
    expect(goWeek.estimate?.usd).toBe(rounded.estimate.usd);
    const repeating: AccountWindow = {
      percent: 100 / 3,
      resetsAt: null,
      state: "active",
    };
    const cc = (window: AccountWindow) =>
      quotaLabel(window, now, "commandcode");
    expect(cc(repeating)).toBe("已用 33.3%");
    expect(cc({ ...repeating, percent: 45 })).toBe("已用 45%");
    expect(cc({ ...repeating, percent: 45.04 })).toBe("已用 45%");
  });

  test("周额度用尽时紧凑视图只留周额度，账单周期让位", () => {
    const week: AccountWindow = {
      percent: 100,
      sampledAt: NOW,
      resetsAt: "2026-11-12T00:00:00.000Z",
      state: "active",
    };
    const monthly: AccountWindow = {
      percent: null,
      sampledAt: NOW,
      resetsAt: "2026-12-01T00:00:00.000Z",
      startsAt: "2026-11-01T00:00:00.000Z",
      state: "active",
    };
    const account: Pick<
      LedgerAccount,
      "fiveHour" | "sevenDay" | "sevenDayFable" | "monthly" | "platform"
    > = {
      fiveHour: null,
      sevenDay: week,
      monthly,
      platform: "commandcode",
    };
    expect(accountQuotaWindows(account, NOW).map((item) => item.key)).toEqual([
      "sevenDay",
    ]);
    // 完整视图保留全部有效周期（与 OpenCode Go 相同的既有规则）。
    const full = {
      ...account,
      fiveHour: { ...week, percent: 20, resetsAt: "2026-11-10T15:00:00.000Z" },
    };
    expect(accountQuotaWindows(full, NOW).map((item) => item.key)).toEqual([
      "sevenDay",
    ]);
    expect(
      accountQuotaWindows(full, NOW, false).map((item) => [
        item.key,
        item.label,
      ]),
    ).toEqual([
      ["fiveHour", "5h"],
      ["sevenDay", "7d"],
      ["monthly", "账单周期"],
    ]);
  });

  test("Command Code 百分比保留 1 位小数，[99.95, 100) 截断为 99.9；其他平台保持原值", () => {
    const at = (percent: number): AccountWindow => ({
      percent,
      sampledAt: NOW,
      resetsAt: "2026-12-01T00:00:00.000Z",
      startsAt: "2026-11-01T00:00:00.000Z",
      state: "active",
    });
    const cc = (percent: number) => quotaLabel(at(percent), NOW, "commandcode");
    expect(cc(99.96)).toBe("已用 99.9%");
    expect(cc(99.95)).toBe("已用 99.9%");
    expect(cc(99.94)).toBe("已用 99.9%");
    expect(cc(99.9)).toBe("已用 99.9%");
    expect(cc(100)).toBe("已用 100%");
    expect(cc(0.04)).toBe("已用 0%");
    expect(quotaLabel(at(45.25), NOW, "opencode-go")).toBe("已用 45.25%");
    expect(quotaLabel(at(99.96), NOW)).toBe("已用 99.96%");
    // 卡片与详情抽屉都按账户平台取文案。
    const [selection] = accountQuotaWindows(
      {
        fiveHour: null,
        sevenDay: null,
        monthly: at(99.96),
        platform: "commandcode",
      },
      NOW,
    );
    expect(selection!.platform).toBe("commandcode");
    expect(render(selection!)).toContain("已用 99.9%");
    const [go] = accountQuotaWindows(
      {
        fiveHour: null,
        sevenDay: null,
        monthly: at(45.25),
        platform: "opencode-go",
      },
      NOW,
    );
    expect(go!.platform).toBeUndefined();
    expect(render(go!)).toContain("已用 45.25%");
  });

  test("Command Code 完整视图在周额度用尽时照常列出账单周期，OpenCode Go 两种视图都让位", () => {
    const week: AccountWindow = {
      percent: 100,
      sampledAt: NOW,
      resetsAt: "2026-11-12T00:00:00.000Z",
      state: "active",
    };
    const monthly: AccountWindow = {
      percent: 40,
      sampledAt: NOW,
      resetsAt: "2026-12-01T00:00:00.000Z",
      startsAt: "2026-11-01T00:00:00.000Z",
      state: "active",
    };
    const cc = {
      fiveHour: null,
      sevenDay: week,
      monthly,
      platform: "commandcode",
    };
    expect(accountQuotaWindows(cc, NOW).map((item) => item.key)).toEqual([
      "sevenDay",
    ]);
    expect(
      accountQuotaWindows(cc, NOW, false).map((item) => [item.key, item.label]),
    ).toEqual([
      ["sevenDay", "7d"],
      ["monthly", "账单周期"],
    ]);
    // OpenCode Go 保持既有行为：两种视图都只留用尽的周额度。
    const go = {
      fiveHour: null,
      sevenDay: week,
      monthly,
      platform: "opencode-go",
    };
    for (const prioritize of [true, false])
      expect(
        accountQuotaWindows(go, NOW, prioritize).map((item) => item.key),
      ).toEqual(["sevenDay"]);
  });

  test("停用估值的窗口缺周期时报 percent-unavailable，过期仍报 expired", () => {
    const noPeriod = fact("monthly", 30, "2026-11-10T11:00:00.000Z", {
      resetsAt: null,
      windowMinutes: null,
    });
    const disabled = quotaView([noPeriod], [], NOW, false, {
      disableEstimate: true,
    });
    expect(disabled!.startsAt).toBeNull();
    expect(disabled!.estimate.reason).toBe("percent-unavailable");
    // 不停用估值时仍报周期未知。
    expect(quotaView([noPeriod], [], NOW)!.estimate.reason).toBe(
      "window-unknown",
    );
    const expired = fact("monthly", 30, "2026-10-10T11:00:00.000Z", {
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    expect(
      quotaView([expired], [], NOW, false, { disableEstimate: true })!.estimate
        .reason,
    ).toBe("expired");
  });

  test("只有账单周期的 Command Code 账户打开详情抽屉并列出账单周期窗口", () => {
    const percentOnly: AccountWindow = {
      percent: 62.5,
      sampledAt: NOW,
      resetsAt: null,
      state: "active",
    };
    const resetOnly: AccountWindow = {
      percent: null,
      sampledAt: NOW,
      resetsAt: "2026-12-01T00:00:00.000Z",
      startsAt: "2026-11-01T00:00:00.000Z",
      state: "unknown",
    };
    for (const [monthly, status] of [
      [percentOnly, "已用 62.5%"],
      [resetOnly, "N/A"],
    ] as const) {
      const account = {
        fiveHour: null,
        sevenDay: null,
        monthly,
        platform: "commandcode",
      };
      expect(hasDetailQuota(account)).toBe(true);
      // 详情抽屉按完整视图取窗口，标题为“<名称> 窗口”。
      const detail = accountQuotaWindows(account, NOW, false);
      expect(detail.map((item) => `${item.label} 窗口`)).toEqual([
        "账单周期 窗口",
      ]);
      expect(quotaLabel(detail[0]!.window, NOW, detail[0]!.platform)).toBe(
        status,
      );
    }
    expect(
      hasDetailQuota({ fiveHour: null, sevenDay: null, monthly: null }),
    ).toBe(false);
  });

  test("桌面纯月窗入口只对 Command Code 开放，OpenCode Go 保持原有点击行为", () => {
    const monthly: AccountWindow = {
      percent: 40,
      sampledAt: NOW,
      resetsAt: "2026-12-01T00:00:00.000Z",
      state: "active",
    };
    const week: AccountWindow = {
      ...monthly,
      resetsAt: "2026-11-12T00:00:00.000Z",
    };
    expect(
      hasDetailQuota({
        platform: "commandcode",
        fiveHour: null,
        sevenDay: null,
        monthly,
      }),
    ).toBe(true);
    // 只有 1m 的 OpenCode Go 账户点击后仍进入请求明细。
    expect(
      hasDetailQuota({
        platform: "opencode-go",
        fiveHour: null,
        sevenDay: null,
        monthly,
      }),
    ).toBe(false);
    for (const windows of [
      { fiveHour: week, sevenDay: null },
      { fiveHour: null, sevenDay: week },
    ])
      expect(
        hasDetailQuota({ platform: "opencode-go", monthly, ...windows }),
      ).toBe(true);
  });

  test("OpenCode Go 月窗标签与显示规则不变", () => {
    expect(monthlyQuotaLabel("opencode-go")).toBe("1m");
    expect(monthlyQuotaLabel(undefined)).toBe("1m");
    expect(monthlyQuotaLabel("commandcode")).toBe("账单周期");
    const month: AccountWindow = {
      percent: 40,
      sampledAt: NOW,
      resetsAt: "2026-12-01T00:00:00Z",
      state: "active",
    };
    const shown = withExtraQuotaWindows(
      visibleQuotaWindows({ fiveHour: null, sevenDay: null }, NOW),
      { monthly: month, platform: "opencode-go" },
      NOW,
    );
    expect(
      shown.map((item) => [item.key, item.label, item.independent]),
    ).toEqual([["monthly", "1m", undefined]]);
    const unknown = withExtraQuotaWindows(
      [],
      { monthly: { ...month, state: "unknown", percent: 40 } },
      NOW,
    );
    expect(unknown).toEqual([]);
  });
});
