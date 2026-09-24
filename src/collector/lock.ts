import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 排他运行锁：以独占创建方式写入 PID。锁文件属于采集器数据目录；
 * 持有者进程已不存在时视为残留锁并接管。返回释放函数，拿不到锁返回 null。
 */
export function acquireLock(path: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) {
            unlinkSync(path);
          }
        } catch {
          // 锁文件已被清理时无需处理。
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(readFileSync(path, "utf8"), 10);
    } catch {
      continue;
    }
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) return null;
    try {
      unlinkSync(path);
    } catch {
      // 另一个进程可能刚好接管，下一次尝试会重新判断。
    }
  }
  return null;
}
