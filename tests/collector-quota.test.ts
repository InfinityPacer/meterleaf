import { expect, test } from "bun:test";
import { quotaSnapshot } from "../src/collector/claude-code/quota";

const accountUuid = "aaaaaaaa-1111-4111-8111-111111111111";

function cached(limits?: unknown) {
  return {
    fetchedAtMs: Date.parse("2026-09-24T20:00:00Z"),
    accountUuid,
    utilization: {
      five_hour: { utilization: 21, resets_at: "2026-09-25T00:20:00Z" },
      seven_day: { utilization: 33, resets_at: "2026-09-27T08:00:00Z" },
      ...(limits === undefined ? {} : { limits }),
    },
  };
}

const fableLimit = {
  kind: "weekly_scoped",
  group: "weekly",
  percent: 12,
  severity: "normal",
  resets_at: "2026-09-27T08:00:00+00:00",
  scope: { model: { id: null, display_name: "Fable" }, surface: null },
  is_active: false,
};

test("the Fable weekly limit becomes its own quota window", () => {
  const snapshot = quotaSnapshot(
    cached([
      { kind: "session", group: "session", percent: 21, scope: null },
      { kind: "weekly_all", group: "weekly", percent: 33, scope: null },
      fableLimit,
    ]),
  )!;
  expect(snapshot.quotas.map((quota) => quota.window)).toEqual([
    "five-hour",
    "seven-day",
    "seven-day-fable",
  ]);
  expect(snapshot.quotas.at(-1)).toEqual({
    accountExternalId: accountUuid,
    window: "seven-day-fable",
    percent: 12,
    sampledAt: "2026-09-24T20:00:00.000Z",
    resetsAt: "2026-09-27T08:00:00.000Z",
    windowMinutes: 10080,
  });
});

test("limits scoped to another model or to one surface are not the Fable account quota", () => {
  const snapshot = quotaSnapshot(
    cached([
      {
        ...fableLimit,
        scope: { model: { id: null, display_name: "Opus" }, surface: null },
      },
      {
        ...fableLimit,
        scope: { model: { id: null, display_name: "Fable" }, surface: "chat" },
      },
    ]),
  )!;
  expect(snapshot.quotas.map((quota) => quota.window)).toEqual([
    "five-hour",
    "seven-day",
  ]);
});

test("a missing Fable percent stays unknown instead of zero", () => {
  const snapshot = quotaSnapshot(cached([{ ...fableLimit, percent: null }]))!;
  expect(snapshot.quotas.at(-1)).toMatchObject({
    window: "seven-day-fable",
    percent: null,
  });
});

test("accounts without a limits list keep only the shared windows", () => {
  expect(quotaSnapshot(cached())!.quotas.map((quota) => quota.window)).toEqual([
    "five-hour",
    "seven-day",
  ]);
});
