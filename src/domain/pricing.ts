import Decimal from "decimal.js";
import { z } from "zod";
import type { UsageFact } from "./connector";

const rate = z.string().regex(/^\d+(\.\d+)?$/);
const rates = z
  .object({
    input: rate.nullable(),
    cacheRead: rate.nullable(),
    cacheWrite: rate.nullable(),
    /** 1 小时 TTL 写入的独立费率；配置后 cacheWrite 只对应其余写入（5 分钟）。 */
    cacheWrite1h: rate.nullable().optional(),
    output: rate.nullable(),
  })
  .strict();
/** 费率均按百万 token；显式版本与证据跟随账单保存，不能静默追随网关定价。 */
export const priceBookSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    /** 本价格表接替的旧标识。改名不是换一套价格，旧结果可作为过渡结果继续显示。 */
    supersedes: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).optional(),
    version: z.string().min(1),
    unit: z.literal("per_million_tokens"),
    publishedAt: z.iso.datetime({ offset: true }),
    sources: z.array(z.string()).min(1),
    notes: z.array(z.string()).optional(),
    rules: z.array(
      z
        .object({
          model: z.string().min(1),
          tier: z.enum(["standard", "priority", "flex"]),
          currency: z.enum(["usd", "credits"]),
          usdBasis: z.enum(["subscription", "api"]).optional(),
          promotion: z
            .object({ description: z.string(), confirmedThrough: z.iso.date() })
            .strict()
            .optional(),
          effectiveFrom: z.iso.datetime({ offset: true }),
          effectiveUntil: z.iso.datetime({ offset: true }).optional(),
          rates,
          // 图像分桶是总 Tokens 的子集，按独立费率替代对应文本费用。
          imageRates: rates
            .pick({ input: true, cacheRead: true, output: true })
            .optional(),
          longContext: z
            .object({ threshold: z.number().int().nonnegative(), rates })
            .strict()
            .optional(),
        })
        .strict()
        .refine(
          (rule) =>
            rule.currency === "usd"
              ? rule.usdBasis !== undefined
              : rule.usdBasis === undefined,
          "USD rules require an estimate basis; credits rules must not have one",
        ),
    ),
  })
  .strict()
  .superRefine((book, context) => {
    for (let index = 0; index < book.rules.length; index++) {
      const rule = book.rules[index]!;
      const end = rule.effectiveUntil
        ? Date.parse(rule.effectiveUntil)
        : Infinity;
      if (end <= Date.parse(rule.effectiveFrom))
        context.addIssue({
          code: "custom",
          path: ["rules", index, "effectiveUntil"],
          message: "Rate period must end after it starts",
        });
      for (let otherIndex = 0; otherIndex < index; otherIndex++) {
        const other = book.rules[otherIndex]!;
        if (
          rule.model !== other.model ||
          rule.currency !== other.currency ||
          rule.tier !== other.tier ||
          rule.usdBasis !== other.usdBasis
        )
          continue;
        const otherEnd = other.effectiveUntil
          ? Date.parse(other.effectiveUntil)
          : Infinity;
        if (
          Date.parse(rule.effectiveFrom) < otherEnd &&
          Date.parse(other.effectiveFrom) < end
        )
          context.addIssue({
            code: "custom",
            path: ["rules", index],
            message: "Overlapping rate periods within the same pricing branch",
          });
      }
    }
  });
export type PriceBook = z.infer<typeof priceBookSchema>;
/** 文件版本只在同一价格表身份内唯一，存储与账单使用完整版本键。 */
export function priceBookKey(book: PriceBook) {
  return `${book.id}@${book.version}`;
}
export type UsdBasis = "subscription" | "api";

/** null 是不可估值，不是免费；两种计量单位可独立有价或缺价。 */
export interface Charge {
  amount: string | null;
  basis: "upstream" | "estimated" | "unpriced";
  reason: string | null;
  assumedStandard: boolean;
}
export interface Valuation {
  version: string;
  usdBasis: UsdBasis;
  /** 当前展示口径及两个分支同时保存，切换展示不需要重采源用量。 */
  usd: Charge;
  apiUsd: Charge;
  subscriptionUsd: Charge;
  credits: Charge;
}

/** 先使用可证实的上游计量金额，否则逐币种查询独立费率；网关扣款从不充当上游金额。 */
export function valueUsage(
  fact: UsageFact,
  book: PriceBook,
  usdBasis: UsdBasis = "subscription",
): Valuation {
  const assumedStandard = fact.tier === null;
  const tier =
    fact.tier === null || fact.tier === "default" || fact.tier === "auto"
      ? "standard"
      : fact.tier === "fast"
        ? "priority"
        : fact.tier;
  const unpriced = (reason: string): Charge => ({
    amount: null,
    basis: "unpriced",
    reason,
    assumedStandard,
  });
  const calculate = (currency: "usd" | "credits", basis?: UsdBasis): Charge => {
    const upstream =
      currency === "usd" ? fact.upstreamUsd : fact.upstreamCredits;
    if (
      upstream !== null &&
      /^\d+(\.\d+)?$/.test(upstream) &&
      (currency === "credits" || fact.upstreamUsdBasis === basis)
    )
      return {
        amount: new Decimal(upstream).toString(),
        basis: "upstream",
        reason: null,
        assumedStandard: false,
      };
    const buckets = [
      fact.tokens.input,
      fact.tokens.cacheRead,
      fact.tokens.cacheWrite,
      fact.tokens.output,
    ];
    if (
      buckets.some(
        (value) => value === null || !Number.isSafeInteger(value) || value < 0,
      )
    )
      return unpriced("missing-or-invalid-token-bucket");
    const matches = book.rules.filter(
      (rule) =>
        rule.model === fact.model &&
        rule.tier === tier &&
        rule.currency === currency &&
        (currency === "credits" || rule.usdBasis === basis) &&
        Date.parse(rule.effectiveFrom) <= Date.parse(fact.occurredAt) &&
        (!rule.effectiveUntil ||
          Date.parse(fact.occurredAt) < Date.parse(rule.effectiveUntil)),
    );
    if (matches.length !== 1)
      return unpriced(matches.length ? "ambiguous-rate" : "missing-rate");
    const rule = matches[0]!;
    const totalInput =
      fact.tokens.input! + fact.tokens.cacheRead! + fact.tokens.cacheWrite!;
    const prices =
      rule.longContext && totalInput > rule.longContext.threshold
        ? rule.longContext.rates
        : rule.rates;
    const keys = ["input", "cacheRead", "cacheWrite", "output"] as const;
    const counts = Object.fromEntries(
      keys.map((key) => [key, fact.tokens[key]!]),
    ) as Record<(typeof keys)[number], number>;
    const imageCharges: { count: number; rate: string | null }[] = [];
    if (rule.imageRates) {
      const image = fact.tokens.image;
      const validCount = (value: number | null | undefined): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      if (!validCount(image?.input) || !validCount(image?.output))
        return unpriced("missing-or-invalid-image-token-bucket");
      // 来源统一计缓存时，图像只从非缓存输入分配并封顶；保留原始计量，不推断缓存模态。
      const aggregateCache = image.cacheReadMode === "aggregate";
      const cachedImage = aggregateCache
        ? 0
        : (image.cacheRead ??
          (counts.cacheRead === 0 || image.input === 0 ? 0 : null));
      if (!validCount(cachedImage))
        return unpriced("missing-image-cache-split");
      const ordinaryImage = aggregateCache
        ? Math.min(image.input, counts.input)
        : image.input - cachedImage;
      if (
        cachedImage > image.input ||
        cachedImage > counts.cacheRead ||
        ordinaryImage > counts.input ||
        image.output > counts.output
      )
        return unpriced("invalid-image-token-subset");
      counts.input -= ordinaryImage;
      counts.cacheRead -= cachedImage;
      counts.output -= image.output;
      imageCharges.push(
        { count: ordinaryImage, rate: rule.imageRates.input },
        { count: cachedImage, rate: rule.imageRates.cacheRead },
        { count: image.output, rate: rule.imageRates.output },
      );
    }
    // 1 小时写入是 cacheWrite 的子集；有独立费率时拆出，缺拆分或缺费率都不能按 5 分钟价凑数。
    const cacheWrite1h = fact.tokens.cacheWrite1h;
    const ttlCharges: { count: number; rate: string | null }[] = [];
    if (prices.cacheWrite1h !== undefined && counts.cacheWrite > 0) {
      if (
        cacheWrite1h === null ||
        !Number.isSafeInteger(cacheWrite1h) ||
        cacheWrite1h < 0
      )
        return unpriced("missing-cache-ttl-split");
      if (cacheWrite1h > counts.cacheWrite)
        return unpriced("invalid-cache-ttl-subset");
      counts.cacheWrite -= cacheWrite1h;
      ttlCharges.push({ count: cacheWrite1h, rate: prices.cacheWrite1h });
    } else if (
      prices.cacheWrite1h === undefined &&
      cacheWrite1h !== null &&
      cacheWrite1h > 0
    )
      return unpriced("unsupported-rate-bucket");
    const charges = [
      ...keys.map((key) => ({ count: counts[key], rate: prices[key] })),
      ...ttlCharges,
      ...imageCharges,
    ];
    if (charges.some(({ count, rate }) => count > 0 && rate === null))
      return unpriced("unsupported-rate-bucket");
    const amount = charges
      .reduce(
        (total, charge) =>
          total.add(new Decimal(charge.count).mul(charge.rate ?? "0")),
        new Decimal(0),
      )
      .div(1_000_000)
      .toString();
    return {
      amount,
      basis: "estimated",
      reason:
        Date.parse(fact.occurredAt) < Date.parse(book.publishedAt)
          ? "current-rate-applied-to-history"
          : assumedStandard
            ? "tier-not-declared"
            : null,
      assumedStandard,
    };
  };
  const apiUsd = calculate("usd", "api");
  const subscriptionUsd = calculate("usd", "subscription");
  return {
    version: priceBookKey(book),
    usdBasis,
    usd: usdBasis === "api" ? apiUsd : subscriptionUsd,
    apiUsd,
    subscriptionUsd,
    credits: calculate("credits"),
  };
}
