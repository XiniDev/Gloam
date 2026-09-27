import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VITE_HMR_PORT } from "@gloam/shared";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { ViteDevServer } from "vite";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { csrfGuard, ok, requestContext, route, sendError } from "./helpers.ts";
import { adminRoutes } from "./routes/admin.ts";
import { type AuthRouteHooks, authRoutes } from "./routes/auth.ts";

const NONCE_PLACEHOLDER = "__GLOAM_NONCE__";
const VALID_HOST = /^[A-Za-z0-9.\-:[\]]+$/;

export interface HttpAppHandle {
  vite: ViteDevServer | null;
  close(): Promise<void>;
}

export interface HttpAppOptions {
  onSetupComplete?: AuthRouteHooks["onSetupComplete"];
}

/**
 * The Express 5 app (SPEC §11, §22.4): security headers on every response, request context, rate limits,
 * CSRF/Origin guard, REST routes, then the SPA (Vite middleware in dev, static files in production).
 */
export async function buildHttpApp(
  app: Express,
  ctx: ServerContext,
  opts: HttpAppOptions = {},
): Promise<HttpAppHandle> {
  const dev = ctx.config.nodeEnv === "development";
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.set("etag", false);

  // Reject hosts we'd otherwise echo into connect-src (R3 deviation 32).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!VALID_HOST.test(req.headers.host ?? "")) return sendError(res, 400, "INVALID", "Bad Host header.");
    next();
  });
  app.use(requestContext(ctx));

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'wasm-unsafe-eval'",
            ...(dev
              ? [(_req: unknown, res: unknown) => `'nonce-${(res as Response).locals.nonce as string}'`]
              : []),
          ],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "blob:", "data:"],
          mediaSrc: ["'self'", "blob:"],
          fontSrc: ["'self'"],
          connectSrc: [
            "'self'",
            (req: unknown) => {
              const r = req as Request;
              return `${r.gloam.https ? "wss" : "ws"}://${r.headers.host ?? "localhost"}`;
            },
            ...(dev ? [`ws://127.0.0.1:${VITE_HMR_PORT}`] : []),
          ],
          workerSrc: ["'self'", "blob:"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          reportUri: ["/api/csp-report"],
        },
      },
      strictTransportSecurity: false,
      xFrameOptions: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      crossOriginEmbedderPolicy: false,
      xContentTypeOptions: true,
    }),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (req.gloam.https) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });

  app.use(
    "/api",
    express.json({
      limit: "256kb",
      type: ["application/json", "application/csp-report", "application/reports+json"],
    }),
  );
  // REST per session (or per IP when anonymous): 60 per 10 s (SPEC §22.5).
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const key = req.gloam.auth ? `s:${req.gloam.auth.session.id}` : `ip:${req.gloam.ip}`;
    if (!ctx.limits.rest.take(key)) return sendError(res, 429, "RATE_LIMITED", "Slow down a little.");
    next();
  });
  app.use(csrfGuard(ctx));

  const sendSpa = async (req: Request, res: Response) => {
    if (vite) {
      const raw = await readFile(join(ctx.config.webRoot, "index.html"), "utf8");
      const html = await vite.transformIndexHtml(req.originalUrl, raw);
      res
        .type("html")
        .setHeader("Cache-Control", "no-store")
        .send(html.replaceAll(NONCE_PLACEHOLDER, req.gloam.nonce));
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(join(ctx.config.webDist, "index.html"));
  };

  authRoutes(app, ctx, { sendSpa, onSetupComplete: opts.onSetupComplete });
  adminRoutes(app, ctx);

  app.get(
    "/api/health",
    route((_req, res) => ok(res, { ok: true, uptimeMs: Date.now() - ctx.startedAt })),
  );
  let cspReports = 0;
  app.post("/api/csp-report", (req: Request, res: Response) => {
    // Violations are logged locally (never forwarded); a flood is capped.
    if (cspReports++ < 500) {
      const b = req.body as Record<string, unknown> | undefined;
      const r = (b?.["csp-report"] ?? b) as Record<string, unknown> | undefined;
      ctx.log.warn(
        {
          directive: r?.["violated-directive"] ?? r?.effectiveDirective,
          blocked: r?.["blocked-uri"] ?? r?.blockedURL,
        },
        "CSP violation",
      );
      ctx.security.record("csp.violation", {
        ip: req.gloam.ip,
        detail: {
          directive: String(r?.["violated-directive"] ?? r?.effectiveDirective ?? ""),
          blocked: String(r?.["blocked-uri"] ?? r?.blockedURL ?? ""),
        },
      });
    }
    res.status(204).end();
  });
  const ClientLog = z.strictObject({
    level: z.enum(["error", "warn"]),
    message: z.string().max(2000),
    stack: z.string().max(8000).optional(),
    url: z.string().max(500).optional(),
  });
  app.post(
    "/api/client-log",
    route((req, res) => {
      const b = ClientLog.parse(req.body ?? {});
      ctx.log[b.level](
        { client: true, message: b.message, stack: b.stack, url: b.url, ip: req.gloam.ip },
        "client log",
      );
      ok(res);
    }),
  );
  app.use("/api", (_req: Request, res: Response) => sendError(res, 404, "NOT_FOUND", "No such endpoint."));

  let vite: ViteDevServer | null = null;
  if (dev) {
    const { createServer } = await import("vite");
    vite = await createServer({
      root: ctx.config.webRoot,
      configFile: join(ctx.config.webRoot, "vite.config.ts"),
      appType: "custom",
      html: { cspNonce: NONCE_PLACEHOLDER },
      server: {
        middlewareMode: true,
        ws: { port: VITE_HMR_PORT, host: "127.0.0.1" },
        allowedHosts: true,
      },
      logLevel: "warn",
    });
    app.use(vite.middlewares);
  } else if (existsSync(ctx.config.webDist)) {
    app.use(
      "/static",
      express.static(join(ctx.config.webDist, "static"), {
        immutable: true,
        maxAge: "365d",
        index: false,
        fallthrough: false,
      }),
    );
    app.use(express.static(ctx.config.webDist, { index: false, maxAge: "1h" }));
  }
  app.get(
    "/{*splat}",
    route(async (req, res) => {
      if (!vite && !existsSync(join(ctx.config.webDist, "index.html"))) {
        res.status(503).type("text").send("The web app isn't built yet. Run `pnpm build`, then restart.");
        return;
      }
      await sendSpa(req, res);
    }),
  );
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number }).status ?? 500;
    if (status >= 500) ctx.log.error({ err, path: req.path }, "request failed");
    sendError(
      res,
      status >= 400 && status < 600 ? status : 500,
      status === 413 ? "INVALID" : "INVALID",
      status === 413 ? "That was too large." : "Something went wrong.",
    );
  });

  return {
    vite,
    async close() {
      await vite?.close();
    },
  };
}
