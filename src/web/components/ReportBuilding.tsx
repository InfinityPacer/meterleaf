import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";

function elapsedText(since: string, now: number) {
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.round((now - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 报表在后台首次计算、或账本被替换后重建时，暂时没有可展示的结果。
 * 页面不等待也不报错，说明原因并由查询轮询在完成后自动换成结果。
 */
export function ReportBuildingPanel({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = elapsedText(since, now);
  return (
    <div className="report-building" role="status">
      <LoaderCircle className="report-building-icon" aria-hidden="true" />
      <h2>报表正在后台计算</h2>
      <p>
        首次打开或更换账本后，需要把全部用量整理成报表。数据较多时要几分钟，完成后页面会自动显示，不用刷新。
      </p>
      {elapsed && <p className="report-building-elapsed">已进行 {elapsed}</p>}
    </div>
  );
}

/** 结果来自重建前的索引时的提示，例如价格表更新后按新价格重算期间。 */
export function ReportRebuildingNotice() {
  return (
    <p className="report-rebuilding" role="status">
      <LoaderCircle className="report-building-icon" aria-hidden="true" />
      报表正在后台重新计算，暂时显示之前的结果，完成后自动更新。
    </p>
  );
}
