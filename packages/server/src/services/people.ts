import { GloamError, type KnockCard, type LobbyDecide } from "@gloam/shared/protocol";
import type { SessionRow } from "../auth/sessions.ts";
import type { ServerContext } from "../context.ts";
import { CLOSE } from "../rooms/registry.ts";
import type { Role } from "./campaigns.ts";

export interface Actor {
  userId: string;
  role: Role;
  ip?: string;
}

export type IdentityKind = KnockCard["identity"];

/**
 * Lobby knocks, admission decisions, kicks and bans (SPEC §8.2). Called from REST routes, the lobby room and
 * the table room so every path applies the same rules.
 */
export class PeopleService {
  private readonly ctx: ServerContext;
  constructor(ctx: ServerContext) {
    this.ctx = ctx;
  }

  private canAdmit(actor: Actor): boolean {
    return actor.role === "admin" || (actor.role === "dm" && this.ctx.settings.get().dmsCanAdmit);
  }

  card(session: SessionRow): KnockCard | null {
    const user = this.ctx.profiles.get(session.userId);
    if (!user) return null;
    return {
      sessionId: session.id,
      userId: user.id,
      name: user.displayName,
      color: user.color,
      identity: (session.identityKind as IdentityKind | null) ?? "new",
      deviceLabel: session.deviceLabel ?? "Browser",
      knockedAt: session.knockedAt ?? session.createdAt,
    };
  }

  /**
   * A pending player reached the waiting room. Records the knock, auto-admits recognised returning players when
   * the setting is on (still logging the knock, AC-AUTH-09), and notifies the Admin/DMs with a knock card.
   */
  knock(session: SessionRow, ip: string): { status: "pending" | "admitted" } {
    const now = Date.now();
    this.ctx.sessions.update(session.id, { status: "pending", knockedAt: now });
    const card = this.card({ ...session, knockedAt: now });
    if (!card) throw new GloamError("NOT_FOUND");
    const s = this.ctx.settings.get();
    const recognised = card.identity === "pin" || card.identity === "device";
    if (s.autoAdmitReturning && recognised) {
      this.ctx.security.record("knock.autoadmit", {
        userId: card.userId,
        ip,
        detail: { identity: card.identity },
      });
      this.admit(session.id, "player", { userId: "system", role: "admin", ip }, { auto: true });
      return { status: "admitted" };
    }
    this.ctx.security.record("knock", { userId: card.userId, ip, detail: { identity: card.identity } });
    this.ctx.rooms.lobby?.upsertKnock({ ...card, status: "pending" });
    this.ctx.rooms.table(this.ctx.table.campaignId)?.toDms("knock", card);
    this.ctx.rooms.lobby?.broadcastToWatchers("knock", card);
    return { status: "pending" };
  }

  pending(): KnockCard[] {
    return this.ctx.rooms.lobby?.pendingKnocks() ?? [];
  }

  decide(actor: Actor, d: LobbyDecide): void {
    if (d.decision === "ban" ? actor.role !== "admin" : !this.canAdmit(actor))
      throw new GloamError("FORBIDDEN");
    const session = this.ctx.sessions.get(d.sessionId);
    if (!session || session.kind !== "player") throw new GloamError("NOT_FOUND", "That knock is gone.");
    if (d.decision === "admitPlayer") this.admit(session.id, "player", actor);
    else if (d.decision === "admitSpectator") this.admit(session.id, "spectator", actor);
    else if (d.decision === "deny") this.deny(session.id, actor);
    else this.ban(session.userId, actor, d.reason ?? null);
  }

  admit(sessionId: string, as: "player" | "spectator", actor: Actor, opts: { auto?: boolean } = {}): void {
    const session = this.ctx.sessions.get(sessionId);
    if (!session) throw new GloamError("NOT_FOUND");
    const campaignId = this.ctx.table.campaignId;
    if (!campaignId || !this.ctx.table.isOpen) throw new GloamError("TABLE_CLOSED");
    const user = this.ctx.profiles.get(session.userId);
    if (!user || user.bannedAt) throw new GloamError("FORBIDDEN");
    this.ctx.sessions.update(sessionId, {
      status: "admitted",
      admittedAs: as,
      tableSessionNo: this.ctx.table.sessionNo,
    });
    const current = this.ctx.campaigns.membership(campaignId, user.id);
    // Never demote a DM; spectator ↔ player follows the latest admission.
    if (current !== "dm") this.ctx.campaigns.setMembership(campaignId, user.id, as);
    this.ctx.security.record("admit", {
      userId: user.id,
      ip: actor.ip,
      detail: { by: actor.userId, as, auto: opts.auto ?? false },
    });
    this.ctx.rooms.lobby?.setKnockStatus(sessionId, "admitted");
    this.ctx.rooms.lobby?.notifySession(sessionId, "admitted", { campaignId, as });
    this.ctx.rooms.lobby?.broadcastToWatchers("knock.resolved", { sessionId, decision: "admitted" });
    this.ctx.rooms.table(campaignId)?.toDms("knock.resolved", { sessionId, decision: "admitted" });
    setTimeout(() => this.ctx.rooms.lobby?.removeKnock(sessionId), 2000).unref();
    this.ctx.table.changed();
  }

  deny(sessionId: string, actor: Actor): void {
    const session = this.ctx.sessions.get(sessionId);
    if (!session) throw new GloamError("NOT_FOUND");
    this.ctx.sessions.update(sessionId, { status: "denied" });
    this.ctx.security.record("deny", { userId: session.userId, ip: actor.ip, detail: { by: actor.userId } });
    this.ctx.rooms.lobby?.notifySession(
      sessionId,
      "denied",
      { message: "The DM couldn't let you in right now" },
      CLOSE.denied,
    );
    this.ctx.rooms.lobby?.removeKnock(sessionId);
    this.ctx.rooms.lobby?.broadcastToWatchers("knock.resolved", { sessionId, decision: "denied" });
    this.ctx.rooms
      .table(this.ctx.table.campaignId)
      ?.toDms("knock.resolved", { sessionId, decision: "denied" });
    this.ctx.table.changed();
  }

  /** Kick sends the person back to the waiting room; they may knock again (SPEC §8.2). */
  kick(targetUserId: string, actor: Actor): void {
    if (!this.canAdmit(actor)) throw new GloamError("FORBIDDEN");
    const user = this.ctx.profiles.get(targetUserId);
    if (!user) throw new GloamError("NOT_FOUND");
    if (user.isAdmin) throw new GloamError("FORBIDDEN", "The Admin can't be kicked.");
    if (actor.role === "dm" && this.ctx.table.campaignId) {
      if (this.ctx.campaigns.membership(this.ctx.table.campaignId, user.id) === "dm") {
        throw new GloamError("FORBIDDEN", "Only the Admin can kick a DM.");
      }
    }
    for (const s of this.ctx.sessions.liveForUser(user.id)) {
      if (s.kind === "player" && s.status === "admitted")
        this.ctx.sessions.update(s.id, { status: "kicked" });
    }
    this.ctx.security.record("kick", { userId: user.id, ip: actor.ip, detail: { by: actor.userId } });
    this.ctx.rooms
      .table(this.ctx.table.campaignId)
      ?.disconnectUser(
        user.id,
        "kicked",
        { message: "You were returned to the waiting room." },
        CLOSE.kicked,
      );
    this.ctx.table.changed();
  }

  /** Ban blocks the profile and every device associated with it; future knocks are auto-denied. */
  ban(targetUserId: string, actor: Actor, reason: string | null): void {
    if (actor.role !== "admin") throw new GloamError("FORBIDDEN");
    const user = this.ctx.profiles.get(targetUserId);
    if (!user) throw new GloamError("NOT_FOUND");
    if (user.isAdmin) throw new GloamError("FORBIDDEN", "The Admin can't be banned.");
    const live = this.ctx.sessions.liveForUser(user.id);
    this.ctx.profiles.ban(user.id, reason);
    this.ctx.sessions.revokeAllForUser(user.id);
    this.ctx.security.record("ban", { userId: user.id, ip: actor.ip, detail: { by: actor.userId } });
    const msg = { message: "You can't join this table" };
    for (const s of live) {
      this.ctx.rooms.lobby?.notifySession(s.id, "banned", msg, CLOSE.banned);
      this.ctx.rooms.lobby?.removeKnock(s.id);
      this.ctx.rooms.lobby?.broadcastToWatchers("knock.resolved", { sessionId: s.id, decision: "banned" });
      this.ctx.rooms
        .table(this.ctx.table.campaignId)
        ?.toDms("knock.resolved", { sessionId: s.id, decision: "banned" });
    }
    this.ctx.rooms.table(this.ctx.table.campaignId)?.disconnectUser(user.id, "banned", msg, CLOSE.banned);
    this.ctx.table.changed();
  }

  unban(targetUserId: string, actor: Actor): void {
    if (actor.role !== "admin") throw new GloamError("FORBIDDEN");
    const user = this.ctx.profiles.get(targetUserId);
    if (!user) throw new GloamError("NOT_FOUND");
    this.ctx.profiles.unban(user.id);
    this.ctx.security.record("unban", { userId: user.id, ip: actor.ip, detail: { by: actor.userId } });
  }
}
