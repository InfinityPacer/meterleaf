import { expect, test } from "bun:test";
import type { LedgerAccount } from "../src/shared/report";
import { accountFilterOptions } from "../src/web/lib/account-filter";

const account = (id: string, name: string): LedgerAccount => ({
  id,
  name,
  plan: "",
  kind: "subscription",
  sampledAt: null,
  fiveHour: null,
  sevenDay: null,
});

const active = account("active", "Claude Ara");
const archived = account("archived", "Claude Team");
const hidden = account("hidden", "OpenCode Go");
const all = [active, archived, hidden];

test("account filter leaves archived and deleted accounts out of the menu", () => {
  expect(
    accountFilterOptions([active], all, "all", {
      archived: new Set([archived.id]),
      hidden: new Set([hidden.id]),
    }),
  ).toEqual([{ value: "active", label: "Claude Ara" }]);
});

test("account filter keeps the drilled-in archived account visible and labelled", () => {
  expect(
    accountFilterOptions([active], all, archived.id, {
      archived: new Set([archived.id]),
      hidden: new Set(),
    }),
  ).toEqual([
    { value: "active", label: "Claude Ara" },
    { value: "archived", label: "Claude Team（已归档）" },
  ]);
});

test("account filter marks a selected deleted account without inventing a name", () => {
  expect(
    accountFilterOptions([active], all, hidden.id, {
      archived: new Set(),
      hidden: new Set([hidden.id]),
    }).at(-1),
  ).toEqual({ value: "hidden", label: "OpenCode Go（已删除）" });
  expect(
    accountFilterOptions([active], all, "unknown", {
      archived: new Set(),
      hidden: new Set(),
    }).at(-1),
  ).toEqual({ value: "unknown", label: "unknown" });
});
