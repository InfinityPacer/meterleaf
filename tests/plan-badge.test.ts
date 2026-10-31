import { expect, test } from "bun:test";
import { planBadge } from "../src/web/lib/plan";

const subscription = (platform: string | undefined, plan: string) =>
  planBadge({ platform, plan, kind: "subscription" });

test("plan tiers align by usage multiple across upstreams", () => {
  expect(subscription("anthropic", "pro")).toEqual({ label: "Pro", tier: 1 });
  expect(subscription("openai", "plus")).toEqual({ label: "Plus", tier: 1 });
  // Anthropic 把 Max 5x 改名 Max、Max 20x 改名 Ultra，标识沿用原值。
  expect(subscription("anthropic", "max-5x")).toEqual({
    label: "Max",
    tier: 2,
  });
  expect(subscription("openai", "prolite")).toEqual({
    label: "Pro 5x",
    tier: 2,
  });
  expect(subscription("anthropic", "max-20x")).toEqual({
    label: "Ultra",
    tier: 3,
  });
  expect(subscription("google", "ultra-5x")).toEqual({
    label: "Ultra 5x",
    tier: 2,
  });
  expect(subscription("google", "ultra-20x")).toEqual({
    label: "Ultra 20x",
    tier: 3,
  });
  // ChatGPT 的 pro 是 20x 档，与 Claude 的 Pro 同名但不同档。
  expect(subscription("openai", "pro")).toEqual({ label: "Pro 20x", tier: 3 });
});

test("unknown platforms or plans keep a label without guessing a tier", () => {
  expect(subscription(undefined, "pro")).toEqual({ label: "Pro", tier: null });
  expect(subscription("openai", "team")).toEqual({ label: "Team", tier: null });
  expect(subscription("openai", "未提供")).toBeNull();
  expect(
    planBadge({ platform: "openai", plan: "未提供", kind: "api" }),
  ).toEqual({ label: "API", tier: null });
});

test("OpenCode Go plans show their names without a usage tier", () => {
  expect(subscription("opencode-go", "go")).toEqual({
    label: "Go",
    tier: null,
  });
  expect(subscription("opencode-go", "go-plus")).toEqual({
    label: "Go Plus",
    tier: null,
  });
});

test("Antigravity reports Google AI Ultra without its multiple", () => {
  expect(subscription("google", "Google AI Ultra")).toEqual({
    label: "Ultra",
    tier: null,
  });
});
