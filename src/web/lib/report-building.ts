import type { LedgerView, ReportBuilding } from "../../shared/ledger-view";
import { isSessionExpired } from "./session";

/**
 * 尚无本地账本结果时的首屏读取超时上限。移动蜂窝网切换出口地址后，浏览器若复用旧空闲连接
 * 会长时间既不返回也不报错，超时主动掐断后立即换新连接重试一次。
 */
export const INITIAL_LEDGER_READ_TIMEOUT_MS = 6000;

export function createLedgerReadSignal(
  callerSignal?: AbortSignal,
  timeoutMs?: number,
): { signal?: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  if (!timeoutMs) {
    return { signal: callerSignal, timedOut: () => false, cleanup: () => {} };
  }
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (callerSignal?.aborted) {
    clearTimeout(timer);
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
/** 报表正在后台首次计算或重建，暂时没有结果；不是读取失败，稍后会自动可用。 */
export class ReportBuildingError extends Error {
  readonly since: string;
  constructor(body: ReportBuilding) {
    super("报表正在后台计算");
    this.name = "ReportBuildingError";
    this.since = body.since;
  }
}

export function isReportBuilding(error: unknown): error is ReportBuildingError {
  return error instanceof ReportBuildingError;
}

/** 纯网络断连或切网失败并未到达服务端报表线程，允许界面壳在后台自动探测恢复。 */
export function isLedgerNetworkError(error: unknown) {
  return (
    error instanceof Error && error.message === "报表读取失败：网络连接异常"
  );
}

/** 计算中不算失败，不走指数退避重试，交给轮询继续等待。 */
export function reportRetry(failureCount: number, error: unknown) {
  return (
    !isReportBuilding(error) && !isSessionExpired(error) && failureCount < 1
  );
}

export function reportRetryDelay(attempt: number, error: unknown) {
  return isLedgerNetworkError(error)
    ? 100
    : Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * 报表查询的轮询节奏：计算中每 2 秒读一次，旧结果刷新中每秒读一次，其余不轮询。
 * 普通读取失败不自动轮询，避免失败请求持续占用报表线程。
 */
export function reportRefetchInterval(
  query: {
    state: {
      error: unknown;
      status: string;
      fetchFailureCount: number;
      data?: LedgerView;
    };
  },
  paused: boolean,
): number | false {
  if (paused) return false;
  if (isReportBuilding(query.state.error)) return 2000;
  if (!query.state.data && isLedgerNetworkError(query.state.error)) return 3000;
  if (query.state.status === "error" || query.state.fetchFailureCount)
    return false;
  return query.state.data?.reportStatus?.refreshing ? 1000 : false;
}
