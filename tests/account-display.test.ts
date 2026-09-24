import { expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { createDemoLedger } from "../src/web/demo/ledger";

test("account display API archives, restores and hides without invoking source sync", async () => {
  const archived = new Set<string>();
  const hidden = new Set<string>();
  const aliases = new Map<string, string>();
  const app = createApp({
    snapshot: () => createDemoLedger(),
    accountArchive: {
      read: () => [...archived], hidden: () => [...hidden],
      write: (id, value) => { if (value) archived.add(id); else archived.delete(id); return [...archived]; },
      hide: (id) => { hidden.add(id); return [...hidden]; },
      aliases: () => Object.fromEntries(aliases),
      setAlias: (id, alias) => { if (alias === null) aliases.delete(id); else aliases.set(id, alias); return Object.fromEntries(aliases); },
    },
  });
  try {
    for (const payload of [{ id: "test:a", archived: true }, { id: "test:a", archived: false }, { id: "test:a", archived: true }, { id: "test:a", hidden: true }]) {
      const response = await app.inject({ method: "PUT", url: "/api/accounts/archive", payload });
      expect(response.statusCode).toBe(200);
    }
    expect((await app.inject("/api/accounts/archive")).json<{ archived: string[]; hidden: string[]; aliases: Record<string, string>; writable: boolean }>()).toEqual({ archived: ["test:a"], hidden: ["test:a"], aliases: {}, writable: true });
    expect((await app.inject({ method: "PUT", url: "/api/accounts/archive", payload: { id: "test:a", hidden: false } })).statusCode).toBe(400);
  } finally { await app.close(); }
});

test("account aliases trim input, reject long names and clear with blank or null", async () => {
  const aliases = new Map<string, string>();
  const app = createApp({
    snapshot: () => createDemoLedger(),
    accountArchive: {
      read: () => [], hidden: () => [], write: () => [], hide: () => [],
      aliases: () => Object.fromEntries(aliases),
      setAlias: (id, alias) => { if (alias === null) aliases.delete(id); else aliases.set(id, alias); return Object.fromEntries(aliases); },
    },
  });
  const put = (payload: object) => app.inject({ method: "PUT", url: "/api/accounts/archive", payload: payload as Record<string, unknown> });
  try {
    const renamed = await put({ id: "claude:a", alias: "  工作号  " });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().aliases).toEqual({ "claude:a": "工作号" });
    expect((await put({ id: "claude:a", alias: "x".repeat(41) })).statusCode).toBe(400);
    expect((await put({ id: "claude:a", alias: "   " })).json().aliases).toEqual({});
    await put({ id: "claude:a", alias: "个人" });
    expect((await put({ id: "claude:a", alias: null })).json().aliases).toEqual({});
  } finally { await app.close(); }
});
