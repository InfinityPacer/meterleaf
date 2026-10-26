import type { LedgerAccount } from "../../shared/report";

export interface AccountFilterOption {
  value: string;
  label: string;
}

/**
 * 账户筛选只列使用中的账户，已归档和已删除的账户不再出现在下拉里；当前筛选的账户
 * 恰好是其中之一时补一项并注明状态，从账户卡片或归档列表钻取过来后仍能辨认。
 */
export function accountFilterOptions(
  visible: readonly LedgerAccount[],
  all: readonly LedgerAccount[],
  selected: string,
  state: { archived: ReadonlySet<string>; hidden: ReadonlySet<string> },
): AccountFilterOption[] {
  const options = visible.map((account) => ({
    value: account.id,
    label: account.name,
  }));
  if (selected === "all" || visible.some((account) => account.id === selected))
    return options;
  const name = all.find((account) => account.id === selected)?.name ?? selected;
  const suffix = state.archived.has(selected)
    ? "（已归档）"
    : state.hidden.has(selected)
      ? "（已删除）"
      : "";
  return [...options, { value: selected, label: `${name}${suffix}` }];
}
