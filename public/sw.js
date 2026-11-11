const CACHE_NAME = "meterleaf-offline-v7";
const OFFLINE_URL = "/offline.html";
/**
 * 首次页面导航的快速回退上限。网络切换或弱网握手挂住时，旧连接可能既不失败也不返回，
 * 超过这一时间仍未拿到响应首包就先交出本地启动过渡页，避免独立窗口长时间停在白屏。
 */
const INITIAL_NAVIGATION_TIMEOUT_MS = 350;
/**
 * 已确认服务可达后的重载，以及登录回调等认证跳转使用的完整超时上限。
 * 此时窗口已有连接提示画面，不再白屏，需要留足慢网传输和 OAuth 会话交换时间。
 */
const CONFIRMED_NAVIGATION_TIMEOUT_MS = 8000;
let confirmedNavigateUntil = 0;
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
      if ("navigationPreload" in self.registration)
        await self.registration.navigationPreload.enable();
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) => key.startsWith("meterleaf-offline-") && key !== CACHE_NAME,
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "meterleaf-prepare-navigate") {
    confirmedNavigateUntil = Date.now() + CONFIRMED_NAVIGATION_TIMEOUT_MS;
    event.ports[0]?.postMessage(true);
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // 离线页的图标同样必须可读；账本与 API 不进入静态资源白名单。
  if (
    url.origin === self.location.origin &&
    PRECACHE_URLS.includes(url.pathname)
  ) {
    event.respondWith(
      caches
        .match(event.request)
        .then((cached) => cached ?? fetch(event.request)),
    );
    return;
  }
  if (event.request.mode !== "navigate") return;

  const isAuthNavigation =
    url.origin === self.location.origin && url.pathname.startsWith("/auth/");
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
        // 网络导航仍需经过外部认证；预加载与 Worker 启动并行，避免冷 Worker 先阻塞网络。
        const network = (async () =>
          (await event.preloadResponse) ??
          (await fetch(event.request, { signal: controller.signal })))();
        network.catch(() => undefined);
        const response = await Promise.race([network, timeout]);
        if (
          !isAuthNavigation &&
          (response.status === 502 ||
            response.status === 503 ||
            response.status === 504)
        ) {
          return (await caches.match(OFFLINE_URL)) ?? response;
        }
        return response;
      } catch {
        return caches.match(OFFLINE_URL);
      } finally {
        clearTimeout(timer);
      }
    })(),
  );
});
