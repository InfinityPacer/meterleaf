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
 * 在可见账户中将 activeId 移到 overId 的位置；归档账户不在可见列表里，
 * 它们在完整顺序中的位置保持不变。未知、不可见或原地放置保持原顺序。
 */
export function reorderAccount(
  order: string[],
  activeId: string,
  overId: string,
  visible: (id: string) => boolean = () => true,
): string[] {
  if (activeId === overId) return order;
  const visibleIndices: number[] = [];
  const visibleIds: string[] = [];
  for (let index = 0; index < order.length; index++) {
    const id = order[index]!;
    if (visible(id)) {
      visibleIndices.push(index);
      visibleIds.push(id);
    }
  }
  const from = visibleIds.indexOf(activeId);
  const to = visibleIds.indexOf(overId);
  if (from < 0 || to < 0) return order;
  const [moved] = visibleIds.splice(from, 1);
  visibleIds.splice(to, 0, moved!);
  const next = [...order];
  for (let index = 0; index < visibleIndices.length; index++) {
    next[visibleIndices[index]!] = visibleIds[index]!;
  }
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
  fiveHourThirdParty?: unknown;
  sevenDayThirdParty?: unknown;
  monthly?: unknown;
  lifetime?: { count: number };
}): boolean {
  return (
    account.kind === "unknown" &&
    !account.fiveHour &&
    !account.sevenDay &&
    !account.sevenDayFable &&
    !account.fiveHourThirdParty &&
    !account.sevenDayThirdParty &&
    !account.monthly &&
    account.lifetime?.count === 0
  );
}
