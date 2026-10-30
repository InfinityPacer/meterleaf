import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import {
  accountProfileConflict,
  channelAccountRuleSchema,
} from "./channel-accounts";
import { INGEST_KEY_PREFIX, sourceIdSchema } from "../shared/ingest";
import { modelAccountRuleSchema } from "./model-accounts";
import { taskSchema } from "./tasks";

/** 额外 Claude 订阅账户：各自的 CLAUDE_CONFIG_DIR，以及可选的额度缓存。 */
export const claudeProfileSchema = z
  .object({
    configDir: z.string().startsWith("/"),
    statuslineCache: z.string().startsWith("/").optional(),
  })
  .strict();

export type ClaudeProfile = z.infer<typeof claudeProfileSchema>;

/** 新来源在读取器打开路径之前判断，路径缺失只让该来源本轮为空。 */
const codexSourceSchema = z
  .object({
    enabled: z.boolean().default(true),
    home: z.string().startsWith("/").optional(),
  })
  .strict();

const opencodeSourceSchema = z
  .object({
    enabled: z.boolean().default(true),
    database: z.string().startsWith("/").optional(),
  })
  .strict();

/**
 * 新来源只上传不早于这一时刻的记录，是两个来源的固定起点配置项。
 * Codex 与 OpenCode 的本地记录历史比账本接入早，不支持更早的费率与账户推断。
 */
export const SOURCE_START = "2026-09-20T00:00:00.000Z";

/** 本机 OTEL 中继的默认端口；避开其他 OTLP 采集器常用的 4318。 */
export const DEFAULT_OTEL_RELAY_PORT = 4319;

/** 只监听回环地址，因此端口可以自行调整，不需要鉴权。 */
export const otelRelaySchema = z
  .object({
    port: z.number().int().min(1024).max(65535),
  })
  .strict();

const configSchema = z
  .object({
    server: z.string().url(),
    sourceId: sourceIdSchema,
    key: z.string().startsWith(INGEST_KEY_PREFIX),
    createdAt: z.string(),
    /** 可选额度来源：用户状态栏脚本写出的 rate_limits TSV 绝对路径。 */
    statuslineCache: z.string().startsWith("/").optional(),
    /** 可选：按模型名把用量归入独立账户，按顺序取第一条命中的规则。 */
    modelAccounts: z.array(modelAccountRuleSchema).max(50).optional(),
    /** 可选：按「来源加通道」把 Codex 与 OpenCode 的用量归入独立账户。 */
    channelAccounts: z.array(channelAccountRuleSchema).max(50).optional(),
    /** 可选：同一台电脑上通过 CLAUDE_CONFIG_DIR 登录的其他 Claude 账户。 */
    claudeProfiles: z.array(claudeProfileSchema).max(20).optional(),
    /** 可选：Codex 本地记录读取器；目录不存在时该来源本轮为空。 */
    codex: codexSourceSchema.optional(),
    /** 可选：OpenCode 本地数据库读取器；数据库不存在时该来源本轮为空。 */
    opencode: opencodeSourceSchema.optional(),
    /** 可选：本机 OTEL 中转的监听端口，省略时使用 4319。 */
    otelRelay: otelRelaySchema.optional(),
    /** 可选：sync 收尾时按间隔运行的额外任务，按登记顺序执行，名称不能重复。 */
    tasks: z
      .array(taskSchema)
      .max(20)
      .refine(
        (tasks) =>
          new Set(tasks.map((task) => task.name)).size === tasks.length,
        { message: "任务名称不能重复" },
      )
      .optional(),
  })
  .superRefine((config, context) => {
    // 同一账户 id 由模型映射与渠道规则共同维护时，资料必须完全一致。
    const conflict = accountProfileConflict([
      ...(config.modelAccounts ?? []).map((rule) => ({
        id: rule.id,
        name: rule.name,
        platform: rule.platform,
        kind: rule.kind,
        plan: rule.plan,
        label: `模型 ${rule.match}`,
      })),
      ...(config.channelAccounts ?? []).map((rule) => ({
        id: rule.id,
        name: rule.name,
        platform: rule.platform,
        kind: rule.kind,
        plan: rule.plan,
        label: `${rule.source}:${rule.channel}`,
      })),
    ]);
    if (conflict)
      context.addIssue({ code: "custom", path: [], message: conflict });
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
  if (!parsed.success) {
    // 校验消息指明冲突或无效的字段；配置文件本身不含对话内容，可原样输出。
    const issues = parsed.error.issues
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .slice(0, 3)
      .join("；");
    throw new Error(`配置文件格式无效: ${path}（${issues}）`);
  }
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
