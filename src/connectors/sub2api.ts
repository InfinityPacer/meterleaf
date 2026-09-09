import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import type {
  QuotaFact,
  SourceAccount,
  TokenUsage,
  UsageConnector,
  UsageFact,
  UsagePage,
} from "../domain/connector";
import { normalizeSub2ApiImageUsage } from "./sub2api-usage";

type Row = Record<string, unknown>;

/** 连接器只依赖查询能力，测试可以注入单连接 fake 而不触碰真实 PostgreSQL。 */
export interface Sub2ApiQueryExecutor {
  query<RowType extends Row = Row>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: RowType[] }>;
}

export interface Sub2ApiQueryClient extends Sub2ApiQueryExecutor {
  release(): void;
}

export interface Sub2ApiQueryPool extends Sub2ApiQueryExecutor {
  connect?: () => Promise<Sub2ApiQueryClient>;
  end?: () => Promise<void>;
}

/** Sub2API 单实例连接参数；pool 仅用于注入已受控的查询实现。 */
export interface Sub2ApiConnectorOptions {
  sourceId: string;
  connectionString: string;
  ssl?: PoolConfig["ssl"];
  pool?: Sub2ApiQueryPool | Pool;
  /** 空闲连接断线不属于正在执行的读取，由入口记录安全诊断摘要。 */
  onBackgroundError?: (error: unknown) => void;
}

const schemaProbeQuery = `
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('accounts', 'usage_logs')
  ORDER BY table_name, ordinal_position
`;

const requiredColumns = {
  accounts: ["id", "name", "platform", "type"],
  usage_logs: ["id", "account_id", "model", "created_at"],
} as const;

const usageOptionalColumns = [
  ["requested_model", "text"],
  ["upstream_model", "text"],
  ["upstream_response_model", "text"],
  ["upstream_model_mismatch", "boolean"],
  ["service_tier", "text"],
  ["reasoning_effort", "text"],
  ["requested_reasoning_effort", "text"],
  ["input_tokens", "integer"],
  ["output_tokens", "integer"],
  ["cache_creation_tokens", "integer"],
  ["cache_read_tokens", "integer"],
  ["cache_creation_5m_tokens", "integer"],
  ["cache_creation_1h_tokens", "integer"],
  ["total_cost", "numeric"],
  ["actual_cost", "numeric"],
  ["duration_ms", "integer"],
  ["first_token_ms", "integer"],
  ["image_input_tokens", "integer"],
  ["image_output_tokens", "integer"],
  ["video_count", "integer"],
  ["video_duration_seconds", "integer"],
  ["billing_mode", "text"],
  ["long_context_billing_applied", "boolean"],
] as const;

const usageMetadataColumns = [
  "upstream_response_model",
  "upstream_model_mismatch",
  "reasoning_effort",
  "requested_reasoning_effort",
  "duration_ms",
  "first_token_ms",
  "image_input_tokens",
  "image_output_tokens",
  "video_count",
  "video_duration_seconds",
  "billing_mode",
  "long_context_billing_applied",
] as const;

// 只保留来源支持的规范强度；未知值不补默认档位，也不推导推理 token。
const reasoningEffortValues = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const quotaWindows = [
  {
    name: "five-hour",
    prefix: "codex_5h",
  },
  {
    name: "seven-day",
    prefix: "codex_7d",
  },
] as const;

class Sub2ApiSchema {
  private readonly columns = new Map<string, Set<string>>();

  add(tableName: string, columnName: string): void {
    const columns = this.columns.get(tableName) ?? new Set<string>();
    columns.add(columnName);
    this.columns.set(tableName, columns);
  }

  has(tableName: string, columnName: string): boolean {
    return this.columns.get(tableName)?.has(columnName) ?? false;
  }

  validateRequired(): void {
    const missing: string[] = [];
    for (const [tableName, columns] of Object.entries(requiredColumns)) {
      for (const columnName of columns) {
        if (!this.has(tableName, columnName)) {
          missing.push(`${tableName}.${columnName}`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Sub2API schema missing required columns: ${missing.join(", ")}`,
      );
    }
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid static SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function publicTable(tableName: "accounts" | "usage_logs"): string {
  return `${quoteIdentifier("public")}.${quoteIdentifier(tableName)}`;
}

function selectColumn(
  schema: Sub2ApiSchema,
  tableName: string,
  columnName: string,
  sqlType: string,
): string {
  const quoted = quoteIdentifier(columnName);
  if (schema.has(tableName, columnName)) {
    return `${quoted} AS ${quoted}`;
  }
  return `NULL::${sqlType} AS ${quoted}`;
}

function selectCredentialClaim(
  schema: Sub2ApiSchema,
  claimName: string,
  alias: string,
): string {
  const quotedAlias = quoteIdentifier(alias);
  if (!schema.has("accounts", "credentials")) {
    return `NULL::text AS ${quotedAlias}`;
  }
  return `${quoteIdentifier("credentials")} ->> '${claimName}' AS ${quotedAlias}`;
}

function buildUsageQuery(schema: Sub2ApiSchema): string {
  const columns = [
    selectColumn(schema, "usage_logs", "id", "bigint"),
    selectColumn(schema, "usage_logs", "account_id", "bigint"),
    selectColumn(schema, "usage_logs", "model", "text"),
    selectColumn(schema, "usage_logs", "created_at", "timestamptz"),
    ...usageOptionalColumns.map(([columnName, sqlType]) =>
      selectColumn(schema, "usage_logs", columnName, sqlType),
    ),
  ];

  return `
    SELECT ${columns.join(", ")}
    FROM ${publicTable("usage_logs")}
    WHERE ($1::bigint IS NULL OR ${quoteIdentifier("id")} > $1::bigint)
    ORDER BY ${quoteIdentifier("id")} ASC
    LIMIT $2
  `;
}

function buildAccountsQuery(schema: Sub2ApiSchema): string {
  const columns = [
    selectColumn(schema, "accounts", "id", "bigint"),
    selectColumn(schema, "accounts", "name", "text"),
    selectColumn(schema, "accounts", "platform", "text"),
    selectColumn(schema, "accounts", "type", "text"),
    selectColumn(schema, "accounts", "parent_account_id", "bigint"),
    selectCredentialClaim(schema, "plan_type", "plan_type"),
    selectCredentialClaim(schema, "chatgpt_account_id", "subject_account_id"),
    selectCredentialClaim(schema, "chatgpt_user_id", "subject_user_id"),
  ];

  return `
    SELECT ${columns.join(", ")}
    FROM ${publicTable("accounts")}
    ORDER BY ${quoteIdentifier("id")} ASC
  `;
}

function buildQuotaQuery(): string {
  const extra = quoteIdentifier("extra");
  const columns = [quoteIdentifier("id")];
  for (const window of quotaWindows) {
    columns.push(
      `${extra} ->> '${window.prefix}_used_percent' AS ${quoteIdentifier(`${window.prefix}_used_percent`)}`,
      `${extra} ->> '${window.prefix}_reset_at' AS ${quoteIdentifier(`${window.prefix}_reset_at`)}`,
      `${extra} ->> '${window.prefix}_window_minutes' AS ${quoteIdentifier(`${window.prefix}_window_minutes`)}`,
    );
  }
  columns.push(
    `${extra} ->> 'codex_usage_updated_at' AS ${quoteIdentifier("codex_usage_updated_at")}`,
  );

  return `
    SELECT ${columns.join(", ")}
    FROM ${publicTable("accounts")}
    ORDER BY ${quoteIdentifier("id")} ASC
  `;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function optionalReasoningEffort(value: unknown): string | null {
  const normalized = optionalText(value)?.toLowerCase() ?? null;
  return normalized !== null && reasoningEffortValues.has(normalized)
    ? normalized
    : null;
}

function requiredText(value: unknown, fieldName: string): string {
  const normalized = optionalText(value);
  if (normalized === null) {
    throw new Error(`Sub2API row has missing or invalid ${fieldName}`);
  }
  return normalized;
}

function bigintText(value: unknown, fieldName: string): string {
  let parsed: bigint;
  try {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error("unsafe number");
      }
      parsed = BigInt(value);
    } else if (typeof value === "bigint") {
      parsed = value;
    } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      parsed = BigInt(value.trim());
    } else {
      throw new Error("not a decimal bigint");
    }
  } catch {
    throw new Error(`Sub2API row has invalid bigint ${fieldName}`);
  }

  if (parsed < 0n) {
    throw new Error(`Sub2API row has invalid bigint ${fieldName}`);
  }
  return parsed.toString();
}

function optionalBigintText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return bigintText(value, "parent_account_id");
  } catch {
    return null;
  }
}

function normalizeCursor(cursor: string | null): string | null {
  if (cursor === null || cursor.trim() === "") {
    return null;
  }
  return bigintText(cursor, "cursor");
}

function safeInteger(value: unknown, nonNegative = true): number | null {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    parsed = Number(value);
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return null;
  }

  if (!Number.isSafeInteger(parsed) || (nonNegative && parsed < 0)) {
    return null;
  }
  return parsed;
}

function tokenCount(value: unknown): number | null {
  return safeInteger(value);
}

function decimalText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toString() : null;
  }
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)
    ? normalized
    : null;
}

function timestampText(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function requiredTimestamp(value: unknown): string {
  const normalized = timestampText(value);
  if (normalized === null) {
    throw new Error("Sub2API row has invalid usage_logs.created_at");
  }
  return normalized;
}

function percentage(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    parsed = Number(value.trim());
  } else {
    return null;
  }
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : null;
}

function windowMinutes(value: unknown): number | null {
  const parsed = safeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.trim().toLowerCase() === "true") {
      return true;
    }
    if (value.trim().toLowerCase() === "false") {
      return false;
    }
  }
  return null;
}

function accountKind(type: string): SourceAccount["kind"] {
  switch (type.toLowerCase()) {
    case "api":
    case "api-key":
    case "api_key":
    case "apikey":
      return "api";
    case "cookie":
    case "oauth":
    case "setup-token":
    case "setup_token":
      return "subscription";
    default:
      return "unknown";
  }
}

function subjectKey(accountId: unknown, userId: unknown): string | null {
  const account = optionalText(accountId);
  const user = optionalText(userId);
  if (account === null && user === null) {
    return null;
  }

  const digestInput = [
    `chatgpt_account_id=${account ?? ""}`,
    `chatgpt_user_id=${user ?? ""}`,
  ].join("\n");
  return `sha256:${createHash("sha256").update(digestInput).digest("hex")}`;
}

function usageMetadata(
  row: Row,
  storedModel: string,
  effectiveModel: string,
): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {};

  for (const columnName of usageMetadataColumns) {
    const value = row[columnName];
    if (
      columnName === "reasoning_effort" ||
      columnName === "requested_reasoning_effort"
    ) {
      // requested 是策略映射前的请求值，reasoning_effort 是策略处理后的有效值。
      const normalized = optionalReasoningEffort(value);
      if (normalized !== null) {
        metadata[columnName] = normalized;
      }
      continue;
    }
    if (
      columnName === "billing_mode" ||
      columnName === "upstream_response_model"
    ) {
      const normalized = optionalText(value);
      if (normalized !== null) {
        metadata[columnName] = normalized;
      }
      continue;
    }
    if (
      columnName === "long_context_billing_applied" ||
      columnName === "upstream_model_mismatch"
    ) {
      const normalized = booleanValue(value);
      if (normalized !== null) {
        metadata[columnName] = normalized;
      }
      continue;
    }

    const normalized = safeInteger(value);
    if (normalized !== null) {
      metadata[columnName] = normalized;
    }
  }

  const requestedModel = optionalText(row.requested_model);
  if (requestedModel !== null && requestedModel !== storedModel) {
    metadata.requested_model = requestedModel;
  }
  if (effectiveModel !== storedModel) {
    metadata.stored_model = storedModel;
  }

  return metadata;
}

function usageTokens(
  row: Row,
  metadata: Record<string, string | number | boolean | null>,
): TokenUsage {
  const cacheRead = tokenCount(row.cache_read_tokens);
  const image = normalizeSub2ApiImageUsage(metadata);
  return {
    input: tokenCount(row.input_tokens),
    output: tokenCount(row.output_tokens),
    cacheRead,
    cacheWrite: tokenCount(row.cache_creation_tokens),
    cacheWrite5m: tokenCount(row.cache_creation_5m_tokens),
    cacheWrite1h: tokenCount(row.cache_creation_1h_tokens),
    reasoning: null,
    ...(image === undefined ? {} : { image }),
  };
}

function mapUsageRow(row: Row, sourceId: string): UsageFact {
  const externalId = bigintText(row.id, "usage_logs.id");
  const accountExternalId = bigintText(row.account_id, "usage_logs.account_id");
  const storedModel = requiredText(row.model, "usage_logs.model");
  const upstreamModel = optionalText(row.upstream_model);
  // 响应模型作为审计证据保留；未明确其计费语义时，不用响应别名覆盖发送模型。
  const effectiveModel = upstreamModel ?? storedModel;
  const metadata = usageMetadata(row, storedModel, effectiveModel);

  return {
    sourceId,
    externalId,
    occurredAt: requiredTimestamp(row.created_at),
    accountExternalId,
    model: effectiveModel,
    upstreamModel,
    tier: optionalText(row.service_tier),
    tokens: usageTokens(row, metadata),
    gatewayCost: decimalText(row.total_cost),
    gatewayBilled: decimalText(row.actual_cost),
    upstreamUsd: null,
    upstreamCredits: null,
    metadata,
  };
}

function mapAccountRow(row: Row, sourceId: string): SourceAccount {
  const externalId = bigintText(row.id, "accounts.id");
  const type = requiredText(row.type, "accounts.type");
  return {
    sourceId,
    externalId,
    name: requiredText(row.name, "accounts.name"),
    platform: requiredText(row.platform, "accounts.platform"),
    kind: accountKind(type),
    plan: optionalText(row.plan_type),
    parentExternalId: optionalBigintText(row.parent_account_id),
    subjectKey: subjectKey(row.subject_account_id, row.subject_user_id),
  };
}

function quotaSignal(row: Row, prefix: string): boolean {
  return ["used_percent", "reset_at", "window_minutes"].some((suffix) => {
    const value = row[`${prefix}_${suffix}`];
    return value !== null && value !== undefined && String(value).trim() !== "";
  });
}

function mapQuotaRow(
  row: Row,
  sourceId: string,
  window: (typeof quotaWindows)[number],
): QuotaFact | null {
  if (!quotaSignal(row, window.prefix)) {
    return null;
  }

  const accountExternalId = bigintText(row.id, "accounts.id");
  return {
    sourceId,
    externalId: `${accountExternalId}:${window.name}`,
    accountExternalId,
    window: window.name,
    percent: percentage(row[`${window.prefix}_used_percent`]),
    sampledAt: timestampText(row.codex_usage_updated_at),
    resetsAt: timestampText(row[`${window.prefix}_reset_at`]),
    windowMinutes: windowMinutes(row[`${window.prefix}_window_minutes`]),
  };
}

class Sub2ApiConnector implements UsageConnector {
  readonly sourceId: string;

  private readonly pool: Sub2ApiQueryPool;
  private readonly ownsPool: boolean;
  private schemaPromise: Promise<Sub2ApiSchema> | null = null;
  private closed = false;
  private errorPool: Pool | null = null;
  private readonly onPoolError: (error: Error) => void;

  constructor(options: Sub2ApiConnectorOptions) {
    this.onPoolError = (error) => {
      // pg 已移除坏连接；消费 error 事件，避免空闲断线成为未处理异常。
      try {
        options.onBackgroundError?.(error);
      } catch {
        // 诊断回调失败不能阻止连接池在后续读取时重连。
      }
    };
    const sourceId = options.sourceId.trim();
    if (sourceId === "") {
      throw new Error("Sub2API sourceId is required");
    }
    if (options.pool === undefined && options.connectionString.trim() === "") {
      throw new Error("Sub2API connectionString is required");
    }

    this.sourceId = sourceId;
    this.ownsPool = options.pool === undefined;
    if (options.pool !== undefined) {
      this.pool = options.pool as unknown as Sub2ApiQueryPool;
      if (options.pool instanceof Pool) this.listenForErrors(options.pool);
      return;
    }

    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      connectionTimeoutMillis: 5000,
      options: "-c default_transaction_read_only=on",
      query_timeout: 15000,
      statement_timeout: 10000,
    };
    if (options.ssl !== undefined) {
      poolConfig.ssl = options.ssl;
    }
    const pool = new Pool(poolConfig);
    this.pool = pool as unknown as Sub2ApiQueryPool;
    this.listenForErrors(pool);
  }

  private listenForErrors(pool: Pool) {
    this.errorPool = pool;
    pool.on("error", this.onPoolError);
  }

  async readUsage(cursor: string | null, limit: number): Promise<UsagePage> {
    this.ensureOpen();
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Sub2API usage limit must be a positive safe integer");
    }

    const normalizedCursor = normalizeCursor(cursor);
    const schema = await this.getSchema();
    const rows = await this.runRead("usage", async (executor) => {
      const result = await executor.query<Row>(buildUsageQuery(schema), [
        normalizedCursor,
        limit + 1,
      ]);
      return result.rows;
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const records = pageRows.map((row) => mapUsageRow(row, this.sourceId));
    return {
      records,
      nextCursor: records.at(-1)?.externalId ?? normalizedCursor,
      hasMore,
    };
  }

  async readAccounts(): Promise<SourceAccount[]> {
    this.ensureOpen();
    const schema = await this.getSchema();
    const rows = await this.runRead("accounts", async (executor) => {
      const result = await executor.query<Row>(buildAccountsQuery(schema));
      return result.rows;
    });
    return rows.map((row) => mapAccountRow(row, this.sourceId));
  }

  async readQuotas(): Promise<QuotaFact[]> {
    this.ensureOpen();
    const schema = await this.getSchema();
    if (!schema.has("accounts", "extra")) {
      return [];
    }

    const rows = await this.runRead("quotas", async (executor) => {
      const result = await executor.query<Row>(buildQuotaQuery());
      return result.rows;
    });
    const quotas: QuotaFact[] = [];
    for (const row of rows) {
      for (const window of quotaWindows) {
        const quota = mapQuotaRow(row, this.sourceId, window);
        if (quota !== null) {
          quotas.push(quota);
        }
      }
    }
    return quotas;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.ownsPool) {
      await this.pool.end?.();
    }
    this.errorPool?.removeListener("error", this.onPoolError);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("Sub2API connector is closed");
    }
  }

  private async getSchema(): Promise<Sub2ApiSchema> {
    if (this.schemaPromise === null) {
      this.schemaPromise = this.runRead("schema probe", async (executor) => {
        const result = await executor.query<Row>(schemaProbeQuery);
        const schema = new Sub2ApiSchema();
        for (const row of result.rows) {
          const tableName = optionalText(row.table_name);
          const columnName = optionalText(row.column_name);
          if (tableName !== null && columnName !== null) {
            schema.add(tableName, columnName);
          }
        }
        schema.validateRequired();
        return schema;
      }).catch((error: unknown) => {
        this.schemaPromise = null;
        throw new Error(`Sub2API schema probe failed: ${errorText(error)}`, {
          cause: error,
        });
      });
    }
    return this.schemaPromise;
  }

  private async runRead<T>(
    label: string,
    operation: (executor: Sub2ApiQueryExecutor) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.withReadOnlyTransaction(operation);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Sub2API schema probe failed:")
      ) {
        throw error;
      }
      throw new Error(`Sub2API ${label} read failed: ${errorText(error)}`, {
        cause: error,
      });
    }
  }

  private async withReadOnlyTransaction<T>(
    operation: (executor: Sub2ApiQueryExecutor) => Promise<T>,
  ): Promise<T> {
    const client =
      this.pool.connect === undefined ? null : await this.pool.connect();
    const executor = client ?? this.pool;
    let transactionStarted = false;
    try {
      await executor.query("BEGIN TRANSACTION READ ONLY");
      transactionStarted = true;
      const result = await operation(executor);
      await executor.query("COMMIT");
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await executor.query("ROLLBACK");
        } catch {
          // Keep the original read error; rollback failure cannot make a read successful.
        }
      }
      throw error;
    } finally {
      client?.release();
    }
  }
}

/** 创建只读 Sub2API 连接器，并将网关计费与上游独立估值分开。 */
export function createSub2ApiConnector(
  options: Sub2ApiConnectorOptions,
): UsageConnector {
  return new Sub2ApiConnector(options);
}
