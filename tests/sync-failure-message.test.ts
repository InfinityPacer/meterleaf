import { expect, test } from "bun:test";
import { syncFailureMessage } from "../src/web/components/SyncControl";

test("sync failures read as a plain step and next action without internal codes", () => {
  expect(syncFailureMessage({ stage: "incremental", kind: "network" })).toBe(
    "补采用量时连接中断。请确认 Meterleaf 能连上 Sub2API 数据库，恢复后会自动继续。",
  );
  expect(syncFailureMessage({ stage: "future", kind: "future" })).toBe(
    "同步时出错。稍后会自动重试。",
  );
});
