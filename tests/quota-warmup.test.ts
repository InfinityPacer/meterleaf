import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_POOL_MODELS,
  CODEX_WARMUP_MODEL,
  WARMUP_PROMPTS,
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
    writeFileSync(
      join(sb.statuslineDir, "quota-phronara.tsv"),
      [
        `gemini_5h\t40\t${nowSec - 300}`,
        `gemini_weekly\t15\t${nowSec + 86400}`,
        `3p_5h\t0\t${nowSec + 3600}`,
        `3p_weekly\t100\t${nowSec - 600}`,
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );

    // tidewren (@tide): gemini_weekly 已到期 (nowSec - 120)，3p_weekly 未到期
    writeFileSync(
      join(sb.statuslineDir, "quota-tidewren.tsv"),
      [
        `gemini_5h\t80\t${nowSec - 120}`,
        `gemini_weekly\t100\t${nowSec - 120}`,
        `3p_5h\t10\t${nowSec + 7200}`,
        `3p_weekly\t50\t${nowSec + 172800}`,
        "plan\tGoogle AI Ultra\t-",
      ].join("\n") + "\n",
    );

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
    expect(calls[4]!.argv).toContain('model_provider="openai"');
    expect(calls[4]!.argv).toContain(`model="${CODEX_WARMUP_MODEL}"`);
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

  test("supports optional 5h warmup when --include-5h / METERLEAF_WARMUP_5H=1 is enabled, and falls back to secondary 3p model on failure", async () => {
    const sb = createSandbox();
    const nowSec = 1_800_000_000;

    // phronara: 仅 3p_5h 到期，3p_weekly 未到期
    writeFileSync(
      join(sb.statuslineDir, "quota-phronara.tsv"),
      [
        `gemini_5h\t10\t${nowSec + 3600}`,
        `gemini_weekly\t15\t${nowSec + 86400}`,
        `3p_5h\t100\t${nowSec - 10}`,
        `3p_weekly\t40\t${nowSec + 86400}`,
      ].join("\n") + "\n",
    );

    const attemptedModels: string[] = [];
    const runner: CommandRunner = async (argv) => {
      const modelIdx = argv.indexOf("--model");
      if (modelIdx !== -1) {
        const model = argv[modelIdx + 1]!;
        attemptedModels.push(model);
        // 模拟主模型 gpt-oss-120b-medium 报错退出，测试自动回退到 claude-sonnet-5-5-low
        if (model === "gpt-oss-120b-medium") {
          return { exitCode: 1, stdout: "", logText: "" };
        }
      }
      return { exitCode: 0, stdout: "{}", logText: "" };
    };

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

  test("backs off for 15 minutes when warmup command fails, and catches up after sleep wake", async () => {
    const sb = createSandbox();
    const resetSec = 1_800_000_000;
    // 模拟本机睡眠了 6 小时后唤醒（nowSec = resetSec + 21600）
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

    // 唤醒后第 1 次运行：触发但失败
    const first = await runWarmup(sb.env, {
      now: () => new Date(wakeSec * 1000),
      runner,
    });
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]!.succeeded).toBe(false);
    expect(runCount).toBe(1);

    // 5 分钟后再跑：仍在 15 分钟冷却期内，直接跳过
    const second = await runWarmup(sb.env, {
      now: () => new Date((wakeSec + 300) * 1000),
      runner,
    });
    expect(second.actions).toHaveLength(0);
    expect(second.skippedCooldown).toEqual(["agy:phronara:gemini"]);
    expect(runCount).toBe(1);

    // 16 分钟后网络恢复再跑：成功补做 warmup
    shouldFail = false;
    const third = await runWarmup(sb.env, {
      now: () => new Date((wakeSec + 960) * 1000),
      runner,
    });
    expect(third.actions).toHaveLength(1);
    expect(third.actions[0]!.succeeded).toBe(true);
    expect(runCount).toBe(2);
  });
});
