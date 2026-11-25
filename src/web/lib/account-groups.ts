import { orderedAccounts, reorderAccount } from "./account-order";

export const OTHER_PLATFORM_KEY = "other";

/** 用 Map 查表，自定义平台名为 __proto__、constructor 等原型属性名时不会命中继承成员。 */
const KNOWN_PLATFORM_LABELS: ReadonlyMap<string, string> = new Map([
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["google", "Google"],
  ["opencode-go", "OpenCode Go"],
  ["commandcode", "Command Code"],
  [OTHER_PLATFORM_KEY, "其他"],
]);

/** 归一化平台标识；空值与 unknown 归入「其他」分组。 */
export function normalizePlatformKey(platform?: string | null): string {
  const trimmed = platform?.trim() ?? "";
  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return OTHER_PLATFORM_KEY;
  }
  return trimmed.toLowerCase();
}

/** 平台分组标题；已知平台映射固定厂商名，自定义平台保留自带大小写或按词首字母大写。 */
export function platformGroupLabel(
  key: string,
  rawPlatform?: string | null,
): string {
  const normalized = normalizePlatformKey(key);
  const known = KNOWN_PLATFORM_LABELS.get(normalized);
  if (known) return known;

  const raw = rawPlatform?.trim() || key.trim() || key;
  if (raw !== raw.toLowerCase()) return raw;

  const parts = raw.split(/[-_\s]+/).filter(Boolean);
  if (!parts.length) return raw;
  return parts
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export interface AccountGroup<T> {
  key: string;
  label: string;
  isOther: boolean;
  accounts: T[];
}

/**
 * 按账号平台分组，保持组内原序；非「其他」分组按组内首位账号出现顺序排列，
 * 「其他」组固定在末尾。同一自定义平台优先保留首次出现的含大写原始写法。
 */
export function groupAccountsByPlatform<
  T extends { id: string; platform?: string },
>(accounts: readonly T[]): AccountGroup<T>[] {
  const entries = new Map<
    string,
    { raw: string | null; hasUpper: boolean; accounts: T[] }
  >();
  for (const account of accounts) {
    const key = normalizePlatformKey(account.platform);
    const trimmed = account.platform?.trim() || null;
    const hasUpper = Boolean(trimmed && trimmed !== trimmed.toLowerCase());
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, {
        raw: trimmed,
        hasUpper,
        accounts: [account],
      });
    } else {
      existing.accounts.push(account);
      if (!existing.hasUpper && hasUpper && trimmed) {
        existing.raw = trimmed;
        existing.hasUpper = true;
      }
    }
  }

  const regular: AccountGroup<T>[] = [];
  let otherGroup: AccountGroup<T> | null = null;
  for (const [key, entry] of entries) {
    const isOther = key === OTHER_PLATFORM_KEY;
    const group: AccountGroup<T> = {
      key,
      label: platformGroupLabel(key, entry.raw),
      isOther,
      accounts: entry.accounts,
    };
    if (isOther) {
      otherGroup = group;
    } else {
      regular.push(group);
    }
  }
  return otherGroup ? [...regular, otherGroup] : regular;
}

/**
 * 在可移动的非「其他」分组间上移或下移指定分组，并将新顺序回填到这些可见账户
 * 在完整顺序中的原槽位；已归档账户及其他不在本批可见集合中的 ID 位置不变。
 */
export function moveAccountGroup(
  order: string[],
  groups: ReadonlyArray<{
    key: string;
    isOther: boolean;
    accounts: readonly { id: string }[];
  }>,
  groupKey: string,
  direction: "up" | "down",
  visible: (id: string) => boolean = () => true,
): string[] {
  const movable = groups.filter((group) => !group.isOther);
  const from = movable.findIndex((group) => group.key === groupKey);
  if (from < 0) return order;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= movable.length) return order;

  const nextMovable = [...movable];
  [nextMovable[from], nextMovable[to]] = [nextMovable[to]!, nextMovable[from]!];
  const otherGroups = groups.filter((group) => group.isOther);
  const nextGroups = [...nextMovable, ...otherGroups];

  const orderSet = new Set(order);
  const seen = new Set<string>();
  const flattened: string[] = [];
  for (const group of nextGroups) {
    for (const account of group.accounts) {
      if (
        visible(account.id) &&
        orderSet.has(account.id) &&
        !seen.has(account.id)
      ) {
        seen.add(account.id);
        flattened.push(account.id);
      }
    }
  }
  if (!flattened.length) return order;

  const slotIndices: number[] = [];
  const claimed = new Set<string>();
  for (let index = 0; index < order.length; index++) {
    const id = order[index]!;
    if (seen.has(id) && !claimed.has(id)) {
      claimed.add(id);
      slotIndices.push(index);
    }
  }
  const next = [...order];
  for (let index = 0; index < slotIndices.length; index++) {
    next[slotIndices[index]!] = flattened[index]!;
  }
  return next;
}

/** 分组展示时只有存在可移动的多个普通分组或任一组内有多个账户才允许排序。 */
export function canSortGroupedAccounts(
  groups: ReadonlyArray<{ isOther: boolean; accounts: readonly unknown[] }>,
): boolean {
  const movableCount = groups.filter((group) => !group.isOther).length;
  return movableCount > 1 || groups.some((group) => group.accounts.length > 1);
}

export interface AccountListState<T> {
  /** 全部账户（含隐藏与空账户）按已保存顺序排列的完整 ID 序列，排序写回以它为基准。 */
  orderIds: string[];
  /** 未隐藏、非空的活跃账户。 */
  active: T[];
  /** 未隐藏、非空的已归档账户。 */
  archived: T[];
}

/**
 * 由快照账户与已保存顺序构建账户区列表；隐藏与空账户不展示，但保留在完整顺序里，
 * 这样排序写回后它们的槽位不变，恢复可见时仍在原位。
 */
export function buildAccountListState<T extends { id: string }>(
  accounts: readonly T[],
  order: string[],
  options: {
    hidden: ReadonlySet<string>;
    archived: ReadonlySet<string>;
    isEmpty: (account: T) => boolean;
  },
): AccountListState<T> {
  const all = orderedAccounts([...accounts], order);
  const shown = all.filter(
    (account) => !options.hidden.has(account.id) && !options.isEmpty(account),
  );
  return {
    orderIds: all.map((account) => account.id),
    active: shown.filter((account) => !options.archived.has(account.id)),
    archived: shown.filter((account) => options.archived.has(account.id)),
  };
}

/**
 * 只在活跃账户（分组内拖拽时再限定为本组账户）的槽位间移动 activeId 到 overId，
 * 已归档、隐藏与空账户在完整顺序中的位置不变。
 */
export function reorderActiveAccount(
  orderIds: string[],
  activeIds: ReadonlySet<string>,
  activeId: string,
  overId: string,
  groupAccountIds?: ReadonlySet<string>,
): string[] {
  return reorderAccount(
    orderIds,
    activeId,
    overId,
    (id) => activeIds.has(id) && (!groupAccountIds || groupAccountIds.has(id)),
  );
}

/** 在活跃账户的槽位间整体上移或下移一个平台分组，其余账户槽位不变。 */
export function moveActiveGroup(
  orderIds: string[],
  activeIds: ReadonlySet<string>,
  groups: Parameters<typeof moveAccountGroup>[1],
  groupKey: string,
  direction: "up" | "down",
): string[] {
  return moveAccountGroup(orderIds, groups, groupKey, direction, (id) =>
    activeIds.has(id),
  );
}
