import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchQuotaSummary,
  localLogins,
  readExistingClaudeQuotaSummaryLogins,
  refreshClaudeQuotaSummaryLogins,
  resolveExclusiveClaudeLogins,
  writeQuotaSummary,
  type LocalQuotaSummary,
} from "../src/collector/quota-summary";
import {
  QUOTA_SUMMARY_PATH,
  type QuotaSummary,
} from "../src/shared/quota-summary";

const config = { server: "https://meterleaf.test", key: "mlk_k" };
const summary: QuotaSummary = {
  schemaVersion: 1,
  asOf: "2026-11-17T08:00:00Z",
  accounts: [],
};

test("logins use the same account ids as the summary members and skip unknown logins", () => {
  expect(
    localLogins("mac", {
      claude: [
        { configDir: "/h/.claude", accountUuid: "uuid-1" },
        { configDir: "/h/.claude-profiles/work", accountUuid: null },
      ],
      agy: [
        {
          appDataDir: "/h/.gemini/antigravity-cli",
          profile: null,
          account: "agy-alice",
        },
        {
          appDataDir: "/h/.gemini/antigravity-cli-work",
          profile: "work",
          account: null,
        },
      ],
      codexChannels: [{ channel: "openai", id: "codex" }],
    }),
  ).toEqual({
    claude: [{ configDir: "/h/.claude", account: "mac:uuid-1" }],
    agy: [
      {
        appDataDir: "/h/.gemini/antigravity-cli",
        profile: null,
        account: "mac:agy-alice",
      },
    ],
    codex: [{ channel: "openai", account: "mac:codex" }],
  });
});

test("only a current-format 200 response replaces the local summary", async () => {
  const seen: string[] = [];
  const answer = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(
        `${String(url)} ${new Headers(init?.headers).get("authorization")}`,
      );
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  expect(
    await fetchQuotaSummary(config, { fetch: answer(200, summary) }),
  ).toEqual({
    summary,
  });
  expect(seen[0]).toBe(
    `https://meterleaf.test${QUOTA_SUMMARY_PATH} Bearer mlk_k`,
  );
  expect(
    "issue" in (await fetchQuotaSummary(config, { fetch: answer(202, {}) })),
  ).toBe(true);
  expect(
    "issue" in (await fetchQuotaSummary(config, { fetch: answer(404, {}) })),
  ).toBe(true);
  expect(
    "issue" in
      (await fetchQuotaSummary(config, {
        fetch: answer(200, { ...summary, schemaVersion: 2 }),
      })),
  ).toBe(true);
  expect(
    "issue" in (await fetchQuotaSummary(config, { fetch: answer(200, null) })),
  ).toBe(true);
  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(await fetchQuotaSummary(config, { fetch: offline })).toEqual({
    issue: "额度摘要读取失败: offline",
  });
});

test("summary file is private and a failed write leaves no temporary file", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-summary-"));
  const value: LocalQuotaSummary = {
    schemaVersion: 1,
    fetchedAt: "2026-11-17T08:00:00Z",
    logins: { claude: [], agy: [], codex: [] },
    summary,
  };
  const path = join(dir, "quota-summary.json");
  writeQuotaSummary(path, value);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(value);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const blocked = join(dir, "blocked");
  mkdirSync(join(blocked, "occupied"), { recursive: true });
  expect(() => writeQuotaSummary(blocked, value)).toThrow();
  expect(readdirSync(dir).sort()).toEqual(["blocked", "quota-summary.json"]);
});

test("refreshClaudeQuotaSummaryLogins updates only claude logins while preserving fetchedAt, summary, and non-claude logins", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-summary-logins-"));
  const path = join(dir, "quota-summary.json");
  const initial: LocalQuotaSummary = {
    schemaVersion: 1,
    fetchedAt: "2026-11-17T08:00:00Z",
    logins: {
      claude: [{ configDir: "/h/.claude", account: "mac:default" }],
      agy: [
        {
          appDataDir: "/h/.gemini/antigravity-cli-work",
          profile: "work",
          account: "mac:agy-work",
        },
      ],
      codex: [{ channel: "openai", account: "mac:codex" }],
    },
    summary,
  };
  writeQuotaSummary(path, initial);

  const nextClaude = [
    { configDir: "/h/.claude-config/team", account: "mac:team" },
  ];
  expect(refreshClaudeQuotaSummaryLogins(path, nextClaude)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    ...initial,
    logins: {
      ...initial.logins,
      claude: nextClaude,
    },
  });
  expect(refreshClaudeQuotaSummaryLogins(path, nextClaude)).toBe(false);
  expect(
    refreshClaudeQuotaSummaryLogins(join(dir, "missing.json"), nextClaude),
  ).toBe(false);

  const corrupt = join(dir, "corrupt.json");
  writeFileSync(corrupt, "{bad json");
  expect(() => refreshClaudeQuotaSummaryLogins(corrupt, nextClaude)).toThrow();
});

test("resolveExclusiveClaudeLogins preserves only uncertain managed profiles and strips excluded directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-resolve-exclusive-"));
  const profilesDir = join(dir, "claude-config");
  const dirA = join(profilesDir, "claude-a");
  const dirB = join(profilesDir, "claude-b");
  const dirDeleted = join(profilesDir, "claude-removed");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, ".claude.json"), "{}");
  writeFileSync(join(dirB, ".claude.json"), "{}");

  const existing = [
    { configDir: join(dir, ".claude"), account: "mac:default" },
    { configDir: dirA, account: "mac:old-a" },
    { configDir: dirB, account: "mac:old-b" },
    { configDir: dirDeleted, account: "mac:deleted" },
    { configDir: join(profilesDir, ".hidden"), account: "mac:hidden" },
    { configDir: join(profilesDir, "claude-a.bak"), account: "mac:bak" },
  ];

  // 根目录可读但 dirB 遇到读取异常：dirA 采用本轮新结果，dirB 保留旧映射，其余已删除/默认/非法项全部剔除。
  expect(
    resolveExclusiveClaudeLogins(
      profilesDir,
      [{ configDir: dirA, account: "mac:new-a" }],
      existing,
      {
        profilesRootReadable: true,
        profilesDiscoveryComplete: false,
        uncertainProfileDirs: [dirB],
      },
    ),
  ).toEqual([
    { configDir: dirA, account: "mac:new-a" },
    { configDir: dirB, account: "mac:old-b" },
  ]);

  // 根目录不可枚举时：仅保留根内仍存在/不可判定的受管目录，剔除默认目录、已确认删除目录、隐藏与备份目录。
  expect(
    resolveExclusiveClaudeLogins(profilesDir, [], existing, {
      profilesRootReadable: false,
      profilesDiscoveryComplete: false,
      uncertainProfileDirs: [],
    }),
  ).toEqual([
    { configDir: dirA, account: "mac:old-a" },
    { configDir: dirB, account: "mac:old-b" },
  ]);

  // readExistingClaudeQuotaSummaryLogins 区分 ENOENT（返回 null）与损坏/不可读（抛出错误）。
  expect(
    readExistingClaudeQuotaSummaryLogins(join(dir, "absent-summary.json")),
  ).toBeNull();
  const brokenPath = join(dir, "broken-summary.json");
  writeFileSync(brokenPath, "{bad json");
  expect(() => readExistingClaudeQuotaSummaryLogins(brokenPath)).toThrow();
});
