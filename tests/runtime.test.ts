import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import Fastify from "fastify";

test("Bun supports the Fastify and SQLite runtime boundary", async () => {
  const db = new Database(":memory:", { strict: true });
  const app = Fastify();
  try {
    db.run("CREATE TABLE records (id TEXT PRIMARY KEY, amount TEXT NOT NULL)");
    db.transaction(() => {
      db.query("INSERT INTO records VALUES (?, ?)").run("probe", "0.000001");
    })();
    app.get("/probe", () => db.query("SELECT id, amount FROM records").get());
    const response = await app.inject({ method: "GET", url: "/probe" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string; amount: string }>()).toEqual({
      id: "probe",
      amount: "0.000001",
    });
  } finally {
    await app.close();
    db.close();
  }
});
