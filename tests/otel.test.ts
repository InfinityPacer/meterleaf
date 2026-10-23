import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { defaultPriceBook } from "../src/domain/default-prices";
import { createApp } from "../src/server/app";
import { liveSnapshot } from "../src/server/snapshot";
import { subjectKeyFrom } from "../src/shared/account-subject";
import {
  INGEST_BATCHES_PATH,
  type IngestBatch,
  type IngestUsage,
} from "../src/shared/ingest";
import {
  DATABASE_BASELINE_REVISION,
  DATABASE_SCHEMA_REVISION,
} from "../src/storage/schema";
import { OTEL_BODY_LIMIT_BYTES, OTEL_LOGS_PATH } from "../src/shared/otel";
import { LedgerStore } from "../src/storage/ledger";

const key = "mlk_test-key-for-otel-only";
const digest = createHash("sha256").update(key).digest("hex");
const sourceId = "claude-code-mac";
const now = "2026-10-23T12:00:00.000Z";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function attributes(values: Record<string, string>) {
  return Object.entries(values).map(([name, value]) => ({
    key: name,
    value: { stringValue: value },
  }));
}

function record(
  values: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  return {
    timeUnixNano: String(Date.parse("2026-10-23T11:00:00Z") * 1_000_000),
    body: { stringValue: "claude_code.api_request" },
    attributes: attributes(values),
    ...extra,
  };
}

function otlp(records: unknown[], resource: Record<string, string> = {}) {
  return {
    resourceLogs: [
      {
        resource: { attributes: attributes(resource) },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

function setup() {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  const app = createApp({
    snapshot: () => {
      throw new Error("not used");
    },
    ingest: {
      keys: [{ sourceId, sha256: digest }],
      save: (id, batch) =>
        store.saveIngestBatch(id, batch, "2026-10-23T11:59:00.000Z"),
      saveOtel: (id, records, receivedAt) =>
        store.saveRequestAccounts(id, records, receivedAt),
    },
  });
  const post = (
    payload: unknown,
    options: {
      token?: string | null;
      contentType?: string;
      gzip?: boolean;
      raw?: string;
    } = {},
  ) => {
    const token = options.token === undefined ? key : options.token;
    // raw 原样发送，用于构造损坏的 JSON 或损坏的 gzip。
    const body =
      options.raw ??
      (options.gzip
        ? gzipSync(JSON.stringify(payload))
        : JSON.stringify(payload));
    return app.inject({
      method: "POST",
      url: OTEL_LOGS_PATH,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": options.contentType ?? "application/json",
        ...(options.gzip ? { "content-encoding": "gzip" } : {}),
      },
      payload: body,
    });
  };
  return { store, app, post };
}

function usage(overrides: Partial<IngestUsage> = {}): IngestUsage {
  return {
    externalId: "req_1:msg_1",
    occurredAt: "2026-10-23T11:00:00.000Z",
    accountExternalId: "timeline-account",
    model: "claude-opus-5-5",
    tier: "standard",
    tokens: {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    },
    metadata: {},
    ...overrides,
  };
}

function batch(overrides: Partial<IngestBatch> = {}): IngestBatch {
  return {
    schemaVersion: 1,
    sourceId,
    batchId: crypto.randomUUID(),
    collector: { name: "meterleaf-collector", version: "0.0.0-test" },
    accounts: [
      {
        externalId: "timeline-account",
        name: "Claude Code",
        platform: "anthropic",
        kind: "subscription",
        plan: "max-5x",
        subjectKey: null,
      },
    ],
    usage: [usage()],
    quotas: [],
    ...overrides,
  };
}

function postBatch(app: ReturnType<typeof setup>["app"], payload: IngestBatch) {
  return app.inject({
    method: "POST",
    url: INGEST_BATCHES_PATH,
    headers: { authorization: `Bearer ${key}` },
    payload,
  });
}

test("OTEL route requires the write key, JSON and a readable body", async () => {
  const { app, post } = setup();
  try {
    expect(
      (await post(otlp([record({ request_id: "req_1" })]), { token: null }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await post(otlp([record({ request_id: "req_1" })]), {
          token: "mlk_wrong",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post(otlp([record({ request_id: "req_1" })]), {
          contentType: "text/plain",
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await post(otlp([record({ request_id: "req_1" })]), {
          contentType: "application/x-protobuf",
        })
      ).statusCode,
    ).toBe(415);

    const gzip = await post(
      otlp([record({ request_id: "req_gzip", "user.account_uuid": "acct" })]),
      { gzip: true },
    );
    expect(gzip.statusCode).toBe(200);

    expect((await post(null, { raw: "{" })).statusCode).toBe(400);
    expect((await post({ resourceLogs: 5 })).statusCode).toBe(400);
    expect((await post(null, { raw: "not gzip", gzip: true })).statusCode).toBe(
      400,
    );
    // 超限返回 413，导出器才会丢弃而不是无限重试。
    expect(
      (
        await post(null, {
          raw: JSON.stringify({
            resourceLogs: [],
            padding: "x".repeat(OTEL_BODY_LIMIT_BYTES),
          }),
        })
      ).statusCode,
    ).toBe(413);
  } finally {
    await app.close();
  }
});

test("only the request identity fields are stored, never prompts or other attributes", async () => {
  const { store, post } = setup();
  try {
    const response = await post(
      otlp([
        record({
          request_id: "req_fields",
          "user.account_uuid": "account-1",
          "organization.id": "org-1",
          "session.id": "session-1",
          model: "claude-opus-5-5",
          "event.timestamp": "2026-10-23T10:59:00Z",
          prompt: "SECRET PROMPT",
          "tool.content": "SECRET TOOL OUTPUT",
          "file.path": "/Users/secret/project",
        }),
      ]),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual({});
    const row = store.db
      .query<Record<string, unknown>, []>("SELECT * FROM request_accounts")
      .get();
    expect(row).toEqual({
      source_id: sourceId,
      request_id: "req_fields",
      account_uuid: "account-1",
      organization_uuid: "org-1",
      session_id: "session-1",
      model: "claude-opus-5-5",
      occurred_at: "2026-10-23T10:59:00.000Z",
      received_at: expect.any(String),
    });
    expect(JSON.stringify(row)).not.toContain("SECRET");
    // 表结构本身也不接受其他属性，避免提示词随字段扩展落库。
    expect(
      store.db
        .query<{ name: string }, []>("PRAGMA table_info(request_accounts)")
        .all()
        .map((column) => column.name),
    ).toEqual([
      "source_id",
      "request_id",
      "account_uuid",
      "organization_uuid",
      "session_id",
      "model",
      "occurred_at",
      "received_at",
    ]);
  } finally {
    await store.close();
  }
});

test("resource attributes fill the record and record attributes win", async () => {
  const { store, post } = setup();
  try {
    const response = await post(
      otlp(
        [
          record({
            request_id: "req_merge",
            "user.account_uuid": "record-account",
          }),
        ],
        {
          "user.account_uuid": "resource-account",
          "organization.id": "resource-org",
          "session.id": "resource-session",
          model: "resource-model",
        },
      ),
    );
    expect(response.statusCode).toBe(200);
    const row = store.db
      .query<Record<string, unknown>, []>(
        "SELECT account_uuid, organization_uuid, session_id, model FROM request_accounts",
      )
      .get();
    expect(row).toEqual({
      account_uuid: "record-account",
      organization_uuid: "resource-org",
      session_id: "resource-session",
      model: "resource-model",
    });

    // event.name 与 body 任一命中都算 API 请求。
    const byEventName = await post({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(
                    Date.parse("2026-10-23T11:00:00Z") * 1_000_000,
                  ),
                  attributes: attributes({
                    "event.name": "api_request",
                    request_id: "req_event_name",
                    "user.account_uuid": "event-account",
                  }),
                },
              ],
            },
          ],
        },
      ],
    });
    expect(byEventName.statusCode).toBe(200);
    expect(
      store.db
        .query<{ request_id: string }, []>(
          "SELECT request_id FROM request_accounts WHERE request_id='req_event_name'",
        )
        .get()?.request_id,
    ).toBe("req_event_name");
  } finally {
    await store.close();
  }
});

test("a repeated request keeps the first non-null account and empty values cannot erase it", async () => {
  const { store, post } = setup();
  try {
    await post(
      otlp([
        record({ request_id: "req_dup", "user.account_uuid": "first-account" }),
      ]),
    );
    await post(otlp([record({ request_id: "req_dup" })]));
    await post(
      otlp([
        record({ request_id: "req_dup", "user.account_uuid": "later-account" }),
      ]),
    );
    const row = store.db
      .query<{ account_uuid: string }, []>(
        "SELECT account_uuid FROM request_accounts WHERE request_id='req_dup'",
      )
      .get();
    expect(row?.account_uuid).toBe("first-account");

    await post(otlp([record({ request_id: "req_fill" })]));
    await post(
      otlp([
        record({
          request_id: "req_fill",
          "user.account_uuid": "filled-account",
        }),
      ]),
    );
    expect(
      store.db
        .query<{ account_uuid: string }, []>(
          "SELECT account_uuid FROM request_accounts WHERE request_id='req_fill'",
        )
        .get()?.account_uuid,
    ).toBe("filled-account");
  } finally {
    await store.close();
  }
});

test("usage written before the OTEL event moves to the request account and appears in reports", async () => {
  const { store, app, post } = setup();
  try {
    expect((await postBatch(app, batch())).statusCode).toBe(200);
    expect(store.usage()[0]!.fact.accountExternalId).toBe("timeline-account");

    const response = await post(
      otlp([
        record({
          request_id: "req_1",
          "user.account_uuid": "otel-account",
          "organization.id": "otel-org",
        }),
      ]),
    );
    expect(response.statusCode).toBe(200);
    expect(store.usage()[0]!.fact.accountExternalId).toBe("otel-account");
    // 覆盖账户不改变计价，估值仍按原事实计算。
    expect(store.usage()[0]!.valuation.apiUsd.amount).not.toBeNull();
    const account = store
      .accounts()
      .find((row) => row.externalId === "otel-account");
    expect(account).toMatchObject({
      sourceId,
      name: "Claude Code",
      platform: "anthropic",
      kind: "unknown",
      plan: null,
      parentExternalId: null,
      subjectKey: subjectKeyFrom("otel-account", "otel-org"),
    });

    const snapshot = liveSnapshot(store, null, 1, now);
    expect(
      snapshot.accounts.find((row) => row.id === `${sourceId}:otel-account`)
        ?.name,
    ).toBe("Claude Code");
    expect(
      snapshot.records.find((row) => row.sourceRecordId === "req_1:msg_1")
        ?.accountId,
    ).toBe(`${sourceId}:otel-account`);
  } finally {
    await store.close();
  }
});

test("usage written after the OTEL event is attributed at write time", async () => {
  const { store, app, post } = setup();
  try {
    await post(
      otlp([
        record({
          request_id: "req_1",
          "user.account_uuid": "otel-account",
          "organization.id": "otel-org",
        }),
        record({
          request_id: "req_model",
          "user.account_uuid": "otel-account",
        }),
      ]),
    );
    expect(
      (
        await postBatch(
          app,
          batch({
            usage: [
              usage(),
              usage({
                externalId: "req_model:msg",
                metadata: { attribution: "model" },
              }),
            ],
          }),
        )
      ).statusCode,
    ).toBe(200);
    const accounts = new Map(
      store
        .usage()
        .map((row) => [row.fact.externalId, row.fact.accountExternalId]),
    );
    expect(accounts.get("req_1:msg_1")).toBe("otel-account");
    // 模型映射优先于 OTEL，写入时也不覆盖。
    expect(accounts.get("req_model:msg")).toBe("timeline-account");
    expect(
      store.accounts().some((row) => row.externalId === "otel-account"),
    ).toBe(true);
  } finally {
    await store.close();
  }
});

test("model-mapped facts, nr keys and advisor siblings follow the attribution rules", async () => {
  const { store, app, post } = setup();
  try {
    await postBatch(
      app,
      batch({
        usage: [
          usage({
            externalId: "req_model:msg",
            accountExternalId: "mapped-account",
            metadata: { attribution: "model" },
          }),
          usage({ externalId: "nr:session:msg" }),
          usage({ externalId: "req_advisor:msg:advisor:0" }),
        ],
      }),
    );
    await post(
      otlp([
        record({
          request_id: "req_model",
          "user.account_uuid": "otel-account",
        }),
        record({ request_id: "nr", "user.account_uuid": "otel-account" }),
        record({
          request_id: "req_advisor",
          "user.account_uuid": "otel-account",
        }),
      ]),
    );
    const accounts = new Map(
      store
        .usage()
        .map((row) => [row.fact.externalId, row.fact.accountExternalId]),
    );
    expect(accounts.get("req_model:msg")).toBe("mapped-account");
    expect(accounts.get("nr:session:msg")).toBe("timeline-account");
    expect(accounts.get("req_advisor:msg:advisor:0")).toBe("otel-account");
  } finally {
    await store.close();
  }
});

test("OTEL never replaces account details already pushed by the collector", async () => {
  const { store, app, post } = setup();
  try {
    await postBatch(
      app,
      batch({
        accounts: [
          {
            externalId: "otel-account",
            name: "Existing Account",
            platform: "anthropic",
            kind: "subscription",
            plan: "max-20x",
            subjectKey: "sha256:existing",
          },
        ],
      }),
    );
    await post(
      otlp([
        record({ request_id: "req_1", "user.account_uuid": "otel-account" }),
      ]),
    );
    expect(
      store.accounts().find((row) => row.externalId === "otel-account"),
    ).toMatchObject({
      name: "Existing Account",
      kind: "subscription",
      plan: "max-20x",
      subjectKey: "sha256:existing",
    });
  } finally {
    await store.close();
  }
});

test("an existing ledger upgrades in place and keeps its facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-otel-migration-"));
  temporary.push(dir);
  const path = join(dir, "ledger.sqlite");
  const store = new LedgerStore(path, defaultPriceBook);
  store.saveIngestBatch(
    sourceId,
    {
      batchId: "old-batch",
      collector: { name: "meterleaf-collector", version: "0.11.2" },
      accounts: [
        {
          sourceId,
          externalId: "timeline-account",
          name: "Claude Code",
          platform: "anthropic",
          kind: "subscription",
          plan: "max-5x",
          parentExternalId: null,
          subjectKey: null,
        },
      ],
      usage: [
        {
          sourceId,
          externalId: "req_old:msg_old",
          occurredAt: "2026-10-20T10:00:00.000Z",
          accountExternalId: "timeline-account",
          model: "claude-opus-5-5",
          upstreamModel: null,
          tier: "standard",
          tokens: {
            input: 10,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            cacheWrite5m: null,
            cacheWrite1h: null,
            reasoning: null,
          },
          gatewayCost: null,
          gatewayBilled: null,
          upstreamUsd: null,
          upstreamCredits: null,
          metadata: {},
        },
      ],
      quotas: [],
    },
    "2026-10-20T10:01:00.000Z",
  );
  const before = store.usage();
  store.close();

  // 模拟上一个版本的账本：只有基线 revision，没有 request_accounts。
  const legacy = new Database(path, { strict: true });
  legacy.exec("DROP TABLE request_accounts");
  legacy
    .query("DELETE FROM schema_revisions WHERE revision=?")
    .run(DATABASE_SCHEMA_REVISION);
  expect(legacy.query("SELECT revision FROM schema_revisions").all()).toEqual([
    { revision: DATABASE_BASELINE_REVISION },
  ]);
  legacy.close();

  const upgraded = new LedgerStore(path, defaultPriceBook);
  try {
    expect(
      upgraded.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='request_accounts'",
        )
        .get()?.name,
    ).toBe("request_accounts");
    expect(
      upgraded.db
        .query<{ revision: string }, []>(
          "SELECT revision FROM schema_revisions",
        )
        .all()
        .map((row) => row.revision)
        .sort(),
    ).toEqual([DATABASE_BASELINE_REVISION, DATABASE_SCHEMA_REVISION].sort());
    expect(upgraded.usage()).toEqual(before);
    expect(upgraded.accounts().map((row) => row.externalId)).toEqual([
      "timeline-account",
    ]);
  } finally {
    upgraded.close();
  }
});
