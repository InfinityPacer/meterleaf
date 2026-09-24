import { expect, test } from "bun:test";
import { planBadge } from "../src/web/lib/plan";

const subscription = (platform: string | undefined, plan: string) =>
  planBadge({ platform, plan, kind: "subscription" });

test("plan tiers align by usage multiple across upstreams", () => {
  expect(subscription("anthropic", "pro")).toEqual({ label: "Pro", tier: 1 });
  expect(subscription("openai", "plus")).toEqual({ label: "Plus", tier: 1 });
  expect(subscription("anthropic", "max-5x")).toEqual({
    label: "Max 5x",
    tier: 2,
  });
  expect(subscription("openai", "prolite")).toEqual({
    label: "Pro 5x",
    tier: 2,
  });
  expect(subscription("anthropic", "max-20x")).toEqual({
    label: "Max 20x",
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
