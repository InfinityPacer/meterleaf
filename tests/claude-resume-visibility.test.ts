import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProgrammaticEntrypoints,
  reveal,
  revert,
} from "../scripts/claude-resume-visibility";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

const ids = {
  main: "11111111-1111-4111-8111-111111111111",
  child: "22222222-2222-4222-8222-222222222222",
  solo: "33333333-3333-4333-8333-333333333333",
  live: "44444444-4444-4444-8444-444444444444",
};

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function user(sessionId: string, content: unknown, extra = {}) {
  return line({
    type: "user",
    message: { role: "user", content },
    entrypoint: "sdk-cli",
    sessionId,
    ...extra,
  });
}

function assistant(sessionId: string, text: string) {
  return line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    entrypoint: "sdk-cli",
    sessionId,
  });
}

/** 与 Claude Code 列表一致：取开头 64 KiB 里第一次出现的 entrypoint 值。 */
function listedEntrypoint(path: string): string | undefined {
  const head = readFileSync(path).subarray(0, 65536).toString("utf8");
  const match = /"entrypoint": ?"([^"]*)"/.exec(head);
  return match?.[1];
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-resume-visibility-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const claude = join(root, "claude");
  const projects = join(claude, "projects", "-work");
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(claude, "sessions"));
  const paseo = join(root, "paseo", "agents", "work");
  mkdirSync(paseo, { recursive: true });
  const files: Record<keyof typeof ids, string> = {
    main: join(projects, `${ids.main}.jsonl`),
    child: join(projects, `${ids.child}.jsonl`),
    solo: join(projects, `${ids.solo}.jsonl`),
    live: join(projects, `${ids.live}.jsonl`),
  };

  // 主会话：开头是注入的上下文和一段转义文本，随后是你的提问；后半部分超过 64 KiB。
  const filler = assistant(ids.main, "x".repeat(70000));
  writeFileSync(
    files.main,
    user(
      ids.main,
      '<system-reminder>"entrypoint":"sdk-cli"</system-reminder>',
      {
        isMeta: true,
      },
    ) +
      user(ids.main, [{ type: "text", text: "确认一下 1.34 清单" }]) +
      assistant(ids.main, "好的") +
      filler +
      user(ids.main, "继续"),
  );
  writeFileSync(
    files.child,
    user(
      ids.child,
      '<paseo-system kind="agent-message">只回复 OK</paseo-system>',
    ) +
      assistant(ids.child, "OK") +
      // 上下文压缩摘要和中断提示由 Claude Code 生成，不算你发出的消息。
      user(
        ids.child,
        "This session is being continued from a previous conversation.",
        {
          isCompactSummary: true,
        },
      ) +
      user(ids.child, [
        { type: "text", text: "[Request interrupted by user for tool use]" },
      ]),
  );
  writeFileSync(files.solo, user(ids.solo, "一次性提问"));
  writeFileSync(files.live, user(ids.live, "还在进行的对话"));

  for (const id of [ids.main, ids.child, ids.live]) {
    writeFileSync(
      join(paseo, `${id.slice(0, 8)}.json`),
      JSON.stringify({
        id: `agent-${id.slice(0, 8)}`,
        provider: "claude-bo",
        persistence: { provider: "claude-bo", sessionId: id },
      }),
    );
  }
  writeFileSync(
    join(paseo, "codex.json"),
    JSON.stringify({
      provider: "codex",
      persistence: { provider: "codex", sessionId: ids.solo },
    }),
  );
  writeFileSync(
    join(claude, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: ids.live }),
  );

  const env = {
    HOME: join(root, "home"),
    PASEO_HOME: join(root, "paseo"),
    METERLEAF_CLAUDE_CONFIG_DIRS: claude,
    METERLEAF_TASK_STATE_DIR: join(root, "state"),
  };
  const original = Object.fromEntries(
    Object.entries(files).map(([key, path]) => [key, readFileSync(path)]),
  ) as Record<keyof typeof ids, Buffer>;
  return { env, files, original };
}

describe("让 Paseo 会话出现在 resume 列表", () => {
  test("只改有你提问、未在运行的 Paseo 会话，原地等长改写开头一段", () => {
    const { env, files, original } = setup();
    const before = statSync(files.main);
    const report = reveal(env);
    expect(report.revealed).toEqual([ids.main]);
    expect(report.skippedLive).toEqual([ids.live]);
    expect(report.notEligible).toBe(1);

    const after = statSync(files.main);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(listedEntrypoint(files.main)).toBe("cli");

    const text = readFileSync(files.main, "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((raw) => JSON.parse(raw) as { entrypoint: string });
    // 开头三行改为 cli；超过 64 KiB 的部分保持原样。
    expect(records.map((record) => record.entrypoint)).toEqual([
      "cli",
      "cli",
      "cli",
      "sdk-cli",
      "sdk-cli",
    ]);
    // 正文里的同名文字被转义，不是记录字段，不改。
    expect(text).toContain('\\"entrypoint\\":\\"sdk-cli\\"');

    for (const key of ["child", "solo", "live"] as const)
      expect(readFileSync(files[key]).equals(original[key])).toBe(true);
  });

  test("再次运行不重复改写，不符合条件的会话在文件不变时不再通读", () => {
    const { env, files } = setup();
    reveal(env);
    const second = reveal(env);
    expect(second.revealed).toEqual([]);
    expect(second.notEligible).toBe(1);
    const checked = JSON.parse(
      readFileSync(join(env.METERLEAF_TASK_STATE_DIR, "checked.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(checked)).toEqual([realpathSync(files.child)]);
  });

  test("预演不写文件也不留状态", () => {
    const { env, files, original } = setup();
    const report = reveal(env, { dryRun: true });
    expect(report.revealed).toEqual([ids.main]);
    expect(readFileSync(files.main).equals(original.main)).toBe(true);
    expect(() =>
      readFileSync(join(env.METERLEAF_TASK_STATE_DIR, "changes.jsonl")),
    ).toThrow();
  });

  test("按修改记录逐字节改回", () => {
    const { env, files, original } = setup();
    reveal(env);
    expect(revert(env)).toEqual({ reverted: 3, skipped: 0 });
    expect(readFileSync(files.main).equals(original.main)).toBe(true);
    expect(revert(env)).toEqual({ reverted: 0, skipped: 0 });
  });

  test("会话结束后的下一轮再处理", () => {
    const { env, files } = setup();
    reveal(env);
    rmSync(join(env.METERLEAF_CLAUDE_CONFIG_DIRS, "sessions"), {
      recursive: true,
    });
    expect(reveal(env).revealed).toEqual([ids.live]);
    expect(listedEntrypoint(files.live)).toBe("cli");
  });

  test("识别 SDK 的三种来源和冒号后带空格的写法，替换后长度不变", () => {
    const head = Buffer.from(
      '{"entrypoint":"sdk-ts"}\n{"entrypoint": "sdk-py"}\n{"entrypoint":"cli"}\n',
    );
    const found = findProgrammaticEntrypoints(head);
    expect(found.map((item) => item.to)).toEqual([
      '"entrypoint":"cli"   ',
      '"entrypoint": "cli"   ',
    ]);
    for (const item of found) expect(item.to.length).toBe(item.from.length);
  });
});
