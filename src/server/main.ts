import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { closeDb, countTotalCloses, getDistinctSymbols } from "./db.ts";
import { getChannelsOverview, resetChannelState } from "./lib/llm.ts";
import {
  recordPositionSnapshot,
  removePositionSnapshot,
  updateStrategyConfig,
} from "./position.ts";
import { readMarkets, refreshMarkets } from "./quotes.ts";
import { startScheduler, stopScheduler } from "./scheduler.ts";
import type { MarketCategory, PositionTargetSymbol } from "../shared/types.ts";

const CLIENT_DIR = path.resolve(import.meta.dirname, "../../dist/client");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function weakEtag(prefix: string, body: string | Buffer): string {
  return `W/"${prefix}-${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || strip(t) === strip(etag));
}

function sendJsonWithEtag(
  req: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
  opts: { etagPrefix: string; cacheControl: string },
) {
  const text = JSON.stringify(body);
  const etag = weakEtag(opts.etagPrefix, text);
  reply.header("ETag", etag).header("Cache-Control", opts.cacheControl).header("Vary", "Accept-Encoding");
  if (etagMatches(req.headers["if-none-match"], etag)) return reply.code(304).send();
  return reply.header("Content-Type", "application/json; charset=utf-8").send(text);
}

export function buildServer() {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => {
    return {
      status: "ok",
      service: "mymarkets",
      symbols: getDistinctSymbols().size,
      totalCloses: countTotalCloses(),
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/api/markets", async (req, reply) => {
    const answer = await readMarkets();
    return sendJsonWithEtag(req, reply, answer, {
      etagPrefix: "markets",
      cacheControl: "no-cache",
    });
  });

  app.post("/api/markets/refresh", async (req, reply) => {
    if (process.env.COLLECT_ENABLED !== "true") {
      return reply.code(403).send({ error: "COLLECT_ENABLED is not true" });
    }
    const query = (req.query as { category?: string; mode?: string } | undefined) ?? {};
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
      category?: string;
      mode?: string;
    };
    const category = (body.category ?? query.category ?? "all") as MarketCategory | "all";
    const mode = (body.mode ?? query.mode ?? "all") as "all" | "quotes" | "ai";

    const written = await refreshMarkets(new Date(), undefined, undefined, category, {
      force: true,
      skipQuotes: mode === "ai",
      skipAi: mode === "quotes",
      allowPartial: true,
    });
    const markets = await readMarkets();
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(
        JSON.stringify({
          ok: true,
          category,
          mode,
          written,
          refreshedAt: new Date().toISOString(),
          markets,
        }),
      );
  });

  app.get("/api/llm/channels", async (req, reply) => {
    const rawDays = (req.query as { days?: string } | undefined)?.days;
    const days = rawDays !== undefined && rawDays !== "" ? Number(rawDays) : 30;
    const overview = await getChannelsOverview(Number.isFinite(days) ? days : 30);
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(JSON.stringify(overview));
  });

  app.post("/api/llm/channels/:id/reset", async (req) => {
    const id = (req.params as { id?: string } | undefined)?.id || "all";
    return resetChannelState(id);
  });

  app.post("/api/positions/snapshot", async (req, reply) => {
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
      symbol?: string;
      day?: string;
      shares?: number | null;
      marketValue?: number;
      unrealizedPnl?: number;
      note?: string | null;
    };
    const validSymbols = new Set<PositionTargetSymbol>(["etf_516670", "cea_600115", "etf_513180"]);
    const symbol = body.symbol as PositionTargetSymbol | undefined;
    if (!symbol || !validSymbols.has(symbol)) {
      return reply.code(400).send({ error: "Invalid symbol" });
    }
    const marketValue = Number(body.marketValue);
    const unrealizedPnl = Number(body.unrealizedPnl);
    if (!Number.isFinite(marketValue) || marketValue < 0 || !Number.isFinite(unrealizedPnl)) {
      return reply.code(400).send({ error: "Invalid marketValue or unrealizedPnl" });
    }
    let shares: number | null = null;
    if (symbol !== "etf_513180") {
      shares = Number(body.shares);
      if (!Number.isFinite(shares) || shares < 0) {
        return reply.code(400).send({ error: "Invalid shares" });
      }
    }

    const snapshot = recordPositionSnapshot({
      symbol,
      day: body.day,
      shares,
      marketValue,
      unrealizedPnl,
      note: body.note ?? null,
    });
    const markets = await readMarkets();
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(JSON.stringify({ ok: true, snapshot, markets }));
  });

  app.delete("/api/positions/snapshot/:id", async (req, reply) => {
    const rawId = (req.params as { id?: string } | undefined)?.id;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: "Invalid snapshot id" });
    }
    const deleted = removePositionSnapshot(id);
    const markets = await readMarkets();
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(JSON.stringify({ ok: true, deleted, markets }));
  });

  app.post("/api/positions/config", async (req, reply) => {
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
      symbol?: string;
      anchorPrice?: number;
      baseCoreShares?: number;
      dcaPeriods?: number;
      dcaBaseDaily?: number;
    };
    const validSymbols = new Set<PositionTargetSymbol>(["etf_516670", "cea_600115", "etf_513180"]);
    const symbol = body.symbol as PositionTargetSymbol | undefined;
    if (!symbol || !validSymbols.has(symbol)) {
      return reply.code(400).send({ error: "Invalid symbol" });
    }
    const patch: Record<string, number> = {};
    if (typeof body.anchorPrice === "number" && Number.isFinite(body.anchorPrice) && body.anchorPrice > 0) {
      patch.anchorPrice = body.anchorPrice;
    }
    if (typeof body.baseCoreShares === "number" && Number.isFinite(body.baseCoreShares) && body.baseCoreShares >= 0) {
      patch.baseCoreShares = Math.round(body.baseCoreShares);
    }
    if (typeof body.dcaPeriods === "number" && Number.isFinite(body.dcaPeriods) && body.dcaPeriods >= 0) {
      patch.dcaPeriods = Math.round(body.dcaPeriods);
    }
    if (typeof body.dcaBaseDaily === "number" && Number.isFinite(body.dcaBaseDaily) && body.dcaBaseDaily >= 10) {
      patch.dcaBaseDaily = Math.round(body.dcaBaseDaily);
    }

    const config = updateStrategyConfig(symbol, patch);
    const markets = await readMarkets();
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(JSON.stringify({ ok: true, config, markets }));
  });

  // Serve static frontend files or SPA index.html
  app.get("/*", async (req, reply) => {
    const urlPath = (req.raw.url ?? "/").split("?")[0] || "/";
    if (urlPath.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }

    if (urlPath !== "/" && urlPath !== "/markets") {
      const safeRel = path.posix.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^\/+/, "");
      const candidate = path.join(CLIENT_DIR, safeRel);
      if (candidate.startsWith(CLIENT_DIR) && existsSync(candidate) && statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        const content = readFileSync(candidate);
        const isHashedAsset = safeRel.startsWith("assets/");
        const cacheControl = isHashedAsset ? "public, max-age=31536000, immutable" : "public, max-age=300";
        const etag = weakEtag("asset", content);
        reply
          .header("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream")
          .header("Cache-Control", cacheControl)
          .header("ETag", etag);
        if (etagMatches(req.headers["if-none-match"], etag)) return reply.code(304).send();
        return reply.send(content);
      }
    }

    const indexHtmlPath = path.join(CLIENT_DIR, "index.html");
    if (existsSync(indexHtmlPath)) {
      const html = readFileSync(indexHtmlPath, "utf8");
      return reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .send(html);
    }

    return reply
      .code(200)
      .header("Content-Type", "text/html; charset=utf-8")
      .send("<!doctype html><html><body><p>MyMarkets API is running. Run <code>npm run build</code> to build the web UI.</p></body></html>");
  });

  return app;
}

if (import.meta.main) {
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || "4080");
  const app = buildServer();

  await app.listen({ host, port });
  startScheduler();
  console.log(JSON.stringify({ level: "info", msg: "MyMarkets server started", host, port }));

  const shutdown = async () => {
    stopScheduler();
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
