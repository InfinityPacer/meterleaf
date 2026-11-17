import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchQuotaSummary,
  localLogins,
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
        { configDir: "/h/.claude-profiles/ara", accountUuid: null },
      ],
      agy: [
        {
          appDataDir: "/h/.gemini/antigravity-cli",
          profile: null,
          account: "agy-owl",
        },
        {
          appDataDir: "/h/.gemini/antigravity-cli-tide",
          profile: "tide",
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
        account: "mac:agy-owl",
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
