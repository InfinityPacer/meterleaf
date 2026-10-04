/** 服务器观察到的套餐边界；首次观察不证明该套餐在此前已经生效。 */
export interface QuotaPlanObservation {
  plan: string | null;
  observedAt: string;
  /** 包括已知套餐与未知套餐之间的变化，旧账户的首次变化也属于边界。 */
  changed: boolean;
}

/** 来源和账户键允许包含分隔符，数组序列化保留完整身份。 */
export function quotaPlanHistoryKey(
  sourceId: string,
  accountExternalId: string,
) {
  return `quota:planHistory:${JSON.stringify([sourceId, accountExternalId])}`;
}
