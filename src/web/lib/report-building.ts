import type { LedgerView, ReportBuilding } from "../../shared/ledger-view";
import { isSessionExpired } from "./session";

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

/** 计算中不算失败，不走指数退避重试，交给轮询继续等待。 */
export function reportRetry(failureCount: number, error: unknown) {
  return (
    !isReportBuilding(error) && !isSessionExpired(error) && failureCount < 1
  );
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
  if (query.state.status === "error" || query.state.fetchFailureCount)
    return false;
  return query.state.data?.reportStatus?.refreshing ? 1000 : false;
}
