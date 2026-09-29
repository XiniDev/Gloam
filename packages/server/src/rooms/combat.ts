/**
 * The room's half of combat (SPEC §8.12, §13.4 "Combat tracker"): the tracker as each person may see it (only the
 * combatants they perceive or control; "Unknown" in the others' places if the DM reveals the count); initiative found
 * — the players' cards, the server's rolls for the NPCs (one per group of identical creatures) — and what each turn
 * brings: at its start, a dying character's death saving throw, the hazards the creature stands in, what burns it,
 * and what has run out (a condition or marker lasting until a round); at its end, the hazards again; the "your turn"
 * chime and banner for its players; and when combat stops, its summary in the campaign log.
 */

import { hazardPrompts } from "@gloam/shared/movement";
import type { CombatView, CombatViewEntry } from "@gloam/shared/protocol";
import { type CombatantEntry, durationExpired, statusName } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import type { RequestResponse, RequestTarget, RollRequest } from "../dice/requests.ts";
import type { CommandActor, CommandBus, CommandCtx } from "../engine/commandBus.ts";
import {
  type CombatCollect,
  type CombatStopped,
  type CombatTurn,
  combatOn,
  dataOf,
  initiativeModeOf,
  initiativeModOf,
} from "../engine/commands/combat.ts";
import { holderOf } from "../engine/commands/health.ts";
import { SYSTEM_ACTOR } from "../engine/commands/party.ts";
import type { CampaignModel } from "../engine/model.ts";
import type { SystemRequest } from "./health.ts";
import { roomCtx } from "./roomContext.ts";

/** Someone at the table, as the tracker sees them. */
export interface CombatViewer {
  /** The view's key (a connection): the same person on two devices gets the same view twice. */
  key: object;
  userId: string;
  dm: boolean;
  spectator: boolean;
  /** Whether this person perceives a token now (their view, §13.4). */
  perceives(tokenId: string): boolean;
  send(type: string, payload: unknown): void;
}

export interface CombatHost {
  readonly campaignId: string;
  model(): CampaignModel;
  bus(): CommandBus;
  viewers(): Iterable<CombatViewer>;
  /** A token as the room projects it (its public HP fraction or band, its art). */
  tokenView(tokenId: string): TokenView | undefined;
  actorOf(userId: string): CommandActor;
  toDms(type: string, payload: unknown): void;
  toUser(userId: string, type: string, payload: unknown): void;
  /** Asks creatures for a roll (cards to their players, the board to the DMs). */
  ask(r: SystemRequest): RollRequest;
  /** The server rolls for a creature (an NPC's initiative), seen as the DM's roll. */
  rollFor(tokenId: string, formula: string, label: string): number;
  /** Death saving throws for the dying among these (health.ts). */
  requestDeathSaves(tokenIds: string[]): void;
  /** Appends to the campaign log (the combat's summary). */
  log(kind: string, text: string, data: Record<string, unknown>): void;
}

/** A combatant's players: its token's owners (a linked character's owner is among them). */
function controllersOf(model: CampaignModel, tokenId: string): string[] {
  return model.get("token", tokenId)?.ownerIds ?? [];
}

export class CombatFlow {
  private readonly host: CombatHost;
  /** What each connection was last sent (a view is re-sent only when it changed). */
  private readonly sent = new WeakMap<object, string>();

  constructor(host: CombatHost) {
    this.host = host;
  }

  private ctx(actor: CommandActor = SYSTEM_ACTOR): CommandCtx {
    return { actor, model: this.host.model(), app: roomCtx(), now: Date.now() };
  }

  private combat() {
    const scene = this.host.model().activeScene;
    return scene ? combatOn(this.host.model(), scene.id) : undefined;
  }

  // ── the tracker ──────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The tracker for one person (§13.4): the DM the whole list; a player the combatants they perceive or control, and
   * — only if the DM reveals the count — an "Unknown" in each other place (no ids); a spectator what any player sees.
   */
  viewFor(v: CombatViewer): CombatView {
    const c = this.combat();
    if (!c)
      return { active: false, begun: false, round: 0, entries: [], activeIndex: -1, freeMovement: false };
    const d = dataOf(c);
    const model = this.host.model();
    const rules = model.campaign;
    const revealCount =
      rules.houseRules.hiddenCombatants === "unknown" || rules.settings.revealHiddenCombatantCount === true;
    const entries: CombatViewEntry[] = [];
    let activeIndex = -1;
    d.combatants.forEach((e, i) => {
      const mine = controllersOf(model, e.tokenId).includes(v.userId);
      const known = v.dm || mine || v.perceives(e.tokenId);
      const active = d.begun && i === c.turnIndex;
      if (!known) {
        if (!revealCount) return;
        if (active) activeIndex = entries.length;
        entries.push({ key: `u${i}`, name: "Unknown", unknown: true });
        return;
      }
      if (active) activeIndex = entries.length;
      entries.push(this.entryView(e, i, v.dm, mine));
    });
    return {
      active: true,
      begun: d.begun,
      round: c.round,
      entries,
      activeIndex,
      ...(v.dm ? { method: d.method } : {}),
      freeMovement: d.freeMovement,
    };
  }

  private entryView(e: CombatantEntry, i: number, dm: boolean, mine: boolean): CombatViewEntry {
    const t = this.host.tokenView(e.tokenId);
    const portrait = t?.portraitAssetId || t?.assetId;
    return {
      key: `c${i}:${e.tokenId}`,
      tokenId: e.tokenId,
      name: t?.name ?? e.name,
      ...(portrait ? { portraitAssetId: portrait } : {}),
      ...(e.initiative !== null ? { initiative: e.initiative } : {}),
      unknown: false,
      // HP as its display mode lets this person see it (the token's own public fields: a bar's fraction, a band).
      ...(t && t.hpFrac >= 0 ? { hpFrac: t.hpFrac } : {}),
      ...(t && t.hpFrac < 0 && t.hpBand !== 255 ? { hpBand: t.hpBand } : {}),
      ...(mine ? { mine: true } : {}),
      ...(e.initiative === null ? { pending: true } : {}),
      ...(dm && e.group ? { group: e.group } : {}),
      ...(dm && e.surprised ? { surprised: true } : {}),
      pc: e.pc,
    };
  }

  /** Sends each person their tracker, where it changed (after a commit, a view change, a join). */
  sync(): void {
    for (const v of this.host.viewers()) {
      const view = this.viewFor(v);
      const json = JSON.stringify(view);
      if (this.sent.get(v.key) === json) continue;
      this.sent.set(v.key, json);
      v.send("combat.view", view);
    }
  }

  /** A connection joined (or re-joined): its tracker, whatever it had before. */
  join(v: CombatViewer): void {
    const view = this.viewFor(v);
    this.sent.set(v.key, JSON.stringify(view));
    v.send("combat.view", view);
  }

  // ── initiative ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Finding initiative (§8.12): the players' creatures get cards (Roll / Enter / Skip, with their hints); the
   * NPCs are rolled by the server now when asked (quick start, "Roll for everyone", a creature added), one roll per
   * group of identical creatures — otherwise they wait for the DM's "Roll NPCs". "Roll for everyone" rolls the
   * players' too.
   */
  collect(e: CombatCollect, by: string): void {
    const c = this.combat();
    if (!c || c.id !== e.combatId) return;
    const d = dataOf(c);
    const model = this.host.model();
    const wanted = d.combatants.filter((x) => e.tokenIds.includes(x.tokenId) && x.initiative === null);
    const played = (x: CombatantEntry) => controllersOf(model, x.tokenId).length > 0;
    const toRoll = wanted.filter((x) => e.method === "rollAll" || (e.rollNpcs && !played(x)));
    const toAsk = e.method === "rollAll" ? [] : wanted.filter(played);
    if (toAsk.length) this.ask(toAsk, by);
    if (toRoll.length)
      this.rollInitiative(
        toRoll.map((x) => x.tokenId),
        by,
      );
  }

  /** Initiative cards for players' creatures: 1d20 + their initiative modifier, with their hints. */
  private ask(entries: CombatantEntry[], by: string): void {
    const c = this.combat();
    if (!c) return;
    this.host.ask({
      targets: entries.map((e) => e.tokenId),
      type: "custom",
      formula: "1d20 + @init",
      label: "Initiative",
      visibility: "public",
      createdBy: by,
      purpose: {
        kind: "initiative",
        combatId: c.id,
        surprised: entries.filter((e) => e.surprised).map((e) => e.tokenId),
      },
    });
  }

  /**
   * The server's rolls for these (the NPCs, or everyone): one per group of identical creatures, each with its hints
   * — then into the order (turns begin once everyone's is known).
   */
  rollInitiative(tokenIds: string[], by: string): void {
    const c = this.combat();
    if (!c) return;
    const d = dataOf(c);
    const ctx = this.ctx();
    const values: Record<string, number> = {};
    const groupRoll = new Map<string, number>();
    for (const id of tokenIds) {
      const e = d.combatants.find((x) => x.tokenId === id);
      const t = ctx.model.get("token", id);
      if (!e || !t) continue;
      const shared = e.group ? groupRoll.get(e.group) : undefined;
      if (shared !== undefined) {
        values[id] = shared;
        continue;
      }
      const mod = initiativeModOf(ctx, t);
      const { mode } = initiativeModeOf(ctx, t, e.surprised === true);
      const formula = `1d20${mod ? ` ${mod < 0 ? "-" : "+"} ${Math.abs(mod)}` : ""}${mode === "normal" ? "" : ` ${mode}`}`;
      const label = e.group ? `Initiative · ${e.name} (and their kind)` : `Initiative · ${e.name}`;
      const v = this.host.rollFor(id, formula, label);
      values[id] = v;
      if (e.group) groupRoll.set(e.group, v);
    }
    // The rest of a group rolled for by one of them take its roll.
    for (const e of d.combatants)
      if (e.group && groupRoll.has(e.group) && tokenIds.includes(e.tokenId))
        values[e.tokenId] = groupRoll.get(e.group) as number;
    if (Object.keys(values).length)
      this.host.bus().execute("combat.initiative", { values, begin: false }, this.host.actorOf(by));
  }

  /** "Roll NPCs" / "Roll remaining" (the DM): every combatant still without initiative, the players' too if asked. */
  rollRemaining(by: string, players: boolean): number {
    const c = this.combat();
    if (!c) return 0;
    const model = this.host.model();
    const pending = dataOf(c)
      .combatants.filter((e) => e.initiative === null)
      .filter((e) => players || controllersOf(model, e.tokenId).length === 0)
      .map((e) => e.tokenId);
    if (pending.length) this.rollInitiative(pending, by);
    return pending.length;
  }

  /** A player answered their initiative card: its total into the order. */
  answered(r: RollRequest, t: RequestTarget, res: RequestResponse): void {
    if (r.purpose?.kind !== "initiative" || res.state === "skipped" || res.total === undefined) return;
    const c = this.combat();
    if (!c || c.id !== r.purpose.combatId) return;
    this.host
      .bus()
      .execute("combat.initiative", { values: { [t.id]: res.total }, begin: false }, SYSTEM_ACTOR);
  }

  // ── a turn ───────────────────────────────────────────────────────────────────────────────────────────────

  /** A turn ended and the next began (not going back): what each brings. */
  turn(e: CombatTurn): void {
    const model = this.host.model();
    if (e.back) {
      this.announce(e);
      return;
    }
    if (e.from) this.hazards(e.from, "endTurn");
    this.expire(e);
    if (!e.to) return;
    const c = combatOn(model, e.sceneId);
    const entry = c ? dataOf(c).combatants.find((x) => x.tokenId === e.to) : undefined;
    // SRD 5.1: a surprised creature loses its first turn.
    if (c && entry?.surprised && e.round === 1 && model.campaign.rulesPack === "srd-5.1") {
      this.host.toDms("toast", {
        kind: "info",
        message: `${entry.name} is surprised and loses its first turn.`,
      });
      queueMicrotask(() => this.host.bus().execute("combat.next", {}, SYSTEM_ACTOR));
      return;
    }
    this.announce(e);
    // A dying character's death saving throw (AC-HP-08).
    try {
      const h = holderOf(this.ctx(), { tokenId: e.to });
      const ds = h.status.deathSaves;
      if (h.isPC && h.hp <= 0 && ds && !ds.stable && !ds.dead) this.host.requestDeathSaves([e.to]);
      // Ongoing damage: burning (a marker) — the DM decides it, as for a hazard.
      if (h.status.markers.some((m) => m.id === "burning"))
        this.host.toDms("hazard.prompt", {
          tokenId: e.to,
          tokenName: h.name,
          prompts: [
            {
              zoneId: "",
              zoneLabel: statusName("burning"),
              when: "startTurn",
              label: "Burning: fire damage at the start of its turn",
              damage: { formula: "1d4", type: "fire" },
            },
          ],
        });
    } catch {}
    this.hazards(e.to, "startTurn");
  }

  /** The turn's news: everyone who perceives the creature hears whose turn it is; its players that it's theirs. */
  private announce(e: CombatTurn): void {
    if (!e.to) return;
    const model = this.host.model();
    const t = model.get("token", e.to);
    if (!t) return;
    const owners = controllersOf(model, e.to);
    for (const v of this.host.viewers())
      if (v.dm || owners.includes(v.userId) || v.perceives(e.to))
        v.send("combat.turn", {
          tokenId: e.to,
          name: t.name,
          round: e.round,
          yours: owners.includes(v.userId),
        });
  }

  /** The hazards a creature stands in at this moment of its turn: the DM's prompts (AC-WAL-05). */
  private hazards(tokenId: string, when: "startTurn" | "endTurn"): void {
    const model = this.host.model();
    const t = model.get("token", tokenId);
    if (!t) return;
    const prompts = hazardPrompts(model.inScene("zone", t.sceneId), { when, at: t.pos });
    if (prompts.length) this.host.toDms("hazard.prompt", { tokenId, tokenName: t.name, prompts });
  }

  /**
   * What ran out as this turn began (AC-CMB-09): conditions and markers lasting until a round — measured from their
   * creator's turn when one is known, else from the top of that round — taken off (one undoable change each
   * creature), and the DM and the creature's players told.
   */
  private expire(e: CombatTurn): void {
    if (!e.to) return;
    const model = this.host.model();
    const c = combatOn(model, e.sceneId);
    if (!c) return;
    const d = dataOf(c);
    const first = d.combatants[0]?.tokenId ?? e.to;
    const now = { round: e.round, turnOf: e.to, when: "start" as const };
    const inFight = new Set(d.combatants.map((x) => x.tokenId));
    for (const t of model.inScene("token", e.sceneId)) {
      let h: ReturnType<typeof holderOf>;
      try {
        h = holderOf(this.ctx(), { tokenId: t.id });
      } catch {
        continue;
      }
      const ends = (untilRound: number | undefined, source?: string) =>
        untilRound !== undefined &&
        durationExpired(
          {
            round: untilRound,
            turnOf: source && inFight.has(source) ? source : first,
            when: "start",
          },
          now,
        );
      const gone = [
        ...h.status.conditions.filter((x) => ends(x.untilRound, x.sourceTokenId)).map((x) => x.id as string),
        ...h.status.markers.filter((x) => ends(x.untilRound)).map((x) => x.id as string),
      ];
      if (!gone.length) continue;
      const dm = [...this.host.viewers()].find((v) => v.dm);
      this.host
        .bus()
        .execute(
          "status.change",
          { tokenId: t.id, remove: gone },
          dm ? this.host.actorOf(dm.userId) : SYSTEM_ACTOR,
        );
      const what = gone
        .map((id) => h.status.markers.find((m) => m.id === id)?.label || statusName(id))
        .join(", ");
      const msg = { tokenId: t.id, name: h.name, what };
      this.host.toDms("combat.expired", msg);
      for (const u of controllersOf(model, t.id)) this.host.toUser(u, "combat.expired", msg);
    }
  }

  // ── stopping ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Combat stopped (AC-CMB-07): its summary in the log, and everyone told. */
  stopped(e: CombatStopped): void {
    const parts = [`Combat ended after ${e.rounds} ${e.rounds === 1 ? "round" : "rounds"}.`];
    if (e.downed.length) parts.push(`Down: ${e.downed.join(", ")}.`);
    const hits = e.tally.filter((x) => x.dealt || x.taken);
    if (hits.length)
      parts.push(`Damage — ${hits.map((x) => `${x.name}: dealt ${x.dealt}, took ${x.taken}`).join("; ")}.`);
    const text = parts.join(" ");
    this.host.log("combat.summary", text, { rounds: e.rounds, downed: e.downed, tally: e.tally });
    for (const v of this.host.viewers()) v.send("combat.stopped", { text, rounds: e.rounds });
  }
}
