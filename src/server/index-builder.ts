import { existsSync, rmSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { priceBookKey, type PriceBook } from "../domain/pricing";
import { LedgerStore } from "../storage/ledger";
import { LifetimeIndex } from "../storage/lifetime-index";
import { sourceFileState } from "../storage/source-file-state";
import { indexFiles } from "./index-files";
import { ReportProjection } from "./report-projection";

/**
 * 在独立线程把报表索引与累计索引完整重建到旁路文件。报表线程在此期间继续用旧索引
 * 回答查询；完成后由报表线程关闭旧连接并替换文件。
 */
const config = workerData as { path: string; book: PriceBook; target: string };

if (parentPort) {
  for (const file of indexFiles(config.target)) rmSync(file, { force: true });
  const store = new LedgerStore(config.path, config.book, { readonly: true });
  const projection = new ReportProjection(store, config.path, config.target);
  const lifetime = new LifetimeIndex(`${config.target}.lifetime`, store, {
    priceBookKey: priceBookKey(config.book),
  });
  try {
    store.db.transaction(() => {
      projection.ensure();
      lifetime.ensure({
        ...sourceFileState(config.path),
        dataVersion: store.reportFingerprint(),
      });
    })();
    // 切回回滚日志模式会合并并删除 WAL，让旁路文件自包含。macOS 系统 SQLite 关闭连接时
    // 保留 WAL 文件，只靠关闭不能保证替换时没有残留。
    projection.index.db.exec("PRAGMA journal_mode=DELETE");
    lifetime.db.exec("PRAGMA journal_mode=DELETE");
  } finally {
    projection.close();
    lifetime.close();
    store.close();
  }
  // 残留 WAL 说明文件不完整，不能替换进来。连接已全部关闭，剩下的 -shm 只是共享内存索引，可以删除。
  const files = indexFiles(config.target);
  if (files.some((file) => file.endsWith("-wal") && existsSync(file)))
    throw new Error("Index build left journal files");
  for (const file of files)
    if (file.endsWith("-shm")) rmSync(file, { force: true });
  parentPort.postMessage({ type: "built" });
}
