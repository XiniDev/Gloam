import { createServer, type Server as HttpServer } from "node:http";
import { defineRoom, defineServer, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { APP_NAME, APP_VERSION, LIMITS } from "@gloam/shared";
import type express from "express";
import { AdminAuth } from "./auth/admin.ts";
import { SecretBox } from "./auth/crypto.ts";
import { InviteService } from "./auth/invites.ts";
import { ProfileService } from "./auth/profiles.ts";
import { AttemptLimiter, BucketMap } from "./auth/rateLimit.ts";
import { SessionService } from "./auth/sessions.ts";
import { type Config, loadConfig } from "./config.ts";
import type { HttpControl, ServerContext } from "./context.ts";
import { dataPaths, ensureDataDir } from "./dataDir.ts";
import { openDatabase } from "./db/client.ts";
import { buildHttpApp, type HttpAppHandle } from "./http/app.ts";
import { selectCampaign } from "./http/routes/admin.ts";
import { createLogger } from "./logger.ts";
import { BackupService } from "./persistence/backups.ts";
import { SnapshotService } from "./persistence/snapshots.ts";
import { isSameOrigin } from "./rooms/dispatch.ts";
import { ensureLobbyRoom, ensureTableRoom } from "./rooms/lifecycle.ts";
import { LobbyRoom } from "./rooms/LobbyRoom.ts";
import { RoomRegistry } from "./rooms/registry.ts";
import { setRoomContext } from "./rooms/roomContext.ts";
import { TableRoom } from "./rooms/TableRoom.ts";
import { CampaignService } from "./services/campaigns.ts";
import { PeopleService } from "./services/people.ts";
import { SecurityLog } from "./services/securityLog.ts";
import { SettingsService } from "./services/settings.ts";
import { TableService } from "./services/table.ts";
import { TunnelManager } from "./tunnel/manager.ts";

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  config?: Partial<Config>;
  /** Called after first-run setup (the demo campaign generator hooks in here). */
  onSetupComplete?: (ctx: ServerContext, opts: { createDemo: boolean }) => Promise<void> | void;
}

export interface GloamServer {
  ctx: ServerContext;
  url: string;
  port: number;
  /** Credential printed in the banner: the setup link on first run, otherwise a magic admin link. */
  bootstrapLink: string;
  closeTable(): Promise<void>;
  /** SIGINT/SIGTERM/crash path (SPEC §11 `shutdown()`), without `process.exit` (callers exit). */
  shutdown(reason?: string): Promise<void>;
}

function makeHttpControl(server: HttpServer, initialHost: string, port: () => number): HttpControl {
  let host = initialHost;
  return {
    server,
    address() {
      const a = server.address();
      const p = typeof a === "object" && a ? a.port : port();
      return { host, port: p };
    },
    async rebind(nextHost: string) {
      if (nextHost === host) return;
      const p = this.address().port;
      // close() stops accepting new connections; established ones (players' sockets) stay open.
      await new Promise<void>((resolve, reject) => {
        server.close();
        server.once("error", reject);
        server.listen(p, nextHost, () => {
          server.off("error", reject);
          resolve();
        });
      });
      host = nextHost;
    },
  };
}

export async function startServer(opts: StartOptions = {}): Promise<GloamServer> {
  const startedAt = Date.now();
  // 1. Load and validate config → ensure data directory → secret.key
  const config = loadConfig(opts.env ?? process.env, opts.config);
  const paths = dataPaths(config.dataDir);
  ensureDataDir(paths);
  const log = await createLogger({
    level: config.logLevel,
    logDir: paths.logs,
    console: config.consoleLog,
    pretty: config.nodeEnv === "development",
  });
  const secret = SecretBox.loadOrCreate(paths.secretKey);
  // 2. Open SQLite (pragmas), back up if migrations are pending, migrate.
  const { sqlite, db } = await openDatabase(paths.db, paths.backups, log);

  const settings = new SettingsService(db, secret);
  const security = new SecurityLog(db, log);
  const campaigns = new CampaignService(db);
  const invites = new InviteService(db);

  // 3. Crash hygiene: revoke invite codes left active, close table sessions left open by a crash.
  const revoked = invites.revokeAll();
  const dangling = campaigns.closeDanglingTableSessions();
  if (revoked || dangling)
    log.warn({ revoked, dangling }, "crash hygiene: previous run did not close the table");

  const httpServer = createServer();
  const cfPath = settings.get().cloudflaredPath;
  const cloudflared = cfPath ? { file: cfPath, args: [] } : config.cloudflared;
  const ctxPartial = {
    config,
    paths,
    log,
    sqlite,
    db,
    secret,
    settings,
    security,
    campaigns,
    invites,
    admin: new AdminAuth(db),
    sessions: new SessionService(db),
    profiles: new ProfileService(db),
    snapshots: new SnapshotService(sqlite, db, paths.snapshots, log),
    backups: new BackupService(sqlite, paths.backups, log),
    rooms: new RoomRegistry(),
    startedAt,
    limits: {
      joinCode: new AttemptLimiter({ max: 10, windowMs: 10 * 60_000, lockMs: 10 * 60_000 }),
      adminLogin: new AttemptLimiter({ max: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000, backoff: true }),
      rest: new BucketMap(60, 6),
      uploads: new BucketMap(10, 10 / 60),
      matchmake: new BucketMap(10, 1),
    },
    http: makeHttpControl(httpServer, config.host, () => config.port),
  } satisfies Partial<ServerContext>;
  const ctx = ctxPartial as ServerContext;
  ctx.tunnel = new TunnelManager({
    command: cloudflared,
    localPort: () => ctx.http.address().port,
    preferredMetricsPort: config.metricsPort,
    log: log.child({ mod: "tunnel" }),
    namedToken: () => settings.tunnelToken(),
    namedHostname: () => settings.get().publicHostname ?? config.publicUrl ?? null,
    ...config.tunnel,
  });
  ctx.table = new TableService(ctx);
  ctx.people = new PeopleService(ctx);
  setRoomContext(ctx);

  // 4. Express + Colyseus on one origin. CORS reflection off and matchmaking restricted BEFORE listen().
  matchMaker.controller.DEFAULT_CORS_HEADERS = {} as never;
  matchMaker.controller.getCorsHeaders = () => ({});
  matchMaker.controller.exposedMethods = ["joinById", "reconnect"];
  let httpApp: HttpAppHandle | null = null;
  const transport = new WebSocketTransport({
    server: httpServer,
    maxPayload: LIMITS.wsMaxPayload,
    beforeUpgrade: (_req, context) =>
      isSameOrigin(context.headers) ? undefined : new Response(null, { status: 403 }),
  });
  const server = defineServer({
    transport,
    rooms: { lobby: defineRoom(LobbyRoom), table: defineRoom(TableRoom) },
    greet: false,
    gracefullyShutdown: false,
    logger: log.child({ mod: "colyseus" }),
    express: async (app: express.Application) => {
      httpApp = await buildHttpApp(app as express.Express, ctx, {
        onSetupComplete: (o) => opts.onSetupComplete?.(ctx, o),
      });
    },
  });
  await server.listen(config.port, config.host);
  const port = ctx.http.address().port;

  // 5. Rooms: the lobby (always) and the table for the selected campaign.
  await ensureLobbyRoom();
  const selected = settings.get().selectedCampaignId;
  if (selected && campaigns.get(selected)) {
    ctx.table.campaignId = selected;
    await ensureTableRoom(ctx, selected);
  } else if (selected) {
    settings.update({ selectedCampaignId: null });
  }

  // 6. Schedulers: autosnapshots every 10 min while open, daily backup after 04:00, limiter sweeps.
  let lastAutoSnapshot = Date.now();
  const tick = setInterval(async () => {
    try {
      const now = Date.now();
      if (ctx.table.isOpen && ctx.table.campaignId && now - lastAutoSnapshot >= config.autoSnapshotMs) {
        lastAutoSnapshot = now;
        ctx.snapshots.write(ctx.table.campaignId, "auto");
      }
      const day = await ctx.backups.maybeDaily(settings.get().lastBackupDay);
      if (day) settings.update({ lastBackupDay: day });
      ctx.limits.joinCode.sweep();
      ctx.limits.adminLogin.sweep();
      ctx.limits.rest.sweep(60_000);
      ctx.limits.uploads.sweep(10 * 60_000);
      ctx.limits.matchmake.sweep(60_000);
      ctx.profiles.pinLimiter.sweep();
    } catch (err) {
      log.error({ err }, "scheduler tick failed");
    }
  }, Math.min(30_000, Math.max(250, Math.floor(config.autoSnapshotMs / 4))));
  tick.unref();

  // 7. Banner (SPEC §8.1): one-time setup link on first run, otherwise a one-time admin link.
  const url = `http://localhost:${port}`;
  const bootstrapLink = ctx.admin.hasPassword()
    ? `${url}/admin/magic?token=${ctx.admin.issueMagicToken()}`
    : `${url}/setup?token=${ctx.admin.issueSetupToken()}`;
  if (config.printBanner) {
    const lines = [
      "",
      `  ✦ ${APP_NAME} ${APP_VERSION}`,
      `  Data directory   ${paths.root}`,
      `  Local address    ${url}`,
      "  Table status     CLOSED",
      ctx.admin.hasPassword()
        ? `  Admin link       ${bootstrapLink}   (one-time, 10 minutes, this PC only)`
        : `  First-run setup  ${bootstrapLink}   (one-time, 30 minutes, this PC only)`,
      "",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  log.info({ port, dataDir: paths.root }, "server started");

  let closedDown = false;
  return {
    ctx,
    url,
    port,
    bootstrapLink,
    async closeTable() {
      await ctx.table.close();
    },
    /** shutdown() (SPEC §11): close the table if open → stop commands → shutdown snapshot → stop processes → close DB. */
    async shutdown(reason = "shutdown") {
      if (closedDown) return;
      closedDown = true;
      clearInterval(tick);
      log.info({ reason }, "shutting down");
      try {
        if (ctx.table.isOpen) await ctx.table.close({ reason: "shutdown" });
      } catch (err) {
        log.error({ err }, "closeTable during shutdown failed");
      }
      for (const room of ctx.rooms.tables.values()) room.flushFog();
      const campaignId = ctx.table.campaignId ?? settings.get().selectedCampaignId;
      if (campaignId && campaigns.get(campaignId)) {
        try {
          ctx.snapshots.write(campaignId, "shutdown");
        } catch (err) {
          log.error({ err }, "shutdown snapshot failed");
        }
      }
      await ctx.tunnel.stop().catch(() => {});
      try {
        await server.gracefullyShutdown(false);
      } catch (err) {
        log.warn({ err }, "colyseus shutdown");
      }
      await (httpApp as HttpAppHandle | null)?.close();
      if (httpServer.listening) await new Promise<void>((r) => httpServer.close(() => r()));
      httpServer.closeAllConnections?.();
      sqlite.close();
      setRoomContext(null);
      log.info("shutdown complete");
      await new Promise<void>((r) => log.flush(() => r()));
    },
  };
}

export { selectCampaign };
