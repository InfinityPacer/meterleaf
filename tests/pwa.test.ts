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

test("service worker disables navigationPreload and isolates static shell from APIs", async () => {
  const worker = await readFile(join(root, "public/sw.js"), "utf8");
  expect(worker).toContain("/offline.html");
  expect(worker).toContain("/manifest.webmanifest");
  expect(worker).toContain('"/favicon.svg"');
  expect(worker).toContain("/icons/meterleaf-leaf-180.png");
  expect(worker).toContain("/icons/meterleaf-leaf-192.png");
  expect(worker).toContain("/icons/meterleaf-leaf-512.png");
  expect(worker).toContain("/icons/meterleaf-192.png");
  expect(worker).toContain("/icons/meterleaf-512.png");
  expect(worker).toContain('const CACHE_NAME = "meterleaf-offline-v8"');
  expect(worker).toContain("navigationPreload");
  expect(worker).toContain(".disable()");
  expect(worker).not.toContain("navigationPreload.enable");
  expect(worker).not.toContain("preloadResponse");
  expect(worker).toContain('url.pathname.startsWith("/api/")');
  expect(worker).toContain("caches.match(OFFLINE_URL)");
});

test("offline page does not expose a stale ledger and avoids blind reload on retry", async () => {
  const offline = await readFile(join(root, "public/offline.html"), "utf8");
  expect(offline).toContain("正在连接 Meterleaf…");
  expect(offline).toContain("账本需要联网查看");
  expect(offline).toContain('src="/icons/meterleaf-leaf-192.png"');
  expect(offline).toContain("重新连接");
  expect(offline).toContain("meterleaf-theme");
  expect(offline).toContain("meterleaf-palette");
  expect(offline).not.toContain('onclick="location.reload()"');
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
  expect(offline).toContain("meterleaf-prepare-navigate");
});

type FetchEventStub = {
  request: { method: string; url: string; mode: string };
  respondWith(response: Promise<Response | undefined>): void;
  waitUntil?(promise: Promise<unknown>): void;
};
type MessageEventStub = {
  data?: { type?: string };
  ports: { postMessage(value: unknown): void }[];
  waitUntil?(promise: Promise<unknown>): void;
};
type ActivateEventStub = {
  waitUntil(promise: Promise<unknown>): void;
};

/** 在最小的 Worker 环境里加载原始 sw.js，用可控时钟验证 350ms/8000ms 超时、预加载禁用与静态壳回退。 */
async function loadWorker(
  network: (url: string, signal?: AbortSignal) => Promise<Response>,
) {
  const source = await readFile(join(root, "public/sw.js"), "utf8");
  const handlers = new Map<string, (event: never) => void>();
  const offline = new Response("offline", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const store = new Map<string, Map<string, Response>>();
  store.set("meterleaf-offline-v8", new Map([["/offline.html", offline]]));
  store.set("meterleaf-offline-v7", new Map([["/offline.html", offline]]));
  store.set("meterleaf-shell-old", new Map([["/", new Response("old-shell")]]));
  let preloadDisabled = false;
  let nowMs = 1_000;
  let nextTimerId = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const advance = async (ms: number) => {
    nowMs += ms;
    for (const [id, entry] of [...timers.entries()]) {
      if (entry.due <= nowMs) {
        timers.delete(id);
        entry.fn();
      }
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  const urlOf = (request: string | { url: string }) =>
    typeof request === "string" ? request : request.url;
  const keyOf = (request: string | { url: string }) =>
    new URL(urlOf(request), "https://meterleaf.test").pathname;
  const cachesStub = {
    open: async (name: string) => {
      let bucket = store.get(name);
      if (!bucket) {
        bucket = new Map();
        store.set(name, bucket);
      }
      return {
        match: async (req: string | { url: string }) =>
          bucket!.get(keyOf(req))?.clone(),
        put: async (req: string | { url: string }, res: Response) => {
          bucket!.set(keyOf(req), res.clone());
        },
        delete: async (req: string | { url: string }) =>
          bucket!.delete(keyOf(req)),
      };
    },
    match: async (req: string | { url: string }) => {
      const path = keyOf(req);
      for (const bucket of store.values()) {
        const hit = bucket.get(path);
        if (hit) return hit.clone();
      }
      return undefined;
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };
  const self = {
    location: { origin: "https://meterleaf.test" },
    registration: {
      navigationPreload: {
        disable: async () => {
          preloadDisabled = true;
        },
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
    },
    addEventListener: (type: string, handler: (event: never) => void) =>
      handlers.set(type, handler),
  };
  new Function(
    "self",
    "caches",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "Date",
    source,
  )(
    self,
    cachesStub,
    (request: string | { url: string }, init?: { signal?: AbortSignal }) =>
      network(urlOf(request), init?.signal),
    (fn: () => void, ms = 0) => {
      const id = nextTimerId++;
      timers.set(id, { due: nowMs + ms, fn });
      return id;
    },
    (id?: number) => {
      if (id !== undefined) timers.delete(id);
    },
    { now: () => nowMs },
  );
  const pendingWaits: Promise<unknown>[] = [];
  const dispatchFetch = (
    url: string,
    mode = "navigate",
    method = "GET",
  ): { handled: boolean; response: Promise<Response | undefined> } => {
    let handled = false;
    const { promise, resolve } = Promise.withResolvers<Response | undefined>();
    (handlers.get("fetch") as ((event: FetchEventStub) => void) | undefined)!({
      request: { method, url, mode },
      respondWith: (response) => {
        handled = true;
        void response.then(resolve);
      },
      waitUntil: (task) => {
        pendingWaits.push(task);
      },
    });
    if (!handled) resolve(undefined);
    return { handled, response: promise };
  };
  const startNavigate = (url = "https://meterleaf.test/") =>
    dispatchFetch(url, "navigate").response;
  const flushWaits = async () => {
    await Promise.all(pendingWaits.splice(0));
  };
  const activate = async () => {
    let task: Promise<unknown> = Promise.resolve();
    (handlers.get("activate") as
      ((event: ActivateEventStub) => void) | undefined)!({
      waitUntil: (promise) => {
        task = promise;
      },
    });
    await task;
  };
  const prepareNavigate = () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    (handlers.get("message") as
      ((event: MessageEventStub) => void) | undefined)!({
      data: { type: "meterleaf-prepare-navigate" },
      ports: [{ postMessage: resolve }],
    });
    return promise;
  };
  return {
    activate,
    startNavigate,
    dispatchFetch,
    flushWaits,
    prepareNavigate,
    advance,
    offline,
    store,
    isPreloadDisabled: () => preloadDisabled,
  };
}

test("activate disables legacy navigationPreload and evicts outdated caches", async () => {
  const worker = await loadWorker(async () => new Response("ok"));
  await worker.activate();
  expect(worker.isPreloadDisabled()).toBe(true);
  expect(worker.store.has("meterleaf-offline-v7")).toBe(false);
  expect(worker.store.has("meterleaf-shell-old")).toBe(false);
  expect(worker.store.has("meterleaf-offline-v8")).toBe(true);
});

test("an unconfirmed navigation that stalls aborts the hung socket at 350ms", async () => {
  let aborted = false;
  const { startNavigate, advance } = await loadWorker((_url, signal) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    });
    return promise;
  });
  const first = startNavigate();
  await advance(349);
  expect(aborted).toBe(false);
  await advance(1);
  expect(await (await first)?.text()).toBe("offline");
  expect(aborted).toBe(true);
});

test("confirmed reloads and auth callbacks keep the full 8000ms navigation timeout once", async () => {
  const slowPage = new Response("slow-page", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  let pendingResolve: ((response: Response) => void) | undefined;
  const { startNavigate, prepareNavigate, advance } = await loadWorker(
    (_url, signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      pendingResolve = resolve;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
      return promise;
    },
  );
  // 冷缓存下未确认的首次慢导航在 350ms 快速交出离线页。
  const initial = startNavigate();
  await advance(350);
  expect(await (await initial)?.text()).toBe("offline");

  // 探测成功后发来一次性确认，重载允许超过 350ms 继续等待完整页面到达。
  expect(await prepareNavigate()).toBe(true);
  const confirmed = startNavigate();
  await advance(1200);
  pendingResolve!(slowPage);
  expect(await confirmed).toBe(slowPage);

  // OAuth 回调不经过 350ms 快速截断，避免换取会话期间中断一次性 code。
  const auth = startNavigate(
    "https://meterleaf.test/auth/github/callback?code=abc&state=xyz",
  );
  await advance(1200);
  pendingResolve!(slowPage);
  expect(await auth).toBe(slowPage);
});

test("warmed app shell serves cached HTML and hashed assets on handoff, never caches APIs, and clears on auth redirect", async () => {
  let mode: "online" | "gateway-502" | "offline" | "auth-expired" = "online";
  let assetNetworkHits = 0;
  const htmlShell = new Response("<!doctype html><div id='root'></div>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const jsBundle = new Response("console.log('shell')", {
    status: 200,
    headers: { "content-type": "text/javascript" },
  });
  const loginRedirect = new Response(null, { status: 302 });

  const worker = await loadWorker(async (url) => {
    if (url.endsWith("/assets/index-Abcd1234.js")) {
      if (mode === "offline") throw new TypeError("offline");
      assetNetworkHits += 1;
      return jsBundle.clone();
    }
    if (mode === "online") return htmlShell.clone();
    if (mode === "gateway-502")
      return new Response("bad gateway", { status: 502 });
    if (mode === "auth-expired") return loginRedirect;
    throw new TypeError("network");
  });

  // API 请求永远不经过 Service Worker 拦截或缓存。
  expect(
    worker.dispatchFetch("https://meterleaf.test/api/view?days=7", "cors")
      .handled,
  ).toBe(false);

  // 在线导航写入纯静态首页壳，带哈希的静态脚本缓存优先。
  const firstNav = await worker.startNavigate();
  expect(await firstNav?.text()).toContain("id='root'");
  await worker.flushWaits();

  const firstAsset = await worker.dispatchFetch(
    "https://meterleaf.test/assets/index-Abcd1234.js",
    "cors",
  ).response;
  expect(await firstAsset?.text()).toBe("console.log('shell')");
  expect(assetNetworkHits).toBe(1);

  // 切网断连或上游 502 时直接返回本地静态前端壳与脚本，不再弹整页离线报错。
  mode = "offline";
  const offlineNav = await worker.startNavigate();
  expect(await offlineNav?.text()).toContain("id='root'");
  const cachedAsset = await worker.dispatchFetch(
    "https://meterleaf.test/assets/index-Abcd1234.js",
    "cors",
  ).response;
  expect(await cachedAsset?.text()).toBe("console.log('shell')");
  expect(assetNetworkHits).toBe(1);

  mode = "gateway-502";
  const gatewayNav = await worker.startNavigate();
  expect(await gatewayNav?.text()).toContain("id='root'");

  // 登录过期收到认证重定向时透传重定向并清掉已缓存的首页壳。
  mode = "auth-expired";
  expect(await worker.startNavigate()).toBe(loginRedirect);
  await worker.flushWaits();

  mode = "offline";
  expect(await (await worker.startNavigate())?.text()).toBe("offline");
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
