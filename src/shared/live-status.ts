/** 轻量账本状态独立于上游拉取能力，不包含账户或请求明细。 */
export interface LedgerUpdateStatus {
  /** 已提交内容的版本，重复推送不改变版本。客户端仅判断是否相等。 */
  revision: number;
  /** 最近成功接收采集批次或完成上游同步的服务端时间；尚无记录时为 null。 */
  updatedAt: string | null;
}
