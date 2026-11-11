import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const webRoot = join(import.meta.dir, "..", "dist", "web");
const compressible = /\.(?:css|html|js|json|svg|webmanifest)$/;
const shellAsset = /\.(?:css|js|woff2)$/;
async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile() && compressible.test(entry.name)) files.push(path);
  }
  return files;
}

async function injectServiceWorkerShellManifest() {
  const assetsDir = join(webRoot, "assets");
  const assetFiles = (await filesInAll(assetsDir))
    .filter((path) => shellAsset.test(path))
    .map((path) => `/${relative(webRoot, path).replaceAll("\\", "/")}`)
    .sort();
  const indexHtml = await readFile(join(webRoot, "index.html"), "utf8");
  const revision = createHash("sha256")
    .update(indexHtml)
    .update("\n")
    .update(assetFiles.join("\n"))
    .digest("hex")
    .slice(0, 12);
  const swPath = join(webRoot, "sw.js");
  const swSource = await readFile(swPath, "utf8");
  const cacheReplaced = swSource.replace(
    'const SHELL_CACHE_NAME = "meterleaf-shell-dev";',
    `const SHELL_CACHE_NAME = "meterleaf-shell-${revision}";`,
  );
  if (cacheReplaced === swSource) {
    throw new Error("Failed to inject SHELL_CACHE_NAME into dist/web/sw.js");
  }
  const manifestReplaced = cacheReplaced.replace(
    "const SHELL_ASSETS = [];",
    `const SHELL_ASSETS = ${JSON.stringify(assetFiles)};`,
  );
  if (manifestReplaced === cacheReplaced) {
    throw new Error("Failed to inject SHELL_ASSETS into dist/web/sw.js");
  }
  await writeFile(swPath, manifestReplaced);
}

async function filesInAll(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesInAll(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

await injectServiceWorkerShellManifest();

const files = await filesIn(webRoot);
let generated = 0;
for (const path of files) {
  const source = await readFile(path);
  await Promise.all([
    writeFile(`${path}.gz`, gzipSync(source, { level: 9 })),
    writeFile(
      `${path}.br`,
      brotliCompressSync(source, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 5,
        },
      }),
    ),
  ]);
  generated += 2;
}

const totalBytes = await Promise.all(
  files.map(async (path) => (await stat(path)).size),
).then((sizes) => sizes.reduce((total, size) => total + size, 0));
console.log(
  `compressed ${files.length} web assets (${totalBytes} source bytes, ${generated} variants)`,
);
