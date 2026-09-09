import { useSyncExternalStore } from "react";

export interface LiveUpdatesState {
  readonly paused: boolean;
  readonly setPaused: (paused: boolean) => void;
}

type LiveUpdatesListener = () => void;

const listeners = new Set<LiveUpdatesListener>();

/** 跨组件共享会话态暂停开关；不写入存储，刷新页面后恢复自动更新。 */
export function setLiveUpdatesPaused(paused: boolean) {
  if (snapshot.paused === paused) return;
  snapshot = { paused, setPaused: setLiveUpdatesPaused };
  for (const listener of listeners) listener();
}

const serverSnapshot: LiveUpdatesState = {
  paused: false,
  setPaused: setLiveUpdatesPaused,
};
let snapshot: LiveUpdatesState = serverSnapshot;

export function subscribeLiveUpdates(listener: LiveUpdatesListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLiveUpdatesSnapshot() {
  return snapshot;
}

const getServerSnapshot = () => serverSnapshot;

/** 页面级自动更新由同一份会话状态驱动，避免各组件维护互相独立的暂停值。 */
export function useLiveUpdates(): LiveUpdatesState {
  return useSyncExternalStore(
    subscribeLiveUpdates,
    getLiveUpdatesSnapshot,
    getServerSnapshot,
  );
}
