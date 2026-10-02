import type { SourceAccount } from "./connector";

export function ref(sourceId: string, externalId: string) {
  return `${encodeURIComponent(sourceId)}:${encodeURIComponent(externalId)}`;
}

export type AccountResolver = (sourceId: string, externalId: string) => string;

/** 本地合并覆盖来源父账户关系；每一步重新读取来源，允许跨来源合并。 */
export function createAccountResolver(
  accounts: readonly SourceAccount[],
  merges: Readonly<Record<string, string>> = {},
): AccountResolver {
  const indexed = new Map(
    accounts.map((account) => [
      ref(account.sourceId, account.externalId),
      account,
    ]),
  );
  return (sourceId, externalId) => {
    let key = ref(sourceId, externalId);
    const visited = new Set<string>();
    while (!visited.has(key)) {
      visited.add(key);
      const account = indexed.get(key);
      const parent = account?.parentExternalId
        ? ref(account.sourceId, account.parentExternalId)
        : null;
      const next = Object.hasOwn(merges, key) ? merges[key] : parent;
      if (!next || !indexed.has(next)) break;
      key = next;
    }
    return key;
  };
}

export interface AccountMergeState {
  writable: boolean;
  accounts: { id: string; name: string; sourceId: string }[];
  links: { id: string; targetId: string; rootId: string }[];
}
