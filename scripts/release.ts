import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { version } from "../package.json";

/** 发布标签必须匹配唯一版本源；只接受正式版本，避免预发布覆盖 latest。 */
export function releaseNotes(tag: string, changelog: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`)
    throw new Error("发布标签必须与 package.json 的正式版本一致");
  const section = changelog
    .split(/^## /m)
    .find((part) => part.startsWith(`[${version}] - `));
  if (!section || !/^\[.*\] - \d{4}-\d{2}-\d{2}\n/.test(section))
    throw new Error("CHANGELOG.md 缺少带日期的对应版本");
  const notes = section.slice(section.indexOf("\n") + 1).trim();
  if (!notes) throw new Error("发布说明不能为空");
  return notes;
}

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
  const tag = `v${version}`;
  const notes = releaseNotes(tag, await Bun.file("CHANGELOG.md").text());
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
  await Bun.write("release-notes.md", notes + "\n");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\ntag=${tag}\nimage=ghcr.io/${repository.toLowerCase()}\npublish=${publish}\n`,
    );
  console.log(publish ? `准备发布 ${tag}` : `${tag} 已存在，跳过自动发布`);
}
