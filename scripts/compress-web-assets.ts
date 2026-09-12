import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const webRoot = join(import.meta.dir, "..", "dist", "web");
const compressible = /\.(?:css|html|js|json|svg|webmanifest)$/;

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
