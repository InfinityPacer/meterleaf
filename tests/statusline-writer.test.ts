import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readStatuslineCache } from "../src/collector/claude-code/statusline-cache";

(Bun.which("jq") ? test : test.skip)(
  "statusline writer stores only valid quota windows atomically and retains reset times",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "meterleaf-statusline-writer-"));
    const cache = join(dir, "quota.tsv");
    const run = (input: string) =>
      Bun.spawnSync(["bash", resolve("scripts/claude-statusline.sh")], {
        env: { ...process.env, METERLEAF_STATUSLINE_CACHE: cache },
        stdin: Buffer.from(input),
      });
    try {
      const input = {
        private: "do-not-save",
        rate_limits: {
          five_hour: { used_percentage: 25, resets_at: 1791048473 },
          seven_day: { used_percentage: 80.5, resets_at: 1791248473 },
          unknown: { used_percentage: 40, resets_at: 1791048473 },
        },
      };
      expect(run(JSON.stringify(input)).exitCode).toBe(0);
      expect(readFileSync(cache, "utf8")).toBe(
        "five_hour\t25\t1791048473\nseven_day\t80.5\t1791248473\n",
      );
      expect(statSync(cache).mode & 0o777).toBe(0o600);
      const before = statSync(cache).mtimeMs;
      for (const invalid of [
        "not-json",
        "{}",
        JSON.stringify({
          rate_limits: {
            five_hour: { used_percentage: -1, resets_at: 1791048473 },
          },
        }),
      ]) {
        expect(run(invalid).exitCode).toBe(0);
        expect(statSync(cache).mtimeMs).toBe(before);
      }
      expect(readStatuslineCache(cache)?.entries).toEqual([
        {
          window: "five-hour",
          percent: 25,
          resetsAt: new Date(1791048473 * 1000).toISOString(),
        },
        {
          window: "seven-day",
          percent: 80.5,
          resetsAt: new Date(1791248473 * 1000).toISOString(),
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
