import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Pool } from "pg";
import { createSub2ApiConnector } from "../src/connectors/sub2api";
import { defaultPriceBook } from "../src/domain/default-prices";
import { SyncRunner } from "../src/server/sync";
import { LedgerStore } from "../src/storage/ledger";

// 独立执行：仅操作本脚本创建的本地容器，不接受外部数据库地址。
const name = `meterleaf-pg-test-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "meterleaf-pg-"));
let created = false;
let admin: Pool | null = null;
let sync: SyncRunner | null = null;
let store: LedgerStore | null = null;

async function docker(...args: string[]) {
  const proc = Bun.spawn(["docker", "--context", "desktop-linux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const error = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0)
    throw new Error(`Docker ${args[0]} failed: ${error}`);
  return output.trim();
}

async function ready() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker("exec", name, "pg_isready", "-U", "postgres");
      await admin!.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(500);
    }
  }
  throw new Error("Temporary PostgreSQL did not become ready", {
    cause: lastError,
  });
}

try {
  // Docker 自动端口会在 stop/start 后重分配；显式绑定才能验证同一端点重连。
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  await docker(
    "run",
    "-d",
    "--pull=never",
    "--name",
    name,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    `127.0.0.1:${port}:5432`,
    "postgres:17-alpine",
  );
  created = true;
  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
  admin = new Pool({ connectionString, connectionTimeoutMillis: 1000 });
  admin.on("error", () => {});
  await ready();
  await admin.query(`
    CREATE TABLE accounts (id bigint PRIMARY KEY, name text, platform text, type text);
    CREATE TABLE usage_logs (id bigint PRIMARY KEY, account_id bigint, model text,
      created_at timestamptz, input_tokens integer, output_tokens integer,
      cache_read_tokens integer, cache_creation_tokens integer,
      upstream_response_model text, upstream_model_mismatch boolean);
    CREATE ROLE meterleaf_reader LOGIN;
    GRANT SELECT ON accounts, usage_logs TO meterleaf_reader;
    INSERT INTO accounts VALUES (1, 'synthetic', 'openai', 'apikey');
    INSERT INTO usage_logs VALUES (1, 1, 'gpt-6-astra', now(), 100, 10, 0, 0, 'response-alias', false);
  `);
  const backgroundErrors: unknown[] = [];
  const connector = createSub2ApiConnector({
    sourceId: "postgres-smoke",
    connectionString: `postgres://meterleaf_reader@127.0.0.1:${port}/postgres`,
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  const path = join(directory, "ledger.sqlite");
  store = new LedgerStore(path, defaultPriceBook);
  const options = {
    intervalMs: 30_000,
    sweepMs: 1,
    pageSize: 1,
    pagesPerPoll: 10,
  };
  sync = new SyncRunner(connector, store, options);
  await sync.poll();
  assert.equal(sync.status().error, null);
  assert.equal(store.usage().length, 1);
  assert.equal(store.usage()[0]!.fact.metadata.upstream_model_mismatch, false);
  assert.equal(
    (
      await admin.query(
        "SELECT has_table_privilege('meterleaf_reader', 'usage_logs', 'INSERT') AS allowed",
      )
    ).rows[0].allowed,
    false,
  );

  await docker("stop", "--time", "5", name);
  await sync.poll();
  assert.equal(sync.status().error, "source-sync-failed");
  assert.equal(store.usage().length, 1);
  assert.ok(
    backgroundErrors.length > 0,
    "real idle disconnect must reach the callback",
  );
  await docker("start", name);
  await ready();
  await admin.query(
    "INSERT INTO usage_logs VALUES (2, 1, 'gpt-6-astra', now(), 200, 20, 0, 0, NULL, NULL)",
  );
  await sync.poll();
  assert.equal(sync.status().error, null);
  assert.equal(store.usage().length, 2);
  await sync.poll();
  assert.equal(store.usage().length, 2);
  await sync.stop();
  sync = null;
  store.close();
  store = new LedgerStore(path, defaultPriceBook);
  assert.equal(store.usage().length, 2);
  assert.equal(
    store.getState<string>("postgres-smoke:incremental:cursor"),
    "2",
  );
  console.log(
    "PASS: PostgreSQL read-only collection, idle disconnect, outage retry, recovery, replay and SQLite reopen",
  );
} finally {
  await sync?.stop();
  store?.close();
  await admin?.end();
  if (created) await docker("rm", "-fv", name);
  await rm(directory, { recursive: true, force: true });
}
