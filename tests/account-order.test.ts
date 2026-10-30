import { expect, test } from "bun:test";
import {
  isEmptyAccount,
  orderedAccounts,
  reorderAccount,
} from "../src/web/lib/account-order";
import {
  preferenceSchemas,
  readStoredPreference,
  writeStoredPreference,
} from "../src/web/lib/preferences";

test("account order survives storage and appends new accounts without reviving removed ones", () => {
  const accounts = [{ id: "a" }, { id: "b" }, { id: "new" }];
  const order = reorderAccount(["a", "b"], "b", "a");
  let raw = "";
  writeStoredPreference("order", preferenceSchemas.accountOrder, order, {
    setItem: (_, value) => {
      raw = value;
    },
  });
  const restored = readStoredPreference(
    "order",
    preferenceSchemas.accountOrder,
    [],
    { getItem: () => raw },
  );
  expect(
    orderedAccounts(accounts, [...restored, "removed"]).map((a) => a.id),
  ).toEqual(["b", "a", "new"]);
  expect(orderedAccounts(accounts, []).map((a) => a.id)).toEqual([
    "a",
    "b",
    "new",
  ]);
});

test("reordering moves accounts to start, end and adjacent positions", () => {
  const initial = ["a", "b", "c", "d"];
  // Move to start
  expect(reorderAccount(initial, "d", "a")).toEqual(["d", "a", "b", "c"]);
  expect(reorderAccount(initial, "c", "a")).toEqual(["c", "a", "b", "d"]);
  // Move to end
  expect(reorderAccount(initial, "a", "d")).toEqual(["b", "c", "d", "a"]);
  expect(reorderAccount(initial, "b", "d")).toEqual(["a", "c", "d", "b"]);
  // Move between adjacent accounts
  expect(reorderAccount(initial, "b", "c")).toEqual(["a", "c", "b", "d"]);
  expect(reorderAccount(initial, "c", "b")).toEqual(["a", "c", "b", "d"]);
});

test("reordering across archived accounts leaves archived IDs in place", () => {
  const archived = new Set(["x", "y"]);
  const visible = (id: string) => !archived.has(id);
  expect(reorderAccount(["a", "x", "b"], "b", "a", visible)).toEqual([
    "b",
    "x",
    "a",
  ]);
  expect(reorderAccount(["a", "x", "b"], "a", "b", visible)).toEqual([
    "b",
    "x",
    "a",
  ]);
  expect(reorderAccount(["x", "a", "y", "b", "c"], "c", "a", visible)).toEqual([
    "x",
    "c",
    "y",
    "a",
    "b",
  ]);
  expect(reorderAccount(["x", "a", "y", "b", "c"], "a", "c", visible)).toEqual([
    "x",
    "b",
    "y",
    "c",
    "a",
  ]);
});

test("reordering ignores unknown, hidden or identical IDs", () => {
  const archived = new Set(["x"]);
  const visible = (id: string) => !archived.has(id);
  const initial = ["a", "x", "b"];
  expect(reorderAccount(initial, "a", "a", visible)).toBe(initial);
  expect(reorderAccount(initial, "missing", "a", visible)).toBe(initial);
  expect(reorderAccount(initial, "a", "missing", visible)).toBe(initial);
  expect(reorderAccount(initial, "x", "a", visible)).toBe(initial);
  expect(reorderAccount(initial, "a", "x", visible)).toBe(initial);
});

test("empty unknown accounts are left out of the overview, sources without totals stay", () => {
  const base = { kind: "unknown", fiveHour: null, sevenDay: null };
  expect(isEmptyAccount({ ...base, lifetime: { count: 0 } })).toBe(true);
  expect(isEmptyAccount({ ...base, lifetime: { count: 3 } })).toBe(false);
  expect(isEmptyAccount(base)).toBe(false);
  expect(isEmptyAccount({ ...base, kind: "api", lifetime: { count: 0 } })).toBe(
    false,
  );
  expect(
    isEmptyAccount({ ...base, sevenDay: {}, lifetime: { count: 0 } }),
  ).toBe(false);
});
