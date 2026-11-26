import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgy } from "../src/collector/agy";
import { collect } from "../src/collector/collect";
import { SOURCE_START } from "../src/collector/config";
import { pushOutbox } from "../src/collector/push";
import { CollectorState } from "../src/collector/state";
import { planRelation } from "../src/domain/quota-plan";
import type { IngestBatch, IngestManagedScope } from "../src/shared/ingest";

const temps: string[] = [];
const states: CollectorState[] = [];

afterEach(() => {
  for (const s of states.splice(0)) s.close();
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-managed-scope-"));
  temps.push(dir);
  return dir;
}

function openState() {
  const state = new CollectorState(":memory:");
  states.push(state);
  return state;
}

function writeOAuth(appDataDir: string, email: string) {
  mkdirSync(join(appDataDir, "conversations"), { recursive: true });
  writeFileSync(
    join(appDataDir, "antigravity-oauth-token"),
    JSON.stringify({ id_token_email: email }),
  );
}

test("agy pool emits active and inactive managed scope members, fails closed on corrupt pool file, and applies defaultPlan cleanly", () => {
  const root = tempDir();
  const geminiDir = join(root, ".gemini");
  const statuslineDir = join(root, "statusline");
  mkdirSync(join(geminiDir, "antigravity-cli", "conversations"), {
    recursive: true,
  });
  mkdirSync(statuslineDir, { recursive: true });

  const active1 = join(geminiDir, "antigravity-cli-pool-p-aaa");
  const active2 = join(geminiDir, "antigravity-cli-pool-p-bbb");
  const paused = join(geminiDir, "antigravity-cli-pool-p-ccc");
  writeOAuth(active1, "alice@example.com");
  writeOAuth(active2, "bob@example.com");
  writeOAuth(paused, "carol@example.com");

  // bob 报了 Google AI Pro（不应被 defaultPlan 覆盖）；alice 只报 Google AI Ultra（应细化为 ultra-20x）。
  writeFileSync(
    join(statuslineDir, "quota-alice.tsv"),
    "gemini_5h\t10\t1796000000\nplan\tGoogle AI Ultra\t-\n",
  );
  writeFileSync(
    join(statuslineDir, "quota-bob.tsv"),
    "gemini_5h\t5\t1796000000\nplan\tGoogle AI Pro\t-\n",
  );

  const poolFile = join(root, "accounts.json");
  writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "acct-1",
          kind: "default",
          appDataDir: "antigravity-cli",
          enabled: false,
          status: "ready",
        },
        {
          id: "p-aaa",
          kind: "managed",
          appDataDir: "antigravity-cli-pool-p-aaa",
          enabled: true,
          status: "ready",
        },
        {
          id: "p-bbb",
          kind: "managed",
          appDataDir: "antigravity-cli-pool-p-bbb",
          enabled: true,
          status: "ready",
        },
        {
          id: "p-ccc",
          kind: "managed",
          appDataDir: "antigravity-cli-pool-p-ccc",
          enabled: false,
          status: "ready",
        },
      ],
    }),
  );

  const state = openState();
  const sources = {
    conversationsDir: join(geminiDir, "antigravity-cli", "conversations"),
    statuslineDir,
    start: SOURCE_START,
    defaultGeminiDir: geminiDir,
    poolAccountsFile: poolFile,
    defaultPlan: "ultra-20x",
  };
  readAgy(state, sources, new Date("2026-11-26T06:00:00Z"));

  expect(state.account("agy-alice")?.plan).toBe("ultra-20x");
  expect(state.account("agy-bob")?.plan).toBe("Google AI Pro");
  expect(planRelation("Google AI Ultra", "ultra-20x")).toBe("refine");

  const firstScopes = state.pending<IngestManagedScope>("scope", 10);
  expect(firstScopes.map((item) => item.payload)).toEqual([
    {
      scope: "agy-pool",
      activeAccountExternalIds: ["agy-alice", "agy-bob"],
      inactiveAccountExternalIds: ["agy-carol"],
    },
  ]);
  state.acknowledge(firstScopes.map((item) => item.seq));

  // 清单内容不变时不再重复入队。
  readAgy(state, sources, new Date("2026-11-26T06:01:00Z"));
  expect(state.pending("scope", 10)).toHaveLength(0);

  // 清单临时损坏时 fail-closed，绝不下发空活跃集把池账号全部误归档。
  writeFileSync(poolFile, "{broken-json");
  readAgy(state, sources, new Date("2026-11-26T06:02:00Z"));
  expect(state.pending("scope", 10)).toHaveLength(0);
});

test("claude exclusive profilesDir emits claude-profiles scope and pushes via outbox", async () => {
  const root = tempDir();
  const profilesDir = join(root, "claude-profiles");
  const p1 = join(profilesDir, "team-a");
  const p2 = join(profilesDir, "team-b");
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  writeFileSync(
    join(p1, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        accountUuid: "uuid-a",
        organizationUuid: "org-a",
        organizationRole: "member",
      },
    }),
  );
  writeFileSync(
    join(p2, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        accountUuid: "uuid-b",
        organizationUuid: "org-b",
        organizationRole: "member",
      },
    }),
  );

  const state = openState();
  collect(state, {
    projectsDir: join(root, "unused-projects"),
    claudeJson: join(root, "unused.json"),
    claudeProfilesDir: profilesDir,
  });

  const scopes = state.pending<IngestManagedScope>("scope", 10);
  expect(scopes.map((item) => item.payload)).toEqual([
    {
      scope: "claude-profiles",
      activeAccountExternalIds: ["uuid-a", "uuid-b"],
    },
  ]);

  const received: IngestBatch[] = [];
  const pushed = await pushOutbox(
    state,
    {
      server: "http://127.0.0.1:4318",
      sourceId: "test-mac",
      key: "mlk_test",
      createdAt: "2026-11-26T00:00:00Z",
    },
    {
      fetch: (async (_url, init) => {
        received.push(JSON.parse(String(init?.body)) as IngestBatch);
        return new Response(
          JSON.stringify({
            batchId: "b",
            accepted: { usage: 0, accounts: 2, quotas: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    },
  );
  expect(pushed.error).toBeNull();
  expect(received).toHaveLength(1);
  expect(received[0]!.managedScopes).toEqual([
    {
      scope: "claude-profiles",
      activeAccountExternalIds: ["uuid-a", "uuid-b"],
    },
  ]);
  expect(state.pendingCounts().scope).toBe(0);
});
