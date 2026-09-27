import { type AuthContext, type Client, Room, ServerError } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { GloamError, type KnockCard, LobbyDecide, MESSAGE_RATES } from "@gloam/shared/protocol";
import { Knock, LobbyState, type LobbyStateT } from "@gloam/shared/state";
import { buildHandlers, type ClientAuth, def, isSameOrigin, parseCookies } from "./dispatch.ts";
import { CLOSE, type LobbyRoomApi } from "./registry.ts";
import { roomCtx } from "./roomContext.ts";

/**
 * The waiting room (SPEC §8.2, §13.1). Pending players see only their own knock (per-client StateView,
 * AC-AUTH-06) and nothing about the table. The Admin console joins as a "watcher" to see every knock live.
 */
export class LobbyRoom extends Room<{ state: LobbyStateT }> implements LobbyRoomApi {
  private readonly bySession = new Map<string, Set<Client>>();
  private readonly watchers = new Set<Client>();
  private readonly leaveTimers = new Map<string, NodeJS.Timeout>();

  static override async onAuth(
    _token: string | undefined,
    _options: unknown,
    context: AuthContext,
  ): Promise<ClientAuth> {
    const ctx = roomCtx();
    if (!isSameOrigin(context.headers)) throw new ServerError(403, "FORBIDDEN");
    const sid = parseCookies(context.headers.get("cookie")).gloam_sid;
    const v = ctx.sessions.verify(sid);
    if (!v) throw new ServerError(401, "UNAUTHENTICATED");
    if (!ctx.limits.matchmake.take(`lobby:${v.session.id}`)) throw new ServerError(429, "RATE_LIMITED");
    const base = {
      userId: v.user.id,
      authSessionId: v.session.id,
      name: v.user.displayName,
      color: v.user.color,
    };
    if (v.session.kind === "admin") return { ...base, role: "admin", ip: v.session.ip ?? "", watcher: true };
    if (!ctx.table.isOpen || !ctx.table.acceptingKnocks) throw new ServerError(403, "TABLE_CLOSED");
    if (v.user.bannedAt) throw new ServerError(403, "FORBIDDEN");
    if (v.session.tableSessionNo !== ctx.table.sessionNo) throw new ServerError(403, "UNAUTHENTICATED");
    if (v.session.status === "denied") throw new ServerError(403, "FORBIDDEN");
    const campaignId = ctx.table.campaignId;
    const role = campaignId ? ctx.campaigns.membership(campaignId, v.user.id) : null;
    // An admitted DM may watch knocks too (they can admit when "DMs can admit" is on).
    if (v.session.status === "admitted" && role === "dm") {
      return { ...base, role: "dm", ip: v.session.ip ?? "", watcher: true };
    }
    return { ...base, role: "player", ip: v.session.ip ?? "" };
  }

  override messages = buildHandlers(
    {
      "lobby.decide": def(LobbyDecide, MESSAGE_RATES["lobby.decide"], ({ auth }, p) => {
        if (!auth.watcher) throw new GloamError("FORBIDDEN");
        roomCtx().people.decide({ userId: auth.userId, role: auth.role, ip: auth.ip }, p);
      }),
    },
    roomCtx().log,
  );

  override onCreate(): void {
    this.roomId = "lobby";
    this.autoDispose = false;
    this.setState(new LobbyState());
    roomCtx().rooms.lobby = this;
  }

  override onJoin(client: Client): void {
    const ctx = roomCtx();
    const auth = client.auth as ClientAuth;
    client.view = new StateView();
    if (auth.watcher) {
      this.watchers.add(client);
      for (const k of this.state.knocks.values()) client.view.add(k);
      client.send("table.status", ctx.table.dto());
      return;
    }
    const sid = auth.authSessionId;
    const set = this.bySession.get(sid) ?? new Set<Client>();
    set.add(client);
    this.bySession.set(sid, set);
    const timer = this.leaveTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      this.leaveTimers.delete(sid);
    }
    const session = ctx.sessions.get(sid);
    if (!session) return;
    if (session.status === "admitted") {
      client.send("admitted", { campaignId: ctx.table.campaignId, as: session.admittedAs ?? "player" });
      return;
    }
    const existing = this.state.knocks.get(sid);
    if (existing && existing.status === "pending") {
      client.view.add(existing);
      return;
    }
    const res = ctx.people.knock(session, session.ip ?? "");
    const knock = this.state.knocks.get(sid);
    if (knock) client.view.add(knock);
    if (res.status === "admitted") {
      client.send("admitted", { campaignId: ctx.table.campaignId, as: "player" });
    }
  }

  override async onDrop(client: Client): Promise<void> {
    try {
      await this.allowReconnection(client, 60);
    } catch {
      // window expired → onLeave follows
    }
  }

  override onReconnect(client: Client): void {
    const ctx = roomCtx();
    const auth = client.auth as ClientAuth;
    const s = ctx.sessions.get(auth.authSessionId);
    if (!s || s.revokedAt !== null || s.status === "denied") client.leave(CLOSE.revoked);
  }

  override onLeave(client: Client): void {
    const auth = client.auth as ClientAuth | undefined;
    client.view?.dispose();
    this.watchers.delete(client);
    if (!auth || auth.watcher) return;
    const set = this.bySession.get(auth.authSessionId);
    set?.delete(client);
    if (set && set.size === 0) {
      this.bySession.delete(auth.authSessionId);
      // The person closed the waiting room: withdraw the knock after a grace period.
      const sid = auth.authSessionId;
      this.leaveTimers.set(
        sid,
        setTimeout(() => {
          this.leaveTimers.delete(sid);
          const k = this.state.knocks.get(sid);
          if (k && k.status === "pending") {
            this.removeKnock(sid);
            this.broadcastToWatchers("knock.resolved", { sessionId: sid, decision: "left" });
            roomCtx()
              .rooms.table(roomCtx().table.campaignId)
              ?.toDms("knock.resolved", { sessionId: sid, decision: "left" });
            roomCtx().table.changed();
          }
        }, 15_000).unref(),
      );
    }
  }

  override onDispose(): void {
    const ctx = roomCtx();
    if (ctx.rooms.lobby === this) ctx.rooms.lobby = null;
  }

  // ── LobbyRoomApi ──────────────────────────────────────────────────────────────────────────────────────

  upsertKnock(card: KnockCard & { status: string }): void {
    let k = this.state.knocks.get(card.sessionId);
    if (!k) {
      k = new Knock();
      k.sessionId = card.sessionId;
      this.state.knocks.set(card.sessionId, k);
      for (const w of this.watchers) w.view?.add(k);
      for (const c of this.bySession.get(card.sessionId) ?? []) c.view?.add(k);
    }
    k.userId = card.userId;
    k.name = card.name;
    k.color = card.color;
    k.status = card.status;
    k.identity = card.identity;
    k.deviceLabel = card.deviceLabel;
    k.knockedAt = card.knockedAt;
    roomCtx().table.changed();
  }

  setKnockStatus(sessionId: string, status: string): void {
    const k = this.state.knocks.get(sessionId);
    if (k) k.status = status;
  }

  removeKnock(sessionId: string): void {
    const k = this.state.knocks.get(sessionId);
    if (!k) return;
    for (const c of this.clients) if (c.view?.has(k)) c.view.remove(k);
    this.state.knocks.delete(sessionId);
    roomCtx().table.changed();
  }

  notifySession(sessionId: string, type: string, payload: unknown, close?: number): void {
    for (const c of this.bySession.get(sessionId) ?? []) {
      c.send(type, payload);
      if (close !== undefined) setTimeout(() => c.leave(close), 50);
    }
  }

  broadcastToWatchers(type: string, payload: unknown): void {
    for (const w of this.watchers) w.send(type, payload);
  }

  closeAllPending(code: number, type: string, payload: unknown): void {
    for (const [sid, set] of this.bySession) {
      for (const c of set) {
        c.send(type, payload);
        setTimeout(() => c.leave(code), 50);
      }
      this.removeKnock(sid);
    }
  }

  pendingKnocks(): KnockCard[] {
    const out: KnockCard[] = [];
    for (const k of this.state.knocks.values()) {
      if (k.status !== "pending") continue;
      out.push({
        sessionId: k.sessionId,
        userId: k.userId,
        name: k.name,
        color: k.color,
        identity: k.identity as KnockCard["identity"],
        deviceLabel: k.deviceLabel,
        knockedAt: k.knockedAt,
      });
    }
    return out.sort((a, b) => a.knockedAt - b.knockedAt);
  }

  counts(): { pending: number } {
    return { pending: this.pendingKnocks().length };
  }
}
