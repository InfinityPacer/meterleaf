import { createHash } from "node:crypto";
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
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const minutesOfDay = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours! * 60 + minutes!;
};
/** 供应商按 UTC 星期与时段的显式价格；时段起点包含、终点不包含，跨日需拆成两段。 */
const peak = z
  .object({
    /** ISO 星期编号，周一为 1，周日为 7。 */
    days: z.array(z.number().int().min(1).max(7)).min(1),
    hoursUtc: z
      .array(z.object({ from: timeOfDay, until: timeOfDay }).strict())
      .min(1),
    rates,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.days).size !== value.days.length)
      context.addIssue({
        code: "custom",
        path: ["days"],
        message: "Peak weekdays must be unique",
      });
    value.hoursUtc.forEach((window, index) => {
      if (minutesOfDay(window.from) >= minutesOfDay(window.until))
        context.addIssue({
          code: "custom",
          path: ["hoursUtc", index],
          message: "Peak window must end after it starts",
        });
    });
  });
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
    /** 显式模型别名表，只做单跳精确映射到已有费率规则的模型，不覆盖已有规则。 */
    modelAliases: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** 不参与路由前缀末段兜底的前缀列表（按 `/` 分段匹配，忽略大小写）。 */
    excludeRoutePrefixes: z.array(z.string().min(1)).optional(),
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
          /** 完整替代基础费率的时段价；供应商公布显式价格时直接配置，不做倍率推导。 */
          peak: peak.optional(),
        })
        .strict()
        .refine(
          (rule) =>
            rule.currency === "usd"
              ? rule.usdBasis !== undefined
              : rule.usdBasis === undefined,
          "USD rules require an estimate basis; credits rules must not have one",
        )
        .refine(
          (rule) => !(rule.peak && (rule.longContext || rule.imageRates)),
          "Peak hours cannot be combined with long-context or image rates",
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
    if (book.modelAliases) {
      const ruleModels = new Set(book.rules.map((rule) => rule.model));
      for (const [alias, target] of Object.entries(book.modelAliases)) {
        if (alias === target) {
          context.addIssue({
            code: "custom",
            path: ["modelAliases", alias],
            message: "Model alias cannot point to itself",
          });
          continue;
        }
        if (ruleModels.has(alias)) {
          context.addIssue({
            code: "custom",
            path: ["modelAliases", alias],
            message: "Model alias cannot shadow an existing priced model",
          });
          continue;
        }
        if (!ruleModels.has(target)) {
          context.addIssue({
            code: "custom",
            path: ["modelAliases", alias],
            message: "Model alias target must match a priced model in rules",
          });
        }
      }
    }
    if (book.excludeRoutePrefixes) {
      book.excludeRoutePrefixes.forEach((prefix, index) => {
        if (!normalizeRoutePrefix(prefix)) {
          context.addIssue({
            code: "custom",
            path: ["excludeRoutePrefixes", index],
            message: "Route prefix must contain a non-empty path segment",
          });
        }
      });
    }
  });
export type PriceBook = z.infer<typeof priceBookSchema>;

const routePrefixSchema = z
  .string()
  .min(1)
  .refine(
    (value) => normalizeRoutePrefix(value) !== null,
    "Route prefix must contain a non-empty path segment",
  );

export const modelAliasesFileSchema = z
  .object({
    aliases: z.record(z.string().min(1), z.string().min(1)).optional(),
    excludePrefixes: z.array(routePrefixSchema).optional(),
    notes: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ModelAliasesFile = z.infer<typeof modelAliasesFileSchema>;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 路由排除前缀统一转为小写并以单个 `/` 结尾，按段边界忽略大小写匹配。 */
function normalizeRoutePrefix(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return `${trimmed.toLowerCase()}/`;
}

function normalizeRoutePrefixes(
  prefixes: readonly string[] | undefined,
): string[] {
  if (!prefixes || prefixes.length === 0) return [];
  const unique = new Set<string>();
  for (const raw of prefixes) {
    const normalized = normalizeRoutePrefix(raw);
    if (normalized) unique.add(normalized);
  }
  return [...unique].sort(compareCodeUnits);
}

/** 把本机私有别名表叠加到当前价格表，并将规范化内容摘要并入版本键以触发自动重估。 */
export function applyModelAliases(
  book: PriceBook,
  overlay: ModelAliasesFile,
): PriceBook {
  if (book.version.includes("@"))
    throw new Error("Base price book version must not contain '@'");
  const sortedOverlayEntries = Object.entries(overlay.aliases ?? {}).sort(
    ([a], [b]) => compareCodeUnits(a, b),
  );
  const overlayExcludes = normalizeRoutePrefixes(overlay.excludePrefixes);
  const overlayNotes = overlay.notes ?? [];
  if (
    sortedOverlayEntries.length === 0 &&
    overlayExcludes.length === 0 &&
    overlayNotes.length === 0
  )
    return book;
  // 按已排序的 [key, target] 数组序列化，避免普通对象枚举重排纯数字字符串键。
  const canonicalOverlay = {
    aliases: sortedOverlayEntries,
    ...(overlayExcludes.length > 0 ? { excludePrefixes: overlayExcludes } : {}),
    notes: overlayNotes,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalOverlay))
    .digest("hex")
    .slice(0, 16);
  const mergedEntries = Object.entries({
    ...(book.modelAliases ?? {}),
    ...Object.fromEntries(sortedOverlayEntries),
  }).sort(([a], [b]) => compareCodeUnits(a, b));
  const mergedExcludes = normalizeRoutePrefixes([
    ...(book.excludeRoutePrefixes ?? []),
    ...overlayExcludes,
  ]);
  const mergedNotes = [...(book.notes ?? []), ...overlayNotes];
  return priceBookSchema.parse({
    ...book,
    version: `${book.version}+aliases-${digest}`,
    ...(mergedEntries.length > 0
      ? { modelAliases: Object.fromEntries(mergedEntries) }
      : {}),
    ...(mergedExcludes.length > 0
      ? { excludeRoutePrefixes: mergedExcludes }
      : {}),
    ...(mergedNotes.length > 0 ? { notes: mergedNotes } : {}),
  });
}
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
  /** 经显式别名或路由前缀解析后实际命中的计价模型；与原始模型相同时省略。 */
  pricingModel?: string;
  /** 当前展示口径及两个分支同时保存，切换展示不需要重采源用量。 */
  usd: Charge;
  apiUsd: Charge;
  subscriptionUsd: Charge;
  credits: Charge;
}

const ruleModelIndex = new WeakMap<PriceBook, Set<string>>();
const excludePrefixIndex = new WeakMap<PriceBook, readonly string[]>();

function getRuleModels(book: PriceBook): Set<string> {
  let models = ruleModelIndex.get(book);
  if (!models) {
    models = new Set(book.rules.map((rule) => rule.model));
    ruleModelIndex.set(book, models);
  }
  return models;
}

function getExcludePrefixes(book: PriceBook): readonly string[] {
  let prefixes = excludePrefixIndex.get(book);
  if (!prefixes) {
    prefixes = normalizeRoutePrefixes(book.excludeRoutePrefixes);
    excludePrefixIndex.set(book, prefixes);
  }
  return prefixes;
}

/**
 * 解析计价模型：1) 原始模型名精确匹配；2) 显式别名表精确匹配；3) 未命中排除前缀且含 `/` 时
 * 剥离路由前缀取末段精确匹配。三步均不做模糊或链式推导；原名已存在规则时不回退到末段，
 * 命中 `excludeRoutePrefixes` 的私有分组只能通过显式别名映射，不自动套用末段公开费率。
 */
function resolvePricingModel(
  model: string,
  book: PriceBook,
): { pricingModel: string; hasRules: boolean } {
  const models = getRuleModels(book);
  if (models.has(model)) return { pricingModel: model, hasRules: true };
  const aliased = book.modelAliases?.[model];
  if (aliased && models.has(aliased))
    return { pricingModel: aliased, hasRules: true };
  const excluded = getExcludePrefixes(book);
  const lower = excluded.length > 0 ? model.toLowerCase() : "";
  if (!excluded.some((prefix) => lower.startsWith(prefix))) {
    const slash = model.lastIndexOf("/");
    if (slash >= 0 && slash < model.length - 1) {
      const suffix = model.slice(slash + 1);
      if (models.has(suffix)) return { pricingModel: suffix, hasRules: true };
    }
  }
  return { pricingModel: model, hasRules: false };
}

/** 时段价按 occurredAt 的 UTC 星期和分钟判定，不受运行环境时区影响。 */
function withinPeak(
  schedule: NonNullable<PriceBook["rules"][number]["peak"]>,
  occurredAt: string,
) {
  const at = new Date(occurredAt);
  const weekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  return (
    schedule.days.includes(weekday) &&
    schedule.hoursUtc.some(
      (window) =>
        minutesOfDay(window.from) <= minute &&
        minute < minutesOfDay(window.until),
    )
  );
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
  const resolved = resolvePricingModel(fact.model, book);
  const pricingModel = resolved.pricingModel;
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
        rule.model === pricingModel &&
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
      rule.peak && withinPeak(rule.peak, fact.occurredAt)
        ? rule.peak.rates
        : rule.longContext && totalInput > rule.longContext.threshold
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
    // 1 小时写入是 cacheWrite 的子集；有独立费率时拆出，缺费率时不能按 5 分钟价凑数。
    // 记录没有 TTL 拆分时整笔按 1 小时计：Claude Code 默认写 1 小时缓存，且这是较高的一档，
    // 不会低估费用。
    // 已知的 5 分钟部分保留原价，只有未拆分的余量按 1 小时计。
    const cacheWrite1h =
      fact.tokens.cacheWrite1h ??
      (prices.cacheWrite1h !== undefined
        ? counts.cacheWrite - (fact.tokens.cacheWrite5m ?? 0)
        : null);
    const ttlCharges: { count: number; rate: string | null }[] = [];
    if (prices.cacheWrite1h !== undefined && counts.cacheWrite > 0) {
      if (
        cacheWrite1h === null ||
        !Number.isSafeInteger(cacheWrite1h) ||
        cacheWrite1h < 0
      )
        return unpriced("invalid-cache-ttl-subset");
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
    ...(resolved.hasRules && pricingModel !== fact.model
      ? { pricingModel }
      : {}),
    usd: usdBasis === "api" ? apiUsd : subscriptionUsd,
    apiUsd,
    subscriptionUsd,
    credits: calculate("credits"),
  };
}
