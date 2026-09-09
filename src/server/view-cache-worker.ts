import { parentPort, workerData } from "node:worker_threads";
import { ViewCache, type CachedReport } from "../storage/view-cache";
import { summarizeError, type SafeErrorSummary } from "./diagnostics";

interface CacheWorkerConfig {
  cachePath: string;
  namespace: string;
}

/** 主线程按序发送 save，收到 saved 后才会发送下一项；close 用于排空并释放 SQLite。 */
interface SaveRequest {
  type: "save";
  id: number;
  entry: CachedReport;
}

interface CloseRequest {
  type: "close";
}

/** 缓存写 worker 的跨线程请求契约。 */
type CacheWorkerRequest = SaveRequest | CloseRequest;

const port = parentPort;
if (!port) throw new Error("Report cache worker requires a parent port");

const config = workerData as CacheWorkerConfig;
let cache: ViewCache | null = null;
let startupError: SafeErrorSummary | null = null;

try {
  cache = new ViewCache(config.cachePath, config.namespace);
} catch (error) {
  startupError = summarizeError(error);
  port.postMessage({ type: "failed", phase: "open", error: startupError });
}

/** 持久缓存只在此 worker 中拥有 SQLite 写连接，主线程仅传递最新结果。 */
port.on("message", (request: CacheWorkerRequest) => {
  if (request.type === "close") {
    try {
      cache?.close();
    } catch {
      /* 关闭失败不遮蔽已完成的写入。 */
    }
    port.postMessage({ type: "closed" });
    port.close();
    return;
  }

  if (!cache) {
    port.postMessage({
      type: "failed",
      id: request.id,
      phase: "open",
      error: startupError ?? { name: "Error", kind: "unknown" },
    });
    return;
  }

  const started = performance.now();
  try {
    cache.save(request.entry);
    port.postMessage({
      type: "saved",
      id: request.id,
      durationMs: performance.now() - started,
    });
  } catch (error) {
    port.postMessage({
      type: "failed",
      id: request.id,
      phase: "save",
      error: summarizeError(error),
      durationMs: performance.now() - started,
    });
  }
});
