import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import { APP_NAME } from "@gloam/shared";
import { type DoorwayMode, GloamError, type TableStatus } from "@gloam/shared/protocol";
import type { ServerContext } from "../context.ts";
import { CLOSE } from "../rooms/registry.ts";
import type { TunnelState } from "../tunnel/manager.ts";

export interface InviteInfo {
  id: string;
  code: string;
  display: string;
  expiresAt: number | null;
  maxUses: number | null;
}

export interface CloudflaredInfo {
  installed: boolean;
  version: string | null;
  os: NodeJS.Platform;
  configYaml: boolean;
  checkedAt: number;
}

export interface TableStatusDto {
  status: TableStatus;
  mode: DoorwayMode | null;
  publicUrl: string | null;
  lanActive: boolean;
  invite: (Omit<InviteInfo, "id"> & { uses: number }) | null;
  locked: boolean;
  sessionNo: number | null;
  campaignId: string | null;
  campaignName: string | null;
  counts: { lobby: number; admitted: number; spectators: number };
  doorway: TunnelState;
  cloudflared: CloudflaredInfo | null;
  error: string | null;
  discordMessage: string | null;
  port: number;
}

const EXPIRY_MS: Record<"close" | "2h" | "4h" | "8h", number | null> = {
  close: null,
  "2h": 2 * 3600_000,
  "4h": 4 * 3600_000,
  "8h": 8 * 3600_000,
};

/** First private IPv4 on this machine, for LAN mode's `http://<LAN-IP>:4747`. */
export function lanAddress(): string | null {
  const candidates: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) candidates.push(a.address);
  }
  const priv = candidates.find((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return priv ?? candidates[0] ?? null;
}

/**
 * The table lifecycle and the doorway (SPEC §8.1, §11): open in quick/named/LAN/local mode, close with the
 * exact `closeTable()` sequence, invite codes, lock, and status for the Admin console.
 */
export class TableService extends EventEmitter {
  private readonly ctx: ServerContext;
  status: TableStatus = "closed";
  mode: DoorwayMode | null = null;
  publicUrl: string | null = null;
  invite: InviteInfo | null = null;
  locked = false;
  acceptingKnocks = false;
  campaignId: string | null = null;
  sessionNo: number | null = null;
  tableSessionId: string | null = null;
  error: string | null = null;
  cloudflared: CloudflaredInfo | null = null;
  private busy: Promise<unknown> | null = null;

  constructor(ctx: ServerContext) {
    super();
    this.ctx = ctx;
    ctx.tunnel.on("state", (s: TunnelState) => {
      if (this.status === "open" || this.status === "reconnecting") {
        if (s.status === "reconnecting") this.status = "reconnecting";
        else if (s.status === "up") {
          this.status = "open";
          if (s.publicUrl) this.publicUrl = s.publicUrl;
        } else if (s.status === "failed") this.error = s.error;
      }
      this.changed();
    });
  }

  get isOpen(): boolean {
    return this.status === "open" || this.status === "reconnecting";
  }

  changed(): void {
    this.emit("status", this.dto());
  }

  async checkCloudflared(): Promise<CloudflaredInfo> {
    const r = await this.ctx.tunnel.checkInstalled();
    this.cloudflared = {
      installed: r.installed,
      version: r.version,
      os: process.platform,
      configYaml: this.ctx.tunnel.configYamlPresent(),
      checkedAt: Date.now(),
    };
    if (r.installed && !this.ctx.settings.get().checklist.cloudflaredSeen) {
      this.ctx.settings.update({
        checklist: { ...this.ctx.settings.get().checklist, cloudflaredSeen: true },
      });
    }
    this.changed();
    return this.cloudflared;
  }

  private newInvite(): InviteInfo {
    const s = this.ctx.settings.get();
    const ttl = EXPIRY_MS[s.inviteExpiry];
    const created = this.ctx.invites.create({
      expiresAt: ttl === null ? null : Date.now() + ttl,
      maxUses: s.inviteMaxUses,
    });
    return {
      id: created.row.id,
      code: created.code,
      display: created.display,
      expiresAt: created.row.expiresAt,
      maxUses: created.row.maxUses,
    };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new GloamError("CONFLICT", "The table is already opening or closing.");
    const p = fn().finally(() => {
      this.busy = null;
    });
    this.busy = p;
    return p;
  }

  /** Opens the table (SPEC §8.1 "Open table"). */
  open(
    mode: DoorwayMode,
    opts: { confirmLan?: boolean; ip?: string; userId?: string } = {},
  ): Promise<TableStatusDto> {
    return this.exclusive(async () => {
      if (this.isOpen) throw new GloamError("CONFLICT", "The table is already open.");
      const campaignId = this.ctx.settings.get().selectedCampaignId;
      const campaign = campaignId ? this.ctx.campaigns.get(campaignId) : undefined;
      if (!campaign || campaign.archivedAt) {
        throw new GloamError("INVALID", "Choose or create a campaign before opening the table.");
      }
      if (mode === "lan" && !opts.confirmLan) {
        throw new GloamError(
          "INVALID",
          "LAN mode needs confirmation: anyone on your network can reach the join page.",
        );
      }
      if (mode === "quick" || mode === "named") {
        const cf = await this.checkCloudflared();
        if (!cf.installed)
          throw new GloamError("INVALID", "cloudflared isn't installed — see the install card.");
        if (mode === "quick" && cf.configYaml) {
          throw new GloamError(
            "INVALID",
            "Quick tunnels won't start while ~/.cloudflared/config.yaml exists. Rename that file or use a named tunnel.",
          );
        }
      }
      this.status = "opening";
      this.mode = mode;
      this.error = null;
      this.campaignId = campaign.id;
      this.changed();
      // Generate a fresh invite code first (SPEC §8.1).
      this.ctx.invites.revokeAll();
      this.invite = this.newInvite();
      this.ctx.security.record("invite.create", { userId: opts.userId, ip: opts.ip });
      try {
        const port = this.ctx.http.address().port;
        if (mode === "quick" || mode === "named") {
          this.ctx.settings.update({ tunnelMode: mode });
          this.publicUrl = await this.ctx.tunnel.start(mode);
        } else if (mode === "lan") {
          await this.ctx.http.rebind("0.0.0.0");
          const ip = lanAddress();
          this.publicUrl = `http://${ip ?? "your-pc-ip"}:${port}`;
          this.ctx.settings.update({ tunnelMode: "lan", lanConfirmed: true });
        } else {
          this.publicUrl = `http://localhost:${port}`;
          this.ctx.settings.update({ tunnelMode: "local" });
        }
      } catch (err) {
        this.ctx.invites.revokeAll();
        this.invite = null;
        this.status = "closed";
        this.mode = null;
        this.publicUrl = null;
        this.error = err instanceof Error ? err.message : String(err);
        this.changed();
        throw new GloamError("INVALID", this.error);
      }
      const ts = this.ctx.campaigns.beginTableSession(campaign.id, mode);
      // The table room's copy of the campaign learns its new session number (it was written outside the room).
      const room = this.ctx.rooms.tables.get(campaign.id);
      if (room) room.model.campaign = { ...room.model.campaign, sessionNo: ts.sessionNo };
      this.tableSessionId = ts.id;
      this.sessionNo = ts.sessionNo;
      this.locked = false;
      this.acceptingKnocks = true;
      this.status = "open";
      const checklist = this.ctx.settings.get().checklist;
      if (!checklist.tableOpened)
        this.ctx.settings.update({ checklist: { ...checklist, tableOpened: true } });
      this.ctx.security.record("table.open", {
        userId: opts.userId,
        ip: opts.ip,
        detail: { mode, sessionNo: ts.sessionNo },
      });
      this.ctx.log.info({ mode, url: this.publicUrl, sessionNo: ts.sessionNo }, "table open");
      this.changed();
      return this.dto();
    });
  }

  /**
   * closeTable() (SPEC §11): stop accepting knocks → revoke all invite codes → broadcast table.closing →
   * disconnect non-admin clients → flush explored fog → write a `close` snapshot → stop cloudflared → end the
   * session in the log.
   */
  close(
    opts: { reason?: "closed" | "shutdown"; ip?: string; userId?: string } = {},
  ): Promise<TableStatusDto> {
    return this.exclusive(async () => {
      if (!this.isOpen && this.status !== "opening") return this.dto();
      this.status = "closing";
      this.changed();
      this.acceptingKnocks = false;
      this.ctx.invites.revokeAll();
      this.invite = null;
      const payload = { message: "The table is closed — thanks for playing" };
      const lobby = this.ctx.rooms.lobby;
      const table = this.ctx.rooms.table(this.campaignId);
      table?.broadcastAll("table.closing", payload);
      lobby?.broadcastToWatchers("table.closing", payload);
      lobby?.closeAllPending(CLOSE.tableClosed, "table.closing", payload);
      table?.disconnectNonAdmins("table.closing", payload, CLOSE.tableClosed);
      table?.flushFog();
      if (this.campaignId) {
        try {
          this.ctx.snapshots.write(this.campaignId, "close");
        } catch (err) {
          this.ctx.log.error({ err }, "close snapshot failed");
        }
      }
      if (this.mode === "quick" || this.mode === "named") await this.ctx.tunnel.stop();
      if (this.mode === "lan") await this.ctx.http.rebind(this.ctx.config.host);
      if (this.tableSessionId) {
        this.ctx.campaigns.endTableSession(
          this.tableSessionId,
          opts.reason === "shutdown" ? "shutdown" : "closed",
        );
      }
      this.ctx.security.record("table.close", {
        userId: opts.userId,
        ip: opts.ip,
        detail: { sessionNo: this.sessionNo },
      });
      this.status = "closed";
      this.mode = null;
      this.publicUrl = null;
      this.tableSessionId = null;
      this.locked = false;
      this.changed();
      return this.dto();
    });
  }

  rotateInvite(opts: { ip?: string; userId?: string } = {}): TableStatusDto {
    if (!this.isOpen) throw new GloamError("TABLE_CLOSED");
    this.ctx.invites.revokeAll();
    this.invite = this.newInvite();
    this.ctx.security.record("invite.rotate", { userId: opts.userId, ip: opts.ip });
    this.changed();
    return this.dto();
  }

  revokeInvite(opts: { ip?: string; userId?: string } = {}): TableStatusDto {
    this.ctx.invites.revokeAll();
    this.invite = null;
    this.ctx.security.record("invite.revoke", { userId: opts.userId, ip: opts.ip });
    this.changed();
    return this.dto();
  }

  setLock(locked: boolean, opts: { ip?: string; userId?: string } = {}): TableStatusDto {
    this.locked = locked;
    this.ctx.security.record("invite.lock", { userId: opts.userId, ip: opts.ip, detail: { locked } });
    this.changed();
    return this.dto();
  }

  /** Changes expiry / max uses for new codes and applies them to the current code. */
  setInvitePolicy(p: { expiry?: "close" | "2h" | "4h" | "8h"; maxUses?: number | null }): TableStatusDto {
    const patch: { inviteExpiry?: "close" | "2h" | "4h" | "8h"; inviteMaxUses?: number | null } = {};
    if (p.expiry !== undefined) patch.inviteExpiry = p.expiry;
    if (p.maxUses !== undefined) patch.inviteMaxUses = p.maxUses;
    this.ctx.settings.update(patch);
    if (this.invite) {
      const ttl = p.expiry !== undefined ? EXPIRY_MS[p.expiry] : undefined;
      const upd: { expiresAt?: number | null; maxUses?: number | null } = {};
      if (ttl !== undefined) upd.expiresAt = ttl === null ? null : Date.now() + ttl;
      if (p.maxUses !== undefined) upd.maxUses = p.maxUses;
      if (Object.keys(upd).length) {
        this.ctx.invites.update(this.invite.id, upd);
        this.invite = { ...this.invite, ...upd };
      }
    }
    this.changed();
    return this.dto();
  }

  /** "🎲 The table is open! Join: <url> — code <code> (works until the table closes)" (AC-HOST-05). */
  discordMessage(): string | null {
    if (!this.isOpen || !this.publicUrl || !this.invite) return null;
    const exp = this.invite.expiresAt;
    let validity = "works until the table closes";
    if (exp !== null) {
      const hours = Math.max(1, Math.round((exp - Date.now()) / 3600_000));
      validity = `works for about ${hours} hour${hours === 1 ? "" : "s"}`;
    }
    if (this.invite.maxUses !== null)
      validity += `, ${this.invite.maxUses} use${this.invite.maxUses === 1 ? "" : "s"}`;
    return `🎲 The table is open! Join: ${this.publicUrl} — code ${this.invite.display} (${validity})`;
  }

  dto(): TableStatusDto {
    const lobby = this.ctx.rooms.lobby?.counts() ?? { pending: 0 };
    const table = this.ctx.rooms.table(this.campaignId)?.counts() ?? { admitted: 0, spectators: 0 };
    const campaign = this.campaignId ? this.ctx.campaigns.get(this.campaignId) : undefined;
    const uses = this.invite
      ? (this.ctx.invites.active().find((r) => r.id === this.invite?.id)?.uses ?? 0)
      : 0;
    return {
      status: this.status,
      mode: this.mode,
      publicUrl: this.publicUrl,
      lanActive: this.mode === "lan" && this.isOpen,
      invite: this.invite
        ? {
            code: this.invite.code,
            display: this.invite.display,
            expiresAt: this.invite.expiresAt,
            maxUses: this.invite.maxUses,
            uses,
          }
        : null,
      locked: this.locked,
      sessionNo: this.sessionNo,
      campaignId: this.campaignId ?? this.ctx.settings.get().selectedCampaignId,
      campaignName: campaign?.name ?? null,
      counts: { lobby: lobby.pending, admitted: table.admitted, spectators: table.spectators },
      doorway: this.ctx.tunnel.state,
      cloudflared: this.cloudflared,
      error: this.error,
      discordMessage: this.discordMessage(),
      port: this.ctx.http.address().port,
    };
  }

  appName(): string {
    return APP_NAME;
  }
}
