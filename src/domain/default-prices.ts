import bundledPriceBook from "../../prices/openai-2026-09-09.json";
import { priceBookSchema } from "./pricing";

/** 内置与自定义价格表通过相同 schema；版本信息只来自数据文件，不在代码里推导费率。 */
export const defaultPriceBook = priceBookSchema.parse(bundledPriceBook);
