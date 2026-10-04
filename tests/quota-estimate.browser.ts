import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { IngestBatch } from "../src/shared/ingest";
import type { LedgerView } from "../src/shared/ledger-view";

const endpoint = process.env.METERLEAF_CDP_URL;
if (!endpoint)
  throw new Error("METERLEAF_CDP_URL must point to the task browser");
const evidenceDir = resolve(
  process.env.METERLEAF_EVIDENCE_DIR ?? "test-results/quota-estimate",
);
await mkdir(evidenceDir, { recursive: true });
const dataDir = await mkdtemp(resolve(tmpdir(), "meterleaf-quota-browser-"));
const probe = createServer().listen(0, "127.0.0.1");
await new Promise<void>((done, reject) => {
  probe.once("listening", done);
  probe.once("error", reject);
});
const port = (probe.address() as { port: number }).port;
await new Promise<void>((done) => probe.close(() => done()));
const base = `http://127.0.0.1:${port}/`;
const sourceId = "quota-browser";
const key = `mlk_${crypto.randomUUID()}`;
// 独立真实服务禁用 .env，仅持有本次生成的写入密钥和临时数据库。
const server = Bun.spawn(
  [process.execPath, "--no-env-file", "src/server/main.ts"],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH,
      METERLEAF_HOST: "127.0.0.1",
      METERLEAF_PORT: String(port),
      METERLEAF_DATA_DIR: dataDir,
      METERLEAF_INGEST_KEYS: `${sourceId}:${createHash("sha256").update(key).digest("hex")}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const output = Promise.all([
  new Response(server.stdout).text(),
  new Response(server.stderr).text(),
]);
let browser: Browser | undefined;
let page: Page | undefined;
const errors: string[] = [];
const stages: Array<Record<string, unknown>> = [];
const week = 7 * 86400_000;
const cycleStart = Date.now() - 3 * 3600_000;
const iso = (value: number) => new Date(value).toISOString();
const names = { history: "合成历史参考账户", rough: "合成无历史账户" };

function observation(
  account: keyof typeof names,
  percent: number,
  cumulativeUsd: number,
  previousUsd: number,
  previousCycle = false,
): IngestBatch {
  const start = cycleStart - (previousCycle ? week : 0);
  const sampledAt = iso(start + percent * 60_000);
  return {
    schemaVersion: 1,
    sourceId,
    batchId: crypto.randomUUID(),
    collector: { name: "quota-browser-fixture", version: "1.0.0" },
    accounts: [
      {
        externalId: account,
        name: names[account],
        platform: "anthropic",
        kind: "subscription",
        plan: "max-5x",
        subjectKey: null,
      },
    ],
    usage: [
      {
        externalId: `${account}-${previousCycle ? "prior" : "current"}-${percent}`,
        occurredAt: iso(Date.parse(sampledAt) - 1000),
        accountExternalId: account,
        model: "claude-opus-5-5",
        tier: "standard",
        // 输入每百万 Tokens 4 USD，1000 输出 Tokens 为 0.02 USD，独立核对 API 计价。
        tokens: {
          input: (cumulativeUsd - previousUsd) * 250_000 - 5000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          reasoning: null,
        },
        metadata: {},
      },
    ],
    quotas: [
      {
        accountExternalId: account,
        window: "seven-day",
        percent,
        sampledAt,
        resetsAt: iso(start + week),
        windowMinutes: 10080,
      },
    ],
  };
}
async function ingest(value: IngestBatch) {
  const response = await fetch(base + "api/ingest/v1/batches", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(200);
}
const accountWindow = (view: LedgerView, account: keyof typeof names) =>
  view.accounts.find((value) => value.name === names[account])!.sevenDay!;
async function apiStage(
  method: string,
  usd: number,
  roughMethod: string,
  roughUsd: number,
  expectedPeriodUsd: number,
) {
  let view: LedgerView | undefined;
  let refresh = true;
  await expect
    .poll(
      async () => {
        const response = await fetch(
          base + `api/view?days=30&pageSize=100&refresh=${refresh}`,
        );
        refresh = false;
        expect([200, 202]).toContain(response.status);
        if (response.status === 202) return false;
        view = (await response.json()) as LedgerView;
        return (
          view.accounts.some(
            (account) =>
              account.name === names.history &&
              account.sevenDay?.estimate?.methods?.usd === method &&
              Number(account.sevenDay?.periodUsd) === expectedPeriodUsd,
          ) &&
          view.accounts.some(
            (account) =>
              account.name === names.rough &&
              account.sevenDay?.estimate?.methods?.usd === roughMethod &&
              Number(account.sevenDay?.periodUsd) === expectedPeriodUsd,
          )
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const history = accountWindow(view!, "history");
  const rough = accountWindow(view!, "rough");
  expect(Number(history.estimate!.usd)).toBeCloseTo(usd, 8);
  expect(Number(rough.estimate!.usd)).toBeCloseTo(roughUsd, 8);
  expect(history.estimate!.reason).toBe("eligible");
  expect(rough.estimate!.reason).toBe("eligible");
  expect(Number(history.periodUsd)).toBe(expectedPeriodUsd);
  expect(Number(rough.periodUsd)).toBe(expectedPeriodUsd);
  const prior = view!.records.filter((record) =>
    record.sourceRecordId?.startsWith("history-prior-"),
  );
  expect(prior).toHaveLength(3);
  expect(prior.map((record) => Number(record.usd))).toEqual([10, 10, 10]);
  const result = { method, usd, roughMethod, roughUsd, history, rough };
  stages.push(result);
  await writeFile(
    resolve(evidenceDir, `api-${stages.length}-${method}.json`),
    JSON.stringify(view, null, 2),
  );
  console.log(JSON.stringify({ method, usd, roughMethod, roughUsd }));
}
async function detail(
  account: keyof typeof names,
  amount: string,
  basis: RegExp,
  screenshot?: string,
) {
  const row = page!
    .locator(".account-row:visible, .mobile-home-account-card:visible")
    .filter({ hasText: names[account] });
  await expect(row).toHaveCount(1);
  await row.click();
  const dialog = page!.getByRole("dialog");
  const entry = (label: string) =>
    dialog
      .locator("dt")
      .filter({ hasText: new RegExp(`^${label}$`) })
      .locator("+ dd");
  await expect(entry("7d 预估费用")).toHaveText(amount);
  await expect(entry("7d 费用预估依据")).toContainText(basis);
  if (screenshot)
    await page!.screenshot({ path: resolve(evidenceDir, screenshot) });
  await page!.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}
async function loadPage() {
  await page!.goto(base + "#overview");
  await page!.reload();
  await expect(page!.locator("main")).toHaveAttribute("aria-busy", "false");
}
async function tokensCard(average: string, output: string) {
  const mobile = await page!.locator(".mobile-home-summary").isVisible();
  const card = mobile
    ? page!.locator(".mobile-home-summary-metrics > span").first()
    : page!.locator("section.usage-summary dl > div").first();
  if (mobile) {
    await expect(card).not.toContainText("每次");
    await expect(card).not.toContainText("输出");
    const outputNote = page!.locator(
      ".mobile-home-summary .token-composition-legend [data-segment=output]",
    );
    await expect(outputNote).toContainText("输出");
    await expect(outputNote).toContainText(output);
  } else {
    await expect(card).toContainText("每次请求");
    await expect(card).toContainText("输出");
    await expect(card).toContainText(average);
    await expect(card).toContainText(output);
  }
  expect(
    await page!.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
  let cumulative = 0;
  for (const percent of [10, 20, 30]) {
    await ingest(observation("history", percent, percent, cumulative, true));
    cumulative = percent;
  }
  for (const account of ["history", "rough"] as const)
    await ingest(observation(account, 1, 8, 0));
  await apiStage("previous-period", 100, "rough", 800, 8);
  browser = await chromium.connectOverCDP(endpoint);
  page = await browser.contexts()[0]!.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.bringToFront();
  await loadPage();
  await page.evaluate(() =>
    localStorage.setItem("meterleaf-pref-mobileLayout", JSON.stringify("app")),
  );
  await page.reload();
  await detail(
    "history",
    "≈$100.00",
    /上一周期/,
    "desktop-previous-period.png",
  );
  await detail("rough", "≈$800.00", /粗估/);
  for (const account of ["history", "rough"] as const) {
    await ingest(observation(account, 2, 16, 8));
    await ingest(observation(account, 3, 24, 16));
  }
  // 当前粗估即使为 800 USD，有历史参考时也继续采用 100 USD。
  await apiStage("previous-period", 100, "rough", 800, 24);
  await loadPage();
  await tokensCard("2.16M", "9.00K");
  await detail("history", "≈$100.00", /上一周期/, "desktop-early-history.png");
  await detail("rough", "≈$800.00", /粗估/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loadPage();
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await tokensCard("2.16M", "9.00K");
  await detail("history", "≈$100.00", /上一周期/, "mobile-early-history.png");
  await detail("rough", "≈$800.00", /粗估/, "mobile-rough.png");
  for (const account of ["history", "rough"] as const) {
    await ingest(observation(account, 10, 30, 24));
    await ingest(observation(account, 15, 35, 30));
  }
  // 七个有效点对的中位数为 1900/13，跨度 14% 的历史混合权重为 0.49。
  const blended = 100 * 0.51 + (1900 / 13) * 0.49;
  await apiStage("blended", blended, "segments", 1900 / 13, 35);
  await loadPage();
  await tokensCard("1.92M", "13.00K");
  await detail(
    "history",
    "≈$122.62",
    /综合上一周期与本周期/,
    "mobile-blended.png",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loadPage();
  await tokensCard("1.92M", "13.00K");
  await detail(
    "history",
    "≈$122.62",
    /综合上一周期与本周期/,
    "desktop-blended.png",
  );
  for (const account of ["history", "rough"] as const) {
    cumulative = 35;
    for (const percent of [20, 30, 40, 50, 60]) {
      await ingest(observation(account, percent, percent + 20, cumulative));
      cumulative = percent + 20;
    }
  }
  await apiStage("segments", 100, "segments", 100, 80);
  await page.setViewportSize({ width: 390, height: 844 });
  await loadPage();
  await detail("history", "$100.00", /多段.*中位数/, "mobile-segments.png");
  await detail("rough", "$100.00", /多段.*中位数/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loadPage();
  await detail("history", "$100.00", /多段.*中位数/, "desktop-segments.png");
  expect(errors).toEqual([]);
  const result = {
    status: "passed",
    port,
    realServer: true,
    sqlite: true,
    syntheticSubscriptionAccounts: true,
    adjacentCycleDurationDays: 7,
    viewports: ["1440x1000", "390x844"],
    reducedMotion: true,
    errors,
    stages,
  };
  await writeFile(
    resolve(evidenceDir, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      stages: stages.map(({ method, usd, roughMethod, roughUsd }) => ({
        method,
        usd,
        roughMethod,
        roughUsd,
      })),
      errors,
    }),
  );
} catch (error) {
  await writeFile(
    resolve(evidenceDir, "failure.json"),
    JSON.stringify({ error: String(error), stages, errors }, null, 2),
  );
  throw error;
} finally {
  if (page && !page.isClosed()) {
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
    (await output).join("\n"),
  );
  await rm(dataDir, { recursive: true, force: true });
}
