import { useSyncExternalStore } from "react";

const query = "(max-width: 900px)";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

/** 与手机布局断点一致，避免同时挂载两套可聚焦的弹层或筛选控件。 */
export function useMobileLayout() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
