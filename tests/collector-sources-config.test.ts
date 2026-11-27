import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadConfig, type CollectorConfig } from "../src/collector/config";
import {
  agyReaderConfig,
  codexReaderConfig,
  ompReaderConfig,
  opencodeReaderConfig,
} from "../src/collector/main";

const config = (extra: Partial<CollectorConfig>): CollectorConfig =>
  ({
    server: "https://meterleaf.example.com",
    sourceId: "claude-code-mac",
    key: "mlk_test",
    createdAt: "2026-10-30T00:00:00Z",
    ...extra,
  }) as CollectorConfig;

test("sources default to enabled with home and database locations", () => {
  const codex = codexReaderConfig(null)!;
  expect(codex.home.endsWith(".codex")).toBe(true);
  expect(codex.start).toBe("2026-09-20T00:00:00.000Z");
  expect(codex.channelAccounts.length).toBeGreaterThan(0);
  const opencode = opencodeReaderConfig(null)!;
  expect(opencode.database.endsWith("opencode.db")).toBe(true);
  expect(opencode.start).toBe(codex.start);
  const agy = agyReaderConfig(null)!;
  expect(agy.conversationsDir.endsWith("antigravity-cli/conversations")).toBe(
    true,
  );
  expect(agy.statuslineDir.endsWith("agy-statusline")).toBe(true);
  expect(agy.start).toBe(codex.start);
  expect(agy.quotaRefresh).toBe(false);
});

test("either source can be disabled or pointed elsewhere in config.json", () => {
  expect(
    codexReaderConfig(
      config({
        codex: { enabled: false, home: "/tmp/codex-home" },
      }),
    ),
  ).toBeNull();
  const opencode = opencodeReaderConfig(
    config({ opencode: { enabled: true, database: "/tmp/opencode.db" } }),
  )!;
  expect(opencode.database).toBe("/tmp/opencode.db");
  expect(opencode.start).toBe("2026-09-20T00:00:00.000Z");
  expect(
    agyReaderConfig(
      config({
        agy: {
          enabled: false,
          quotaRefresh: false,
          conversationsDir: "/tmp/agy-convos",
          statuslineDir: "/tmp/agy-statusline",
        },
      }),
    ),
  ).toBeNull();
  const agy = agyReaderConfig(
    config({
      agy: {
        enabled: true,
        quotaRefresh: false,
        conversationsDir: "/tmp/agy-convos",
        statuslineDir: "/tmp/agy-statusline",
      },
    }),
  )!;
  expect(agy.conversationsDir).toBe("/tmp/agy-convos");
  expect(agy.statuslineDir).toBe("/tmp/agy-statusline");
  expect(agy.start).toBe("2026-09-20T00:00:00.000Z");
  expect(agy.quotaRefresh).toBe(false);

  const agyRefreshEnabled = agyReaderConfig(
    config({
      agy: {
        enabled: true,
        quotaRefresh: true,
      },
    }),
  )!;
  expect(agyRefreshEnabled.quotaRefresh).toBe(true);
});

test("loadConfig defaults agy.quotaRefresh to false and preserves explicit true", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-agy-config-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        server: "https://meterleaf.example.com",
        sourceId: "claude-code-mac",
        key: "mlk_test",
        createdAt: "2026-11-27T00:00:00Z",
        agy: {},
      }),
    );
    const defaultParsed = loadConfig(file);
    expect(defaultParsed?.agy?.quotaRefresh).toBeUndefined();
    expect(agyReaderConfig(defaultParsed)?.quotaRefresh).toBe(false);

    writeFileSync(
      file,
      JSON.stringify({
        server: "https://meterleaf.example.com",
        sourceId: "claude-code-mac",
        key: "mlk_test",
        createdAt: "2026-11-27T00:00:00Z",
        agy: { quotaRefresh: true },
      }),
    );
    const enabledParsed = loadConfig(file);
    expect(enabledParsed?.agy?.quotaRefresh).toBe(true);
    expect(agyReaderConfig(enabledParsed)?.quotaRefresh).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omp reads its session directory by default, follows config.json, and shares the Antigravity cache directory", () => {
  const omp = ompReaderConfig(null)!;
  expect(omp.sessionsDir.endsWith(".omp/agent/sessions")).toBe(true);
  expect(omp.start).toBe("2026-09-20T00:00:00.000Z");
  expect(omp.statuslineDir).toBe(agyReaderConfig(null)!.statuslineDir);
  expect(
    omp.channelAccounts.some(
      (rule) => rule.source === "omp" && rule.channel === "opencode-go",
    ),
  ).toBe(true);

  expect(ompReaderConfig(config({ omp: { enabled: false } }))).toBeNull();
  const moved = ompReaderConfig(
    config({
      omp: { enabled: true, sessionsDir: "/tmp/omp-sessions" },
      agy: {
        enabled: true,
        quotaRefresh: false,
        statuslineDir: "/tmp/agy-statusline",
      },
    }),
  )!;
  expect(moved.sessionsDir).toBe("/tmp/omp-sessions");
  expect(moved.statuslineDir).toBe("/tmp/agy-statusline");
});
