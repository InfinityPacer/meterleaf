import { resolve } from "node:path";
import prettier from "prettier";
import { buildPriceBook } from "../prices/catalog";

const targetPath = resolve(import.meta.dir, "../prices/meterleaf.json");
const checkOnly = process.argv.includes("--check");

const book = buildPriceBook();
const config = (await prettier.resolveConfig(targetPath)) ?? {};
const formatted = await prettier.format(JSON.stringify(book, null, 2), {
  ...config,
  parser: "json",
});

if (checkOnly) {
  const existing = await Bun.file(targetPath)
    .text()
    .catch(() => "");
  if (existing !== formatted) {
    console.error(
      "prices/meterleaf.json is out of sync with prices/catalog.ts. Run `bun run prices:build`.",
    );
    process.exit(1);
  }
  console.log(
    `OK: prices/meterleaf.json matches prices/catalog.ts (${book.id}@${book.version}, ${book.rules.length} rules).`,
  );
} else {
  await Bun.write(targetPath, formatted);
  console.log(
    `Wrote prices/meterleaf.json (${book.id}@${book.version}, ${book.rules.length} rules).`,
  );
}
