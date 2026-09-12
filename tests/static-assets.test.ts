import { brotliCompressSync, brotliDecompressSync, gzipSync } from "node:zlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createApp } from "../src/server/app";

test("static shell serves pre-compressed hashed assets with safe cache headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "meterleaf-static-"));
  const assets = join(root, "assets");
  const source = Buffer.from("console.log('meterleaf');\n");
  await mkdir(assets);
  await writeFile(
    join(root, "index.html"),
    '<div id="root"><div class="boot-shell">正在连接 Meterleaf…</div></div>',
  );
  await writeFile(join(assets, "index-Abcd1234.js"), source);
  await writeFile(
    join(assets, "index-Abcd1234.js.br"),
    brotliCompressSync(source),
  );
  await writeFile(join(assets, "index-Abcd1234.js.gz"), gzipSync(source));

  const app = createApp({
    webRoot: root,
    snapshot: () => ({
      mode: "live",
      asOf: new Date().toISOString(),
      records: [],
      accounts: [],
      resets: [],
    }),
  });
  try {
    await app.ready();
    const shell = await app.inject("/");
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["cache-control"]).toBe("no-cache");
    expect(shell.body).toContain("boot-shell");

    const brotli = await app.inject({
      method: "GET",
      url: "/assets/index-Abcd1234.js",
      headers: { "accept-encoding": "br" },
    });
    expect(brotli.statusCode).toBe(200);
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(brotliDecompressSync(brotli.rawPayload)).toEqual(source);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
