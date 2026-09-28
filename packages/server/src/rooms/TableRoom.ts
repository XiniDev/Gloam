import { type AuthContext, type Client, Room, ServerError } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import type { P } from "@gloam/shared/geometry";
import {
  AdminBan,
  AdminUnban,
  CameraSpotlight,
  ClockSync,
  DiceManual,
  DiceRoll,
  GloamError,
  HandToggle,
  LobbyDecide,
  MESSAGE_RATES,
  MeasureShare,
  MovePreview,
  PingSend,
  ProfileDiceSkin,
  SceneRef,
  TableKick,
} from "@gloam/shared/protocol";
import { controlsToken } from "@gloam/shared/rules";
import type { TokenEntity } from "@gloam/shared/schemas";
import { type PrepSnapshot, Presence, Sensed, Table, type TableState, V2 } from "@gloam/shared/state";
import { z } from "zod";
import { renderDto } from "../assets/service.ts";
import { LibraryQuery } from "../assets/types.ts";
import { DEFAULT_SKIN, DiceService, type DiceSkin, type RollRecord, viewOfRoll } from "../dice/service.ts";
import { type CommandActor, CommandBus, type CommitInfo, type RoomEvent } from "../engine/commandBus.ts";
import { CampaignModel } from "../engine/model.ts";
import { ALL_COMMANDS, COMMAND_RATES, registerCommands } from "../engine/registry.ts";
import { type MoveSeen, VisionService } from "../vision/visionService.ts";
import {
  buildHandlers,
  type ClientAuth,
  def,
  isSameOrigin,
  type MessageDef,
  parseCookies,
} from "./dispatch.ts";
import {
  glowView,
  lightView,
  type ProjectionCtx,
  prepSnapshot,
  StateProjector,
  tokenView,
} from "./projector.ts";
import { CLOSE, type TableRoomApi } from "./registry.ts";
import { roomCtx } from "./roomContext.ts";
import { type Viewer, ViewManager } from "./views.ts";

export interface TableRoomOptions {
  campaignId: string;
}

/**
 * The game room for one campaign (SPEC §13.1): `roomId = campaignId`, never auto-disposed. All play happens
 * here; every mutation goes through the command bus; per-client StateViews decide what each client receives.
 */
export class TableRoom extends Room<{ state: TableState }> implements TableRoomApi {
  campaignId = "";
  private readonly clientsByUser = new Map<string, Set<Client>>();
  private readonly closing = new WeakSet<Client>();
  model!: CampaignModel;
  bus!: CommandBus;
  projector!: StateProjector;
  views!: ViewManager;
  /** Perception, fog and explored memory of the active scene (SPEC §15.5). */
  vision!: VisionService;
  dice!: DiceService;
  /** DM connections viewing a non-active scene in prep (SPEC §13.7): client → scene id. */
  private readonly prepSubs = new Map<Client, string>();
  /** Test probe (AC-PER-01): runs right before Colyseus encodes and sends a state patch. */
  beforePatchProbe: (() => void) | null = null;

  /**
   * Colyseus 0.18 only calls the STATIC onAuth during matchmaking (an instance-level one is ignored), so the
   * campaign id comes from the matchmaking URL (/matchmake/joinById/<campaignId>). onJoin re-checks it.
   */
  static override async onAuth(
    _token: string | undefined,
    _options: unknown,
    context: AuthContext,
  ): Promise<ClientAuth> {
    const ctx = roomCtx();
    if (!isSameOrigin(context.headers)) throw new ServerError(403, "FORBIDDEN");
    const url = (context.req as { url?: string } | undefined)?.url ?? "";
    const campaignId = /\/matchmake\/joinById\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
    if (!campaignId) throw new ServerError(403, "FORBIDDEN");
    const sid = parseCookies(context.headers.get("cookie")).gloam_sid;
    const v = ctx.sessions.verify(sid);
    if (!v) throw new ServerError(401, "UNAUTHENTICATED");
    if (!ctx.limits.matchmake.take(`table:${v.session.id}`)) throw new ServerError(429, "RATE_LIMITED");
    const base = {
      userId: v.user.id,
      authSessionId: v.session.id,
      name: v.user.displayName,
      color: v.user.color,
      campaignId,
    };
    if (v.session.kind === "admin") return { ...base, role: "admin", ip: v.session.ip ?? "" };
    if (!ctx.table.isOpen || ctx.table.campaignId !== campaignId) throw new ServerError(403, "TABLE_CLOSED");
    if (v.session.status !== "admitted" || v.session.tableSessionNo !== ctx.table.sessionNo) {
      throw new ServerError(403, "FORBIDDEN");
    }
    const role = ctx.campaigns.membership(campaignId, v.user.id);
    if (!role) throw new ServerError(403, "FORBIDDEN");
    return { ...base, role, ip: v.session.ip ?? "" };
  }

  override messages = buildHandlers(
    {
      "lobby.decide": def(LobbyDecide, MESSAGE_RATES["lobby.decide"], ({ auth }, p) => {
        roomCtx().people.decide({ userId: auth.userId, role: auth.role, ip: auth.ip }, p);
      }),
      "lobby.list": def(z.strictObject({}), { capacity: 2, perSecond: 1 }, ({ auth }) => {
        if (auth.role !== "admin" && auth.role !== "dm") throw new GloamError("FORBIDDEN");
        return roomCtx().people.pending();
      }),
      "table.kick": def(TableKick, MESSAGE_RATES["table.kick"], ({ auth }, p) => {
        roomCtx().people.kick(p.userId, { userId: auth.userId, role: auth.role, ip: auth.ip });
      }),
      "admin.ban": def(AdminBan, MESSAGE_RATES["admin.ban"], ({ auth }, p) => {
        roomCtx().people.ban(
          p.userId,
          { userId: auth.userId, role: auth.role, ip: auth.ip },
          p.reason ?? null,
        );
      }),
      "admin.unban": def(AdminUnban, MESSAGE_RATES["admin.unban"], ({ auth }, p) => {
        roomCtx().people.unban(p.userId, { userId: auth.userId, role: auth.role, ip: auth.ip });
      }),
      "clock.sync": def(ClockSync, MESSAGE_RATES["clock.sync"], (_c, p) => ({
        t0: p.t0,
        serverNow: Date.now(),
      })),
      "hand.toggle": def(HandToggle, MESSAGE_RATES["hand.toggle"], ({ auth }, p) => {
        const pr = this.state.presence.get(auth.userId);
        if (!pr) throw new GloamError("NOT_FOUND");
        if (auth.role === "spectator") throw new GloamError("FORBIDDEN");
        const raised = p.raised ?? !pr.handRaised;
        pr.handRaised = raised;
        if (raised) this.toDms("hand.raised", { userId: auth.userId, name: auth.name });
        return { raised };
      }),
      "prep.open": def(SceneRef, MESSAGE_RATES["prep.open"], ({ client, auth }, p): PrepSnapshot | null => {
        this.requireDm(auth);
        const scene = this.model.get("scene", p.sceneId);
        if (!scene || scene.deletedAt) throw new GloamError("NOT_FOUND", "That scene no longer exists.");
        if (scene.id === this.projector.activeSceneId) {
          // The active scene is already in the live state; no prep subscription needed.
          this.prepSubs.delete(client);
          return null;
        }
        this.prepSubs.set(client, scene.id);
        return prepSnapshot(scene, this.projectionCtx());
      }),
      "prep.close": def(z.strictObject({}), MESSAGE_RATES["prep.close"], ({ client, auth }) => {
        this.requireDm(auth);
        this.prepSubs.delete(client);
      }),
      // A controller's drag, relayed to everyone else who can see the token (SPEC §8.6 Others see planning) — each
      // player only as far as they'd see the token go (§15.6): never where it's heading out of their sight.
      "move.preview": def(MovePreview, MESSAGE_RATES["move.preview"], ({ client, auth }, p) => {
        const t = this.model.get("token", p.tokenId);
        if (!t || t.sceneId !== this.projector.activeSceneId) throw new GloamError("NOT_FOUND");
        if (!controlsToken(auth.role, auth.userId, t)) throw new GloamError("FORBIDDEN");
        const color = roomCtx().profiles.get(auth.userId)?.color ?? "";
        const msg = { ...p, by: auth.userId, color };
        const clips = new Map<string, { points: P[]; full: boolean } | null>();
        const clipFor = (userId: string) => {
          if (!clips.has(userId)) clips.set(userId, this.vision.clipPreview(userId, p.tokenId, p.points));
          return clips.get(userId) ?? null;
        };
        for (const c of this.clients) {
          if (c === client) continue;
          const a = c.auth as ClientAuth | undefined;
          if (!a) continue;
          if (a.role === "admin" || a.role === "dm") {
            c.send("move.preview", msg);
            continue;
          }
          if (this.views.grantsOf(c)?.tokens.has(p.tokenId) !== true) continue;
          let clip: { points: P[]; full: boolean } | null = null;
          if (a.role === "spectator")
            for (const u of this.vision.playerIds()) {
              const q = clipFor(u);
              if (q && (!clip || q.full || q.points.length > clip.points.length)) clip = q;
            }
          else clip = clipFor(a.userId);
          if (!clip) continue;
          // A cut route's cost would tell how far it goes: only a whole one carries it.
          c.send("move.preview", clip.full ? msg : { ...msg, points: clip.points, cost: 0 });
        }
      }),
      // Dice (SPEC §8.9, §18): the server rolls; each client gets what its visibility row allows (§18.3).
      "dice.roll": def(DiceRoll, MESSAGE_RATES["dice.roll"], ({ auth }, p) => {
        const dm = auth.role === "admin" || auth.role === "dm";
        this.checkRollVisibility(dm, p.visibility);
        let token: TokenEntity | undefined;
        if (p.context?.tokenId) {
          token = this.model.get("token", p.context.tokenId);
          if (!token || !controlsToken(auth.role, auth.userId, token)) throw new GloamError("FORBIDDEN");
        }
        const r = this.dice.roll(this.campaignId, this.projector.activeSceneId || null, this.rollerOf(auth), {
          formula: p.formula,
          visibility: p.visibility,
          ...(p.label ? { label: p.label } : {}),
          ...(p.purpose ? { purpose: p.purpose } : {}),
          ...(token ? { token } : {}),
        });
        this.deliverRoll(r, dm);
        return { id: r.id };
      }),
      "dice.manual": def(DiceManual, MESSAGE_RATES["dice.manual"], ({ auth }, p) => {
        const dm = auth.role === "admin" || auth.role === "dm";
        this.checkRollVisibility(dm, p.visibility);
        const r = this.dice.manual(
          this.campaignId,
          this.projector.activeSceneId || null,
          this.rollerOf(auth),
          {
            formula: p.formula,
            visibility: p.visibility,
            ...(p.values ? { values: p.values } : {}),
            ...(p.total !== undefined ? { total: p.total } : {}),
            ...(p.label ? { label: p.label } : {}),
          },
        );
        this.deliverRoll(r, dm);
        return { id: r.id };
      }),
      // Your dice skin (§8.9): saved to your profile, and in the room's presence so everyone's dice show it at once.
      "profile.diceSkin": def(ProfileDiceSkin, MESSAGE_RATES["profile.diceSkin"], ({ auth }, p) => {
        const json = JSON.stringify({ body: p.body, number: p.number, material: p.material });
        roomCtx().profiles.update(auth.userId, { diceSkinJson: json });
        const pr = this.state.presence.get(auth.userId);
        if (pr) pr.diceSkin = json;
      }),
      "dice.feed": def(z.strictObject({}), MESSAGE_RATES["dice.feed"], ({ auth }) =>
        this.dice.feed(this.campaignId, {
          userId: auth.userId,
          dm: auth.role === "admin" || auth.role === "dm",
        }),
      ),
      // A finished measurement, shown to everyone else for 3 s (SPEC §8.6 Measurement tools).
      "measure.share": def(MeasureShare, MESSAGE_RATES["measure.share"], ({ client, auth }, p) => {
        if (!this.projector.activeSceneId) return;
        const color = roomCtx().profiles.get(auth.userId)?.color ?? "";
        for (const c of this.clients)
          if (c !== client) c.send("measure.shared", { ...p, by: auth.userId, name: auth.name, color });
      }),
      // Pings (SPEC §8.18): everyone at the table sees them, in the sender's colour.
      "ping.send": def(PingSend, MESSAGE_RATES["ping.send"], ({ auth }, p) => {
        if (!this.projector.activeSceneId) return;
        const color = roomCtx().profiles.get(auth.userId)?.color ?? "";
        this.broadcastAll("ping", {
          x: p.x,
          y: p.y,
          color,
          by: auth.userId,
          name: auth.name,
          spotlight: false,
        });
      }),
      "camera.spotlight": def(CameraSpotlight, MESSAGE_RATES["camera.spotlight"], ({ auth }, p) => {
        this.requireDm(auth);
        const color = roomCtx().profiles.get(auth.userId)?.color ?? "";
        this.broadcastAll("ping", {
          x: p.x,
          y: p.y,
          color,
          by: auth.userId,
          name: auth.name,
          spotlight: true,
        });
        for (const c of this.clients) {
          const role = (c.auth as ClientAuth | undefined)?.role;
          if (role !== "admin" && role !== "dm")
            c.send("camera.spotlight", { x: p.x, y: p.y, by: auth.name });
        }
      }),
      "asset.list": def(LibraryQuery, MESSAGE_RATES["asset.list"], ({ auth }, p) => {
        const usage = this.assetUsage();
        return roomCtx()
          .assets.list(this.campaignId, { userId: auth.userId, role: auth.role }, p)
          .map((a) => ({ ...a, usage: usage.get(a.id) ?? 0 }));
      }),
      "scene.list": def(z.strictObject({}), MESSAGE_RATES["scene.list"], ({ auth }) => {
        this.requireDm(auth);
        return this.sceneList();
      }),
      "scene.preload": def(SceneRef, MESSAGE_RATES["scene.preload"], ({ auth }, p) => {
        this.requireDm(auth);
        const scene = this.model.get("scene", p.sceneId);
        if (!scene || scene.deletedAt) throw new GloamError("NOT_FOUND", "That scene no longer exists.");
        // Everyone's browser fetches the scene's images and models in the background (SPEC §8.3 Preload).
        const assetIds = new Set<string>();
        if (scene.mapAssetId) assetIds.add(scene.mapAssetId);
        for (const t of this.model.inScene("token", scene.id)) {
          if (t.hidden) continue;
          if (t.appearance.assetId) assetIds.add(t.appearance.assetId);
          if (t.appearance.portraitAssetId) assetIds.add(t.appearance.portraitAssetId);
        }
        this.broadcastAll("scene.preload", { assetIds: [...assetIds] });
        return { count: assetIds.size };
      }),
      // Fog of the active scene for this client (SPEC §15.8): its reveal layers and explored memory.
      "fog.snapshot": def(z.strictObject({}), MESSAGE_RATES["fog.snapshot"], ({ auth }) =>
        this.vision.snapshot(auth.userId, auth.role !== "player"),
      ),
      // View as (SPEC §8.8): what a player would hold. Nothing changes for anyone.
      "vision.viewAs": def(
        z.strictObject({ userId: z.string().min(1).max(64) }),
        MESSAGE_RATES["vision.viewAs"],
        ({ auth }, p) => {
          this.requireDm(auth);
          return this.vision.viewAs(p.userId);
        },
      ),
      ...this.commandHandlers(),
      "history.undo": def(
        z.strictObject({ force: z.boolean().optional() }),
        { capacity: 5, perSecond: 5 },
        ({ auth }, p) => {
          const e = this.bus.undo(this.actorFor(auth), { force: p.force });
          return { entryId: e.id, summary: e.summary };
        },
      ),
      "history.redo": def(z.strictObject({}), { capacity: 5, perSecond: 5 }, ({ auth }) => {
        const e = this.bus.redo(this.actorFor(auth));
        return { entryId: e.id, summary: e.summary };
      }),
    },
    roomCtx().log,
    (client, type) => {
      const auth = client.auth as ClientAuth | undefined;
      roomCtx().security.record("ws.ratelimited", { userId: auth?.userId ?? null, detail: { type } });
    },
  );

  override onCreate(options: TableRoomOptions): void {
    if (!/^[A-Za-z0-9_-]+$/.test(options.campaignId)) throw new Error("invalid campaign id");
    this.campaignId = options.campaignId;
    this.roomId = options.campaignId;
    this.autoDispose = false;
    const state = new Table();
    this.setState(state);
    this.loadModel();
    roomCtx().rooms.tables.set(this.campaignId, this);
  }

  /** (Re)loads the campaign into memory and builds the command bus around it. */
  private loadModel(): void {
    const ctx = roomCtx();
    const model = CampaignModel.load(ctx.db, this.campaignId);
    if (!model) throw new Error(`campaign ${this.campaignId} not found`);
    this.model = model;
    // A reload replaces the database under it (a restore): the old service's memory is not written back.
    this.vision?.dispose();
    this.dice = new DiceService(ctx.db, ctx.config.testSeed);
    this.vision = new VisionService(model, ctx.db, {
      players: () => {
        const out: string[] = [];
        this.state.presence.forEach((p, id) => {
          if (p.role === "player") out.push(id);
        });
        return out;
      },
      toUser: (userId, type, payload) => {
        for (const c of this.clientsByUser.get(userId) ?? []) c.send(type, payload);
      },
      toOverseers: (type, payload) => {
        for (const c of this.clients) {
          const role = (c.auth as ClientAuth | undefined)?.role;
          if (role === "admin" || role === "dm" || role === "spectator") c.send(type, payload);
        }
      },
    });
    this.bus = new CommandBus(ctx, model, {
      onCommitted: (info) => this.onCommitted(info),
      onEvents: (events) => this.deliver(events),
      fog: this.vision,
    });
    registerCommands(this.bus);
    this.syncCampaign();
    this.views?.detachAll();
    this.projector = new StateProjector(this.state, this.projectionCtx());
    this.views = new ViewManager(this.state, model, this.vision);
    this.projector.loadActive();
    this.syncSensed();
    this.syncGlows();
    this.syncAllViews();
  }

  projectionCtx(): ProjectionCtx {
    return {
      model: this.model,
      colorOf: (userId) => roomCtx().profiles.get(userId)?.color,
    };
  }

  private viewerOf(client: Client): Viewer | null {
    const auth = client.auth as ClientAuth | undefined;
    return auth ? { userId: auth.userId, role: auth.role } : null;
  }

  syncAllViews(): void {
    for (const c of this.clients) {
      const v = this.viewerOf(c);
      if (v) this.views.sync(c, v, this.projector.activeSceneId);
    }
  }

  private requireDm(auth: ClientAuth): void {
    if (auth.role !== "admin" && auth.role !== "dm")
      throw new GloamError("FORBIDDEN", "Only the DM can do that.");
  }

  /** The DM scene list (SPEC §8.3 DM scene tools). */
  sceneList() {
    const active = this.projector.activeSceneId;
    return this.model
      .all("scene")
      .sort((a, b) => a.sort - b.sort)
      .map((s) => ({
        id: s.id,
        name: s.name,
        sort: s.sort,
        mapKind: s.mapKind,
        mapAssetId: s.mapAssetId,
        thumbnailAssetId: s.thumbnailAssetId,
        active: s.id === active,
        archived: s.archivedAt !== null,
        deleted: s.deletedAt !== null,
        tokenCount: this.model.inScene("token", s.id).length,
        updatedAt: s.updatedAt,
        calibration: s.calibration,
        bounds: s.bounds,
      }));
  }

  /** Projects the campaign document into the synchronised state. */
  private syncCampaign(): void {
    const c = this.model.campaign;
    this.state.campaignId = c.id;
    this.state.campaignName = c.name;
    this.state.units = c.units;
    this.state.rulesPack = c.rulesPack;
    this.state.sessionNo = c.sessionNo;
    this.state.houseRulesJson = JSON.stringify(c.houseRules);
    this.state.settingsJson = JSON.stringify(c.settings);
  }

  /** Post-commit (§14.1 step 5–6): mirror changed entities into the Colyseus state. */
  private onCommitted(info: CommitInfo): void {
    if (info.ops.some((o) => (o.k === "set" || o.k === "create") && o.e === "campaign")) this.syncCampaign();
    const active = this.model.activeScene;
    const nextActive = active && !active.deletedAt ? active.id : "";
    if (nextActive !== this.projector.activeSceneId) this.views.detachAll();
    const res = this.projector.apply(info.ops);
    const seen = this.vision.onCommitted(info.ops);
    if (seen) this.syncSensed();
    // Carriers move and lights change without anyone's perception changing: the stand-ins follow every commit.
    this.syncGlows();
    if (res.switched) {
      // Everyone travels (SPEC §8.3): DMs who were prepping the new active scene now see it live.
      for (const [client, sceneId] of this.prepSubs) if (sceneId === nextActive) this.prepSubs.delete(client);
    }
    if (res.activeChanged || seen) this.syncAllViews();
    this.vision.deliverFog();
    for (const [sceneId, patch] of res.prep) {
      for (const [client, sub] of this.prepSubs) if (sub === sceneId) client.send("prep.patch", patch);
    }
    if (info.ops.some((o) => o.k !== "fog" && o.k !== "sheet" && o.e === "scene"))
      this.toDms("scene.list", this.sceneList());
    const assetIds = new Set<string>();
    for (const o of info.ops) if (o.k !== "fog" && o.k !== "sheet" && o.e === "asset") assetIds.add(o.id);
    if (assetIds.size) this.notifyAssets([...assetIds], info.type);
  }

  /**
   * Library updates: DMs see every change; an uploader sees changes to their own uploads (e.g. approval). Everyone
   * else gets only the render view of approved assets (`asset.render`), and only when it changed — a new override on
   * a mini re-scales it on every board at once, while renames and tags stay the DM's business.
   */
  private notifyAssets(ids: string[], type: string): void {
    const svc = roomCtx().assets;
    for (const id of ids) {
      const dto = svc.dtoById(id);
      if (!dto) continue;
      this.toDms("asset.changed", { asset: dto });
      if (type === "asset.register" && dto.status === "pending") this.toDms("asset.pending", { asset: dto });
      for (const c of this.clientsByUser.get(dto.uploaderId) ?? []) {
        const role = (c.auth as ClientAuth).role;
        if (role !== "admin" && role !== "dm") c.send("asset.changed", { asset: dto });
      }
      const view = dto.status === "approved" && !dto.deleted ? renderDto(dto) : null;
      const json = view ? JSON.stringify(view) : "";
      if (!view || this.renderSent.get(id) === json) continue;
      this.renderSent.set(id, json);
      for (const c of this.clients) {
        const auth = c.auth as ClientAuth | undefined;
        if (!auth || auth.role === "admin" || auth.role === "dm" || auth.userId === dto.uploaderId) continue;
        c.send("asset.render", { asset: view });
      }
    }
  }
  /** The last render view sent to players per asset (only real changes go out). */
  private readonly renderSent = new Map<string, string>();

  /** How many tokens and scenes use each asset (Library "usage count", SPEC §8.16). */
  assetUsage(): Map<string, number> {
    const n = new Map<string, number>();
    const bump = (id: string | null | undefined) => {
      if (id) n.set(id, (n.get(id) ?? 0) + 1);
    };
    for (const t of this.model.all("token")) {
      bump(t.appearance.assetId);
      if (t.appearance.portraitAssetId !== t.appearance.assetId) bump(t.appearance.portraitAssetId);
    }
    for (const s of this.model.all("scene")) if (!s.deletedAt) bump(s.mapAssetId);
    return n;
  }

  actorFor(auth: ClientAuth): CommandActor {
    return { userId: auth.userId, role: auth.role, name: auth.name, actingAs: null };
  }

  /** One room message per command type; the bus parses, authorizes, plans and commits. */
  private commandHandlers(): Record<string, MessageDef<z.ZodType>> {
    const out: Record<string, MessageDef<z.ZodType>> = {};
    for (const d of ALL_COMMANDS) {
      if (d.internal) continue;
      out[d.type] = def(
        z.unknown(),
        COMMAND_RATES[d.type] ?? { capacity: 10, perSecond: 10 },
        ({ auth }, raw) => {
          const payload = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : raw;
          // Envelope fields: `cid` (idempotency) and `undoGroup` (consecutive commands that undo as one step).
          const envelope = (k: "cid" | "undoGroup") => {
            if (!payload || typeof payload !== "object" || !(k in payload)) return undefined;
            const v = (payload as Record<string, unknown>)[k];
            delete (payload as Record<string, unknown>)[k];
            return typeof v === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(v) ? v : undefined;
          };
          const cid = envelope("cid");
          const undoGroup = envelope("undoGroup");
          return this.bus.execute(d.type, payload, this.actorFor(auth), { cid, undoGroup });
        },
      );
    }
    return out;
  }

  override onJoin(client: Client): void {
    const ctx = roomCtx();
    const auth = client.auth as ClientAuth;
    if (!auth || auth.campaignId !== this.campaignId) {
      client.leave(CLOSE.revoked);
      return;
    }
    client.view = new StateView();
    const set = this.clientsByUser.get(auth.userId) ?? new Set<Client>();
    set.add(client);
    this.clientsByUser.set(auth.userId, set);
    this.upsertPresence(auth, true);
    this.syncCampaign();
    this.views.sync(client, { userId: auth.userId, role: auth.role }, this.projector.activeSceneId);
    client.send("welcome", {
      userId: auth.userId,
      role: auth.role,
      name: auth.name,
      color: auth.color,
      campaignId: this.campaignId,
      serverNow: Date.now(),
    });
    if (auth.role === "admin" || auth.role === "dm") client.send("knocks", ctx.people.pending());
    ctx.table.changed();
  }

  private upsertPresence(auth: ClientAuth, online: boolean): void {
    let p = this.state.presence.get(auth.userId);
    if (!p) {
      p = new Presence();
      p.userId = auth.userId;
      p.handRaised = false;
      this.state.presence.set(auth.userId, p);
    }
    const user = roomCtx().profiles.get(auth.userId);
    p.name = user?.displayName ?? auth.name;
    p.color = user?.color ?? auth.color;
    p.role = auth.role;
    p.spectator = auth.role === "spectator";
    p.diceSkin = user?.diceSkinJson ?? "{}";
    p.online = online;
  }

  override async onDrop(client: Client): Promise<void> {
    if (this.closing.has(client)) return;
    const auth = client.auth as ClientAuth;
    const p = this.state.presence.get(auth.userId);
    if (p && (this.clientsByUser.get(auth.userId)?.size ?? 0) <= 1) p.online = false;
    try {
      // A dropped socket reconnects within 60 s without re-approval (AC-AUTH-07).
      await this.allowReconnection(client, 60);
    } catch {
      // window expired → onLeave follows
    }
  }

  override onReconnect(client: Client): void {
    const ctx = roomCtx();
    const auth = client.auth as ClientAuth;
    const s = ctx.sessions.get(auth.authSessionId);
    const user = ctx.profiles.get(auth.userId);
    const valid =
      s &&
      s.revokedAt === null &&
      user &&
      !user.bannedAt &&
      (s.kind === "admin" ||
        (s.status === "admitted" && ctx.table.isOpen && s.tableSessionNo === ctx.table.sessionNo));
    if (!valid) {
      client.leave(CLOSE.revoked);
      return;
    }
    const p = this.state.presence.get(auth.userId);
    if (p) p.online = true;
  }

  override onLeave(client: Client): void {
    const auth = client.auth as ClientAuth | undefined;
    this.views.forget(client);
    this.prepSubs.delete(client);
    client.view?.dispose();
    if (!auth) return;
    const set = this.clientsByUser.get(auth.userId);
    set?.delete(client);
    if (!set || set.size === 0) {
      this.clientsByUser.delete(auth.userId);
      const p = this.state.presence.get(auth.userId);
      if (p) {
        p.online = false;
        p.handRaised = false;
      }
    }
    roomCtx().table.changed();
  }

  override onBeforePatch(): void {
    this.beforePatchProbe?.();
  }

  override onDispose(): void {
    this.vision.flush();
    this.vision.dispose();
    const ctx = roomCtx();
    if (ctx.rooms.tables.get(this.campaignId) === this) ctx.rooms.tables.delete(this.campaignId);
  }

  // ── TableRoomApi ──────────────────────────────────────────────────────────────────────────────────────

  /** Who may roll how (§8.9): players Public, Private to DM or Self; DMs Public or Private. Blind comes from DM roll
   * requests (P6), never from the tray. */
  private checkRollVisibility(dm: boolean, v: string): void {
    const ok = dm ? v === "public" || v === "dm" : v === "public" || v === "dm" || v === "self";
    if (!ok) throw new GloamError("INVALID", "That visibility isn't one you can roll with.");
  }

  /** The roller as their dice show: name, colour and skin (SPEC §8.9 Dice skins). */
  private rollerOf(auth: ClientAuth) {
    const user = roomCtx().profiles.get(auth.userId);
    let skin: DiceSkin = DEFAULT_SKIN;
    try {
      const s = JSON.parse(user?.diceSkinJson ?? "{}") as Partial<DiceSkin>;
      skin = {
        body: typeof s.body === "string" && /^#[0-9A-Fa-f]{6}$/.test(s.body) ? s.body : DEFAULT_SKIN.body,
        number:
          typeof s.number === "string" && /^#[0-9A-Fa-f]{6}$/.test(s.number) ? s.number : DEFAULT_SKIN.number,
        material: ["resin", "gemstone", "metal", "bone", "obsidian"].includes(s.material as string)
          ? (s.material as DiceSkin["material"])
          : DEFAULT_SKIN.material,
      };
    } catch {
      // a skin that doesn't parse: the default dice
    }
    return {
      userId: auth.userId,
      name: user?.displayName ?? auth.name,
      color: user?.color ?? auth.color,
      skin,
      dm: auth.role === "admin" || auth.role === "dm",
    };
  }

  /** Sends a roll to every client as its row of §18.3 allows: the roll, a masked card, or nothing. */
  private deliverRoll(r: RollRecord, rollerIsDm: boolean): void {
    for (const c of this.clients) {
      const auth = c.auth as ClientAuth | undefined;
      if (!auth) continue;
      const v = viewOfRoll(
        r,
        { userId: auth.userId, dm: auth.role === "admin" || auth.role === "dm" },
        rollerIsDm,
      );
      if (!v) continue;
      c.send("masked" in v ? "roll.masked" : "roll.result", v);
    }
  }

  /** Glow stand-ins in the state: exactly the ones someone holds, each drawn from its light as it is now. */
  private readonly glowIds = new Set<string>();
  private syncGlows(): void {
    const want = new Map(this.vision.allGlows().map((g) => [g.id, g.lightId] as const));
    for (const id of [...this.glowIds])
      if (!want.has(id)) {
        this.projector.removeGlow(id);
        this.glowIds.delete(id);
      }
    for (const [id, lightId] of want) {
      const l = this.model.get("light", lightId);
      if (!l) continue;
      this.projector.upsertGlow(glowView(lightView(l, this.projectionCtx()), id));
      this.glowIds.add(id);
    }
  }

  /** The state's tremorsense markers: exactly the ones someone holds (views decide who). */
  private syncSensed(): void {
    const want = new Map(this.vision.allSensed().map((m) => [m.id, m] as const));
    for (const id of [...this.state.sensed.keys()]) if (!want.has(id)) this.state.sensed.delete(id);
    for (const [id, m] of want) {
      let s = this.state.sensed.get(id);
      if (!s) {
        s = new Sensed();
        s.id = id;
        s.pos = new V2();
        this.state.sensed.set(id, s);
      }
      if (s.pos.x !== m.x) s.pos.x = m.x;
      if (s.pos.y !== m.y) s.pos.y = m.y;
    }
  }

  /**
   * A token's move (SPEC §15.6): DMs see all of it; every other viewer the part they perceive — from where it came
   * into their perception to where it left it — or nothing. Who never holds the token gets its looks with the path.
   */
  private deliverMove(p: { id: string; path: { x: number; y: number }[]; durationMs: number }): void {
    const t = this.model.get("token", p.id);
    const clips = new Map<string, MoveSeen | null>();
    const clipFor = (userId: string) => {
      if (!clips.has(userId)) clips.set(userId, this.vision.clipMove(userId, p.id, p.path, p.durationMs));
      return clips.get(userId) ?? null;
    };
    for (const c of this.clients) {
      const auth = c.auth as ClientAuth | undefined;
      if (!auth) continue;
      if (auth.role === "admin" || auth.role === "dm") {
        c.send("token.moved", { ...p, delayMs: 0, appear: false, disappear: false });
        continue;
      }
      let clip: MoveSeen | null = null;
      if (auth.role === "spectator") {
        // The union of the players' views: the widest part any of them sees.
        for (const u of this.vision.playerIds()) clip = widest(clip, clipFor(u));
      } else clip = clipFor(auth.userId);
      if (!clip) continue;
      const holds = this.views.grantsOf(c)?.tokens.has(p.id) === true;
      c.send(
        "token.moved",
        !holds && t ? { ...clip, ghost: ghostOf(tokenView(t, this.projectionCtx())) } : clip,
      );
    }
  }

  /** Delivers command events (§14.1 post-commit): to a token's viewers, to users, or to the DMs. */
  private deliver(events: RoomEvent[]): void {
    for (const e of events) {
      if (e.name === "token.moved" && "viewersOf" in e.to) {
        this.deliverMove(e.payload as { id: string; path: { x: number; y: number }[]; durationMs: number });
        continue;
      }
      if ("viewersOf" in e.to) this.toViewersOf(e.to.viewersOf, e.name, e.payload);
      else if ("users" in e.to)
        for (const u of e.to.users)
          for (const c of this.clientsByUser.get(u) ?? []) c.send(e.name, e.payload);
      else this.toDms(e.name, e.payload);
    }
  }

  /** Sends to every client whose view holds the token (DMs always), optionally skipping one (the sender). */
  toViewersOf(tokenId: string, type: string, payload: unknown, except?: Client): void {
    for (const c of this.clients) {
      if (c === except) continue;
      const role = (c.auth as ClientAuth | undefined)?.role;
      if (role === "admin" || role === "dm" || this.views.grantsOf(c)?.tokens.has(tokenId))
        c.send(type, payload);
    }
  }

  toDms(type: string, payload: unknown): void {
    for (const c of this.clients) {
      const role = (c.auth as ClientAuth | undefined)?.role;
      if (role === "admin" || role === "dm") c.send(type, payload);
    }
  }

  broadcastAll(type: string, payload: unknown): void {
    for (const c of this.clients) c.send(type, payload);
  }

  disconnectUser(userId: string, type: string, payload: unknown, code: number): void {
    for (const c of this.clientsByUser.get(userId) ?? []) {
      this.closing.add(c);
      c.send(type, payload);
      setTimeout(() => c.leave(code), 30);
    }
  }

  disconnectNonAdmins(type: string, payload: unknown, code: number): void {
    for (const c of this.clients) {
      const role = (c.auth as ClientAuth | undefined)?.role;
      if (role === "admin") continue;
      this.closing.add(c);
      c.send(type, payload);
      setTimeout(() => c.leave(code), 30);
    }
  }

  counts(): { admitted: number; spectators: number } {
    let admitted = 0;
    let spectators = 0;
    for (const [userId] of this.clientsByUser) {
      const p = this.state.presence.get(userId);
      if (!p || p.role === "admin") continue;
      if (p.role === "spectator") spectators++;
      else admitted++;
    }
    return { admitted, spectators };
  }

  onlineUserIds(): Set<string> {
    return new Set(this.clientsByUser.keys());
  }

  async reloadFromDatabase(): Promise<void> {
    this.loadModel();
    this.broadcastAll("table.resync", {});
  }

  flushFog(): void {
    this.vision.flush();
  }
}

/** The wider of two clipped moves (for spectators: the union of the players' views). */
function widest(a: MoveSeen | null, b: MoveSeen | null): MoveSeen | null {
  if (!a) return b;
  if (!b) return a;
  const end = (m: MoveSeen) => m.delayMs + m.durationMs;
  if (a.delayMs <= b.delayMs && end(a) >= end(b)) return a;
  if (b.delayMs <= a.delayMs && end(b) >= end(a)) return b;
  // Overlapping parts: from the earlier start to the later end.
  const [first, second] = a.delayMs <= b.delayMs ? [a, b] : [b, a];
  return {
    ...first,
    path: [...first.path, ...second.path.slice(1)],
    durationMs: end(second) - first.delayMs,
    appear: first.appear,
    disappear: second.disappear,
  };
}

/** A token's looks for a viewer who never holds it (it crosses their view mid-move): nothing tagged. */
function ghostOf(v: ReturnType<typeof tokenView>) {
  return {
    name: v.name,
    size: v.size,
    sizeFt: v.sizeFt,
    elevation: v.elevation,
    rotation: v.rotation,
    mode: v.mode,
    assetId: v.assetId,
    portraitAssetId: v.portraitAssetId,
    scale: v.scale,
    offsetY: v.offsetY,
    rotOffset: v.rotOffset,
    tint: v.tint,
    ringColor: v.ringColor,
    disposition: v.disposition,
  };
}
