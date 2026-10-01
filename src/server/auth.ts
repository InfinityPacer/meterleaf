import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { INGEST_BATCHES_PATH } from "../shared/ingest";
import { silentLogger, type DiagnosticsLogger } from "./diagnostics";

/**
 * 内置 GitHub 登录：只允许配置的 GitHub 账号访问界面与读取接口。
 *
 * 会话保存在签名 Cookie 中，服务端不存储会话；签名密钥由 OAuth 应用的 Client Secret
 * 派生，轮换 Secret 即让所有会话失效。会话在使用中顺延：距上次签发超过一天的有效会话
 * 会按完整有效期重新签发，因此持续使用不会过期，闲置满有效期才需要重新登录。
 * 每次请求都会重新核对账号仍在允许名单内，从名单删除即撤销访问。
 */
export interface GithubAuthConfig {
  clientId: string;
  clientSecret: string;
  /** 允许登录的 GitHub 用户名，比较时不区分大小写。 */
  users: string[];
  /** 浏览器访问 Meterleaf 的外部地址，用于回调地址与判断 Cookie 是否仅限 HTTPS。 */
  publicUrl: string;
  sessionDays: number;
}

export interface GithubIdentity {
  id: number;
  login: string;
}

/** 与 GitHub 交互的边界；测试注入假实现，生产使用 GitHub 的 OAuth 与 REST 接口。 */
export interface GithubClient {
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  fetchUser(accessToken: string): Promise<GithubIdentity>;
}

const SESSION_COOKIE = "meterleaf_session";
const STATE_COOKIE = "meterleaf_oauth";
const STATE_TTL_SECONDS = 600;
const RENEW_AFTER_SECONDS = 86_400;
const CALLBACK_PATH = "/auth/github/callback";
const LOGIN_PATH = "/auth/github/login";

/** 登录前也必须可读的路径：认证流程、健康检查、采集器写入（自带设备密钥）与品牌静态资源。 */
function isPublicPath(path: string) {
  return (
    path.startsWith("/auth/") ||
    path === "/api/health" ||
    path === INGEST_BATCHES_PATH ||
    path === "/favicon.svg" ||
    path === "/manifest.webmanifest" ||
    path === "/offline.html" ||
    path === "/sw.js" ||
    path.startsWith("/icons/")
  );
}

export function createGithubClient(
  config: Pick<GithubAuthConfig, "clientId" | "clientSecret">,
  fetchImpl: typeof fetch = fetch,
): GithubClient {
  return {
    async exchangeCode(code, redirectUri) {
      const response = await fetchImpl(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        access_token?: unknown;
        error?: unknown;
      };
      if (!response.ok || typeof body.access_token !== "string")
        throw new Error(
          `GitHub code exchange failed: ${typeof body.error === "string" ? body.error : `HTTP ${response.status}`}`,
        );
      return body.access_token;
    },
    async fetchUser(accessToken) {
      const response = await fetchImpl("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "meterleaf",
        },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        id?: unknown;
        login?: unknown;
      };
      if (
        !response.ok ||
        typeof body.id !== "number" ||
        typeof body.login !== "string"
      )
        throw new Error(`GitHub user lookup failed: HTTP ${response.status}`);
      return { id: body.id, login: body.login };
    },
  };
}

function base64url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0)
      cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

/** 只接受站内相对路径，防止登录后被带到外部站点。 */
function safeNext(value: unknown) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    !value.startsWith("/auth/")
    ? value
    : "/";
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

function page(title: string, message: string, action?: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Meterleaf</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;color:#1f2a24;background:#f6f7f4}@media(prefers-color-scheme:dark){body{color:#e6ebe7;background:#151a17}}main{max-width:420px}h1{font-size:20px}a{color:inherit}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p>${action ?? ""}</main></body></html>`;
}

export function registerGithubAuth(
  app: FastifyInstance,
  config: GithubAuthConfig,
  options: {
    client?: GithubClient;
    now?: () => number;
    diagnostics?: DiagnosticsLogger;
  } = {},
) {
  const client = options.client ?? createGithubClient(config);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const diagnostics = options.diagnostics ?? silentLogger;
  const key = createHmac("sha256", "meterleaf-session")
    .update(config.clientSecret)
    .digest();
  const allowed = new Set(config.users.map((user) => user.toLowerCase()));
  const publicUrl = new URL(config.publicUrl);
  const secure = publicUrl.protocol === "https:";
  const redirectUri = new URL(CALLBACK_PATH, publicUrl).toString();
  const sessionSeconds = config.sessionDays * 86_400;

  const sign = (payload: object) => {
    const body = base64url(JSON.stringify(payload));
    return `${body}.${base64url(createHmac("sha256", key).update(body).digest())}`;
  };
  const verify = <T>(token: string | undefined): T | undefined => {
    const [body, signature, extra] = token?.split(".") ?? [];
    if (!body || !signature || extra !== undefined) return undefined;
    const expected = createHmac("sha256", key).update(body).digest();
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return undefined;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    } catch {
      return undefined;
    }
  };
  const cookie = (name: string, value: string, maxAge: number, path = "/") =>
    `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

  type Session = { u: string; i: number; iat: number; exp: number };
  const issue = (reply: FastifyReply, identity: { u: string; i: number }) => {
    const iat = now();
    reply.header(
      "Set-Cookie",
      cookie(
        SESSION_COOKIE,
        sign({ ...identity, iat, exp: iat + sessionSeconds }),
        sessionSeconds,
      ),
    );
  };
  const currentSession = (request: FastifyRequest) => {
    const session = verify<Session>(
      parseCookies(request.headers.cookie).get(SESSION_COOKIE),
    );
    if (
      !session ||
      typeof session.u !== "string" ||
      typeof session.exp !== "number" ||
      session.exp <= now() ||
      !allowed.has(session.u.toLowerCase())
    )
      return undefined;
    return session;
  };

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (isPublicPath(path)) return;
    const session = currentSession(request);
    if (session) {
      if (now() - session.iat >= RENEW_AFTER_SECONDS)
        issue(reply, { u: session.u, i: session.i });
      return;
    }
    // 接口返回 401，由前端提示刷新；页面导航直接带去 GitHub 登录并在完成后回到原地址。
    if (path.startsWith("/api/") || !["GET", "HEAD"].includes(request.method))
      return reply.code(401).send({ error: "unauthorized" });
    return reply.redirect(
      `${LOGIN_PATH}?next=${encodeURIComponent(request.url)}`,
    );
  });

  app.get<{ Querystring: { next?: string } }>(LOGIN_PATH, (request, reply) => {
    const state = base64url(randomBytes(24));
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Set-Cookie",
      cookie(
        STATE_COOKIE,
        sign({
          s: state,
          n: safeNext(request.query.next),
          exp: now() + STATE_TTL_SECONDS,
        }),
        STATE_TTL_SECONDS,
        "/auth/",
      ),
    );
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("allow_signup", "false");
    return reply.redirect(authorize.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    CALLBACK_PATH,
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const stored = verify<{ s: string; n: string; exp: number }>(
        parseCookies(request.headers.cookie).get(STATE_COOKIE),
      );
      const clearState = cookie(STATE_COOKIE, "", 0, "/auth/");
      const retry = `<p><a href="${LOGIN_PATH}">重新登录</a></p>`;
      if (
        !stored ||
        stored.exp <= now() ||
        !request.query.state ||
        request.query.state !== stored.s ||
        !request.query.code
      ) {
        reply.header("Set-Cookie", clearState);
        return reply
          .code(400)
          .type("text/html; charset=utf-8")
          .send(
            page("登录已失效", "登录请求已过期或不完整，请重新登录。", retry),
          );
      }
      let identity: GithubIdentity;
      try {
        identity = await client.fetchUser(
          await client.exchangeCode(request.query.code, redirectUri),
        );
      } catch (error) {
        diagnostics.log("warn", "auth.github_failed", {
          requestId: request.id,
          error,
        });
        reply.header("Set-Cookie", clearState);
        return reply
          .code(502)
          .type("text/html; charset=utf-8")
          .send(
            page(
              "无法完成登录",
              "暂时无法从 GitHub 确认账号，请稍后重试。",
              retry,
            ),
          );
      }
      if (!allowed.has(identity.login.toLowerCase())) {
        diagnostics.log("warn", "auth.denied", { requestId: request.id });
        reply.header("Set-Cookie", clearState);
        return reply
          .code(403)
          .type("text/html; charset=utf-8")
          .send(
            page(
              "没有访问权限",
              `GitHub 账号 ${escapeHtml(identity.login)} 不在 Meterleaf 的允许名单中。`,
            ),
          );
      }
      issue(reply, { u: identity.login, i: identity.id });
      reply.header("Set-Cookie", clearState);
      return reply.redirect(safeNext(stored.n));
    },
  );

  app.get("/auth/logout", (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
    return reply
      .type("text/html; charset=utf-8")
      .send(
        page(
          "已退出",
          "已退出 Meterleaf。",
          `<p><a href="${LOGIN_PATH}">重新登录</a></p>`,
        ),
      );
  });
}
