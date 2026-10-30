/** 读取器上报条目的共同形状；sync 报告与 status 按来源列出这些计数。 */
export type SourceName = "codex" | "opencode";

export interface SourceReaderReport {
  source: SourceName;
  /** 本轮遇到的用量候选数，含被通道规则、起点或校验排除的记录。 */
  read: number;
  /** 通过通道路由并首次入账的用量条数。 */
  recorded: number;
  /** 按「来源加通道」跳过的用量：通道缺失时以 key 记为缺失。 */
  skipped: Record<string, number>;
  /** 无法解析的记录数；其余记录与进度照常处理。 */
  invalid: number;
}

export function emptySourceReport(source: SourceName): SourceReaderReport {
  return { source, read: 0, recorded: 0, skipped: {}, invalid: 0 };
}
