import { chromium, expect, type Locator, type Route } from "@playwright/test";

const base = process.env.METERLEAF_TEST_URL ?? "http://127.0.0.1:4332/";
const baseUrl = new URL(base);
const endpoint = process.env.METERLEAF_CDP_URL;
if (!endpoint) throw new Error("METERLEAF_CDP_URL is required");

const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => {
    try {
      return new URL(candidate.url()).origin === baseUrl.origin;
    } catch {
      return false;
    }
  });
if (!page)
  throw new Error(
    "Open the production preview through the browser manager first",
  );
page.setDefaultTimeout(10_000);

const pageSession = await page.context().newCDPSession(page);
const browserSession = await browser.newBrowserCDPSession();
const onlineApiUrl = new URL("/api/view?pwaBrowserTest=online-fixture", baseUrl)
  .href;
const onlineApiFixture = {
  fixture: "pwa-browser-same-origin-api",
  ok: true,
};
let onlineApiRequests = 0;
const onlineApiRouteHandler = async (route: Route) => {
  onlineApiRequests++;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    json: onlineApiFixture,
  });
};
let onlineApiRouteInstalled = false;
let workerSessionId: string | undefined;
let cdpMessageId = 0;

async function sendWorkerCommand(
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const id = ++cdpMessageId;
  const response = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      browserSession.off("Target.receivedMessageFromTarget", listener);
      reject(new Error(`${method} timed out`));
    }, 5_000);
    const listener = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message) as {
        id?: number;
        error?: { message?: string };
        result?: unknown;
      };
      if (message.id !== id) return;
      clearTimeout(timeout);
      browserSession.off("Target.receivedMessageFromTarget", listener);
      if (message.error) {
        reject(new Error(message.error.message ?? `${method} failed`));
      } else {
        resolve(message.result);
      }
    };
    browserSession.on("Target.receivedMessageFromTarget", listener);
  });
  await browserSession.send("Target.sendMessageToTarget", {
    sessionId,
    message: JSON.stringify({ id, method, params }),
  });
  return response;
}

async function setOffline(offline: boolean) {
  const conditions = {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
  };
  const commands: Promise<unknown>[] = [
    pageSession.send("Network.emulateNetworkConditions", conditions),
  ];
  if (workerSessionId) {
    commands.push(
      sendWorkerCommand(
        workerSessionId,
        "Network.emulateNetworkConditions",
        conditions,
      ),
    );
  }
  await Promise.all(commands);
}

async function imageHasPaintedPixels(locator: Locator) {
  return locator.evaluate((element) => {
    const image = element as HTMLImageElement;
    if (
      !image.complete ||
      image.naturalWidth === 0 ||
      image.naturalHeight === 0
    )
      return false;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return false;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  });
}

try {
  await page.goto(base);
  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return {
      scope: ready.scope,
      activeScriptUrl: ready.active?.scriptURL ?? null,
    };
  });
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  expect(registration.scope).toBe(`${baseUrl.origin}/`);
  expect(registration.activeScriptUrl).toBe(`${baseUrl.origin}/sw.js`);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
  ).toBe(`${baseUrl.origin}/sw.js`);

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (!registration)
      throw new Error("The page has no service-worker registration");
    await registration.update();
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const response = await caches.match("/offline.html");
        return response ? response.text() : null;
      }),
    )
    .toContain("重新连接");

  const manifest = await (
    await page.request.get(`${base}manifest.webmanifest`)
  ).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  for (const icon of manifest.icons) {
    const response = await page.request.get(new URL(icon.src, base).href);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  const cacheEntries = await page.evaluate(async () => {
    const keys = await caches.keys();
    return Promise.all(
      keys.map(async (key) => ({
        key,
        paths: (await (await caches.open(key)).keys()).map(
          (request) => new URL(request.url).pathname,
        ),
      })),
    );
  });
  const cachePaths = cacheEntries.flatMap((entry) => entry.paths);
  expect(cachePaths).toContain("/offline.html");
  expect(cachePaths).toContain("/manifest.webmanifest");
  expect(cachePaths).toContain("/icons/meterleaf-192.png");
  expect(cachePaths).toContain("/icons/meterleaf-512.png");
  expect(
    cacheEntries.flatMap((entry) =>
      entry.paths.filter((path) => path.startsWith("/api")),
    ),
  ).toEqual([]);

  await page.route(onlineApiUrl, onlineApiRouteHandler);
  onlineApiRouteInstalled = true;
  const onlineApiResponse = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json(),
    };
  }, onlineApiUrl);
  expect(onlineApiResponse).toEqual({
    ok: true,
    status: 200,
    body: onlineApiFixture,
  });
  expect(onlineApiRequests).toBe(1);
  await page.unroute(onlineApiUrl, onlineApiRouteHandler);
  onlineApiRouteInstalled = false;

  const nativeInstallEvent = await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => ({ outcome: "dismissed" }),
    });
    return {
      dispatchResult: window.dispatchEvent(event),
      defaultPrevented: event.defaultPrevented,
    };
  });
  expect(nativeInstallEvent).toEqual({
    dispatchResult: true,
    defaultPrevented: false,
  });
  await expect(page.locator(".app-shell")).toBeVisible();
  const onlineTitle = await page.title();
  await expect(
    page.getByRole("button", { name: /安装 Meterleaf|添加到主屏幕/ }),
  ).toHaveCount(0);
  await expect(page.getByText("添加到主屏幕", { exact: true })).toHaveCount(0);

  const workerTarget = (
    await browserSession.send("Target.getTargets")
  ).targetInfos.find(
    (target) =>
      target.type === "service_worker" &&
      target.url === `${baseUrl.origin}/sw.js`,
  );
  if (!workerTarget)
    throw new Error("The page's service-worker target is not available");
  workerSessionId = (
    await browserSession.send("Target.attachToTarget", {
      targetId: workerTarget.targetId,
      flatten: false,
    })
  ).sessionId;
  await sendWorkerCommand(workerSessionId, "Network.enable");
  await pageSession.send("Network.enable");
  await setOffline(true);
  const offlineApiFetch = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url);
      return { failed: false, status: response.status };
    } catch (error) {
      return {
        failed: true,
        error: error instanceof Error ? error.name : String(error),
      };
    }
  }, onlineApiUrl);
  expect(offlineApiFetch.failed).toBe(true);
  expect(
    await page.evaluate(async () => {
      const paths = await Promise.all(
        (await caches.keys()).map(async (key) =>
          (await (await caches.open(key)).keys()).map(
            (request) => new URL(request.url).pathname,
          ),
        ),
      );
      return paths.flat().filter((path) => path.startsWith("/api"));
    }),
  ).toEqual([]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Meterleaf 暂时离线" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "重新连接" })).toBeVisible();
  expect(await page.title()).toBe("Meterleaf · 暂时离线");
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
  ).toBe(`${baseUrl.origin}/sw.js`);
  const offlineIcon = page.getByRole("img", { name: "Meterleaf" });
  await expect(offlineIcon).toBeVisible();
  expect(await imageHasPaintedPixels(offlineIcon)).toBe(true);
  await expect(page.locator(".app-shell, .account-row, .metrics")).toHaveCount(
    0,
  );
  await page.screenshot({ path: "test-results/pwa-offline.png" });

  await setOffline(false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page).toHaveTitle(onlineTitle);
  console.log(
    JSON.stringify({
      manifest: true,
      pngIcons: true,
      serviceWorkerControls: true,
      noApiCache: true,
      nativeBeforeInstallPrompt: "not intercepted",
      customInstallEntry: false,
      offlineFallback: true,
      offlineIconPainted: true,
      reconnect: true,
    }),
  );
} finally {
  if (onlineApiRouteInstalled)
    await page
      .unroute(onlineApiUrl, onlineApiRouteHandler)
      .catch(() => undefined);
  await setOffline(false).catch(() => undefined);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  if (workerSessionId) {
    await browserSession
      .send("Target.detachFromTarget", { sessionId: workerSessionId })
      .catch(() => undefined);
  }
  await pageSession.detach().catch(() => undefined);
  await browserSession.detach().catch(() => undefined);
  await browser.close();
}
