const CACHE_NAME = "meterleaf-offline-v8";
const SHELL_CACHE_PREFIX = "meterleaf-shell-";
const SHELL_CACHE_NAME = "meterleaf-shell-dev";
const SHELL_INDEX_URL = "/";
const OFFLINE_URL = "/offline.html";
const SHELL_ASSETS = [];
const HASHED_ASSET_PATH =
  /^\/assets\/.+[-_][A-Za-z0-9_-]{8,}\.(?:js|css|woff2)$/;
/**
 * 首次页面导航的快速回退上限。网络切换或弱网握手挂住时，旧连接可能既不失败也不返回，
 * 超过这一时间仍未拿到响应首包就中止卡死的连接并交出本地纯静态前端壳，避免白屏与连接池阻塞。
 */
const INITIAL_NAVIGATION_TIMEOUT_MS = 350;
/**
 * 重新登录、已确认服务可达后的重载，以及登录回调等认证跳转使用的完整超时上限。
 * 此时窗口已有界面提示，需要留足慢网传输和 OAuth 会话交换时间。
 */
const CONFIRMED_NAVIGATION_TIMEOUT_MS = 8000;
let confirmedNavigateUntil = 0;
let warmingShell = null;
const PRECACHE_URLS = [
  OFFLINE_URL,
  // 品牌图标在登录过期时也要可读，否则认证网关的重定向会让页面显示破图。
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/meterleaf-leaf-180.png",
  "/icons/meterleaf-leaf-192.png",
  "/icons/meterleaf-leaf-512.png",
  // 旧安装引用的路径保留同一品牌图标。
  "/icons/meterleaf-192.png",
  "/icons/meterleaf-512.png",
];

function isHtmlShellResponse(response) {
  return (
    Boolean(response) &&
    response.status === 200 &&
    !response.redirected &&
    response.type !== "opaqueredirect" &&
    (response.headers.get("content-type") ?? "").includes("text/html")
  );
}

function isSessionRedirect(response) {
  return (
    Boolean(response) &&
    (response.type === "opaqueredirect" ||
      response.redirected ||
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400))
  );
}

function warmShellAssets() {
  if (warmingShell) return warmingShell;
  warmingShell = (async () => {
    try {
      const cache = await caches.open(SHELL_CACHE_NAME);
      if (!(await cache.match(SHELL_INDEX_URL))) {
        const indexResponse = await fetch(
          new Request(SHELL_INDEX_URL, {
            cache: "reload",
            credentials: "same-origin",
            redirect: "manual",
          }),
        );
        if (!isHtmlShellResponse(indexResponse)) return false;
        await cache.put(SHELL_INDEX_URL, indexResponse);
      }
      await Promise.all(
        SHELL_ASSETS.map(async (assetUrl) => {
          if (await cache.match(assetUrl)) return;
          const response = await fetch(
            new Request(assetUrl, {
              credentials: "same-origin",
              redirect: "manual",
            }),
          );
          if (
            response.status === 200 &&
            !response.redirected &&
            response.type !== "opaqueredirect"
          ) {
            await cache.put(assetUrl, response);
          }
        }),
      );
      return true;
    } catch {
      return false;
    } finally {
      warmingShell = null;
    }
  })();
  return warmingShell;
}

async function matchNavigationFallback() {
  const shellCache = await caches.open(SHELL_CACHE_NAME);
  const shellIndex = await shellCache.match(SHELL_INDEX_URL);
  if (shellIndex) {
    const missingAsset = (
      await Promise.all(
        SHELL_ASSETS.map(
          async (assetUrl) => !(await shellCache.match(assetUrl)),
        ),
      )
    ).some(Boolean);
    if (!missingAsset) return shellIndex;
  }
  return caches.match(OFFLINE_URL);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(
          PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" })),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 显式关闭旧版本启用的导航预加载。iOS WebKit 在 Wi-Fi 切蜂窝网时会在失效连接上
      // 挂住底层预加载请求且无法被 AbortController 中止，并堵住同源 HTTP/2 连接池。
      if ("navigationPreload" in self.registration) {
        await self.registration.navigationPreload
          .disable()
          .catch(() => undefined);
      }
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              (key.startsWith("meterleaf-offline-") && key !== CACHE_NAME) ||
              (key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE_NAME),
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
      if (
        self.clients.matchAll &&
        (await self.clients.matchAll({ type: "window" })).length > 0
      ) {
        await warmShellAssets();
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "meterleaf-prepare-navigate") {
    confirmedNavigateUntil = Date.now() + CONFIRMED_NAVIGATION_TIMEOUT_MS;
    event.ports[0]?.postMessage(true);
  } else if (event.data?.type === "meterleaf-warm-shell") {
    const done = warmShellAssets().then((ok) => {
      event.ports[0]?.postMessage(ok);
    });
    if (typeof event.waitUntil === "function") event.waitUntil(done);
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // API 永远只走网络，任何账本与账户数据都不写入缓存。
  if (url.pathname.startsWith("/api/")) return;

  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(
      caches
        .match(event.request)
        .then((cached) => cached ?? fetch(event.request)),
    );
    return;
  }

  // 带内容哈希的纯静态前端脚本、样式与字体使用本地缓存优先，保证离线前端壳完整启动。
  if (
    event.request.mode !== "navigate" &&
    (SHELL_ASSETS.includes(url.pathname) ||
      HASHED_ASSET_PATH.test(url.pathname))
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE_NAME);
        const cached = await cache.match(url.pathname);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (
          response.status === 200 &&
          !response.redirected &&
          response.type !== "opaqueredirect"
        ) {
          await cache.put(url.pathname, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  if (event.request.mode !== "navigate") return;

  const isAuthNavigation = url.pathname.startsWith("/auth/");
  const useConfirmedTimeout =
    isAuthNavigation || confirmedNavigateUntil > Date.now();
  if (!isAuthNavigation) confirmedNavigateUntil = 0;
  const timeoutMs = useConfirmedTimeout
    ? CONFIRMED_NAVIGATION_TIMEOUT_MS
    : INITIAL_NAVIGATION_TIMEOUT_MS;

  event.respondWith(
    (async () => {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("navigation timeout"));
        }, timeoutMs);
      });
      try {
        const network = fetch(event.request, { signal: controller.signal });
        network.catch(() => undefined);
        const response = await Promise.race([network, timeout]);
        if (isAuthNavigation) return response;
        if (
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504
        ) {
          return (await matchNavigationFallback()) ?? response;
        }
        if (isSessionRedirect(response)) {
          event.waitUntil?.(
            caches
              .open(SHELL_CACHE_NAME)
              .then((cache) => cache.delete(SHELL_INDEX_URL)),
          );
          return response;
        }
        if (isHtmlShellResponse(response)) {
          const copy = response.clone();
          event.waitUntil?.(
            caches
              .open(SHELL_CACHE_NAME)
              .then((cache) => cache.put(SHELL_INDEX_URL, copy))
              .then(() => warmShellAssets()),
          );
        }
        return response;
      } catch {
        if (isAuthNavigation) return caches.match(OFFLINE_URL);
        return matchNavigationFallback();
      } finally {
        clearTimeout(timer);
      }
    })(),
  );
});
