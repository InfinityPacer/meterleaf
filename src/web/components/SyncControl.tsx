import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { RefreshCw, Bell } from "lucide-react";
import { Button } from "./ui/button";
import type { SyncStatus } from "../../server/sync";
import { useLiveUpdates } from "../lib/use-live-updates";
import "./controls.css";

const stageLabels: Record<string, string> = {
  accounts: "账户",
  quotas: "额度",
  incremental: "用量补采",
  sweep: "历史回扫",
};
const errorLabels: Record<string, string> = {
  network: "连接中断",
  timeout: "连接超时",
  sql: "源数据库读取失败",
  storage: "本地账本写入失败",
  configuration: "连接配置错误",
  unknown: "同步处理失败",
};

type SyncStatusResponse = SyncStatus & { unavailable?: boolean };

type SyncStatusReadErrorKind =
  "gateway-timeout" | "gateway-unavailable" | "http" | "network";

type SyncStatusReadError = Error & {
  syncStatusReadError?: SyncStatusReadErrorKind;
  status?: number;
};

function isSyncStatusReadError(error: unknown): error is SyncStatusReadError {
  if (!error || typeof error !== "object") return false;
  const kind = (error as { syncStatusReadError?: unknown }).syncStatusReadError;
  return (
    kind === "gateway-timeout" ||
    kind === "gateway-unavailable" ||
    kind === "http" ||
    kind === "network"
  );
}

/** 状态接口故障不能被解释为上游同步任务失败。 */
export function formatSyncStatusReadError(error: unknown) {
  if (isSyncStatusReadError(error)) {
    const suffix =
      typeof error.status === "number" ? `（HTTP ${error.status}）` : "";
    if (error.syncStatusReadError === "gateway-timeout")
      return `读取同步状态失败：网关超时${suffix}`;
    if (error.syncStatusReadError === "gateway-unavailable")
      return `读取同步状态失败：网关不可用${suffix}`;
    if (error.syncStatusReadError === "network")
      return "读取同步状态失败：网络连接异常";
    return `读取同步状态失败：HTTP ${error.status ?? "未知"}`;
  }
  return "读取同步状态失败，请稍后重试";
}

function createSyncStatusReadError(
  kind: SyncStatusReadErrorKind,
  status?: number,
) {
  const error = Object.assign(new Error(), {
    syncStatusReadError: kind,
    ...(status === undefined ? {} : { status }),
  });
  error.message = formatSyncStatusReadError(error);
  return error;
}

function postPresence(pageId: string, visible: boolean, signal?: AbortSignal) {
  return fetch("/api/sync/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: pageId, visible }),
    signal,
  });
}

/** 查询失败时旧快照不再是当前运行状态的可靠依据。 */
export function isSyncActuallyRunning(
  status: Pick<SyncStatus, "running"> | undefined,
  queryFailed: boolean,
) {
  return Boolean(status && !queryFailed && status.running);
}

/** 同步时间沿用账本时区，不受浏览器系统时区影响。 */
export function formatSyncUpdatedAt(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `更新于 ${fields.month}/${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
}

function statusLabel(
  status: SyncStatusResponse | undefined,
  queryFailed: boolean,
  requestPending: boolean,
) {
  if (queryFailed) return "同步状态读取失败";
  if (!status) return requestPending ? "正在提交同步请求" : "读取同步状态";
  if (requestPending) return "正在提交同步请求";
  if (status.running)
    return status.phase === "sweep"
      ? "历史回扫中"
      : `同步中 · ${stageLabels[status.phase] ?? "处理中"}`;
  if (status.error || status.quotaError || status.lastError) return "同步失败";
  if (!status.lastAttempt) return "尚未同步";
  if (status.initialComplete)
    return status.autoEnabled ? "同步完成 · 自动同步已开启" : "同步完成";
  return "补采未完成";
}

function statusTone(
  status: SyncStatusResponse | undefined,
  queryFailed: boolean,
  requestPending: boolean,
) {
  if (queryFailed || status?.error || status?.quotaError || status?.lastError)
    return "error";
  if (requestPending || status?.running) return "running";
  if (status?.lastSuccess) return "success";
  return "idle";
}

/** 只负责同步控制面的可见状态，不改变后端同步任务的生命周期。 */
export function SyncControl({ compact = false }: { compact?: boolean }) {
  const client = useQueryClient();
  const { paused, setPaused } = useLiveUpdates();
  const lastSuccess = useRef<string | null | undefined>(undefined);
  const wasPaused = useRef(false);
  const [pageId] = useState(() =>
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
      value.toString(16),
    ).join("-"),
  );
  const [visible, setVisible] = useState(
    () =>
      typeof document !== "undefined" && document.visibilityState === "visible",
  );
  const query = useQuery({
    queryKey: ["sync-status"],
    queryFn: async ({ signal }) => {
      try {
        const response = await postPresence(
          pageId,
          document.visibilityState === "visible",
          signal,
        );
        if (!response.ok) {
          const kind =
            response.status === 408 || response.status === 504
              ? "gateway-timeout"
              : response.status === 502 || response.status === 503
                ? "gateway-unavailable"
                : "http";
          throw createSyncStatusReadError(kind, response.status);
        }
        return response.json() as Promise<SyncStatusResponse>;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (isSyncStatusReadError(error)) throw error;
        throw createSyncStatusReadError("network");
      }
    },
    enabled: visible && !paused,
    // 恢复可见时不能因全局 staleTime 跳过心跳，后台同步可能已经完成。
    staleTime: 0,
    refetchInterval: (current) => {
      if (paused) return false;
      if (current.state.status === "error" || current.state.fetchFailureCount)
        return 15_000;
      return current.state.data?.running ? 3000 : 15_000;
    },
    retry: 1,
  });
  useEffect(() => {
    const leave = () => {
      navigator.sendBeacon(
        "/api/sync/presence",
        new Blob([JSON.stringify({ id: pageId, visible: false })], {
          type: "application/json",
        }),
      );
    };
    const visibilityChanged = () => {
      const current = document.visibilityState === "visible";
      setVisible(current);
      if (!current) leave();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [pageId]);
  useEffect(() => {
    if (!paused || !visible) return;
    const controller = new AbortController();
    const keepPresence = () => {
      if (document.visibilityState !== "visible") return;
      void postPresence(pageId, true, controller.signal).catch(() => {});
    };
    keepPresence();
    const timer = window.setInterval(keepPresence, 15_000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [pageId, paused, visible]);
  useEffect(() => {
    const resumed = wasPaused.current && !paused;
    wasPaused.current = paused;
    if (resumed && visible) void query.refetch();
  }, [paused, visible, query.refetch]);
  const trigger = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/sync", { method: "POST" });
      if (!response.ok)
        throw new Error(
          `同步请求失败 (${response.status}) · 请求编号 ${response.headers.get("X-Request-Id") ?? "未提供"}`,
        );
    },
    onSuccess: () => {
      void query.refetch();
    },
  });
  const status = query.data;
  const completedAt = query.isError ? lastSuccess.current : status?.lastSuccess;
  useEffect(() => {
    if (completedAt === undefined) return;
    // 完成标识变化也覆盖两次查询间已结束的短任务，不能只观察 running 跳变。
    const changed =
      lastSuccess.current !== undefined && completedAt !== lastSuccess.current;
    lastSuccess.current = completedAt;
    if (changed) void client.invalidateQueries({ queryKey: ["ledger"] });
  }, [completedAt, client]);
  const automatic = useMutation({
    mutationFn: async (enabled: boolean) => {
      const response = await fetch("/api/sync/automatic", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok)
        throw new Error(
          `自动同步设置失败 (${response.status}) · 请求编号 ${response.headers.get("X-Request-Id") ?? "未提供"}`,
        );
    },
    onSuccess: () => {
      void query.refetch();
    },
  });

  if (status?.unavailable) return null;

  const queryFailed = query.isError;
  const statusKnown = Boolean(status && !queryFailed);
  const running = isSyncActuallyRunning(status, queryFailed);
  const requestPending = trigger.isPending;
  const syncFailed = Boolean(
    statusKnown && (status?.error || status?.quotaError || status?.lastError),
  );
  const hasError = Boolean(
    queryFailed || syncFailed || trigger.isError || automatic.isError,
  );
  const label = statusLabel(status, queryFailed, requestPending);
  const tone = statusTone(status, queryFailed, requestPending);
  const updatedLabel = formatSyncUpdatedAt(completedAt);

  return (
    <Popover.Root>
      <Popover.Trigger
        className="sync-trigger"
        aria-label="数据同步"
        title={updatedLabel ? `数据同步 · ${updatedLabel}` : "数据同步"}
        aria-busy={running || requestPending || undefined}
      >
        {compact ? (
          <Bell size={20} aria-hidden="true" />
        ) : (
          <RefreshCw size={16} aria-hidden="true" />
        )}
        <span className="sync-trigger-label">{updatedLabel ?? "数据同步"}</span>
        {hasError && <span className="sync-trigger-badge">需处理</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="sync-positioner"
          sideOffset={8}
          align="end"
        >
          <Popover.Popup className="sync-popup">
            <div className="sync-popup-heading">
              <Popover.Title className="sync-popup-title">
                数据同步
              </Popover.Title>
              <span className={`sync-status sync-status-${tone}`}>{label}</span>
            </div>
            <div className="sync-control-body">
              <div className="sync-summary" role="status" aria-live="polite">
                <strong>{label}</strong>
                {status && (
                  <span>
                    {status.localRecords.toLocaleString()} 条请求
                    {updatedLabel ? ` · ${updatedLabel}` : ""}
                  </span>
                )}
              </div>
              {statusKnown && status?.lastError && (
                <p className="sync-error" role="status" aria-live="polite">
                  阶段：
                  {stageLabels[status.lastError.stage] ??
                    status.lastError.stage}{" "}
                  · {errorLabels[status.lastError.kind] ?? "同步处理失败"}
                  {status.lastError.code ? ` (${status.lastError.code})` : ""} ·
                  错误编号 {status.lastError.id}
                </p>
              )}
              {queryFailed && (
                <p className="sync-error" role="status" aria-live="polite">
                  {formatSyncStatusReadError(query.error)}
                </p>
              )}
              {(trigger.isError || automatic.isError) && (
                <p className="sync-error" role="alert">
                  {trigger.error?.message ??
                    automatic.error?.message ??
                    "操作失败，请稍后重试"}
                </p>
              )}
              <label className="sync-auto-control">
                <input
                  type="checkbox"
                  checked={status?.autoEnabled ?? false}
                  disabled={!statusKnown || automatic.isPending}
                  onChange={(event) => automatic.mutate(event.target.checked)}
                />
                <span>自动同步</span>
              </label>
              <label className="sync-auto-control">
                <input
                  type="checkbox"
                  checked={paused}
                  onChange={(event) => setPaused(event.target.checked)}
                />
                <span>暂停页面自动更新</span>
              </label>
              <Button
                variant="outline"
                className="sync-action"
                disabled={!statusKnown || requestPending || running}
                onClick={() => {
                  // 后端对运行中请求复用同一任务；客户端同时保留单次提交闸门，避免重复网络请求。
                  if (statusKnown && !running && !requestPending)
                    trigger.mutate();
                }}
                title="立即同步上游用量"
              >
                <RefreshCw size={15} aria-hidden="true" />
                {requestPending
                  ? "正在提交"
                  : running
                    ? "同步中"
                    : syncFailed
                      ? "重试同步"
                      : "立即同步"}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
