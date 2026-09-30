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
    if (session?.kind !== "player") throw new GloamError("NOT_FOUND", "That knock is gone.");
    // A DM decides knocks: a pending one, never a DM's own session — only the Admin removes a DM (security review L1;
    // the session ids are on the knock cards every DM holds).
    if (actor.role !== "admin") {
      if (session.status !== "pending") throw new GloamError("NOT_FOUND", "That knock is gone.");
      const campaignId = this.ctx.table.campaignId;
      if (campaignId && this.ctx.campaigns.membership(campaignId, session.userId) === "dm")
        throw new GloamError("FORBIDDEN", "Only the Admin can turn a DM away.");
    }
    if (d.decision === "admitPlayer") this.admit(session.id, "player", actor);
    else if (d.decision === "admitSpectator") this.admit(session.id, "spectator", actor);
    else if (d.decision === "deny") this.deny(session.id, actor);
    else if (session.identityKind === "unverified" && session.deviceId) {
      // An unverified claim: whoever knocked isn't known to be the profile they named — their browser is banned,
      // not the profile (its owner didn't knock).
      this.ctx.profiles.banDevice(session.deviceId);
      this.ctx.security.record("ban", {
        userId: session.userId,
        ip: actor.ip,
        detail: { by: actor.userId, browser: true, claimed: true },
      });
      this.deny(session.id, actor);
    } else this.ban(session.userId, actor, d.reason ?? null);
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
    // An unverified claim let in: its browser is now this profile's (recognised next time, security review H2).
    if (session.identityKind === "unverified" && session.deviceId)
      this.ctx.profiles.confirmDevice(session.deviceId);
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

  // ── the Admin's people management (SPEC §8.20 People; AC-ADM-02) ──────────────────────────────────────────

  private requireAdmin(actor: Actor): void {
    if (actor.role !== "admin") throw new GloamError("FORBIDDEN");
  }

  private person(userId: string) {
    const user = this.ctx.profiles.get(userId);
    if (!user || user.deletedAt !== null)
      throw new GloamError("NOT_FOUND", "That person isn't here any more.");
    return user;
  }

  /** Renames someone (their name at every table from now on, and on the table they're at now). */
  rename(targetUserId: string, name: string, actor: Actor): void {
    this.requireAdmin(actor);
    const user = this.person(targetUserId);
    this.ctx.profiles.update(user.id, { displayName: name });
    this.ctx.security.record("profile.update", {
      userId: user.id,
      ip: actor.ip,
      detail: { by: actor.userId, field: "name" },
    });
    this.ctx.rooms.table(this.ctx.table.campaignId)?.profileChanged(user.id);
    this.ctx.table.changed();
  }

  /** Sets or clears someone's PIN (a returning player proves who they are with it, SPEC §8.2). */
  async setPin(targetUserId: string, pin: string | null, actor: Actor): Promise<void> {
    this.requireAdmin(actor);
    const user = this.person(targetUserId);
    if (user.isAdmin) throw new GloamError("FORBIDDEN", "The Admin signs in with a password, not a PIN.");
    await this.ctx.profiles.setPin(user.id, pin);
    this.ctx.security.record("profile.update", {
      userId: user.id,
      ip: actor.ip,
      detail: { by: actor.userId, field: pin ? "pin set" : "pin cleared" },
    });
  }

  /**
   * Someone's role in a campaign (assign DM, or back to player; spectator; or none). If they're at that table now, they
   * rejoin with it at once.
   */
  setRole(
    targetUserId: string,
    campaignId: string,
    role: "dm" | "player" | "spectator" | null,
    actor: Actor,
  ): void {
    this.requireAdmin(actor);
    const user = this.person(targetUserId);
    if (user.isAdmin) throw new GloamError("FORBIDDEN", "The Admin is every campaign's DM already.");
    if (!this.ctx.campaigns.get(campaignId)) throw new GloamError("NOT_FOUND", "That campaign isn't here.");
    if (role) this.ctx.campaigns.setMembership(campaignId, user.id, role);
    else this.ctx.campaigns.removeMembership(campaignId, user.id);
    this.ctx.security.record("profile.update", {
      userId: user.id,
      ip: actor.ip,
      detail: { by: actor.userId, field: "role", role: role ?? "none", campaignId },
    });
    if (this.ctx.table.campaignId === campaignId)
      this.ctx.rooms
        .table(campaignId)
        ?.disconnectUser(
          user.id,
          "role.changed",
          { message: role === "dm" ? "You're a DM at this table now." : "Your role at this table changed." },
          CLOSE.roleChanged,
        );
    this.ctx.table.changed();
  }

  /**
   * Deletes a profile (SPEC §8.20: with character reassignment): the characters and tokens they played go to
   * `reassignTo` (made a player where they weren't one) or to no one (the DMs'); their sessions end, their memberships
   * go, the profile is soft-deleted. The table they're at hears it through the bus; other campaigns change on disk.
   */
  deleteProfile(targetUserId: string, reassignTo: string | null, actor: Actor): { reassigned: number } {
    this.requireAdmin(actor);
    const user = this.person(targetUserId);
    if (user.isAdmin) throw new GloamError("FORBIDDEN", "The Admin's profile can't be deleted.");
    if (reassignTo === user.id) throw new GloamError("INVALID", "Give their characters to someone else.");
    if (reassignTo) this.person(reassignTo);
    // Off the table first: whoever it is doesn't stay connected while their things change hands.
    if (this.ctx.table.campaignId)
      this.ctx.rooms
        .table(this.ctx.table.campaignId)
        ?.disconnectUser(user.id, "kicked", { message: "Your profile was removed." }, CLOSE.revoked);
    this.ctx.sessions.revokeAllForUser(user.id);
    let reassigned = 0;
    for (const c of this.ctx.campaigns.list(true)) {
      const owned = this.ctx.campaigns.ownedBy(c.id, user.id);
      if (!owned.actors && !owned.tokens) continue;
      reassigned += owned.actors;
      if (reassignTo && !this.ctx.campaigns.membership(c.id, reassignTo))
        this.ctx.campaigns.setMembership(c.id, reassignTo, "player");
      const room = this.ctx.rooms.table(c.id);
      if (room) room.reassignOwner(user.id, reassignTo, actor.userId);
      else this.ctx.campaigns.reassignOwner(c.id, user.id, reassignTo);
    }
    for (const c of this.ctx.campaigns.list(true)) this.ctx.campaigns.removeMembership(c.id, user.id);
    this.ctx.profiles.softDelete(user.id);
    this.ctx.security.record("profile.delete", {
      userId: user.id,
      ip: actor.ip,
      detail: { by: actor.userId, reassigned, to: reassignTo },
    });
    this.ctx.table.changed();
    return { reassigned };
  }

  unban(targetUserId: string, actor: Actor): void {
    if (actor.role !== "admin") throw new GloamError("FORBIDDEN");
    const user = this.ctx.profiles.get(targetUserId);
    if (!user) throw new GloamError("NOT_FOUND");
    this.ctx.profiles.unban(user.id);
    this.ctx.security.record("unban", { userId: user.id, ip: actor.ip, detail: { by: actor.userId } });
  }
}
