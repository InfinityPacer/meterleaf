export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogLevelSetting = LogLevel | "silent";

export type ErrorKind =
  "sql" | "storage" | "network" | "timeout" | "configuration" | "unknown";

export interface SafeErrorSummary {
  name: string;
  kind: ErrorKind;
  code?: string;
  causeDepth?: number;
}

export interface LogEvent {
  time: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export type LogSink = (event: LogEvent) => void;
export type LogFields = Record<string, unknown>;

export interface DiagnosticsLogger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface DiagnosticsLoggerOptions {
  level?: LogLevelSetting;
  sink?: LogSink;
  now?: () => string;
}

const levelPriority: Record<LogLevelSetting, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

const networkCodes = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_NETWORK",
  "ERR_SOCKET_CLOSED",
  "ERR_SOCKET_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function property(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function stringProperty(value: unknown, key: string): string | null {
  const candidate = property(value, key);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function safeName(value: string | null): string {
  return value !== null && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value
    : "Error";
}

function isSqlState(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code);
}

function isSafeDiagnosticCode(code: string): boolean {
  return (
    isSqlState(code) ||
    networkCodes.has(code) ||
    /^SQLITE_[A-Z0-9_]{1,48}$/.test(code) ||
    /^ERR_[A-Z0-9_]{1,48}$/.test(code) ||
    /^UND_ERR_[A-Z0-9_]{1,48}$/.test(code)
  );
}

function diagnosticCode(value: unknown): string | null {
  for (const key of ["code", "sqlState", "sqlstate", "sql_state"]) {
    const candidate = stringProperty(value, key)?.trim().toUpperCase() ?? null;
    if (candidate !== null && isSafeDiagnosticCode(candidate)) return candidate;
  }
  return null;
}

function kindFor(name: string | null, code: string | null): ErrorKind {
  const normalizedName = name?.toLowerCase() ?? "";
  if (code !== null && isSqlState(code)) return "sql";
  if (code !== null && code.startsWith("SQLITE_")) return "storage";
  if (code !== null && (/TIMEOUT/.test(code) || code === "ETIMEDOUT"))
    return "timeout";
  if (code !== null && networkCodes.has(code)) return "network";
  if (normalizedName.includes("timeout")) return "timeout";
  if (
    normalizedName.includes("network") ||
    normalizedName.includes("socket") ||
    normalizedName.includes("fetch")
  ) {
    return "network";
  }
  if (
    normalizedName.includes("sqlite") ||
    normalizedName.includes("storage") ||
    normalizedName.includes("database")
  ) {
    return "storage";
  }
  if (normalizedName.includes("postgres") || normalizedName.includes("sql")) {
    return "sql";
  }
  if (normalizedName.includes("config")) return "configuration";
  return "unknown";
}

interface CodeCandidate {
  code: string;
  kind: ErrorKind;
  depth: number;
  priority: number;
}

function candidateFor(value: unknown, depth: number): CodeCandidate | null {
  const code = diagnosticCode(value);
  if (code === null || !isSafeDiagnosticCode(code)) return null;
  const kind = kindFor(stringProperty(value, "name"), code);
  const priority = isSqlState(code)
    ? 1
    : code.startsWith("SQLITE_")
      ? 2
      : networkCodes.has(code)
        ? 3
        : 4;
  return { code, kind, depth, priority };
}

/** 提取可供排障的有限分类；绝不把原始 message、stack 或连接信息写入摘要。 */
export function summarizeError(error: unknown): SafeErrorSummary {
  let current: unknown = error;
  let depth = 0;
  let name = "Error";
  let inferredKind: ErrorKind = "unknown";
  let selected: CodeCandidate | null = null;
  const seen = new Set<object>();

  while (current !== null && current !== undefined) {
    if (isRecord(current)) {
      if (depth === 0) name = safeName(stringProperty(current, "name"));
      const currentName = stringProperty(current, "name");
      const candidateKind = kindFor(currentName, null);
      if (inferredKind === "unknown" && candidateKind !== "unknown") {
        inferredKind = candidateKind;
      }
      const candidate = candidateFor(current, depth);
      if (
        candidate !== null &&
        (selected === null || candidate.priority < selected.priority)
      ) {
        selected = candidate;
      }
      if (seen.has(current)) break;
      seen.add(current);
    }

    const next = property(current, "cause");
    if (next === undefined || next === null) break;
    current = next;
    depth += 1;
    if (depth > 8) break;
  }

  const result: SafeErrorSummary = {
    name,
    kind: selected?.kind ?? inferredKind,
  };
  if (selected !== null) {
    result.code = selected.code;
    result.causeDepth = selected.depth;
  }
  return result;
}

function isSafeErrorSummary(value: unknown): value is SafeErrorSummary {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    !("message" in value) &&
    !("stack" in value)
  );
}

function sanitizeFields(fields: LogFields | undefined): LogFields {
  const result = { ...(fields ?? {}) };
  delete result.time;
  delete result.level;
  delete result.event;
  if ("error" in result) {
    result.error = isSafeErrorSummary(result.error)
      ? {
          name: result.error.name,
          kind: result.error.kind,
          ...(result.error.code !== undefined
            ? { code: result.error.code }
            : {}),
          ...(result.error.causeDepth !== undefined
            ? { causeDepth: result.error.causeDepth }
            : {}),
        }
      : summarizeError(result.error);
  }
  return result;
}

function stdoutSink(event: LogEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function normalizeLevel(value: string | undefined): LogLevelSetting {
  switch (value?.trim().toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "silent":
      return value.trim().toLowerCase() as LogLevelSetting;
    default:
      return "info";
  }
}

/** 读取独立日志配置；无效值按 info 处理，不改变主配置校验。 */
export function logLevelFromEnv(
  env: Record<string, string | undefined> = process.env,
): LogLevelSetting {
  return normalizeLevel(env.METERLEAF_LOG_LEVEL);
}

/** 创建单行 JSON logger；sink 适合测试或由入口接入其他受控输出。 */
export function createDiagnosticsLogger(
  options: DiagnosticsLoggerOptions = {},
): DiagnosticsLogger {
  const level = options.level ?? logLevelFromEnv();
  const sink = options.sink ?? stdoutSink;
  const now = options.now ?? (() => new Date().toISOString());

  const log = (
    eventLevel: LogLevel,
    event: string,
    fields?: LogFields,
  ): void => {
    if (levelPriority[eventLevel] < levelPriority[level]) return;
    const record: LogEvent = {
      time: now(),
      level: eventLevel,
      event,
      ...sanitizeFields(fields),
    };
    try {
      sink(record);
    } catch {
      // 日志输出故障不应改变同步和服务的结果。
    }
  };

  return {
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}

/** 同步默认使用的静默 logger，避免改变既有直接调用者的输出。 */
export const silentLogger: DiagnosticsLogger = createDiagnosticsLogger({
  level: "silent",
  sink: () => {},
});
