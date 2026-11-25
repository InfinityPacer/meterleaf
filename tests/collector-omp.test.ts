import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readAgy } from "../src/collector/agy";
import { DEFAULT_CHANNEL_ACCOUNTS } from "../src/collector/channel-accounts";
import { SOURCE_START } from "../src/collector/config";
import {
  OMP_H0_MIGRATION_OFFSETS_META,
  OMP_RULES_DIGEST_META,
  OMP_RULES_PENDING_META,
  ompMessage,
  readOmp,
  type OmpContext,
} from "../src/collector/omp";
import { CollectorState } from "../src/collector/state";
import { quotaModelScope } from "../src/domain/quota";
import type { IngestAccount, IngestUsage } from "../src/shared/ingest";

const temporary: string[] = [];
const opened: CollectorState[] = [];

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-omp-reader-"));
  temporary.push(root);
  const sessionsDir = join(root, "sessions");
  const statuslineDir = join(root, "statusline");
  mkdirSync(join(sessionsDir, "-work"), { recursive: true });
  mkdirSync(join(sessionsDir, "-other"), { recursive: true });
  mkdirSync(statuslineDir);
  const credentialsDb = join(root, "agent.db");
  return { root, sessionsDir, credentialsDb, statuslineDir };
}
function openState() {
  const item = new CollectorState(":memory:");
  opened.push(item);
  return item;
}
const read = (
  state: CollectorState,
  dirs: { sessionsDir: string; credentialsDb: string; statuslineDir: string },
) =>
  readOmp(state, {
    ...dirs,
    start: SOURCE_START,
    channelAccounts: DEFAULT_CHANNEL_ACCOUNTS,
  });
const lines = (...events: unknown[]) =>
  events.map((item) => JSON.stringify(item) + "\n").join("");
function usages(state: CollectorState): IngestUsage[] {
  return state
    .pending<IngestUsage>("usage", 1000)
    .map((entry) => entry.payload);
}
function accounts(state: CollectorState): Map<string, IngestAccount> {
  return new Map(
    state
      .pending<IngestAccount>("account", 1000)
      .map((entry) => [entry.payload.externalId, entry.payload]),
  );
}

const title = (text = "") => ({
  type: "title",
  v: 1,
  title: text,
  pad: " ".repeat(120 - text.length),
});
const session = { type: "session", id: "s1", cwd: "/private/workspace" };
const thinking = (level: string | null) => ({
  type: "thinking_level_change",
  id: "t" + String(level),
  thinkingLevel: level,
});

interface AssistantOptions {
  id: string;
  provider: string;
  model: string;
  usage?: Record<string, unknown>;
  completedAt?: number;
  timestamp?: string;
  credentialId?: number;
  errorStatus?: number;
}
function assistant(options: AssistantOptions) {
  const completedAt = options.completedAt ?? Date.parse("2026-10-30T10:00:00Z");
  return {
    type: "message",
    id: options.id,
    timestamp: options.timestamp ?? new Date(completedAt).toISOString(),
    message: {
      role: "assistant",
      provider: options.provider,
      model: options.model,
      content: [{ type: "text", text: "private answer" }],
      completedAt,
      ...(options.credentialId === undefined
        ? {}
        : { credentialId: options.credentialId }),
      ...(options.errorStatus === undefined
        ? {}
        : { stopReason: "error", errorStatus: options.errorStatus }),
      usage: options.usage ?? {
        input: 1000,
        output: 80,
        cacheRead: 200,
        cacheWrite: 30,
        totalTokens: 1310,
        reasoningTokens: 20,
        cost: { total: 9.99 },
      },
    },
  };
}
const argon = (id: string, extra: Partial<AssistantOptions> = {}) =>
  assistant({
    id,
    provider: "google-antigravity",
    model: "gemini-4-argon",
    ...extra,
  });
const glm = (id: string, extra: Partial<AssistantOptions> = {}) =>
  assistant({
    id,
    provider: "opencode-go",
    model: "glm-5.3-flash",
    ...extra,
  });

/** 仿 omp 的 agent.db：data 列放令牌，采集器不得读取。 */
function writeCredentials(path: string, emails: Record<number, string>) {
  const db = new Database(path);
  db.run(
    "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT)",
  );
  for (const [id, email] of Object.entries(emails))
    db.run(
      "INSERT INTO auth_credentials VALUES (?, 'google-antigravity', 'oauth', 'secret-token', NULL, ?)",
      [Number(id), `email:${email}`],
    );
  db.run(
    "INSERT INTO auth_credentials VALUES (99, 'anthropic', 'oauth', 'secret-token', NULL, 'email:Carol@example.com')",
  );
  db.close();
}

function writeSession(
  dirs: { sessionsDir: string },
  file: string,
  content: string,
) {
  const path = join(dirs.sessionsDir, file);
  writeFileSync(path, content);
  return path;
}

test("assistant messages become requests with exclusive buckets, reasoning kept inside output, and nothing private", () => {
  const context: OmpContext = { effort: null, tier: null };
  const parsed = ompMessage(argon("a1"), context)!;
  expect(parsed.usage.tokens).toEqual({
    input: 1000,
    output: 80,
    cacheRead: 200,
    cacheWrite: 30,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: 20,
  });
  expect(parsed.usage.occurredAt).toBe("2026-10-30T10:00:00.000Z");
  expect(JSON.stringify(parsed)).not.toContain("private");
  expect(JSON.stringify(parsed)).not.toContain("9.99");

  // omp 推理量为 0 时省略字段，保持未知而不是补零。
  const omitted = ompMessage(
    glm("a2", { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }),
    context,
  )!;
  expect(omitted.usage.tokens.reasoning).toBeNull();
  expect(omitted.usage.tokens.cacheRead).toBe(0);
});

test("zero-usage responses are not requests and inconsistent counters are rejected", () => {
  const context: OmpContext = { effort: null, tier: null };
  const zeros = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  expect(ompMessage(glm("z", { usage: zeros }), context)).toBeNull();
  expect(() =>
    ompMessage(
      glm("bad", { usage: { input: 1, output: 5, reasoningTokens: 6 } }),
      context,
    ),
  ).toThrow();
  expect(() =>
    ompMessage(glm("neg", { usage: { input: -1, output: 5 } }), context),
  ).toThrow();
});

test("the request identity ignores the file and session but follows the request", () => {
  const context: OmpContext = { effort: null, tier: null };
  const first = ompMessage(argon("a1"), context)!.usage.externalId;
  expect(ompMessage(argon("a1"), context)!.usage.externalId).toBe(first);
  expect(first.startsWith("omp-")).toBe(true);
  expect(ompMessage(argon("a2"), context)!.usage.externalId).not.toBe(first);
  expect(
    ompMessage(argon("a1", { usage: { input: 1001, output: 80 } }), context)!
      .usage.externalId,
  ).not.toBe(first);
});

test("Antigravity requests join the active Google account and OpenCode Go requests the Go account", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  writeFileSync(
    join(dirs.statuslineDir, "quota-alice.tsv"),
    "gemini_5h\t10\t1793409600\nplan\tGoogle AI Ultra\t-\n",
  );
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(
      title(),
      session,
      thinking("high"),
      { type: "message", id: "u", message: { role: "user" } },
      argon("a1"),
      argon("a2", {
        model: "claude-sonnet-5-5",
        completedAt: Date.parse("2026-10-30T10:01:00Z"),
      }),
      glm("g1", { completedAt: Date.parse("2026-10-30T10:02:00Z") }),
      { type: "message", id: "tr", message: { role: "toolResult" } },
      { type: "compaction", id: "c", summary: "private summary" },
    ),
  );
  const state = openState();
  // 同步里 Antigravity 读取器先于 omp 运行，套餐由它记下。
  readAgy(state, {
    conversationsDir: join(dirs.root, "none"),
    statuslineDir: dirs.statuslineDir,
    start: SOURCE_START,
  });
  const report = await read(state, dirs);
  expect(report).toMatchObject({
    read: 3,
    recorded: 3,
    agyRecorded: 2,
    agyMissingAccount: 0,
    invalid: 0,
  });
  const byId = new Map(usages(state).map((usage) => [usage.model, usage]));
  expect(byId.get("gemini-4-argon")).toMatchObject({
    accountExternalId: "agy-alice",
    metadata: { origin: "omp_local", reasoning_effort: "high" },
  });
  expect(byId.get("claude-sonnet-5-5")?.accountExternalId).toBe("agy-alice");
  expect(byId.get("glm-5.3-flash")?.accountExternalId).toBe("opencode-go");
  const known = accounts(state);
  expect(known.get("agy-alice")).toMatchObject({
    name: "Antigravity (alice)",
    platform: "google",
    plan: "Google AI Ultra",
  });
  expect(known.get("opencode-go")).toMatchObject({ plan: "go" });
  // 模型名保持原样，服务端按前缀把它们分进 Gemini 池和第三方池。
  const gemini = quotaModelScope("seven-day", true)!;
  expect(gemini("gemini-4-argon")).toBe(true);
  expect(gemini("claude-sonnet-5-5")).toBe(false);
  expect(JSON.stringify(usages(state))).not.toContain("private");
  expect(state.sourcePendingCounts().omp).toBe(3);
});

test("a later read only takes appended requests, and a half-written line waits", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const path = writeSession(
    dirs,
    "-work/one.jsonl",
    lines(title(), session, thinking("medium"), glm("g1")),
  );
  const state = openState();
  expect((await read(state, dirs)).recorded).toBe(1);

  const next = JSON.stringify(
    glm("g2", { completedAt: Date.parse("2026-10-30T11:00:00Z") }),
  );
  appendFileSync(path, next.slice(0, 40));
  expect((await read(state, dirs)).recorded).toBe(0);
  appendFileSync(path, next.slice(40) + "\n");
  const report = await read(state, dirs);
  expect(report.recorded).toBe(1);
  expect(report.read).toBe(1);
  // 续读时仍沿用文件开头设置的思考档位。
  expect(usages(state).at(-1)?.metadata.reasoning_effort).toBe("medium");
  expect(usages(state)).toHaveLength(2);
});

test("rewriting the title line in place does not count the session twice", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const events = [session, thinking("low"), glm("g1"), glm("g2")];
  // 标题行定长补空格，omp 改标题时原地改写第 0 行，文件长度不变。
  const path = writeSession(dirs, "-work/one.jsonl", lines(title(), ...events));
  const state = openState();
  expect((await read(state, dirs)).recorded).toBe(2);
  const bytes = readFileSync(path);
  const head = Buffer.from(JSON.stringify(title("New title")) + "\n");
  const original = JSON.stringify(title()).length + 1;
  expect(head.length).toBe(original);
  writeFileSync(path, Buffer.concat([head, bytes.subarray(original)]));
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  const report = await read(state, dirs);
  expect(report.recorded).toBe(0);
  expect(usages(state)).toHaveLength(2);
});

test("a moved session file and a branch copy of earlier messages are not billed again", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const shared = [thinking("high"), argon("a1"), glm("g1")];
  const original = writeSession(
    dirs,
    "-work/one.jsonl",
    lines(title(), session, ...shared),
  );
  const state = openState();
  expect((await read(state, dirs)).recorded).toBe(2);

  // 工作目录迁移：同一个文件整体移到另一个编码目录。
  renameSync(original, join(dirs.sessionsDir, "-other/one.jsonl"));
  expect((await read(state, dirs)).recorded).toBe(0);

  // 分支会话：新会话 ID，复制旧消息后追加一条新请求。
  writeSession(
    dirs,
    "-work/branch.jsonl",
    lines(
      title(),
      { ...session, id: "s2" },
      ...shared,
      glm("g2", { completedAt: Date.parse("2026-10-30T12:00:00Z") }),
    ),
  );
  const report = await read(state, dirs);
  expect(report.read).toBe(3);
  expect(report.recorded).toBe(1);
  expect(usages(state)).toHaveLength(3);
});

test("requests before the fixed start and unrouted channels are dropped with counts, not billed", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(
      title(),
      glm("old", { completedAt: Date.parse("2026-09-01T00:00:00Z") }),
      assistant({ id: "x1", provider: "openrouter", model: "some-model" }),
      glm("g1"),
    ),
  );
  const state = openState();
  const report = await read(state, dirs);
  expect(report).toMatchObject({
    read: 3,
    recorded: 1,
    beforeStart: 1,
    skipped: { openrouter: 1 },
  });
});

test("Antigravity requests wait for an active account and are backfilled once it appears", async () => {
  const dirs = workspace();
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(title(), thinking("high"), argon("a1"), glm("g1")),
  );
  const state = openState();
  const first = await read(state, dirs);
  expect(first).toMatchObject({
    recorded: 1,
    agyRecorded: 0,
    agyMissingAccount: 1,
    skipped: { "google-antigravity (缺失账户)": 1 },
  });
  expect(usages(state)).toHaveLength(1);

  // 账号仍未出现时，暂缓的文件继续重读，已入账的 Go 请求不会重复。
  const again = await read(state, dirs);
  expect(again).toMatchObject({ recorded: 0, agyMissingAccount: 1 });

  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const done = await read(state, dirs);
  expect(done).toMatchObject({
    recorded: 1,
    agyRecorded: 1,
    agyMissingAccount: 0,
  });
  expect(
    usages(state)
      .map((usage) => usage.accountExternalId)
      .sort(),
  ).toEqual(["agy-alice", "opencode-go"]);
  expect((await read(state, dirs)).recorded).toBe(0);
});

test("a configured omp channel rule takes precedence over the Antigravity default", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  writeSession(dirs, "-work/one.jsonl", lines(title(), argon("a1")));
  const state = openState();
  const report = await readOmp(state, {
    ...dirs,
    start: SOURCE_START,
    channelAccounts: [
      {
        source: "omp",
        channel: "google-antigravity",
        id: "custom-agy",
        name: "Custom",
        platform: "google",
        kind: "subscription",
        plan: null,
      },
    ],
  });
  expect(report).toMatchObject({ recorded: 1, agyRecorded: 0 });
  expect(usages(state)[0]?.accountExternalId).toBe("custom-agy");
});

test("Antigravity requests go to the Google account omp used, falling back to the active account", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  writeCredentials(dirs.credentialsDb, {
    1: "Alice@example.com",
    2: "Bob.Two@example.com",
  });
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(
      title(),
      argon("a1", { credentialId: 1 }),
      argon("a2", {
        credentialId: 2,
        completedAt: Date.parse("2026-10-30T10:01:00Z"),
      }),
      // 早期记录没有编号，账号库里也查不到的编号同样退回活跃账号。
      argon("a3", { completedAt: Date.parse("2026-10-30T10:02:00Z") }),
      argon("a4", {
        credentialId: 7,
        completedAt: Date.parse("2026-10-30T10:03:00Z"),
      }),
    ),
  );
  const state = openState();
  const report = await read(state, dirs);
  expect(report).toMatchObject({ recorded: 4, agyRecorded: 4 });
  expect(
    usages(state)
      .map((usage) => usage.accountExternalId)
      .sort(),
  ).toEqual(["agy-alice", "agy-alice", "agy-alice", "agy-bob-two"]);
  expect(accounts(state).get("agy-bob-two")).toMatchObject({
    name: "Antigravity (bob-two)",
    platform: "google",
  });
});

test("an Antigravity quota-exhausted response is counted for a refresh but not billed", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(
      title(),
      argon("a1", { errorStatus: 429, usage: zero }),
      glm("g1", { errorStatus: 429, usage: zero }),
    ),
  );
  const state = openState();
  const report = await read(state, dirs);
  expect(report).toMatchObject({ recorded: 0, agyExhausted: 1 });
  expect(usages(state)).toHaveLength(0);
  // 已读过的响应下一轮不再触发。
  expect((await read(state, dirs)).agyExhausted).toBe(0);
});

const ruleB = [
  ...DEFAULT_CHANNEL_ACCOUNTS,
  {
    source: "omp" as const,
    channel: "zai",
    id: "custom-zai",
    name: "Custom",
    platform: "zai",
    kind: "subscription" as const,
    plan: null,
  },
];
const readWith = (
  state: CollectorState,
  dirs: { sessionsDir: string; credentialsDb: string; statuslineDir: string },
  channelAccounts: typeof ruleB | typeof DEFAULT_CHANNEL_ACCOUNTS,
  maxBytes?: number,
) =>
  readOmp(state, { ...dirs, start: SOURCE_START, channelAccounts }, maxBytes);
const exhausted429 = (id: string, completedAt: number) =>
  argon(id, {
    errorStatus: 429,
    completedAt,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
/** 让 first 比 second 新，补录首轮按修改时间先读 first。 */
function order(dirs: { sessionsDir: string }, first: string, second: string) {
  const now = Date.now() / 1000;
  utimesSync(join(dirs.sessionsDir, second), now - 60, now - 60);
  utimesSync(join(dirs.sessionsDir, first), now, now);
}

test("rule-change backfill rereads history without counting old Antigravity 429 responses", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(title(), exhausted429("a1", Date.parse("2026-10-30T10:00:00Z"))),
  );
  const state = openState();
  expect((await read(state, dirs)).agyExhausted).toBe(1);
  const changed = await readWith(state, dirs, ruleB);
  expect(changed.filesRead).toBeGreaterThan(0);
  expect(changed.agyExhausted).toBe(0);
});

test("a 429 appended while a multi-round backfill is pending still counts; replayed history does not", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(title(), exhausted429("a1", Date.parse("2026-10-30T10:00:00Z"))),
  );
  writeSession(
    dirs,
    "-other/two.jsonl",
    lines(title(), exhausted429("b1", Date.parse("2026-10-30T10:01:00Z"))),
  );
  const state = openState();
  expect((await read(state, dirs)).agyExhausted).toBe(2);
  order(dirs, "-work/one.jsonl", "-other/two.jsonl");
  const first = await readWith(state, dirs, ruleB, 1);
  expect(first).toMatchObject({ deferred: true, agyExhausted: 0 });
  // 续扫前向尚未补扫的旧文件追加一条新的 429。
  appendFileSync(
    join(dirs.sessionsDir, "-other/two.jsonl"),
    lines(exhausted429("b2", Date.parse("2026-10-30T10:02:00Z"))),
  );
  const resumed = await readWith(state, dirs, ruleB);
  expect(resumed).toMatchObject({ deferred: false, agyExhausted: 1 });
  expect(state.getMeta(OMP_RULES_PENDING_META)).toBeNull();
  // 补录期间新建的文件同样按新内容计入。
  writeSession(
    dirs,
    "-work/three.jsonl",
    lines(title(), exhausted429("c1", Date.parse("2026-10-30T10:03:00Z"))),
  );
  expect((await readWith(state, dirs, ruleB)).agyExhausted).toBe(1);
});

test("switching A → B (incomplete) → A never recounts a 429 already counted during B", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(title(), exhausted429("a1", Date.parse("2026-10-30T10:00:00Z"))),
  );
  writeSession(
    dirs,
    "-other/two.jsonl",
    lines(title(), exhausted429("b1", Date.parse("2026-10-30T10:01:00Z"))),
  );
  const state = openState();
  expect((await read(state, dirs)).agyExhausted).toBe(2);
  appendFileSync(
    join(dirs.sessionsDir, "-work/one.jsonl"),
    lines(exhausted429("a2", Date.parse("2026-10-30T10:02:00Z"))),
  );
  order(dirs, "-work/one.jsonl", "-other/two.jsonl");
  const partial = await readWith(state, dirs, ruleB, 1);
  expect(partial).toMatchObject({ deferred: true, agyExhausted: 1 });
  const back = await readWith(state, dirs, DEFAULT_CHANNEL_ACCOUNTS);
  expect(back).toMatchObject({ deferred: false, agyExhausted: 0 });
  expect(state.getMeta(OMP_RULES_PENDING_META)).toBeNull();
});

/** 原地截断重写（同一 inode），返回重写前后的 inode 以便断言。 */
function rewriteInPlace(path: string, content: string) {
  const before = statSync(path).ino;
  writeFileSync(path, content);
  return { before, after: statSync(path).ino };
}

test("an in-place shorter rewrite with the same inode counts its new 429 during a rule-change backfill", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const path = join(dirs.sessionsDir, "-work/one.jsonl");
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(
      title(),
      argon("a1", { completedAt: Date.parse("2026-10-30T10:00:00Z") }),
      argon("a2", { completedAt: Date.parse("2026-10-30T10:01:00Z") }),
      argon("a3", { completedAt: Date.parse("2026-10-30T10:02:00Z") }),
    ),
  );
  const state = openState();
  await read(state, dirs);
  const oldOffset = statSync(path).size;
  const content = lines(
    title(),
    exhausted429("n1", Date.parse("2026-10-30T11:00:00Z")),
  );
  const { before, after } = rewriteInPlace(path, content);
  expect(after).toBe(before);
  expect(Buffer.byteLength(content)).toBeLessThan(oldOffset);
  expect((await readWith(state, dirs, ruleB)).agyExhausted).toBe(1);
});

test("an in-place rewrite at least as long as the old offset counts its new 429 because the tail fingerprint differs", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const path = join(dirs.sessionsDir, "-work/one.jsonl");
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(
      title(),
      argon("a1", { completedAt: Date.parse("2026-10-30T10:00:00Z") }),
      argon("a2", { completedAt: Date.parse("2026-10-30T10:01:00Z") }),
    ),
  );
  const state = openState();
  await read(state, dirs);
  const oldOffset = statSync(path).size;
  const content = lines(
    title(),
    exhausted429("n1", Date.parse("2026-10-30T11:00:00Z")),
    ...Array.from({ length: 6 }, (_, index) =>
      glm(`g${index}`, {
        completedAt: Date.parse("2026-10-30T11:01:00Z") + index * 1000,
      }),
    ),
  );
  const { before, after } = rewriteInPlace(path, content);
  expect(after).toBe(before);
  expect(Buffer.byteLength(content)).toBeGreaterThanOrEqual(oldOffset);
  // 新的 429 位于旧偏移之内，但旧偏移前的末尾指纹已不同。
  expect(content.indexOf('"n1"')).toBeLessThan(oldOffset);
  expect((await readWith(state, dirs, ruleB)).agyExhausted).toBe(1);
});

test("after an in-place rewrite, switching A → B (incomplete) → A does not recount the rewritten file's new 429", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const path = join(dirs.sessionsDir, "-work/one.jsonl");
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(
      title(),
      argon("a1", { completedAt: Date.parse("2026-10-30T10:00:00Z") }),
      argon("a2", { completedAt: Date.parse("2026-10-30T10:01:00Z") }),
      argon("a3", { completedAt: Date.parse("2026-10-30T10:02:00Z") }),
    ),
  );
  writeSession(
    dirs,
    "-other/two.jsonl",
    lines(
      title(),
      argon("b1", { completedAt: Date.parse("2026-10-30T10:03:00Z") }),
    ),
  );
  const state = openState();
  await read(state, dirs);
  const { before, after } = rewriteInPlace(
    path,
    lines(title(), exhausted429("n1", Date.parse("2026-10-30T11:00:00Z"))),
  );
  expect(after).toBe(before);
  order(dirs, "-work/one.jsonl", "-other/two.jsonl");
  const partial = await readWith(state, dirs, ruleB, 1);
  expect(partial).toMatchObject({ deferred: true, agyExhausted: 1 });
  const back = await readWith(state, dirs, DEFAULT_CHANNEL_ACCOUNTS);
  expect(back).toMatchObject({ deferred: false, agyExhausted: 0 });
});

test("an equal-length in-place rewrite that keeps the last 256 bytes still counts its new 429 once, without touching the outbox", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const path = join(dirs.sessionsDir, "-work/one.jsonl");
  const base = Date.parse("2026-10-30T10:00:00Z");
  // 等长替换：两行都补齐到同一字节长度（只含 ASCII）。
  const oldEntry = argon("a-old", { completedAt: base });
  const newEntry = exhausted429("n-new", base + 1000);
  const width =
    Math.max(JSON.stringify(oldEntry).length, JSON.stringify(newEntry).length) +
    16;
  const padded = (entry: object) => {
    const bare = JSON.stringify({ ...entry, pad: "" });
    return JSON.stringify({ ...entry, pad: "x".repeat(width - bare.length) });
  };
  const oldLine = padded(oldEntry);
  const newLine = padded(newEntry);
  expect(Buffer.byteLength(newLine)).toBe(Buffer.byteLength(oldLine));
  const tail = lines(
    ...Array.from({ length: 30 }, (_, index) =>
      glm(`g${index}`, { completedAt: base + 60_000 + index * 1000 }),
    ),
  );
  writeFileSync(path, lines(title()) + oldLine + "\n" + tail);
  const state = openState();
  await read(state, dirs);
  state.acknowledge(state.pending("usage", 10_000).map((item) => item.seq));
  const before = readFileSync(path);
  expect(before.length).toBeGreaterThan(4096);
  expect(before.indexOf(oldLine)).toBeLessThan(before.length - 256);

  const { before: inodeBefore, after: inodeAfter } = rewriteInPlace(
    path,
    before.toString("utf8").replace(oldLine, newLine),
  );
  const after = readFileSync(path);
  expect(inodeAfter).toBe(inodeBefore);
  expect(after.length).toBe(before.length);
  expect(after.subarray(-256).equals(before.subarray(-256))).toBe(true);

  expect((await readWith(state, dirs, ruleB)).agyExhausted).toBe(1);
  // 事件登记只写幂等表，不产生待发送条目。
  expect(state.pendingCounts().usage).toBe(0);
  expect(state.sourcePendingCounts().omp).toBe(0);
  expect(
    (await readWith(state, dirs, DEFAULT_CHANNEL_ACCOUNTS)).agyExhausted,
  ).toBe(0);
});

test("upgrading from a legacy omp_files cursor without 429 keys suppresses old 429s while counting newly appended ones", async () => {
  const dirs = workspace();
  writeFileSync(join(dirs.statuslineDir, "current-account"), "alice\n");
  const path = join(dirs.sessionsDir, "-work/one.jsonl");
  const base = Date.parse("2026-10-30T10:00:00Z");
  writeSession(
    dirs,
    "-work/one.jsonl",
    lines(title(), exhausted429("h0-old", base)),
  );

  // 场景 1：模拟旧版已扫描并写入 omp_files 游标，但没有规则摘要和 omp-agy-429 去重键。
  const stateOnlyOld = openState();
  expect((await read(stateOnlyOld, dirs)).agyExhausted).toBe(1);
  stateOnlyOld.deleteMeta(OMP_RULES_DIGEST_META);
  stateOnlyOld.db
    .query("DELETE FROM source_usage WHERE source = 'omp-agy-429'")
    .run();

  const migratedOnlyOld = await read(stateOnlyOld, dirs);
  expect(migratedOnlyOld.filesRead).toBeGreaterThan(0);
  expect(migratedOnlyOld.agyExhausted).toBe(0);
  expect(stateOnlyOld.getMeta(OMP_H0_MIGRATION_OFFSETS_META)).toBeNull();
  // 后续规则切换也不再重复触发旧 429（已补记去重键）。
  expect((await readWith(stateOnlyOld, dirs, ruleB)).agyExhausted).toBe(0);

  // 场景 2：同一旧版升级夹具在旧游标之后追加一条新 429，首次补录只计新 429。
  const stateWithNew = openState();
  expect((await read(stateWithNew, dirs)).agyExhausted).toBe(1);
  stateWithNew.deleteMeta(OMP_RULES_DIGEST_META);
  stateWithNew.db
    .query("DELETE FROM source_usage WHERE source = 'omp-agy-429'")
    .run();
  appendFileSync(path, lines(exhausted429("post-upgrade-new", base + 60_000)));

  const migratedWithNew = await read(stateWithNew, dirs);
  expect(migratedWithNew.agyExhausted).toBe(1);
  expect(stateWithNew.getMeta(OMP_H0_MIGRATION_OFFSETS_META)).toBeNull();
  expect((await readWith(stateWithNew, dirs, ruleB)).agyExhausted).toBe(0);
});
