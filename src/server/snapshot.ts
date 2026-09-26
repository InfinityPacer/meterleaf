import type { SourceAccount, UsageFact } from "../domain/connector";
import { quotaView, type QuotaChargeReader } from "../domain/quota";
import { priceBookKey } from "../domain/pricing";
import { reportBounds, type DateRange } from "../shared/date-range";
import type {
  LedgerRecord,
  LedgerRecordDetails,
  LedgerSnapshot,
  UsdBasis,
} from "../shared/report";
import type { LedgerStore, StoredUsage } from "../storage/ledger";
import type { SyncRunner } from "./sync";

const DAY_MS = 86_400_000;

/** URI 分量避免来源与外部 ID 分隔符冲突，身份规则由适配器提供。 */
export function ref(sourceId: string, externalId: string) {
  return `${encodeURIComponent(sourceId)}:${encodeURIComponent(externalId)}`;
}

export type AccountResolver = (sourceId: string, externalId: string) => string;

/** 按来源快照解析父账号；缺失父项停止，循环在再次访问节点前停止。 */
export function createAccountResolver(
  sourceAccounts: readonly SourceAccount[],
): AccountResolver {
  const indexed = new Map(
    sourceAccounts.map((account) => [
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
      if (!account?.parentExternalId) break;
      const parent = ref(sourceId, account.parentExternalId);
      if (!indexed.has(parent)) break;
      key = parent;
    }
    return key;
  };
}

function metadataText(
  metadata: UsageFact["metadata"],
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function metadataNumber(
  metadata: UsageFact["metadata"],
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function metadataBoolean(
  metadata: UsageFact["metadata"],
  key: string,
): boolean | null {
  const value = metadata[key];
  return typeof value === "boolean" ? value : null;
}

function requestDetails(fact: UsageFact): LedgerRecordDetails {
  const requestedModel = metadataText(fact.metadata, "requested_model");
  const storedModel = metadataText(fact.metadata, "stored_model");
  // requested/stored 是旧事实里可识别的请求证据；fact.model 只作兼容回退，不能证明原始请求值。
  return {
    requestedModel: requestedModel ?? storedModel ?? fact.model,
    sentModel: fact.upstreamModel ?? fact.model,
    responseModel: metadataText(fact.metadata, "upstream_response_model"),
    responseModelMismatch: metadataBoolean(
      fact.metadata,
      "upstream_model_mismatch",
    ),
    requestedReasoningEffort: metadataText(
      fact.metadata,
      "requested_reasoning_effort",
    ),
    reasoningEffort: metadataText(fact.metadata, "reasoning_effort"),
    durationMs: metadataNumber(fact.metadata, "duration_ms"),
    firstTokenMs: metadataNumber(fact.metadata, "first_token_ms"),
  };
}

/** 将已保存事实转换为报表记录，确保所有 USD 口径共享同一详情映射。 */
export function toLedgerRecord(
  row: StoredUsage,
  root: AccountResolver,
  usdBasis: UsdBasis = "subscription",
): LedgerRecord {
  const { fact } = row;
  const valuation = {
    ...row.valuation,
    usdBasis,
    usd:
      usdBasis === "api" ? row.valuation.apiUsd : row.valuation.subscriptionUsd,
  };
  return {
    id: ref(fact.sourceId, fact.externalId),
    sourceId: fact.sourceId,
    sourceRecordId: fact.externalId,
    occurredAt: fact.occurredAt,
    accountId: root(fact.sourceId, fact.accountExternalId),
    model: fact.model,
    input: fact.tokens.input,
    output: fact.tokens.output,
    cacheRead: fact.tokens.cacheRead,
    cacheWrite: fact.tokens.cacheWrite,
    usd: valuation.usd.amount,
    credits: valuation.credits.amount,
    tier:
      fact.tier === "priority" || fact.tier === "fast"
        ? "priority"
        : fact.tier === "flex"
          ? "flex"
          : fact.tier === "default" ||
              fact.tier === "standard" ||
              fact.tier === "auto"
            ? "standard"
            : "unknown",
    quality:
      valuation.usd.amount === null || valuation.credits.amount === null
        ? "unpriced"
        : "estimated",
    priceVersion: valuation.version,
    valuation,
    gatewayCost: fact.gatewayCost,
    gatewayBilled: fact.gatewayBilled,
    details: requestDetails(fact),
  };
}

function selectedUsage(row: StoredUsage, usdBasis: UsdBasis): StoredUsage {
  return {
    ...row,
    valuation: {
      ...row.valuation,
      usdBasis,
      usd:
        usdBasis === "api"
          ? row.valuation.apiUsd
          : row.valuation.subscriptionUsd,
    },
  };
}

export function liveSnapshot(
  store: LedgerStore,
  sync: Pick<SyncRunner, "status"> | null,
  days: number,
  now: string,
  usdBasis: UsdBasis = "subscription",
  dateRange?: DateRange,
): LedgerSnapshot {
  const sourceAccounts = store.accounts();
  const root = createAccountResolver(sourceAccounts);
  const indexed = new Map(
    sourceAccounts.map((account) => [
      ref(account.sourceId, account.externalId),
      account,
    ]),
  );
  const history = store.quotas();
  const nowTime = Date.parse(now);
  // 账户周期统计不能被报表筛选日期截断。查询范围至少覆盖源快照给定的完整窗口。
  const accountStart = history.reduce(
    (earliest, { fact }) =>
      fact.resetsAt && fact.windowMinutes && Date.parse(fact.resetsAt) > nowTime
        ? Math.min(
            earliest,
            Date.parse(fact.resetsAt) - fact.windowMinutes * 60_000,
          )
        : earliest,
    nowTime - days * 2 * DAY_MS,
  );

  const currentBounds = reportBounds({ days, dateRange }, now);
  const previousBounds = reportBounds({ days, dateRange }, now, true);
  const reportStart = Math.min(currentBounds.start, previousBounds.start);
  const reportEnd = Math.max(currentBounds.end, previousBounds.end);
  const loadedStart = Math.min(accountStart, reportStart);
  const loadedEnd = Math.max(nowTime, reportEnd);
  const usage = store.usage(
    new Date(loadedStart).toISOString(),
    new Date(loadedEnd).toISOString(),
  );
  const periodUsage = usage
    .map((row) => selectedUsage(row, usdBasis))
    .filter((row) => {
      const time = Date.parse(row.fact.occurredAt);
      return time >= accountStart && time <= nowTime;
    });
  const records: LedgerRecord[] = usage
    .filter((row) => {
      const time = Date.parse(row.fact.occurredAt);
      return currentBounds.endInclusive
        ? time > reportStart && time <= reportEnd
        : time >= reportStart && time < reportEnd;
    })
    .map((row) => toLedgerRecord(row, root, usdBasis));
  const canonical = new Map<string, SourceAccount>();
  for (const account of sourceAccounts) {
    const key = root(account.sourceId, account.externalId);
    canonical.set(key, indexed.get(key) ?? account);
  }
  // 已删除的源账号仍保留历史请求，但不臆造订阅能力或额度。
  for (const { fact } of usage) {
    const key = root(fact.sourceId, fact.accountExternalId);
    if (!canonical.has(key))
      canonical.set(key, {
        sourceId: fact.sourceId,
        externalId: fact.accountExternalId,
        name: `Account ${fact.accountExternalId}`,
        platform: "unknown",
        kind: "unknown",
        plan: null,
        parentExternalId: null,
        subjectKey: null,
      });
  }
  const accounts = [...canonical].map(([id, account]) => {
    const periodAccountUsage = periodUsage.filter(
      (row) => root(row.fact.sourceId, row.fact.accountExternalId) === id,
    );
    const quotaHistory = history.filter(
      (row) => root(row.fact.sourceId, row.fact.accountExternalId) === id,
    );
    const fiveHour = quotaView(
      quotaHistory.filter((row) => row.fact.window === "five-hour"),
      periodAccountUsage,
      now,
    );
    const sevenDay = quotaView(
      quotaHistory.filter((row) => row.fact.window === "seven-day"),
      periodAccountUsage,
      now,
    );
    const sevenDayFable = quotaView(
      quotaHistory.filter((row) => row.fact.window === "seven-day-fable"),
      periodAccountUsage,
      now,
    );
    return {
      id,
      name: account.name,
      plan: account.plan ?? "未提供",
      platform: account.platform,
      kind: account.kind,
      sampledAt: sevenDay?.sampledAt ?? fiveHour?.sampledAt ?? null,
      fiveHour,
      sevenDay,
      sevenDayFable,
    };
  });
  const resets = [
    ...new Map(
      history.flatMap(({ fact }) =>
        fact.resetsAt && Date.parse(fact.resetsAt) <= Date.parse(now)
          ? [
              [
                `${root(fact.sourceId, fact.accountExternalId)}:${fact.resetsAt}`,
                {
                  accountId: root(fact.sourceId, fact.accountExternalId),
                  at: fact.resetsAt,
                },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  return {
    mode: "live",
    usdBasis,
    asOf: now,
    accounts,
    records,
    resets,
    sync: sync?.status(),
    pricing: {
      version: priceBookKey(store.book),
      publishedAt: store.book.publishedAt,
      sources: store.book.sources,
    },
  };
}

interface ParsedRef {
  sourceId: string;
  externalId: string;
}

function parseRef(value: string): ParsedRef | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  try {
    return {
      sourceId: decodeURIComponent(value.slice(0, separator)),
      externalId: decodeURIComponent(value.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

function unknownAccount(sourceId: string, externalId: string): SourceAccount {
  return {
    sourceId,
    externalId,
    name: `Account ${externalId}`,
    platform: "unknown",
    kind: "unknown",
    plan: null,
    parentExternalId: null,
    subjectKey: null,
  };
}

/** 只读取账户和额度快照；请求金额由外部索引按窗口提供。 */
export function indexedSnapshot(
  store: Pick<LedgerStore, "book" | "accounts" | "quotas">,
  sync: Pick<SyncRunner, "status"> | null,
  now: string,
  usdBasis: UsdBasis,
  sumWindow: (
    accountId: string,
    startInclusive: string,
    endInclusive: string,
    basis: UsdBasis,
    modelScope: ((model: string) => boolean) | null,
  ) => { usd: string | null; credits: string | null; count?: number; tokens?: number | null },
  observedAccountIds: string[] = [],
): Omit<LedgerSnapshot, "records"> {
  const sourceAccounts = store.accounts();
  const root = createAccountResolver(sourceAccounts);
  const sourceAccountByRef = new Map(
    sourceAccounts.map((account) => [
      ref(account.sourceId, account.externalId),
      account,
    ]),
  );
  const history = store.quotas();
  const canonical = new Map<string, SourceAccount>();
  for (const account of sourceAccounts) {
    const id = root(account.sourceId, account.externalId);
    canonical.set(id, sourceAccountByRef.get(id) ?? account);
  }
  // 派生索引保留的账户身份可早于当前来源账户快照，不能因账户删除而丢失报表主体。
  for (const observedId of observedAccountIds) {
    const parsed = parseRef(observedId);
    const id = parsed ? root(parsed.sourceId, parsed.externalId) : observedId;
    if (canonical.has(id)) continue;
    const account = parsed
      ? sourceAccountByRef.get(ref(parsed.sourceId, parsed.externalId))
      : undefined;
    canonical.set(
      id,
      account ??
        unknownAccount(
          parsed?.sourceId ?? "unknown",
          parsed?.externalId ?? observedId,
        ),
    );
  }

  const quotaByAccount = new Map<string, typeof history>();
  for (const row of history) {
    const id = root(row.fact.sourceId, row.fact.accountExternalId);
    const rows = quotaByAccount.get(id);
    if (rows) rows.push(row);
    else quotaByAccount.set(id, [row]);
  }
  const accounts = [...canonical].map(([id, account]) => {
    const quotaHistory = quotaByAccount.get(id) ?? [];
    const reader: QuotaChargeReader = (startInclusive, endInclusive, scope) =>
      sumWindow(id, startInclusive, endInclusive, usdBasis, scope);
    const fiveHour = quotaView(
      quotaHistory.filter((row) => row.fact.window === "five-hour"),
      reader,
      now,
    );
    const sevenDay = quotaView(
      quotaHistory.filter((row) => row.fact.window === "seven-day"),
      reader,
      now,
    );
    const sevenDayFable = quotaView(
      quotaHistory.filter((row) => row.fact.window === "seven-day-fable"),
      reader,
      now,
    );
    return {
      id,
      name: account.name,
      plan: account.plan ?? "未提供",
      platform: account.platform,
      kind: account.kind,
      sampledAt: sevenDay?.sampledAt ?? fiveHour?.sampledAt ?? null,
      fiveHour,
      sevenDay,
      sevenDayFable,
    };
  });
  const nowTime = Date.parse(now);
  const resets = [
    ...new Map(
      history.flatMap(({ fact }) => {
        if (!fact.resetsAt || !(Date.parse(fact.resetsAt) <= nowTime))
          return [];
        const accountId = root(fact.sourceId, fact.accountExternalId);
        return [
          [
            `${accountId}:${fact.resetsAt}`,
            { accountId, at: fact.resetsAt },
          ] as const,
        ];
      }),
    ).values(),
  ];
  return {
    mode: "live",
    usdBasis,
    asOf: now,
    accounts,
    resets,
    sync: sync?.status(),
    pricing: {
      version: priceBookKey(store.book),
      publishedAt: store.book.publishedAt,
      sources: store.book.sources,
    },
  };
}
