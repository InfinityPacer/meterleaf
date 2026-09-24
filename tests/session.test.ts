import { expect, test } from "bun:test";
import { reportRetry } from "../src/web/lib/report-building";
import {
  SessionExpiredError,
  isLoginRedirect,
  isSessionExpired,
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
