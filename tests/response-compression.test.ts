import { expect, test } from "bun:test";
import Fastify from "fastify";
import { gzipSync, gunzipSync } from "node:zlib";
import { registerResponseCompression } from "../src/server/response-compression";

const ledgerPayload = {
  mode: "live",
  records: Array.from({ length: 320 }, (_, index) => ({
    id: `record-${index}`,
    account: "shared-account",
    model: "gpt-6-astra",
    label: "账户账本",
    detail: "repeated ledger payload ".repeat(10),
  })),
};

function createApp() {
  const app = Fastify({ logger: false });
  registerResponseCompression(app);
  app.get<{
    Querystring: {
      preencoded?: string;
      small?: string;
    };
  }>("/api/ledger", (request, reply) => {
    if (request.query.preencoded === "1") {
      reply.header("Content-Type", "application/json");
      reply.header("Content-Encoding", "gzip");
      return reply.send(gzipSync(JSON.stringify(ledgerPayload)));
    }
    if (request.query.small === "1")
      return { status: "ok", value: "small response" };
    return ledgerPayload;
  });
  app.get("/api/health", () => ({ status: "ok" }));
  return app;
}

test("compresses ledger JSON and preserves the decompressed content", async () => {
  const app = createApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/ledger",
      headers: { "accept-encoding": "gzip" },
    });
    const compressed = Buffer.from(response.rawPayload);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers.vary).toContain("Accept-Encoding");
    const contentLength = response.headers["content-length"];
    if (contentLength !== undefined)
      expect(contentLength).toBe(String(compressed.byteLength));
    expect(JSON.parse(gunzipSync(compressed).toString("utf8"))).toEqual(
      ledgerPayload,
    );
  } finally {
    await app.close();
  }
});

test("does not compress when gzip is unsupported or explicitly disabled", async () => {
  const app = createApp();
  try {
    for (const headers of [
      {},
      { "accept-encoding": "br" },
      { "accept-encoding": "gzip;q=0, br;q=1" },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/ledger",
        headers,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers.vary).toContain("Accept-Encoding");
      const contentLength = response.headers["content-length"];
      if (contentLength !== undefined)
        expect(contentLength).toBe(String(Buffer.byteLength(response.body)));
      expect(JSON.parse(response.body)).toEqual(ledgerPayload);
    }
  } finally {
    await app.close();
  }
});

test("does not compress ledger JSON below the size threshold", async () => {
  const app = createApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/ledger?small=1",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toContain("Accept-Encoding");
    expect(JSON.parse(response.body)).toEqual({
      status: "ok",
      value: "small response",
    });
  } finally {
    await app.close();
  }
});

test("does not compress health responses", async () => {
  const app = createApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  } finally {
    await app.close();
  }
});

test("does not apply a second encoding to an already encoded ledger response", async () => {
  const app = createApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/ledger?preencoded=1",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(
      JSON.parse(gunzipSync(response.rawPayload).toString("utf8")),
    ).toEqual(ledgerPayload);
  } finally {
    await app.close();
  }
});
