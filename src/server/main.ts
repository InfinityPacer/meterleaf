import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createSub2ApiConnector } from "../connectors/sub2api";
import { LedgerStore } from "../storage/ledger";
import type { DateRange } from "../shared/date-range";
import { createDemoLedger } from "../web/demo/ledger";
import { createApp } from "./app";
import { readConfig } from "./config";
import { loadPriceBook } from "./price-book";
import { liveSnapshot } from "./snapshot";
import { SyncRunner } from "./sync";
import { createDiagnosticsLogger } from "./diagnostics";
import { ViewService } from "./view-service";

const logger = createDiagnosticsLogger();
let stage = "configuration";

/** 单进程拥有账本与采集任务；退出时先停止采集，再关闭数据库。 */
async function main() {
  const config = readConfig(process.env);
  const demo = config.METERLEAF_DEMO === "true";
  stage = "price-book";
  const book = await loadPriceBook(config.METERLEAF_PRICE_BOOK);
  let store: LedgerStore | null = null;
  let sync: SyncRunner | null = null;
  if (!demo) {
    stage = "storage";
    await mkdir(config.METERLEAF_DATA_DIR, { recursive: true });
    store = new LedgerStore(
      resolve(config.METERLEAF_DATA_DIR, "meterleaf.sqlite"),
      book,
    );
    stage = "connector";
    const connector = createSub2ApiConnector({
      sourceId: config.METERLEAF_SOURCE_ID,
      connectionString: config.SUB2API_DATABASE_URL!,
      onBackgroundError: (error) =>
        logger.warn("source.connection_failed", {
          sourceId: config.METERLEAF_SOURCE_ID,
          error,
        }),
    });
    sync = new SyncRunner(
      connector,
      store,
      {
        intervalMs: config.METERLEAF_SYNC_VISIBLE_INTERVAL_MS,
        hiddenIntervalMs: config.METERLEAF_SYNC_HIDDEN_INTERVAL_MS,
        quotaIntervalMs: Math.min(
          config.METERLEAF_SYNC_VISIBLE_INTERVAL_MS,
          config.METERLEAF_SYNC_HIDDEN_INTERVAL_MS,
        ),
      },
      logger,
    );
  }
  stage = "http-server";
  const reports = store
    ? new ViewService(
        resolve(config.METERLEAF_DATA_DIR, "meterleaf.sqlite"),
        book,
        {
          refreshIntervalMs: config.METERLEAF_REPORT_REFRESH_INTERVAL_MS,
          diagnostics: logger,
          getSyncStatus: () => sync!.status(),
        },
      )
    : null;
  const app = createApp({
    accountArchive: store ? {
      read: () => store.archivedAccounts(),
      write: (id, archived) => store.setAccountArchived(id, archived),
      hidden: () => store.hiddenAccounts(),
      hide: (id) => store.hideAccount(id),
      aliases: () => store.accountAliases(),
      setAlias: (id, alias) => store.setAccountAlias(id, alias),
    } : undefined,
    view: reports
      ? (query, basis = config.METERLEAF_USD_BASIS, refresh = true) =>
          reports.read(query, basis, undefined, refresh)
      : undefined,
    sync: sync ?? undefined,
    ingest: store
      ? {
          keys: config.ingestKeys,
          save: (sourceId, batch) =>
            store.saveIngestBatch(sourceId, batch, new Date().toISOString()),
        }
      : undefined,
    diagnostics: logger,
    webRoot: resolve("dist/web"),
    snapshot: (
      days,
      basis = config.METERLEAF_USD_BASIS,
      dateRange?: DateRange,
    ) =>
      demo
        ? createDemoLedger(basis)
        : liveSnapshot(
            store!,
            sync!,
            days,
            new Date().toISOString(),
            basis,
            dateRange,
          ),
  });
  app.addHook("onClose", async () => {
    await reports?.close();
    await sync?.stop();
    store?.close();
    logger.info("server.stopped");
  });
  try {
    await app.listen({
      host: config.METERLEAF_HOST,
      port: config.METERLEAF_PORT,
    });
    logger.info("server.started", {
      mode: demo ? "demo" : "live",
      port: config.METERLEAF_PORT,
      priceVersion: `${book.id}@${book.version}`,
      usdBasis: config.METERLEAF_USD_BASIS,
    });
    sync?.start();
  } catch (error) {
    await app.close();
    throw error;
  }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server.stopping");
    await app.close();
  };
  const onSignal = () =>
    void shutdown().catch((error) => {
      logger.error("server.shutdown_failed", { error });
      process.exitCode = 1;
    });
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

void main().catch((error) => {
  logger.error("server.startup_failed", { stage, error });
  process.exitCode = 1;
});
