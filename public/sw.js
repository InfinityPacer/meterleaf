const CACHE_NAME = "meterleaf-offline-v5";
const OFFLINE_URL = "/offline.html";
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
      .then((cache) => cache.addAll(PRECACHE_URLS))
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

  event.respondWith(
    (async () => {
      try {
        // 网络导航仍需经过外部认证；预加载与 Worker 启动并行，避免冷 Worker 先阻塞网络。
        return (await event.preloadResponse) ?? (await fetch(event.request));
      } catch {
        return caches.match(OFFLINE_URL);
      }
    })(),
  );
});
