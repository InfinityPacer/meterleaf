import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { dateRangeSchema, type DateRange } from "../shared/date-range";
import type { LedgerSnapshot, UsdBasis } from "../shared/report";
import { silentLogger, type DiagnosticsLogger } from "./diagnostics";
import { encodeLedger } from "../shared/ledger-wire";
import type { SyncStatus } from "./sync";
import { registerResponseCompression } from "./response-compression";
import { z } from "zod";
import {
  createLedgerView,
  type LedgerView,
  type ViewQuery,
} from "../shared/ledger-view";

interface AppOptions {
  /** 本地账户展示状态，不向连接器透传写操作。 */
  accountArchive?: {
    read(): string[];
    write(id: string, archived: boolean): string[];
    hidden(): string[];
    hide(id: string): string[];
  };
  snapshot: (
    days: number,
    usdBasis?: UsdBasis,
    dateRange?: DateRange,
  ) => LedgerSnapshot;
  view?: (
    query: ViewQuery,
    usdBasis?: UsdBasis,
    refresh?: boolean,
  ) => Promise<LedgerView>;
  webRoot?: string;
  diagnostics?: DiagnosticsLogger;
  sync?: {
    status(): SyncStatus;
    requestSync(): unknown;
    setAutoSync(enabled: boolean): unknown;
    updatePresence?(id: string, visible: boolean): void;
  };
}
/** 服务读写本地账本状态；上游保持只读，认证由外部反代负责。 */
export function createApp({
  snapshot,
  view,
  webRoot,
  diagnostics = silentLogger,
  sync,
  accountArchive,
}: AppOptions) {
  const app = Fastify({ logger: false });
  registerResponseCompression(app);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });
  // 在压缩钩子之后记录发送前耗时；只暴露数值，不包含查询条件或来源信息。
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.routeOptions.url === "/api/view") {
      const report = reply.getHeader("Server-Timing");
      reply.header(
        "Server-Timing",
        `${report ? `${report}, ` : ""}app;dur=${reply.elapsedTime.toFixed(2)}`,
      );
    }
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    // 仅记录路由模板，不复制查询串、请求头或正文。
    diagnostics.log(
      reply.statusCode >= 400 ? "warn" : "debug",
      "http.completed",
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
    );
  });
  app.get("/api/health", () => ({ status: "ok" }));
  app.get("/api/accounts/archive", () => ({
    archived: accountArchive?.read() ?? [],
    hidden: accountArchive?.hidden() ?? [],
    writable: Boolean(accountArchive),
  }));
  app.put("/api/accounts/archive", (request, reply) => {
    const id = z.string().min(1).max(512);
    const parsed = z
      .union([
        z.object({ id, archived: z.boolean() }).strict(),
        z.object({ id, hidden: z.literal(true) }).strict(),
      ])
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "归档参数无效" });
    if (!accountArchive)
      return reply.code(503).send({ error: "当前账本不支持归档" });
    if ("hidden" in parsed.data) accountArchive.hide(parsed.data.id);
    else accountArchive.write(parsed.data.id, parsed.data.archived);
    diagnostics.info("account.display_updated", {
      action:
        "hidden" in parsed.data
          ? "hide"
          : parsed.data.archived
            ? "archive"
            : "restore",
    });
    return {
      archived: accountArchive.read(),
      hidden: accountArchive.hidden(),
      writable: true,
    };
  });
  app.get("/api/view", async (request, reply) => {
    const parsed = z
      .object({
        days: z.coerce
          .number()
          .refine((n) => [1, 7, 30].includes(n))
          .optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        usdBasis: z.enum(["subscription", "api"]).optional(),
        refresh: z.enum(["true", "false"]).default("true"),
        model: z.string().max(256).default("all"),
        account: z.string().max(256).default("all"),
        search: z.string().max(256).default(""),
        unit: z.enum(["usd", "credits", "tokens"]).default("usd"),
        granularity: z.enum(["hour", "day", "week"]).default("day"),
        dimension: z
          .enum(["hour", "day", "week", "model", "account"])
          .default("day"),
        page: z.coerce.number().int().min(0).max(1_000_000).default(0),
        pageSize: z.coerce.number().int().min(1).max(100).default(12),
        sort: z
          .enum([
            "occurredAt",
            "model",
            "accountId",
            "input",
            "cacheRead",
            "output",
            "usd",
          ])
          .default("occurredAt"),
        desc: z.enum(["true", "false"]).default("true"),
      })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid-view-query" });
    const q = parsed.data;
    let dateRange: DateRange | undefined;
    if (q.from !== undefined || q.to !== undefined) {
      const range = dateRangeSchema.safeParse({ from: q.from, to: q.to });
      if (!range.success || q.days !== undefined)
        return reply.code(400).send({ error: "invalid-date-range" });
      dateRange = range.data;
    }
    const query: ViewQuery = {
      filter: {
        days: q.days ?? 7,
        dateRange,
        model: q.model,
        account: q.account,
        search: q.search,
      },
      unit: q.unit,
      granularity: q.granularity,
      dimension: q.dimension,
      page: q.page,
      pageSize: q.pageSize,
      sort: q.sort,
      desc: q.desc === "true",
    };
    reply.header("Cache-Control", "no-store");
    const started = performance.now();
    try {
      return view
        ? await view(query, q.usdBasis, q.refresh === "true")
        : createLedgerView(
            snapshot(query.filter.days, q.usdBasis, dateRange),
            query,
          );
    } finally {
      // 包括视图缓存读取或 worker 等待，但不包括响应编码、压缩和网络传输。
      reply.header(
        "Server-Timing",
        `report;dur=${(performance.now() - started).toFixed(2)}`,
      );
    }
  });
  app.get("/api/sync", (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return sync?.status() ?? { unavailable: true };
  });
  app.post<{ Body: { id?: unknown; visible?: unknown } }>(
    "/api/sync/presence",
    (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const { id, visible } = request.body ?? {};
      if (
        typeof id !== "string" ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
        typeof visible !== "boolean"
      )
        return reply.code(400).send({ error: "invalid-page-presence" });
      sync?.updatePresence?.(id, visible);
      return sync?.status() ?? { unavailable: true };
    },
  );
  app.post("/api/sync", (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!sync) return reply.code(409).send({ error: "sync-unavailable" });
    sync.requestSync();
    diagnostics.info("sync.requested", {
      requestId: _request.id,
      trigger: "manual",
    });
    return reply.code(202).send(sync.status());
  });
  app.put<{ Body: { enabled?: unknown } }>(
    "/api/sync/automatic",
    (request, reply) => {
      if (!sync) return reply.code(409).send({ error: "sync-unavailable" });
      if (typeof request.body?.enabled !== "boolean")
        return reply.code(400).send({ error: "enabled-must-be-boolean" });
      sync.setAutoSync(request.body.enabled);
      diagnostics.info("sync.automatic_changed", {
        requestId: request.id,
        enabled: request.body.enabled,
      });
      return sync.status();
    },
  );
  app.get<{
    Querystring: {
      days?: string;
      from?: string;
      to?: string;
      usdBasis?: string;
      compact?: string;
    };
  }>("/api/ledger", (request, reply) => {
    const hasFrom = request.query.from !== undefined;
    const hasTo = request.query.to !== undefined;
    const hasDays = request.query.days !== undefined;
    if (hasFrom !== hasTo || (hasFrom && hasTo && hasDays))
      return reply.code(400).send({
        error:
          "from and to must be provided together and cannot be combined with days",
      });

    const days = Number(request.query.days ?? "30");
    if (![1, 7, 30].includes(days))
      return reply.code(400).send({ error: "days must be 1, 7, or 30" });

    let dateRange: DateRange | undefined;
    if (hasFrom && hasTo) {
      const parsed = dateRangeSchema.safeParse({
        from: request.query.from,
        to: request.query.to,
      });
      if (!parsed.success)
        return reply.code(400).send({
          error: "from and to must be valid YYYY-MM-DD dates with from <= to",
        });
      dateRange = parsed.data;
    }

    const usdBasis = request.query.usdBasis;
    if (
      usdBasis !== undefined &&
      usdBasis !== "api" &&
      usdBasis !== "subscription"
    )
      return reply
        .code(400)
        .send({ error: "usdBasis must be subscription or api" });
    reply.header("Cache-Control", "no-store");
    const result = snapshot(days, usdBasis, dateRange);
    return request.query.compact === "1" ? encodeLedger(result) : result;
  });
  app.setErrorHandler((error, request, reply) => {
    diagnostics.error("http.failed", {
      requestId: request.id,
      route: request.routeOptions.url ?? "unmatched",
      error,
    });
    reply.code(500).send({
      error: request.routeOptions.url?.startsWith("/api/sync")
        ? "sync-operation-failed"
        : "ledger-read-failed",
      requestId: request.id,
    });
  });
  if (webRoot && existsSync(resolve(webRoot, "index.html"))) {
    const staticRoot = resolve(webRoot);
    app.register(fastifyStatic, {
      root: staticRoot,
      preCompressed: true,
      cacheControl: false,
      setHeaders: (reply, path) => {
        const relative = path.slice(staticRoot.length).replaceAll("\\", "/");
        const logical = relative.replace(/\.(?:br|gz)$/, "");
        if (/^\/assets\/.+[-_][A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(logical)) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        } else if (
          logical === "/index.html" ||
          logical === "/sw.js" ||
          logical === "/manifest.webmanifest"
        ) {
          reply.header("Cache-Control", "no-cache");
        } else {
          reply.header("Cache-Control", "public, max-age=3600");
        }
      },
    });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "not-found" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
