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
  expect(worker).toContain('const CACHE_NAME = "meterleaf-offline-v7"');
  expect(worker).toContain("navigationPreload.enable");
  expect(worker).toContain("event.preloadResponse");
  expect(worker).toContain('event.request.mode !== "navigate"');
  expect(worker).toContain("caches.match(OFFLINE_URL)");
  expect(worker).not.toContain("/api/");
  expect(worker).not.toContain("cache.put");
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
  preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response | undefined>): void;
};
type MessageEventStub = {
  data?: { type?: string };
  ports: { postMessage(value: unknown): void }[];
};

/** 在最小的 Worker 环境里加载原始 sw.js，用可控时钟验证真实 350ms 与 8000ms 超时边界。 */
async function loadWorker(
  network: (signal?: AbortSignal) => Promise<Response>,
) {
  const source = await readFile(join(root, "public/sw.js"), "utf8");
  const handlers = new Map<string, (event: never) => void>();
  const offline = new Response("offline");
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
  const self = {
    location: { origin: "https://meterleaf.test" },
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
    { match: async () => offline },
    (_request: unknown, init?: { signal?: AbortSignal }) =>
      network(init?.signal),
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
  const startNavigate = (
    preload: Promise<Response | undefined>,
    url = "https://meterleaf.test/",
  ) => {
    const { promise, resolve } = Promise.withResolvers<Response | undefined>();
    (handlers.get("fetch") as ((event: FetchEventStub) => void) | undefined)!({
      request: {
        method: "GET",
        url,
        mode: "navigate",
      },
      preloadResponse: preload,
      respondWith: (response) => void response.then(resolve),
    });
    return promise;
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
  return { startNavigate, prepareNavigate, advance, offline };
}

test("an unconfirmed navigation that stalls falls back at 350ms to avoid a blank white screen", async () => {
  let aborted = false;
  const { startNavigate, advance, offline } = await loadWorker((signal) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    });
    return promise;
  });
  const first = startNavigate(Promise.resolve(undefined));
  await advance(349);
  expect(aborted).toBe(false);
  await advance(1);
  expect(await first).toBe(offline);
  expect(aborted).toBe(true);

  // 挂住的预加载同样不能让窗口一直空白。
  const hungPreload = startNavigate(Promise.withResolvers<undefined>().promise);
  await advance(350);
  expect(await hungPreload).toBe(offline);
});

test("confirmed reloads and auth callbacks keep the full 8000ms navigation timeout once", async () => {
  const slowPage = new Response("slow-page");
  let pendingResolve: ((response: Response) => void) | undefined;
  const { startNavigate, prepareNavigate, advance, offline } = await loadWorker(
    (signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      pendingResolve = resolve;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
      return promise;
    },
  );
  // 未确认的首次慢导航在 350ms 快速交出本地过渡壳。
  const initial = startNavigate(Promise.resolve(undefined));
  await advance(350);
  expect(await initial).toBe(offline);

  // 过渡壳探测成功后发来一次性确认，重载允许超过 350ms 继续等待完整页面到达。
  expect(await prepareNavigate()).toBe(true);
  const confirmed = startNavigate(Promise.resolve(undefined));
  await advance(1200);
  pendingResolve!(slowPage);
  expect(await confirmed).toBe(slowPage);

  // 一次性确认消费后，后续新的独立导航恢复 350ms 快速回退。
  const next = startNavigate(Promise.resolve(undefined));
  await advance(350);
  expect(await next).toBe(offline);

  // OAuth 回调不经过 350ms 快速截断，避免换取会话期间中断一次性 code。
  const auth = startNavigate(
    Promise.resolve(undefined),
    "https://meterleaf.test/auth/github/callback?code=abc&state=xyz",
  );
  await advance(1200);
  pendingResolve!(slowPage);
  expect(await auth).toBe(slowPage);
});

test("a navigation that answers in time passes through, while 502-504 or network errors show the offline page", async () => {
  const page = new Response("page");
  const preloaded = new Response("preloaded");
  const { startNavigate } = await loadWorker(async () => page);
  expect(await startNavigate(Promise.resolve(undefined))).toBe(page);
  expect(await startNavigate(Promise.resolve(preloaded))).toBe(preloaded);

  const gatewayError = await loadWorker(
    async () => new Response("bad gateway", { status: 502 }),
  );
  expect(await gatewayError.startNavigate(Promise.resolve(undefined))).toBe(
    gatewayError.offline,
  );

  const failing = await loadWorker(async () => {
    throw new TypeError("network");
  });
  expect(await failing.startNavigate(Promise.resolve(undefined))).toBe(
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
