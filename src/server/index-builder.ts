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
  } finally {
    projection.close();
    lifetime.close();
    store.close();
  }
  // 关闭最后一个连接会合并并删除 WAL；残留说明文件不完整，不能替换进来。
  const leftover = indexFiles(config.target).filter(
    (file) => /-(wal|shm)$/.test(file) && existsSync(file),
  );
  if (leftover.length > 0) throw new Error("Index build left journal files");
  parentPort.postMessage({ type: "built" });
}
