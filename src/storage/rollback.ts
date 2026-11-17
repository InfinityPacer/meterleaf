import type { Database } from "bun:sqlite";

/**
 * 在一个最终回滚的事务里运行 fn，fn 内的写入只对本次调用可见。嵌套事务的保存点日志
 * 默认写进临时文件，超出页缓存的脏页会提前写进 WAL；这些写入随后都会被丢弃，所以
 * 期间改放内存，占用随 fn 改动的页数增长，调用方负责限制改动量。
 */
export function rollbackAfter<T>(db: Database, fn: () => T): T {
  db.exec("PRAGMA temp_store=MEMORY; PRAGMA cache_spill=OFF; BEGIN");
  try {
    return fn();
  } finally {
    db.exec("ROLLBACK; PRAGMA cache_spill=ON; PRAGMA temp_store=DEFAULT");
  }
}
