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
