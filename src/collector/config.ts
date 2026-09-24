import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import { INGEST_KEY_PREFIX, sourceIdSchema } from "../shared/ingest";

const configSchema = z.object({
  server: z.string().url(),
  sourceId: sourceIdSchema,
  key: z.string().startsWith(INGEST_KEY_PREFIX),
  createdAt: z.string(),
});

export type CollectorConfig = z.infer<typeof configSchema>;

export function generateKey(): string {
  return `${INGEST_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** 服务端只保存完整密钥的 SHA-256 十六进制摘要。 */
export function keyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function defaultSourceId(host: string = hostname()): string {
  const slug = host
    .toLowerCase()
    .replace(/\.local$/, "")
    .split(".")[0]!
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return `claude-code-${slug || "mac"}`;
}

/** 服务地址只保留协议、主机与可选子路径；凭据、查询和片段一律拒绝。 */
export function normalizeServer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`无效的服务地址: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("服务地址必须使用 https:// 或 http://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("服务地址不能包含用户名、密码、查询参数或片段");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function isLoopback(server: string): boolean {
  const host = new URL(server).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function loadConfig(path: string): CollectorConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = configSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`配置文件格式无效: ${path}`);
  return parsed.data;
}

/** 配置含写入密钥，目录与文件都只允许当前用户访问。 */
export function saveConfig(
  dataDir: string,
  path: string,
  config: CollectorConfig,
  overwrite: boolean,
) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: overwrite ? "w" : "wx",
  });
  chmodSync(path, 0o600);
}
