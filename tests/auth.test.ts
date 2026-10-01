import { expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { readConfig } from "../src/server/config";
import type { GithubAuthConfig, GithubClient } from "../src/server/auth";
import { INGEST_BATCHES_PATH } from "../src/shared/ingest";
import type { LedgerSnapshot } from "../src/shared/report";

const auth: GithubAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret-value",
  users: ["InfinityPacer"],
  publicUrl: "https://meterleaf.example.test",
  sessionDays: 30,
};
const DAY = 86_400;

function setup(login = "infinitypacer", start = 1_800_000_000) {
  let clock = start;
  const exchanged: string[] = [];
  const client: GithubClient = {
    async exchangeCode(code, redirectUri) {
      exchanged.push(`${code} ${redirectUri}`);
      if (code === "bad") throw new Error("bad_verification_code");
      return "token";
    },
    async fetchUser() {
      return { id: 42, login };
    },
  };
  const app = createApp({
    snapshot: () => ({}) as LedgerSnapshot,
    githubAuth: auth,
    githubClient: client,
    now: () => clock,
  });
  return {
    app,
    exchanged,
    advance(seconds: number) {
      clock += seconds;
    },
  };
}

function cookies(response: { headers: Record<string, unknown> }) {
  const raw = response.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return new Map(
    list.map((line: string) => {
      const [pair] = line.split(";");
      const index = pair!.indexOf("=");
      return [pair!.slice(0, index), { value: pair!.slice(index + 1), line }];
    }),
  );
}

async function login(ctx: ReturnType<typeof setup>, next = "/reports?x=1") {
  const start = await ctx.app.inject({
    url: `/auth/github/login?next=${encodeURIComponent(next)}`,
  });
  const state = new URL(String(start.headers.location)).searchParams.get(
    "state",
  )!;
  const stateCookie = cookies(start).get("meterleaf_oauth")!.value;
  const callback = await ctx.app.inject({
    url: `/auth/github/callback?code=ok&state=${state}`,
    headers: { cookie: `meterleaf_oauth=${stateCookie}` },
  });
  return { start, callback, state, stateCookie };
}

test("GitHub login is enabled only with complete configuration", () => {
  const base = { METERLEAF_DEMO: "true" };
  expect(readConfig(base).githubAuth).toBeUndefined();
  expect(
    readConfig({
      ...base,
      METERLEAF_GITHUB_CLIENT_ID: "",
      METERLEAF_GITHUB_CLIENT_SECRET: "",
      METERLEAF_GITHUB_USERS: "",
      METERLEAF_PUBLIC_URL: "",
    }).githubAuth,
  ).toBeUndefined();
  expect(() =>
    readConfig({ ...base, METERLEAF_GITHUB_CLIENT_ID: "id" }),
  ).toThrow("GitHub login needs");
  const full = {
    ...base,
    METERLEAF_GITHUB_CLIENT_ID: "id",
    METERLEAF_GITHUB_CLIENT_SECRET: "very-secret",
    METERLEAF_GITHUB_USERS: "InfinityPacer, other-user",
    METERLEAF_PUBLIC_URL: "https://meterleaf.example.test",
  };
  expect(readConfig(full).githubAuth).toEqual({
    clientId: "id",
    clientSecret: "very-secret",
    users: ["InfinityPacer", "other-user"],
    publicUrl: "https://meterleaf.example.test",
    sessionDays: 30,
  });
  expect(() =>
    readConfig({ ...full, METERLEAF_GITHUB_USERS: "not a login" }),
  ).toThrow("METERLEAF_GITHUB_USERS");
  try {
    readConfig({ ...full, METERLEAF_PUBLIC_URL: "very-secret" });
  } catch (error) {
    expect(String(error)).not.toContain("very-secret");
  }
});

test("unauthenticated pages go to GitHub and APIs answer 401", async () => {
  const { app } = setup();
  const page = await app.inject({ url: "/reports?range=7d" });
  expect(page.statusCode).toBe(302);
  expect(page.headers.location).toBe(
    "/auth/github/login?next=%2Freports%3Frange%3D7d",
  );
  const api = await app.inject({ url: "/api/view" });
  expect(api.statusCode).toBe(401);
  expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
  // 采集器写入自带设备密钥，不经过登录；未配置写入时该路径不存在。
  expect(
    (await app.inject({ method: "POST", url: INGEST_BATCHES_PATH })).statusCode,
  ).toBe(404);

  const start = await app.inject({ url: "/auth/github/login?next=/x" });
  const authorize = new URL(String(start.headers.location));
  expect(authorize.origin + authorize.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(authorize.searchParams.get("client_id")).toBe("client-id");
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "https://meterleaf.example.test/auth/github/callback",
  );
  const state = cookies(start).get("meterleaf_oauth")!.line;
  expect(state).toContain("HttpOnly");
  expect(state).toContain("Secure");
  expect(state).toContain("Path=/auth/");
});

test("an allowed account gets a 30-day session and returns to its page", async () => {
  const ctx = setup();
  const { callback } = await login(ctx);
  expect(callback.statusCode).toBe(302);
  expect(callback.headers.location).toBe("/reports?x=1");
  expect(ctx.exchanged).toEqual([
    "ok https://meterleaf.example.test/auth/github/callback",
  ]);
  const session = cookies(callback).get("meterleaf_session")!;
  expect(session.line).toContain(`Max-Age=${30 * DAY}`);
  expect(session.line).toContain("SameSite=Lax");
  expect(cookies(callback).get("meterleaf_oauth")!.line).toContain("Max-Age=0");
  const api = await ctx.app.inject({
    url: "/api/health/nothing",
    headers: { cookie: `meterleaf_session=${session.value}` },
  });
  expect(api.statusCode).toBe(404);
});

test("the session slides while used and ends after 30 idle days", async () => {
  const ctx = setup();
  let session = cookies((await login(ctx)).callback).get(
    "meterleaf_session",
  )!.value;
  const visit = () =>
    ctx.app.inject({
      url: "/api/missing",
      headers: { cookie: `meterleaf_session=${session}` },
    });
  // 一天内不重复签发。
  ctx.advance(DAY - 1);
  expect(cookies(await visit()).has("meterleaf_session")).toBe(false);
  // 每隔约一个月使用一次，会话持续顺延。
  for (let month = 0; month < 3; month++) {
    ctx.advance(29 * DAY);
    const renewed = await visit();
    expect(renewed.statusCode).toBe(404);
    session = cookies(renewed).get("meterleaf_session")!.value;
  }
  ctx.advance(30 * DAY);
  expect((await visit()).statusCode).toBe(401);
});

test("tampered sessions, wrong state and other accounts are refused", async () => {
  const ctx = setup();
  const session = cookies((await login(ctx)).callback).get(
    "meterleaf_session",
  )!.value;
  const [body, signature] = session.split(".");
  const forged = `${Buffer.from(
    JSON.stringify({ u: "InfinityPacer", i: 42, iat: 0, exp: 9e9 }),
  ).toString("base64url")}.${signature}`;
  expect(
    (
      await ctx.app.inject({
        url: "/api/view",
        headers: { cookie: `meterleaf_session=${forged}` },
      })
    ).statusCode,
  ).toBe(401);
  expect(body).toBeTruthy();

  const { stateCookie } = await login(ctx);
  const wrongState = await ctx.app.inject({
    url: "/auth/github/callback?code=ok&state=other",
    headers: { cookie: `meterleaf_oauth=${stateCookie}` },
  });
  expect(wrongState.statusCode).toBe(400);

  const stranger = setup("someone-else");
  const denied = (await login(stranger)).callback;
  expect(denied.statusCode).toBe(403);
  expect(denied.body).toContain("someone-else");
  expect(cookies(denied).has("meterleaf_session")).toBe(false);

  const failing = setup();
  const start = await failing.app.inject({ url: "/auth/github/login" });
  const state = new URL(String(start.headers.location)).searchParams.get(
    "state",
  );
  const failed = await failing.app.inject({
    url: `/auth/github/callback?code=bad&state=${state}`,
    headers: {
      cookie: `meterleaf_oauth=${cookies(start).get("meterleaf_oauth")!.value}`,
    },
  });
  expect(failed.statusCode).toBe(502);
});

test("login never redirects outside the site", async () => {
  const ctx = setup();
  for (const next of ["https://evil.test/", "//evil.test", "/\\evil.test"]) {
    const { callback } = await login(ctx, next);
    expect(callback.headers.location).toBe("/");
  }
});
