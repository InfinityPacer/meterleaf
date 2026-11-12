import Decimal from "decimal.js";
import { buildPriceBook } from "../prices/catalog";

interface UpstreamRate {
  source: string;
  input: string | null;
  cacheRead: string | null;
  output: string | null;
}

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENCODE_GO_URL = "https://opencode.ai/inference/go/v1/models";

function perMillion(perToken: unknown): string | null {
  if (typeof perToken !== "number" || !Number.isFinite(perToken)) return null;
  return new Decimal(perToken).mul(1_000_000).toDecimalPlaces(6).toString();
}

function normalizeNum(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  try {
    return new Decimal(value).toDecimalPlaces(6).toString();
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const book = buildPriceBook();
const nowMs = Date.now();

const activeStandardByModel = new Map<
  string,
  { input: string; cacheRead: string | null; output: string | null }
>();
for (const rule of book.rules) {
  if (
    rule.currency !== "usd" ||
    rule.usdBasis !== "subscription" ||
    rule.tier !== "standard"
  ) {
    continue;
  }
  const from = Date.parse(rule.effectiveFrom);
  const until = rule.effectiveUntil
    ? Date.parse(rule.effectiveUntil)
    : Infinity;
  if (nowMs >= from && nowMs < until) {
    activeStandardByModel.set(rule.model, {
      input: normalizeNum(rule.rates.input)!,
      cacheRead: normalizeNum(rule.rates.cacheRead),
      output: normalizeNum(rule.rates.output),
    });
  }
}

const [litellm, modelsDev, opencodeGo] = await Promise.all([
  fetchJson<Record<string, Record<string, unknown>>>(LITELLM_URL),
  fetchJson<
    Record<
      string,
      { models?: Record<string, { cost?: Record<string, unknown> }> }
    >
  >(MODELS_DEV_URL),
  fetchJson<{
    data?: Array<{ id: string; pricing?: Record<string, unknown> }>;
  }>(OPENCODE_GO_URL),
]);

const upstream = new Map<string, UpstreamRate>();

if (modelsDev) {
  for (const provider of ["openai", "anthropic", "google"] as const) {
    for (const [id, entry] of Object.entries(
      modelsDev[provider]?.models ?? {},
    )) {
      if (!entry.cost) continue;
      upstream.set(id, {
        source: `models.dev/${provider}`,
        input: normalizeNum(entry.cost.input),
        cacheRead: normalizeNum(entry.cost.cache_read),
        output: normalizeNum(entry.cost.output),
      });
    }
  }
}

if (litellm) {
  for (const [rawKey, entry] of Object.entries(litellm)) {
    const id = rawKey.replace(/^(gemini|openai|anthropic|vertex_ai)\//, "");
    if (upstream.has(id)) continue;
    const input = perMillion(entry.input_cost_per_token);
    const output = perMillion(entry.output_cost_per_token);
    if (input === null && output === null) continue;
    upstream.set(id, {
      source: `litellm(${rawKey})`,
      input,
      cacheRead: perMillion(entry.cache_read_input_token_cost),
      output,
    });
  }
}

if (opencodeGo?.data) {
  for (const item of opencodeGo.data) {
    if (!item.pricing) continue;
    upstream.set(item.id, {
      source: "opencode-go",
      input: perMillion(item.pricing.prompt),
      cacheRead: perMillion(item.pricing.input_cache_read),
      output: perMillion(item.pricing.completion),
    });
  }
}

const diffs: string[] = [];
let matched = 0;
let missingUpstream = 0;

for (const [model, local] of activeStandardByModel) {
  const remote = upstream.get(model);
  if (!remote) {
    missingUpstream++;
    continue;
  }
  const fields: Array<
    ["input" | "cacheRead" | "output", string | null, string | null]
  > = [
    ["input", local.input, remote.input],
    ["cacheRead", local.cacheRead, remote.cacheRead],
    ["output", local.output, remote.output],
  ];
  const mismatches = fields.filter(
    ([, l, r]) => l !== null && r !== null && l !== r,
  );
  if (mismatches.length > 0) {
    diffs.push(
      `  - ${model} [${remote.source}]: ` +
        mismatches
          .map(([k, l, r]) => `${k} local=${l} vs upstream=${r}`)
          .join(", "),
    );
  } else {
    matched++;
  }
}

const candidatePatterns = [
  /^gpt-(?:5\.[4-9]|6(?:\.[0-9]+)?)-(?:astra|sol|terra|luna)$/,
  /^gpt-image-2(?:\.[5-9])-(?:sunburst|flare)$/,
  /^claude-(?:fable|opus|sonnet|haiku)-5(?:-[0-9]+)?$/,
  /^gemini-4-(?:hydrogen|helium|lithium|carbon|nitrogen|oxygen|neon|argon)$/,
  /^gemini-3\.[5-9]-flash(?:-lite)?$/,
];

const unconfiguredCandidates = [...upstream.entries()]
  .filter(
    ([id]) =>
      !activeStandardByModel.has(id) &&
      candidatePatterns.some((re) => re.test(id)),
  )
  .sort(([a], [b]) => a.localeCompare(b));

console.log(
  `Price check (${book.id}@${book.version}): ${activeStandardByModel.size} models (${matched} matched upstream, ${missingUpstream} local-only).`,
);

if (diffs.length > 0) {
  console.log(
    "\nRate differences to review (note peak/image-text split models may differ):",
  );
  for (const line of diffs) console.log(line);
}

if (unconfiguredCandidates.length > 0) {
  console.log("\nUpstream candidate models not yet in prices/catalog.ts:");
  for (const [id, r] of unconfiguredCandidates) {
    console.log(
      `  - ${id} [${r.source}]: input=${r.input ?? "-"} cacheRead=${r.cacheRead ?? "-"} output=${r.output ?? "-"}`,
    );
  }
}
