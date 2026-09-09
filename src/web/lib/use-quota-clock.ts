import { useEffect, useState } from "react";
import type { LedgerSnapshot } from "../../shared/report";
import { nextQuotaRefreshDelay } from "./quota-display";

/** 额度按真实时钟到期，不依赖报表重算；演示账本沿用固定时钟。 */
export function useQuotaClock(snapshot: LedgerSnapshot | undefined) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!snapshot || snapshot.mode === "demo") return;
    const delay = nextQuotaRefreshDelay(
      snapshot.accounts.flatMap((account) => [
        account.fiveHour,
        account.sevenDay,
      ]),
      clock,
      Date.now(),
    );
    const timer =
      delay === undefined
        ? undefined
        : setTimeout(() => setClock(Date.now()), delay);
    // 后台标签页可能被浏览器暂停，恢复可见时重新核对绝对到期时间。
    const onVisible = () => {
      if (document.visibilityState === "visible") setClock(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [snapshot, clock]);
  return snapshot?.mode === "demo"
    ? snapshot.asOf
    : new Date(Math.max(clock, Date.now())).toISOString();
}
