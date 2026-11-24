import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_POOL_MODELS,
  CODEX_WARMUP_MODEL,
  DEFAULT_USAGE_REFRESH_MAX_MINUTES,
  DEFAULT_USAGE_REFRESH_MIN_MINUTES,
  UNOPENED_WARMUP_COOLDOWN_SEC,
  WARMUP_PROMPTS,
  loadWarmupConfig,
  parseUsageBuckets,
  readAgyQuotaTsv,
  runWarmup,
  type CommandRunner,
} from "../scripts/quota-warmup";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-quota-warmup-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const statuslineDir = join(root, "cache", "agy-statusline");
  const geminiDir = join(home, ".gemini");
  const defaultAppData = join(geminiDir, "antigravity-cli");
  const defaultConvDir = join(defaultAppData, "conversations");
  const tideAppData = join(geminiDir, "antigravity-cli-tide");
  const tideConvDir = join(tideAppData, "conversations");
  const codexHome = join(home, ".codex");
  const codexSessions = join(codexHome, "sessions", "2026", "11", "10");
  const stateDir = join(root, "state");
  const binDir = join(home, ".local", "bin");

  for (const dir of [
    statuslineDir,
    defaultConvDir,
    tideConvDir,
    codexSessions,
    stateDir,
    binDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const agyBin = join(binDir, "agy");
  const codexBin = join(binDir, "codex");
  writeFileSync(agyBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(codexBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  writeFileSync(join(statuslineDir, "current-account"), "phronara\n");
  writeFileSync(
    join(tideAppData, "antigravity-oauth-token"),
    JSON.stringify({ id_token_email: "tidewren@gmail.com" }),
  );

  const env: Record<string, string> = {
    HOME: home,
    METERLEAF_TASK_STATE_DIR: stateDir,
    METERLEAF_AGY_STATUSLINE_DIR: statuslineDir,
    METERLEAF_AGY_CONVERSATIONS_DIR: defaultConvDir,
    CODEX_HOME: codexHome,
    AGY_BIN: agyBin,
    CODEX_BIN: codexBin,
  };

  return {
    root,
    statuslineDir,
    defaultAppData,
    tideAppData,
    codexSessions,
    stateDir,
    agyBin,
    codexBin,
    env,
  };
}

function writeCodexRollout(
  path: string,
  options: {
    provider?: string;
    timestamp: string;
    fiveHourReset: number;
    sevenDayReset: number;
  },
) {
  const lines = [
    JSON.stringify({
      timestamp: options.timestamp,
      type: "session_meta",
      payload: {
        id: "01a1c502-34ae-7a90-b131-e8d09c80ad4d",
        model_provider: options.provider ?? "openai",
      },
    }),
    JSON.stringify({
      timestamp: options.timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          plan_type: "plus",
          primary: {
            used_percent: 12,
            window_minutes: 300,
            resets_at: options.fiveHourReset,
          },
          secondary: {
            used_percent: 100,
            window_minutes: 10080,
            resets_at: options.sevenDayReset,
          },
        },
      },
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("quota-warmup task script", () => {
  test("by default warms up only expired weekly windows across both agy accounts and codex, and ignores expired 5h windows", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;

    // phronara: 3p_weekly 已到期 (nowSec - 600)，gemini_5h 已到期 (nowSec - 300)，gemini_weekly 未到期
    const phronaraQuota = join(sb.statuslineDir, "quota-phronara.tsv");
    writeFileSync(
      phronaraQuota,
      [
        `gemini_5h\t40\t${nowSec - 300}`,
        `gemini_weekly\t15\t${nowSec + 86400}`,
        `3p_5h\t0\t${nowSec + 3600}`,
        `3p_weekly\t100\t${nowSec - 600}`,
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );
    const freshMtime = new Date((nowSec - 60) * 1000);
    utimesSync(phronaraQuota, freshMtime, freshMtime);

    // tidewren (@tide): gemini_weekly 已到期 (nowSec - 120)，3p_weekly 未到期
    const tideQuota = join(sb.statuslineDir, "quota-tidewren.tsv");
    writeFileSync(
      tideQuota,
      [
        `gemini_5h\t80\t${nowSec - 120}`,
        `gemini_weekly\t100\t${nowSec - 120}`,
        `3p_5h\t10\t${nowSec + 7200}`,
        `3p_weekly\t50\t${nowSec + 172800}`,
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );
    utimesSync(tideQuota, freshMtime, freshMtime);

    // codex: seven-day 已到期 (nowSec - 50)，five-hour 未到期
    writeCodexRollout(join(sb.codexSessions, "rollout-1.jsonl"), {
      timestamp: new Date((nowSec - 10) * 1000).toISOString(),
      fiveHourReset: nowSec + 1800,
      sevenDayReset: nowSec - 50,
    });

    const calls: { argv: string[]; env: Record<string, string> }[] = [];
    const runner: CommandRunner = async (argv, opts) => {
      calls.push({ argv, env: opts.env });
      if (argv.includes("/usage")) {
        const isTide = argv.includes("antigravity-cli-tide");
        const nextWeek = new Date((nowSec + 604800) * 1000).toISOString();
        const next5h = new Date((nowSec + 18000) * 1000).toISOString();
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "SUCCESS",
            command: {
              data: {
                groups: [
                  {
                    buckets: [
                      {
                        id: "gemini-5h",
                        remaining_fraction: 1,
                        reset_time: next5h,
                      },
                      {
                        id: "gemini-weekly",
                        remaining_fraction: isTide ? 1 : 0.85,
                        reset_time: nextWeek,
                      },
                      {
                        id: "3p-5h",
                        remaining_fraction: 1,
                        reset_time: next5h,
                      },
                      {
                        id: "3p-weekly",
                        remaining_fraction: isTide ? 0.5 : 1,
                        reset_time: nextWeek,
                      },
                    ],
                  },
                ],
              },
            },
          }),
          logText: "",
        };
      }
      return { exitCode: 0, stdout: "ok\n", logText: "" };
    };

    const chosenPrompts: string[] = [];
    let promptIdx = 0;
    const report = await runWarmup(sb.env, {
      now: () => new Date(nowSec * 1000),
      pickPrompt: (prompts) => {
        const p = prompts[promptIdx % prompts.length]!;
        promptIdx += 1;
        chosenPrompts.push(p);
        return p;
      },
      runner,
    });

    // 应只触发 3 个目标：phronara 的 3p_weekly、tidewren 的 gemini_weekly、codex 的 seven-day
    // phronara 的 gemini_5h 虽然到期，但默认不开启 5h 预热，不应触发
    expect(report.actions.map((a) => a.key)).toEqual([
      "agy:phronara:3p",
      "agy:tidewren:gemini",
      "codex:default",
    ]);
    expect(report.actions.every((a) => a.succeeded)).toBe(true);
    expect(chosenPrompts).toEqual([
      WARMUP_PROMPTS[0]!,
      WARMUP_PROMPTS[1]!,
      WARMUP_PROMPTS[2]!,
    ]);

    // 检查命令参数与最廉价模型选择
    // 1. phronara 3p prompt + /usage
    expect(calls[0]!.argv).toContain("--model");
    expect(calls[0]!.argv).toContain(AGY_POOL_MODELS["3p"][0]!); // gpt-oss-120b-medium
    expect(calls[0]!.argv).not.toContain("--app_data_dir");
    expect(calls[1]!.argv).toContain("/usage");

    // 2. tidewren (@tide) gemini prompt + /usage，必须带 WSL_INTEROP=1 与 --app_data_dir antigravity-cli-tide
    expect(calls[2]!.env.WSL_INTEROP).toBe("1");
    expect(calls[2]!.argv).toContain("--app_data_dir");
    expect(calls[2]!.argv).toContain("antigravity-cli-tide");
    expect(calls[2]!.argv).toContain(AGY_POOL_MODELS.gemini[0]!); // gemini-3.8-flash-low
    expect(calls[3]!.argv).toContain("/usage");

    // 3. codex exec，必须指定 openai 通道、gpt-6-luna 与 low effort，且不带 --ephemeral 以便采集器读取新额度
    expect(calls[4]!.argv[0]).toBe(sb.codexBin);
    expect(calls[4]!.argv).toContain("exec");
    expect(calls[4]!.argv).toContain("--ignore-user-config");
    expect(calls[4]!.argv).toContain('model_provider="openai"');
    expect(calls[4]!.argv).toContain(`model="${CODEX_WARMUP_MODEL}"`);
    expect(calls[4]!.argv).toContain(
      'base_instructions="Reply with one word only and do not call any tools."',
    );
    expect(calls[4]!.argv).not.toContain("--ephemeral");

    // 检查状态栏 TSV 已被更新为新周期，且保留了 plan 行
    const updatedPhronara = readFileSync(
      join(sb.statuslineDir, "quota-phronara.tsv"),
      "utf8",
    );
    expect(updatedPhronara).toContain(`3p_weekly\t0\t${nowSec + 604800}`);
    expect(updatedPhronara).toContain("plan\tGoogle AI Ultra\t-");

    // 紧接着再跑一轮（即使还没刷新 TSV 的 codex），因为 state.json 已记录 handled，不会重复预热
    const secondReport = await runWarmup(sb.env, {
      now: () => new Date((nowSec + 60) * 1000),
      runner,
    });
    expect(secondReport.actions).toHaveLength(0);
    expect(secondReport.skippedHandled).toContain("codex:default");
  });

  test("supports --codex-5h for Codex 5h without enabling Agy 5h, and --include-5h with 3p model fallback", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;

    // phronara: 仅 3p_5h 到期，3p_weekly 未到期
    const phronaraQuota = join(sb.statuslineDir, "quota-phronara.tsv");
    writeFileSync(
      phronaraQuota,
      [
        `gemini_5h\t10\t${nowSec + 3600}`,
        `gemini_weekly\t15\t${nowSec + 86400}`,
        `3p_5h\t100\t${nowSec - 10}`,
        `3p_weekly\t40\t${nowSec + 86400}`,
      ].join("\n") + "\n",
    );
    const freshMtime = new Date((nowSec - 60) * 1000);
    utimesSync(phronaraQuota, freshMtime, freshMtime);

    // codex: 仅 five-hour 到期，seven-day 未到期
    writeCodexRollout(join(sb.codexSessions, "rollout-1.jsonl"), {
      timestamp: new Date((nowSec - 10) * 1000).toISOString(),
      fiveHourReset: nowSec - 20,
      sevenDayReset: nowSec + 86400,
    });

    const attemptedModels: string[] = [];
    const runner: CommandRunner = async (argv) => {
      const modelIdx = argv.indexOf("--model");
      if (modelIdx !== -1) {
        const model = argv[modelIdx + 1]!;
        attemptedModels.push(model);
        if (model === "gpt-oss-120b-medium") {
          return { exitCode: 1, stdout: "", logText: "" };
        }
      }
      return { exitCode: 0, stdout: "{}", logText: "" };
    };

    // 仅开启 includeCodex5h 时，只预热 codex:five-hour，不触发 phronara 的 3p_5h
    const codexOnly = await runWarmup(sb.env, {
      includeCodex5h: true,
      now: () => new Date(nowSec * 1000),
      runner,
    });
    expect(codexOnly.actions.map((a) => [a.key, a.windows])).toEqual([
      ["codex:default", ["five-hour"]],
    ]);

    // 开启 METERLEAF_WARMUP_5H=1 时，phronara 的 3p_5h 也触发并从 gpt-oss-120b-medium 回退到 claude-sonnet-5-5-low
    const report = await runWarmup(
      { ...sb.env, METERLEAF_WARMUP_5H: "1" },
      {
        now: () => new Date(nowSec * 1000),
        runner,
      },
    );

    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]!.windows).toEqual(["3p_5h"]);
    expect(report.actions[0]!.succeeded).toBe(true);
    expect(report.actions[0]!.model).toBe("claude-sonnet-5-5-low");
    expect(attemptedModels).toEqual([
      "gpt-oss-120b-medium",
      "claude-sonnet-5-5-low",
    ]);
  });

  test("retries on the next scheduled task run when a warmup attempt fails", async () => {
    const sb = createSandbox();
    const resetSec = 1_800_000_000;
    const wakeSec = resetSec + 21_600;

    writeFileSync(
      join(sb.statuslineDir, "quota-phronara.tsv"),
      `gemini_weekly\t100\t${resetSec}\n`,
    );

    let shouldFail = true;
    let runCount = 0;
    const runner: CommandRunner = async (argv) => {
      if (!argv.includes("/usage")) runCount += 1;
      return { exitCode: shouldFail ? 1 : 0, stdout: "", logText: "" };
    };

    // 第 1 次运行失败：不写入 handled
    const first = await runWarmup(sb.env, {
      now: () => new Date(wakeSec * 1000),
      runner,
    });
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]!.succeeded).toBe(false);
    expect(runCount).toBe(1);

    // 下一轮任务运行网络恢复：立即重试成功并记录 handled
    shouldFail = false;
    const second = await runWarmup(sb.env, {
      now: () => new Date((wakeSec + 300) * 1000),
      runner,
    });
    expect(second.actions).toHaveLength(1);
    expect(second.actions[0]!.succeeded).toBe(true);
    expect(runCount).toBe(2);
  });

  test("parseUsageBuckets treats a reset a full window ahead of the query as unopened", () => {
    const nowSec = 2_000_000_000;
    const iso = (sec: number) => new Date(sec * 1000).toISOString();
    const parsed = parseUsageBuckets(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                buckets: [
                  // 上游重置后无人使用：重置时间正好是查询时刻加整个窗口，且没有用量
                  {
                    id: "gemini-5h",
                    remaining_fraction: 1,
                    reset_time: iso(nowSec + 5 * 3600),
                  },
                  {
                    id: "gemini-weekly",
                    remaining_fraction: 1,
                    reset_time: iso(nowSec + 7 * 86400),
                  },
                  // 已开窗 40 分钟、用量四舍五入后仍为 0：重置时间不再顺延，照实保留
                  {
                    id: "3p-weekly",
                    remaining_fraction: 1,
                    reset_time: iso(nowSec + 7 * 86400 - 2400),
                  },
                  // 已有用量的窗口即使刚开窗也照实保留
                  {
                    id: "3p-5h",
                    remaining_fraction: 0.99,
                    reset_time: iso(nowSec + 5 * 3600),
                  },
                ],
              },
            ],
          },
        },
      }),
      nowSec,
    );
    expect(parsed).toBeInstanceOf(Map);
    const rows = parsed as Map<string, string>;
    expect(rows.get("gemini_5h")).toBe("gemini_5h\t0\t0");
    expect(rows.get("gemini_weekly")).toBe("gemini_weekly\t0\t0");
    expect(rows.get("3p_weekly")).toBe(
      `3p_weekly\t0\t${nowSec + 7 * 86400 - 2400}`,
    );
    expect(rows.get("3p_5h")).toBe(`3p_5h\t1\t${nowSec + 5 * 3600}`);
  });

  test("parseUsageBuckets and readAgyQuotaTsv preserve unopened 0/0 windows while rejecting invalid rows", () => {
    const sb = createSandbox();
    const futureIso = "2027-01-20T00:00:00.000Z";
    const futureSec = Math.floor(Date.parse(futureIso) / 1000);
    const parsed = parseUsageBuckets(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                buckets: [
                  // 缺失 / null / 空串 / 0 / epoch 0 且 remaining_fraction === 1，均保留为 0\t0
                  { id: "gemini-5h", remaining_fraction: 1 },
                  {
                    id: "gemini-weekly",
                    remaining_fraction: 1,
                    reset_time: null,
                  },
                  { id: "3p-5h", remaining_fraction: 1, reset_time: "" },
                  { id: "3p-weekly", remaining_fraction: 1, reset_time: 0 },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(parsed).toBeInstanceOf(Map);
    const rows = parsed as Map<string, string>;
    expect(rows.get("gemini_5h")).toBe("gemini_5h\t0\t0");
    expect(rows.get("gemini_weekly")).toBe("gemini_weekly\t0\t0");
    expect(rows.get("3p_5h")).toBe("3p_5h\t0\t0");
    expect(rows.get("3p_weekly")).toBe("3p_weekly\t0\t0");

    // remaining_fraction < 1 却没有 reset_time、或 reset_time 格式非法时，应丢弃该桶
    const mixed = parseUsageBuckets(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                buckets: [
                  { id: "gemini-5h", remaining_fraction: 0.5 },
                  {
                    id: "gemini-weekly",
                    remaining_fraction: 1,
                    reset_time: "not-a-date",
                  },
                  {
                    id: "3p-5h",
                    remaining_fraction: 1,
                    reset_time: "1970-01-01T00:00:00Z",
                  },
                  {
                    id: "3p-weekly",
                    remaining_fraction: 0.005,
                    reset_time: futureIso,
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(mixed).toBeInstanceOf(Map);
    const mixedRows = mixed as Map<string, string>;
    expect(mixedRows.has("gemini_5h")).toBe(false);
    expect(mixedRows.has("gemini_weekly")).toBe(false);
    expect(mixedRows.get("3p_5h")).toBe("3p_5h\t0\t0");
    expect(mixedRows.get("3p_weekly")).toBe(`3p_weekly\t100\t${futureSec}`);

    const tsvPath = join(sb.statuslineDir, "quota-phronara.tsv");
    writeFileSync(
      tsvPath,
      [
        "gemini_5h\t\t",
        "gemini_weekly\t50\t0",
        "3p_5h\t0\t0",
        `3p_weekly\t12\t${futureSec}`,
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );
    const tsv = readAgyQuotaTsv(tsvPath)!;
    expect(tsv.windows.has("gemini_5h")).toBe(false);
    expect(tsv.windows.has("gemini_weekly")).toBe(false);
    expect(tsv.windows.get("3p_5h")).toEqual({ percent: 0, resetEpoch: 0 });
    expect(tsv.windows.get("3p_weekly")).toEqual({
      percent: 12,
      resetEpoch: futureSec,
    });
  });

  test("warms up resetEpoch === 0 targets even with legacy handled state and writes refreshed resetEpoch", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;
    const nextWeekSec = nowSec + 604_800;

    // 模拟旧版 state.json：handled 已有历史时间戳，绝不能锁死 resetEpoch === 0
    writeFileSync(
      join(sb.stateDir, "state.json"),
      JSON.stringify({ handled: { "agy:phronara:3p": nowSec - 86_400 } }),
    );

    const phronaraQuota = join(sb.statuslineDir, "quota-phronara.tsv");
    writeFileSync(
      phronaraQuota,
      [
        `gemini_weekly\t10\t${nowSec + 86_400}`,
        "3p_weekly\t0\t0",
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );
    const freshMtime = new Date((nowSec - 60) * 1000);
    utimesSync(phronaraQuota, freshMtime, freshMtime);

    // tidewren 保持未到期，避免干扰本用例断言
    const tideQuota = join(sb.statuslineDir, "quota-tidewren.tsv");
    writeFileSync(
      tideQuota,
      [
        `gemini_weekly\t10\t${nowSec + 86_400}`,
        `3p_weekly\t10\t${nowSec + 86_400}`,
      ].join("\n") + "\n",
    );
    utimesSync(tideQuota, freshMtime, freshMtime);

    const runner: CommandRunner = async (argv) => {
      if (argv.includes("/usage")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "SUCCESS",
            command: {
              data: {
                groups: [
                  {
                    buckets: [
                      {
                        id: "3p-weekly",
                        remaining_fraction: 1,
                        reset_time: new Date(nextWeekSec * 1000).toISOString(),
                      },
                    ],
                  },
                ],
              },
            },
          }),
          logText: "",
        };
      }
      return { exitCode: 0, stdout: "ok\n", logText: "" };
    };

    const report = await runWarmup(sb.env, {
      now: () => new Date(nowSec * 1000),
      runner,
    });

    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]).toMatchObject({
      key: "agy:phronara:3p",
      windows: ["3p_weekly"],
      resetEpoch: 0,
      succeeded: true,
      refreshedQuota: true,
    });
    expect(readFileSync(phronaraQuota, "utf8")).toContain(
      `3p_weekly\t0\t${nextWeekSec}`,
    );
    const savedState = JSON.parse(
      readFileSync(join(sb.stateDir, "state.json"), "utf8"),
    ) as {
      handled: Record<string, number>;
      unopenedWarmupAt: Record<string, number>;
    };
    expect(savedState.handled["agy:phronara:3p"]).toBe(nowSec - 86_400);
    expect(savedState.unopenedWarmupAt["agy:phronara:3p"]).toBe(nowSec);
  });

  test("applies cooldown to resetEpoch === 0 targets that stay unopened and retries after cooldown expires", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;
    const phronaraQuota = join(sb.statuslineDir, "quota-phronara.tsv");
    const tideQuota = join(sb.statuslineDir, "quota-tidewren.tsv");
    const writeQuotas = (atSec: number) => {
      writeFileSync(
        phronaraQuota,
        [`gemini_weekly\t10\t${atSec + 86_400}`, "3p_weekly\t0\t0"].join("\n") +
          "\n",
      );
      writeFileSync(
        tideQuota,
        [
          `gemini_weekly\t10\t${atSec + 86_400}`,
          `3p_weekly\t10\t${atSec + 86_400}`,
        ].join("\n") + "\n",
      );
      const mtime = new Date((atSec - 30) * 1000);
      utimesSync(phronaraQuota, mtime, mtime);
      utimesSync(tideQuota, mtime, mtime);
    };
    writeQuotas(nowSec);

    let warmupRuns = 0;
    const runner: CommandRunner = async (argv) => {
      if (argv.includes("/usage")) {
        // 上游持续返回未开窗的 0\t0
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "SUCCESS",
            command: {
              data: {
                groups: [
                  {
                    buckets: [
                      {
                        id: "3p-weekly",
                        remaining_fraction: 1,
                        reset_time: null,
                      },
                    ],
                  },
                ],
              },
            },
          }),
          logText: "",
        };
      }
      warmupRuns += 1;
      return { exitCode: 0, stdout: "ok\n", logText: "" };
    };

    const first = await runWarmup(sb.env, {
      now: () => new Date(nowSec * 1000),
      runner,
    });
    expect(first.actions).toHaveLength(1);
    expect(warmupRuns).toBe(1);

    // 5 分钟后仍在冷却期内：跳过，不重复发送预热消息
    const withinCooldownSec = nowSec + 5 * 60;
    utimesSync(
      phronaraQuota,
      new Date((withinCooldownSec - 30) * 1000),
      new Date((withinCooldownSec - 30) * 1000),
    );
    utimesSync(
      tideQuota,
      new Date((withinCooldownSec - 30) * 1000),
      new Date((withinCooldownSec - 30) * 1000),
    );
    const second = await runWarmup(sb.env, {
      now: () => new Date(withinCooldownSec * 1000),
      runner,
    });
    expect(second.actions).toHaveLength(0);
    expect(second.skippedHandled).toContain("agy:phronara:3p");
    expect(warmupRuns).toBe(1);

    // 30 分钟冷却期满后：允许重试
    const afterCooldownSec = nowSec + UNOPENED_WARMUP_COOLDOWN_SEC;
    utimesSync(
      phronaraQuota,
      new Date((afterCooldownSec - 30) * 1000),
      new Date((afterCooldownSec - 30) * 1000),
    );
    utimesSync(
      tideQuota,
      new Date((afterCooldownSec - 30) * 1000),
      new Date((afterCooldownSec - 30) * 1000),
    );
    const third = await runWarmup(sb.env, {
      now: () => new Date(afterCooldownSec * 1000),
      runner,
    });
    expect(third.actions).toHaveLength(1);
    expect(third.actions[0]!.key).toBe("agy:phronara:3p");
    expect(warmupRuns).toBe(2);
  });

  test("refreshes stale Antigravity quota cache via read-only /usage to detect mid-cycle resets and throttles repeat probes with jitter", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;
    const minSec = DEFAULT_USAGE_REFRESH_MIN_MINUTES * 60;
    const maxSec = DEFAULT_USAGE_REFRESH_MAX_MINUTES * 60;
    const staleMtime = new Date((nowSec - maxSec - 60) * 1000);
    const freshMtime = new Date((nowSec - 60) * 1000);
    const newWeekSec = nowSec + 604_800;

    // phronara 缓存陈旧，本地仍显示未来重置时间，但上游已中途重置为 0\t0
    const phronaraQuota = join(sb.statuslineDir, "quota-phronara.tsv");
    writeFileSync(
      phronaraQuota,
      [
        `gemini_weekly\t40\t${nowSec + 259_200}`,
        `3p_weekly\t30\t${nowSec + 259_200}`,
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );
    utimesSync(phronaraQuota, staleMtime, staleMtime);

    // tidewren 缓存同样陈旧，但上游未发生重置（仍返回未来重置时间）
    const tideQuota = join(sb.statuslineDir, "quota-tidewren.tsv");
    writeFileSync(
      tideQuota,
      [
        `gemini_weekly\t20\t${nowSec + 259_200}`,
        `3p_weekly\t10\t${nowSec + 259_200}`,
      ].join("\n") + "\n",
    );
    utimesSync(tideQuota, staleMtime, staleMtime);

    const calls: string[][] = [];
    let phronaraWarmed = false;
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      const isTide = argv.includes("antigravity-cli-tide");
      if (argv.includes("/usage")) {
        if (isTide) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              status: "SUCCESS",
              command: {
                data: {
                  groups: [
                    {
                      buckets: [
                        {
                          id: "gemini-weekly",
                          remaining_fraction: 0.8,
                          reset_time: new Date(
                            (nowSec + 259_200) * 1000,
                          ).toISOString(),
                        },
                        {
                          id: "3p-weekly",
                          remaining_fraction: 0.9,
                          reset_time: new Date(
                            (nowSec + 259_200) * 1000,
                          ).toISOString(),
                        },
                      ],
                    },
                  ],
                },
              },
            }),
            logText: "",
          };
        }
        // 首次 /usage 返回被上游提前重置的 gemini-weekly（remaining=1，无 reset_time）；
        // 预热后第二次 /usage 返回新开启的 7 天周期。
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "SUCCESS",
            command: {
              data: {
                groups: [
                  {
                    buckets: [
                      phronaraWarmed
                        ? {
                            id: "gemini-weekly",
                            remaining_fraction: 1,
                            reset_time: new Date(
                              newWeekSec * 1000,
                            ).toISOString(),
                          }
                        : {
                            id: "gemini-weekly",
                            remaining_fraction: 1,
                            reset_time: null,
                          },
                      {
                        id: "3p-weekly",
                        remaining_fraction: 0.7,
                        reset_time: new Date(
                          (nowSec + 259_200) * 1000,
                        ).toISOString(),
                      },
                    ],
                  },
                ],
              },
            },
          }),
          logText: "",
        };
      }
      phronaraWarmed = true;
      return { exitCode: 0, stdout: "ok\n", logText: "" };
    };

    // dry-run 不发起任何 /usage 或预热命令
    const dryReport = await runWarmup(sb.env, {
      dryRun: true,
      now: () => new Date(nowSec * 1000),
      runner,
    });
    expect(calls).toHaveLength(0);
    expect(dryReport.refreshedAgyAccounts).toEqual([]);
    expect(dryReport.actions).toHaveLength(0);

    // 正式运行：注入确定性 random，phronara 巡检取 min(0)、tidewren 巡检取中点(0.5=65m)、
    // phronara 预热后刷新取 max(1=80m)。
    const rngValues = [0, 0.5, 1];
    const report = await runWarmup(sb.env, {
      now: () => new Date(nowSec * 1000),
      random: () => rngValues.shift() ?? 0,
      runner,
    });
    expect(report.refreshedAgyAccounts).toEqual(["phronara", "tidewren"]);
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]).toMatchObject({
      key: "agy:phronara:gemini",
      windows: ["gemini_weekly"],
      resetEpoch: 0,
      succeeded: true,
      refreshedQuota: true,
    });
    expect(readFileSync(phronaraQuota, "utf8")).toContain(
      `gemini_weekly\t0\t${newWeekSec}`,
    );
    expect(readFileSync(phronaraQuota, "utf8")).toContain(
      "plan\tGoogle AI Ultra\t-",
    );

    const savedState = JSON.parse(
      readFileSync(join(sb.stateDir, "state.json"), "utf8"),
    ) as { nextUsageRefreshAt: Record<string, number> };
    expect(savedState.nextUsageRefreshAt.phronara).toBe(nowSec + maxSec);
    expect(savedState.nextUsageRefreshAt.tidewren).toBe(
      nowSec + Math.round((minSec + maxSec) / 2),
    );

    // 55 分钟后（已超过 min=50m，但未到 tidewren 的 65m 抖动时间点）：不触发刷新
    const callsAfterFirst = calls.length;
    utimesSync(phronaraQuota, freshMtime, freshMtime);
    utimesSync(tideQuota, staleMtime, staleMtime);
    const beforeJitter = await runWarmup(sb.env, {
      now: () => new Date((nowSec + 55 * 60) * 1000),
      random: () => 0,
      runner,
    });
    expect(beforeJitter.refreshedAgyAccounts).toEqual([]);
    expect(calls).toHaveLength(callsAfterFirst);

    // 65 分钟到达 tidewren 的抖动时间点：仅刷新 tidewren
    const atJitter = await runWarmup(sb.env, {
      now: () => new Date((nowSec + 65 * 60) * 1000),
      random: () => 1,
      runner,
    });
    expect(atJitter.refreshedAgyAccounts).toEqual(["tidewren"]);
    expect(calls).toHaveLength(callsAfterFirst + 1);
  });

  test("warms up a window the read-only /usage reports as a full window from the query time", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;
    const staleMtime = new Date(
      (nowSec - DEFAULT_USAGE_REFRESH_MAX_MINUTES * 60 - 60) * 1000,
    );
    const newWeekSec = nowSec + 604_800;
    const phronaraQuota = join(sb.statuslineDir, "quota-phronara.tsv");
    writeFileSync(
      phronaraQuota,
      `gemini_weekly\t40\t${nowSec + 259_200}\n3p_weekly\t30\t${nowSec + 259_200}\n`,
    );
    utimesSync(phronaraQuota, staleMtime, staleMtime);
    const tideQuota = join(sb.statuslineDir, "quota-tidewren.tsv");
    writeFileSync(tideQuota, `gemini_weekly\t20\t${nowSec + 259_200}\n`);
    const freshMtime = new Date((nowSec - 60) * 1000);
    utimesSync(tideQuota, freshMtime, freshMtime);

    let warmed = false;
    const runner: CommandRunner = async (argv) => {
      if (!argv.includes("/usage")) {
        warmed = true;
        return { exitCode: 0, stdout: "ok\n", logText: "" };
      }
      // 上游提前重置后无人使用：巡检时重置时间是「查询时刻 + 7 天」；预热后是新周期的真实重置时间。
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: "SUCCESS",
          command: {
            data: {
              groups: [
                {
                  buckets: [
                    {
                      id: "gemini-weekly",
                      remaining_fraction: 1,
                      reset_time: new Date(newWeekSec * 1000).toISOString(),
                    },
                    {
                      id: "3p-weekly",
                      remaining_fraction: 0.7,
                      reset_time: new Date(
                        (nowSec + 259_200) * 1000,
                      ).toISOString(),
                    },
                  ],
                },
              ],
            },
          },
        }),
        logText: "",
      };
    };

    const report = await runWarmup(sb.env, {
      now: () => new Date(nowSec * 1000),
      random: () => 0,
      runner,
    });
    expect(warmed).toBe(true);
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]).toMatchObject({
      key: "agy:phronara:gemini",
      windows: ["gemini_weekly"],
      resetEpoch: 0,
      succeeded: true,
      refreshedQuota: true,
    });
    expect(readFileSync(phronaraQuota, "utf8")).toContain(
      `gemini_weekly\t0\t${newWeekSec}`,
    );

    // 预热开窗后重置时间固定下来，下一次巡检（60 分钟后）不再判为未开窗，也不再预热。
    warmed = false;
    const laterSec = nowSec + 60 * 60;
    const laterStale = new Date(
      (laterSec - DEFAULT_USAGE_REFRESH_MAX_MINUTES * 60 - 60) * 1000,
    );
    utimesSync(phronaraQuota, laterStale, laterStale);
    utimesSync(
      tideQuota,
      new Date((laterSec - 60) * 1000),
      new Date((laterSec - 60) * 1000),
    );
    const later = await runWarmup(sb.env, {
      now: () => new Date(laterSec * 1000),
      random: () => 0,
      runner,
    });
    expect(later.refreshedAgyAccounts).toEqual(["phronara"]);
    expect(later.actions).toHaveLength(0);
    expect(warmed).toBe(false);
  });

  test("backs off failed /usage refresh with custom jitter range and migrates legacy usageRefreshAt state", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;
    const staleMtime = new Date((nowSec - 7200) * 1000);

    // 自定义抖动区间 20-40 分钟
    writeFileSync(
      join(sb.stateDir, "config.json"),
      JSON.stringify({
        usageRefreshMinutes: { min: 20, max: 40 },
      }),
    );

    // 旧版 state.json 仅有 usageRefreshAt：phronara 10 分钟前刷新过（应平滑折算为 +20m=10m 后才允许刷新）
    writeFileSync(
      join(sb.stateDir, "state.json"),
      JSON.stringify({
        handled: {},
        usageRefreshAt: { phronara: nowSec - 600 },
      }),
    );

    const phronaraQuota = join(sb.statuslineDir, "quota-phronara.tsv");
    const tideQuota = join(sb.statuslineDir, "quota-tidewren.tsv");
    for (const file of [phronaraQuota, tideQuota]) {
      writeFileSync(
        file,
        [
          `gemini_weekly\t10\t${nowSec + 86_400}`,
          `3p_weekly\t10\t${nowSec + 86_400}`,
        ].join("\n") + "\n",
      );
      utimesSync(file, staleMtime, staleMtime);
    }

    const usageTargets: string[] = [];
    const runner: CommandRunner = async (argv) => {
      usageTargets.push(
        argv.includes("antigravity-cli-tide") ? "tidewren" : "phronara",
      );
      return { exitCode: 1, stdout: "", logText: "" };
    };

    // 第 1 轮：phronara 仍在旧版 usageRefreshAt + 20m 窗口内被跳过；tidewren 失败后按 max(40m) 退避
    await runWarmup(sb.env, {
      now: () => new Date(nowSec * 1000),
      random: () => 1,
      runner,
    });
    expect(usageTargets).toEqual(["tidewren"]);

    // 10 分钟后：phronara 到达折算的下次刷新点（-10m + 20m = nowSec + 600）；tidewren 仍在 40m 退避期内
    await runWarmup(sb.env, {
      now: () => new Date((nowSec + 600) * 1000),
      random: () => 0,
      runner,
    });
    expect(usageTargets).toEqual(["tidewren", "phronara"]);

    // 39 分钟后：tidewren 仍未到 40m；40 分钟后才重试
    await runWarmup(sb.env, {
      now: () => new Date((nowSec + 39 * 60) * 1000),
      random: () => 0,
      runner,
    });
    expect(usageTargets).toEqual(["tidewren", "phronara", "phronara"]);

    await runWarmup(sb.env, {
      now: () => new Date((nowSec + 40 * 60) * 1000),
      random: () => 0,
      runner,
    });
    expect(usageTargets).toEqual([
      "tidewren",
      "phronara",
      "phronara",
      "tidewren",
    ]);
  });

  test("applies per-account, per-pool, and per-window config switches with precedence over CLI flags", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;
    const staleMtime = new Date((nowSec - 7200) * 1000);
    const freshMtime = new Date((nowSec - 60) * 1000);

    // 增加第三个实例 @tern（账号标签 tern），用来测试 profile 兜底匹配与 defaults 继承
    const ternAppData = join(
      sb.root,
      "home",
      ".gemini",
      "antigravity-cli-tern",
    );
    mkdirSync(join(ternAppData, "conversations"), { recursive: true });
    writeFileSync(
      join(ternAppData, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "tern@gmail.com" }),
    );
    // 再增加第四个未在 config.accounts 中列出的实例 @extra，用来验证 defaults 继承
    const extraAppData = join(
      sb.root,
      "home",
      ".gemini",
      "antigravity-cli-extra",
    );
    mkdirSync(join(extraAppData, "conversations"), { recursive: true });
    writeFileSync(
      join(extraAppData, "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "extra@gmail.com" }),
    );

    const writeAllExpired = (file: string, mtime: Date) => {
      writeFileSync(
        file,
        [
          `gemini_5h\t80\t${nowSec - 60}`,
          `gemini_weekly\t80\t${nowSec - 60}`,
          `3p_5h\t80\t${nowSec - 60}`,
          `3p_weekly\t80\t${nowSec - 60}`,
        ].join("\n") + "\n",
      );
      utimesSync(file, mtime, mtime);
    };

    // phronara: gemini 开 5h+7d，3p 关 5h、开 7d（验证池级覆盖）
    writeAllExpired(join(sb.statuslineDir, "quota-phronara.tsv"), freshMtime);
    // tidewren (@tide): 通过 profile 兜底键 agy:tide 设为 enabled: false，缓存故意设为陈旧验证不触发 /usage
    writeAllExpired(join(sb.statuslineDir, "quota-tidewren.tsv"), staleMtime);
    // tern (@tern): 通过 agy:@tern 开启 5h、关闭 7d
    writeAllExpired(join(sb.statuslineDir, "quota-tern.tsv"), freshMtime);
    // extra (@extra): 未列出，继承 defaults（5h: false, 7d: true）
    writeAllExpired(join(sb.statuslineDir, "quota-extra.tsv"), freshMtime);

    // codex: 两个窗口均到期，配置文件明确关 5h、开 7d，即使命令行传入 --codex-5h / --include-5h 也以配置明确项为准
    writeCodexRollout(join(sb.codexSessions, "rollout-1.jsonl"), {
      timestamp: new Date((nowSec - 10) * 1000).toISOString(),
      fiveHourReset: nowSec - 30,
      sevenDayReset: nowSec - 30,
    });

    const customConfigPath = join(sb.root, "custom-warmup-config.json");
    writeFileSync(
      customConfigPath,
      JSON.stringify({
        defaults: { enabled: true, "5h": false, "7d": true },
        accounts: {
          codex: { enabled: true, "5h": false, "7d": true },
          "agy:phronara": {
            enabled: true,
            gemini: { "5h": true, "7d": true },
            "3p": { "5h": false, "7d": true },
          },
          "agy:tide": { enabled: false },
          "agy:@tern": { enabled: true, "5h": true, "7d": false },
        },
      }),
    );

    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "ok\n", logText: "" };
    };

    const report = await runWarmup(
      { ...sb.env, METERLEAF_WARMUP_CONFIG: customConfigPath },
      {
        includeCodex5h: true,
        now: () => new Date(nowSec * 1000),
        runner,
      },
    );

    // tidewren 被 enabled: false 禁用：既不做陈旧 /usage 巡检，也不进入 checkedAgyAccounts 与 actions
    expect(report.refreshedAgyAccounts).toEqual([]);
    expect(report.checkedAgyAccounts).toEqual(["phronara", "extra", "tern"]);
    expect(calls.some((argv) => argv.includes("antigravity-cli-tide"))).toBe(
      false,
    );

    const byKey = new Map(report.actions.map((a) => [a.key, a.windows]));
    expect(byKey.get("agy:phronara:gemini")).toEqual([
      "gemini_weekly",
      "gemini_5h",
    ]);
    expect(byKey.get("agy:phronara:3p")).toEqual(["3p_weekly"]);
    expect(byKey.get("agy:tern:gemini")).toEqual(["gemini_5h"]);
    expect(byKey.get("agy:tern:3p")).toEqual(["3p_5h"]);
    expect(byKey.get("agy:extra:gemini")).toEqual(["gemini_weekly"]);
    expect(byKey.get("agy:extra:3p")).toEqual(["3p_weekly"]);
    // codex 显式配置 5h: false，覆盖了传入的 includeCodex5h: true
    expect(byKey.get("codex:default")).toEqual(["seven-day"]);

    // 验证精确匹配 agy:<label> 优先于 agy:<profile>，以及 --include-5h 覆盖未列出账号的 defaults["5h"]
    writeFileSync(
      customConfigPath,
      JSON.stringify({
        defaults: { enabled: true, "5h": false, "7d": false },
        accounts: {
          codex: { enabled: false },
          "agy:tidewren": {
            enabled: true,
            gemini: { enabled: false },
            "3p": { "5h": true, "7d": false },
          },
          "agy:tide": { enabled: false },
        },
      }),
    );
    utimesSync(
      join(sb.statuslineDir, "quota-tidewren.tsv"),
      freshMtime,
      freshMtime,
    );
    // extra 进入新一轮 5h / 7d 到期，避免命中第 1 轮已记录的 handledEpoch
    writeFileSync(
      join(sb.statuslineDir, "quota-extra.tsv"),
      [
        `gemini_5h\t80\t${nowSec + 10}`,
        `gemini_weekly\t80\t${nowSec + 10}`,
        `3p_5h\t80\t${nowSec + 10}`,
        `3p_weekly\t80\t${nowSec + 10}`,
      ].join("\n") + "\n",
    );
    utimesSync(
      join(sb.statuslineDir, "quota-extra.tsv"),
      freshMtime,
      freshMtime,
    );

    const second = await runWarmup(
      { ...sb.env, METERLEAF_WARMUP_CONFIG: customConfigPath },
      {
        dryRun: true,
        include5h: true,
        now: () => new Date((nowSec + 60) * 1000),
        runner,
      },
    );
    expect(second.checkedCodex).toBe(false);
    const secondByKey = new Map(second.actions.map((a) => [a.key, a.windows]));
    // agy:tidewren 精确匹配胜过 agy:tide，且 gemini 池被单独关闭、3p 池开启 5h
    expect(secondByKey.has("agy:tidewren:gemini")).toBe(false);
    expect(secondByKey.get("agy:tidewren:3p")).toEqual(["3p_5h"]);
    // 未列出账号（extra）在 --include-5h 下覆盖 defaults["5h"]: false，启用 5h 但保持 7d: false
    expect(secondByKey.get("agy:extra:gemini")).toEqual(["gemini_5h"]);
    expect(secondByKey.get("agy:extra:3p")).toEqual(["3p_5h"]);

    // 损坏的 JSON 配置文件必须明确报错，避免静默忽略用户的停用规则
    const brokenPath = join(sb.root, "broken-config.json");
    writeFileSync(brokenPath, "{ invalid json");
    expect(() => loadWarmupConfig(brokenPath)).toThrow("不是有效 JSON");
  });

  test("rejects symlink/directory tokens and rechecks extra-profile token before post-warmup /usage", async () => {
    const sb = createSandbox();
    const nowSec = Math.floor(
      new Date("2026-11-23T01:00:00Z").getTime() / 1000,
    );
    const expiredSec = nowSec - 600;
    const futureSec = nowSec + 5 * 86400;

    const freshMtime = new Date((nowSec - 60) * 1000);
    // 默认实例未到期，仅用于保持默认目录存在。
    const phronaraQuota = join(sb.statuslineDir, "quota-phronara.tsv");
    writeFileSync(
      phronaraQuota,
      [
        `gemini_5h\t10\t${futureSec}`,
        `gemini_weekly\t10\t${futureSec}`,
        `3p_5h\t10\t${futureSec}`,
        `3p_weekly\t10\t${futureSec}`,
      ].join("\n") + "\n",
    );
    utimesSync(phronaraQuota, freshMtime, freshMtime);
    // tide 实例有真实普通文件令牌，且 gemini_weekly 已到期。
    const tideQuota = join(sb.statuslineDir, "quota-tidewren.tsv");
    writeFileSync(
      tideQuota,
      [
        `gemini_5h\t10\t${futureSec}`,
        `gemini_weekly\t100\t${expiredSec}`,
        `3p_5h\t10\t${futureSec}`,
        `3p_weekly\t10\t${futureSec}`,
      ].join("\n") + "\n",
    );
    utimesSync(tideQuota, freshMtime, freshMtime);

    // 新增两个非法令牌的额外目录：软链令牌与目录型令牌。
    const geminiDir = join(sb.defaultAppData, "..");
    const symlinkAppDir = join(geminiDir, "antigravity-cli-symlinked");
    const dirTokenAppDir = join(geminiDir, "antigravity-cli-dirtoken");
    const externalToken = join(sb.root, "external-token.json");
    writeFileSync(
      externalToken,
      JSON.stringify({ id_token_email: "symlinked@example.com" }),
    );
    mkdirSync(join(symlinkAppDir, "conversations"), { recursive: true });
    symlinkSync(externalToken, join(symlinkAppDir, "antigravity-oauth-token"));
    mkdirSync(join(dirTokenAppDir, "conversations"), { recursive: true });
    mkdirSync(join(dirTokenAppDir, "antigravity-oauth-token"), {
      recursive: true,
    });
    writeFileSync(
      join(sb.statuslineDir, "current-account-dirtoken"),
      "dirtoken\n",
    );
    writeFileSync(
      join(sb.statuslineDir, "quota-dirtoken.tsv"),
      `gemini_weekly\t100\t${expiredSec}\n`,
    );
    utimesSync(
      join(sb.statuslineDir, "quota-dirtoken.tsv"),
      freshMtime,
      freshMtime,
    );
    writeFileSync(
      join(sb.statuslineDir, "quota-symlinked.tsv"),
      `gemini_weekly\t100\t${expiredSec}\n`,
    );
    utimesSync(
      join(sb.statuslineDir, "quota-symlinked.tsv"),
      freshMtime,
      freshMtime,
    );

    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      // 模拟在 tide 预热 prompt 执行期间，令牌文件被移除。
      if (argv.includes("antigravity-cli-tide") && !argv.includes("/usage")) {
        rmSync(join(sb.tideAppData, "antigravity-oauth-token"), {
          force: true,
        });
        return { exitCode: 0, stdout: "ok\n", logText: "" };
      }
      return { exitCode: 0, stdout: "", logText: "" };
    };

    const report = await runWarmup(sb.env, {
      now: () => new Date(nowSec * 1000),
      runner,
    });

    // 非法令牌目录完全不被发现或调用。
    expect(
      calls.some(
        (argv) =>
          argv.includes("antigravity-cli-symlinked") ||
          argv.includes("antigravity-cli-dirtoken"),
      ),
    ).toBe(false);
    // tide 只调用了一次 prompt；由于 prompt 期间令牌被删，紧随其后的 /usage 被拦截未调用。
    const tideCalls = calls.filter((argv) =>
      argv.includes("antigravity-cli-tide"),
    );
    expect(tideCalls).toHaveLength(1);
    expect(tideCalls[0]!.includes("/usage")).toBe(false);
    const tideAction = report.actions.find(
      (a) => a.key === "agy:tidewren:gemini",
    );
    expect(tideAction?.succeeded).toBe(true);
    expect(tideAction?.refreshedQuota).toBe(false);
  });
});
