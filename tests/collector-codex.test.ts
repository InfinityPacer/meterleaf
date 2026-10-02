import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexCollector,
  codexEvent,
  emptyContext,
} from "../src/collector/codex";
import { ingestBatchSchema, type IngestBatch } from "../src/shared/ingest";

const temporary: string[] = [];
const opened: CodexCollector[] = [];
afterEach(() => {
  for (const collector of opened.splice(0)) collector.db.close();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const meta = {
  type: "session_meta",
  payload: {
    id: "session-example",
    cwd: "/private/workspace",
    instructions: "private",
  },
};
const model = {
  type: "turn_context",
  payload: { model: "gpt-5.5", effort: "high" },
};
function usage(n = 1) {
  const last = {
    input_tokens: 100,
    cached_input_tokens: 60,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120,
  };
  return {
    timestamp: `2026-10-02T10:00:${String(n).padStart(2, "0")}.000Z`,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: Object.fromEntries(
          Object.entries(last).map(([key, value]) => [key, value * n]),
        ),
      },
    },
  };
}
const lines = (...events: unknown[]) =>
  events.map((item) => JSON.stringify(item) + "\n").join("");
function context() {
  const ctx = emptyContext();
  codexEvent(meta, ctx);
  codexEvent(model, ctx);
  return ctx;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-codex-test-"));
  temporary.push(root);
  mkdirSync(join(root, "sessions"));
  const file = join(root, "sessions", "rollout.jsonl");
  const state = join(root, "collector.sqlite");
  const collector = new CodexCollector(state);
  opened.push(collector);
  writeFileSync(file, lines(meta, model, usage()));
  return { root, file, collector, state };
}
const config = {
  server: "http://localhost",
  sourceId: "codex-test",
  key: "mlk_test",
  createdAt: "2026-10-02T00:00:00Z",
};
const ack = (batch: IngestBatch) =>
  Promise.resolve({
    batchId: batch.batchId,
    accepted: { usage: batch.usage.length, accounts: 1, quotas: 0 },
  });

test("Codex reads per-request usage, separates cache and keeps reasoning inside output", () => {
  const ctx = context();
  const first = codexEvent(usage(1), ctx)!;
  const second = codexEvent(usage(2), ctx)!;
  expect(first.tokens).toEqual({
    input: 40,
    output: 20,
    cacheRead: 60,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: 5,
  });
  expect(second.tokens).toEqual(first.tokens);
  expect(second.externalId).not.toBe(first.externalId);
  expect(JSON.stringify(first)).not.toContain("private");
  expect(JSON.stringify(first)).not.toContain("session-example");
});

test("Codex ignores repeated rate-limit snapshots, including changed notification timestamps", () => {
  const ctx = context();
  codexEvent(usage(), ctx);
  const repeat = usage();
  repeat.timestamp = "2026-10-02T10:01:00Z";
  expect(codexEvent(repeat, ctx)).toBeNull();
});

test("Codex allows cumulative reset and follows model changes", () => {
  const ctx = context();
  codexEvent(usage(4), ctx);
  codexEvent({ type: "turn_context", payload: { model: "gpt-6-astra" } }, ctx);
  const next = codexEvent(usage(1), ctx)!;
  expect(next.model).toBe("gpt-6-astra");
  expect(next.tokens.input).toBe(40);
});

test("Codex cache writes are kept separate when present", () => {
  const row = usage();
  Object.assign(row.payload.info.last_token_usage, {
    cache_write_input_tokens: 10,
  });
  expect(codexEvent(row, context())!.tokens).toMatchObject({
    input: 30,
    cacheRead: 60,
    cacheWrite: 10,
  });
});

test("Codex does not guess a missing model or inconsistent token counters", () => {
  expect(() => codexEvent(usage(), emptyContext())).toThrow(
    "missing_session_or_model",
  );
  const row = usage();
  row.payload.info.last_token_usage.cached_input_tokens = 101;
  expect(() => codexEvent(row, context())).toThrow("inconsistent");
});

test("Codex ignores empty notifications and conversation content", () => {
  expect(
    codexEvent(
      { type: "event_msg", payload: { type: "token_count", info: null } },
      context(),
    ),
  ).toBeNull();
  expect(
    codexEvent(
      {
        type: "response_item",
        payload: { type: "message", content: "private" },
      },
      context(),
    ),
  ).toBeNull();
});

test("Codex only reads complete lines and resumes after partial appends", async () => {
  const { file, root, collector } = fixture();
  const partial = JSON.stringify(usage(2));
  appendFileSync(file, partial.slice(0, 30));
  expect((await collector.scan(root)).events).toBe(1);
  appendFileSync(file, partial.slice(30) + "\n");
  expect((await collector.scan(root)).events).toBe(1);
  expect(collector.status().events).toBe(2);
  expect((await collector.scan(root)).bytes).toBe(0);
});

test("Codex scan does not write source files and unchanged scans do not reread content", async () => {
  const { file, root, collector } = fixture();
  const original = readFileSync(file);
  await collector.scan(root);
  expect(readFileSync(file)).toEqual(original);
  expect(await collector.scan(root)).toMatchObject({ bytes: 0, events: 0 });
});

test("Codex restarting preserves progress and pending records", async () => {
  const { root, state, collector } = fixture();
  await collector.scan(root);
  const next = new CodexCollector(state);
  opened.push(next);
  expect(next.status()).toMatchObject({ events: 1, pending: 1 });
  expect((await next.scan(root)).events).toBe(0);
});

test("Codex backfill respects the byte budget and resumes across bounded cycles", async () => {
  const { root, file, collector } = fixture();
  appendFileSync(
    file,
    lines(...Array.from({ length: 20 }, (_, n) => usage(n + 2))),
  );
  for (let n = 0; n < 40 && collector.status().events < 21; n++) {
    const report = await collector.scan(root, 1024);
    expect(report.bytes).toBeLessThanOrEqual(1024);
  }
  expect(collector.status().events).toBe(21);
});

test("Codex prioritizes recently modified files during bounded backfill", async () => {
  const { root, file, collector } = fixture();
  const newer = join(root, "sessions", "new.jsonl");
  writeFileSync(
    newer,
    lines(
      { type: "session_meta", payload: { id: "new-session" } },
      model,
      usage(),
    ),
  );
  const { utimesSync } = await import("node:fs");
  utimesSync(file, new Date(0), new Date(0));
  await collector.scan(root, readFileSync(newer).length);
  expect(collector.status().events).toBe(1);
  expect(
    collector.db.query<{ path: string }, []>("SELECT path FROM files").get()
      ?.path,
  ).toBe(newer);
});

test("Codex archive copies and file rewrites do not inflate the same source", async () => {
  const { root, file, collector } = fixture();
  await collector.scan(root);
  mkdirSync(join(root, "archived_sessions"));
  copyFileSync(file, join(root, "archived_sessions", "rollout.jsonl"));
  writeFileSync(file, lines(meta, model, usage(), usage(2)));
  await collector.scan(root);
  expect(collector.status().events).toBe(2);
});

test("Codex malformed token records do not block subsequent complete usage", async () => {
  const { root, file, collector } = fixture();
  appendFileSync(file, '{"token_count":bad}\n' + lines(usage(2)));
  expect(await collector.scan(root)).toMatchObject({ invalid: 1, events: 2 });
});

test("Codex only marks delivered after a valid server acknowledgement", async () => {
  const { root, collector } = fixture();
  await collector.scan(root);
  await expect(collector.push(config, async () => ({}))).rejects.toThrow(
    "acknowledgement",
  );
  expect(collector.status().pending).toBe(1);
  expect(
    await collector.push(config, async (batch) => {
      expect(ingestBatchSchema.safeParse(batch).success).toBe(true);
      return ack(batch);
    }),
  ).toBe(1);
  expect(collector.status().pending).toBe(0);
});

test("Codex replay after a lost acknowledgement uses stable request IDs", async () => {
  const { root, collector } = fixture();
  await collector.scan(root);
  const received = new Set<string>();
  await expect(
    collector.push(config, async (batch) => {
      for (const row of batch.usage) received.add(row.externalId);
      throw new Error("connection_lost");
    }),
  ).rejects.toThrow("connection_lost");
  await collector.push(config, async (batch) => {
    for (const row of batch.usage) received.add(row.externalId);
    return ack(batch);
  });
  expect(received.size).toBe(1);
});
