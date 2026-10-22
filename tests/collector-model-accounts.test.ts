import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/collector/collect";
import { loadConfig } from "../src/collector/config";
import {
  modelAccountRuleSchema,
  OTHER_MODELS_ACCOUNT,
  routeModel,
  type ModelAccountRule,
} from "../src/collector/model-accounts";
import { CollectorState } from "../src/collector/state";
import type { IngestAccount, IngestUsage } from "../src/shared/ingest";
import {
  assistantLine,
  FIXTURE_ACCOUNT_UUID,
} from "./fixtures/claude-code/lines";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const GO_RULE: ModelAccountRule = modelAccountRuleSchema.parse({
  match: "deepseek-*",
  id: "opencode-go",
  name: "OpenCode Go",
  platform: "opencode-go",
  kind: "subscription",
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "meterleaf-model-accounts-"));
  temporary.push(root);
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "p"), { recursive: true });
  const claudeJson = join(root, "claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify({
      oauthAccount: {
        accountUuid: FIXTURE_ACCOUNT_UUID,
        organizationUuid: "bbbbbbbb-2222-4222-8222-222222222222",
        organizationType: "claude_max",
        organizationRateLimitTier: "default_claude_max_5x",
        billingType: "apple_subscription",
      },
    }),
  );
  const session = join(projectsDir, "p", "s.jsonl");
  writeFileSync(
    session,
    [
      assistantLine({
        messageId: "opus",
        timestamp: "2026-10-22T10:01:00Z",
        input: 1,
        output: 2,
      }),
      assistantLine({
        messageId: "ds",
        timestamp: "2026-10-22T10:02:00Z",
        input: 3,
        output: 4,
        model: "deepseek-v4.1-flash",
      }),
      "",
    ].join("\n"),
  );
  return { root, projectsDir, claudeJson, session };
}

/** 读完后确认账户的时刻晚于会话记录，使 Claude 事件落在观察区间内。 */
const later = () => new Date("2026-10-22T10:03:00Z");

function pendingUsage(state: CollectorState) {
  return new Map(
    state
      .pending<IngestUsage>("usage", 100)
      .map((item) => [item.payload.externalId, item.payload.accountExternalId]),
  );
}

function ackAll(state: CollectorState) {
  state.acknowledge(
    [
      ...state.pending("usage", 100),
      ...state.pending("account", 100),
      ...state.pending("quota", 100),
    ].map((item) => item.seq),
  );
}

describe("模型账户映射", () => {
  test("匹配式只把 * 当通配符，按顺序取第一条", () => {
    const exact = { ...GO_RULE, match: "gpt-5.4", id: "exact" };
    expect(routeModel("deepseek-v4.1-flash", [GO_RULE])?.externalId).toBe(
      "opencode-go",
    );
    expect(routeModel("gpt-5.4", [exact])?.externalId).toBe("exact");
    expect(routeModel("gpt-5x4", [exact])).toEqual(OTHER_MODELS_ACCOUNT);
    expect(routeModel("claude-opus-5-5", [GO_RULE])).toBeNull();
    const split = { ...GO_RULE, match: "claude-haiku-*", id: "haiku" };
    expect(routeModel("claude-haiku-5-5", [split, GO_RULE])?.externalId).toBe(
      "haiku",
    );
  });

  test("未配置时非 Claude 模型归入其他模型，不按登录时间归到 Claude 账户", () => {
    const w = workspace();
    const state = new CollectorState(":memory:");
    collect(state, w, new Date("2026-10-22T10:00:00Z"), later);
    const usage = pendingUsage(state);
    expect(usage.get("req_opus:opus")).toBe(FIXTURE_ACCOUNT_UUID);
    expect(usage.get("req_ds:ds")).toBe("other-models");
    expect(state.account("other-models")).toEqual(OTHER_MODELS_ACCOUNT);
    state.close();
  });

  test("映射的账户资料随用量推送", () => {
    const w = workspace();
    const state = new CollectorState(":memory:");
    collect(
      state,
      { ...w, modelAccounts: [GO_RULE] },
      new Date("2026-10-22T10:00:00Z"),
      later,
    );
    expect(pendingUsage(state).get("req_ds:ds")).toBe("opencode-go");
    expect(state.account("opencode-go")).toEqual({
      externalId: "opencode-go",
      name: "OpenCode Go",
      platform: "opencode-go",
      kind: "subscription",
      plan: null,
      subjectKey: null,
    } satisfies IngestAccount);
    state.close();
  });

  test("升级或修改映射后，已推送的事件改归新账户并重新入队一次", () => {
    const w = workspace();
    const state = new CollectorState(":memory:");
    collect(state, w, new Date("2026-10-22T10:00:00Z"), later);
    // 模拟旧规则：DeepSeek 事件已按登录时间归到 Claude 账户并推送。
    state.db.run(
      `UPDATE events SET account = '${FIXTURE_ACCOUNT_UUID}' WHERE key = 'req_ds:ds'`,
    );
    state.db.run("UPDATE meta SET value = '2' WHERE key = 'attribution_rules'");
    ackAll(state);

    const upgraded = collect(state, w, new Date("2026-10-22T10:05:00Z"));
    expect(upgraded.reattributed).toBe(1);
    expect(pendingUsage(state)).toEqual(
      new Map([["req_ds:ds", "other-models"]]),
    );
    ackAll(state);

    const mapped = collect(
      state,
      { ...w, modelAccounts: [GO_RULE] },
      new Date("2026-10-22T10:06:00Z"),
    );
    expect(mapped.reattributed).toBe(1);
    expect(pendingUsage(state)).toEqual(
      new Map([["req_ds:ds", "opencode-go"]]),
    );
    ackAll(state);

    const again = collect(
      state,
      { ...w, modelAccounts: [GO_RULE] },
      new Date("2026-10-22T10:07:00Z"),
    );
    expect(again.reattributed).toBe(0);
    expect(pendingUsage(state).size).toBe(0);
    state.close();
  });

  test("配置文件中的映射经校验后读出，缺省字段取默认值", () => {
    const w = workspace();
    const path = join(w.root, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        server: "https://meterleaf.example.com",
        sourceId: "claude-code-mac",
        key: "mlk_test",
        createdAt: "2026-10-22T00:00:00Z",
        modelAccounts: [
          {
            match: "deepseek-*",
            id: "opencode-go",
            name: "OpenCode Go",
            platform: "opencode-go",
          },
        ],
      }),
    );
    expect(loadConfig(path)?.modelAccounts).toEqual([
      {
        match: "deepseek-*",
        id: "opencode-go",
        name: "OpenCode Go",
        platform: "opencode-go",
        kind: "unknown",
        plan: null,
      },
    ]);
    writeFileSync(
      path,
      JSON.stringify({
        server: "https://meterleaf.example.com",
        sourceId: "claude-code-mac",
        key: "mlk_test",
        createdAt: "2026-10-22T00:00:00Z",
        modelAccounts: [{ match: "x", id: "bad id", name: "x", platform: "x" }],
      }),
    );
    expect(() => loadConfig(path)).toThrow();
  });
});
