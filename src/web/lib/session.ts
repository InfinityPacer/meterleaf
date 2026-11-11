/**
 * 部署时页面通常位于外部认证网关之后。会话过期后网关把接口请求重定向到登录页，
 * 请求必须手动跟踪重定向，才能把登录拦截和网络故障、网关故障区分开。
 */
export function isLoginRedirect(response: Pick<Response, "status" | "type">) {
  return (
    response.type === "opaqueredirect" ||
    response.status === 401 ||
    response.status === 403
  );
}

/** 登录过期不会随重试恢复，需要重新载入页面走一遍认证。 */
export class SessionExpiredError extends Error {
  constructor() {
    super("登录已过期，请刷新页面重新登录");
    this.name = "SessionExpiredError";
  }
}

export function isSessionExpired(error: unknown): error is SessionExpiredError {
  return error instanceof SessionExpiredError;
}

/**
 * 重新登录前清理本地静态前端壳缓存并通知离线脚本预留完整导航超时，
 * 避免慢网下 350 毫秒快速回退再次返回本地界面壳而进不了认证登录流。
 */
export async function reloadForSessionLogin() {
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("meterleaf-shell-"))
          .map((key) => caches.delete(key)),
      );
    }
    const controller =
      typeof navigator !== "undefined"
        ? navigator.serviceWorker?.controller
        : null;
    if (controller && typeof MessageChannel !== "undefined") {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(resolve, 150);
        channel.port1.onmessage = () => {
          clearTimeout(timer);
          resolve();
        };
        controller.postMessage({ type: "meterleaf-prepare-navigate" }, [
          channel.port2,
        ]);
      });
    }
  } catch {
    // 清理失败不阻塞重新载入。
  }
  window.location.reload();
}
