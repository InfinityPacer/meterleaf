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
  expect(worker).toContain("/icons/meterleaf-leaf-180.png");
  expect(worker).toContain("/icons/meterleaf-leaf-192.png");
  expect(worker).toContain("/icons/meterleaf-leaf-512.png");
  expect(worker).toContain("/icons/meterleaf-192.png");
  expect(worker).toContain("/icons/meterleaf-512.png");
  expect(worker).toContain('const CACHE_NAME = "meterleaf-offline-v3"');
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
  expect(offline).not.toContain("<script");
});

test("HTML exposes the manifest and Apple touch icon for native browser install", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  const normalizedHtml = html.replace(/\s+/g, " ");
  expect(normalizedHtml).toContain(
    'rel="manifest" href="/manifest.webmanifest"',
  );
  expect(normalizedHtml).toContain(
    'name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"',
  );
  expect(normalizedHtml).toContain(
    'rel="apple-touch-icon" sizes="180x180" href="/icons/meterleaf-leaf-180.png"',
  );
});

test("PWA module only exposes production service-worker registration", async () => {
  const pwa = await import("../src/web/pwa");
  expect(Object.keys(pwa)).toEqual(["registerPwa"]);
  expect(await registerPwa()).toBeNull();
});
