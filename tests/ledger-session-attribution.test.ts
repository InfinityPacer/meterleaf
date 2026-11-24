import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPriceBook } from "../src/domain/default-prices";
import type { UsageFact } from "../src/domain/connector";
import type { OtelRequestAccount } from "../src/shared/otel";
import { LedgerStore, SESSION_BRACKET_WINDOW_MS } from "../src/storage/ledger";
import {
  DATABASE_OTEL_ATTRIBUTION_REVISION,
  DATABASE_SCHEMA_REVISION,
} from "../src/storage/schema";

const sourceId = "claude-code-test";
const session = "sess-bracket";
const receivedAt = "2026-10-23T12:00:00.000Z";

function at(minute: number, second = 0): string {
  return new Date(
    Date.UTC(2026, 9, 23, 10, 0, 0) + minute * 60_000 + second * 1000,
  ).toISOString();
}

function usage(overrides: Partial<UsageFact> = {}): UsageFact {
  return {
    sourceId,
    externalId: "req_gap:msg_gap",
    accountExternalId: "unattributed",
    occurredAt: at(10),
    model: "claude-opus-5-5",
    upstreamModel: null,
    tier: "standard",
    tokens: {
      input: 1_000,
      output: 200,
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
    metadata: { session_id: session, attribution: "timeline" },
    ...overrides,
  };
}

function otel(
  requestId: string,
  accountUuid: string | null,
  occurredAt: string | null,
  sessionId: string | null = session,
): OtelRequestAccount {
  return {
    requestId,
    accountUuid,
    organizationUuid: accountUuid ? `org-${accountUuid}` : null,
    sessionId,
    model: "claude-opus-5-5",
    occurredAt,
  };
}

function batch(facts: readonly UsageFact[]) {
  return {
    batchId: crypto.randomUUID(),
    collector: { name: "meterleaf-collector", version: "test" },
    accounts: [],
    usage: facts,
    quotas: [],
  };
}

function saved(store: LedgerStore, externalId = "req_gap:msg_gap") {
  // 直接读事实表：usage() 的默认时间上界是文本 "9999"，会漏掉 9999 年的边界用例。
  const row = store.db
    .query<{ account_id: string; payload: string }, [string]>(
      "SELECT account_id, payload FROM usage_facts WHERE external_id=?",
    )
    .get(externalId);
  if (!row) throw new Error(`missing fact ${externalId}`);
  const fact = JSON.parse(row.payload) as UsageFact;
  expect(row.account_id).toBe(fact.accountExternalId);
  return fact;
}

function changeCount(store: LedgerStore): number {
  return store.db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM usage_change_log",
    )
    .get()!.count;
}

function withStore(run: (store: LedgerStore) => void) {
  const store = new LedgerStore(":memory:", defaultPriceBook);
  try {
    run(store);
  } finally {
    store.close();
  }
}

test("同会话前后同账户且都在窗口内时推断为 session 归属", () => {
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [otel("req_prev", "acct-a", at(0)), otel("req_next", "acct-a", at(30))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    const fact = saved(store);
    expect(fact.accountExternalId).toBe("acct-a");
    expect(fact.metadata.attribution).toBe("session");
    expect(fact.metadata.session_id).toBe(session);
    // 推断出的账户尚未由采集器推来资料时补一条占位账户。
    expect(
      store.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM accounts WHERE external_id='acct-a'",
        )
        .get()?.external_id,
    ).toBe("acct-a");

    // 没有请求 ID 的 nr: 用量同样按会话推断。
    store.saveIngestBatch(
      sourceId,
      batch([usage({ externalId: `nr:${session}:msg_nr` })]),
      receivedAt,
    );
    expect(saved(store, `nr:${session}:msg_nr`).metadata.attribution).toBe(
      "session",
    );
  });
});

test("缺一侧邻居、两侧账户不同、超出窗口或缺会话 ID 时保持未归属", () => {
  const cases: {
    name: string;
    records: OtelRequestAccount[];
    fact?: Partial<UsageFact>;
  }[] = [
    { name: "只有前邻居", records: [otel("p", "acct-a", at(5))] },
    { name: "只有后邻居", records: [otel("n", "acct-a", at(15))] },
    {
      name: "两侧账户不同",
      records: [otel("p", "acct-a", at(5)), otel("n", "acct-b", at(15))],
    },
    {
      name: "前邻居超出窗口",
      records: [otel("p", "acct-a", at(-20, -1)), otel("n", "acct-a", at(15))],
    },
    {
      name: "后邻居超出窗口",
      records: [otel("p", "acct-a", at(5)), otel("n", "acct-a", at(40, 1))],
    },
    {
      name: "邻居属于其他会话",
      records: [
        otel("p", "acct-a", at(5), "other"),
        otel("n", "acct-a", at(15), "other"),
      ],
    },
    {
      name: "邻居缺账户或时间",
      records: [otel("p", null, at(5)), otel("n", "acct-a", null)],
    },
    {
      name: "用量缺会话 ID",
      records: [otel("p", "acct-a", at(5)), otel("n", "acct-a", at(15))],
      fact: { metadata: { attribution: "timeline" } },
    },
    {
      name: "采集器已给出时间线账户",
      records: [otel("p", "acct-a", at(5)), otel("n", "acct-a", at(15))],
      fact: { accountExternalId: "timeline-account" },
    },
  ];
  for (const item of cases) {
    for (const order of ["otel-first", "usage-first"] as const) {
      withStore((store) => {
        const fact = usage(item.fact);
        if (order === "otel-first") {
          store.saveRequestAccounts(sourceId, item.records, receivedAt);
          store.saveIngestBatch(sourceId, batch([fact]), receivedAt);
        } else {
          store.saveIngestBatch(sourceId, batch([fact]), receivedAt);
          const result = store.saveRequestAccounts(
            sourceId,
            item.records,
            receivedAt,
          );
          expect(result.rewritten).toBe(0);
        }
        const stored = saved(store);
        expect({
          name: item.name,
          order,
          account: stored.accountExternalId,
        }).toEqual({ name: item.name, order, account: fact.accountExternalId });
        expect(stored.metadata.attribution).toBe("timeline");
      });
    }
  }
});

test("窗口边界正好 30 分钟时仍可推断", () => {
  withStore((store) => {
    expect(SESSION_BRACKET_WINDOW_MS).toBe(30 * 60 * 1000);
    store.saveRequestAccounts(
      sourceId,
      [otel("p", "acct-a", at(-20)), otel("n", "acct-a", at(40))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    expect(saved(store).metadata.attribution).toBe("session");
  });
});

test("跨账号 --resume：切换点上的缺失请求保持未归属，远离切换点的照常推断", () => {
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [
        otel("a1", "acct-a", at(0)),
        otel("a2", "acct-a", at(10)),
        otel("b1", "acct-b", at(20)),
        otel("b2", "acct-b", at(30)),
      ],
      receivedAt,
    );
    store.saveIngestBatch(
      sourceId,
      batch([
        usage({ externalId: "gap_a:msg", occurredAt: at(5) }),
        usage({ externalId: "gap_switch:msg", occurredAt: at(15) }),
        usage({ externalId: "gap_b:msg", occurredAt: at(25) }),
      ]),
      receivedAt,
    );
    expect(saved(store, "gap_a:msg").accountExternalId).toBe("acct-a");
    expect(saved(store, "gap_a:msg").metadata.attribution).toBe("session");
    expect(saved(store, "gap_switch:msg").accountExternalId).toBe(
      "unattributed",
    );
    expect(saved(store, "gap_switch:msg").metadata.attribution).toBe(
      "timeline",
    );
    expect(saved(store, "gap_b:msg").accountExternalId).toBe("acct-b");
    expect(saved(store, "gap_b:msg").metadata.attribution).toBe("session");
  });
});

test("后邻居晚于用量到达时回查补推断，并递增 revision 与变更日志", () => {
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [otel("req_prev", "acct-a", at(0))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    expect(saved(store).accountExternalId).toBe("unattributed");
    const revision = store.revision();
    const changes = changeCount(store);

    const result = store.saveRequestAccounts(
      sourceId,
      [otel("req_next", "acct-a", at(20))],
      receivedAt,
    );
    expect(result.rewritten).toBe(1);
    const fact = saved(store);
    expect(fact.accountExternalId).toBe("acct-a");
    expect(fact.metadata.attribution).toBe("session");
    expect(store.revision()).toBeGreaterThan(revision);
    expect(changeCount(store)).toBeGreaterThan(changes);
    expect(
      store.db
        .query<{ account_id: string }, []>(
          "SELECT account_id FROM usage_facts WHERE external_id='req_gap:msg_gap'",
        )
        .get()?.account_id,
    ).toBe("acct-a");

    // 同一 OTEL 再到达时没有可改写的用量，不空转 revision。
    const settled = store.revision();
    const settledChanges = changeCount(store);
    expect(
      store.saveRequestAccounts(
        sourceId,
        [otel("req_next", "acct-a", at(20))],
        receivedAt,
      ).rewritten,
    ).toBe(0);
    expect(store.revision()).toBe(settled);
    expect(changeCount(store)).toBe(settledChanges);
  });
});

test("精确 OTEL 晚到时把 session 推断升级为 otel，并可更正账户", () => {
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [otel("req_prev", "acct-a", at(0)), otel("req_next", "acct-a", at(20))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    expect(saved(store).metadata.attribution).toBe("session");

    const result = store.saveRequestAccounts(
      sourceId,
      [otel("req_gap", "acct-exact", at(10))],
      receivedAt,
    );
    expect(result.rewritten).toBe(1);
    let fact = saved(store);
    expect(fact.accountExternalId).toBe("acct-exact");
    expect(fact.metadata.attribution).toBe("otel");

    // 映射过期后重放，即使前后邻居仍指向另一账户，otel 也不被降级为 session。
    store.db
      .query("DELETE FROM request_accounts WHERE request_id='req_gap'")
      .run();
    const revision = store.revision();
    const changes = changeCount(store);
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    fact = saved(store);
    expect(fact.accountExternalId).toBe("acct-exact");
    expect(fact.metadata.attribution).toBe("otel");
    expect(store.revision()).toBe(revision);
    expect(changeCount(store)).toBe(changes);
  });
});

test("精确 OTEL 先到时，重放的 session 用量直接升级为 otel", () => {
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [otel("req_prev", "acct-a", at(0)), otel("req_next", "acct-a", at(20))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    expect(saved(store).metadata.attribution).toBe("session");
    // 直接写入映射而不触发回查，验证 writeFacts 自身的升级路径。
    store.db
      .query(
        "INSERT INTO request_accounts (source_id, request_id, account_uuid, received_at) VALUES (?, 'req_gap', 'acct-exact', ?)",
      )
      .run(sourceId, receivedAt);
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    const fact = saved(store);
    expect(fact.accountExternalId).toBe("acct-exact");
    expect(fact.metadata.attribution).toBe("otel");
  });
});

test("模型映射优先于 session 推断与精确 OTEL", () => {
  withStore((store) => {
    const mapped = usage({
      accountExternalId: "mapped-account",
      metadata: { session_id: session, attribution: "model" },
    });
    store.saveRequestAccounts(
      sourceId,
      [otel("req_prev", "acct-a", at(0)), otel("req_next", "acct-a", at(20))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([mapped]), receivedAt);
    expect(saved(store).accountExternalId).toBe("mapped-account");
    expect(saved(store).metadata.attribution).toBe("model");

    store.saveRequestAccounts(
      sourceId,
      [otel("req_gap", "acct-exact", at(10))],
      receivedAt,
    );
    expect(saved(store).accountExternalId).toBe("mapped-account");
    expect(saved(store).metadata.attribution).toBe("model");

    // 已推断为 session 的用量之后被模型映射改写时，以映射为准。
    store.saveRequestAccounts(
      sourceId,
      [
        otel("req_p2", "acct-a", at(0), "sess-2"),
        otel("req_n2", "acct-a", at(20), "sess-2"),
      ],
      receivedAt,
    );
    store.saveIngestBatch(
      sourceId,
      batch([
        usage({
          externalId: `nr:${session}:msg_m`,
          occurredAt: at(5),
          metadata: { session_id: "sess-2", attribution: "timeline" },
        }),
      ]),
      receivedAt,
    );
    expect(saved(store, `nr:${session}:msg_m`).metadata.attribution).toBe(
      "session",
    );
    store.saveIngestBatch(
      sourceId,
      batch([
        usage({
          externalId: `nr:${session}:msg_m`,
          occurredAt: at(5),
          accountExternalId: "mapped-account",
          metadata: { session_id: "sess-2", attribution: "model" },
        }),
      ]),
      receivedAt,
    );
    expect(saved(store, `nr:${session}:msg_m`).accountExternalId).toBe(
      "mapped-account",
    );
    expect(saved(store, `nr:${session}:msg_m`).metadata.attribution).toBe(
      "model",
    );
  });
});

test("请求归属记录过期后重放未归属用量，session 归属不回退且不空转", () => {
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [otel("req_prev", "acct-a", at(0)), otel("req_next", "acct-a", at(20))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    expect(saved(store).metadata.attribution).toBe("session");

    store.db.exec("DELETE FROM request_accounts");
    const revision = store.revision();
    const changes = changeCount(store);
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    const fact = saved(store);
    expect(fact.accountExternalId).toBe("acct-a");
    expect(fact.metadata.attribution).toBe("session");
    expect(store.revision()).toBe(revision);
    expect(changeCount(store)).toBe(changes);

    // 两侧邻居换成另一账户后重放，已保存的 session 结论保持不变。
    store.saveRequestAccounts(
      sourceId,
      [otel("req_p2", "acct-b", at(1)), otel("req_n2", "acct-b", at(19))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    expect(saved(store).accountExternalId).toBe("acct-a");
    expect(saved(store).metadata.attribution).toBe("session");
  });
});

test("已有账本重开时补齐夹逼索引，数据与 revision 不变且可重复打开", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-session-attribution-"));
  try {
    const path = join(dir, "ledger.sqlite");
    const indexNames = (store: LedgerStore) =>
      store.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('request_accounts_session_time', 'usage_facts_unattributed_session') ORDER BY name",
        )
        .all()
        .map((row) => row.name);
    const revisions = (store: LedgerStore) =>
      store.db
        .query<{ revision: string }, []>(
          "SELECT revision FROM schema_revisions ORDER BY revision",
        )
        .all()
        .map((row) => row.revision);

    let payloads: string[];
    const legacy = new LedgerStore(path, defaultPriceBook);
    try {
      legacy.saveIngestBatch(
        sourceId,
        batch([
          usage(),
          usage({ externalId: "req_x:msg_x", accountExternalId: "acct-x" }),
        ]),
        receivedAt,
      );
      // 模拟尚无夹逼索引、停在上一 revision 的旧账本。
      legacy.db.exec(`
        DROP INDEX request_accounts_session_time;
        DROP INDEX usage_facts_unattributed_session;
      `);
      legacy.db
        .query("DELETE FROM schema_revisions WHERE revision=?")
        .run(DATABASE_SCHEMA_REVISION);
      expect(indexNames(legacy)).toEqual([]);
      payloads = legacy
        .usage()
        .map((row) => JSON.stringify(row.fact))
        .sort();
    } finally {
      legacy.close();
    }

    for (let round = 0; round < 2; round++) {
      const upgraded = new LedgerStore(path, defaultPriceBook);
      try {
        expect(indexNames(upgraded)).toEqual([
          "request_accounts_session_time",
          "usage_facts_unattributed_session",
        ]);
        expect(revisions(upgraded)).toContain(DATABASE_SCHEMA_REVISION);
        expect(revisions(upgraded)).toContain(
          DATABASE_OTEL_ATTRIBUTION_REVISION,
        );
        expect(
          upgraded
            .usage()
            .map((row) => JSON.stringify(row.fact))
            .sort(),
        ).toEqual(payloads);

        // 回查语句命中未归属部分索引，邻居查询命中会话时间索引。
        const plan = (sql: string) =>
          upgraded.db
            .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
            .all()
            .map((row) => row.detail)
            .join("\n");
        expect(
          plan(
            `SELECT external_id FROM usage_facts WHERE source_id='s' AND json_extract(payload, '$.metadata.session_id')='x' AND account_id='unattributed' AND occurred_at>='a' AND occurred_at<='b'`,
          ),
        ).toContain("usage_facts_unattributed_session");
        // 与 sessionBracketAccount 的前、后邻居及并列检查语句一致。
        for (const order of ["DESC", "ASC"])
          expect(
            plan(
              `SELECT account_uuid, organization_uuid, occurred_at FROM request_accounts
                WHERE source_id='s' AND session_id='x' AND account_uuid IS NOT NULL
                  AND occurred_at IS NOT NULL AND occurred_at >= '0000-01-01T00:00:00.000Z' AND occurred_at <= '9999-12-31T23:59:59.999Z'
                ORDER BY occurred_at ${order} LIMIT 1`,
            ),
          ).toContain("request_accounts_session_time");
        expect(
          plan(
            `SELECT COUNT(DISTINCT account_uuid) AS accounts FROM request_accounts
              WHERE source_id='s' AND session_id='x' AND occurred_at='a'
                AND account_uuid IS NOT NULL`,
          ),
        ).toContain("request_accounts_session_time");
      } finally {
        upgraded.close();
      }
    }

    const readonly = new LedgerStore(path, defaultPriceBook, {
      readonly: true,
    });
    try {
      expect(readonly.usage()).toHaveLength(2);
    } finally {
      readonly.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("最近时刻并列着不同账户时保持未归属，单账户同刻照常命中", () => {
  const cases: { name: string; records: OtelRequestAccount[] }[] = [
    {
      name: "前侧同刻两账户（先 A 后 B）",
      records: [
        otel("p_a", "acct-a", at(5)),
        otel("p_b", "acct-b", at(5)),
        otel("n_a", "acct-a", at(15)),
      ],
    },
    {
      // 插入顺序反过来，LIMIT 1 无论取到哪条都必须由并列检查拦下。
      name: "前侧同刻两账户（先 B 后 A）",
      records: [
        otel("p_b", "acct-b", at(5)),
        otel("p_a", "acct-a", at(5)),
        otel("n_a", "acct-a", at(15)),
      ],
    },
    {
      name: "后侧同刻两账户",
      records: [
        otel("p_a", "acct-a", at(5)),
        otel("n_a", "acct-a", at(15)),
        otel("n_b", "acct-b", at(15)),
      ],
    },
    {
      name: "与用量同刻两账户",
      records: [otel("s_a", "acct-a", at(10)), otel("s_b", "acct-b", at(10))],
    },
  ];
  for (const item of cases) {
    for (const order of ["otel-first", "usage-first"] as const) {
      withStore((store) => {
        if (order === "otel-first") {
          store.saveRequestAccounts(sourceId, item.records, receivedAt);
          store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
        } else {
          store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
          expect(
            store.saveRequestAccounts(sourceId, item.records, receivedAt)
              .rewritten,
          ).toBe(0);
        }
        expect({
          name: item.name,
          order,
          account: saved(store).accountExternalId,
        }).toEqual({ name: item.name, order, account: "unattributed" });
      });
    }
  }

  // 同一账户的两条请求同刻并列、且与用量同刻时，零间隔仍命中。
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [otel("s_1", "acct-a", at(10)), otel("s_2", "acct-a", at(10))],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
    expect(saved(store).accountExternalId).toBe("acct-a");
    expect(saved(store).metadata.attribution).toBe("session");
  });
});

test("同一请求的 OTEL 分次补齐账户、会话与时间后触发回查", () => {
  for (const mode of ["separate-calls", "same-batch"] as const) {
    withStore((store) => {
      store.saveRequestAccounts(
        sourceId,
        [otel("req_prev", "acct-a", at(0))],
        receivedAt,
      );
      store.saveIngestBatch(sourceId, batch([usage()]), receivedAt);
      expect(saved(store).accountExternalId).toBe("unattributed");
      const revision = store.revision();
      const changes = changeCount(store);

      const accountOnly = otel("req_next", "acct-a", null, null);
      // 第二条没有账户也没有耗时，只带会话与时间。
      const timeOnly = otel("req_next", null, at(20));
      let rewritten = 0;
      if (mode === "separate-calls") {
        rewritten += store.saveRequestAccounts(
          sourceId,
          [accountOnly],
          receivedAt,
        ).rewritten;
        expect(saved(store).accountExternalId).toBe("unattributed");
        rewritten += store.saveRequestAccounts(
          sourceId,
          [timeOnly],
          receivedAt,
        ).rewritten;
      } else {
        rewritten = store.saveRequestAccounts(
          sourceId,
          [accountOnly, timeOnly],
          receivedAt,
        ).rewritten;
      }
      expect({ mode, rewritten }).toEqual({ mode, rewritten: 1 });
      expect(saved(store).accountExternalId).toBe("acct-a");
      expect(saved(store).metadata.attribution).toBe("session");
      expect(store.revision()).toBeGreaterThan(revision);
      expect(changeCount(store)).toBeGreaterThan(changes);
    });
  }
});

test("用量时间带时区偏移时，晚到的邻居同样回查命中", () => {
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [otel("req_prev", "acct-a", at(0))],
      receivedAt,
    );
    // 18:10+08:00 即 10:10Z。
    store.saveIngestBatch(
      sourceId,
      batch([usage({ occurredAt: "2026-10-23T18:10:00+08:00" })]),
      receivedAt,
    );
    expect(saved(store).accountExternalId).toBe("unattributed");
    const result = store.saveRequestAccounts(
      sourceId,
      [otel("req_next", "acct-a", at(20))],
      receivedAt,
    );
    expect(result.rewritten).toBe(1);
    expect(saved(store).accountExternalId).toBe("acct-a");
    expect(saved(store).metadata.attribution).toBe("session");
  });
});

test("接近四位年份上下界的时间不抛错、不回滚，并能正常推断", () => {
  for (const [prev, fact, next] of [
    [
      "9999-12-31T23:50:00.000Z",
      "9999-12-31T23:55:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ],
    [
      "0000-01-01T00:00:00.000Z",
      "0000-01-01T00:05:00.000Z",
      "0000-01-01T00:10:00.000Z",
    ],
  ] as const) {
    withStore((store) => {
      store.saveRequestAccounts(
        sourceId,
        [otel("req_prev", "acct-a", prev)],
        receivedAt,
      );
      store.saveIngestBatch(
        sourceId,
        batch([usage({ occurredAt: fact })]),
        receivedAt,
      );
      let result: { stored: number; rewritten: number } | undefined;
      expect(() => {
        result = store.saveRequestAccounts(
          sourceId,
          [otel("req_next", "acct-a", next)],
          receivedAt,
        );
      }).not.toThrow();
      expect(result).toEqual({ stored: 1, rewritten: 1 });
      expect(
        store.db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM request_accounts",
          )
          .get()!.count,
      ).toBe(2);
      expect(saved(store).accountExternalId).toBe("acct-a");
      expect(saved(store).metadata.attribution).toBe("session");
    });
  }
});

test("仅有耗时的 OTEL 加 session 推断后，映射过期重放无标记用量不空转", () => {
  withStore((store) => {
    store.saveRequestAccounts(
      sourceId,
      [
        otel("req_prev", "acct-a", at(0)),
        otel("req_next", "acct-a", at(20)),
        { ...otel("req_gap", null, null, null), durationMs: 1234 },
      ],
      receivedAt,
    );
    const raw = usage({ metadata: { session_id: session } });
    store.saveIngestBatch(sourceId, batch([raw]), receivedAt);
    const first = saved(store);
    expect(first.accountExternalId).toBe("acct-a");
    expect(first.metadata.attribution).toBe("session");
    expect(first.metadata.duration_ms).toBe(1234);

    store.db.exec("DELETE FROM request_accounts");
    const revision = store.revision();
    const dataRevision = store.db
      .query<{ value: string }, []>(
        "SELECT value FROM sync_state WHERE key='ledger:dataRevision'",
      )
      .get()?.value;
    const changes = changeCount(store);
    store.saveIngestBatch(sourceId, batch([raw]), receivedAt);
    expect(saved(store)).toEqual(first);
    expect(store.revision()).toBe(revision);
    expect(
      store.db
        .query<{ value: string }, []>(
          "SELECT value FROM sync_state WHERE key='ledger:dataRevision'",
        )
        .get()?.value,
    ).toBe(dataRevision);
    expect(changeCount(store)).toBe(changes);
  });
});

test("年份边界上带偏移或省略毫秒的用量时间，晚到邻居仍能回查命中", () => {
  for (const item of [
    {
      fact: "0000-01-01T00:00:00+00:00",
      early: otel("req_next", "acct-a", "0000-01-01T00:10:00.000Z"),
      late: otel("req_prev", "acct-a", "0000-01-01T00:00:00.000Z"),
    },
    {
      fact: "9999-12-31T23:59:59Z",
      early: otel("req_next", "acct-a", "9999-12-31T23:59:59.999Z"),
      late: otel("req_prev", "acct-a", "9999-12-31T23:50:00.000Z"),
    },
  ]) {
    withStore((store) => {
      store.saveRequestAccounts(sourceId, [item.early], receivedAt);
      store.saveIngestBatch(
        sourceId,
        batch([usage({ occurredAt: item.fact })]),
        receivedAt,
      );
      expect(saved(store).accountExternalId).toBe("unattributed");
      const result = store.saveRequestAccounts(
        sourceId,
        [item.late],
        receivedAt,
      );
      expect({ fact: item.fact, rewritten: result.rewritten }).toEqual({
        fact: item.fact,
        rewritten: 1,
      });
      expect(saved(store).accountExternalId).toBe("acct-a");
      expect(saved(store).metadata.attribution).toBe("session");
    });
  }
});

test("升级前落库的扩展年份邻居不参与推断，也不遮蔽合法邻居", () => {
  const legacy = (store: LedgerStore, requestId: string, at: string) =>
    store.db
      .query(
        "INSERT INTO request_accounts (source_id, request_id, account_uuid, session_id, occurred_at, received_at) VALUES (?, ?, 'acct-a', ?, ?, ?)",
      )
      .run(sourceId, requestId, session, at, receivedAt);
  const fact = usage({ occurredAt: "0000-01-01T00:00:00.000Z" });

  // 只有越界的前邻居：保持未归属。
  withStore((store) => {
    legacy(store, "req_old", "-000001-12-31T23:55:00.000Z");
    store.saveRequestAccounts(
      sourceId,
      [otel("req_next", "acct-a", "0000-01-01T00:05:00.000Z")],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([fact]), receivedAt);
    expect(saved(store).accountExternalId).toBe("unattributed");
  });

  // 越界行与合法前邻居并存：按合法邻居命中。
  withStore((store) => {
    legacy(store, "req_old", "-000001-12-31T23:55:00.000Z");
    legacy(store, "req_far", "+010000-01-01T00:00:00.000Z");
    store.saveRequestAccounts(
      sourceId,
      [
        otel("req_prev", "acct-a", "0000-01-01T00:00:00.000Z"),
        otel("req_next", "acct-a", "0000-01-01T00:05:00.000Z"),
      ],
      receivedAt,
    );
    store.saveIngestBatch(sourceId, batch([fact]), receivedAt);
    expect(saved(store).accountExternalId).toBe("acct-a");
    expect(saved(store).metadata.attribution).toBe("session");
  });
});
