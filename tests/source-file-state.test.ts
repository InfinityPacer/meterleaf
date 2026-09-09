import { expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  renameSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { sourceFileState } from "../src/storage/source-file-state";

test("source identity handles readonly URIs, content stamps and replaced databases", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterleaf-file-state-"));
  const path = join(dir, "fixture.sqlite");
  try {
    writeFileSync(path, "fixture");
    const before = sourceFileState(path);
    expect(sourceFileState(`${pathToFileURL(path)}?immutable=1`)).toEqual(
      before,
    );
    writeFileSync(`${path}-wal`, "committed-wal");
    expect(sourceFileState(path).identity).toBe(before.identity);
    expect(sourceFileState(path).stamp).not.toBe(before.stamp);
    const withWal = sourceFileState(path);
    utimesSync(path, new Date(), new Date(Date.now() + 60_000));
    expect(sourceFileState(path).identity).toBe(before.identity);
    expect(sourceFileState(path).stamp).not.toBe(withWal.stamp);
    writeFileSync(join(dir, "replacement"), "replacement");
    renameSync(join(dir, "replacement"), path);
    expect(sourceFileState(path).identity).not.toBe(before.identity);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
