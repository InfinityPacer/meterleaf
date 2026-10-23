import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPriceBook } from "../src/domain/default-prices";
import type { UsageFact } from "../src/domain/connector";
import { LedgerStore } from "../src/storage/ledger";
import {
  DATABASE_REQUEST_ACCOUNTS_REVISION,
  DATABASE_SCHEMA_REVISION,
} from "../src/storage/schema";

const sourceId = "claude-code-test";
const oldNow = "2026-10-23T12:00:00.000Z";

function usage(overrides: Partial<UsageFact> = {}): UsageFact {
  return {
    sourceId,
    externalId: "req_1:msg_1",
    accountExternalId: "timeline-account",
    occurredAt: "2026-10-23T11:00:00.000Z",
    model: "claude-opus-5-5",
    upstreamModel: null,
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
    gatewayCost: null,
    gatewayBilled: null,
    upstreamUsd: null,
    upstreamCredits: null,
    metadata: { attribution: "timeline" },
    ...overrides,
  };
}

function batch(
  facts: readonly UsageFact[],
  batchId: string = crypto.randomUUID(),
) {
  return {
    batchId,
    collector: { name: "meterleaf-collector", version: "test" },
    accounts: [],
    usage: facts,
    quotas: [],
  };
}

function saved(store: LedgerStore, externalId: string): UsageFact {
  const row = store.usage().find((item) => item.fact.externalId === externalId);
  if (!row) throw new Error(`missing fact ${externalId}`);
  return row.fact;
}

function request(store: LedgerStore, requestId: string, receivedAt: string) {
  store.db
    .query(
      "INSERT INTO request_accounts (source_id, request_id, account_uuid, received_at) VALUES (?, ?, ?, ?)",
    )
    .run(sourceId, requestId, "otel-account", receivedAt);
}

function cleanupStore(onExpired?: (removed: number) => void) {
  return new LedgerStore(":memory:", defaultPriceBook, {
    onRequestAccountsExpired: onExpired,
  });
}

function requestIds(store: LedgerStore): string[] {
  return store.db
    .query<{ request_id: string }, []>(
      "SELECT request_id FROM request_accounts ORDER BY request_id",
    )
    .all()
    .map((row) => row.request_id);
}

test("OTEL 先到、用量后到，请求归属记录过期后重发仍保持 OTEL 账户", () => {
  const store = cleanupStore();
  try {
    store.saveRequestAccounts(
      sourceId,
      [
        {
          requestId: "req_1",
          accountUuid: "otel-account",
          organizationUuid: "otel-org",
          sessionId: null,
          model: null,
          occurredAt: null,
        },
      ],
      oldNow,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), oldNow);
    let fact = saved(store, "req_1:msg_1");
    expect(fact.accountExternalId).toBe("otel-account");
    expect(fact.metadata.attribution).toBe("otel");

    // 模拟超过 30 天保留期后请求归属记录被清理。
    store.db.exec("DELETE FROM request_accounts");
    const revision = store.revision();
    store.saveIngestBatch(
      sourceId,
      batch([usage()]),
      "2026-11-25T12:00:00.000Z",
    );
    fact = saved(store, "req_1:msg_1");
    expect(fact.accountExternalId).toBe("otel-account");
    expect(fact.metadata.attribution).toBe("otel");
    // 重放内容没有变化，报表索引不会因这次写入失效。
    expect(store.revision()).toBe(revision);
  } finally {
    store.close();
  }
});

test("用量先到、OTEL 后到，请求归属记录过期后重发仍保持 OTEL 账户", () => {
  const store = cleanupStore();
  try {
    store.saveIngestBatch(sourceId, batch([usage()]), oldNow);
    expect(saved(store, "req_1:msg_1").accountExternalId).toBe(
      "timeline-account",
    );

    const result = store.saveRequestAccounts(
      sourceId,
      [
        {
          requestId: "req_1",
          accountUuid: "otel-account",
          organizationUuid: "otel-org",
          sessionId: null,
          model: null,
          occurredAt: null,
        },
      ],
      oldNow,
    );
    expect(result.rewritten).toBe(1);
    let fact = saved(store, "req_1:msg_1");
    expect(fact.accountExternalId).toBe("otel-account");
    expect(fact.metadata.attribution).toBe("otel");

    store.db.exec("DELETE FROM request_accounts");
    store.saveIngestBatch(
      sourceId,
      batch([usage()]),
      "2026-11-25T12:00:00.000Z",
    );
    fact = saved(store, "req_1:msg_1");
    expect(fact.accountExternalId).toBe("otel-account");
    expect(fact.metadata.attribution).toBe("otel");
  } finally {
    store.close();
  }
});

test("模型映射优先于已保存的 OTEL 归属", () => {
  const store = cleanupStore();
  try {
    store.saveRequestAccounts(
      sourceId,
      [
        {
          requestId: "req_1",
          accountUuid: "otel-account",
          organizationUuid: null,
          sessionId: null,
          model: null,
          occurredAt: null,
        },
      ],
      oldNow,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), oldNow);
    expect(saved(store, "req_1:msg_1").metadata.attribution).toBe("otel");

    store.saveIngestBatch(
      sourceId,
      batch([
        usage({
          accountExternalId: "mapped-account",
          metadata: { attribution: "model" },
        }),
      ]),
      "2026-10-23T12:01:00.000Z",
    );
    const fact = saved(store, "req_1:msg_1");
    expect(fact.accountExternalId).toBe("mapped-account");
    expect(fact.metadata.attribution).toBe("model");
  } finally {
    store.close();
  }
});

test("内容没变的重放不产生变更，带 otel 标记的事实也一样", () => {
  const store = cleanupStore();
  try {
    store.saveIngestBatch(sourceId, batch([usage()]), oldNow);
    store.saveRequestAccounts(
      sourceId,
      [
        {
          requestId: "req_1",
          accountUuid: "otel-account",
          organizationUuid: null,
          sessionId: null,
          model: null,
          occurredAt: null,
        },
      ],
      oldNow,
    );
    const revision = store.revision();
    const changes = store.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM usage_change_log",
      )
      .get()!.count;

    // 先重放 OTEL 事实本身，再重放带登录时间线归属的同一内容。
    store.saveRequestAccounts(
      sourceId,
      [
        {
          requestId: "req_1",
          accountUuid: "otel-account",
          organizationUuid: null,
          sessionId: null,
          model: null,
          occurredAt: null,
        },
      ],
      "2026-10-23T12:00:30.000Z",
    );
    store.saveIngestBatch(
      sourceId,
      batch([usage()], "same-batch"),
      "2026-10-23T12:01:00.000Z",
    );

    expect(saved(store, "req_1:msg_1").metadata.attribution).toBe("otel");
    expect(store.revision()).toBe(revision);
    expect(
      store.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM usage_change_log",
        )
        .get()!.count,
    ).toBe(changes);
  } finally {
    store.close();
  }
});

test("迁移为已覆盖的事实补上 otel 标记，未覆盖的事实不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-otel-attribution-"));
  try {
    const path = join(dir, "ledger.sqlite");
    const store = new LedgerStore(path, defaultPriceBook);
    try {
      store.saveIngestBatch(
        sourceId,
        batch([
          usage(),
          usage({
            externalId: "req_2:msg_2",
            accountExternalId: "other-account",
          }),
        ]),
        oldNow,
      );
      store.saveRequestAccounts(
        sourceId,
        [
          {
            requestId: "req_1",
            accountUuid: "otel-account",
            organizationUuid: null,
            sessionId: null,
            model: null,
            occurredAt: null,
          },
        ],
        oldNow,
      );
      // 模拟上一修订里没有 otel 标记的 payload。
      store.db.exec(
        "UPDATE usage_facts SET payload=json_remove(payload, '$.metadata.attribution')",
      );
      store.db
        .query("DELETE FROM schema_revisions WHERE revision=?")
        .run(DATABASE_SCHEMA_REVISION);
      expect(
        store.db
          .query<{ revision: string }, []>(
            "SELECT revision FROM schema_revisions",
          )
          .all()
          .map((row) => row.revision),
      ).toContain(DATABASE_REQUEST_ACCOUNTS_REVISION);
    } finally {
      store.close();
    }

    const upgraded = new LedgerStore(path, defaultPriceBook);
    try {
      const overridden = saved(upgraded, "req_1:msg_1");
      expect(overridden.accountExternalId).toBe("otel-account");
      expect(overridden.metadata.attribution).toBe("otel");

      const untouched = saved(upgraded, "req_2:msg_2");
      expect(untouched.accountExternalId).toBe("other-account");
      expect(untouched.metadata.attribution).toBeUndefined();

      expect(
        upgraded.db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='request_accounts_received_at'",
          )
          .get()?.name,
      ).toBe("request_accounts_received_at");
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("清理删除超过 30 天的请求归属记录，并每小时只执行一次", () => {
  const expired: number[] = [];
  const store = cleanupStore((removed) => expired.push(removed));
  try {
    request(store, "old_1", "2026-01-01T00:00:00.000Z");
    request(store, "old_2", "2026-02-01T00:00:00.000Z");
    request(store, "recent", "2026-10-01T00:00:00.000Z");

    store.saveIngestBatch(sourceId, batch([usage()]), oldNow);
    expect(requestIds(store)).toEqual(["recent"]);
    expect(expired).toEqual([2]);

    // 一小时内再次写入不会执行 DELETE。
    request(store, "old_3", "2026-01-15T00:00:00.000Z");
    store.saveIngestBatch(
      sourceId,
      batch([usage({ externalId: "req_3:msg_3" })]),
      "2026-10-23T12:30:00.000Z",
    );
    expect(requestIds(store)).toContain("old_3");
    expect(expired).toEqual([2]);

    // 超过一小时后重新检查并删除。
    store.saveIngestBatch(
      sourceId,
      batch([usage({ externalId: "req_4:msg_4" })]),
      "2026-10-23T13:01:00.000Z",
    );
    expect(requestIds(store)).toEqual(["recent"]);
    expect(expired).toEqual([2, 1]);
  } finally {
    store.close();
  }
});

test("超过 1 万条过期记录按批删除，未过期记录保留", () => {
  const expired: number[] = [];
  const store = cleanupStore((removed) => expired.push(removed));
  try {
    const insert = store.db.query(
      "INSERT INTO request_accounts (source_id, request_id, account_uuid, received_at) VALUES (?, ?, ?, ?)",
    );
    store.db.transaction(() => {
      for (let index = 0; index < 10_001; index += 1)
        insert.run(
          sourceId,
          `old_${index}`,
          "otel-account",
          "2026-01-01T00:00:00.000Z",
        );
      insert.run(
        sourceId,
        "recent",
        "otel-account",
        "2026-10-01T00:00:00.000Z",
      );
    })();

    store.saveIngestBatch(sourceId, batch([usage()]), oldNow);
    expect(expired).toEqual([10_001]);
    expect(requestIds(store)).toEqual(["recent"]);
  } finally {
    store.close();
  }
});
