/**
 * 报表打开耗时基准：生成接近生产规模的合成账本，并分阶段测量报表线程每次查询的耗时。
 *
 *   bun scripts/bench-report-open.ts build <ledger.sqlite> [days] [eventsPerDay]
 *   bun scripts/bench-report-open.ts phases <ledger.sqlite> [runs] [uncached|cached]
 *   bun scripts/bench-report-open.ts open <ledger.sqlite> [runs] [steady|push]
 *
 * phases 在当前线程直接拆解快照阶段；open 通过 ViewService 模拟一次打开发出的连续查询，
 * 读取报表线程上报的分段耗时。合成账本较大，请放在仓库之外并在测量后删除。
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  QuotaFact,
  SourceAccount,
  UsageFact,
} from "../src/domain/connector";
import { loadPriceBook } from "../src/server/price-book";
import { ReportInputCache } from "../src/server/report-inputs";
import { ReportProjection } from "../src/server/report-projection";
import { indexedSnapshot } from "../src/server/snapshot";
import { ViewService } from "../src/server/view-service";
import {
  createDiagnosticsLogger,
  type LogEvent,
} from "../src/server/diagnostics";
import type { ViewQuery } from "../src/shared/ledger-view";
import { LedgerStore } from "../src/storage/ledger";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const SOURCE = "bench";

const accounts: SourceAccount[] = [
  ["claude-a", "Claude A", "anthropic", "subscription", "max-20x"],
  ["claude-b", "Claude B", "anthropic", "subscription", "max-5x"],
  ["claude-c", "Claude C", "anthropic", "subscription", "pro"],
  ["codex-a", "Codex A", "openai", "subscription", "pro"],
  ["api-a", "API A", "openai", "api", null],
  ["api-b", "API B", "anthropic", "api", null],
].map(([externalId, name, platform, kind, plan]) => ({
  sourceId: SOURCE,
  externalId: externalId!,
  name: name!,
  platform: platform!,
  kind: kind as SourceAccount["kind"],
  plan: plan ?? null,
  parentExternalId: null,
  subjectKey: null,
}));
const models: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1"],
  openai: ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-luna"],
};

/** 固定种子的伪随机数，使两次生成的账本内容一致。 */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function usage(index: number, at: number, next: () => number): UsageFact {
  const account = accounts[index % accounts.length]!;
  const pool = models[account.platform]!;
  return {
    sourceId: SOURCE,
    externalId: `req-${index}:msg-${index}`,
    accountExternalId: account.externalId,
    occurredAt: new Date(at).toISOString(),
    model: pool[Math.floor(next() * pool.length)]!,
    upstreamModel: null,
    tier: "standard",
    tokens: {
      input: Math.floor(next() * 4000),
      cacheRead: Math.floor(next() * 60000),
      cacheWrite: Math.floor(next() * 3000),
      cacheWrite5m: null,
      cacheWrite1h: null,
      output: Math.floor(next() * 2000),
      reasoning: null,
    },
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: { duration_ms: Math.floor(next() * 30000) },
  };
}

/** 订阅账户每 5 分钟上报一次各窗口读数，百分比在每个周期内单调上升。 */
function quotaReadings(
  account: SourceAccount,
  at: number,
  weeklyAnchor: number,
): QuotaFact[] {
  const windows: [QuotaFact["window"], number][] = [
    ["five-hour", 300],
    ["seven-day", 10080],
  ];
  if (account.platform === "anthropic")
    windows.push(["seven-day-fable", 10080]);
  return windows.map(([window, minutes]) => {
    const duration = minutes * MINUTE;
    const anchor = window === "five-hour" ? 0 : weeklyAnchor;
    const reset = anchor + Math.ceil((at - anchor + 1) / duration) * duration;
    const elapsed = 1 - (reset - at) / duration;
    return {
      sourceId: SOURCE,
      externalId: `${account.externalId}:${window}:${at}`,
      accountExternalId: account.externalId,
      window,
      percent: Math.min(100, Math.floor(elapsed * 90)),
      sampledAt: new Date(at).toISOString(),
      resetsAt: new Date(reset).toISOString(),
      windowMinutes: minutes,
    };
  });
}

async function build(path: string, days: number, eventsPerDay: number) {
  if (existsSync(path)) throw new Error(`${path} already exists`);
  const book = await loadPriceBook();
  const store = new LedgerStore(path, book);
  const end = Date.now();
  const start = end - days * DAY;
  const weeklyAnchor = end - 2 * DAY;
  const next = random(42);
  const step = DAY / eventsPerDay;
  let index = 0;
  let batch = 0;
  const started = performance.now();
  for (let dayStart = start; dayStart < end; dayStart += DAY) {
    const usageFacts: UsageFact[] = [];
    for (let at = dayStart; at < Math.min(end, dayStart + DAY); at += step)
      usageFacts.push(usage(index++, at + next() * step, next));
    const quotaFacts: QuotaFact[] = [];
    for (
      let at = dayStart;
      at < Math.min(end, dayStart + DAY);
      at += 5 * MINUTE
    )
      for (const account of accounts)
        if (account.kind === "subscription")
          quotaFacts.push(...quotaReadings(account, at, weeklyAnchor));
    store.saveIngestBatch(
      SOURCE,
      {
        batchId: `bench-${batch++}`,
        collector: { name: "bench", version: "1" },
        accounts,
        usage: usageFacts,
        quotas: quotaFacts,
      },
      new Date(Math.min(end, dayStart + DAY)).toISOString(),
    );
  }
  const counts = store.db
    .query<{ usage: number; quotas: number }, []>(
      "SELECT (SELECT COUNT(*) FROM usage_facts) AS usage, (SELECT COUNT(*) FROM quota_snapshots) AS quotas",
    )
    .get()!;
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();
  console.log(
    JSON.stringify({
      path,
      days,
      ...counts,
      buildSeconds: Math.round((performance.now() - started) / 1000),
    }),
  );
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function summarize(samples: Record<string, number[]>) {
  return Object.fromEntries(
    Object.entries(samples).map(([key, values]) => [
      key,
      {
        p50: Math.round(percentile(values, 0.5) * 10) / 10,
        p90: Math.round(percentile(values, 0.9) * 10) / 10,
      },
    ]),
  );
}

/** 在当前线程逐项计时快照阶段，定位 snapshotMs 内部的主要开销。 */
async function phases(path: string, runs: number, cached: boolean) {
  const book = await loadPriceBook();
  const store = new LedgerStore(path, book, { readonly: true });
  const indexPath = join(tmpdir(), `meterleaf-bench-${process.pid}.reports`);
  const projection = new ReportProjection(store, path, indexPath);
  const ensureStarted = performance.now();
  projection.ensure();
  console.log(
    JSON.stringify({
      indexBuildMs: Math.round(performance.now() - ensureStarted),
    }),
  );
  const samples: Record<string, number[]> = {};
  const time = <T>(name: string, run: () => T): T => {
    const started = performance.now();
    const value = run();
    (samples[name] ??= []).push(performance.now() - started);
    return value;
  };
  const inputs = new ReportInputCache(store);
  for (let run = 0; run < runs; run++) {
    store.db.transaction(() => {
      const now = new Date().toISOString();
      const total = performance.now();
      // 未缓存路径与修复前一致：每次查询新建窗口读取器并重新读取账本输入。
      if (!cached)
        (
          projection.index as unknown as { recentWindows: Map<string, unknown> }
        ).recentWindows = new Map();
      const sumWindow = projection.index.windowReader();
      const read = cached
        ? time("inputs", () => inputs.read(now))
        : {
            accounts: time("accounts", () => store.accounts()),
            quotas: time("reportQuotas", () => store.reportQuotas(now)),
            merges: time("accountMerges", () => store.accountMerges()),
          };
      const accountList = read.accounts;
      const quotas = read.quotas;
      const merges = read.merges;
      const ledger = {
        book: store.book,
        accounts: () => accountList,
        quotas: () => quotas,
        accountMerges: () => merges,
      };
      const ids = time("accountIds", () => projection.accountIds());
      time("snapshotSubscription", () =>
        indexedSnapshot(ledger, null, now, "subscription", sumWindow, ids),
      );
      time("snapshotApi", () =>
        indexedSnapshot(ledger, null, now, "api", sumWindow, ids),
      );
      (samples.snapshotTotal ??= []).push(performance.now() - total);
      (samples.quotaRows ??= []).push(quotas.length);
    })();
  }
  console.log(JSON.stringify(summarize(samples), null, 2));
  projection.close();
  store.close();
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(`${indexPath}${suffix}`)
      .delete()
      .catch(() => undefined);
}

const overview: ViewQuery = {
  filter: { days: 7, model: "all", account: "all", search: "" },
  unit: "usd",
  granularity: "day",
  dimension: "model",
  page: 0,
  pageSize: 1,
  sort: "occurredAt",
  desc: true,
};

/** 一次打开的查询组合：总览和各订阅账户的近七天微图，按页面顺序连续发出。 */
function openQueries(): ViewQuery[] {
  return [
    overview,
    ...accounts.slice(0, 3).map((account) => ({
      filter: {
        days: 7 as const,
        model: "all",
        account: `${SOURCE}:${account.externalId}`,
        search: "",
      },
      unit: "tokens" as const,
      granularity: "hour" as const,
      dimension: "day" as const,
      page: 0,
      pageSize: 1,
      sort: "occurredAt",
      desc: true,
    })),
  ];
}

/** push 在每次打开前写入一条额度读数，模拟两次打开之间采集器的推送；steady 不写入。 */
async function open(path: string, runs: number, push: boolean) {
  const book = await loadPriceBook();
  const events: LogEvent[] = [];
  const indexPath = join(tmpdir(), `meterleaf-bench-${process.pid}.reports`);
  const reports = new ViewService(path, book, {
    indexPath,
    cachePath: null,
    refreshIntervalMs: 0,
    indexCatchUpIntervalMs: 0,
    inlineRebuildLimit: Number.MAX_SAFE_INTEGER,
    diagnostics: createDiagnosticsLogger({
      level: "debug",
      sink: (event) => events.push(event),
    }),
  });
  try {
    // 第一次查询建立索引，不计入结果。
    await reports.read(overview, "subscription");
    events.length = 0;
    for (let run = 0; run < runs; run++) {
      // 冷读取会等待报表线程，等价于每次打开时的后台刷新。
      const service = reports as unknown as { cache: Map<string, unknown> };
      service.cache.clear();
      if (push) {
        const writer = new LedgerStore(path, book);
        const at = Date.now();
        writer.saveQuotas(
          quotaReadings(accounts[0]!, at, at - 2 * DAY).slice(0, 1),
          new Date(at).toISOString(),
        );
        writer.close();
      }
      await Promise.all(
        openQueries().map((query) => reports.read(query, "subscription")),
      );
    }
    const samples: Record<string, number[]> = {};
    for (const event of events.filter(
      (item) => item.event === "report.query_timing",
    ))
      for (const key of [
        "queueMs",
        "indexMs",
        "snapshotMs",
        "aggregateMs",
        "materializeMs",
        "readMs",
      ])
        (samples[key] ??= []).push(Number(event[key]));
    samples.totalMs = (samples.queueMs ?? []).map(
      (queue, index) =>
        queue + samples.indexMs![index]! + samples.readMs![index]!,
    );
    console.log(
      JSON.stringify(
        { queries: samples.totalMs.length, ...summarize(samples) },
        null,
        2,
      ),
    );
  } finally {
    await reports.close();
    for (const suffix of [
      "",
      "-wal",
      "-shm",
      ".lifetime",
      ".lifetime-wal",
      ".lifetime-shm",
    ])
      await Bun.file(`${indexPath}${suffix}`)
        .delete()
        .catch(() => undefined);
  }
}

const [command, path, ...rest] = process.argv.slice(2);
if (!path) throw new Error("usage: build|phases|open <ledger.sqlite>");
if (command === "build")
  await build(path, Number(rest[0] ?? 120), Number(rest[1] ?? 3500));
else if (command === "phases")
  await phases(path, Number(rest[0] ?? 20), rest[1] === "cached");
else if (command === "open")
  await open(path, Number(rest[0] ?? 10), rest[1] === "push");
else throw new Error(`unknown command ${command}`);
