import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { version } from "../package.json";

/** 自动运行只发布新版本；手动运行明确允许覆盖已有版本。 */
export function shouldPublish(
  currentCommit: string,
  taggedCommit: string | null,
  manual = false,
): boolean {
  if (!/^[a-f0-9]{40,64}$/.test(currentCommit))
    throw new Error("缺少有效发布提交");
  return manual || taggedCommit === null;
}

if (import.meta.main) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("发布版本必须是正式版本");
  const tag = `v${version}`;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("缺少有效仓库标识");
  const tagged = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`],
    { encoding: "utf8" },
  );
  if (tagged.status !== 0 && tagged.status !== 1)
    throw new Error("无法读取已有版本标签");
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const publish = shouldPublish(
    process.env.GITHUB_SHA ?? "",
    tagged.status === 0 ? tagged.stdout.trim() : null,
    manual,
  );
  // 发布不写说明；工作流的发布步骤仍读取这个文件，留空即可。
  await Bun.write("release-notes.md", "");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\ntag=${tag}\nimage=ghcr.io/${repository.toLowerCase()}\npublish=${publish}\n`,
    );
  console.log(publish ? `准备发布 ${tag}` : `${tag} 已存在，跳过自动发布`);
}
