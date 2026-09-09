import { expect, test } from "bun:test";
import { version } from "../package.json";
import { releaseNotes, shouldPublish } from "../scripts/release";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("release requires matching version and dated nonempty notes", () => {
  expect(
    releaseNotes(
      `v${version}`,
      `# 更新日志\n## [${version}] - 2026-09-09\n\n- 发布说明\n## [0.0.1] - 2026-01-01\n旧版`,
    ),
  ).toBe("- 发布说明");
  expect(() => releaseNotes("v99.0.0", "")).toThrow();
  expect(() => releaseNotes(`v${version}`, "## [未发布]\n草稿")).toThrow();
  expect(() =>
    releaseNotes(`v${version}`, `## [${version}] - 2026-09-09\n`),
  ).toThrow();
});

test("automatic publishing skips existing versions and manual runs allow replacement", () => {
  const current = "a".repeat(40);
  expect(shouldPublish(current, null)).toBe(true);
  expect(shouldPublish(current, current)).toBe(false);
  expect(shouldPublish(current, "b".repeat(40))).toBe(false);
  expect(shouldPublish(current, current, true)).toBe(true);
  expect(shouldPublish(current, "b".repeat(40), true)).toBe(true);
  expect(shouldPublish(current, null, true)).toBe(true);
  expect(() => shouldPublish("", null)).toThrow();
});

test("release workflow creates and manually replaces tags using a local-only remote", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meterleaf-release-"));
  const work = join(directory, "work");
  const remote = join(directory, "remote.git");
  const output = join(directory, "outputs");
  await mkdir(join(work, "scripts"), { recursive: true });
  const command = (
    bin: string,
    args: string[],
    env: Record<string, string> = {},
  ) => {
    const result = spawnSync(bin, args, {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    if (result.status !== 0) throw new Error(`${bin} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    await copyFile(
      resolve("scripts/release.ts"),
      join(work, "scripts/release.ts"),
    );
    await writeFile(join(work, "package.json"), JSON.stringify({ version }));
    await writeFile(
      join(work, "CHANGELOG.md"),
      `## [${version}] - 2026-09-09\n\n- Fixture release\n`,
    );
    command("git", ["init", "--bare", remote]);
    command("git", ["init"]);
    command("git", ["config", "user.name", "Release Fixture"]);
    command("git", ["config", "user.email", "release@example.invalid"]);
    command("git", ["add", "package.json"]);
    command("git", ["commit", "-m", "test(release): initial fixture"]);
    command("git", ["remote", "add", "origin", remote]);
    const first = command("git", ["rev-parse", "HEAD"]);
    const workflow = Bun.YAML.parse(
      await readFile(resolve(".github/workflows/release.yml"), "utf8"),
    ) as any;
    expect(workflow.on.push.branches).toContain("main");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    const tagStep = workflow.jobs.release.steps.find(
      (step: any) => step.name === "Tag tested commit",
    );
    expect(tagStep.if).toBe("steps.release.outputs.publish == 'true'");
    const env = {
      GITHUB_REPOSITORY: "fixture/meterleaf",
      GITHUB_OUTPUT: output,
      TAG: `v${version}`,
    };
    const plan = async (sha: string, event: string) => {
      await writeFile(output, "");
      command(process.execPath, ["scripts/release.ts"], {
        ...env,
        GITHUB_SHA: sha,
        GITHUB_EVENT_NAME: event,
      });
      return readFile(output, "utf8");
    };
    expect(await plan(first, "push")).toContain("publish=true");
    command("bash", ["-e", "-c", tagStep.run], {
      ...env,
      GITHUB_SHA: first,
      GITHUB_EVENT_NAME: "push",
    });
    expect(
      command("git", [
        "--git-dir",
        remote,
        "rev-parse",
        `refs/tags/v${version}`,
      ]),
    ).toBe(first);
    expect(await plan(first, "push")).toContain("publish=false");
    command("git", [
      "commit",
      "--allow-empty",
      "-m",
      "test(release): replacement fixture",
    ]);
    const second = command("git", ["rev-parse", "HEAD"]);
    expect(await plan(second, "push")).toContain("publish=false");
    expect(await plan(second, "workflow_dispatch")).toContain("publish=true");
    command("bash", ["-e", "-c", tagStep.run], {
      ...env,
      GITHUB_SHA: second,
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });
    expect(
      command("git", [
        "--git-dir",
        remote,
        "rev-parse",
        `refs/tags/v${version}`,
      ]),
    ).toBe(second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
