/** 已保存顺序按稳定账户 ID 恢复；新账户按来源顺序追加，失效 ID 不影响现存账户。 */
export function orderedAccounts<T extends { id: string }>(accounts: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...accounts].sort((a, b) =>
    (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
}

/** 在完整账户顺序中移动一个位置，越界操作保持原顺序。 */
export function moveAccount(order: string[], id: string, direction: -1 | 1): string[] {
  const index = order.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
