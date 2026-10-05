import { lazy, Suspense } from "react";
import type { AccountTrendProps } from "./AccountTrend";
import "./account-trend.css";

// 微图不应把图表引擎带入启动依赖，尤其移动首页并不显示这些桌面微图。
const AccountTrend = lazy(() =>
  import("./AccountTrend").then((module) => ({ default: module.AccountTrend })),
);

export function LazyAccountTrend(props: AccountTrendProps) {
  return (
    <Suspense
      fallback={
        <div
          className={`mini-trend${props.hideCaption ? " is-caption-hidden" : ""}`}
        >
          {!props.hideCaption && (
            <span className="mini-trend-caption">近 7 天</span>
          )}
          <div className="mini-trend-state" role="status">
            读取中…
          </div>
        </div>
      }
    >
      <AccountTrend {...props} />
    </Suspense>
  );
}
