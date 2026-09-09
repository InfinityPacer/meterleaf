import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  DATABASE_SCHEMA_REVISION,
  assertReadableSchema,
  migrateSchema,
} from "../src/storage/schema";

const NEXT_REVISION = "000000000002";
const UNKNOWN_REVISION = "deadbeefcafe";

function baseline(apply: (db: Database) => void = () => {}) {
  return {
    revision: DATABASE_SCHEMA_REVISION,
    downRevision: null,
    apply,
  };
}

test("adopts production schema_version=1 and legacy report user_version=2", () => {
  const ledger = new Database(":memory:");
  ledger.exec(
    "PRAGMA user_version=1; CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (1); CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('ledger')",
  );
  migrateSchema(ledger, "ledger", [baseline()]);
  expect(assertReadableSchema(ledger, "ledger", [baseline()])).toBe(
    DATABASE_SCHEMA_REVISION,
  );
  expect(
    ledger.query("SELECT revision, down_revision FROM schema_revisions").get(),
  ).toEqual({ revision: DATABASE_SCHEMA_REVISION, down_revision: null });
  expect(ledger.query("SELECT * FROM evidence").get()).toEqual({
    value: "ledger",
  });
  expect(ledger.query("PRAGMA user_version").get()).toEqual({
    user_version: 1,
  });
  ledger.close();

  const report = new Database(":memory:");
  report.exec(
    "PRAGMA user_version=2; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('report')",
  );
  migrateSchema(report, "report", [baseline()]);
  expect(
    report.query("SELECT revision, down_revision FROM schema_revisions").get(),
  ).toEqual({ revision: DATABASE_SCHEMA_REVISION, down_revision: null });
  expect(report.query("SELECT * FROM evidence").get()).toEqual({
    value: "report",
  });
  // user_version is retained as legacy metadata and is not the schema authority.
  expect(report.query("PRAGMA user_version").get()).toEqual({
    user_version: 2,
  });
  report.close();
});

test("migrations are atomic, repeatable and refuse unknown revisions", () => {
  const db = new Database(":memory:");
  let firstRuns = 0;
  let secondRuns = 0;
  const first = baseline((database) => {
    firstRuns++;
    database.exec(
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('kept')",
    );
  });
  migrateSchema(db, "ledger", [first]);
  migrateSchema(db, "ledger", [first]);
  expect(firstRuns).toBe(1);

  const failing = {
    revision: NEXT_REVISION,
    downRevision: DATABASE_SCHEMA_REVISION,
    apply: (database: Database) => {
      secondRuns++;
      database.exec("ALTER TABLE evidence ADD COLUMN extra TEXT");
      throw new Error("interrupted");
    },
  };
  expect(() => migrateSchema(db, "ledger", [first, failing])).toThrow(
    "interrupted",
  );
  expect(db.query("PRAGMA table_info(evidence)").all()).toHaveLength(1);
  expect(
    db.query("SELECT revision, down_revision FROM schema_revisions").all(),
  ).toEqual([{ revision: DATABASE_SCHEMA_REVISION, down_revision: null }]);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });

  migrateSchema(db, "ledger", [
    first,
    {
      revision: NEXT_REVISION,
      downRevision: DATABASE_SCHEMA_REVISION,
      apply: (database) => {
        secondRuns++;
        database.exec("ALTER TABLE evidence ADD COLUMN extra TEXT");
      },
    },
  ]);
  migrateSchema(db, "ledger", [
    first,
    {
      revision: NEXT_REVISION,
      downRevision: DATABASE_SCHEMA_REVISION,
      apply: () => {
        secondRuns++;
      },
    },
  ]);
  expect(secondRuns).toBe(2);
  expect(db.query("PRAGMA table_info(evidence)").all()).toHaveLength(2);

  db.query(
    "INSERT INTO schema_revisions (revision, down_revision) VALUES (?, ?)",
  ).run(UNKNOWN_REVISION, NEXT_REVISION);
  expect(() =>
    migrateSchema(db, "ledger", [
      first,
      {
        revision: NEXT_REVISION,
        downRevision: DATABASE_SCHEMA_REVISION,
        apply: () => {},
      },
    ]),
  ).toThrow("Unsupported");
  db.close();
});

test("migration definitions must use a single lowercase hex chain", () => {
  const db = new Database(":memory:");
  expect(() =>
    migrateSchema(db, "ledger", [
      { revision: "ABCDEFABCDEF", downRevision: null, apply: () => {} },
    ]),
  ).toThrow("Invalid");
  expect(() =>
    migrateSchema(db, "ledger", [
      baseline(),
      { revision: NEXT_REVISION, downRevision: null, apply: () => {} },
    ]),
  ).toThrow("single chain");
  db.close();
});
