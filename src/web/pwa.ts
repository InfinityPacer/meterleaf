/** 开发服务器不注册 SW，避免本地调试被旧缓存接管。 */
export async function registerPwa(): Promise<ServiceWorkerRegistration | null> {
  if (
    import.meta.env?.PROD !== true ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  )
    return null;
  const registration = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
  });
  void navigator.serviceWorker.ready
    ?.then((ready) => {
      ready.active?.postMessage({ type: "meterleaf-warm-shell" });
    })
    .catch(() => undefined);
  return registration;
}
