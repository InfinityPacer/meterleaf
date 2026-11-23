import { readFile } from "node:fs/promises";
import { ZodError } from "zod";
import { defaultPriceBook } from "../domain/default-prices";
import {
  applyModelAliases,
  modelAliasesFileSchema,
  priceBookSchema,
  type PriceBook,
} from "../domain/pricing";

/** 自定义价格文件整体替换内置表，不做隐式合并；可选模型别名文件叠加在当前价格表之上。 */
export async function loadPriceBook(
  path?: string,
  aliasesPath?: string,
): Promise<PriceBook> {
  let book: PriceBook;
  if (!path) {
    book = defaultPriceBook;
  } else {
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
    book = result.data;
  }
  if (!aliasesPath) return book;
  let aliasInput: unknown;
  try {
    aliasInput = JSON.parse(await readFile(aliasesPath, "utf8"));
  } catch {
    throw new Error("Cannot read or parse METERLEAF_MODEL_ALIASES JSON");
  }
  const aliasResult = modelAliasesFileSchema.safeParse(aliasInput);
  if (!aliasResult.success)
    throw new Error(
      `Invalid model aliases fields: ${aliasResult.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  try {
    return applyModelAliases(book, aliasResult.data);
  } catch (error) {
    if (error instanceof ZodError)
      throw new Error(
        `Invalid model aliases: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    throw error;
  }
}
