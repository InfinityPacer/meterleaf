import { expect, test } from "bun:test";
import { encodeLedger, decodeLedger } from "../src/shared/ledger-wire";
import { createDemoLedger } from "../src/web/demo/ledger";
import { createApp } from "../src/server/app";
import {
  createDiagnosticsLogger,
  type LogEvent,
} from "../src/server/diagnostics";
import type { SyncStatus } from "../src/server/sync";

test("compact ledger preserves exact values, nulls, charges and report rows", async () => {
  const snapshot = createDemoLedger("api");
  const encoded = encodeLedger(snapshot);
  const decoded = decodeLedger(JSON.parse(JSON.stringify(encoded)));
  expect(decoded.records.length).toBe(snapshot.records.length);
  for (let index = 0; index < snapshot.records.length; index++) {
    for (const [key, value] of Object.entries(snapshot.records[index]!)) {
      expect(
        decoded.records[index]![key as keyof (typeof snapshot.records)[number]],
      ).toEqual(value);
    }
  }
  expect(JSON.stringify(encoded).length).toBeLessThan(
    JSON.stringify(snapshot).length,
  );
  const app = createApp({ snapshot: () => snapshot });
  try {
    const response = await app.inject("/api/ledger?days=7&compact=1");
    expect(response.statusCode).toBe(200);
    expect(decodeLedger(response.json()).records).toEqual(decoded.records);
  } finally {
    await app.close();
  }
});

test("request details survive compact wire and legacy rows remain decodable", () => {
  const details = {
    requestedModel: "requested-model",
    sentModel: "sent-model",
    responseModel: "response-model",
    responseModelMismatch: false,
    requestedReasoningEffort: "high",
    reasoningEffort: "xhigh",
    durationMs: 0,
    firstTokenMs: 12,
  };
  const snapshot = createDemoLedger();
  snapshot.records = [
    { ...snapshot.records[0]!, details },
    ...snapshot.records.slice(1),
  ];

  const encoded = encodeLedger(snapshot);
  expect(encoded.fields).toContain("details");
  const decoded = decodeLedger(JSON.parse(JSON.stringify(encoded)));
  expect(decoded.records[0]!.details).toEqual(details);

  const detailsIndex = encoded.fields.indexOf("details");
  const legacy = {
    ...encoded,
    fields: encoded.fields.filter((_, index) => index !== detailsIndex),
    rows: encoded.rows.map((row) =>
      row.filter((_, index) => index !== detailsIndex),
    ),
  };
  expect(
    decodeLedger(JSON.parse(JSON.stringify(legacy))).records[0]!.details,
  ).toBe(undefined);
});

test("sync control is lightweight and unavailable in demo mode", async () => {
  const app = createApp({
    snapshot: () => {
      throw new Error("must not load ledger");
    },
  });
  try {
    expect(
      (await app.inject("/api/sync")).json<{ unavailable: boolean }>(),
    ).toEqual({
      unavailable: true,
    });
    expect(
      (await app.inject({ method: "POST", url: "/api/sync" })).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});

test("manual sync and automatic settings return quickly and log request correlation", async () => {
  let requests = 0;
  const events: LogEvent[] = [];
  const status: SyncStatus = {
    autoEnabled: false,
    running: false,
    phase: "idle",
    localRecords: 0,
    batchRecords: 0,
    batchPages: 0,
    hasSynced: false,
    lastAttempt: null,
    lastSuccess: null,
    error: null,
    quotaError: null,
    lastError: null,
    initialComplete: false,
    initialCompleteAt: null,
    lastSweep: null,
  };
  const app = createApp({
    snapshot: () => {
      throw new Error("must not query ledger");
    },
    diagnostics: createDiagnosticsLogger({
      sink: (event) => events.push(event),
    }),
    sync: {
      status: () => status,
      requestSync: () => {
        requests++;
      },
      setAutoSync: (enabled) => {
        status.autoEnabled = enabled;
      },
    },
  });
  try {
    const initial = await app.inject("/api/sync");
    expect(initial.json<SyncStatus>().autoEnabled).toBe(false);
    expect(requests).toBe(0);
    const started = await app.inject({ method: "POST", url: "/api/sync" });
    expect(started.statusCode).toBe(202);
    expect(requests).toBe(1);
    expect(
      events.find((event) => event.event === "sync.requested")?.requestId,
    ).toBe(started.headers["x-request-id"]);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/sync/automatic",
          payload: { enabled: "yes" },
        })
      ).statusCode,
    ).toBe(400);
    const automatic = await app.inject({
      method: "PUT",
      url: "/api/sync/automatic",
      payload: { enabled: true },
    });
    expect(automatic.json<SyncStatus>().autoEnabled).toBe(true);
  } finally {
    await app.close();
  }
});

test("sync endpoint failures expose request IDs without source errors", async () => {
  const app = createApp({
    snapshot: () => {
      throw new Error("unused");
    },
    sync: {
      status: () => {
        throw new Error("private-dsn");
      },
      requestSync: () => {},
      setAutoSync: () => {},
    },
  });
  try {
    const response = await app.inject("/api/sync");
    expect(response.statusCode).toBe(500);
    expect(response.json<{ requestId: string }>().requestId).toBe(
      String(response.headers["x-request-id"]),
    );
    expect(response.body).not.toContain("private-dsn");
  } finally {
    await app.close();
  }
});
