/** 完整样式加载期间保留内联启动提示，避免 React 提前替换成无样式内容。 */
export async function waitForAppStyles(): Promise<void> {
  await Promise.all(
    Array.from(
      document.querySelectorAll<HTMLLinkElement>("link[data-app-styles]"),
      (link) =>
        new Promise<void>((resolve, reject) => {
          if (link.dataset.failed === "true") {
            reject(new Error("Application stylesheet failed to load"));
            return;
          }
          if (link.sheet) {
            link.media = "all";
            resolve();
            return;
          }
          const cleanup = () => {
            link.removeEventListener("load", loaded);
            link.removeEventListener("error", failed);
          };
          const loaded = () => {
            cleanup();
            link.media = "all";
            resolve();
          };
          const failed = () => {
            cleanup();
            reject(new Error("Application stylesheet failed to load"));
          };
          link.addEventListener("load", loaded);
          link.addEventListener("error", failed);
        }),
    ),
  );
}
