import { expect, test } from "bun:test";
import type { CollectorConfig } from "../src/collector/config";
import { codexReaderConfig, opencodeReaderConfig } from "../src/collector/main";

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
});
