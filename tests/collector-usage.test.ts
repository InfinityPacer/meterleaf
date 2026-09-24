import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  accountFact,
  readClaudeJson,
  subjectKeyFor,
} from "../src/collector/claude-code/account";
import { parseLine } from "../src/collector/claude-code/usage";
import { collect } from "../src/collector/collect";
import { CollectorState } from "../src/collector/state";
import type { IngestUsage } from "../src/shared/ingest";
import { ingestUsageSchema } from "../src/shared/ingest";
import {
  assistantLine,
  FIXTURE_ACCOUNT_UUID,
  FIXTURE_ORG_UUID,
} from "./fixtures/claude-code/lines";

const fixtureRoot = join(import.meta.dir, "fixtures/claude-code");
const sources = {
  projectsDir: join(fixtureRoot, "projects"),
  claudeJson: join(fixtureRoot, "claude.json"),
};

function collectFixture() {
  const state = new CollectorState(":memory:");
  const report = collect(state, sources, new Date("2026-09-01T11:00:00Z"));
  const usage = new Map(
    state
      .pending<IngestUsage>("usage", 100)
      .map((item) => [item.payload.externalId, item.payload]),
  );
  return { state, report, usage };
}

describe("Claude Code 用量行解析", () => {
  test("同一响应的多行按键合并，只计一次", () => {
    const { usage, state } = collectFixture();
    const event = usage.get("req_A:msg_A")!;
    expect(event.tokens).toEqual({
      input: 10,
      output: 100,
      cacheRead: 1000,
      cacheWrite: 50,
      cacheWrite5m: 0,
      cacheWrite1h: 50,
      reasoning: 20,
    });
    const totals = state.usageTotals();
    const opus = totals.find((row) => row.model === "claude-opus-5")!;
    expect(opus.cacheRead).toBe(1000 + 500);
    state.close();
  });

  test("全零占位行在前时保留真实行，时间取首行", () => {
    const { usage } = collectFixture();
    expect(usage.get("req_A:msg_A")!.occurredAt).toBe(
      "2026-09-01T10:00:00.000Z",
    );
  });

  test("合成模型与全零事件不发送", () => {
    const { usage, report } = collectFixture();
    expect(report.synthetic).toBe(1);
    expect(usage.has("req_B:msg_B")).toBe(false);
    expect(usage.has("req_C:msg_C")).toBe(false);
  });

  test("缺少 requestId 时退回会话键，缺失字段保留 null", () => {
    const { usage } = collectFixture();
    const event = usage.get("nr:sess-main:msg_D")!;
    expect(event.tier).toBe("fast");
    expect(event.tokens).toEqual({
      input: 3,
      output: 7,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
    });
  });

  test("子代理文件复制的主会话事件只计一次", () => {
    const { usage, state } = collectFixture();
    expect([...usage.keys()].sort()).toEqual([
      "nr:sess-main:msg_D",
      "req_A:msg_A",
      "req_E:msg_E",
      "req_E:msg_E:advisor:1",
      "req_F:msg_F",
    ]);
    expect(usage.get("req_F:msg_F")!.metadata.is_sidechain).toBe(true);
    state.close();
  });

  test("advisor 迭代按独立事件发送", () => {
    const { usage } = collectFixture();
    const advisor = usage.get("req_E:msg_E:advisor:1")!;
    expect(advisor.model).toBe("claude-opus-5-5");
    expect(advisor.occurredAt).toBe(usage.get("req_E:msg_E")!.occurredAt);
    expect(advisor.tokens).toEqual({
      input: 40,
      output: 60,
      cacheRead: 400,
      cacheWrite: 30,
      cacheWrite5m: 30,
      cacheWrite1h: 0,
      reasoning: null,
    });
  });

  test("元数据只含白名单字段", () => {
    const { usage } = collectFixture();
    expect(usage.get("req_A:msg_A")!.metadata).toEqual({
      reasoning_effort: "high",
      is_sidechain: false,
      web_search_requests: 1,
      web_fetch_requests: 0,
      client_version: "2.1.0",
    });
    expect(usage.get("req_E:msg_E")!.metadata.inference_geo).toBe("us");
    for (const event of usage.values()) {
      expect(ingestUsageSchema.safeParse(event).success).toBe(true);
    }
  });

  test("损坏行跳过并计数", () => {
    const { report } = collectFixture();
    expect(report.malformed).toBe(1);
    expect(parseLine("{not json").kind).toBe("malformed");
  });

  test("无 usage 或非 assistant 行忽略", () => {
    expect(parseLine(JSON.stringify({ type: "user" })).kind).toBe("ignored");
    expect(
      parseLine(
        assistantLine({ messageId: "m", timestamp: "invalid", output: 1 }),
      ).kind,
    ).toBe("ignored");
  });
});

describe("Claude Code 账户与额度", () => {
  test("只读取非敏感字段并生成订阅账户", () => {
    const snapshot = readClaudeJson(sources.claudeJson)!;
    const account = accountFact(snapshot.account!);
    expect(account).toEqual({
      externalId: FIXTURE_ACCOUNT_UUID,
      name: "Claude Max 5x · aaaaaaaa",
      platform: "anthropic",
      kind: "subscription",
      plan: "max-5x",
      subjectKey: subjectKeyFor(snapshot.account!),
    });
    expect(account.subjectKey).toBe(
      `sha256:${new Bun.CryptoHasher("sha256")
        .update(
          `anthropic_account_uuid=${FIXTURE_ACCOUNT_UUID}\nanthropic_organization_uuid=${FIXTURE_ORG_UUID}`,
        )
        .digest("hex")}`,
    );
    expect(JSON.stringify(snapshot)).not.toContain("example.com");
    expect(JSON.stringify(snapshot.account)).not.toContain("Secret Org");
  });

  test("非订阅计费方式不认定为订阅", () => {
    const account = accountFact({
      accountUuid: "x",
      organizationUuid: null,
      organizationType: "claude_max",
      rateLimitTier: null,
      billingType: null,
    });
    expect(account.kind).toBe("unknown");
    expect(account.plan).toBe("claude_max");
    expect(account.subjectKey).toBeNull();
  });

  test("无法解析的 .claude.json 返回 null", () => {
    expect(readClaudeJson(join(fixtureRoot, "missing.json"))).toBeNull();
    expect(
      readClaudeJson(
        join(fixtureRoot, "projects/-Users-tester-demo/sess-main.jsonl"),
      ),
    ).toBeNull();
  });
});
