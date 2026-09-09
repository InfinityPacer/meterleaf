import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 文件替换使派生索引失效；无变更日志的旧副本另外用文件与 WAL 时间戳判断内容变化。 */
export function sourceFileState(path: string): {
  identity: string;
  stamp: string;
} {
  const filename = path.startsWith("file:")
    ? fileURLToPath(new URL(path))
    : resolve(path);
  const file = statSync(filename);
  let wal: { size: number; mtimeMs: number } | null = null;
  try {
    wal = statSync(`${filename}-wal`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    identity: hash([filename, file.dev, file.ino, file.birthtimeMs]),
    stamp: hash([file.size, file.mtimeMs, wal?.size, wal?.mtimeMs]),
  };
}
