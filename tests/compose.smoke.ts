import { expect } from "bun:test";
import { mkdtemp, mkdir, cp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// 仅创建随机测试项目，来源为合成 PostgreSQL，不接受真实实例地址。
const dir = await mkdtemp(join(tmpdir(), "meterleaf-compose-"));
const data = join(dir, "data");
await mkdir(data);
const project = `meterleaf-test-${randomUUID().slice(0, 8)}`;
const env = {
  ...process.env,
  SUB2API_DATABASE_URL: "postgres://meterleaf_reader@postgres:5432/postgres",
  METERLEAF_TEST_DATA_DIR: data,
};
async function compose(args: string[], input?: string) {
  const child = Bun.spawn(
    [
      "docker",
      "--context",
      "desktop-linux",
      "compose",
      "--project-directory",
      resolve("."),
      "-p",
      project,
      "-f",
      "compose.yaml",
      "-f",
      "tests/fixtures/compose.smoke.yaml",
      ...args,
    ],
    {
      env,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(`${args[0]} failed: ${error}`);
  return output.trim();
}
let base = "";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
async function online() {
  base = `http://${await compose(["port", "meterleaf", "4318"])}`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      await api("/api/health");
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error("Compose app did not become ready");
}
async function view() {
  await api("/api/view?days=7");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await api("/api/view?days=7&refresh=false");
    if (result.lifetimeTotals?.count === 2) return result;
    await Bun.sleep(300);
  }
  throw new Error("Expected two synthetic requests");
}
try {
  await compose(["config", "-q"]);
  await compose(["build", "meterleaf"]);
  await compose([
    "run",
    "--pull",
    "never",
    "--rm",
    "--no-deps",
    "--user",
    "root",
    "--entrypoint",
    "sh",
    "meterleaf",
    "-c",
    "chown bun:bun /app/app_data",
  ]);
  await compose(["up", "-d", "--wait", "postgres"]);
  await compose(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    `
CREATE TABLE accounts (id bigint PRIMARY KEY, name text, platform text, type text);
CREATE TABLE usage_logs (id bigint PRIMARY KEY, account_id bigint, model text, created_at timestamptz, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_creation_tokens integer);
CREATE ROLE meterleaf_reader LOGIN;
GRANT SELECT ON accounts, usage_logs TO meterleaf_reader;
INSERT INTO accounts VALUES (1, 'synthetic', 'openai', 'apikey');
INSERT INTO usage_logs VALUES (1,1,'gpt-6-astra',now(),100,10,0,0),(2,1,'gpt-6-astra',now(),200,20,0,0);
`,
  );
  await compose(["up", "-d", "--pull", "never", "meterleaf"]);
  await online();
  expect((await api("/api/sync")).autoEnabled).toBe(false);
  expect((await api("/api/sync")).localRecords).toBe(0);
  await api("/api/sync", "POST");
  for (let n = 0; n < 100 && (await api("/api/sync")).localRecords !== 2; n++)
    await Bun.sleep(200);
  const before = await view();
  expect(before.lifetimeTotals.tokens.total).toBe(330);
  const id = before.accounts[0].id;
  await api("/api/accounts/archive", "PUT", { id, archived: true });
  await api("/api/accounts/archive", "PUT", { id, hidden: true });
  await compose(["stop", "meterleaf"]);
  // 模拟部署中的开发期版本标记；数据和结构与首版兼容，迁移必须保留全部状态。
  await compose([
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "bun",
    "meterleaf",
    "-e",
    `import {Database} from 'bun:sqlite'; const report='meterleaf.sqlite.reports.sqlite'; const lifetime='meterleaf.sqlite.reports.sqlite.lifetime'; for(const [name,version] of [['meterleaf.sqlite',1],[report,2],[lifetime,0],['meterleaf.sqlite.reports.sqlite.views',0]]) {const db=new Database('/app/app_data/'+name); if(name===report||name===lifetime)db.exec('DROP TABLE IF EXISTS schema_version'); db.exec('PRAGMA user_version='+version); db.close();}`,
  ]);
  await compose(["up", "-d", "--pull", "never", "meterleaf"]);
  await online();
  expect((await view()).lifetimeTotals.tokens.total).toBe(330);
  expect((await api("/api/accounts/archive")).hidden).toEqual([id]);
  await compose(["stop", "meterleaf"]);
  const versions = await compose([
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "bun",
    "meterleaf",
    "-e",
    `import {Database} from 'bun:sqlite'; const baseline='a17c9e4b620f'; for(const name of ['meterleaf.sqlite','meterleaf.sqlite.reports.sqlite','meterleaf.sqlite.reports.sqlite.lifetime','meterleaf.sqlite.reports.sqlite.views']) {const db=new Database('/app/app_data/'+name,{readonly:true}); const row=db.query('SELECT revision, down_revision FROM schema_revisions').get(); if(row?.revision!==baseline || row?.down_revision!==null)throw new Error('schema revision mismatch'); if(db.query('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('integrity failure'); db.close();} console.log('schema-ok');`,
  ]);
  expect(versions).toBe("schema-ok");
  await cp(data, join(dir, "backup"), { recursive: true });
  await rename(data, join(dir, "before-restore"));
  await cp(join(dir, "backup"), data, { recursive: true });
  await compose(["up", "-d", "--pull", "never", "meterleaf"]);
  await online();
  const restored = await view();
  expect(restored.lifetimeTotals.tokens.total).toBe(330);
  expect(restored.lifetimeTotals.usd).toBe(before.lifetimeTotals.usd);
  expect((await api("/api/accounts/archive")).archived).toEqual([id]);
  expect((await api("/api/accounts/archive")).hidden).toEqual([id]);
  console.log(
    JSON.stringify({
      cleanComposeInstall: true,
      manualSync: true,
      legacyUpgrade: true,
      backupRestore: true,
      requests: 2,
      tokens: 330,
    }),
  );
} catch (error) {
  console.error(await compose(["logs", "--tail", "80", "meterleaf"]));
  throw error;
} finally {
  await compose(["down", "--volumes", "--remove-orphans"]);
  await rm(dir, { recursive: true, force: true });
}
