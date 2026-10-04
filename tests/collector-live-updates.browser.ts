import {
  chromium,
  expect,
  type Browser,
  type Page,
  type Request,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { INGEST_BATCHES_PATH, type IngestBatch } from "../src/shared/ingest";
import type { LedgerUpdateStatus } from "../src/shared/live-status";

// 使用独立真实服务和合成采集数据，不能继承工作区的上游连接或运行数据库。
const endpoint = process.env.METERLEAF_CDP_URL;
if (!endpoint)
  throw new Error("METERLEAF_CDP_URL must point to the task browser");
const evidenceDir = resolve(
  process.env.METERLEAF_EVIDENCE_DIR ?? "test-results/collector-live-updates",
);
await mkdir(evidenceDir, { recursive: true });
const dataDir = await mkdtemp(
  resolve(tmpdir(), "meterleaf-collector-browser-"),
);
const probe = createServer();
await new Promise<void>((done, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", done);
});
const port = (probe.address() as { port: number }).port;
await new Promise<void>((done) => probe.close(() => done()));
const base = `http://127.0.0.1:${port}/`;
const sourceId = "browser-collector";
const key = `mlk_${crypto.randomUUID()}`;
const server = Bun.spawn(
  [process.execPath, "--no-env-file", "src/server/main.ts"],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH,
      METERLEAF_HOST: "127.0.0.1",
      METERLEAF_PORT: String(port),
      METERLEAF_DATA_DIR: dataDir,
      METERLEAF_DEMO: "false",
      METERLEAF_INGEST_KEYS: `${sourceId}:${createHash("sha256").update(key).digest("hex")}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const stdout = new Response(server.stdout).text();
const stderr = new Response(server.stderr).text();
let browser: Browser | undefined;
let page: Page | undefined;
let views = 0;
let heartbeats = 0;
let recordCount = 0;
const errors: string[] = [];
const checks: Array<Record<string, unknown>> = [];
const track = (request: Request) => {
  const path = new URL(request.url()).pathname;
  if (path === "/api/view") views += 1;
  if (path === "/api/sync/presence") heartbeats += 1;
};
function batch(id: number): IngestBatch {
  return {
    schemaVersion: 1,
    sourceId,
    batchId: crypto.randomUUID(),
    collector: { name: "browser-fixture", version: "1.0.0" },
    accounts: [
      {
        externalId: "account",
        name: "合成采集器账户",
        platform: "anthropic",
        kind: "api",
        plan: null,
        subjectKey: null,
      },
    ],
    usage: [
      {
        externalId: `request-${id}`,
        occurredAt: new Date().toISOString(),
        accountExternalId: "account",
        model: "claude-opus-5-5",
        tier: "standard",
        tokens: {
          input: 1000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          reasoning: null,
        },
        metadata: {},
      },
    ],
    quotas: [],
  };
}
async function ingest(value: IngestBatch) {
  const response = await fetch(base + INGEST_BATCHES_PATH.slice(1), {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).accepted).toEqual({
    usage: 1,
    accounts: 1,
    quotas: 0,
  });
}
async function status(): Promise<{
  unavailable: boolean;
  ledger: LedgerUpdateStatus;
}> {
  const response = await fetch(base + "api/sync");
  expect(response.status).toBe(200);
  return response.json();
}
function updatedLabel(value: string | null) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value!));
  const fields = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `更新于 ${fields.month}/${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
}
async function expectCount(tab: string, count: number, timeout = 15_000) {
  if (tab === "ledger") {
    await expect(page!.locator(".request-table-scroll tbody tr")).toHaveCount(
      count,
      { timeout },
    );
  } else if (await page!.locator(".mobile-home-summary").isVisible()) {
    await expect(
      page!
        .locator(".mobile-home-summary-metrics > span")
        .nth(1)
        .locator("strong"),
    ).toHaveText(String(count), { timeout });
  } else {
    await expect(
      page!.locator("section.usage-summary dl > div").nth(2).locator("dd"),
    ).toHaveText(String(count), { timeout });
  }
}
async function settled(tab: string) {
  await expectCount(tab, recordCount);
  await expect(page!.locator("main")).toHaveAttribute("aria-busy", "false");
  await page!.waitForTimeout(1500);
}
async function expectTimestamp(value: string | null) {
  await expect(
    page!.getByRole("button", { name: "数据同步", exact: true }),
  ).toHaveAttribute("title", `数据同步 · ${updatedLabel(value)}`);
}
async function addAndExpectRefresh(tab: string) {
  const before = views;
  const previous = await status();
  const value = batch(++recordCount);
  const started = performance.now();
  await ingest(value);
  await expectCount(tab, recordCount);
  const elapsedMs = Math.round(performance.now() - started);
  expect(elapsedMs).toBeLessThan(15_000);
  expect(views).toBeGreaterThan(before);
  const current = await status();
  expect(current.ledger.revision).toBeGreaterThan(previous.ledger.revision);
  await expectTimestamp(current.ledger.updatedAt);
  checks.push({
    behavior: "new-batch-refresh",
    tab,
    elapsedMs,
    count: recordCount,
  });
  console.log(JSON.stringify(checks.at(-1)));
  return value;
}
try {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(base + "api/health")).ok;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  expect((await status()).unavailable).toBe(true);
  await ingest(batch(++recordCount));
  browser = await chromium.connectOverCDP(endpoint);
  page = await browser.contexts()[0]!.newPage();
  page.setDefaultTimeout(15_000);
  page.on("request", track);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.bringToFront();
  await page.goto(base + "#overview");
  await page.evaluate(() =>
    localStorage.setItem("meterleaf-pref-mobileLayout", JSON.stringify("app")),
  );
  await page.reload();
  await settled("overview");
  await expectTimestamp((await status()).ledger.updatedAt);
  await page.getByRole("button", { name: "数据同步", exact: true }).click();
  await expect(page.locator(".sync-popup")).toContainText("由采集器推送数据");
  await expect(page.getByLabel("暂停页面自动更新")).toBeVisible();
  await expect(page.getByText("自动同步", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "立即同步", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: resolve(evidenceDir, "desktop-collector.png"),
  });
  await page.keyboard.press("Escape");
  let lastBatch: IngestBatch | undefined;
  for (const tab of ["overview", "reports", "ledger"]) {
    await page.goto(base + "#" + tab);
    await settled(tab);
    lastBatch = await addAndExpectRefresh(tab);
  }
  await settled("ledger");
  const beforeDuplicate = views;
  const previous = await status();
  await ingest({ ...lastBatch!, batchId: crypto.randomUUID() });
  const afterDuplicate = await status();
  expect(afterDuplicate.ledger.revision).toBe(previous.ledger.revision);
  expect(Date.parse(afterDuplicate.ledger.updatedAt!)).toBeGreaterThan(
    Date.parse(previous.ledger.updatedAt!),
  );
  const duplicateHeartbeat = heartbeats;
  await expect
    .poll(() => heartbeats, { timeout: 17_000 })
    .toBeGreaterThan(duplicateHeartbeat);
  await expectTimestamp(afterDuplicate.ledger.updatedAt);
  await page.waitForTimeout(1000);
  expect(views).toBe(beforeDuplicate);
  await expectCount("ledger", recordCount);
  checks.push({
    behavior: "duplicate-no-report-read",
    revision: afterDuplicate.ledger.revision,
    views,
  });
  await page.goto(base + "#overview");
  await settled("overview");
  await page.getByRole("button", { name: "数据同步", exact: true }).click();
  await page.getByLabel("暂停页面自动更新").check();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
  const pausedViews = views;
  const pausedHeartbeats = heartbeats;
  await ingest(batch(++recordCount));
  await page.waitForTimeout(16_000);
  expect(views).toBe(pausedViews);
  expect(heartbeats).toBeGreaterThan(pausedHeartbeats);
  await expectCount("overview", recordCount - 1);
  await page.getByRole("button", { name: "数据同步", exact: true }).click();
  const resumedAt = performance.now();
  await page.getByLabel("暂停页面自动更新").uncheck();
  await page.keyboard.press("Escape");
  await expectCount("overview", recordCount, 5000);
  checks.push({
    behavior: "pause-resume",
    elapsedMs: Math.round(performance.now() - resumedAt),
    presenceKept: true,
  });
  await settled("overview");
  // CDP 任务标签可能一直报告可见，模拟浏览器生命周期事件，但保留真实状态接口与报表读取。
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1000);
  const hiddenViews = views;
  const hiddenHeartbeats = heartbeats;
  await ingest(batch(++recordCount));
  await page.waitForTimeout(16_000);
  expect(views).toBe(hiddenViews);
  expect(heartbeats).toBe(hiddenHeartbeats);
  const visibleAt = performance.now();
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expectCount("overview", recordCount, 5000);
  checks.push({
    behavior: "emulated-hidden-resume",
    elapsedMs: Math.round(performance.now() - visibleAt),
    hiddenStopped: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await settled("overview");
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await addAndExpectRefresh("overview");
  await page.getByRole("button", { name: "数据同步", exact: true }).click();
  await expect(page.locator(".sync-popup")).toContainText("由采集器推送数据");
  await expect(page.getByLabel("暂停页面自动更新")).toBeVisible();
  await page.screenshot({
    path: resolve(evidenceDir, "mobile-reduced-motion-collector.png"),
  });
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
  const result = {
    status: "passed",
    port,
    realServer: true,
    sqlite: true,
    syntheticIngestOnly: true,
    viewports: ["1440x1000", "390x844"],
    reducedMotion: true,
    visibilityEvents: "emulated",
    views,
    heartbeats,
    recordCount,
    errors,
    checks,
  };
  await writeFile(
    resolve(evidenceDir, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(
    resolve(evidenceDir, "failure.json"),
    JSON.stringify(
      { error: String(error), checks, views, heartbeats, errors },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (page && !page.isClosed()) {
    page.off("request", track);
    await page
      .evaluate(() => {
        Reflect.deleteProperty(document, "visibilityState");
        document.dispatchEvent(new Event("visibilitychange"));
      })
      .catch(() => {});
    await page
      .emulateMedia({ reducedMotion: "no-preference", colorScheme: null })
      .catch(() => {});
    await page.close().catch(() => {});
  }
  await browser?.close();
  server.kill("SIGTERM");
  await Promise.race([server.exited, Bun.sleep(5000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
  await server.exited;
  await writeFile(
    resolve(evidenceDir, "server.log"),
    (await stdout) + (await stderr),
  );
  await rm(dataDir, { recursive: true, force: true });
}
