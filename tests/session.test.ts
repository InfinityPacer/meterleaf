import { expect, test } from "bun:test";
import {
  createLedgerReadSignal,
  INITIAL_LEDGER_READ_TIMEOUT_MS,
  isLedgerNetworkError,
  reportRefetchInterval,
  reportRetry,
  reportRetryDelay,
} from "../src/web/lib/report-building";
import {
  SessionExpiredError,
  isLoginRedirect,
  isSessionExpired,
  reloadForSessionLogin,
} from "../src/web/lib/session";

test("login interception is told apart from gateway and network failures", () => {
  expect(isLoginRedirect({ type: "opaqueredirect", status: 0 })).toBe(true);
  expect(isLoginRedirect({ type: "basic", status: 401 })).toBe(true);
  expect(isLoginRedirect({ type: "basic", status: 403 })).toBe(true);
  expect(isLoginRedirect({ type: "basic", status: 502 })).toBe(false);
  expect(isLoginRedirect({ type: "basic", status: 200 })).toBe(false);
});

test("an expired session is not retried because only a reload can recover it", () => {
  const expired = new SessionExpiredError();
  expect(isSessionExpired(expired)).toBe(true);
  expect(expired.message).toContain("登录已过期");
  expect(reportRetry(0, expired)).toBe(false);
  expect(reportRetry(0, new Error("报表读取失败：网络连接异常"))).toBe(true);
});

test("disconnected initial ledger reads auto-poll every 3s without polling server HTTP errors", () => {
  const networkErr = new Error("报表读取失败：网络连接异常");
  const gatewayErr = new Error("报表读取失败：网关不可用（HTTP 503）");
  expect(isLedgerNetworkError(networkErr)).toBe(true);
  expect(isLedgerNetworkError(gatewayErr)).toBe(false);
  expect(
    reportRefetchInterval(
      {
        state: {
          error: networkErr,
          status: "error",
          fetchFailureCount: 2,
          data: undefined,
        },
      },
      false,
    ),
  ).toBe(3000);
  expect(
    reportRefetchInterval(
      {
        state: {
          error: gatewayErr,
          status: "error",
          fetchFailureCount: 2,
          data: undefined,
        },
      },
      false,
    ),
  ).toBe(false);
});

test("reloadForSessionLogin clears cached app shells and prepares an 8000ms auth navigation", async () => {
  const deleted: string[] = [];
  const messages: unknown[] = [];
  let reloaded = false;
  const prevWindow = globalThis.window;
  const prevCaches = globalThis.caches;
  const prevNavigator = globalThis.navigator;
  Object.assign(globalThis, {
    caches: {
      keys: async () => ["meterleaf-offline-v8", "meterleaf-shell-abc123"],
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
    },
    navigator: {
      serviceWorker: {
        controller: {
          postMessage: (data: unknown, transfer?: MessagePort[]) => {
            messages.push(data);
            transfer?.[0]?.postMessage(true);
          },
        },
      },
    },
    window: {
      location: {
        reload: () => {
          reloaded = true;
        },
      },
    },
  });
  try {
    await reloadForSessionLogin();
    expect(deleted).toEqual(["meterleaf-shell-abc123"]);
    expect(messages).toEqual([{ type: "meterleaf-prepare-navigate" }]);
    expect(reloaded).toBe(true);
  } finally {
    Object.assign(globalThis, {
      window: prevWindow,
      caches: prevCaches,
      navigator: prevNavigator,
    });
  }
});

test("createLedgerReadSignal distinguishes socket timeout from caller cancellation", async () => {
  expect(INITIAL_LEDGER_READ_TIMEOUT_MS).toBe(6000);
  const caller = new AbortController();
  const timed = createLedgerReadSignal(caller.signal, 25);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(timed.signal?.aborted).toBe(true);
  expect(timed.timedOut()).toBe(true);
  timed.cleanup();

  const cancelledCaller = new AbortController();
  const cancelled = createLedgerReadSignal(cancelledCaller.signal, 5000);
  cancelledCaller.abort();
  expect(cancelled.signal?.aborted).toBe(true);
  expect(cancelled.timedOut()).toBe(false);
  cancelled.cleanup();

  expect(reportRetryDelay(0, new Error("报表读取失败：网络连接异常"))).toBe(
    100,
  );
  expect(
    reportRetryDelay(0, new Error("报表读取失败：网关不可用（HTTP 503）")),
  ).toBe(1000);
});
