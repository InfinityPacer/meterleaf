/** 开发服务器不注册 SW，避免本地调试被旧缓存接管。 */
export function registerPwa(): Promise<ServiceWorkerRegistration | null> {
  if (
    import.meta.env?.PROD !== true ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  )
    return Promise.resolve(null);
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}
