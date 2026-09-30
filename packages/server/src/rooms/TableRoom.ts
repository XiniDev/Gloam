import { type AuthContext, type Client, Room, ServerError } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { BOARD_COLORS, SKILLS, type SkillId } from "@gloam/shared";
import {
  DiceError,
  isD20Test,
  parseFormula,
  sheetTestOf,
  withHint,
  withPenalty,
  withTerms,
} from "@gloam/shared/dice";
import type { P } from "@gloam/shared/geometry";
import {
  ActAs,
  type ActingAsView,
  ActorPropose,
  AdminBan,
  AdminUnban,
  CameraSpotlight,
  CastInspire,
  CastNpcSaves,
  CastRoll,
  ClockSync,
  CombatRollRemaining,
  DeathSaveRequest,
  DiceManual,
  DiceRoll,
  EmoteSend,
  GloamError,
  HandToggle,
  type HistoryListEntry,
  type HistoryListResult,
  type HistoryRestorePlan,
  HpApply,
  LobbyDecide,
  LogAdd,
  LogList,
  MESSAGE_RATES,
  MeasureShare,
  MovePreview,
  PingSend,
  ProfileDiceSkin,
  ProfilePhrases,
  PromptResolve,
  ProposalDecide,
  RequestAnswer,
  type RequestCard,
  RequestClose,
  RequestCreate,
  RequestKeep,
  RequestRespond,
  SceneRef,
  TableKick,
} from "@gloam/shared/protocol";
import {
  applyChanges,
  applyPatch,
  can,
  conditionsBearing,
  controlsToken,
  diffSheet,
  effectiveTokenState,
  hintedMode,
  isDm,
  type RollKind,
  rollHints,
  type SheetChange,
  speedNowFt,
  statusFromActor,
} from "@gloam/shared/rules";
import type { Sheet, TokenEntity, TokenStatusT } from "@gloam/shared/schemas";
import { type PrepSnapshot, Presence, Sensed, Table, type TableState, V2 } from "@gloam/shared/state";
import { z } from "zod";
import { renderDto } from "../assets/service.ts";
import { LibraryQuery } from "../assets/types.ts";
import {
  cardFor,
  type RequestResponse,
  RequestService,
  type RequestTarget,
  type RollRequest,
  requestFormula,
  requestLabel,
  targetFormula,
} from "../dice/requests.ts";
import {
  creatureRefs,
  DEFAULT_SKIN,
  DiceService,
  type DiceSkin,
  type RollRecord,
  rerollableDice,
  viewOfRoll,
} from "../dice/service.ts";
import type { ActorEntity } from "../engine/codecs.ts";
import {
  type CommandActor,
  CommandBus,
  type CommandCtx,
  type CommitInfo,
  type HistoryEntry,
  type RoomEvent,
} from "../engine/commandBus.ts";
import { checkSheet, readSheet } from "../engine/commands/actor.ts";
import { AUDIO_SYNC, campaignAudio } from "../engine/commands/audio.ts";
import {
  COMBAT_COLLECT,
  COMBAT_STOPPED,
  COMBAT_TURN,
  type CombatCollect,
  type CombatStopped,
  type CombatTurn,
  combatOn,
  dataOf,
  movementOf,
} from "../engine/commands/combat.ts";
import { homebrewFor } from "../engine/commands/content.ts";
import { holds } from "../engine/commands/handout.ts";
import { FOLLOWUPS, type Followups, hpApply, previewHp } from "../engine/commands/health.ts";
import { SYSTEM_ACTOR } from "../engine/commands/party.ts";
import { REST_FOLLOWUPS, type RestFollowups } from "../engine/commands/rest.ts";
import { CAST_FOLLOWUP, type CastFollowup, concentrationsEnded } from "../engine/commands/spells.ts";
import { CampaignModel } from "../engine/model.ts";
import { ALL_COMMANDS, COMMAND_RATES, registerCommands } from "../engine/registry.ts";
import { PromptService } from "../health/prompts.ts";
import { type Proposal, ProposalService, proposalView } from "../sheets/proposals.ts";
import { type MoveSeen, VisionService } from "../vision/visionService.ts";
import { AudioTimer } from "./audioTimer.ts";
import { CastFlow, type CastViewer } from "./castFlow.ts";
import { CombatFlow, type CombatViewer } from "./combat.ts";
import {
  buildHandlers,
  type ClientAuth,
  def,
  isSameOrigin,
  type MessageDef,
  parseCookies,
} from "./dispatch.ts";
import { EffectFlow } from "./effectFlow.ts";
import { FunFlow } from "./fun.ts";
import { HealthFlow, type SystemRequest } from "./health.ts";
import {
  effectGlimpseView,
  effectView,
  glowView,
  lightView,
  type ProjectionCtx,
  prepSnapshot,
  StateProjector,
  tokenView,
} from "./projector.ts";
import { CLOSE, type TableRoomApi } from "./registry.ts";
import { roomCtx } from "./roomContext.ts";
import { SheetSync } from "./sheetSync.ts";
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
  /** Act as (AC-DMP-03): the character each DM at the table is acting as, by their user id. */
  private readonly actingAs = new Map<string, { actorId: string; name: string }>();
  private readonly closing = new WeakSet<Client>();
  model!: CampaignModel;
  bus!: CommandBus;
  projector!: StateProjector;
  views!: ViewManager;
  /** Perception, fog and explored memory of the active scene (SPEC §15.5). */
  vision!: VisionService;
  dice!: DiceService;
  /** Character sheets to whoever may read them (SPEC §8.10, §13.4). */
  sheets!: SheetSync;
  /** Players' proposed changes to locked sheets (SPEC §8.10). */
  proposals!: ProposalService;
  /** The DM's roll requests (SPEC §8.9, §18.5). */
  requests!: RequestService;
  /** The DM's prompts (SPEC §8.11, §19.1) and the room's half of health (concentration and death saves). */
  prompts!: PromptService;
  health!: HealthFlow;
  combat!: CombatFlow;
  casts!: CastFlow;
  effects!: EffectFlow;
  /** When the track playing ends (SPEC §25.3). */
  audioTimer!: AudioTimer;
  /** Emotes, the campaign log, handouts (SPEC §8.18). */
  fun!: FunFlow;
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
        // Everyone at the table may (SPEC §6: emotes, pings, hand raise — spectators too).
        if (!can(auth.role, "social")) throw new GloamError("FORBIDDEN");
        const raised = p.raised ?? !pr.handRaised;
        // The DM is told once, as it goes up (not again while it stays up).
        if (raised && !pr.handRaised) this.toDms("hand.raised", { userId: auth.userId, name: auth.name });
        pr.handRaised = raised;
        return { raised };
      }),
      "emote.send": def(EmoteSend, MESSAGE_RATES["emote.send"], ({ auth }, p) => {
        this.fun.emote(auth, p);
      }),
      "profile.phrases": def(ProfilePhrases, MESSAGE_RATES["profile.phrases"], ({ auth }, p) => ({
        phrases: this.fun.setPhrases(auth.userId, p.phrases),
      })),
      "log.add": def(LogAdd, MESSAGE_RATES["log.add"], ({ auth }, p) =>
        this.fun.add(auth, p.text, this.actingAs.get(auth.userId)?.name ?? null),
      ),
      // Act as (SPEC §8.19, AC-DMP-03): a DM takes a character's controls on its player's behalf, or lets go. What they
      // do meanwhile — commands, rolls, log entries — is the character's, recorded as "DM as <character>".
      "act.as": def(ActAs, MESSAGE_RATES["act.as"], ({ auth }, p): ActingAsView => {
        if (!can(auth.role, "actAs")) throw new GloamError("FORBIDDEN");
        const before = this.actingAs.get(auth.userId);
        if (p.actorId === null) this.actingAs.delete(auth.userId);
        else {
          const a = this.model.get("actor", p.actorId);
          if (!a || a.deletedAt !== null || a.kind !== "character")
            throw new GloamError("NOT_FOUND", "That character isn't in this campaign.");
          this.actingAs.set(auth.userId, {
            actorId: a.id,
            name: readSheet(a).core.name || "their character",
          });
        }
        return this.actingChanged(auth, before?.actorId ?? null);
      }),
      "log.list": def(LogList, MESSAGE_RATES["log.list"], ({ auth }, p) =>
        this.fun.list(auth, p.sinceSession, p.limit),
      ),
      "handout.list": def(z.strictObject({}), MESSAGE_RATES["handout.list"], ({ auth }) =>
        this.fun.handouts(auth),
      ),
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
      // A scene's DM notes (SPEC §8.19 Handouts & Notes): the DM's alone — asked for, never in the synchronised state,
      // pushed to DMs when they change (AC-DMP-05).
      "scene.notes": def(SceneRef, MESSAGE_RATES["scene.notes"], ({ auth }, p) => {
        this.requireDm(auth);
        const scene = this.model.get("scene", p.sceneId);
        if (!scene || scene.deletedAt) throw new GloamError("NOT_FOUND", "That scene no longer exists.");
        return { sceneId: scene.id, notes: scene.dmNotes ?? "" };
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
        // (A DM acting as a character rolls as its player would: the player's visibilities, a card that isn't masked
        // as the DM's, the character's sheet behind `@` references — AC-DMP-03.)
        const roller = this.rollerOf(auth);
        const dm = roller.dm;
        this.checkRollVisibility(dm, p.visibility);
        let token: TokenEntity | undefined;
        if (p.context?.tokenId) {
          token = this.model.get("token", p.context.tokenId);
          if (!token || !controlsToken(auth.role, auth.userId, token)) throw new GloamError("FORBIDDEN");
        }
        // `@` references answer from the creature's sheet: the token's character, or the character rolled for.
        const actorId =
          p.context?.actorId ?? token?.actorId ?? this.actingAs.get(auth.userId)?.actorId ?? undefined;
        const actor = actorId ? this.model.get("actor", actorId) : undefined;
        if (
          p.context?.actorId &&
          !(actor && this.sheets.mayRead({ userId: auth.userId, role: auth.role }, actor))
        )
          throw new GloamError("FORBIDDEN", "That isn't your sheet.");
        const sheet = actor && actor.deletedAt === null ? readSheet(actor) : undefined;
        // A creature's D20 Tests lose 2 × its Exhaustion level (AC-HP-05), whoever rolls them — SRD 5.2.1's; SRD 5.1's
        // table gives Disadvantage instead, the roller's hint (rules audit C2).
        const live = actor && actor.deletedAt === null ? actor : undefined;
        const status = token
          ? effectiveTokenState(token, token.link === "linked" ? live : undefined).status
          : live
            ? statusFromActor(live.status)
            : null;
        const penalize = Boolean(status?.exhaustion) && this.model.campaign.rulesPack !== "srd-5.1";
        // Its markers' terms on an attack roll or a saving throw (Bless +1d4, Bane −1d4, Slow −2 on Dex saves; rules
        // audit Q6) — the rules', not the roller's to set aside.
        const test: { kind: RollKind; ability?: string } | null =
          p.purpose === "attack" ? { kind: "attack" } : sheetTestOf(p.formula);
        const terms =
          status && test
            ? rollHints([], 0, test.kind, test.ability, {
                markers: status.markers.map((m) => m.id as string),
              }).extra.map((e) => e.term)
            : [];
        const formula = withTerms(
          penalize ? withPenalty(p.formula, -2 * (status?.exhaustion ?? 0)) : p.formula,
          terms,
        );
        const r = this.dice.roll(this.campaignId, this.projector.activeSceneId || null, roller, {
          formula,
          visibility: p.visibility,
          ...(p.label ? { label: p.label } : {}),
          ...(p.purpose ? { purpose: p.purpose } : {}),
          ...(token ? { token } : {}),
          ...(sheet ? { sheet } : {}),
        });
        this.deliverRoll(r, dm);
        // An attack from the app (§8.12, AC-CMB-08): on its creature's turn, its Action is marked used.
        if (p.purpose === "attack") this.markActionFor(token, actorId, auth);
        return { id: r.id };
      }),
      "dice.manual": def(DiceManual, MESSAGE_RATES["dice.manual"], ({ auth }, p) => {
        const roller = this.rollerOf(auth);
        const dm = roller.dm;
        this.checkRollVisibility(dm, p.visibility);
        const r = this.dice.manual(this.campaignId, this.projector.activeSceneId || null, roller, {
          formula: p.formula,
          visibility: p.visibility,
          ...(p.values ? { values: p.values } : {}),
          ...(p.total !== undefined ? { total: p.total } : {}),
          ...(p.label ? { label: p.label } : {}),
        });
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
      // A player's change to locked fields of their own sheet, for the DM to approve (SPEC §8.10, AC-SHEET-05).
      "actor.propose": def(ActorPropose, MESSAGE_RATES["actor.propose"], ({ auth }, p) => {
        if (auth.role !== "player") throw new GloamError("FORBIDDEN", "DMs change sheets directly.");
        const actor = this.model.get("actor", p.actorId);
        if (!actor || actor.deletedAt !== null)
          throw new GloamError("NOT_FOUND", "That character no longer exists.");
        if (actor.ownerUserId !== auth.userId) throw new GloamError("FORBIDDEN", "That isn't your sheet.");
        const now = readSheet(actor);
        const changes = p.changes as SheetChange[];
        // It has to make a valid sheet, and to change something.
        if (!diffSheet(now, checkSheet(applyChanges(now, changes))).length)
          throw new GloamError("INVALID", "That changes nothing on the sheet.");
        const prop = this.proposals.create({
          campaignId: this.campaignId,
          actorId: actor.id,
          userId: auth.userId,
          changes: changes.map((c) => ({ path: c.path, before: undefined, after: c.after })),
          note: p.note,
        });
        const dto = this.proposalDto(prop);
        this.toDms("proposal.new", dto);
        this.toUser(auth.userId, "proposal.update", dto);
        return { proposalId: prop.id };
      }),
      // The DM's answer: approved changes go onto the sheet as it is now (an ordinary, undoable sheet edit by the DM).
      "proposal.decide": def(ProposalDecide, MESSAGE_RATES["proposal.decide"], ({ auth }, p) => {
        this.requireDm(auth);
        const prop = this.proposals.get(p.proposalId);
        if (!prop || prop.campaignId !== this.campaignId)
          throw new GloamError("NOT_FOUND", "That proposal no longer exists.");
        if (prop.status !== "pending")
          throw new GloamError("CONFLICT", "That proposal was already answered.");
        if (p.approve)
          this.bus.execute(
            "actor.change",
            { actorId: prop.actorId, changes: prop.changes.map((c) => ({ path: c.path, after: c.after })) },
            this.actorFor(auth),
          );
        const decided = this.proposals.decide(
          prop.id,
          auth.userId,
          p.approve ? "approved" : "denied",
          p.note,
        );
        const dto = this.proposalDto(decided);
        this.toDms("proposal.update", dto);
        this.toUser(decided.userId, "proposal.update", dto);
        return { status: decided.status };
      }),
      // Roll requests (SPEC §8.9, §18.5, AC-DICE-06): the DM asks; each target's controllers get a card.
      "request.create": def(RequestCreate, MESSAGE_RATES["request.create"], ({ auth }, p) => {
        this.requireDm(auth);
        const r = this.createRequest(auth.userId, p);
        return { requestId: r.id };
      }),
      // A target's controller answers its card: the server rolls, a physical roll is entered, or it's skipped.
      "request.respond": def(RequestRespond, MESSAGE_RATES["request.respond"], ({ auth }, p) => {
        const { r, target } = this.openTarget(p.requestId, p.target);
        if (!target.controllers.includes(auth.userId))
          throw new GloamError("FORBIDDEN", "That card isn't yours.");
        if (r.responses[target.id]?.state !== "pending")
          throw new GloamError("CONFLICT", "That roll was already answered.");
        let res: RequestResponse;
        let roll: RollRecord | null = null;
        if (p.action === "skip") res = { state: "skipped", by: auth.userId };
        else {
          const x = this.requestTarget(target.id);
          // SRD 5.1's Inspiration: Advantage on this roll, spent (rules audit C4).
          if (p.inspire) {
            const actorId = x.token ? x.token.actorId : target.id;
            if (this.model.campaign.rulesPack !== "srd-5.1" || !actorId || !x.sheet?.core.inspiration)
              throw new GloamError("CONFLICT", `${target.name} has no Inspiration to spend on this.`);
            this.bus.execute(
              "actor.change",
              { actorId, changes: [{ path: ["core", "inspiration"], after: false }] },
              this.actorOfUser(auth.userId),
            );
          }
          const opts = {
            formula: p.inspire
              ? withHint(hinted(target, p.ignoreHints), "adv")
              : hinted(target, p.ignoreHints),
            visibility: r.visibility,
            label: `${target.name} · ${r.label}`,
          };
          roll =
            p.action === "roll"
              ? this.dice.roll(this.campaignId, this.projector.activeSceneId || null, this.rollerOf(auth), {
                  ...opts,
                  purpose: "request",
                  ...(x.token ? { token: x.token } : {}),
                })
              : this.dice.manual(this.campaignId, this.projector.activeSceneId || null, this.rollerOf(auth), {
                  ...opts,
                  purpose: "request",
                  ...(x.token ? { token: x.token } : {}),
                  ...(p.values ? { values: p.values } : {}),
                  ...(p.total !== undefined ? { total: p.total } : {}),
                });
          this.deliverRoll(roll, false);
          res = {
            state: p.action === "roll" ? "rolled" : "manual",
            rollId: roll.id,
            formula: roll.normalized || roll.formula,
            total: roll.total,
            by: auth.userId,
            ...(r.dc !== undefined ? { success: roll.total >= r.dc } : {}),
          };
          // Its creature holds Heroic Inspiration: the roll waits on its roller — keep it, or roll a die again.
          const held = p.action === "roll" ? this.heldFor(r, x.sheet, roll) : null;
          if (held) res.held = held;
        }
        r.responses[target.id] = res;
        if (!res.held) this.answeredForRules(r, target, res, roll);
        this.requests.save(r);
        this.sendRequest(r);
        return cardFor(r, target, this.cardExtra(r, target));
      }),
      // A held roll kept, or Heroic Inspiration spent on one of its dice (rules audit C4).
      "request.keep": def(RequestKeep, MESSAGE_RATES["request.keep"], ({ auth }, p) => {
        const { r, target } = this.openTarget(p.requestId, p.target);
        if (!target.controllers.includes(auth.userId))
          throw new GloamError("FORBIDDEN", "That card isn't yours.");
        const res = r.responses[target.id];
        if (!res?.held || !res.rollId) throw new GloamError("CONFLICT", "That roll isn't waiting on you.");
        const original = this.dice.get(this.campaignId, res.rollId);
        if (!original) throw new GloamError("NOT_FOUND", "That roll is gone.");
        const { held: _held, ...kept } = res;
        let next: RequestResponse = kept;
        let roll: RollRecord = original;
        if (p.reroll !== undefined) {
          const x = this.requestTarget(target.id);
          const actorId = x.token ? x.token.actorId : target.id;
          if (!actorId || !x.sheet?.core.inspiration)
            throw new GloamError("CONFLICT", `${target.name} has no Heroic Inspiration to spend.`);
          // Spent: its sheet says so (one step the DM can undo with the rest).
          this.bus.execute(
            "actor.change",
            { actorId, changes: [{ path: ["core", "inspiration"], after: false }] },
            this.actorOfUser(auth.userId),
          );
          roll = this.dice.reroll(
            this.campaignId,
            this.projector.activeSceneId || null,
            this.rollerOf(auth),
            original,
            p.reroll,
            {
              label: `${target.name} · ${r.label} · Heroic Inspiration`,
              visibility: r.visibility,
              purpose: "request",
              ...(x.token ? { token: x.token } : {}),
            },
          );
          this.deliverRoll(roll, false);
          next = {
            state: "rolled",
            rollId: roll.id,
            formula: roll.normalized || roll.formula,
            total: roll.total,
            by: auth.userId,
            ...(r.dc !== undefined ? { success: roll.total >= r.dc } : {}),
          };
        }
        r.responses[target.id] = next;
        this.answeredForRules(r, target, next, roll);
        this.requests.save(r);
        this.sendRequest(r);
        return cardFor(r, target, this.cardExtra(r, target));
      }),
      // The DM answers for a target: rolls with its modifiers, sets its result, or skips it.
      "request.answer": def(RequestAnswer, MESSAGE_RATES["request.answer"], ({ auth }, p) => {
        this.requireDm(auth);
        const { r, target } = this.openTarget(p.requestId, p.target);
        let res: RequestResponse;
        let dmRoll: RollRecord | null = null;
        if (p.action === "skip") res = { state: "skipped", by: auth.userId };
        else if (p.action === "set") {
          if (p.total === undefined) throw new GloamError("INVALID", "Give the result.");
          res = {
            state: "dm",
            total: p.total,
            by: auth.userId,
            ...(r.dc !== undefined ? { success: p.total >= r.dc } : {}),
          };
        } else {
          const x = this.requestTarget(target.id);
          dmRoll = this.dice.roll(
            this.campaignId,
            this.projector.activeSceneId || null,
            this.rollerOf(auth),
            {
              formula: hinted(target, p.ignoreHints),
              visibility: r.visibility === "public" ? "public" : "dm",
              label: `${target.name} · ${r.label}`,
              purpose: "request",
              ...(x.token ? { token: x.token } : {}),
            },
          );
          this.deliverRoll(dmRoll, true);
          res = {
            state: "dm",
            rollId: dmRoll.id,
            formula: dmRoll.normalized || dmRoll.formula,
            total: dmRoll.total,
            by: auth.userId,
            ...(r.dc !== undefined ? { success: dmRoll.total >= r.dc } : {}),
          };
        }
        r.responses[target.id] = res;
        this.answeredForRules(r, target, res, dmRoll);
        this.requests.save(r);
        this.sendRequest(r);
        return { state: res.state };
      }),
      "request.close": def(RequestClose, MESSAGE_RATES["request.close"], ({ auth }, p) => {
        this.requireDm(auth);
        const r = this.requests.get(p.requestId);
        if (!r || r.campaignId !== this.campaignId)
          throw new GloamError("NOT_FOUND", "That request no longer exists.");
        if (r.status === "closed") return { status: "closed" };
        // A roll still waiting on its roller (Heroic Inspiration) counts as it fell.
        for (const t of r.targets) {
          const res = r.responses[t.id];
          if (!res?.held) continue;
          const { held: _held, ...kept } = res;
          r.responses[t.id] = kept;
          this.answeredForRules(r, t, kept, res.rollId ? this.dice.get(this.campaignId, res.rollId) : null);
        }
        r.status = "closed";
        r.closedAt = Date.now();
        this.requests.save(r);
        this.sendRequest(r);
        return { status: "closed" };
      }),
      // DMs: the open requests; players: their open cards.
      "request.list": def(z.strictObject({}), MESSAGE_RATES["request.list"], ({ auth }) => {
        const open = this.requests.open(this.campaignId);
        if (auth.role === "admin" || auth.role === "dm") return open;
        return open.flatMap((r) =>
          r.targets.filter((t) => t.controllers.includes(auth.userId)).map((t) => cardFor(r, t)),
        );
      }),
      // Health (§8.11): the DM's prompts — what follows from damage or a condition, a player's damage to check.
      "prompt.list": def(z.strictObject({}), MESSAGE_RATES["prompt.list"], ({ auth }) => {
        this.requireDm(auth);
        return this.health.list();
      }),
      "prompt.resolve": def(PromptResolve, MESSAGE_RATES["prompt.resolve"], ({ auth }, p) => {
        this.requireDm(auth);
        return this.health.resolve(this.actorFor(auth), p);
      }),
      // A damage / heal dialog's preview: what applying it would do (numbers only where the caller may see them).
      "hp.preview": def(HpApply, MESSAGE_RATES["hp.preview"], ({ auth }, p) => {
        const ctx: CommandCtx = {
          actor: this.actorFor(auth),
          model: this.model,
          app: roomCtx(),
          now: Date.now(),
        };
        hpApply.authorize(ctx, p);
        return previewHp(ctx, p);
      }),
      // Combat (§8.12): the DM rolls the NPCs still without initiative ("Roll NPCs"), or everyone left.
      "combat.rollRemaining": def(
        CombatRollRemaining,
        MESSAGE_RATES["combat.rollRemaining"],
        ({ auth }, p) => {
          this.requireDm(auth);
          return { rolled: this.combat.rollRemaining(auth.userId, p.players) };
        },
      ),
      // Resolution cards (§8.13): a roll from a card (an attack, the damage), the NPCs' saves on one click.
      "cast.roll": def(CastRoll, MESSAGE_RATES["cast.roll"], ({ auth }, p) =>
        this.casts.roll(this.actorFor(auth), p),
      ),
      "cast.inspire": def(CastInspire, MESSAGE_RATES["cast.inspire"], ({ auth }, p) =>
        this.casts.inspire(this.actorFor(auth), p),
      ),
      "cast.npcSaves": def(CastNpcSaves, MESSAGE_RATES["cast.npcSaves"], ({ auth }, p) =>
        this.casts.npcSaves(this.actorFor(auth), p.castId),
      ),
      // The campaign's homebrew spells as this person may see them (§8.13).
      "content.spells": def(z.strictObject({}), MESSAGE_RATES["content.spells"], ({ auth }) =>
        homebrewFor(
          this.model,
          { userId: auth.userId, dm: auth.role === "admin" || auth.role === "dm" },
          (u) => roomCtx().profiles.get(u)?.displayName ?? "someone",
        ),
      ),
      // Outside combat, the DM asks the dying for death saving throws.
      "death.request": def(DeathSaveRequest, MESSAGE_RATES["death.request"], ({ auth }, p) => {
        this.requireDm(auth);
        return this.health.requestDeathSaves(this.actorFor(auth), p.targets);
      }),
      // Sheet templates (§8.10 Templates): anyone at the table may start a character from one.
      "template.list": def(z.strictObject({}), MESSAGE_RATES["template.list"], ({ auth }) => {
        if (auth.role === "spectator") return [];
        return this.model
          .all("template")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((tpl) => ({
            id: tpl.id,
            name: tpl.name,
            createdBy: tpl.createdBy,
            blocks: tpl.blocks.length,
          }));
      }),
      // A client that lost track (a reconnect, a patch that didn't fit) gets its sheets whole again.
      "sheets.sync": def(z.strictObject({}), MESSAGE_RATES["sheets.sync"], ({ client, auth }) => {
        this.sheets.join(client, { userId: auth.userId, role: auth.role });
      }),
      // DMs: the campaign's proposals; players: their own.
      "proposal.list": def(z.strictObject({}), MESSAGE_RATES["proposal.list"], ({ auth }) => {
        const dm = auth.role === "admin" || auth.role === "dm";
        if (!dm && auth.role !== "player") return [];
        return this.proposals
          .list(this.campaignId, dm ? { limit: 100 } : { userId: auth.userId, limit: 50 })
          .map((pr) => this.proposalDto(pr));
      }),
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
      // The History panel (SPEC §8.14; DM): the list, Revert (with what it would override) and Restore to here (with
      // what it would revert) — each a dry run first when the panel asks for one.
      "history.list": def(
        z.strictObject({
          userId: z.string().min(1).max(64).optional(),
          family: z
            .string()
            .regex(/^[a-z]{1,24}$/)
            .optional(),
          sceneId: z.string().min(1).max(64).optional(),
          before: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        }),
        { capacity: 10, perSecond: 4 },
        ({ auth }, p): HistoryListResult => {
          this.requireDm(auth);
          const { rows, more } = this.bus.list(p);
          return {
            entries: rows.map((e) => this.historyView(e)),
            more,
            people: this.bus.people().map((id) => ({ id, name: this.nameOf(id) })),
            scenes: this.model.all("scene").map((s) => ({ id: s.id, name: s.name })),
          };
        },
      ),
      "history.revert": def(
        z.strictObject({
          id: z.number().int().positive(),
          dryRun: z.boolean().optional(),
          force: z.boolean().optional(),
        }),
        { capacity: 5, perSecond: 5 },
        ({ auth }, p) => {
          this.requireDm(auth);
          const e = this.bus.entry(p.id);
          if (!e) throw new GloamError("NOT_FOUND", "That change isn't in this table's history.");
          if (!e.undoable)
            throw new GloamError("INVALID", "That can't be reverted: it's a fact of the table.");
          if (e.undoneAt !== null) throw new GloamError("CONFLICT", "That change has already been undone.");
          const conflicts = this.bus.conflicts(e).map((x) => this.historyView(x));
          if (p.dryRun) return { changes: [this.historyView(e)], conflicts } satisfies HistoryRestorePlan;
          if (conflicts.length && !p.force)
            throw new GloamError(
              "CONFLICT",
              `${conflicts.length} later change${conflicts.length === 1 ? "" : "s"} touched the same things.`,
            );
          const r = this.bus.revert(p.id, this.actorFor(auth));
          return { entryId: r.id, summary: e.summary };
        },
      ),
      "history.restore": def(
        z.strictObject({ id: z.number().int().positive(), dryRun: z.boolean().optional() }),
        { capacity: 3, perSecond: 1 },
        ({ auth }, p) => {
          this.requireDm(auth);
          if (!this.bus.entry(p.id))
            throw new GloamError("NOT_FOUND", "That change isn't in this table's history.");
          if (p.dryRun)
            return {
              changes: this.bus.laterThan(p.id).map((x) => this.historyView(x)),
              conflicts: [],
            } satisfies HistoryRestorePlan;
          return { reverted: this.bus.restoreTo(p.id, this.actorFor(auth)) };
        },
      ),
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
      onEvents: (events, info) => this.deliver(events, info),
      onUndone: (e, actor) => this.health?.undone(e.id, actor.userId),
      fog: this.vision,
      sheet: { apply: (sheet, patch) => applyPatch(sheet, patch) },
    });
    registerCommands(this.bus);
    this.sheets = new SheetSync(model);
    this.proposals = new ProposalService(ctx.db);
    this.requests = new RequestService(ctx.db);
    this.prompts = new PromptService(ctx.db);
    this.health = new HealthFlow({
      campaignId: this.campaignId,
      model: () => this.model,
      bus: () => this.bus,
      prompts: () => this.prompts,
      requests: () => this.requests,
      toDms: (type, payload) => this.toDms(type, payload),
      toUser: (userId, type, payload) => this.toUser(userId, type, payload),
      actorOf: (userId) => this.actorOfUser(userId),
      ask: (r) => this.askForRules(r),
      sendRequest: (r) => this.sendRequest(r),
    });
    this.combat = new CombatFlow({
      campaignId: this.campaignId,
      model: () => this.model,
      bus: () => this.bus,
      viewers: () => this.combatViewers(),
      tokenView: (id) =>
        this.state.tokens.get(id) as unknown as import("@gloam/shared/state").TokenView | undefined,
      actorOf: (userId) => this.actorOfUser(userId),
      toDms: (type, payload) => this.toDms(type, payload),
      toUser: (userId, type, payload) => this.toUser(userId, type, payload),
      ask: (r) => this.askForRules(r),
      rollFor: (tokenId, formula, label) => this.rollForCombat(tokenId, formula, label),
      requestDeathSaves: (ids) => {
        const dm = [...this.clients]
          .map((c) => c.auth as ClientAuth | undefined)
          .find((a) => a && (a.role === "dm" || a.role === "admin"));
        try {
          this.health.requestDeathSaves(dm ? this.actorOfUser(dm.userId) : SYSTEM_ACTOR, ids);
        } catch {
          // none of them is dying after all
        }
      },
      log: (kind, text, data, visibility) =>
        this.fun.append(kind, text, { data, ...(visibility ? { visibility } : {}) }),
      closeAsked: (combatId) => {
        for (const r of this.requests.open(this.campaignId)) {
          const p = r.purpose as { kind?: string; combatId?: string } | undefined;
          if (p?.kind !== "initiative" || p.combatId !== combatId) continue;
          r.status = "closed";
          r.closedAt = Date.now();
          this.requests.save(r);
          this.sendRequest(r);
        }
      },
    });
    this.fun = new FunFlow({
      campaignId: this.campaignId,
      model: () => this.model,
      clients: () => this.clients,
      perceives: (c, tokenId) => {
        const role = (c.auth as ClientAuth | undefined)?.role;
        return role === "admin" || role === "dm" || Boolean(this.views.grantsOf(c)?.tokens.has(tokenId));
      },
    });
    this.audioTimer = new AudioTimer({
      model: () => this.model,
      bus: () => this.bus,
      durationOf: (assetId) => {
        const a = this.model.get("asset", assetId);
        return (a && roomCtx().assets.file(a.fileId)?.durationMs) || null;
      },
      onError: (err) => roomCtx().log.error({ err }, "the music's next track failed"),
    });
    this.audioTimer.changed();
    this.casts = new CastFlow({
      campaignId: this.campaignId,
      model: () => this.model,
      sees: (a, b) => this.tokenSees(a, b),
      bus: () => this.bus,
      viewers: () => this.castViewers(),
      actorOf: (userId) => this.actorOfUser(userId),
      askSaves: (createdBy, p) =>
        this.createRequest(createdBy, {
          targets: p.targets,
          type: "save",
          ability: p.ability,
          label: p.label,
          ...(p.dc !== undefined ? { dc: p.dc } : {}),
          showDc: p.showDc,
          adv: "none",
          visibility: p.visibility,
          purpose: { kind: "castSave", castId: p.castId },
        }),
      answerAsDm: (r, targetId, dmUserId) => this.answerAsDm(r, targetId, dmUserId),
      request: (id) => this.requests.get(id) ?? undefined,
      updateRequest: (r) => {
        this.requests.save(r);
        this.sendRequest(r);
      },
      roll: (userId, p) => this.rollFromCard(userId, p, null),
      reroll: (userId, rollId, die, p) => {
        const original = this.dice.get(this.campaignId, rollId);
        if (!original) throw new GloamError("NOT_FOUND", "That roll is gone.");
        const roller = this.rollerFor(userId);
        const token = p.tokenId ? this.model.get("token", p.tokenId) : undefined;
        const r = this.dice.reroll(
          this.campaignId,
          this.projector.activeSceneId || null,
          roller,
          original,
          die,
          {
            label: p.label,
            visibility: original.visibility,
            purpose: "cast",
            ...(token ? { token } : {}),
          },
        );
        this.deliverRoll(r, roller.dm);
        return r;
      },
      manual: (userId, p) =>
        this.rollFromCard(userId, p, p.values ? { values: p.values } : { total: p.total ?? 0 }),
    });
    this.effects = new EffectFlow({
      model: () => this.model,
      bus: () => this.bus,
      dmActor: () => {
        const dm = [...this.clients]
          .map((c) => c.auth as ClientAuth | undefined)
          .find((a) => a && (a.role === "dm" || a.role === "admin"));
        return dm ? this.actorOfUser(dm.userId) : SYSTEM_ACTOR;
      },
      toDms: (type, payload) => this.toDms(type, payload),
    });
    this.syncCampaign();
    this.views?.detachAll();
    this.projector = new StateProjector(this.state, this.projectionCtx());
    this.views = new ViewManager(this.state, model, this.vision);
    this.projector.loadActive();
    this.syncSensed();
    this.syncGlows();
    this.syncGlimpses();
    this.syncAllViews();
    // A reload (a restore) starts every client's sheets afresh.
    for (const [c, v] of this.viewerPairs()) this.sheets.join(c, v);
  }

  private *viewerPairs(): Generator<[Client, Viewer]> {
    for (const c of this.clients) {
      const v = this.viewerOf(c);
      if (v) yield [c, v];
    }
  }

  /** Players at the table now: their characters are the party. */
  private presentPlayers(): string[] {
    const out: string[] = [];
    for (const [userId, set] of this.clientsByUser) {
      const first = set.values().next().value as Client | undefined;
      if ((first?.auth as ClientAuth | undefined)?.role === "player") out.push(userId);
    }
    return out;
  }

  /** Characters of these players without a token on the active scene, placed round its party spawn (AC-SCN-06). */
  private placeParty(userIds: readonly string[]): void {
    const sceneId = this.projector.activeSceneId;
    if (!sceneId || !userIds.length) return;
    const actorIds = this.model
      .all("actor")
      .filter(
        (a) =>
          a.kind === "character" &&
          a.deletedAt === null &&
          a.ownerUserId !== null &&
          userIds.includes(a.ownerUserId),
      )
      .map((a) => a.id);
    if (!actorIds.length) return;
    try {
      this.bus.execute("party.place", { sceneId, actorIds }, SYSTEM_ACTOR);
    } catch (err) {
      roomCtx().log.error({ err }, "placing the party failed");
    }
  }

  private toUser(userId: string, type: string, payload: unknown): void {
    for (const c of this.clientsByUser.get(userId) ?? []) c.send(type, payload);
  }

  /** A roll request: each target's formula from its sheet, cards to its players, the board to the DMs. */
  private createRequest(
    createdBy: string,
    p: {
      targets: readonly string[];
      type: RollRequest["type"];
      ability?: RollRequest["ability"] | undefined;
      skill?: string | undefined;
      formula?: string | undefined;
      label?: string | undefined;
      dc?: number | undefined;
      showDc: boolean;
      adv: RollRequest["adv"];
      visibility: RollRequest["visibility"];
      purpose?: RollRequest["purpose"];
    },
  ): RollRequest {
    const base = requestFormula(p as Parameters<typeof requestFormula>[0]);
    // What kind of D20 Test it is, for the hints its conditions give (a death save is a saving throw).
    const kind: RollKind | null =
      p.type === "attack"
        ? "attack"
        : p.type === "custom"
          ? p.purpose?.kind === "deathSave"
            ? "save"
            : p.purpose?.kind === "initiative"
              ? "initiative"
              : null
          : p.type;
    // Initiative (§19.5): the surprised roll it with disadvantage (SRD 5.1 has none — its surprise loses a turn).
    const surprised =
      p.purpose?.kind === "initiative" && this.model.campaign.rulesPack !== "srd-5.1"
        ? new Set(p.purpose.surprised)
        : new Set<string>();
    const ability = p.type === "check" && p.skill ? SKILLS[p.skill as SkillId] : p.ability;
    const targets: RequestTarget[] = [...new Set(p.targets)].map((id) => {
      const x = this.requestTarget(id);
      // Its Frightened with the fear out of its sight: nothing (rules audit C7).
      const conds = conditionsBearing(x.status.conditions, {
        sees: (src) => (x.token ? this.tokenSees(x.token.id, src) : null),
      });
      const h = rollHints(
        conds,
        x.status.exhaustion,
        kind ?? "check",
        ability,
        {
          markers: x.status.markers.map((m) => m.id as string),
          ...(x.speedFt !== undefined ? { speedFt: x.speedFt } : {}),
        },
        this.model.campaign.rulesPack,
      );
      if (surprised.has(id)) h.dis.push({ from: "Surprised" });
      // Exhaustion takes 2 × its level off every D20 Test (AC-HP-05), in the formula for everyone to see; its markers
      // add theirs (Bless +1d4, Bane −1d4, Slow −2 on Dex saves — rules audit Q6).
      const formula = withTerms(
        withPenalty(targetFormula(base, creatureRefs(x.token, x.sheet), p.adv), h.penalty),
        h.extra.map((e) => e.term),
      );
      try {
        parseFormula(formula);
      } catch (e) {
        if (e instanceof DiceError) throw new GloamError("INVALID", e.message);
        throw e;
      }
      const mode = kind && isD20Test(formula) ? hintedMode(h) : "normal";
      return {
        ...x.target,
        formula,
        ...(mode !== "normal"
          ? { hint: { mode, from: (mode === "adv" ? h.adv : h.dis).map((x) => x.from) } }
          : {}),
        ...(kind === "save" && h.autoFail.length ? { autoFail: h.autoFail } : {}),
      };
    });
    const r = this.requests.create({
      campaignId: this.campaignId,
      createdBy,
      type: p.type,
      ...(p.ability ? { ability: p.ability } : {}),
      ...(p.skill ? { skill: p.skill as RollRequest["skill"] & string } : {}),
      label: requestLabel(p as Parameters<typeof requestLabel>[0]),
      ...(p.dc !== undefined ? { dc: p.dc } : {}),
      showDc: p.showDc,
      adv: p.adv,
      visibility: p.visibility,
      targets,
      ...(p.purpose ? { purpose: p.purpose } : {}),
    });
    this.sendRequest(r);
    return r;
  }

  /** A request the rules ask for (a concentration save, a death saving throw): the DC shown, no advantage. */
  private askForRules(r: SystemRequest): RollRequest {
    return this.createRequest(r.createdBy, {
      targets: r.targets,
      type: r.type,
      ...(r.ability ? { ability: r.ability } : {}),
      ...(r.formula ? { formula: r.formula } : {}),
      label: r.label,
      ...(r.dc !== undefined ? { dc: r.dc } : {}),
      showDc: r.dc !== undefined,
      adv: "none",
      visibility: r.visibility,
      purpose: r.purpose,
    });
  }

  /**
   * An answer to a request the rules asked for: what it brings (health.ts); and once every creature has answered,
   * the request closes (nothing more to wait for).
   */
  private answeredForRules(
    r: RollRequest,
    t: RequestTarget,
    res: RequestResponse,
    roll: RollRecord | null,
  ): void {
    if (!r.purpose) return;
    try {
      this.health.answered(r, t, res, roll);
      this.combat.answered(r, t, res);
      this.casts.answered(r, t, res);
    } catch (err) {
      roomCtx().log.error({ err }, "health follow-up of a roll failed");
    }
    // Answered by all — a roll still waiting on its roller (Heroic Inspiration) isn't, yet.
    if (r.targets.every((x) => r.responses[x.id]?.state !== "pending" && !r.responses[x.id]?.held)) {
      r.status = "closed";
      r.closedAt = Date.now();
    }
  }

  /**
   * Whether a roll waits on its roller (rules audit C4): its creature holds Heroic Inspiration (SRD 5.2.1's reroll —
   * 5.1's Inspiration is Advantage, taken before the roll), the request isn't blind (they'd reroll what they can't
   * see), and its dice can be rolled again one by one. Then the choice: keep it, or roll a die again.
   */
  private heldFor(
    r: RollRequest,
    sheet: Sheet | undefined,
    roll: RollRecord,
  ): RequestResponse["held"] | null {
    if (!sheet?.core.inspiration || r.visibility === "blind") return null;
    if (this.model.campaign.rulesPack === "srd-5.1") return null;
    const dice = rerollableDice(roll);
    return dice ? { dice } : null;
  }

  /** What a card adds for its roller: death saves so far, and (SRD 5.1) Inspiration to spend on it. */
  private cardExtra(r: RollRequest, t: RequestTarget): Partial<RequestCard> {
    const extra = this.health.cardExtra(r, t);
    if (this.model.campaign.rulesPack !== "srd-5.1" || r.responses[t.id]?.state !== "pending") return extra;
    return this.requestTarget(t.id).sheet?.core.inspiration ? { ...extra, inspiration: "advantage" } : extra;
  }

  /** Whether one creature sees another now (the vision service's answer; null where it can't say). */
  private tokenSees(fromId: string, toId: string): boolean | null {
    const a = this.model.get("token", fromId);
    const b = this.model.get("token", toId);
    return a && b && this.vision ? this.vision.tokenSees(a, b) : null;
  }

  /** A request's target: a token on the board or a character — its name, who answers for it, its sheet. */
  private requestTarget(id: string): {
    target: Omit<RequestTarget, "formula">;
    token?: TokenEntity;
    sheet?: Sheet;
    /** Its conditions and exhaustion now (hints and penalties for its rolls). */
    status: TokenStatusT;
    /** Its Speed now, on the board (Dodge lapses at 0). */
    speedFt?: number;
  } {
    const token = this.model.get("token", id);
    if (token) {
      const actor = token.actorId ? this.model.get("actor", token.actorId) : undefined;
      const sheet = actor && actor.deletedAt === null ? readSheet(actor) : undefined;
      const linked = actor && actor.deletedAt === null && token.link === "linked" ? actor : undefined;
      const { stats, status } = effectiveTokenState(token, linked);
      return {
        target: { id, kind: "token", name: token.name, controllers: this.playersAmong(token.ownerIds) },
        token,
        ...(sheet ? { sheet } : {}),
        status,
        speedFt: speedNowFt(token, stats, status, this.model.campaign.rulesPack),
      };
    }
    const actor = this.model.get("actor", id);
    if (actor && actor.deletedAt === null) {
      const sheet = readSheet(actor);
      return {
        target: {
          id,
          kind: "actor",
          name: sheet.core.name,
          controllers: this.playersAmong(actor.ownerUserId ? [actor.ownerUserId] : []),
        },
        sheet,
        status: statusFromActor(actor.status),
      };
    }
    throw new GloamError("NOT_FOUND", "That creature isn't here.");
  }

  /** Of these users, the campaign's players (DMs answer from their board, not a card). */
  private playersAmong(userIds: readonly string[]): string[] {
    const ctx = roomCtx();
    return userIds.filter((u) => ctx.campaigns.membership(this.campaignId, u) === "player");
  }

  private openTarget(requestId: string, targetId: string): { r: RollRequest; target: RequestTarget } {
    const r = this.requests.get(requestId);
    if (!r || r.campaignId !== this.campaignId)
      throw new GloamError("NOT_FOUND", "That request no longer exists.");
    if (r.status !== "open") throw new GloamError("CONFLICT", "That request is closed.");
    const target = r.targets.find((t) => t.id === targetId);
    if (!target) throw new GloamError("NOT_FOUND", "That creature wasn't asked.");
    return { r, target };
  }

  /** A request as it stands: each controller its targets' cards, DMs the whole board. */
  private sendRequest(r: RollRequest): void {
    for (const t of r.targets)
      for (const u of t.controllers) this.toUser(u, "request.card", cardFor(r, t, this.cardExtra(r, t)));
    this.toDms("request.status", r);
  }

  /** On joining: the open cards this person answers, or (DMs) the open requests. */
  private sendOpenRequests(client: Client, auth: ClientAuth): void {
    const open = this.requests.open(this.campaignId);
    if (auth.role === "admin" || auth.role === "dm") {
      for (const r of open) client.send("request.status", r);
      return;
    }
    for (const r of open)
      for (const t of r.targets)
        if (t.controllers.includes(auth.userId))
          client.send("request.card", cardFor(r, t, this.cardExtra(r, t)));
  }

  /** A proposal as it's shown: what approving it would change on the sheet now. */
  private proposalDto(p: Proposal) {
    const actor = this.model.get("actor", p.actorId);
    const live = actor && actor.deletedAt === null ? actor : undefined;
    const sheet = live ? readSheet(live) : null;
    return proposalView(
      p,
      {
        actor: sheet?.core.name ?? "A removed character",
        user: roomCtx().profiles.get(p.userId)?.displayName ?? "Someone",
      },
      sheet,
    );
  }

  projectionCtx(): ProjectionCtx {
    return {
      model: this.model,
      colorOf: (userId) => roomCtx().profiles.get(userId)?.color,
      // A combatant's turn for its controllers (§16.5): its budget, what it used, its pips, where its turn began.
      movementOf: (tokenId) => {
        const t = this.model.get("token", tokenId);
        if (!t) return undefined;
        const c = combatOn(this.model, t.sceneId);
        const m = movementOf(this.model, t);
        if (!c || !m) return undefined;
        const d = dataOf(c);
        const turn = d.turn?.tokenId === t.id ? d.turn : null;
        return {
          budgetFt: m.budget,
          usedFt: m.used,
          dashes: m.dashes,
          bonusMoveFt: m.bonus,
          pips: d.pips[t.id] ?? 0,
          segments: turn?.segments.length ?? 0,
          turnStart: turn ? { x: turn.turnStart.x, y: turn.turnStart.y } : { x: t.pos.x, y: t.pos.y },
          freeMovement: d.freeMovement || t.overrides.freeMovement === true,
        };
      },
    };
  }

  /** The state's public combat numbers (active, round, the turn's sequence) and the trackers, as they are now. */
  private syncCombatState(): void {
    const scene = this.model.activeScene;
    const c = scene ? combatOn(this.model, scene.id) : undefined;
    const cs = this.state.combat;
    const active = Boolean(c);
    const round = c ? c.round : 0;
    const turn = c ? `${c.round}:${c.turnIndex}:${dataOf(c).begun}` : "";
    if (cs.active !== active) cs.active = active;
    if (cs.round !== round) cs.round = round;
    if (turn !== this.lastTurn) {
      this.lastTurn = turn;
      cs.turnSeq = (cs.turnSeq + 1) % 4_000_000_000;
    }
    this.combat.sync();
  }
  private lastTurn = "";

  /**
   * An app-driven attack marks its creature's Action (AC-CMB-08) — the creature whose turn it is, rolled for by its
   * token or its character's token on the scene — once (Extra Attack's second swing uses the same Action).
   */
  private markActionFor(token: TokenEntity | undefined, actorId: string | undefined, auth: ClientAuth): void {
    const scene = this.model.activeScene;
    const c = scene ? combatOn(this.model, scene.id) : undefined;
    if (!c) return;
    const d = dataOf(c);
    const active = d.begun ? d.combatants[c.turnIndex]?.tokenId : undefined;
    const t = active ? this.model.get("token", active) : undefined;
    if (!t || !(token ? token.id === t.id : actorId && t.actorId === actorId && t.link === "linked")) return;
    if (((d.pips[t.id] ?? 0) & 1) !== 0) return;
    try {
      this.bus.execute("combat.pip", { tokenId: t.id, pip: "action", used: true }, this.actorFor(auth));
    } catch (err) {
      roomCtx().log.warn({ err }, "marking the action failed");
    }
  }

  /** Everyone at the table as the combat tracker sees them (§13.4): who they are and what they perceive. */
  private combatViewers(): CombatViewer[] {
    const out: CombatViewer[] = [];
    for (const c of this.clients) {
      const auth = c.auth as ClientAuth | undefined;
      if (!auth) continue;
      out.push({
        key: c,
        userId: auth.userId,
        dm: auth.role === "admin" || auth.role === "dm",
        spectator: auth.role === "spectator",
        perceives: (id) => this.views.grantsOf(c)?.tokens.has(id) ?? false,
        send: (type, payload) => c.send(type, payload),
      });
    }
    return out;
  }

  /** Everyone at the table as the resolution cards see them (the tracker's viewers). */
  private castViewers(): CastViewer[] {
    return this.combatViewers();
  }

  /** The homebrew spells, to each person as they may see them (after a change to them). */
  /**
   * The homebrew spells each person may see, after a change to them: only what changed for them (the whole list
   * went when they joined) — never the campaign's whole list again on every change (security review M5).
   */
  private readonly homebrewSent = new WeakMap<Client, Map<string, string>>();
  private homebrewOf(auth: ClientAuth) {
    return homebrewFor(
      this.model,
      { userId: auth.userId, dm: auth.role === "admin" || auth.role === "dm" },
      (u) => roomCtx().profiles.get(u)?.displayName ?? "someone",
    );
  }
  private sendHomebrewAll(c: Client, auth: ClientAuth): void {
    const list = this.homebrewOf(auth);
    this.homebrewSent.set(c, new Map(list.map((e) => [e.id, JSON.stringify(e)])));
    c.send("content.spells", list);
  }
  private sendHomebrew(): void {
    for (const c of this.clients) {
      const auth = c.auth as ClientAuth | undefined;
      if (!auth) continue;
      const had = this.homebrewSent.get(c);
      if (!had) {
        this.sendHomebrewAll(c, auth);
        continue;
      }
      const list = this.homebrewOf(auth);
      const now = new Map(list.map((e) => [e.id, JSON.stringify(e)]));
      const upsert = list.filter((e) => had.get(e.id) !== now.get(e.id));
      const remove = [...had.keys()].filter((id) => !now.has(id));
      this.homebrewSent.set(c, now);
      if (upsert.length || remove.length) c.send("content.spells.patch", { upsert, remove });
    }
  }

  /** Who rolls for a user (their dice skin and colour); a DM who isn't here rolls as "The DM". */
  private rollerFor(userId: string) {
    const auth = [...(this.clientsByUser.get(userId) ?? [])]
      .map((c) => c.auth as ClientAuth | undefined)
      .find((a) => a);
    return auth
      ? this.rollerOf(auth)
      : { userId, name: "The DM", color: BOARD_COLORS.brass400, skin: DEFAULT_SKIN, dm: true };
  }

  /** A roll from a resolution card (an attack, the damage): rolled, or a total entered; the table sees it. */
  private rollFromCard(
    userId: string,
    p: { formula: string; label: string; visibility: "public" | "dm"; tokenId?: string },
    entered: { total: number } | { values: number[] } | null,
  ): RollRecord {
    const roller = this.rollerFor(userId);
    const token = p.tokenId ? this.model.get("token", p.tokenId) : undefined;
    const opts = {
      formula: p.formula,
      label: p.label,
      visibility: p.visibility,
      purpose: "cast",
      ...(token ? { token } : {}),
    };
    const r =
      entered === null
        ? this.dice.roll(this.campaignId, this.projector.activeSceneId || null, roller, opts)
        : this.dice.manual(this.campaignId, this.projector.activeSceneId || null, roller, {
            ...opts,
            ...entered,
          });
    this.deliverRoll(r, roller.dm);
    return r;
  }

  /** The DM rolls a request's target (its formula with its hints), as the request board's Roll does. */
  private answerAsDm(r: RollRequest, targetId: string, dmUserId: string): void {
    const target = r.targets.find((t) => t.id === targetId);
    if (!target || r.responses[target.id]?.state !== "pending") return;
    const x = this.requestTarget(target.id);
    const roller = this.rollerFor(dmUserId);
    const roll = this.dice.roll(this.campaignId, this.projector.activeSceneId || null, roller, {
      formula: hinted(target, false),
      visibility: r.visibility === "public" ? "public" : "dm",
      label: `${target.name} · ${r.label}`,
      purpose: "request",
      ...(x.token ? { token: x.token } : {}),
    });
    this.deliverRoll(roll, true);
    const res: RequestResponse = {
      state: "dm",
      rollId: roll.id,
      formula: roll.normalized || roll.formula,
      total: roll.total,
      by: dmUserId,
      ...(r.dc !== undefined ? { success: roll.total >= r.dc } : {}),
    };
    r.responses[target.id] = res;
    this.answeredForRules(r, target, res, roll);
    this.requests.save(r);
    this.sendRequest(r);
  }

  /** The server rolls a creature's initiative (the NPCs, or everyone): a DM's roll, seen as the DM's rolls are. */
  private rollForCombat(tokenId: string, formula: string, label: string): number {
    const token = this.model.get("token", tokenId);
    const dmAuth = [...this.clients]
      .map((c) => c.auth as ClientAuth | undefined)
      .find((a) => a && (a.role === "dm" || a.role === "admin"));
    const roller = dmAuth
      ? this.rollerOf(dmAuth)
      : { userId: "system", name: "The DM", color: BOARD_COLORS.brass400, skin: DEFAULT_SKIN, dm: true };
    const roll = this.dice.roll(this.campaignId, this.projector.activeSceneId || null, roller, {
      formula,
      visibility: "dm",
      label,
      purpose: "initiative",
      ...(token ? { token } : {}),
    });
    this.deliverRoll(roll, true);
    return roll.total;
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
    // What each person perceives changed: their tracker with it (§13.4 "Combat tracker").
    this.combat?.sync();
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
  /** An entry as the History panel shows it: names for its person, its scene and who undid it. */
  private historyView(e: HistoryEntry): HistoryListEntry {
    const scene = e.sceneId ? this.model.get("scene", e.sceneId) : null;
    return {
      id: e.id,
      at: e.createdAt,
      userId: e.userId,
      userName: this.nameOf(e.userId),
      actingAs: e.actingAs,
      type: e.type,
      summary: e.summary,
      sceneId: e.sceneId,
      sceneName: scene?.name ?? null,
      undoable: e.undoable,
      undoneAt: e.undoneAt,
      undoneByName: e.undoneBy ? this.nameOf(e.undoneBy) : null,
    };
  }

  private nameOf(userId: string): string {
    return roomCtx().profiles.get(userId)?.displayName ?? "someone";
  }

  /** The DMs' History panels hear that it changed (at most every 400 ms: a batch of commands is one refresh). */
  private historyPing: ReturnType<typeof setTimeout> | null = null;
  private historyChanged(): void {
    if (this.historyPing) return;
    this.historyPing = setTimeout(() => {
      this.historyPing = null;
      this.toDms("history.changed", {});
    }, 400);
  }

  private onCommitted(info: CommitInfo): void {
    this.historyChanged();
    try {
      this.fun?.committed(info);
    } catch (err) {
      roomCtx().log.error({ err }, "the campaign log's entries failed");
    }
    // The audio changed other than by its own commands (an undo, a revert): everyone gets it as it now is.
    if (
      !info.type.startsWith("audio.") &&
      info.ops.some(
        (o) => o.k === "set" && o.e === "campaign" && o.path[0] === "settings" && o.path[1] === "audio",
      )
    ) {
      const audio = campaignAudio({ model: this.model });
      for (const c of this.clients) c.send(AUDIO_SYNC, this.audioFor(c, audio));
      this.audioTimer.changed();
    }
    if (info.ops.some((o) => (o.k === "set" || o.k === "create") && o.e === "campaign")) this.syncCampaign();
    // A scene's DM notes changed (an edit, an undo): the DMs' copies follow; no one else is told.
    for (const o of info.ops)
      if (o.k === "set" && o.e === "scene" && o.path[0] === "dmNotes")
        this.toDms("scene.notes", { sceneId: o.id, notes: (o.value as string | undefined) ?? "" });
    const active = this.model.activeScene;
    const nextActive = active && !active.deletedAt ? active.id : "";
    if (nextActive !== this.projector.activeSceneId) this.views.detachAll();
    const res = this.projector.apply(info.ops);
    // Combat (§13.3): its public numbers in the state, and each person's tracker — after a change to it, or to a
    // creature in it (a name, HP as its display shows it).
    const combatTouched = info.ops.some((o) => o.k !== "fog" && o.k !== "sheet" && o.e === "combat");
    if (combatTouched || res.activeChanged) this.syncCombatState();
    const seen = this.vision.onCommitted(info.ops);
    if (seen) this.syncSensed();
    // Carriers move and lights change without anyone's perception changing: the stand-ins follow every commit.
    this.syncGlows();
    this.syncGlimpses();
    if (res.switched) {
      // Everyone travels (SPEC §8.3): DMs who were prepping the new active scene now see it live.
      for (const [client, sceneId] of this.prepSubs) if (sceneId === nextActive) this.prepSubs.delete(client);
    }
    if (res.activeChanged || seen) this.syncAllViews();
    else if (
      this.state.combat.active &&
      !combatTouched &&
      info.ops.some((o) => o.k === "sheet" || (o.k !== "fog" && (o.e === "token" || o.e === "actor")))
    )
      this.combat.sync();
    this.vision.deliverFog();
    // Resolution cards (§8.13): the ones that changed; all of them when a creature on one did (its HP preview).
    const castIds = info.ops
      .filter((o) => o.k !== "fog" && o.k !== "sheet" && o.e === "cast")
      .map((o) => (o as { id: string }).id);
    if (castIds.length) this.casts.push([...new Set(castIds)]);
    else {
      // A creature changed (moved, hurt, its sheet): the open cards it's on — as caster or row — again; a wall or
      // door: every open card (lines and cover). Never the campaign's closed ones (security review M5).
      const open = this.model.all("cast").filter((c) => c.status === "open");
      if (open.length) {
        const walls = info.ops.some((o) => o.k !== "fog" && o.k !== "sheet" && o.e === "wall");
        const touched = new Set<string>();
        for (const o of info.ops) {
          if (o.k === "fog") continue;
          const actorId = o.k === "sheet" ? o.actorId : o.e === "actor" ? o.id : null;
          if (actorId) for (const t of this.model.all("token")) if (t.actorId === actorId) touched.add(t.id);
          if (o.k !== "sheet" && o.e === "token") touched.add(o.id);
        }
        const ids = open
          .filter(
            (c) =>
              walls ||
              (c.data.caster.tokenId !== null && touched.has(c.data.caster.tokenId)) ||
              c.data.targets.some((t) => touched.has(t.id)),
          )
          .map((c) => c.id);
        if (ids.length) this.casts.push(ids);
      }
    }
    if (info.ops.some((o) => o.k !== "fog" && o.k !== "sheet" && o.e === "content")) this.sendHomebrew();
    // A concentration that ended takes what it held up with it (§8.13; AC-SPL-07) — in the same undo step.
    if (info.type !== "history.undo" && info.type !== "history.redo")
      for (const ended of concentrationsEnded(info.ops)) {
        const entry = info.entry?.id;
        queueMicrotask(() => {
          try {
            this.bus.execute(
              "concentration.cleanup",
              ended,
              info.actor,
              entry !== undefined ? { joinEntry: entry } : {},
            );
          } catch (err) {
            roomCtx().log.error({ err }, "concentration's cleanup failed");
          }
        });
      }
    for (const [sceneId, patch] of res.prep) {
      for (const [client, sub] of this.prepSubs) if (sub === sceneId) client.send("prep.patch", patch);
    }
    if (info.ops.some((o) => o.k !== "fog" && o.k !== "sheet" && o.e === "scene"))
      this.toDms("scene.list", this.sceneList());
    const assetIds = new Set<string>();
    for (const o of info.ops) if (o.k !== "fog" && o.k !== "sheet" && o.e === "asset") assetIds.add(o.id);
    if (assetIds.size) this.notifyAssets([...assetIds], info.type);
    this.sheets.sync(info.ops, this.viewerPairs());
    // The party follows the table (AC-SCN-06): into a scene made active, and a character made for someone at the
    // table onto the scene now — after this command, not inside it.
    if (info.type !== "party.place") {
      const present = this.presentPlayers();
      const owners = res.switched
        ? present
        : info.ops
            .filter((o) => o.k === "create" && o.e === "actor")
            .map((o) => (o as { value: ActorEntity }).value)
            .filter(
              (a) => a.kind === "character" && a.ownerUserId !== null && present.includes(a.ownerUserId),
            )
            .map((a) => a.ownerUserId as string);
      if (owners.length) queueMicrotask(() => this.placeParty(owners));
    }
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
      // (Only to players with a reason to see it — assetVisibleTo; others fetch its view when they come to need it.)
      for (const c of this.clients) {
        const auth = c.auth as ClientAuth | undefined;
        if (!auth || auth.role === "admin" || auth.role === "dm" || auth.userId === dto.uploaderId) continue;
        if (!this.assetVisibleTo(auth.userId, id)) continue;
        c.send("asset.render", { asset: view });
      }
    }
  }
  /** The last render view sent to players per asset (only real changes go out). */
  private readonly renderSent = new Map<string, string>();

  /**
   * Whether an asset is one this player has a reason to see now (security review M2): the live scene's map, a token
   * in their view (its art, portrait or mini), a handout they hold, a picture on a sheet they may read, the track
   * playing, or their own upload. A DM's secret boss mini, a handout meant for someone else, the map of a scene in prep
   * and the rest of the Library stay the DM's — they were announced to every player and could be fetched by any.
   */
  assetVisibleTo(userId: string, assetId: string): boolean {
    const model = this.model;
    const scene = model.get("scene", this.projector.activeSceneId);
    if (scene?.mapAssetId === assetId) return true;
    const clients = this.clientsByUser.get(userId) ?? [];
    for (const c of clients)
      for (const id of this.views.grantsOf(c)?.tokens.keys() ?? []) {
        const a = model.get("token", id)?.appearance;
        if (a && (a.assetId === assetId || a.portraitAssetId === assetId)) return true;
      }
    for (const h of model.all("handout")) if (h.imageAssetId === assetId && holds(h, userId)) return true;
    const viewer = { userId, role: "player" as const };
    for (const a of model.all("actor")) {
      if (!this.sheets.mayRead(viewer, a)) continue;
      const core = readSheet(a).core;
      if (core.portraitAssetId === assetId || core.tokenAssetId === assetId) return true;
    }
    return campaignAudio({ model }).music.trackId === assetId;
  }

  /** The campaign's audio as someone at the table gets it: players the playing, not the DM's playlists. */
  private audioFor(c: Client, state: ReturnType<typeof campaignAudio>): unknown {
    const role = (c.auth as ClientAuth | undefined)?.role;
    return role === "admin" || role === "dm" ? state : { ...state, playlists: [] };
  }

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
    const actor: CommandActor = {
      userId: auth.userId,
      role: auth.role,
      name: auth.name,
      actingAs: isDm(auth.role) ? (this.actingAs.get(auth.userId) ?? null) : null,
    };
    // What a player may aim at: the tokens one of their connections can see now (§13.4).
    if (auth.role === "player" || auth.role === "spectator")
      actor.sees = (tokenId) =>
        [...(this.clientsByUser.get(auth.userId) ?? [])].some((c) =>
          this.views.grantsOf(c)?.tokens.has(tokenId),
        );
    return actor;
  }

  /** Someone at this table as a command's actor, by id (their membership role and profile name now). */
  private actorOfUser(userId: string): CommandActor {
    const ctx = roomCtx();
    const role = ctx.campaigns.membership(this.campaignId, userId);
    if (!role) return SYSTEM_ACTOR;
    return { userId, role, name: ctx.profiles.get(userId)?.displayName ?? "someone", actingAs: null };
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
    this.sheets.join(client, { userId: auth.userId, role: auth.role });
    this.sendOpenRequests(client, auth);
    if (auth.role === "admin" || auth.role === "dm")
      for (const p of this.health.list()) client.send("prompt.update", p);
    const cv = this.combatViewers().find((v) => v.key === client);
    if (cv) this.combat.join(cv);
    // Their open resolution cards, and the campaign's homebrew spells as they may see them.
    if (cv) this.casts.join(cv);
    this.sendHomebrewAll(client, auth);
    // What's playing and the ambience, to join it where it is (SPEC §25.3: a late joiner starts at the position).
    client.send(AUDIO_SYNC, this.audioFor(client, campaignAudio({ model: this.model })));
    client.send("welcome", {
      userId: auth.userId,
      role: auth.role,
      name: auth.name,
      color: auth.color,
      campaignId: this.campaignId,
      serverNow: Date.now(),
      // Their own quick phrases (SPEC §8.18), as their profile keeps them.
      phrases: this.fun.phrasesOf(auth.userId),
    });
    if (auth.role === "admin" || auth.role === "dm") client.send("knocks", ctx.people.pending());
    // An admitted player's characters join them on the board (AC-SCN-06).
    if (auth.role === "player") this.placeParty([auth.userId]);
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
    this.sheets.leave(client);
    this.prepSubs.delete(client);
    client.view?.dispose();
    if (!auth) return;
    const set = this.clientsByUser.get(auth.userId);
    set?.delete(client);
    if (!set || set.size === 0) {
      this.clientsByUser.delete(auth.userId);
      // Gone from the table: whoever they were acting as is back in their player's hands.
      const acting = this.actingAs.get(auth.userId);
      if (acting) {
        this.actingAs.delete(auth.userId);
        this.actingChanged(auth, acting.actorId);
      }
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
    this.audioTimer?.stop();
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
    // Acting as a character (AC-DMP-03): the roll is the character's — its name, its player's colour, not a DM's roll
    // (never masked as "The DM rolls…"); the card says who rolled it for them.
    const acting = isDm(auth.role) ? this.actingAs.get(auth.userId) : undefined;
    if (acting) {
      const a = this.model.get("actor", acting.actorId);
      const owner = a?.ownerUserId ? roomCtx().profiles.get(a.ownerUserId) : undefined;
      return {
        userId: auth.userId,
        name: acting.name,
        color: owner?.color ?? user?.color ?? auth.color,
        skin,
        dm: false,
        actingAs: acting.name,
      };
    }
    return {
      userId: auth.userId,
      name: user?.displayName ?? auth.name,
      color: user?.color ?? auth.color,
      skin,
      dm: auth.role === "admin" || auth.role === "dm",
    };
  }

  /**
   * Tells the table who is acting as whom (AC-DMP-03): every DM, and the players of the character taken or let go (so
   * a player knows the DM has their character's controls). Returns the acting DM's view of it.
   */
  private actingChanged(auth: ClientAuth, previousActorId: string | null): ActingAsView {
    const now = this.actingAs.get(auth.userId) ?? null;
    const view: ActingAsView = {
      userId: auth.userId,
      dmName: auth.name,
      actorId: now?.actorId ?? null,
      name: now?.name ?? null,
    };
    this.toDms("act.as", view);
    const owners = new Set<string>();
    for (const id of [previousActorId, now?.actorId ?? null]) {
      const a = id ? this.model.get("actor", id) : undefined;
      if (a?.ownerUserId) owners.add(a.ownerUserId);
    }
    for (const u of owners) if (u !== auth.userId) this.toUser(u, "act.as", view);
    return view;
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

  /**
   * Effect stand-ins in the state (§13.4): exactly the ones someone holds, each drawn from its effect as it is now
   * (an emanation's area follows its unseen creature — to the foot, never its id).
   */
  private readonly glimpseIds = new Set<string>();
  private syncGlimpses(): void {
    const want = new Map(this.vision.allGlimpses().map((g) => [g.id, g.effectId] as const));
    for (const id of [...this.glimpseIds])
      if (!want.has(id)) {
        this.projector.removeGlimpse(id);
        this.glimpseIds.delete(id);
      }
    for (const [id, effectId] of want) {
      const e = this.model.get("effect", effectId);
      if (!e) continue;
      this.projector.upsertGlimpse(effectGlimpseView(effectView(e, this.projectionCtx()), id));
      this.glimpseIds.add(id);
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
  private deliver(events: RoomEvent[], info?: CommitInfo): void {
    for (const e of events) {
      // A short rest's Hit Dice: each character's first card.
      if (e.name === REST_FOLLOWUPS) {
        const f = e.payload as RestFollowups;
        for (const actorId of f.actors)
          try {
            this.health.askHitDie(actorId, f.by);
          } catch (err) {
            roomCtx().log.error({ err }, "hit dice card failed");
          }
        continue;
      }
      // A health command's prompts and concentration saves (created after its commit, remembering its entry).
      if (e.name === FOLLOWUPS) {
        try {
          this.health.followups(e.payload as Followups, info?.entry?.id ?? null);
        } catch (err) {
          roomCtx().log.error({ err }, "health follow-ups failed");
        }
        continue;
      }
      // A cast's follow-ups (§8.13): save cards, the VFX, its line.
      // A command's line for the campaign log (a handout shown).
      if (e.name === "log.append") {
        const l = e.payload as { kind: string; text: string; visibility?: string };
        this.fun.append(l.kind, l.text, { ...(l.visibility ? { visibility: l.visibility } : {}) });
        continue;
      }
      if (e.name === CAST_FOLLOWUP) {
        try {
          this.casts.followup(e.payload as CastFollowup, info?.actor.userId ?? "system");
        } catch (err) {
          roomCtx().log.error({ err }, "cast follow-up failed");
        }
        continue;
      }
      // An effect moved (the DM's drag, its caster's, a drift): whoever it now covers (its "enter" trigger).
      if (e.name === "effect.moved") {
        try {
          const m = e.payload as {
            effectId: string;
            before: import("@gloam/shared/schemas").AreaShape;
            rammed?: string;
          };
          this.effects.effectMoved(m.effectId, m.before, m.rammed);
        } catch (err) {
          roomCtx().log.error({ err }, "an effect's move follow-up failed");
        }
        continue;
      }
      // Combat's cues: initiative to find, a turn's processing, the summary when it stops.
      if (e.name === COMBAT_COLLECT || e.name === COMBAT_TURN || e.name === COMBAT_STOPPED) {
        try {
          if (e.name === COMBAT_COLLECT)
            this.combat.collect(e.payload as CombatCollect, info?.actor.userId ?? "system");
          else if (e.name === COMBAT_TURN) {
            this.combat.turn(e.payload as CombatTurn);
            // The effects' part of a turn: triggers inside them, what ran out, drifts (§8.13).
            this.effects.turn(e.payload as CombatTurn);
          } else this.combat.stopped(e.payload as CombatStopped);
        } catch (err) {
          roomCtx().log.error({ err, event: e.name }, "combat follow-up failed");
        }
        continue;
      }
      if (e.name === "token.moved" && "viewersOf" in e.to) {
        const m = e.payload as { id: string; path: { x: number; y: number }[]; durationMs: number };
        this.deliverMove(m);
        // The effects it walked into or through (their "enter" and per-5-ft triggers).
        try {
          this.effects.moved(m.id, m.path);
        } catch (err) {
          roomCtx().log.error({ err }, "effects after a move failed");
        }
        continue;
      }
      if ("viewersOf" in e.to) this.toViewersOf(e.to.viewersOf, e.name, e.payload);
      else if ("all" in e.to) {
        const skip = new Set(e.to.exceptUsers ?? []);
        for (const c of this.clients)
          if (!skip.has((c.auth as ClientAuth | undefined)?.userId ?? ""))
            c.send(
              e.name,
              e.name === AUDIO_SYNC
                ? this.audioFor(c, e.payload as ReturnType<typeof campaignAudio>)
                : e.payload,
            );
        if (e.name === AUDIO_SYNC) this.audioTimer.changed();
      } else if ("users" in e.to)
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

  /** An entry for the campaign log from outside the room (the local API): logged, and to its readers at once. */
  appendLog(kind: string, text: string, data: Record<string, unknown>): void {
    this.fun.append(kind, text, { data });
  }

  /** Someone's profile changed (the Admin renamed them): their presence follows at once. */
  profileChanged(userId: string): void {
    const p = this.state.presence.get(userId);
    const user = roomCtx().profiles.get(userId);
    if (!p || !user) return;
    p.name = user.displayName;
    p.color = user.color;
  }

  /**
   * Reassigns everything a person played here to someone else (or no one — the DM's): their characters' ownership and
   * their place among each token's owners, through the bus like any change (as the Admin), so the table sees it at
   * once and the history has it.
   */
  reassignOwner(fromUserId: string, toUserId: string | null, adminUserId: string): void {
    const actor = this.actorOfUser(adminUserId);
    for (const a of this.model.all("actor"))
      if (a.ownerUserId === fromUserId && a.deletedAt === null)
        this.bus.execute("actor.setOwner", { actorId: a.id, ownerUserId: toUserId }, actor);
    for (const t of this.model.all("token"))
      if (t.ownerIds.includes(fromUserId)) {
        const ownerIds = [...new Set(t.ownerIds.map((u) => (u === fromUserId ? toUserId : u)))].filter(
          (u): u is string => Boolean(u),
        );
        this.bus.execute("token.update", { tokenId: t.id, ownerIds }, actor);
      }
  }

  onlineUserIds(): Set<string> {
    return new Set(this.clientsByUser.keys());
  }

  async reloadFromDatabase(): Promise<void> {
    this.loadModel();
    this.broadcastAll("table.resync", {});
    // A restore carries the audio as it was then.
    this.broadcastAll(AUDIO_SYNC, campaignAudio({ model: this.model }));
    this.audioTimer.changed();
  }

  audioChanged(): void {
    this.audioTimer.changed();
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

/** A request target's formula with the hint its conditions give — unless the roller set it aside (AC-DICE-11). */
function hinted(t: RequestTarget, ignore: boolean | undefined): string {
  return t.hint && !ignore ? withHint(t.formula, t.hint.mode) : t.formula;
}
