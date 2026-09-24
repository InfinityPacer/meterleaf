/** 合成的 Claude Code JSONL 行，结构与 2.1.x 一致，不含任何真实账户数据。 */
export interface AssistantLineOptions {
  requestId?: string | null;
  messageId: string;
  sessionId?: string;
  model?: string;
  timestamp: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  usage?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export function assistantLine(options: AssistantLineOptions): string {
  const usage = options.usage ?? {
    input_tokens: options.input ?? 0,
    output_tokens: options.output ?? 0,
    cache_read_input_tokens: options.cacheRead ?? 0,
    cache_creation_input_tokens: options.cacheWrite ?? 0,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: options.cacheWrite ?? 0,
    },
    service_tier: "standard",
    speed: "standard",
  };
  const line: Record<string, unknown> = {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/Users/tester/secret-project",
    sessionId: options.sessionId ?? "sess-test",
    version: "2.1.0",
    gitBranch: "secret-branch",
    message: {
      id: options.messageId,
      type: "message",
      role: "assistant",
      model: options.model ?? "claude-opus-5",
      content: [{ type: "text", text: "secret conversation text" }],
      usage,
    },
    type: "assistant",
    uuid: `${options.messageId}-${options.timestamp}`,
    timestamp: options.timestamp,
    ...options.extra,
  };
  if (options.requestId !== null) {
    line.requestId = options.requestId ?? `req_${options.messageId}`;
  }
  return JSON.stringify(line);
}

export const FIXTURE_ACCOUNT_UUID = "aaaaaaaa-1111-4111-8111-111111111111";
export const FIXTURE_ORG_UUID = "bbbbbbbb-2222-4222-8222-222222222222";
