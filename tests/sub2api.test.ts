import { describe, expect, test } from "bun:test";
import { Pool } from "pg";
import type { UsageConnector, UsageFact } from "../src/domain/connector";
import {
  createSub2ApiConnector,
  type Sub2ApiQueryClient,
  type Sub2ApiQueryPool,
} from "../src/connectors/sub2api";
import type { PriceBook } from "../src/domain/pricing";
import { defaultPriceBook } from "../src/domain/default-prices";
import { SyncRunner } from "../src/server/sync";
import { LedgerStore } from "../src/storage/ledger";

type Row = Record<string, unknown>;

const completeSchema = [
  "accounts.id",
  "accounts.name",
  "accounts.platform",
  "accounts.type",
  "accounts.credentials",
  "accounts.extra",
  "accounts.parent_account_id",
  "usage_logs.id",
  "usage_logs.account_id",
  "usage_logs.model",
  "usage_logs.created_at",
  "usage_logs.requested_model",
  "usage_logs.upstream_model",
  "usage_logs.upstream_response_model",
  "usage_logs.upstream_model_mismatch",
  "usage_logs.service_tier",
  "usage_logs.reasoning_effort",
  "usage_logs.requested_reasoning_effort",
  "usage_logs.input_tokens",
  "usage_logs.output_tokens",
  "usage_logs.cache_creation_tokens",
  "usage_logs.cache_read_tokens",
  "usage_logs.cache_creation_5m_tokens",
  "usage_logs.cache_creation_1h_tokens",
  "usage_logs.total_cost",
  "usage_logs.actual_cost",
  "usage_logs.duration_ms",
  "usage_logs.first_token_ms",
  "usage_logs.image_input_tokens",
  "usage_logs.image_output_tokens",
  "usage_logs.video_count",
  "usage_logs.video_duration_seconds",
  "usage_logs.billing_mode",
  "usage_logs.long_context_billing_applied",
  "usage_logs.request_type",
  "usage_logs.stream",
].map((entry) => {
  const [table_name, column_name] = entry.split(".");
  return { table_name, column_name };
});

class FakePool implements Sub2ApiQueryPool {
  readonly calls: Array<{ text: string; values: unknown[] | undefined }> = [];
  readonly releasedClients: number[] = [];
  private clientCount = 0;

  constructor(
    private readonly rows: {
      usage?: Row[];
      accounts?: Row[];
      quotas?: Row[];
      schema?: Row[];
    },
  ) {}

  async query<RowType extends Row = Row>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: RowType[] }> {
    this.calls.push({ text, values });
    if (text.includes("information_schema.columns")) {
      return { rows: (this.rows.schema ?? completeSchema) as RowType[] };
    }
    if (text.includes('FROM "public"."usage_logs"')) {
      const cursor = values?.[0];
      const usage = (this.rows.usage ?? []).filter((row) => {
        if (cursor === null || cursor === undefined) {
          return true;
        }
        return BigInt(String(row.id)) > BigInt(String(cursor));
      });
      return { rows: usage as RowType[] };
    }
    if (text.includes("codex_5h_used_percent")) {
      return { rows: (this.rows.quotas ?? []) as RowType[] };
    }
    if (text.includes('FROM "public"."accounts"')) {
      return { rows: (this.rows.accounts ?? []) as RowType[] };
    }
    return { rows: [] as RowType[] };
  }

  async connect(): Promise<Sub2ApiQueryClient> {
    const clientId = ++this.clientCount;
    return {
      query: this.query.bind(this),
      release: () => this.releasedClients.push(clientId),
    };
  }
}

function connectorFor(
  pool: FakePool,
  sourceId = "sub2api-test",
): ReturnType<typeof createSub2ApiConnector> {
  return createSub2ApiConnector({
    sourceId,
    connectionString: "postgres://readonly.invalid/sub2api",
    pool,
  });
}

describe("Sub2API read-only connector", () => {
  test("idle pool errors are handled and connector close releases its listener", async () => {
    const pool = new Pool();
    const errors: unknown[] = [];
    const connector = createSub2ApiConnector({
      sourceId: "idle-test",
      connectionString: "",
      pool,
      onBackgroundError: (error) => {
        errors.push(error);
        throw new Error("sink failed");
      },
    });
    try {
      const error = Object.assign(new Error("connection closed"), {
        code: "ECONNRESET",
      });
      expect(() => pool.emit("error", error)).not.toThrow();
      expect(errors).toEqual([error]);
      expect(pool.listenerCount("error")).toBe(1);
      await connector.close();
      expect(pool.listenerCount("error")).toBe(0);
    } finally {
      await connector.close();
      await pool.end();
    }
  });

  test("response audit fields persist without selecting the response model for pricing", async () => {
    const pool = new FakePool({
      usage: [
        {
          id: "1",
          account_id: "2",
          model: "gpt-6-astra",
          created_at: "2026-09-01T00:00:00Z",
          upstream_response_model: "response-alias",
          upstream_model_mismatch: false,
          requested_reasoning_effort: "max",
          reasoning_effort: "xhigh",
        },
      ],
    });
    const connector = connectorFor(pool);
    const page = await connector.readUsage(null, 10);
    const store = new LedgerStore(":memory:", defaultPriceBook);
    try {
      store.savePage(
        connector.sourceId,
        "incremental",
        page,
        "2026-09-01T00:01:00Z",
      );
      const fact = store.usage()[0]!.fact;
      expect(fact.model).toBe("gpt-6-astra");
      expect(fact.metadata.upstream_response_model).toBe("response-alias");
      expect(fact.metadata.upstream_model_mismatch).toBe(false);
      expect(fact.metadata.requested_reasoning_effort).toBe("max");
      expect(fact.metadata.reasoning_effort).toBe("xhigh");
    } finally {
      store.close();
      await connector.close();
    }
  });

  test("older schemas project NULL for unavailable optional audit columns", async () => {
    const pool = new FakePool({
      schema: completeSchema.filter(
        (row) =>
          ![
            "upstream_response_model",
            "upstream_model_mismatch",
            "reasoning_effort",
            "requested_reasoning_effort",
          ].includes(row.column_name!),
      ),
    });
    const connector = connectorFor(pool);
    await connector.readUsage(null, 10);
    const query = pool.calls.find((call) =>
      call.text.includes('FROM "public"."usage_logs"'),
    )!.text;
    expect(query).toContain('NULL::text AS "upstream_response_model"');
    expect(query).toContain('NULL::boolean AS "upstream_model_mismatch"');
    expect(query).toContain('NULL::text AS "reasoning_effort"');
    expect(query).toContain('NULL::text AS "requested_reasoning_effort"');
    await connector.close();
  });

  test("stores known reasoning effort metadata without affecting tier or tokens", async () => {
    const pool = new FakePool({
      usage: [
        {
          id: "1",
          account_id: "2",
          model: "gpt-6-astra",
          created_at: "2026-09-01T00:00:00Z",
          service_tier: "priority",
          reasoning_effort: "max",
          requested_reasoning_effort: "high",
          input_tokens: 10,
          output_tokens: 20,
        },
      ],
    });
    const connector = connectorFor(pool);

    const record = (await connector.readUsage(null, 1)).records[0]!;

    expect(record.tier).toBe("priority");
    expect(record.tokens).toEqual({
      input: 10,
      output: 20,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    });
    expect(record.metadata).toEqual({
      reasoning_effort: "max",
      requested_reasoning_effort: "high",
    });
    await connector.close();
  });

  test("normalizes image usage from metadata without dropping the raw fields", async () => {
    const pool = new FakePool({
      usage: [
        {
          id: "1",
          account_id: "2",
          model: "gpt-6-astra",
          created_at: "2026-09-01T00:00:00Z",
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 24,
          image_input_tokens: 12,
          image_output_tokens: 3,
        },
      ],
    });
    const connector = connectorFor(pool);

    const record = (await connector.readUsage(null, 1)).records[0]!;

    expect(record.tokens.cacheRead).toBe(24);
    expect(record.tokens.image).toEqual({
      input: 12,
      output: 3,
      cacheRead: null,
      cacheReadMode: "aggregate",
    });
    expect(record.metadata).toMatchObject({
      image_input_tokens: 12,
      image_output_tokens: 3,
    });
    await connector.close();
  });

  test("keeps missing, empty, and invalid reasoning effort values unknown", async () => {
    const pool = new FakePool({
      usage: [
        {
          id: "1",
          account_id: "2",
          model: "model",
          created_at: "2026-09-01T00:00:00Z",
          service_tier: "high",
        },
        {
          id: "2",
          account_id: "2",
          model: "model",
          created_at: "2026-09-01T00:01:00Z",
          reasoning_effort: "",
          requested_reasoning_effort: "not-a-reasoning-level",
        },
      ],
    });
    const connector = connectorFor(pool);

    const records = (await connector.readUsage(null, 2)).records;

    expect(records[0]!.tier).toBe("high");
    expect(records.map((record) => record.metadata)).toEqual([{}, {}]);
    await connector.close();
  });

  test("keeps cache buckets independent, preserves NULL tier, and paginates bigint ids exactly", async () => {
    const pool = new FakePool({
      usage: [
        {
          id: "9007199254740993",
          account_id: "9007199254740995",
          model: "stored-model",
          requested_model: "requested-model",
          upstream_model: "upstream-model",
          upstream_response_model: "response-model",
          upstream_model_mismatch: true,
          created_at: "2026-09-01T00:00:00Z",
          service_tier: null,
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_tokens: 30,
          cache_read_tokens: 40,
          cache_creation_5m_tokens: 11,
          cache_creation_1h_tokens: 19,
          total_cost: "0.456789",
          actual_cost: "0.123456",
          duration_ms: 80,
          first_token_ms: 12,
          billing_mode: "token",
          stream: true,
          request_type: 1,
          long_context_billing_applied: false,
        },
        {
          id: "9007199254740994",
          account_id: "9007199254740995",
          model: "next-model",
          requested_model: "next-requested",
          created_at: "2026-09-01T00:01:00Z",
        },
      ],
    });

    const connector = connectorFor(pool);
    const page = await connector.readUsage(null, 1);
    const record = page.records[0]!;

    expect(record.externalId).toBe("9007199254740993");
    expect(record.accountExternalId).toBe("9007199254740995");
    expect(record.model).toBe("upstream-model");
    expect(record.upstreamModel).toBe("upstream-model");
    expect(record.tier).toBeNull();
    expect(record.tokens).toEqual({
      input: 10,
      output: 20,
      cacheRead: 40,
      cacheWrite: 30,
      cacheWrite5m: 11,
      cacheWrite1h: 19,
      reasoning: null,
    });
    expect(record.gatewayCost).toBe("0.456789");
    expect(record.gatewayBilled).toBe("0.123456");
    expect(record.upstreamUsd).toBeNull();
    expect(record.metadata).toEqual({
      upstream_response_model: "response-model",
      upstream_model_mismatch: true,
      duration_ms: 80,
      first_token_ms: 12,
      billing_mode: "token",
      long_context_billing_applied: false,
      requested_model: "requested-model",
      stored_model: "stored-model",
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("9007199254740993");

    const nextPage = await connector.readUsage(page.nextCursor, 1);
    expect(nextPage.records[0]!.externalId).toBe("9007199254740994");
    expect(nextPage.records[0]!.model).toBe("next-model");
    expect(nextPage.records[0]!.metadata).toEqual({
      requested_model: "next-requested",
    });
    expect(nextPage.nextCursor).toBe("9007199254740994");
    expect(nextPage.hasMore).toBe(false);

    const emptyPage = await connector.readUsage(nextPage.nextCursor, 1);
    expect(emptyPage.records).toEqual([]);
    expect(emptyPage.nextCursor).toBe("9007199254740994");
    expect(emptyPage.hasMore).toBe(false);
    const usageCalls = pool.calls.filter((call) =>
      call.text.includes('FROM "public"."usage_logs"'),
    );
    expect(usageCalls[0]?.values?.[0]).toBeNull();
    expect(usageCalls[1]?.values?.[0]).toBe("9007199254740993");
    expect(usageCalls[2]?.values?.[0]).toBe("9007199254740994");
    expect(usageCalls[0]?.text).toContain('FROM "public"."usage_logs"');
    expect(pool.calls.some((call) => call.text.includes("SELECT *"))).toBe(
      false,
    );
    expect(
      pool.calls.some((call) =>
        call.text.includes("BEGIN TRANSACTION READ ONLY"),
      ),
    ).toBe(true);
  });

  test("maps missing and invalid optional values to null without inventing metrics", async () => {
    const pool = new FakePool({
      schema: completeSchema,
      usage: [
        {
          id: "1",
          account_id: "2",
          model: "model",
          created_at: "2026-09-01T00:00:00Z",
          input_tokens: "not-an-integer",
          output_tokens: null,
          cache_creation_tokens: "NaN",
          cache_read_tokens: undefined,
          cache_creation_5m_tokens: "9007199254740993",
          cache_creation_1h_tokens: -1,
          duration_ms: "bad",
          image_input_tokens: null,
          billing_mode: "",
          long_context_billing_applied: "unknown",
          upstream_response_model: "",
          upstream_model_mismatch: "unknown",
        },
      ],
    });

    const connector = connectorFor(pool);
    const record = (await connector.readUsage(null, 2)).records[0]!;

    expect(record.tokens).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    });
    expect(record.metadata).toEqual({});
  });

  test("keeps shadow parent ids and hashes optional ChatGPT identity claims", async () => {
    const accountClaim = "chatgpt-account-secret";
    const userClaim = "chatgpt-user-secret";
    const pool = new FakePool({
      accounts: [
        {
          id: "9007199254740993",
          name: "shadow",
          platform: "openai",
          type: "oauth",
          parent_account_id: "9007199254740992",
          plan_type: "plus",
          subject_account_id: accountClaim,
          subject_user_id: userClaim,
        },
      ],
    });

    const account = (await connectorFor(pool).readAccounts())[0]!;
    expect(account.externalId).toBe("9007199254740993");
    expect(account.parentExternalId).toBe("9007199254740992");
    expect(account.platform).toBe("openai");
    expect(account.kind).toBe("subscription");
    expect(account.plan).toBe("plus");
    expect(account.subjectKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(account.subjectKey).not.toContain(accountClaim);
    expect(account.subjectKey).not.toContain(userClaim);

    const accountsCall = pool.calls.find((call) =>
      call.text.includes('FROM "public"."accounts"'),
    );
    expect(accountsCall?.text).not.toMatch(/SELECT\s+[^\n]*credentials\s*,/i);
    expect(accountsCall?.text).toContain("credentials");
  });

  test("reads canonical 5h/7d quotas independently and preserves stale or invalid values", async () => {
    const staleAt = "2026-08-01T00:00:00.000Z";
    const staleReset = "2026-08-02T00:00:00.000Z";
    const pool = new FakePool({
      quotas: [
        {
          id: "7",
          codex_5h_used_percent: "not-a-percent",
          codex_5h_reset_at: "not-a-date",
          codex_5h_window_minutes: "0",
          codex_7d_used_percent: "75.5",
          codex_7d_reset_at: staleReset,
          codex_7d_window_minutes: "10080",
          codex_usage_updated_at: staleAt,
        },
      ],
    });

    const quotas = await connectorFor(pool).readQuotas!();
    expect(quotas).toEqual([
      {
        sourceId: "sub2api-test",
        externalId: "7:five-hour",
        accountExternalId: "7",
        window: "five-hour",
        percent: null,
        sampledAt: staleAt,
        resetsAt: null,
        windowMinutes: null,
      },
      {
        sourceId: "sub2api-test",
        externalId: "7:seven-day",
        accountExternalId: "7",
        window: "seven-day",
        percent: 75.5,
        sampledAt: staleAt,
        resetsAt: staleReset,
        windowMinutes: 10080,
      },
    ]);
  });

  test("treats quota extra and account identity columns as optional schema features", async () => {
    const oldSchema = completeSchema.filter(
      (row) =>
        !(
          row.table_name === "accounts" &&
          ["extra", "credentials", "parent_account_id"].includes(
            String(row.column_name),
          )
        ),
    );
    const pool = new FakePool({
      schema: oldSchema,
      accounts: [
        {
          id: "1",
          name: "legacy",
          platform: "openai",
          type: "api_key",
        },
      ],
    });
    const connector = connectorFor(pool);

    const accounts = await connector.readAccounts();
    expect(accounts[0]!.parentExternalId).toBeNull();
    expect(accounts[0]!.subjectKey).toBeNull();
    expect(await connector.readQuotas!()).toEqual([]);
    expect(
      pool.calls.some((call) => call.text.includes("codex_5h_used_percent")),
    ).toBe(false);
  });

  test("reports missing required schema columns with a readable error", async () => {
    const schema = completeSchema.filter(
      (row) =>
        !(row.table_name === "usage_logs" && row.column_name === "created_at"),
    );
    const connector = connectorFor(new FakePool({ schema }));

    await expect(connector.readUsage(null, 1)).rejects.toThrow(
      "usage_logs.created_at",
    );
  });

  test("keeps the terminal cursor across two SyncRunner polls", async () => {
    const sourceId = "sub2api-sync-test";
    const records: UsageFact[] = ["1", "2"].map((externalId) => ({
      sourceId,
      externalId,
      accountExternalId: "10",
      occurredAt: "2026-09-08T00:00:00.000Z",
      model: "unpriced-test-model",
      upstreamModel: null,
      tier: null,
      tokens: {
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: null,
      },
      gatewayCost: null,
      gatewayBilled: null,
      upstreamUsd: null,
      upstreamCredits: null,
      metadata: {},
    }));
    const calls: Array<{ cursor: string | null; ids: string[] }> = [];
    const connector: UsageConnector = {
      sourceId,
      readAccounts: async () => [],
      close: async () => {},
      readUsage: async (cursor) => {
        const pageRecords = records.filter(
          (record) =>
            cursor === null || BigInt(record.externalId) > BigInt(cursor),
        );
        calls.push({
          cursor,
          ids: pageRecords.map((record) => record.externalId),
        });
        return {
          records: pageRecords,
          nextCursor: pageRecords.at(-1)?.externalId ?? cursor,
          hasMore: false,
        };
      },
    };
    const book: PriceBook = {
      schemaVersion: 1,
      id: "sub2api-sync-test",
      version: "v1",
      unit: "per_million_tokens",
      publishedAt: "2026-01-01T00:00:00Z",
      sources: ["test fixture"],
      rules: [],
    };
    const store = new LedgerStore(":memory:", book);
    store.setState(`${sourceId}:status`, {
      lastAttempt: null,
      lastSuccess: null,
      error: null,
      initialComplete: false,
      initialCompleteAt: null,
      lastSweep: "2026-09-08T00:00:00.000Z",
    });
    const runner = new SyncRunner(connector, store, {
      intervalMs: 30_000,
      sweepMs: 24 * 60 * 60 * 1000,
      pageSize: 100,
      pagesPerPoll: 1,
    });

    try {
      await runner.poll("2026-09-08T01:00:00.000Z");
      await runner.poll("2026-09-08T01:00:01.000Z");

      expect(calls).toEqual([
        { cursor: null, ids: ["1", "2"] },
        { cursor: "2", ids: [] },
      ]);
      expect(store.usage()).toHaveLength(2);
      expect(store.getState<string>(`${sourceId}:incremental:cursor`)).toBe(
        "2",
      );
    } finally {
      await runner.stop();
      store.close();
    }
  });
});
