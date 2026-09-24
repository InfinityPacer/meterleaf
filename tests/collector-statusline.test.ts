import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/collector/collect";
import { readStatuslineCache } from "../src/collector/claude-code/statusline-cache";
import { CollectorState } from "../src/collector/state";
import type { IngestQuota } from "../src/shared/ingest";
import { FIXTURE_ACCOUNT_UUID } from "./fixtures/claude-code/lines";

const OTHER_ACCOUNT = "cccccccc-3333-4333-8333-333333333333";
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-collector-statusline-"));
  temporary.push(root);
  const projectsDir = join(root, "projects");
  mkdirSync(projectsDir, { recursive: true });
  const claudeJson = join(root, "claude.json");
  const statuslineCache = join(root, "rate-limits.tsv");
  return { projectsDir, claudeJson, statuslineCache };
}

function login(path: string, accountUuid: string) {
  writeFileSync(
    path,
    JSON.stringify({
      oauthAccount: {
        accountUuid,
        organizationUuid: "bbbbbbbb-2222-4222-8222-222222222222",
        organizationType: "claude_max",
        organizationRateLimitTier: "default_claude_max_5x",
        billingType: "apple_subscription",
      },
    }),
  );
}

function writeCache(path: string, body: string, mtime: string) {
  writeFileSync(path, body);
  const at = new Date(mtime);
  utimesSync(path, at, at);
}

function quotas(state: CollectorState): IngestQuota[] {
  return state.pending<IngestQuota>("quota", 50).map((item) => item.payload);
}

const resets5h = Math.floor(Date.parse("2026-09-24T19:20:00Z") / 1000);
const resets7d = Math.floor(Date.parse("2026-09-27T08:00:00Z") / 1000);

test("statusline cache yields fresh quota samples at the file time for the observed account", () => {
  const sources = workspace();
  const state = new CollectorState(":memory:");
  login(sources.claudeJson, FIXTURE_ACCOUNT_UUID);
  collect(state, sources, new Date("2026-09-24T17:00:00Z"));

  writeCache(
    sources.statuslineCache,
    `five_hour\t18\t${resets5h}\nseven_day\t25\t${resets7d}\n`,
    "2026-09-24T17:00:30Z",
  );
  const report = collect(state, sources, new Date("2026-09-24T17:01:00Z"));
  expect(report.statuslineQuotaRecorded).toBe(true);
  expect(quotas(state)).toEqual([
    {
      accountExternalId: FIXTURE_ACCOUNT_UUID,
      window: "five-hour",
      percent: 18,
      sampledAt: "2026-09-24T17:00:30.000Z",
      resetsAt: "2026-09-24T19:20:00.000Z",
      windowMinutes: 300,
    },
    {
      accountExternalId: FIXTURE_ACCOUNT_UUID,
      window: "seven-day",
      percent: 25,
      sampledAt: "2026-09-24T17:00:30.000Z",
      resetsAt: "2026-09-27T08:00:00.000Z",
      windowMinutes: 10080,
    },
  ]);

  // 同一采样重复读取不再上报；状态栏再次写入（修改时间变化）是新的采样。
  expect(
    collect(state, sources, new Date("2026-09-24T17:02:00Z"))
      .statuslineQuotaRecorded,
  ).toBe(false);
  writeCache(
    sources.statuslineCache,
    `five_hour\t19\t${resets5h}\nseven_day\t25\t${resets7d}\n`,
    "2026-09-24T17:02:30Z",
  );
  expect(
    collect(state, sources, new Date("2026-09-24T17:03:00Z"))
      .statuslineQuotaRecorded,
  ).toBe(true);
  expect(quotas(state)).toHaveLength(4);
});

test("statusline samples are skipped when the login at the file time is unknown", () => {
  const sources = workspace();
  const state = new CollectorState(":memory:");
  // 采样早于首次观察到账户，也没有历史绑定。
  writeCache(
    sources.statuslineCache,
    `five_hour\t18\t${resets5h}\n`,
    "2026-09-24T16:00:00Z",
  );
  login(sources.claudeJson, FIXTURE_ACCOUNT_UUID);
  const first = collect(state, sources, new Date("2026-09-24T17:00:00Z"));
  expect(first.statuslineQuotaRecorded).toBe(false);
  expect(first.statuslineQuotaSkipped).toContain("登录账户");

  // 两次观察之间换了账户，中间的采样无法归属。
  login(sources.claudeJson, OTHER_ACCOUNT);
  writeCache(
    sources.statuslineCache,
    `five_hour\t30\t${resets5h}\n`,
    "2026-09-24T17:05:00Z",
  );
  const switched = collect(state, sources, new Date("2026-09-24T17:10:00Z"));
  expect(switched.statuslineQuotaRecorded).toBe(false);
  expect(quotas(state)).toHaveLength(0);
});

test("malformed or partial statusline files are ignored instead of guessed", () => {
  const { statuslineCache } = workspace();
  const cases = [
    "",
    "five_hour\t18\n",
    "five_hour\tabc\t1790277600\n",
    "constructor\t18\t1790277600\n",
    "five_hour\t18\t1790277600\textra\n",
  ];
  for (const body of cases) {
    writeFileSync(statuslineCache, body);
    expect(readStatuslineCache(statuslineCache)).toBeNull();
  }
  expect(readStatuslineCache(join(statuslineCache, "missing"))).toBeNull();
  writeFileSync(
    statuslineCache,
    "five_hour\t10\t1790277600\nfive_hour\t12\t1790277600\n",
  );
  expect(readStatuslineCache(statuslineCache)?.entries).toEqual([
    { window: "five-hour", percent: 12, resetsAt: "2026-09-24T19:20:00.000Z" },
  ]);
});
