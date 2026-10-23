import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  QuotaFact,
  SourceAccount,
  UsageFact,
} from "../src/domain/connector";
import { defaultPriceBook } from "../src/domain/default-prices";
import { priceBookKey } from "../src/domain/pricing";
import { ReportInputCache } from "../src/server/report-inputs";
import { ReportProjection } from "../src/server/report-projection";
import { readReportView } from "../src/server/report-read";
import { ViewService } from "../src/server/view-service";
import type { ViewQuery } from "../src/shared/ledger-view";
import { LedgerStore } from "../src/storage/ledger";
import { LifetimeIndex } from "../src/storage/lifetime-index";
import { sourceFileState } from "../src/storage/source-file-state";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const SOURCE = "src";
const base = Date.parse("2026-10-20T00:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();
/** 周额度在 base 后 36 小时重置，五小时额度在 base 后 2 小时重置。 */
const weeklyReset = base + 36 * HOUR;
const fiveHourReset = base + 2 * HOUR;

function account(
  externalId: string,
  platform: string,
  kind: SourceAccount["kind"],
  plan: string | null,
): SourceAccount {
  return {
    sourceId: SOURCE,
    externalId,
    name: externalId,
    platform,
    kind,
    plan,
    parentExternalId: null,
    subjectKey: null,
  };
}

const accounts = [
  account("claude-a", "anthropic", "subscription", "max-20x"),
  account("claude-b", "anthropic", "subscription", null),
  account("codex", "openai", "subscription", "pro"),
  account("api", "openai", "api", null),
];

function usage(
  index: number,
  accountExternalId: string,
  at: number,
  model = "gpt-6-astra",
): UsageFact {
  return {
    sourceId: SOURCE,
    externalId: `req-${index}:msg-${index}`,
    accountExternalId,
    occurredAt: iso(at),
    model,
    upstreamModel: null,
    tier: "standard",
    tokens: {
      input: 100 + (index % 7),
      cacheRead: index % 3 === 0 ? null : 1000,
      cacheWrite: 10,
      cacheWrite5m: null,
      cacheWrite1h: null,
      output: 50,
      reasoning: null,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: {},
  };
}

function reading(
  accountExternalId: string,
  window: QuotaFact["window"],
  at: number,
  sampledAt: string | null = iso(at),
): QuotaFact {
  const minutes = window === "five-hour" ? 300 : 10080;
  const duration = minutes * MINUTE;
  const anchor = window === "five-hour" ? fiveHourReset : weeklyReset;
  const reset = anchor + Math.ceil((at - anchor + 1) / duration) * duration;
  return {
    sourceId: SOURCE,
    externalId: `${accountExternalId}:${window}:${at}`,
    accountExternalId,
    window,
    percent: Math.floor((1 - (reset - at) / duration) * 90),
    sampledAt,
    resetsAt: iso(reset),
    windowMinutes: minutes,
  };
}

/** 三周用量与每小时额度读数，包含合并、手动套餐与一条无法按文本比较的采样时间。 */
function seed(store: LedgerStore) {
  const facts: UsageFact[] = [];
  const quotas: QuotaFact[] = [];
  let index = 0;
  for (let at = base - 3 * WEEK; at <= base; at += 20 * MINUTE) {
    const owner = accounts[index % accounts.length]!;
    facts.push(
      usage(
        index++,
        owner.externalId,
        at,
        owner.platform === "anthropic"
          ? index % 5 === 0
            ? "claude-fable-5-1"
            : "claude-opus-5-5"
          : "gpt-6-astra",
      ),
    );
  }
  for (let at = base - 3 * WEEK; at <= base; at += HOUR)
    for (const owner of ["claude-a", "claude-b", "codex"]) {
      quotas.push(reading(owner, "five-hour", at));
      quotas.push(reading(owner, "seven-day", at));
      if (owner === "claude-a")
        quotas.push(reading(owner, "seven-day-fable", at));
    }
  quotas.push(
    reading("claude-b", "five-hour", base - DAY, "2026-10-19T08:00:00+08:00"),
  );
  store.saveIngestBatch(
    SOURCE,
    {
      batchId: "seed",
      collector: { name: "test", version: "1" },
      accounts,
      usage: facts,
      quotas,
    },
    iso(base),
  );
  store.setAccountPlan(`${SOURCE}:claude-b`, "max-5x");
  store.setAccountMerge(`${SOURCE}:codex`, `${SOURCE}:claude-a`);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "meterleaf-report-inputs-"));
  const path = join(dir, "ledger.sqlite");
  const writer = new LedgerStore(path, defaultPriceBook);
  seed(writer);
  const reader = new LedgerStore(path, defaultPriceBook, { readonly: true });
  return {
    path,
    writer,
    reader,
    async close() {
      reader.close();
      writer.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 模拟报表线程的一组索引；每组持有自己的窗口汇总缓存。 */
function indexes(store: LedgerStore, path: string) {
  const projection = new ReportProjection(store, path, ":memory:");
  const lifetime = new LifetimeIndex(":memory:", store, {
    priceBookKey: priceBookKey(store.book),
  });
  return {
    projection,
    lifetime,
    ensure() {
      projection.ensure();
      lifetime.ensure({
        ...sourceFileState(path),
        dataVersion: store.reportFingerprint(),
      });
    },
    close() {
      projection.close();
      lifetime.close();
    },
  };
}

const overview: ViewQuery = {
  filter: { days: 7, model: "all", account: "all", search: "" },
  unit: "usd",
  granularity: "day",
  dimension: "model",
  page: 0,
  pageSize: 5,
  sort: "occurredAt",
  desc: true,
};
const trend: ViewQuery = {
  filter: {
    days: 7,
    model: "all",
    account: `${SOURCE}:claude-b`,
    search: "",
  },
  unit: "tokens",
  granularity: "hour",
  dimension: "day",
  page: 0,
  pageSize: 1,
  sort: "occurredAt",
  desc: true,
};

test("cached report inputs produce the same views as fresh reads at every time", async () => {
  const ledger = await fixture();
  const warm = indexes(ledger.reader, ledger.path);
  const cold = indexes(ledger.reader, ledger.path);
  const inputs = new ReportInputCache(ledger.reader);
  const read = (
    set: ReturnType<typeof indexes>,
    cache: ReportInputCache,
    query: ViewQuery,
    now: number,
  ) =>
    ledger.reader.db.transaction(() => {
      set.ensure();
      return readReportView(
        { store: ledger.reader, ...set, inputs: cache },
        { query, basis: "subscription" },
        iso(now),
        false,
      ).result;
    })();
  try {
    // 依次跨过五小时和周额度重置，截取点后移。随后的写入让候选按周重置之后的时刻重新读取，
    // 再回拨时钟：较晚时刻的候选不含较早时刻需要的历史，必须重新读取。
    const steps: (number | "write")[] = [
      base + 10 * MINUTE,
      base + 20 * MINUTE,
      base + 3 * HOUR,
      base + 37 * HOUR,
      "write",
      base + 37 * HOUR,
      base + 3 * HOUR,
    ];
    expect(
      ledger.reader.reportQuotas(iso(base + 37 * HOUR)).length,
    ).toBeLessThan(ledger.reader.reportQuotas(iso(base + 3 * HOUR)).length);
    for (const now of steps) {
      if (now === "write") {
        ledger.writer.setAccountPlan(`${SOURCE}:claude-a`, "max-5x");
        continue;
      }
      for (const query of [overview, trend]) {
        const cached = read(warm, inputs, query, now);
        const fresh = read(
          cold,
          new ReportInputCache(ledger.reader),
          query,
          now,
        );
        expect(cached).toEqual(fresh);
        expect(
          ledger.reader.db.transaction(() => inputs.read(iso(now)))(),
        ).toEqual({
          accounts: ledger.reader.accounts(),
          merges: ledger.reader.accountMerges(),
          quotas: ledger.reader.reportQuotas(iso(now)),
        });
      }
    }
    const sample = read(warm, inputs, overview, base + 10 * MINUTE);
    // 预估逐点读取窗口汇总，确认比较覆盖了沿用的窗口与额度历史。
    expect(
      sample.accounts.some((item) => item.sevenDay?.estimate.usd != null),
    ).toBe(true);
    expect(sample.ledgerRevision).toBe(ledger.reader.revision());
  } finally {
    warm.close();
    cold.close();
    await ledger.close();
  }
});

test("every write that changes report inputs invalidates the cache", async () => {
  const ledger = await fixture();
  const inputs = new ReportInputCache(ledger.reader);
  const now = iso(base + 10 * MINUTE);
  const cachedRead = () =>
    ledger.reader.db.transaction(() => inputs.read(now))();
  const freshRead = () =>
    ledger.reader.db.transaction(() => ({
      accounts: ledger.reader.accounts(),
      merges: ledger.reader.accountMerges(),
      quotas: ledger.reader.reportQuotas(now),
    }))();
  const batch = (
    batchId: string,
    content: Partial<{
      accounts: SourceAccount[];
      usage: UsageFact[];
      quotas: QuotaFact[];
    }>,
  ) =>
    ledger.writer.saveIngestBatch(
      SOURCE,
      {
        batchId,
        collector: { name: "test", version: "1" },
        accounts: content.accounts ?? [],
        usage: content.usage ?? [],
        quotas: content.quotas ?? [],
      },
      now,
    );
  const writes: [string, () => void][] = [
    [
      "ingest quota snapshot",
      () =>
        batch("quota", {
          quotas: [reading("claude-a", "seven-day", base + 5 * MINUTE)],
        }),
    ],
    [
      "pulled quota snapshot",
      () =>
        ledger.writer.saveQuotas(
          [reading("claude-b", "five-hour", base + 6 * MINUTE)],
          now,
        ),
    ],
    [
      "ingest account plan change",
      () =>
        batch("plan", {
          accounts: [account("codex", "openai", "subscription", "plus")],
        }),
    ],
    [
      "OTEL placeholder account",
      () => {
        batch("otel-usage", {
          usage: [usage(900_001, "claude-a", base + MINUTE)],
        });
        ledger.writer.saveRequestAccounts(
          SOURCE,
          [
            {
              requestId: "req-900001",
              accountUuid: "otel-account",
              organizationUuid: null,
              sessionId: null,
              model: null,
              occurredAt: iso(base + MINUTE),
            },
          ],
          now,
        );
      },
    ],
    [
      "OTEL placeholder recreated by a replayed push",
      () => {
        ledger.writer.saveRequestAccounts(
          SOURCE,
          [
            {
              requestId: "req-900004",
              accountUuid: "replayed-account",
              organizationUuid: null,
              sessionId: null,
              model: null,
              occurredAt: iso(base + MINUTE),
            },
          ],
          now,
        );
        const replay = () =>
          batch("replayed-usage", {
            usage: [usage(900_004, "claude-a", base + MINUTE)],
          });
        replay();
        ledger.writer.saveAccountsSnapshot(
          SOURCE,
          ledger.writer
            .accounts()
            .filter((item) => item.externalId !== "replayed-account"),
          now,
        );
        // 只有补写的占位账户是新内容；它也必须推进版本。
        expect(
          cachedRead().accounts.map((item) => item.externalId),
        ).not.toContain("replayed-account");
        replay();
      },
    ],
    [
      "account merge",
      () => ledger.writer.setAccountMerge(`${SOURCE}:codex`, null),
    ],
    [
      "manual plan",
      () => ledger.writer.setAccountPlan(`${SOURCE}:claude-a`, "max-5x"),
    ],
    [
      "account snapshot removal",
      () =>
        ledger.writer.saveAccountsSnapshot(SOURCE, accounts.slice(0, 3), now),
    ],
  ];
  try {
    for (const [name, write] of writes) {
      const before = cachedRead();
      write();
      const after = cachedRead();
      expect({ name, after }).toEqual({ name, after: freshRead() });
      expect({ name, changed: after }).not.toEqual({ name, changed: before });
    }
    // 内容相同的重复推送不推进版本，直接沿用已读取的输入。
    const reused = cachedRead();
    batch("replay", {
      quotas: [reading("claude-a", "seven-day", base + 5 * MINUTE)],
    });
    const replayed = cachedRead();
    expect(replayed.accounts).toBe(reused.accounts);
    expect(replayed).toEqual(freshRead());
  } finally {
    await ledger.close();
  }
});

test("window sums reused across readers follow index writes", async () => {
  const ledger = await fixture();
  const set = indexes(ledger.reader, ledger.path);
  const window = [
    `${SOURCE}:claude-a`,
    iso(base - DAY),
    iso(base + HOUR),
  ] as const;
  const sum = () =>
    ledger.reader.db.transaction(() => {
      set.ensure();
      return set.projection.index.windowReader()(
        ...window,
        "subscription",
        null,
      );
    })();
  try {
    const first = sum();
    expect(sum()).toEqual(first);
    ledger.writer.saveIngestBatch(
      SOURCE,
      {
        batchId: "late",
        collector: { name: "test", version: "1" },
        accounts: [],
        usage: [usage(900_002, "claude-a", base + 30 * MINUTE)],
        quotas: [],
      },
      iso(base + HOUR),
    );
    const updated = sum();
    expect(updated.count).toBe((first.count ?? 0) + 1);
    expect(updated).toEqual(
      set.projection.index.sumWindow(...window, "subscription"),
    );
    // 模型范围在不同读取器中出现的先后不同，沿用的汇总也不能张冠李戴。
    const fable = (model: string) => model.startsWith("claude-fable-");
    const opus = (model: string) => model.startsWith("claude-opus-");
    const scoped = (scopes: ((model: string) => boolean)[]) =>
      ledger.reader.db.transaction(() => {
        const reader = set.projection.index.windowReader();
        return scopes.map((scope) => reader(...window, "subscription", scope));
      })();
    const [fableFirst] = scoped([fable, opus]);
    const [opusFirst] = scoped([opus, fable]);
    expect(fableFirst).toEqual(
      set.projection.index.sumWindow(...window, "subscription", fable),
    );
    expect(opusFirst).toEqual(
      set.projection.index.sumWindow(...window, "subscription", opus),
    );
    expect(opusFirst).not.toEqual(fableFirst);
    // 全量重建（价格表或账户映射变化）同样不能沿用旧汇总。
    set.projection.index.replace([]);
    expect(
      set.projection.index.windowReader()(...window, "subscription", null),
    ).toMatchObject({ count: 0 });
  } finally {
    set.close();
    await ledger.close();
  }
});

test("a write between two worker queries is reflected in the second", async () => {
  const ledger = await fixture();
  const reports = new ViewService(ledger.path, defaultPriceBook, {
    refreshIntervalMs: 0,
    indexCatchUpIntervalMs: 0,
    cachePath: null,
  });
  const claudeA = (view: Awaited<ReturnType<ViewService["read"]>>) =>
    view.accounts.find((item) => item.id === `${SOURCE}:claude-a`);
  try {
    const first = await reports.read(overview, "subscription");
    expect(first.ledgerRevision).toBe(ledger.writer.revision());
    const now = Date.now();
    ledger.writer.saveIngestBatch(
      SOURCE,
      {
        batchId: "live",
        collector: { name: "test", version: "1" },
        accounts: [],
        usage: [usage(900_003, "claude-a", now - MINUTE)],
        quotas: [
          {
            ...reading("claude-a", "seven-day", now - MINUTE),
            percent: 42,
            resetsAt: iso(now + DAY),
          },
        ],
      },
      iso(now),
    );
    ledger.writer.setAccountMerge(`${SOURCE}:codex`, null);
    // 已缓存结果先返回旧值，刷新完成后才包含新提交。
    await reports.read(overview, "subscription");
    const deadline = Date.now() + 5_000;
    let second = await reports.read(overview, "subscription", undefined, false);
    while (second.reportStatus?.refreshing && Date.now() < deadline) {
      await Bun.sleep(10);
      second = await reports.read(overview, "subscription", undefined, false);
    }
    expect(second.ledgerRevision).toBe(ledger.writer.revision());
    expect(second.ledgerRevision).not.toBe(first.ledgerRevision);
    expect(claudeA(second)?.sevenDay?.percent).toBe(42);
    expect(claudeA(first)?.sevenDay?.percent).not.toBe(42);
    expect(second.accounts.map((item) => item.id)).toContain(`${SOURCE}:codex`);
    expect(first.accounts.map((item) => item.id)).not.toContain(
      `${SOURCE}:codex`,
    );
  } finally {
    await reports.close();
    await ledger.close();
  }
});
