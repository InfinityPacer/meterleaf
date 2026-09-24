import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attribute } from "../src/collector/attribution";
import { collect } from "../src/collector/collect";
import { CollectorState } from "../src/collector/state";
import type { IngestQuota, IngestUsage } from "../src/shared/ingest";
import {
  assistantLine,
  FIXTURE_ACCOUNT_UUID,
} from "./fixtures/claude-code/lines";

const OTHER_ACCOUNT = "cccccccc-3333-4333-8333-333333333333";
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-collector-state-"));
  temporary.push(root);
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "p"), { recursive: true });
  const claudeJson = join(root, "claude.json");
  const session = join(projectsDir, "p", "s.jsonl");
  return { root, projectsDir, claudeJson, session };
}

function writeAccount(
  path: string,
  accountUuid: string | null,
  fetchedAt?: string,
) {
  const body: Record<string, unknown> = {};
  if (accountUuid) {
    body.oauthAccount = {
      accountUuid,
      organizationUuid: "bbbbbbbb-2222-4222-8222-222222222222",
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_5x",
      billingType: "apple_subscription",
    };
  }
  if (fetchedAt && accountUuid) {
    body.cachedUsageUtilization = {
      fetchedAtMs: Date.parse(fetchedAt),
      accountUuid,
      utilization: {
        five_hour: { utilization: 10, resets_at: "2026-09-01T15:00:00Z" },
        seven_day: { utilization: null },
      },
    };
  }
  writeFileSync(path, JSON.stringify(body));
}

function line(id: string, at: string, output: number): string {
  return `${assistantLine({ messageId: id, timestamp: at, input: 1, output })}\n`;
}

function pendingUsage(state: CollectorState): Map<string, IngestUsage> {
  return new Map(
    state
      .pending<IngestUsage>("usage", 1000)
      .map((item) => [item.payload.externalId, item.payload]),
  );
}

function ackAll(state: CollectorState) {
  state.acknowledge(
    [
      ...state.pending("usage", 1000),
      ...state.pending("account", 1000),
      ...state.pending("quota", 1000),
    ].map((item) => item.seq),
  );
}

describe("增量读取", () => {
  test("追加行只读取新增部分，未写完的行等补全后再读", () => {
    const w = workspace();
    writeAccount(w.claudeJson, FIXTURE_ACCOUNT_UUID);
    writeFileSync(w.session, line("m1", "2026-09-01T10:00:00Z", 5));
    const state = new CollectorState(":memory:");
    collect(state, w, new Date("2026-09-01T10:01:00Z"));
    expect(pendingUsage(state).size).toBe(1);
    ackAll(state);
    const firstOffset = state.cursor(w.session)!.offset;

    const partial = line("m2", "2026-09-01T10:02:00Z", 6);
    appendFileSync(w.session, partial.slice(0, 40));
    const second = collect(state, w, new Date("2026-09-01T10:03:00Z"));
    expect(second.bytesRead).toBe(40);
    expect(state.cursor(w.session)!.offset).toBe(firstOffset);
    expect(pendingUsage(state).size).toBe(0);

    appendFileSync(w.session, partial.slice(40));
    const third = collect(state, w, new Date("2026-09-01T10:04:00Z"));
    expect(third.bytesRead).toBe(partial.length);
    expect([...pendingUsage(state).keys()]).toEqual(["req_m2:m2"]);
    state.close();
  });

  test("未变化的文件不再读取", () => {
    const w = workspace();
    writeFileSync(w.session, line("m1", "2026-09-01T10:00:00Z", 5));
    const state = new CollectorState(":memory:");
    collect(state, w);
    const again = collect(state, w);
    expect(again.filesRead).toBe(0);
    expect(again.bytesRead).toBe(0);
    state.close();
  });

  test("截断或原地重写后从头重读且不重复", () => {
    const w = workspace();
    writeFileSync(
      w.session,
      line("m1", "2026-09-01T10:00:00Z", 5) +
        line("m2", "2026-09-01T10:01:00Z", 6),
    );
    const state = new CollectorState(":memory:");
    collect(state, w);
    ackAll(state);

    writeFileSync(w.session, line("m1", "2026-09-01T10:00:00Z", 5));
    const truncated = collect(state, w);
    expect(truncated.rewound).toBe(1);
    expect(pendingUsage(state).size).toBe(0);

    // 同长度原地改写：指纹不符，从头重读，新事件入队，旧事件不重复。
    const rewritten = line("m9", "2026-09-01T10:00:00Z", 5);
    writeFileSync(w.session, rewritten);
    utimesSync(w.session, new Date(), new Date(Date.now() + 5000));
    const result = collect(state, w);
    expect(result.rewound).toBe(1);
    expect([...pendingUsage(state).keys()]).toEqual(["req_m9:m9"]);
    expect(state.usageTotals().reduce((sum, row) => sum + row.events, 0)).toBe(
      3,
    );
    state.close();
  });

  test("文件删除后已记录事件保留", () => {
    const w = workspace();
    writeFileSync(w.session, line("m1", "2026-09-01T10:00:00Z", 5));
    const state = new CollectorState(":memory:");
    collect(state, w);
    rmSync(w.session);
    const report = collect(state, w);
    expect(report.files).toBe(0);
    expect(state.cursors()).toHaveLength(0);
    expect(pendingUsage(state).has("req_m1:m1")).toBe(true);
    expect(state.usageTotals()[0]!.events).toBe(1);
    state.close();
  });

  test("更大的后续行替换并重新入队，更小的不入队", () => {
    const w = workspace();
    writeFileSync(w.session, line("m1", "2026-09-01T10:00:00Z", 5));
    const state = new CollectorState(":memory:");
    collect(state, w);
    ackAll(state);

    appendFileSync(w.session, line("m1", "2026-09-01T10:00:05Z", 3));
    collect(state, w);
    expect(pendingUsage(state).size).toBe(0);

    appendFileSync(w.session, line("m1", "2026-09-01T10:00:09Z", 50));
    collect(state, w);
    const event = pendingUsage(state).get("req_m1:m1")!;
    expect(event.tokens.output).toBe(50);
    expect(event.occurredAt).toBe("2026-09-01T10:00:00.000Z");
    state.close();
  });
});

describe("账户归属", () => {
  const segments = [
    {
      accountUuid: "A",
      firstSeen: "2026-09-01T10:00:00.000Z",
      lastSeen: "2026-09-01T11:00:00.000Z",
    },
    {
      accountUuid: "A",
      firstSeen: "2026-09-01T12:00:00.000Z",
      lastSeen: "2026-09-01T13:00:00.000Z",
    },
    {
      accountUuid: "B",
      firstSeen: "2026-09-01T14:00:00.000Z",
      lastSeen: "2026-09-01T15:00:00.000Z",
    },
  ];

  test("区间内、同账户空档、不同账户空档、首段前与最后观察后", () => {
    expect(attribute("2026-09-01T10:30:00.000Z", segments, null)).toBe("A");
    expect(attribute("2026-09-01T11:30:00.000Z", segments, null)).toBe("A");
    expect(attribute("2026-09-01T13:30:00.000Z", segments, null)).toBe(
      "unattributed",
    );
    expect(attribute("2026-09-01T09:00:00.000Z", segments, null)).toBe(
      "unattributed",
    );
    expect(attribute("2026-09-01T16:00:00.000Z", segments, null)).toBe(
      "unattributed",
    );
    expect(attribute("2026-09-01T14:30:00.000Z", segments, null)).toBe("B");
  });

  test("历史绑定只作用于首段之前", () => {
    const binding = { accountUuid: "A", before: segments[0]!.firstSeen };
    expect(attribute("2026-09-01T09:00:00.000Z", segments, binding)).toBe("A");
    expect(attribute("2026-09-01T13:30:00.000Z", segments, binding)).toBe(
      "unattributed",
    );
  });

  test("时间线延长后重新归属并重新入队", () => {
    const w = workspace();
    writeAccount(w.claudeJson, FIXTURE_ACCOUNT_UUID);
    writeFileSync(w.session, line("old", "2026-09-01T09:00:00Z", 5));
    const state = new CollectorState(":memory:");
    collect(state, w, new Date("2026-09-01T10:00:00Z"));
    expect(pendingUsage(state).get("req_old:old")!.accountExternalId).toBe(
      "unattributed",
    );
    expect(state.account("unattributed")!.name).toBe("未归属");
    ackAll(state);

    // .claude.json 本轮读不到：新事件落在最后一次观察之后，暂归未归属。
    writeFileSync(w.claudeJson, '{"oauthAccount": {');
    appendFileSync(w.session, line("gap", "2026-09-01T10:05:00Z", 5));
    const unreadable = collect(state, w, new Date("2026-09-01T10:06:00Z"));
    expect(unreadable.claudeJsonRead).toBe(false);
    expect(pendingUsage(state).get("req_gap:gap")!.accountExternalId).toBe(
      "unattributed",
    );
    ackAll(state);

    writeAccount(w.claudeJson, FIXTURE_ACCOUNT_UUID);
    const next = collect(state, w, new Date("2026-09-01T10:10:00Z"));
    expect(next.reattributed).toBe(1);
    expect(pendingUsage(state).get("req_gap:gap")!.accountExternalId).toBe(
      FIXTURE_ACCOUNT_UUID,
    );

    // 账户切换后，两账户之间的空档无法判断。
    writeAccount(w.claudeJson, OTHER_ACCOUNT);
    appendFileSync(w.session, line("switch", "2026-09-01T10:15:00Z", 5));
    collect(state, w, new Date("2026-09-01T10:20:00Z"));
    expect(
      pendingUsage(state).get("req_switch:switch")!.accountExternalId,
    ).toBe("unattributed");
    appendFileSync(w.session, line("after", "2026-09-01T10:20:00Z", 5));
    collect(state, w, new Date("2026-09-01T10:25:00Z"));
    expect(pendingUsage(state).get("req_after:after")!.accountExternalId).toBe(
      OTHER_ACCOUNT,
    );

    // 用户声明首段之前的历史属于某账户。
    state.setBinding({
      accountUuid: FIXTURE_ACCOUNT_UUID,
      before: state.segments()[0]!.firstSeen,
    });
    expect(state.reattribute(null)).toBe(1);
    expect(pendingUsage(state).get("req_old:old")!.accountExternalId).toBe(
      FIXTURE_ACCOUNT_UUID,
    );
    state.close();
  });
});

describe("额度快照", () => {
  test("同一次采样只记录一次，未知百分比保留 null", () => {
    const w = workspace();
    writeAccount(w.claudeJson, FIXTURE_ACCOUNT_UUID, "2026-09-01T10:00:00Z");
    const state = new CollectorState(":memory:");
    expect(collect(state, w).quotaRecorded).toBe(true);
    expect(collect(state, w).quotaRecorded).toBe(false);
    const quotas = state
      .pending<IngestQuota>("quota", 10)
      .map((i) => i.payload);
    expect(quotas).toEqual([
      {
        accountExternalId: FIXTURE_ACCOUNT_UUID,
        window: "five-hour",
        percent: 10,
        sampledAt: "2026-09-01T10:00:00.000Z",
        resetsAt: "2026-09-01T15:00:00.000Z",
        windowMinutes: 300,
      },
      {
        accountExternalId: FIXTURE_ACCOUNT_UUID,
        window: "seven-day",
        percent: null,
        sampledAt: "2026-09-01T10:00:00.000Z",
        resetsAt: null,
        windowMinutes: 10080,
      },
    ]);
    writeAccount(w.claudeJson, FIXTURE_ACCOUNT_UUID, "2026-09-01T10:05:00Z");
    expect(collect(state, w).quotaRecorded).toBe(true);
    expect(state.pending("quota", 10)).toHaveLength(4);
    state.close();
  });
});
