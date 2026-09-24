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
