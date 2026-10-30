import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { IngestUsage } from "../shared/ingest";
import { routeChannel, type ChannelAccountRule } from "./channel-accounts";
import { emptySourceReport, type SourceReaderReport } from "./sources";
import type { CollectorState } from "./state";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export interface OpenCodeReaderSources {
  database: string;
  start: string;
  channelAccounts: readonly ChannelAccountRule[];
}

export interface OpenCodeReaderReport extends SourceReaderReport {
  unreadable: number;
  /** 本轮读取的游标起点；每轮从上次游标减 10 分钟开始，靠唯一标识去重。 */
  fromCursor: number | null;
}

export function emptyOpenCodeReport(): OpenCodeReaderReport {
  return {
    ...emptySourceReport("opencode"),
    unreadable: 0,
    fromCursor: null,
  };
}

/** 增量读取的回看窗口：期间可能错过的时间差靠 external_id 去重补齐。 */
const overlapMs = 10 * 60_000;

interface MessageRow {
  id: string;
  time_updated: number;
  data: string;
}

/**
 * 只读打开 OpenCode 数据库。文件按 WAL 模式写入，OpenCode 运行中也能读；
 * 文件不存在时返回 null，该来源本轮为空。
 */
function openDatabase(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * 读取一轮 OpenCode 本地消息。一行 `type='assistant'` 且已完成的记录是一次请求；
 * `model.providerID` 是通道，账户在读取时确定。tokens.input 已是未缓存输入，
 * 直接作为 input；output 含可见输出与推理，缺失字段保持未知，不补零。
 * cost 字段不参与估值。会上传会话 ID、内容与路径之外的信息，不读出这些字段。
 */
export function readOpenCode(
  state: CollectorState,
  sources: OpenCodeReaderSources,
): OpenCodeReaderReport {
  const report = emptyOpenCodeReport();
  const db = openDatabase(sources.database);
  if (!db) return report;
  try {
    const table = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_message'",
      )
      .get("session_message");
    if (!table) return report;
    const lastCursor = state.opencodeCursor();
    const since = lastCursor !== null ? Math.max(0, lastCursor - overlapMs) : 0;
    report.fromCursor = since;
    let rows: MessageRow[];
    try {
      rows = db
        .query<MessageRow, [number]>(
          `SELECT id, time_updated, data FROM session_message
           WHERE type = 'assistant' AND time_updated > ?
             AND json_extract(data, '$.time.completed') IS NOT NULL
           ORDER BY time_updated ASC`,
        )
        .all(since);
    } catch {
      // 读取瞬间与 OpenCode 写入冲突时本轮为空，下一轮从原游标重读。
      report.unreadable++;
      return report;
    }
    if (rows.length === 0) return report;
    let cursor = lastCursor ?? 0;
    state.db.transaction(() => {
      for (const row of rows) {
        // 无论行内容结果如何，游标都推进到本轮读到的最新行。
        cursor = Math.max(cursor, row.time_updated);
        let data: RecordValue | null;
        try {
          data = object(JSON.parse(row.data));
        } catch {
          data = null;
        }
        const model = object(data?.model);
        const tokens = object(data?.tokens);
        const completed = count(
          (object(data?.time) as RecordValue | null)?.completed,
        );
        const modelId = model?.id;
        if (!data || !completed || !tokens || typeof modelId !== "string") {
          // 缺模型或时间戳的记录无法成为一次计量请求，跳过并计数。
          report.invalid++;
          continue;
        }
        report.read++;
        const occurredAt = new Date(completed).toISOString();
        if (occurredAt < sources.start) continue;
        const provider = model?.providerID;
        const account = routeChannel(
          "opencode",
          typeof provider === "string" ? provider : null,
          sources.channelAccounts,
        );
        if (!account) {
          const key = typeof provider === "string" ? provider : "(缺失)";
          report.skipped[key] = (report.skipped[key] ?? 0) + 1;
          continue;
        }
        const input = count(tokens.input);
        const visible = count(tokens.output);
        const reasoning = count(tokens.reasoning);
        // 输出侧两个加数有一个缺失时 output 未知，不按另一部分凑数。
        const cache = object(tokens.cache);
        const usage: IngestUsage = {
          externalId: "opencode-" + hash(row.id),
          occurredAt,
          accountExternalId: account.id,
          model: modelId,
          // variant 是推理档位，不是计价档位；OpenCode 记录不区分优先级等计价档。
          tier: null,
          tokens: {
            input,
            output:
              visible !== null && reasoning !== null
                ? visible + reasoning
                : null,
            cacheRead: count(cache?.read),
            cacheWrite: count(cache?.write),
            cacheWrite5m: null,
            cacheWrite1h: null,
            reasoning,
          },
          metadata: {
            origin: "opencode_local",
            reasoning_effort:
              typeof model?.variant === "string" && model.variant.length > 0
                ? model.variant
                : null,
          },
        };
        state.upsertAccount({
          externalId: account.id,
          name: account.name,
          platform: account.platform,
          kind: account.kind,
          plan: account.plan,
          subjectKey: null,
        });
        if (state.recordSourceUsage("opencode", usage)) report.recorded++;
      }
      // 游标与入账在同一事务提交；中途失败整体回滚，下一轮从原进度重读。
      state.saveOpencodeCursor(cursor);
    })();
    return report;
  } finally {
    db.close();
  }
}
