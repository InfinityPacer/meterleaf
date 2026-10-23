/** 两个派生索引各自已提交的变更序号，以及它们当前是否可用于判断清理水位。 */
export interface ChangeLogCursors {
  /** 报表索引已提交的序号；索引尚未建立或不使用变更日志时为 null。 */
  reportSequence: number | null;
  /** 累计索引已提交的序号；索引尚未建立或不使用变更日志时为 null。 */
  lifetimeSequence: number | null;
  /** 派生索引状态；后台重建期间沿用旧索引，不能代表账本已被完整消费。 */
  indexState: "current" | "transitional" | "building";
}

/**
 * 两个索引都已消费到的变更序号，也就是可以安全清理的水位。
 *
 * 清理按“严格小于水位”删除，所以两个索引都能从各自游标继续增量追赶。任一索引
 * 尚未建立，或正处在重建期间，都不给出水位：此时另一个索引的游标不能代表全部派生
 * 数据已经跟上账本。
 */
export function prunableChangeLogThrough(
  input: ChangeLogCursors,
): number | null {
  if (input.indexState !== "current") return null;
  if (input.reportSequence === null || input.lifetimeSequence === null)
    return null;
  const through = Math.min(input.reportSequence, input.lifetimeSequence);
  return through > 0 ? through : null;
}
