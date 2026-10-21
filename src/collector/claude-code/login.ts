/** 会话里执行 /login 成功后，Claude Code 写入的本地命令输出。 */
const loginSuccess =
  "<local-command-stdout>Login successful</local-command-stdout>";

/**
 * 从会话记录行识别 /login 成功的时刻；不是该行时返回 null。只认整条消息正好是这段输出的
 * 用户行，工具输出或对话里引用到的同样文字不算。
 */
export function loginMoment(raw: string): string | null {
  if (!raw.includes(loginSuccess)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const line = parsed as Record<string, unknown>;
  const message = line.message as Record<string, unknown> | null | undefined;
  if (line.type !== "user" || message?.content !== loginSuccess) return null;
  if (typeof line.timestamp !== "string") return null;
  const at = Date.parse(line.timestamp);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
