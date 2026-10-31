import { expect, test } from "bun:test";
import type { CollectorConfig } from "../src/collector/config";
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
        conversationsDir: "/tmp/agy-convos",
        statuslineDir: "/tmp/agy-statusline",
      },
    }),
  )!;
  expect(agy.conversationsDir).toBe("/tmp/agy-convos");
  expect(agy.statuslineDir).toBe("/tmp/agy-statusline");
  expect(agy.start).toBe("2026-09-20T00:00:00.000Z");
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
      agy: { enabled: true, statuslineDir: "/tmp/agy-statusline" },
    }),
  )!;
  expect(moved.sessionsDir).toBe("/tmp/omp-sessions");
  expect(moved.statuslineDir).toBe("/tmp/agy-statusline");
});
