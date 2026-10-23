import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { registerPwa } from "../src/web/pwa";

const root = join(import.meta.dir, "..");

function pngSize(bytes: Uint8Array) {
  if (String.fromCharCode(...bytes.slice(1, 4)) !== "PNG")
    throw new Error("not a PNG");
  return {
    width: new DataView(bytes.buffer, bytes.byteOffset).getUint32(16),
    height: new DataView(bytes.buffer, bytes.byteOffset).getUint32(20),
  };
}

test("manifest declares a standalone Meterleaf app with maskable icons", async () => {
  const manifest = JSON.parse(
    await readFile(join(root, "public/manifest.webmanifest"), "utf8"),
  ) as {
    name: string;
    start_url: string;
    display: string;
    icons: { sizes: string; purpose: string; src: string; type: string }[];
  };
  expect(manifest).toMatchObject({
    name: "Meterleaf",
    start_url: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual([
    {
      sizes: "192x192",
      purpose: "any maskable",
      src: "/icons/meterleaf-leaf-192.png",
      type: "image/png",
    },
    {
      sizes: "512x512",
      purpose: "any maskable",
      src: "/icons/meterleaf-leaf-512.png",
      type: "image/png",
    },
  ]);
});

test("generated icon assets have the manifest dimensions", async () => {
  for (const size of [180, 192, 512]) {
    const path = join(root, `public/icons/meterleaf-leaf-${size}.png`);
    const file = await readFile(path);
    expect((await stat(path)).isFile()).toBe(true);
    expect(pngSize(file)).toEqual({ width: size, height: size });
  }

  for (const size of [192, 512]) {
    const canonical = await readFile(
      join(root, `public/icons/meterleaf-leaf-${size}.png`),
    );
    const legacy = await readFile(
      join(root, `public/icons/meterleaf-${size}.png`),
    );
    expect(legacy).toEqual(canonical);
  }
});

test("service worker only precaches independent offline resources", async () => {
  const worker = await readFile(join(root, "public/sw.js"), "utf8");
  expect(worker).toContain("/offline.html");
  expect(worker).toContain("/manifest.webmanifest");
  expect(worker).toContain('"/favicon.svg"');
  expect(worker).toContain("/icons/meterleaf-leaf-180.png");
  expect(worker).toContain("/icons/meterleaf-leaf-192.png");
  expect(worker).toContain("/icons/meterleaf-leaf-512.png");
  expect(worker).toContain("/icons/meterleaf-192.png");
  expect(worker).toContain("/icons/meterleaf-512.png");
  expect(worker).toContain('const CACHE_NAME = "meterleaf-offline-v6"');
  expect(worker).toContain("navigationPreload.enable");
  expect(worker).toContain("event.preloadResponse");
  expect(worker).toContain('event.request.mode !== "navigate"');
  expect(worker).toContain("caches.match(OFFLINE_URL)");
  expect(worker).not.toContain("/api/");
  expect(worker).not.toContain("cache.put");
});

test("offline page does not expose a stale ledger", async () => {
  const offline = await readFile(join(root, "public/offline.html"), "utf8");
  expect(offline).toContain("账本需要联网查看");
  expect(offline).toContain('src="/icons/meterleaf-leaf-192.png"');
  expect(offline).toContain("重新连接");
  expect(offline).not.toContain("/api/");
});

test("offline page probes a path the service worker never answers from cache", async () => {
  const offline = await readFile(join(root, "public/offline.html"), "utf8");
  const worker = await readFile(join(root, "public/sw.js"), "utf8");
  const probe = /fetch\("([^"?]+)\?probe=/.exec(offline)?.[1];
  expect(probe).toBe("/");
  const precached = /const PRECACHE_URLS = \[([\s\S]*?)\];/.exec(worker)![1]!;
  expect(precached).not.toContain(`"${probe}"`);
  expect(offline).toContain("AbortSignal.timeout");
});

type FetchHandler = (event: {
  request: { method: string; url: string; mode: string };
  preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response | undefined>): void;
}) => void;

/** 在最小的 Worker 环境里加载 sw.js，导航超时缩短到 50 毫秒。 */
async function loadWorker(
  network: (signal?: AbortSignal) => Promise<Response>,
) {
  const source = (await readFile(join(root, "public/sw.js"), "utf8")).replace(
    "const NAVIGATION_TIMEOUT_MS = 8000;",
    "const NAVIGATION_TIMEOUT_MS = 50;",
  );
  const handlers = new Map<string, FetchHandler>();
  const offline = new Response("offline");
  const self = {
    location: { origin: "https://meterleaf.test" },
    addEventListener: (type: string, handler: FetchHandler) =>
      handlers.set(type, handler),
  };
  const caches = { match: async () => offline };
  const fetchStub = (_request: unknown, init?: { signal?: AbortSignal }) =>
    network(init?.signal);
  new Function("self", "caches", "fetch", source)(self, caches, fetchStub);
  const navigate = (preload: Promise<Response | undefined>) =>
    new Promise<Response | undefined>((resolve) =>
      handlers.get("fetch")!({
        request: {
          method: "GET",
          url: "https://meterleaf.test/",
          mode: "navigate",
        },
        preloadResponse: preload,
        respondWith: (response) => void response.then(resolve),
      }),
    );
  return { navigate, offline };
}

test("a navigation that never answers falls back to the offline page and aborts the request", async () => {
  let aborted = false;
  const { navigate, offline } = await loadWorker(
    (signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }),
      ),
  );
  expect(await navigate(Promise.resolve(undefined))).toBe(offline);
  expect(aborted).toBe(true);
  // 挂住的预加载同样不能让窗口一直空白。
  expect(await navigate(new Promise(() => undefined))).toBe(offline);
});

test("a navigation that answers in time is passed through, and a failure still shows the offline page", async () => {
  const page = new Response("page");
  const preloaded = new Response("preloaded");
  const { navigate } = await loadWorker(async () => page);
  expect(await navigate(Promise.resolve(undefined))).toBe(page);
  expect(await navigate(Promise.resolve(preloaded))).toBe(preloaded);
  const failing = await loadWorker(async () => {
    throw new TypeError("network");
  });
  expect(await failing.navigate(Promise.resolve(undefined))).toBe(
    failing.offline,
  );
});

test("HTML exposes the manifest and Apple touch icon for native browser install", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  const normalizedHtml = html.replace(/\s+/g, " ");
  expect(normalizedHtml).toContain(
    'rel="manifest" href="/manifest.webmanifest"',
  );
  expect(normalizedHtml).toContain(
    'name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0, viewport-fit=cover"',
  );
  expect(normalizedHtml).toContain(
    'rel="apple-touch-icon" sizes="180x180" href="/icons/meterleaf-leaf-180.png"',
  );
  expect(normalizedHtml).toContain('class="boot-shell"');
});

test("PWA module only exposes production service-worker registration", async () => {
  const pwa = await import("../src/web/pwa");
  expect(Object.keys(pwa)).toEqual(["registerPwa"]);
  expect(await registerPwa()).toBeNull();
});
