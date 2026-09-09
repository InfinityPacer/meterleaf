import type { Database } from "bun:sqlite";

/** 首次公开发行的统一结构基线；费用表版本与数据库结构版本相互独立。 */
export const DATABASE_SCHEMA_REVISION = "a17c9e4b620f";
export type SchemaRevision = string;
export type DatabaseKind = "ledger" | "report" | "lifetime" | "view-cache";

/** 迁移按单一父链排列，revision 是结构身份而不是可比较的序号。 */
export interface SchemaMigration {
  revision: SchemaRevision;
  downRevision: SchemaRevision | null;
  apply(db: Database): void;
}

interface RevisionRow {
  revision: string;
  down_revision: string | null;
}

interface SchemaState {
  current: SchemaRevision | null;
  hasRevisionTable: boolean;
}

const REVISION_PATTERN = /^[0-9a-f]{12}$/;
const DEFAULT_MIGRATIONS: readonly SchemaMigration[] = [
  {
    revision: DATABASE_SCHEMA_REVISION,
    downRevision: null,
    apply: () => {},
  },
];

function hasTable(db: Database, name: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}

function validateRevision(value: string, label: string): void {
  if (!REVISION_PATTERN.test(value))
    throw new Error(`Invalid ${label}: ${value}`);
}

function validateMigrations(
  migrations: readonly SchemaMigration[],
): readonly SchemaMigration[] {
  if (!migrations.length)
    throw new Error("Schema migrations must not be empty");
  const revisions = new Set<string>();
  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index]!;
    validateRevision(migration.revision, "schema migration revision");
    if (revisions.has(migration.revision))
      throw new Error(
        `Duplicate schema migration revision: ${migration.revision}`,
      );
    revisions.add(migration.revision);
    const expectedDownRevision =
      index === 0 ? null : migrations[index - 1]!.revision;
    if (migration.downRevision !== expectedDownRevision)
      throw new Error("Schema migrations must form a single chain");
  }
  return migrations;
}

function readLegacyRevision(
  db: Database,
  kind: DatabaseKind,
): SchemaRevision | null {
  if (hasTable(db, "schema_version")) {
    const version = db
      .query<{ version: number | null }, []>(
        "SELECT MAX(version) AS version FROM schema_version",
      )
      .get()?.version;
    if (version === 1) return DATABASE_SCHEMA_REVISION;
    if (version !== null && version !== undefined)
      throw new Error(
        `Unsupported ${kind} database schema version: ${version}`,
      );
  }

  // 首版报表索引在共享 revision 表出现前使用 SQLite 私有标记；这里只把它作为迁移提示。
  if (kind === "report") {
    const userVersion = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (userVersion === 2) return DATABASE_SCHEMA_REVISION;
  }
  return null;
}

function readRecordedState(
  db: Database,
  kind: DatabaseKind,
  migrations: readonly SchemaMigration[],
): SchemaState {
  if (!hasTable(db, "schema_revisions")) {
    return {
      current: readLegacyRevision(db, kind),
      hasRevisionTable: false,
    };
  }

  const rows = db
    .query<RevisionRow, []>(
      "SELECT revision, down_revision FROM schema_revisions",
    )
    .all();
  if (!rows.length) return { current: null, hasRevisionTable: true };

  const known = new Map(
    migrations.map((migration) => [migration.revision, migration]),
  );
  const recorded = new Map<string, RevisionRow>();
  for (const row of rows) {
    if (!known.has(row.revision))
      throw new Error(
        `Unsupported ${kind} database schema revision: ${row.revision}`,
      );
    if (recorded.has(row.revision))
      throw new Error(
        `Duplicate ${kind} database schema revision: ${row.revision}`,
      );
    const migration = known.get(row.revision)!;
    if (row.down_revision !== migration.downRevision)
      throw new Error(`Invalid ${kind} database schema revision chain`);
    if (row.down_revision !== null && !known.has(row.down_revision))
      throw new Error(
        `Unsupported ${kind} database schema revision: ${row.down_revision}`,
      );
    recorded.set(row.revision, row);
  }
  for (const row of rows)
    if (row.down_revision !== null && !recorded.has(row.down_revision))
      throw new Error(`Invalid ${kind} database schema revision chain`);

  const childRevisions = new Set(
    rows
      .map((row) => row.down_revision)
      .filter((revision): revision is string => revision !== null),
  );
  const heads = rows.filter((row) => !childRevisions.has(row.revision));
  if (heads.length !== 1)
    throw new Error(`Invalid ${kind} database schema revision chain`);

  const visited = new Set<string>();
  let revision: string | null = heads[0]!.revision;
  while (revision !== null) {
    if (visited.has(revision))
      throw new Error(`Invalid ${kind} database schema revision chain`);
    visited.add(revision);
    revision = recorded.get(revision)!.down_revision;
  }
  if (visited.size !== rows.length)
    throw new Error(`Invalid ${kind} database schema revision chain`);

  return { current: heads[0]!.revision, hasRevisionTable: true };
}

/** 校验当前数据库只包含代码已知的 revision 链，并返回当前 head。 */
export function assertReadableSchema(
  db: Database,
  kind: DatabaseKind,
  migrations: readonly SchemaMigration[] = DEFAULT_MIGRATIONS,
): SchemaRevision | null {
  const validated = validateMigrations(migrations);
  return readRecordedState(db, kind, validated).current;
}

/** 返回持久化结构身份；未初始化的数据库不能作为已迁移 store 使用。 */
export function currentSchemaRevision(
  db: Database,
  kind: DatabaseKind,
  migrations: readonly SchemaMigration[] = DEFAULT_MIGRATIONS,
): SchemaRevision {
  const revision = assertReadableSchema(db, kind, migrations);
  if (revision === null)
    throw new Error(`Uninitialized ${kind} database schema`);
  return revision;
}

function createRevisionTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_revisions (
      revision TEXT PRIMARY KEY,
      down_revision TEXT
    )
  `);
}

function recordRevision(db: Database, migration: SchemaMigration): void {
  db.query(
    "INSERT INTO schema_revisions (revision, down_revision) VALUES (?, ?)",
  ).run(migration.revision, migration.downRevision);
}

/** 每个升级链与 revision 标记在同一事务提交；失败回滚，重复启动不重放迁移。 */
export function migrateSchema(
  db: Database,
  kind: DatabaseKind,
  migrations: readonly SchemaMigration[],
): void {
  const validated = validateMigrations(migrations);
  const state = readRecordedState(db, kind, validated);
  const target = validated.at(-1)!.revision;
  const currentIndex =
    state.current === null
      ? -1
      : validated.findIndex(
          (migration) => migration.revision === state.current,
        );
  if (state.current !== null && currentIndex < 0)
    throw new Error(
      `Unsupported ${kind} database schema revision: ${state.current}`,
    );
  if (state.current === target && state.hasRevisionTable) return;

  db.transaction(() => {
    createRevisionTable(db);
    let nextIndex = currentIndex + 1;
    if (state.current !== null && !state.hasRevisionTable) {
      recordRevision(db, validated[currentIndex]!);
    }
    for (; nextIndex < validated.length; nextIndex++) {
      const migration = validated[nextIndex]!;
      migration.apply(db);
      recordRevision(db, migration);
    }
  })();
}
