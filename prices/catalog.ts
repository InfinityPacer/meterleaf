import Decimal from "decimal.js";
import { priceBookSchema, type PriceBook } from "../src/domain/pricing";

type PriceRule = PriceBook["rules"][number];
type RateSet = PriceRule["rates"];

const EPOCH = "1970-01-01T00:00:00Z";
const USD_BASES = ["subscription", "api"] as const;

function mul(value: string | null | undefined, factor: string) {
  if (value === null || value === undefined) return value;
  return new Decimal(value).mul(factor).toString();
}

function scaleRates(
  rates: RateSet,
  factor: string,
  outputFactor = factor,
): RateSet {
  return {
    input: mul(rates.input, factor)!,
    cacheRead: mul(rates.cacheRead, factor) ?? null,
    cacheWrite: mul(rates.cacheWrite, factor) ?? null,
    ...(rates.cacheWrite1h !== undefined
      ? { cacheWrite1h: mul(rates.cacheWrite1h, factor) ?? null }
      : {}),
    output: mul(rates.output, outputFactor) ?? null,
  };
}

interface OpenAiTieredOptions {
  apiLongContext?: number;
  promotion?: { description: string; confirmedThrough: string };
}

/** OpenAI 旗舰与编码模型：展开 Standard / Priority (2x) / Flex (0.5x)、1.25x 缓存写入及 API 长上下文档。 */
function openaiTiered(
  model: string,
  base: { input: string; cacheRead: string; output: string },
  options: OpenAiTieredOptions = {},
): PriceRule[] {
  const fullBase: RateSet = {
    input: base.input,
    cacheRead: base.cacheRead,
    cacheWrite: mul(base.input, "1.25")!,
    output: base.output,
  };
  const tiers: Array<[PriceRule["tier"], string]> = [
    ["standard", "1"],
    ["priority", "2"],
    ["flex", "0.5"],
  ];
  return tiers.flatMap(([tier, factor]) => {
    const rates = scaleRates(fullBase, factor);
    return USD_BASES.map((usdBasis): PriceRule => ({
      model,
      effectiveFrom: EPOCH,
      currency: "usd",
      usdBasis,
      tier,
      rates,
      ...(usdBasis === "api" && options.apiLongContext
        ? {
            longContext: {
              threshold: options.apiLongContext,
              rates: scaleRates(rates, "2", "1.5"),
            },
          }
        : {}),
      ...(options.promotion ? { promotion: options.promotion } : {}),
    }));
  });
}

/** OpenAI 仅标准档模型（如 GPT-5.4、GPT-5.4-mini 与图像模型）。 */
function openaiStandard(
  models: readonly string[],
  rates: RateSet,
  options: {
    apiLongContext?: number;
    imageRates?: PriceRule["imageRates"];
  } = {},
): PriceRule[] {
  return models.flatMap((model) =>
    USD_BASES.map((usdBasis): PriceRule => ({
      model,
      effectiveFrom: EPOCH,
      currency: "usd",
      usdBasis,
      tier: "standard",
      rates,
      ...(options.imageRates ? { imageRates: options.imageRates } : {}),
      ...(usdBasis === "api" && options.apiLongContext
        ? {
            longContext: {
              threshold: options.apiLongContext,
              rates: scaleRates(rates, "2", "1.5"),
            },
          }
        : {}),
    })),
  );
}

/**
 * Anthropic Claude 模型：5m 缓存写入固定为输入价 1.25x，1h 写入固定为 2x，输出固定为 5x；
 * 缓存读取按模型代际为 0.1x、0.05x 或 0.025x；Fast 模式（priority）整体翻倍并叠加缓存倍率。
 */
function claude(
  models: string | readonly string[],
  input: string,
  options: {
    cacheReadFactor?: "0.1" | "0.05" | "0.025";
    fast?: boolean;
    apiLongContext?: { threshold: number; multiplier: string };
  } = {},
): PriceRule[] {
  const list = typeof models === "string" ? [models] : models;
  const base: RateSet = {
    input,
    cacheRead: mul(input, options.cacheReadFactor ?? "0.1")!,
    cacheWrite: mul(input, "1.25")!,
    cacheWrite1h: mul(input, "2")!,
    output: mul(input, "5")!,
  };
  const tiers: Array<[PriceRule["tier"], string]> = options.fast
    ? [
        ["standard", "1"],
        ["priority", "2"],
      ]
    : [["standard", "1"]];
  return list.flatMap((model) =>
    tiers.flatMap(([tier, factor]) => {
      const rates = scaleRates(base, factor);
      return USD_BASES.map((usdBasis): PriceRule => ({
        model,
        effectiveFrom: EPOCH,
        currency: "usd",
        usdBasis,
        tier,
        rates,
        ...(usdBasis === "api" && options.apiLongContext
          ? {
              longContext: {
                threshold: options.apiLongContext.threshold,
                rates: scaleRates(rates, options.apiLongContext.multiplier),
              },
            }
          : {}),
      }));
    }),
  );
}

interface GeminiWindow {
  from: string;
  until?: string;
  rates: Pick<RateSet, "input" | "cacheRead" | "output">;
  promotion?: { description: string; confirmedThrough: string };
}

/** Google Gemini 模型：支持标准档、可选 Flex 半价档，以及促销期/恢复期时间窗分段。 */
function gemini(
  model: string,
  config: {
    input: string;
    cacheRead: string;
    output: string;
    flex?: boolean;
    promo?: {
      until: string;
      confirmedThrough: string;
      description: string;
      input: string;
      cacheRead: string;
      output: string;
    };
  },
): PriceRule[] {
  const windows: GeminiWindow[] = config.promo
    ? [
        {
          from: EPOCH,
          until: config.promo.until,
          rates: {
            input: config.promo.input,
            cacheRead: config.promo.cacheRead,
            output: config.promo.output,
          },
          promotion: {
            description: config.promo.description,
            confirmedThrough: config.promo.confirmedThrough,
          },
        },
        {
          from: config.promo.until,
          rates: {
            input: config.input,
            cacheRead: config.cacheRead,
            output: config.output,
          },
        },
      ]
    : [
        {
          from: EPOCH,
          rates: {
            input: config.input,
            cacheRead: config.cacheRead,
            output: config.output,
          },
        },
      ];
  const tiers: Array<[PriceRule["tier"], string]> = config.flex
    ? [
        ["standard", "1"],
        ["flex", "0.5"],
      ]
    : [["standard", "1"]];
  return windows.flatMap((win) =>
    tiers.flatMap(([tier, factor]) => {
      const rates = scaleRates({ ...win.rates, cacheWrite: null }, factor);
      return USD_BASES.map((usdBasis): PriceRule => ({
        model,
        effectiveFrom: win.from,
        ...(win.until ? { effectiveUntil: win.until } : {}),
        currency: "usd",
        usdBasis,
        tier,
        rates,
        ...(win.promotion ? { promotion: win.promotion } : {}),
      }));
    }),
  );
}

/** 单一标准档 USD 规则（如 OpenCode Go 与 Model Garden 合作模型）。 */
function flatUsd(
  model: string,
  rates: RateSet,
  peak?: PriceRule["peak"],
): PriceRule[] {
  return USD_BASES.map((usdBasis): PriceRule => ({
    model,
    effectiveFrom: EPOCH,
    currency: "usd",
    usdBasis,
    tier: "standard",
    rates,
    ...(peak ? { peak } : {}),
  }));
}

const IMAGE_RATES = { input: "8", cacheRead: "2", output: "30" } as const;

export function buildPriceBook(): PriceBook {
  return priceBookSchema.parse({
    schemaVersion: 1,
    id: "meterleaf",
    supersedes: ["meterleaf-openai"],
    version: "2026-11-13.1",
    publishedAt: "2026-11-13T00:00:00Z",
    unit: "per_million_tokens",
    sources: [
      "https://developers.openai.com/api/docs/pricing",
      "https://developers.openai.com/api/docs/models/codex-auto-review",
      "https://developers.openai.com/api/docs/models/gpt-image-2",
      "https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst",
      "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare",
      "https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst",
      "https://developers.openai.com/api/docs/models/gpt-image-2.6-flare",
      "https://platform.claude.com/docs/en/about-claude/pricing",
      "https://platform.claude.com/docs/en/about-claude/models/overview",
      "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
      "https://platform.claude.com/docs/en/build-with-claude/fast-mode",
      "https://opencode.ai/docs/go/",
      "https://ai.google.dev/gemini-api/docs/pricing",
      "https://cloud.google.com/vertex-ai/generative-ai/pricing",
      "https://cloud.google.com/model-garden/partner-models/pricing",
    ],
    notes: [
      "Generated from prices/catalog.ts via bun run prices:build. Rates are USD per 1M tokens.",
      "Two USD bases are stored per model: subscription-equivalent USD omits API long-context uplifts (>272K on OpenAI models and >100K on Claude Haiku 5.5), while standard API USD applies them.",
      "Codex subscription Credits have been retired from the built-in price book; historical databases retaining stored credits rules remain schema-compatible.",
      "GPT-5.6-Sol promotion is confirmed through 2026-11-30 on the OpenAI API. No unannounced post-promotion price is assumed.",
      "Codex auto-review has no separate row on the OpenAI API pricing table; its official model page documents it as fine-tuned from gpt-6-luna, so codex-auto-review uses gpt-6-luna USD rates.",
      "Only documented image model IDs and snapshots are included; generic gpt-image-2.5 and gpt-image-2.6 are not inferred as variant aliases.",
      "Claude fast mode maps to the priority tier for Fable 5.2, Opus 5.5, Opus 5 and Opus 4.8 with 2x rates and stacked cache multipliers. US-only inference (1.1x) and web search fees are not applied.",
      "OpenCode Go DeepSeek V4.1 Flash uses Go's published Beijing weekday peak (09:00-18:00, UTC+8) and off-peak rates. GLM-5.3 and GLM-5.3-Flash match Go and Zhipu published rates with no cache-write rate.",
      "Gemini 4 Hydrogen ($1.50/$0.075/$7.50 Standard, $0.75/$0.0375/$3.75 Flex) and Gemini 3.5 Flash-Lite ($0.30/$0.03/$2.50 Standard) use permanent list rates; Gemini 3.5 Flash-Lite Flex is omitted due to upstream cached-input rounding differences ($0.02 vs $0.015). Promotional pricing applies through 2026-11-30 for Gemini 4 Carbon and Argon and through 2026-12-31 for Gemini 3.8 Flash.",
      "GPT-OSS 120B uses Google Cloud Vertex AI Model Garden partner pricing ($0.09 input, $0.36 output) with null cache read/write rates.",
    ],
    rules: [
      // OpenAI 旗舰与编码系列
      ...openaiStandard(
        ["gpt-5.4"],
        { input: "2.5", cacheRead: "0.25", cacheWrite: null, output: "15" },
        { apiLongContext: 272000 },
      ),
      ...openaiStandard(["gpt-5.4-mini"], {
        input: "0.75",
        cacheRead: "0.075",
        cacheWrite: null,
        output: "4.5",
      }),
      ...openaiTiered(
        "gpt-6-astra",
        { input: "10", cacheRead: "1", output: "50" },
        { apiLongContext: 272000 },
      ),
      ...openaiTiered(
        "gpt-5.6-sol",
        { input: "4", cacheRead: "0.4", output: "20" },
        {
          apiLongContext: 272000,
          promotion: {
            description: "Published promotional API pricing",
            confirmedThrough: "2026-11-30",
          },
        },
      ),
      ...openaiTiered(
        "gpt-5.6-terra",
        { input: "2", cacheRead: "0.2", output: "12" },
        { apiLongContext: 272000 },
      ),
      ...openaiTiered(
        "gpt-5.6-luna",
        { input: "0.2", cacheRead: "0.02", output: "1.2" },
        { apiLongContext: 272000 },
      ),
      ...openaiTiered(
        "gpt-6-sol",
        { input: "2", cacheRead: "0.2", output: "10" },
        { apiLongContext: 272000 },
      ),
      ...openaiTiered(
        "gpt-6-luna",
        { input: "0.1", cacheRead: "0.01", output: "0.5" },
        { apiLongContext: 272000 },
      ),
      ...openaiTiered(
        "codex-auto-review",
        { input: "0.1", cacheRead: "0.01", output: "0.5" },
        { apiLongContext: 272000 },
      ),
      ...openaiTiered(
        "gpt-6.1-sol",
        { input: "2", cacheRead: "0.1", output: "10" },
        { apiLongContext: 272000 },
      ),
      ...openaiTiered(
        "gpt-6.1-terra",
        { input: "1", cacheRead: "0.05", output: "5" },
        { apiLongContext: 272000 },
      ),

      // OpenAI 图像系列
      ...openaiStandard(
        ["gpt-image-2", "gpt-image-2-2026-04-21"],
        { input: "5", cacheRead: "1.25", cacheWrite: null, output: null },
        { imageRates: IMAGE_RATES },
      ),
      ...openaiStandard(
        [
          "gpt-image-2.5-sunburst",
          "gpt-image-2.5-sunburst-2026-09-08",
          "gpt-image-2.5-flare",
          "gpt-image-2.5-flare-2026-09-08",
          "gpt-image-2.6-sunburst",
          "gpt-image-2.6-flare",
        ],
        { input: "5", cacheRead: "1.25", cacheWrite: null, output: "0" },
        { imageRates: IMAGE_RATES },
      ),

      // Anthropic Claude 系列
      ...claude("claude-fable-5-2", "8", {
        cacheReadFactor: "0.025",
        fast: true,
      }),
      ...claude("claude-fable-5-1", "10", { cacheReadFactor: "0.025" }),
      ...claude("claude-opus-5-5", "4", {
        cacheReadFactor: "0.05",
        fast: true,
      }),
      ...claude(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6"], "5", {
        fast: true,
      }),
      ...claude("claude-sonnet-5-5", "2", { cacheReadFactor: "0.05" }),
      ...claude("claude-sonnet-5", "2"),
      ...claude("claude-haiku-5-5", "0.1", {
        apiLongContext: { threshold: 100000, multiplier: "5" },
      }),
      ...claude(["claude-haiku-4-5-20251001", "claude-haiku-4-5"], "1"),

      // OpenCode Go 系列
      ...flatUsd(
        "deepseek-v4.1-flash",
        { input: "0.15", cacheRead: "0.003", cacheWrite: null, output: "0.6" },
        {
          days: [1, 2, 3, 4, 5],
          hoursUtc: [
            { from: "01:00", until: "04:00" },
            { from: "06:00", until: "10:00" },
          ],
          rates: {
            input: "0.3",
            cacheRead: "0.006",
            cacheWrite: null,
            output: "1.2",
          },
        },
      ),
      ...flatUsd("glm-5.3", {
        input: "1.4",
        cacheRead: "0.26",
        cacheWrite: null,
        output: "4.4",
      }),
      ...flatUsd("glm-5.3-flash", {
        input: "0.15",
        cacheRead: "0.03",
        cacheWrite: null,
        output: "0.5",
      }),

      // Google Gemini 与 Vertex AI Model Garden 系列
      ...gemini("gemini-4-hydrogen", {
        input: "1.5",
        cacheRead: "0.075",
        output: "7.5",
        flex: true,
      }),
      ...gemini("gemini-4-carbon", {
        input: "4",
        cacheRead: "0.2",
        output: "20",
        flex: true,
        promo: {
          until: "2026-12-01T00:00:00Z",
          confirmedThrough: "2026-11-30",
          description:
            "Published Gemini 4 Carbon promotional pricing through 2026-11-30",
          input: "2",
          cacheRead: "0.1",
          output: "10",
        },
      }),
      ...gemini("gemini-4-argon", {
        input: "4",
        cacheRead: "0.2",
        output: "20",
        flex: true,
        promo: {
          until: "2026-12-01T00:00:00Z",
          confirmedThrough: "2026-11-30",
          description:
            "Published Gemini 4 Argon promotional pricing through 2026-11-30",
          input: "2",
          cacheRead: "0.1",
          output: "10",
        },
      }),
      ...gemini("gemini-3.8-flash", {
        input: "1.5",
        cacheRead: "0.15",
        output: "7.5",
        flex: true,
        promo: {
          until: "2027-01-01T00:00:00Z",
          confirmedThrough: "2026-12-31",
          description:
            "Published Gemini 3.8 Flash promotional pricing through 2026-12-31",
          input: "0.75",
          cacheRead: "0.075",
          output: "3.75",
        },
      }),
      ...gemini("gemini-3.5-flash-lite", {
        input: "0.3",
        cacheRead: "0.03",
        output: "2.5",
      }),
      ...flatUsd("gpt-oss-120b", {
        input: "0.09",
        cacheRead: null,
        cacheWrite: null,
        output: "0.36",
      }),
    ],
  });
}
