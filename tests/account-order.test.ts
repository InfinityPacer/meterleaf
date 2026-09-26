import { expect, test } from "bun:test";
import { orderedAccounts, moveAccount } from "../src/web/lib/account-order";
import { preferenceSchemas, readStoredPreference, writeStoredPreference } from "../src/web/lib/preferences";

test("account order survives storage and appends new accounts without reviving removed ones", () => {
  const accounts = [{ id: "a" }, { id: "b" }, { id: "new" }];
  const order = moveAccount(["a", "b"], "b", -1);
  let raw = "";
  writeStoredPreference("order", preferenceSchemas.accountOrder, order, { setItem: (_, value) => { raw = value; } });
  const restored = readStoredPreference("order", preferenceSchemas.accountOrder, [], { getItem: () => raw });
  expect(orderedAccounts(accounts, [...restored, "removed"]).map(a => a.id)).toEqual(["b", "a", "new"]);
  expect(moveAccount(order, "b", -1)).toEqual(order);
  expect(moveAccount(order, "missing", 1)).toEqual(order);
  expect(orderedAccounts(accounts, []).map(a => a.id)).toEqual(["a", "b", "new"]);
});

test("moving an account skips archived neighbours and leaves them in place", () => {
  const archived = new Set(["x"]);
  const visible = (id: string) => !archived.has(id);
  expect(moveAccount(["a", "x", "b"], "b", -1, visible)).toEqual(["b", "x", "a"]);
  expect(moveAccount(["a", "x", "b"], "a", 1, visible)).toEqual(["b", "x", "a"]);
  expect(moveAccount(["x", "a", "b"], "a", -1, visible)).toEqual(["x", "a", "b"]);
});
