import { expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { createDemoLedger } from "../src/web/demo/ledger";

test("account display API archives, restores and hides without invoking source sync", async () => {
  const archived = new Set<string>();
  const hidden = new Set<string>();
  const app = createApp({
    snapshot: () => createDemoLedger(),
    accountArchive: {
      read: () => [...archived], hidden: () => [...hidden],
      write: (id, value) => { if (value) archived.add(id); else archived.delete(id); return [...archived]; },
      hide: (id) => { hidden.add(id); return [...hidden]; },
    },
  });
  try {
    for (const payload of [{ id: "test:a", archived: true }, { id: "test:a", archived: false }, { id: "test:a", archived: true }, { id: "test:a", hidden: true }]) {
      const response = await app.inject({ method: "PUT", url: "/api/accounts/archive", payload });
      expect(response.statusCode).toBe(200);
    }
    expect((await app.inject("/api/accounts/archive")).json<{ archived: string[]; hidden: string[]; writable: boolean }>()).toEqual({ archived: ["test:a"], hidden: ["test:a"], writable: true });
    expect((await app.inject({ method: "PUT", url: "/api/accounts/archive", payload: { id: "test:a", hidden: false } })).statusCode).toBe(400);
  } finally { await app.close(); }
});
