/** 已保存顺序按稳定账户 ID 恢复；新账户按来源顺序追加，失效 ID 不影响现存账户。 */
export function orderedAccounts<T extends { id: string }>(
  accounts: T[],
  order: string[],
): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...accounts].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
}

/**
 * 在完整账户顺序中与相邻的可见账户交换位置；归档账户不在列表里，移动时跳过它们，
 * 它们在完整顺序中的位置保持不变。越界操作保持原顺序。
 */
export function moveAccount(
  order: string[],
  id: string,
  direction: -1 | 1,
  visible: (id: string) => boolean = () => true,
): string[] {
  const index = order.indexOf(id);
  if (index < 0) return order;
  let target = index + direction;
  while (target >= 0 && target < order.length && !visible(order[target]!))
    target += direction;
  if (target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/**
 * 类型未知、没有任何额度窗口且累计请求确认为 0 的账户在总览中没有可展示的内容，
 * 例如采集器短暂建立后又全部重新归属的「未归属」账户。累计缺失表示来源尚未汇总，仍然显示。
 */
export function isEmptyAccount(account: {
  kind: string;
  fiveHour: unknown;
  sevenDay: unknown;
  sevenDayFable?: unknown;
  lifetime?: { count: number };
}): boolean {
  return (
    account.kind === "unknown" &&
    !account.fiveHour &&
    !account.sevenDay &&
    !account.sevenDayFable &&
    account.lifetime?.count === 0
  );
}
