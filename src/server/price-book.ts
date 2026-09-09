import { readFile } from "node:fs/promises";
import { defaultPriceBook } from "../domain/default-prices";
import { priceBookSchema, type PriceBook } from "../domain/pricing";

/** 自定义价格文件整体替换内置表，不做隐式合并，避免同一模型重复命中两条价格规则。 */
export async function loadPriceBook(path?: string): Promise<PriceBook> {
  if (!path) return defaultPriceBook;
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Cannot read or parse METERLEAF_PRICE_BOOK JSON");
  }
  const result = priceBookSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid price book fields: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}
