import type { Server as HttpServer } from "node:http";
import type { AssetService } from "./assets/service.ts";
import type { AdminAuth } from "./auth/admin.ts";
import type { SecretBox } from "./auth/crypto.ts";
import type { InviteService } from "./auth/invites.ts";
import type { ProfileService } from "./auth/profiles.ts";
import type { AttemptLimiter, BucketMap } from "./auth/rateLimit.ts";
import type { SessionService } from "./auth/sessions.ts";
import type { Config } from "./config.ts";
import type { ContentPack } from "./content/packs.ts";
import type { DataPaths } from "./dataDir.ts";
import type { Db, Sqlite } from "./db/client.ts";
import type { Logger } from "./logger.ts";
import type { BackupService } from "./persistence/backups.ts";
import type { SnapshotService } from "./persistence/snapshots.ts";
import type { RoomRegistry } from "./rooms/registry.ts";
import type { ApiTokenService } from "./services/apiTokens.ts";
import type { CampaignService } from "./services/campaigns.ts";
import type { PeopleService } from "./services/people.ts";
import type { SecurityLog } from "./services/securityLog.ts";
import type { SettingsService } from "./services/settings.ts";
import type { TableService } from "./services/table.ts";
import type { TunnelManager } from "./tunnel/manager.ts";

export interface Limits {
  /** 10 wrong invite codes per IP per 10 min → 429 for 10 min (AC-AUTH-01). */
  joinCode: AttemptLimiter;
  /** Admin login per IP: 5 per 15 min, then exponential backoff (§22.5). */
  adminLogin: AttemptLimiter;
  /** REST per session (or IP when anonymous): 60 per 10 s (§22.5). */
  rest: BucketMap;
  /** Uploads per user: 10 per minute (§22.5). */
  uploads: BucketMap;
  /** Matchmaking joins per session/IP (Colyseus routes bypass Express, R3 deviation 2). */
  matchmake: BucketMap;
}

/** Everything a request handler, room or scheduler needs. Built once in server.ts. */
export interface ServerContext {
  config: Config;
  paths: DataPaths;
  log: Logger;
  sqlite: Sqlite;
  db: Db;
  secret: SecretBox;
  settings: SettingsService;
  security: SecurityLog;
  admin: AdminAuth;
  sessions: SessionService;
  invites: InviteService;
  profiles: ProfileService;
  campaigns: CampaignService;
  snapshots: SnapshotService;
  backups: BackupService;
  tunnel: TunnelManager;
  table: TableService;
  people: PeopleService;
  /** API tokens for the local REST API and the MCP server (SPEC §8.23). */
  apiTokens: ApiTokenService;
  /** Uploads, the processor child process, serving and purges (SPEC §21). */
  assets: AssetService;
  rooms: RoomRegistry;
  limits: Limits;
  http: HttpControl;
  /** SRD 5.2.1 pack, loaded and count-checked at startup. */
  content: ContentPack;
  startedAt: number;
}

export interface HttpControl {
  server: HttpServer;
  /** The address the server is bound to right now. */
  address(): { host: string; port: number };
  /** Re-binds the listener (LAN mode ↔ loopback) without dropping established connections. */
  rebind(host: string): Promise<void>;
}
