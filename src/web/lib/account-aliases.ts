import type { LedgerView } from "../../shared/ledger-view";

/**
 * 用户别名只在页面展示时替换账户名称，账本、报表缓存和上游账户资料都保留原名。
 * 所有名称都从视图的 accounts 读取，因此在这里统一替换即可覆盖卡片、筛选和表格。
 */
export function withAccountAliases(
  view: LedgerView,
  aliases: Record<string, string> | undefined,
): LedgerView {
  if (!aliases || !view.accounts.some((account) => aliases[account.id]))
    return view;
  return {
    ...view,
    accounts: view.accounts.map((account) =>
      aliases[account.id]
        ? { ...account, name: aliases[account.id]! }
        : account,
    ),
  };
}
