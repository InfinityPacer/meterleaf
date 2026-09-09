import { expect, test } from "bun:test";
import {
  getLiveUpdatesSnapshot,
  setLiveUpdatesPaused,
  subscribeLiveUpdates,
} from "../src/web/lib/use-live-updates";

test("live updates share pause and resume notifications across subscribers", () => {
  setLiveUpdatesPaused(false);
  const first = { notifications: 0 };
  const second = { notifications: 0 };
  const unsubscribeFirst = subscribeLiveUpdates(() => {
    first.notifications += 1;
  });
  const unsubscribeSecond = subscribeLiveUpdates(() => {
    second.notifications += 1;
  });

  try {
    expect(getLiveUpdatesSnapshot().paused).toBe(false);
    getLiveUpdatesSnapshot().setPaused(true);
    expect(getLiveUpdatesSnapshot().paused).toBe(true);
    expect(first.notifications).toBe(1);
    expect(second.notifications).toBe(1);

    getLiveUpdatesSnapshot().setPaused(true);
    expect(first.notifications).toBe(1);
    expect(second.notifications).toBe(1);

    unsubscribeFirst();
    setLiveUpdatesPaused(false);
    expect(getLiveUpdatesSnapshot().paused).toBe(false);
    expect(first.notifications).toBe(1);
    expect(second.notifications).toBe(2);
  } finally {
    unsubscribeFirst();
    unsubscribeSecond();
    setLiveUpdatesPaused(false);
  }
});
