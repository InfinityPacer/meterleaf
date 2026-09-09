import { expect, test } from "bun:test";
import { createServer } from "node:net";

/** 进程级验证覆盖真实入口；动态端口不占用开发服务，finally 保证退出。 */
test("entrypoint serves explicit demo and shuts down on SIGTERM", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const child = Bun.spawn([process.execPath, "src/server/main.ts"], {
    env: {
      ...process.env,
      METERLEAF_HOST: "127.0.0.1",
      METERLEAF_PORT: String(port),
      METERLEAF_DEMO: "true",
      METERLEAF_LOG_LEVEL: "info",
      METERLEAF_PRICE_BOOK: "",
      SUB2API_DATABASE_URL: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null)
        throw new Error("Server exited before listening");
      try {
        ready = (await fetch(`${url}/api/health`)).ok;
      } catch {}
      if (ready) break;
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const subscription = await fetch(`${url}/api/ledger?days=7`).then((r) =>
      r.json(),
    );
    const api = await fetch(`${url}/api/ledger?days=7&usdBasis=api`).then((r) =>
      r.json(),
    );
    expect(subscription.mode).toBe("demo");
    expect(subscription.usdBasis).toBe("subscription");
    expect(api.usdBasis).toBe("api");
    expect(api.records.length).toBe(subscription.records.length);
    expect(api.records.map((r: { credits: string }) => r.credits)).toEqual(
      subscription.records.map((r: { credits: string }) => r.credits),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const events = (await new Response(child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.event)).toEqual([
      "server.started",
      "server.stopping",
      "server.stopped",
    ]);
    expect(events[0].mode).toBe("demo");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10_000);
