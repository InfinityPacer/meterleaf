import { expect, test } from "bun:test";
import {
  OTHER_PLATFORM_KEY,
  buildAccountListState,
  canSortGroupedAccounts,
  groupAccountsByPlatform,
  moveAccountGroup,
  moveActiveGroup,
  normalizePlatformKey,
  platformGroupLabel,
  reorderActiveAccount,
} from "../src/web/lib/account-groups";
import { orderedAccounts, reorderAccount } from "../src/web/lib/account-order";
import {
  preferenceSchemas,
  readStoredPreference,
  writeStoredPreference,
} from "../src/web/lib/preferences";
import { ref } from "../src/domain/account-merge";

test("normalizePlatformKey normalizes casing, whitespace, empty and unknown values", () => {
  expect(normalizePlatformKey("Anthropic")).toBe("anthropic");
  expect(normalizePlatformKey("  OpenAI  ")).toBe("openai");
  expect(normalizePlatformKey("OpenCode-Go")).toBe("opencode-go");
  expect(normalizePlatformKey("CommandCode")).toBe("commandcode");
  expect(normalizePlatformKey("  Sub2API ")).toBe("sub2api");
  expect(normalizePlatformKey("")).toBe(OTHER_PLATFORM_KEY);
  expect(normalizePlatformKey("   ")).toBe(OTHER_PLATFORM_KEY);
  expect(normalizePlatformKey(null)).toBe(OTHER_PLATFORM_KEY);
  expect(normalizePlatformKey(undefined)).toBe(OTHER_PLATFORM_KEY);
  expect(normalizePlatformKey("unknown")).toBe(OTHER_PLATFORM_KEY);
  expect(normalizePlatformKey("  UNKNOWN  ")).toBe(OTHER_PLATFORM_KEY);
});

test("platformGroupLabel maps known vendors and formats custom platforms", () => {
  expect(platformGroupLabel("anthropic")).toBe("Anthropic");
  expect(platformGroupLabel("openai")).toBe("OpenAI");
  expect(platformGroupLabel("google")).toBe("Google");
  expect(platformGroupLabel("opencode-go")).toBe("OpenCode Go");
  expect(platformGroupLabel("commandcode")).toBe("Command Code");
  expect(platformGroupLabel(OTHER_PLATFORM_KEY)).toBe("其他");
  expect(platformGroupLabel("deepseek-api")).toBe("Deepseek Api");
  expect(platformGroupLabel("custom_vendor")).toBe("Custom Vendor");
  expect(platformGroupLabel("my  custom-vendor_hub")).toBe(
    "My Custom Vendor Hub",
  );
  expect(platformGroupLabel("openrouter", "OpenRouter")).toBe("OpenRouter");
  expect(platformGroupLabel("sub2api", "Sub2API")).toBe("Sub2API");
});

test("groupAccountsByPlatform keeps first-appearance group order, intra-group order, trailing other and stable custom labels", () => {
  const accounts = [
    { id: "o1", platform: undefined },
    { id: "a1", platform: "openai" },
    { id: "c1", platform: "openrouter" },
    { id: "b1", platform: "Anthropic" },
    { id: "a2", platform: "OpenAI" },
    { id: "o2", platform: "unknown" },
    { id: "c2", platform: "OpenRouter" },
    { id: "c3", platform: "OPENROUTER" },
    { id: "d1", platform: "custom_vendor" },
    { id: "d2", platform: "custom_vendor" },
    { id: "o3", platform: "   " },
  ];

  const groups = groupAccountsByPlatform(accounts);
  expect(
    groups.map((group) => ({
      key: group.key,
      label: group.label,
      isOther: group.isOther,
      ids: group.accounts.map((account) => account.id),
    })),
  ).toEqual([
    { key: "openai", label: "OpenAI", isOther: false, ids: ["a1", "a2"] },
    {
      key: "openrouter",
      label: "OpenRouter",
      isOther: false,
      ids: ["c1", "c2", "c3"],
    },
    { key: "anthropic", label: "Anthropic", isOther: false, ids: ["b1"] },
    {
      key: "custom_vendor",
      label: "Custom Vendor",
      isOther: false,
      ids: ["d1", "d2"],
    },
    {
      key: OTHER_PLATFORM_KEY,
      label: "其他",
      isOther: true,
      ids: ["o1", "o2", "o3"],
    },
  ]);
});

test("moveAccountGroup moves adjacent groups, respects boundaries and other group, and leaves archived or empty slots untouched", () => {
  const accounts = [
    { id: "arch1", platform: "anthropic" },
    { id: "a1", platform: "anthropic" },
    { id: "arch2", platform: "openai" },
    { id: "o1", platform: "openai" },
    { id: "a2", platform: "anthropic" },
    { id: "empty1", platform: "unknown" },
    { id: "g1", platform: "google" },
    { id: "u1", platform: undefined },
  ];
  const hiddenSlots = new Set(["arch1", "arch2", "empty1"]);
  const visible = (id: string) => !hiddenSlots.has(id);
  const initialOrder = accounts.map((account) => account.id);
  const visibleAccounts = accounts.filter((account) => visible(account.id));
  const groups = groupAccountsByPlatform(visibleAccounts);

  // 边界与「其他」组保持原引用不变。
  expect(
    moveAccountGroup(initialOrder, groups, "anthropic", "up", visible),
  ).toBe(initialOrder);
  expect(
    moveAccountGroup(initialOrder, groups, "google", "down", visible),
  ).toBe(initialOrder);
  expect(
    moveAccountGroup(initialOrder, groups, OTHER_PLATFORM_KEY, "up", visible),
  ).toBe(initialOrder);
  expect(
    moveAccountGroup(initialOrder, groups, "missing", "down", visible),
  ).toBe(initialOrder);

  // 将 openai 上移到 anthropic 前，已归档和空账户槽位完全不变。
  const movedUp = moveAccountGroup(
    initialOrder,
    groups,
    "openai",
    "up",
    visible,
  );
  expect(movedUp).toEqual([
    "arch1",
    "o1",
    "arch2",
    "a1",
    "a2",
    "empty1",
    "g1",
    "u1",
  ]);
  expect(movedUp[0]).toBe("arch1");
  expect(movedUp[2]).toBe("arch2");
  expect(movedUp[5]).toBe("empty1");

  // 多次组间移动 + 组内拖拽排序后，重新分组仍保持连贯顺序。
  const groupsAfterFirstMove = groupAccountsByPlatform(
    orderedAccounts(visibleAccounts, movedUp),
  );
  expect(groupsAfterFirstMove.map((group) => group.key)).toEqual([
    "openai",
    "anthropic",
    "google",
    OTHER_PLATFORM_KEY,
  ]);

  const movedDown = moveAccountGroup(
    movedUp,
    groupsAfterFirstMove,
    "anthropic",
    "down",
    visible,
  );
  expect(movedDown).toEqual([
    "arch1",
    "o1",
    "arch2",
    "g1",
    "a1",
    "empty1",
    "a2",
    "u1",
  ]);

  const anthropicIds = new Set(["a1", "a2"]);
  const afterIntraGroupReorder = reorderAccount(movedDown, "a2", "a1", (id) =>
    anthropicIds.has(id),
  );
  expect(afterIntraGroupReorder).toEqual([
    "arch1",
    "o1",
    "arch2",
    "g1",
    "a2",
    "empty1",
    "a1",
    "u1",
  ]);

  const finalGroups = groupAccountsByPlatform(
    orderedAccounts(visibleAccounts, afterIntraGroupReorder),
  );
  expect(
    finalGroups.map((group) => ({
      key: group.key,
      ids: group.accounts.map((account) => account.id),
    })),
  ).toEqual([
    { key: "openai", ids: ["o1"] },
    { key: "google", ids: ["g1"] },
    { key: "anthropic", ids: ["a2", "a1"] },
    { key: OTHER_PLATFORM_KEY, ids: ["u1"] },
  ]);
});

test("canSortGroupedAccounts requires either multiple movable groups or a multi-account group", () => {
  expect(canSortGroupedAccounts([])).toBe(false);
  expect(
    canSortGroupedAccounts([{ isOther: false, accounts: [{ id: "a1" }] }]),
  ).toBe(false);
  expect(
    canSortGroupedAccounts([
      { isOther: false, accounts: [{ id: "a1" }] },
      { isOther: true, accounts: [{ id: "u1" }] },
    ]),
  ).toBe(false);
  expect(
    canSortGroupedAccounts([
      { isOther: false, accounts: [{ id: "a1" }] },
      { isOther: false, accounts: [{ id: "o1" }] },
    ]),
  ).toBe(true);
  expect(
    canSortGroupedAccounts([
      { isOther: false, accounts: [{ id: "a1" }, { id: "a2" }] },
      { isOther: true, accounts: [{ id: "u1" }] },
    ]),
  ).toBe(true);
  expect(
    canSortGroupedAccounts([
      { isOther: true, accounts: [{ id: "u1" }, { id: "u2" }] },
    ]),
  ).toBe(true);
});

const prototypePlatformNames = [
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
];

test("prototype property names as custom platforms yield plain string keys and labels", () => {
  for (const name of prototypePlatformNames) {
    const key = normalizePlatformKey(name);
    expect(typeof key).toBe("string");
    expect(key).toBe(name.toLowerCase());
    const label = platformGroupLabel(key, name);
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
    expect(label).toBe(name === name.toLowerCase() ? label : name);
    const lowerLabel = platformGroupLabel(key);
    expect(typeof lowerLabel).toBe("string");
    expect(lowerLabel.length).toBeGreaterThan(0);
  }
  expect(platformGroupLabel("__proto__")).toBe("Proto");
  expect(platformGroupLabel("constructor")).toBe("Constructor");
  expect(platformGroupLabel("tostring", "toString")).toBe("toString");
  expect(platformGroupLabel("hasownproperty", "hasOwnProperty")).toBe(
    "hasOwnProperty",
  );
});

test("groupAccountsByPlatform groups prototype-named platforms like any custom platform", () => {
  const accounts = [
    { id: "a1", platform: "anthropic" },
    ...prototypePlatformNames.flatMap((name, index) => [
      { id: `p${index}-1`, platform: name },
      { id: `p${index}-2`, platform: ` ${name} ` },
    ]),
    { id: "u1", platform: undefined },
  ];
  const groups = groupAccountsByPlatform(accounts);
  expect(groups.map((group) => group.key)).toEqual([
    "anthropic",
    ...prototypePlatformNames.map((name) => name.toLowerCase()),
    OTHER_PLATFORM_KEY,
  ]);
  for (const group of groups) {
    expect(typeof group.label).toBe("string");
    expect(group.label.length).toBeGreaterThan(0);
  }
  prototypePlatformNames.forEach((_, index) => {
    expect(groups[index + 1]!.accounts.map((account) => account.id)).toEqual([
      `p${index}-1`,
      `p${index}-2`,
    ]);
  });
});

/**
 * 完整快照：活跃 a1/a2（anthropic）、o1/o2（openai）、u1（其他），归档 o3，
 * 空账户 e1，隐藏 h1，均穿插在已保存顺序中。
 */
function snapshotFixture() {
  const accounts = [
    { id: "a1", platform: "anthropic", empty: false },
    { id: "e1", platform: undefined, empty: true },
    { id: "o1", platform: "openai", empty: false },
    { id: "o3", platform: "openai", empty: false },
    { id: "h1", platform: "anthropic", empty: false },
    { id: "a2", platform: "anthropic", empty: false },
    { id: "u1", platform: undefined, empty: false },
    { id: "o2", platform: "openai", empty: false },
  ];
  const order = ["a1", "e1", "o1", "o3", "h1", "a2", "u1", "o2"];
  const options = {
    hidden: new Set(["h1"]),
    archived: new Set(["o3"]),
    isEmpty: (account: { empty: boolean }) => account.empty,
  };
  return { accounts, order, options };
}

test("buildAccountListState hides empty and hidden accounts but keeps every slot in the full order", () => {
  const { accounts, order, options } = snapshotFixture();
  const state = buildAccountListState(accounts, order, options);
  expect(state.orderIds).toEqual(order);
  expect(state.active.map((account) => account.id)).toEqual([
    "a1",
    "o1",
    "a2",
    "u1",
    "o2",
  ]);
  expect(state.archived.map((account) => account.id)).toEqual(["o3"]);
});

test("moving a group keeps empty, hidden and archived slots so they reappear in place", () => {
  const { accounts, order, options } = snapshotFixture();
  const state = buildAccountListState(accounts, order, options);
  const activeIds = new Set(state.active.map((account) => account.id));
  const groups = groupAccountsByPlatform(state.active);
  expect(groups.map((group) => group.key)).toEqual([
    "anthropic",
    "openai",
    OTHER_PLATFORM_KEY,
  ]);

  const next = moveActiveGroup(
    state.orderIds,
    activeIds,
    groups,
    "openai",
    "up",
  );
  expect(next).toEqual(["o1", "e1", "o2", "o3", "h1", "a1", "a2", "u1"]);
  expect(next.indexOf("e1")).toBe(order.indexOf("e1"));
  expect(next.indexOf("h1")).toBe(order.indexOf("h1"));
  expect(next.indexOf("o3")).toBe(order.indexOf("o3"));

  const after = buildAccountListState(accounts, next, options);
  expect(
    groupAccountsByPlatform(after.active).map((group) => group.key),
  ).toEqual(["openai", "anthropic", OTHER_PLATFORM_KEY]);

  const restored = buildAccountListState(accounts, next, {
    ...options,
    hidden: new Set<string>(),
    archived: new Set<string>(),
    isEmpty: () => false,
  });
  expect(restored.active.map((account) => account.id)).toEqual(next);
  expect(restored.active.map((account) => account.id)[1]).toBe("e1");
});

test("dragging within a group or the flat list keeps empty, hidden and archived slots", () => {
  const { accounts, order, options } = snapshotFixture();
  const state = buildAccountListState(accounts, order, options);
  const activeIds = new Set(state.active.map((account) => account.id));
  const groups = groupAccountsByPlatform(state.active);
  const anthropicIds = new Set(
    groups[0]!.accounts.map((account) => account.id),
  );

  const grouped = reorderActiveAccount(
    state.orderIds,
    activeIds,
    "a2",
    "a1",
    anthropicIds,
  );
  expect(grouped).toEqual(["a2", "e1", "o1", "o3", "h1", "a1", "u1", "o2"]);
  expect(
    reorderActiveAccount(state.orderIds, activeIds, "a2", "o1", anthropicIds),
  ).toEqual(order);

  const flat = reorderActiveAccount(state.orderIds, activeIds, "o2", "a1");
  expect(flat).toEqual(["o2", "e1", "a1", "o3", "h1", "o1", "a2", "u1"]);
  for (const next of [grouped, flat]) {
    expect(next.indexOf("e1")).toBe(order.indexOf("e1"));
    expect(next.indexOf("h1")).toBe(order.indexOf("h1"));
    expect(next.indexOf("o3")).toBe(order.indexOf("o3"));
    expect([...next].sort()).toEqual([...order].sort());
  }
  expect(reorderActiveAccount(state.orderIds, activeIds, "e1", "a1")).toEqual(
    order,
  );
});

test("long UTF-8 empty account ids survive move, drag, persistence and reload in their original slots", () => {
  const longEmpty = ref("collector", "汉".repeat(60));
  expect(longEmpty.length).toBeGreaterThan(512);
  const accounts = [
    { id: "a1", platform: "anthropic", empty: false },
    { id: longEmpty, platform: undefined, empty: true },
    { id: "o1", platform: "openai", empty: false },
    { id: "o3", platform: "openai", empty: false },
    { id: "a2", platform: "anthropic", empty: false },
    { id: "o2", platform: "openai", empty: false },
  ];
  const order = ["a1", longEmpty, "o1", "o3", "a2", "o2"];
  const options = {
    hidden: new Set<string>(),
    archived: new Set(["o3"]),
    isEmpty: (account: { empty: boolean }) => account.empty,
  };
  const key = "meterleaf-pref-account-order";
  const values = new Map<string, string>();
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
  };
  const persistAndReload = (next: string[]) => {
    values.clear();
    writeStoredPreference(key, preferenceSchemas.accountOrder, next, storage);
    return readStoredPreference(
      key,
      preferenceSchemas.accountOrder,
      [],
      storage,
    );
  };

  const state = buildAccountListState(accounts, order, options);
  const activeIds = new Set(state.active.map((account) => account.id));
  const groups = groupAccountsByPlatform(state.active);
  const anthropicIds = new Set(
    groups[0]!.accounts.map((account) => account.id),
  );
  const paths = {
    group: moveActiveGroup(state.orderIds, activeIds, groups, "openai", "up"),
    intraGroup: reorderActiveAccount(
      state.orderIds,
      activeIds,
      "a2",
      "a1",
      anthropicIds,
    ),
    flat: reorderActiveAccount(state.orderIds, activeIds, "o2", "a1"),
  };
  expect(paths.group).toEqual(["o1", longEmpty, "o2", "o3", "a1", "a2"]);
  expect(paths.intraGroup).toEqual(["a2", longEmpty, "o1", "o3", "a1", "o2"]);
  expect(paths.flat).toEqual(["o2", longEmpty, "a1", "o3", "o1", "a2"]);

  for (const next of Object.values(paths)) {
    const reloaded = persistAndReload(next);
    expect(reloaded).toEqual(next);
    expect(reloaded.indexOf(longEmpty)).toBe(order.indexOf(longEmpty));
    expect(reloaded.indexOf("o3")).toBe(order.indexOf("o3"));

    const after = buildAccountListState(accounts, reloaded, options);
    expect(after.orderIds).toEqual(next);
    const restored = buildAccountListState(accounts, reloaded, {
      ...options,
      isEmpty: () => false,
    });
    expect(restored.orderIds.indexOf(longEmpty)).toBe(order.indexOf(longEmpty));
    expect(restored.active.map((account) => account.id)).toEqual(
      next.filter((id) => id !== "o3"),
    );
    expect(restored.archived.map((account) => account.id)).toEqual(["o3"]);
  }
});

/**
 * 大规模快照：emptyCount 个未知平台空账户，两个活跃账户分别插在 1/3 与 2/3 槽位，
 * 用于验证完整顺序在 10,000 项上下都能持久化并按原槽位恢复。
 */
function largeSnapshot(
  emptyCount: number,
  first: { id: string; platform: string },
  second: { id: string; platform: string },
) {
  const empties = Array.from({ length: emptyCount }, (_, index) => ({
    id: `e${index}`,
    platform: undefined as string | undefined,
    empty: true,
  }));
  const firstSlot = Math.floor(emptyCount / 3);
  const secondSlot = Math.floor((emptyCount * 2) / 3) + 1;
  const accounts: {
    id: string;
    platform: string | undefined;
    empty: boolean;
  }[] = [...empties];
  accounts.splice(firstSlot, 0, { ...first, empty: false });
  accounts.splice(secondSlot, 0, { ...second, empty: false });
  const order = accounts.map((account) => account.id);
  const options = {
    hidden: new Set<string>(),
    archived: new Set<string>(),
    isEmpty: (account: { empty: boolean }) => account.empty,
  };
  const values = new Map<string, string>();
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
  };
  const key = "meterleaf-pref-account-order";
  const persistAndReload = (next: string[]) => {
    values.clear();
    writeStoredPreference(key, preferenceSchemas.accountOrder, next, storage);
    expect(values.has(key)).toBe(true);
    return readStoredPreference(
      key,
      preferenceSchemas.accountOrder,
      [],
      storage,
    );
  };
  return { accounts, order, options, firstSlot, secondSlot, persistAndReload };
}

function expectEmptySlotsKept(order: string[], next: string[]) {
  expect(next).toHaveLength(order.length);
  order.forEach((id, index) => {
    if (id.startsWith("e")) expect(next[index]).toBe(id);
  });
}

for (const emptyCount of [9_998, 9_999]) {
  const total = emptyCount + 2;
  test(`group move and flat drag across ${total} accounts persist and restore every empty slot`, () => {
    const {
      accounts,
      order,
      options,
      firstSlot,
      secondSlot,
      persistAndReload,
    } = largeSnapshot(
      emptyCount,
      { id: "a1", platform: "anthropic" },
      { id: "o1", platform: "openai" },
    );
    expect(order).toHaveLength(total);
    const state = buildAccountListState(accounts, order, options);
    expect(state.orderIds).toEqual(order);
    expect(state.active.map((account) => account.id)).toEqual(["a1", "o1"]);
    const activeIds = new Set(state.active.map((account) => account.id));
    const groups = groupAccountsByPlatform(state.active);
    expect(groups.map((group) => group.key)).toEqual(["anthropic", "openai"]);

    const paths = {
      group: moveActiveGroup(state.orderIds, activeIds, groups, "openai", "up"),
      flat: reorderActiveAccount(state.orderIds, activeIds, "o1", "a1"),
    };
    for (const next of Object.values(paths)) {
      expect(next[firstSlot]).toBe("o1");
      expect(next[secondSlot]).toBe("a1");
      expectEmptySlotsKept(order, next);

      const reloaded = persistAndReload(next);
      expect(reloaded).toEqual(next);
      const after = buildAccountListState(accounts, reloaded, options);
      expect(after.orderIds).toEqual(next);
      expect(after.active.map((account) => account.id)).toEqual(["o1", "a1"]);
      expect(
        groupAccountsByPlatform(after.active).map((group) => group.key),
      ).toEqual(["openai", "anthropic"]);
      const restored = buildAccountListState(accounts, reloaded, {
        ...options,
        isEmpty: () => false,
      });
      expect(restored.active.map((account) => account.id)).toEqual(next);
    }
  });

  test(`intra-group drag across ${total} accounts persists and restores every empty slot`, () => {
    const {
      accounts,
      order,
      options,
      firstSlot,
      secondSlot,
      persistAndReload,
    } = largeSnapshot(
      emptyCount,
      { id: "a1", platform: "anthropic" },
      { id: "a2", platform: "Anthropic" },
    );
    expect(order).toHaveLength(total);
    const state = buildAccountListState(accounts, order, options);
    const activeIds = new Set(state.active.map((account) => account.id));
    const groups = groupAccountsByPlatform(state.active);
    expect(groups).toHaveLength(1);
    const anthropicIds = new Set(
      groups[0]!.accounts.map((account) => account.id),
    );

    const next = reorderActiveAccount(
      state.orderIds,
      activeIds,
      "a2",
      "a1",
      anthropicIds,
    );
    expect(next[firstSlot]).toBe("a2");
    expect(next[secondSlot]).toBe("a1");
    expectEmptySlotsKept(order, next);

    const reloaded = persistAndReload(next);
    expect(reloaded).toEqual(next);
    const after = buildAccountListState(accounts, reloaded, options);
    expect(after.orderIds).toEqual(next);
    expect(after.active.map((account) => account.id)).toEqual(["a2", "a1"]);
    const restored = buildAccountListState(accounts, reloaded, {
      ...options,
      isEmpty: () => false,
    });
    expect(restored.active.map((account) => account.id)).toEqual(next);
  });
}
