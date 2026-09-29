/**
 * The room's half of spells and attacks (SPEC §8.13, §29.5): each resolution card as its reader may see it — the DM's
 * whole card, the caster's rolls, nobody else's (§13.4) — kept in step after every commit; a cast's save cards for the
 * players it caught (the DC shown only once the DM shows it) and its NPCs' saves on one DM click; the attacks and
 * damage rolled (or entered) from a card, as rolls the table sees; the cast's VFX for whoever can see it; and its line
 * for everyone who can see its caster ("Mira casts Fireball (3rd level) — 4 creatures").
 */
import type { Ability, DamageType } from "@gloam/shared";
import { COVER_BONUS, coverHint } from "@gloam/shared/aoe";
import { withPenalty } from "@gloam/shared/dice";
import { type CastTargetView, type CastView, GloamError } from "@gloam/shared/protocol";
import {
  applyDamage,
  applyHealing,
  attackHints,
  critFormula,
  critMaxFormula,
  hintedMode,
  isDm,
} from "@gloam/shared/rules";
import type { RequestResponse, RequestTarget, RollRequest } from "../dice/requests.ts";
import type { RollRecord } from "../dice/service.ts";
import type { CastEntity } from "../engine/codecs.ts";
import type { CommandActor, CommandBus, CommandCtx } from "../engine/commandBus.ts";
import type { CastData, CastTargetData } from "../engine/commands/castData.ts";
import { holderOf } from "../engine/commands/health.ts";
import { SYSTEM_ACTOR } from "../engine/commands/party.ts";
import {
  adjusted,
  barriersOf,
  CAST_FOLLOWUP,
  type CastFollowup,
  castLineText,
  conditionsFor,
  outcomeOf,
  rowFormula,
  rowInstances,
  rowParts,
  silenced,
} from "../engine/commands/spells.ts";
import type { CampaignModel } from "../engine/model.ts";
import { roomCtx } from "./roomContext.ts";

export { CAST_FOLLOWUP };

/** Someone at the table, as the cards see them. */
export interface CastViewer {
  key: object;
  userId: string;
  dm: boolean;
  /** Whether this person perceives a token now (their view, §13.4). */
  perceives(tokenId: string): boolean;
  send(type: string, payload: unknown): void;
}

export interface CastHost {
  readonly campaignId: string;
  model(): CampaignModel;
  bus(): CommandBus;
  viewers(): Iterable<CastViewer>;
  actorOf(userId: string): CommandActor;
  /** Save cards (the room's requests: each target's formula from its sheet, its conditions' hints). */
  askSaves(
    createdBy: string,
    p: {
      targets: string[];
      ability: Ability;
      dc?: number;
      showDc: boolean;
      visibility: "public" | "dm";
      label: string;
      castId: string;
    },
  ): RollRequest;
  /** The DM rolls a request's target (its formula and hints), as the request board's Roll does. */
  answerAsDm(r: RollRequest, targetId: string, dmUserId: string): void;
  request(id: string): RollRequest | undefined;
  /** Saves a request and sends it again (its cards, the DM's board). */
  updateRequest(r: RollRequest): void;
  /** A roll made from a card, seen as the roller's rolls are. */
  roll(
    userId: string,
    p: { formula: string; label: string; visibility: "public" | "dm"; tokenId?: string },
  ): RollRecord;
  /** A physical roll: by its dice (one value a die), or its total. */
  manual(
    userId: string,
    p: {
      formula: string;
      total?: number;
      values?: number[];
      label: string;
      visibility: "public" | "dm";
      tokenId?: string;
    },
  ): RollRecord;
}

const ABILITY_SHORT: Record<Ability, string> = {
  str: "STR",
  dex: "DEX",
  con: "CON",
  int: "INT",
  wis: "WIS",
  cha: "CHA",
};

export class CastFlow {
  private readonly host: CastHost;
  /** What each connection was last sent per card (a view goes again only when it changed). */
  private readonly sent = new WeakMap<object, Map<string, string>>();

  constructor(host: CastHost) {
    this.host = host;
  }

  private ctx(actor: CommandActor = SYSTEM_ACTOR): CommandCtx {
    return { actor, model: this.host.model(), app: roomCtx(), now: Date.now() };
  }

  private cast(id: string): CastEntity | undefined {
    const c = this.host.model().get("cast", id);
    return c && c.campaignId === this.host.campaignId ? c : undefined;
  }

  /** The caster's players (its token's owners). */
  private casterUsers(c: CastData): string[] {
    const t = c.caster.tokenId ? this.host.model().get("token", c.caster.tokenId) : undefined;
    return t?.ownerIds ?? [];
  }

  // ── views ─────────────────────────────────────────────────────────────────────────────────────────────

  /** A card as one person may see it: the DM's whole card, the caster's parts, or nothing. */
  viewFor(
    c: CastEntity,
    v: { userId: string; dm: boolean; perceives(id: string): boolean },
  ): CastView | null {
    const d = c.data;
    const caster = this.casterUsers(d).includes(v.userId);
    if (!v.dm && !caster) return null;
    const ctx = this.ctx();
    const applied = d.targets.some((t) => t.state === "applied");
    const steps: CastView["steps"] = ["targets"];
    if (d.attack) steps.push("attacks");
    if (d.save) steps.push("saves");
    if (d.damage) steps.push("damage");
    steps.push("apply");
    const formula = rowFormula(d, null).formula;
    const targets: CastTargetView[] = [];
    for (const t of d.targets) {
      // The caster sees only the creatures they perceive (a hidden one isn't named on their card).
      if (!v.dm && !v.perceives(t.id)) continue;
      targets.push(v.dm ? this.dmRow(ctx, d, t) : this.casterRow(ctx, d, t, v));
    }
    // A trigger's card (their effect burning someone) only when they perceive someone on it — its subtitle naming
    // only those.
    if (!v.dm && d.kind === "trigger" && !targets.length) return null;
    const subtitle =
      !v.dm && d.kind === "trigger" && d.trigger?.verb
        ? `${[...new Set(targets.map((t) => t.name))].join(", ")} ${d.trigger.verb}`
        : d.subtitle;
    const cover = v.dm ? coverNote(d) : undefined;
    return {
      id: c.id,
      kind: d.kind,
      name: d.name,
      subtitle,
      casterName: d.caster.name,
      casterTokenId: d.caster.tokenId,
      spellId: d.spellId,
      slot: d.spent?.level ?? null,
      steps,
      ...(d.save
        ? {
            save: {
              ability: d.save.ability,
              ...(d.dc !== null && (v.dm || d.dcRevealed) ? { dc: d.dc } : {}),
              revealed: d.dcRevealed,
              onSuccess: d.save.onSuccess,
            },
          }
        : {}),
      ...(d.attack ? { attack: { bonus: d.attack.formula.replace(/^1d20\s*/, "") } } : {}),
      ...(d.damage
        ? {
            damage: {
              formula,
              types: [...new Set(d.damage.parts.map((p) => p.type))],
              healing: d.damage.healing,
              per: d.damage.per,
              ...(d.damage.roll
                ? {
                    roll: {
                      total: d.damage.roll.total,
                      formula: d.damage.roll.formula,
                      ...(d.damage.roll.entered ? { entered: true } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      targets,
      ...(cover ? { coverNote: cover } : {}),
      vfx: d.vfx,
      effectId: d.effectId,
      status: c.status,
      can: { edit: v.dm, roll: v.dm || caster, cancel: v.dm || (caster && !applied) },
      createdAt: c.createdAt,
    };
  }

  private dmRow(ctx: CommandCtx, d: CastData, t: CastTargetData): CastTargetView {
    const base = this.casterRow(ctx, d, t, null);
    let h: ReturnType<typeof holderOf> | null = null;
    try {
      h = holderOf(ctx, { tokenId: t.id });
    } catch {
      h = null;
    }
    const row: CastTargetView = {
      ...base,
      ...(t.save
        ? { save: { ...base.save, ability: d.save?.ability ?? "dex", ...t.save } as CastTargetView["save"] }
        : {}),
      ...(t.attack
        ? {
            attack: {
              total: t.attack.total,
              ...(t.attack.natural !== null ? { natural: t.attack.natural } : {}),
              crit: t.attack.crit,
              ...(t.attack.hit !== undefined ? { hit: t.attack.hit } : {}),
              ...(t.attack.entered ? { entered: true } : {}),
              ...(h ? { ac: h.stats.ac } : {}),
            },
          }
        : {}),
    };
    if (!h) return row;
    const has = {
      resist: Boolean(d.damage?.parts.some((p) => h?.stats.resist.includes(p.type))),
      vuln: Boolean(d.damage?.parts.some((p) => h?.stats.vuln.includes(p.type))),
      immune: Boolean(d.damage?.parts.some((p) => h?.stats.immune.includes(p.type))),
    };
    row.adjust = { resist: !t.ignore.resist, vuln: !t.ignore.vuln, immune: !t.ignore.immune, has };
    row.conditions = [...new Set([...d.conditions.map((c) => c.id), ...(t.conditions ?? [])])].map((id) => ({
      id,
      on: conditionsFor(d, t).includes(id),
    }));
    const parts = rowParts(d, t);
    if (d.damage?.healing) {
      const amount = parts ? parts.parts.reduce((s, p) => s + p.amount, 0) : null;
      if (amount !== null) {
        const out = applyHealing(h, amount);
        row.computed = amount;
        row.hp = { now: h.hp, max: h.hpMax, after: out.hp };
      }
    } else if (d.damage && parts) {
      // As Apply will: each instance (attack, ray, dart) in turn, its HP carried on; Thunder nothing inside Silence.
      const a = silenced(ctx, adjusted(h, t.ignore));
      let hp = h.hp;
      let hpTemp = h.hpTemp;
      let total = 0;
      for (const inst of rowInstances(d, t)) {
        const p = applyDamage(
          {
            hp,
            hpMax: h.hpMax,
            hpTemp,
            resistances: a.stats.resist,
            immunities: a.stats.immune,
            vulnerabilities: a.stats.vuln,
            conditions: a.status.conditions.map((x) => x.id),
            concentrating: Boolean(h.status.concentration),
            isPC: h.isPC,
          },
          inst,
        );
        hp = p.hp;
        hpTemp = p.hpTemp;
        total += p.total;
      }
      row.computed = parts.final ? (t.final ?? total) : total;
      row.hp = { now: h.hp, max: h.hpMax, after: hp };
    } else if (d.damage && outcomeOf(d, t) === "none") {
      row.computed = 0;
      row.hp = { now: h.hp, max: h.hpMax, after: h.hp };
    }
    if (t.final !== undefined && t.final !== null) row.final = t.final;
    return row;
  }

  /**
   * What an attack at a row gets (SRD 5.2.1 §19.3): the attacker's and the target's conditions (`attackHints`), the
   * mode they add up to, Exhaustion's penalty, whether a hit is a critical hit (a melee one from within 5 ft on a
   * Paralyzed or Unconscious creature). Distances edge to edge.
   */
  private hintsFor(
    ctx: CommandCtx,
    d: CastData,
    t: CastTargetData,
  ): NonNullable<CastTargetView["attackHints"]> {
    const m = this.host.model();
    const at = d.caster.tokenId ? m.get("token", d.caster.tokenId) : undefined;
    const to = m.get("token", t.id);
    const holder = (id: string | undefined) => {
      try {
        return id ? holderOf(ctx, { tokenId: id }) : null;
      } catch {
        return null;
      }
    };
    const a = holder(at?.id);
    const b = holder(to?.id);
    const within =
      at && to ? Math.hypot(to.pos.x - at.pos.x, to.pos.y - at.pos.y) - at.sizeFt / 2 - to.sizeFt / 2 : 999;
    const h = attackHints(
      {
        conditions: a?.status.conditions.map((c) => c.id) ?? [],
        exhaustion: a?.status.exhaustion ?? 0,
      },
      {
        conditions: b?.status.conditions.map((c) => c.id) ?? [],
        markers: b?.status.markers.map((x) => x.id) ?? [],
        outlined: Boolean(b?.status.outlined),
      },
      { withinFt: Math.max(0, within), melee: d.attack?.kind === "melee" },
    );
    const mode = hintedMode(h);
    return {
      adv: h.adv.map((x) => x.from),
      dis: h.dis.map((x) => x.from),
      penalty: h.penalty,
      mode: mode === "normal" ? "none" : mode,
      critOnHit: h.critOnHit,
    };
  }

  /** A row's cover from what a player perceives: creatures they perceive in the way, walls they know of. */
  private coverSeen(
    ctx: CommandCtx,
    d: CastData,
    t: CastTargetData,
    v: { perceives(id: string): boolean },
  ): CastTargetData["cover"] {
    const m = ctx.model;
    const target = m.get("token", t.id);
    const casterTok = d.caster.tokenId ? m.get("token", d.caster.tokenId) : undefined;
    const from = d.origin ?? casterTok?.pos ?? null;
    if (!target || !from || (from.x === target.pos.x && from.y === target.pos.y)) return "none";
    const barriers = barriersOf(ctx, target.sceneId, { known: true });
    const others = m
      .inScene("token", target.sceneId)
      .filter((o) => o.id !== target.id && !o.hidden && v.perceives(o.id))
      .map((o) => ({ pos: o.pos, r: o.sizeFt / 2 }));
    return coverHint(from, { pos: target.pos, r: target.sizeFt / 2 }, barriers, others).cover;
  }

  /**
   * What the caster sees of a row: who, whether it's in, their own rolls — no DC, AC, resistances or HP; the cover
   * hint as they could judge it (the creatures they perceive, the walls they know of — never a hidden one's worth).
   */
  private casterRow(
    ctx: CommandCtx,
    d: CastData,
    t: CastTargetData,
    v: { perceives(id: string): boolean } | null,
  ): CastTargetView {
    return {
      key: t.key,
      id: t.id,
      name: t.name,
      state: t.state,
      pc: t.pc,
      cover: t.cover === "none" || !v ? t.cover : this.coverSeen(ctx, d, t, v),
      ...(d.save && t.save
        ? {
            save: {
              ability: d.save.ability,
              ...(t.save.pending ? { pending: true } : {}),
              ...(t.save.total !== undefined && t.pc ? { total: t.save.total } : {}),
            },
          }
        : {}),
      // Whether it hit — as the DM would say "that hits" — never the AC it was measured against (§8.13).
      ...(t.attack
        ? {
            attack: {
              total: t.attack.total,
              ...(t.attack.natural !== null ? { natural: t.attack.natural } : {}),
              crit: t.attack.crit,
              ...(typeof t.attack.hit === "boolean" ? { hit: t.attack.hit } : {}),
            },
          }
        : d.attack && t.state === "in"
          ? { attackHints: this.hintsFor(ctx, d, t) }
          : {}),
      ...(t.roll ? { roll: { total: t.roll.total, formula: t.roll.formula } } : {}),
      outcome: outcomeOf(d, t),
      adjust: {
        resist: true,
        vuln: true,
        immune: true,
        has: { resist: false, vuln: false, immune: false },
      },
      conditions: [],
      times: t.times,
    };
  }

  /**
   * Every open card to every reader (a card that closed goes once more, closed, so it leaves their screen; one that's
   * gone — its cast undone — goes as cancelled to whoever had it).
   */
  push(ids?: readonly string[]): void {
    const model = this.host.model();
    const gone = ids ? ids.filter((id) => !model.get("cast", id)) : [];
    const casts = ids
      ? ids.map((id) => model.get("cast", id)).filter((c): c is CastEntity => Boolean(c))
      : model.all("cast").filter((c) => c.campaignId === this.host.campaignId);
    for (const v of this.host.viewers()) {
      let mine = this.sent.get(v.key);
      if (!mine) {
        mine = new Map();
        this.sent.set(v.key, mine);
      }
      for (const id of gone)
        if (mine.delete(id)) v.send("cast.view", { id, status: "cancelled", targets: [] });
      for (const c of casts) {
        const view = this.viewFor(c, v);
        const json = view ? JSON.stringify(view) : "";
        if (mine.get(c.id) === json) continue;
        if (!view && !mine.has(c.id)) continue;
        mine.set(c.id, json);
        v.send("cast.view", view ?? { id: c.id, status: "done", targets: [] });
      }
    }
    // The save cards say the DC once the DM shows it.
    for (const c of casts) {
      const r = c.data.requestId ? this.host.request(c.data.requestId) : undefined;
      if (r && r.status === "open" && r.showDc !== c.data.dcRevealed) {
        r.showDc = c.data.dcRevealed;
        this.host.updateRequest(r);
      }
    }
  }

  /** A card that just left the model (done or cancelled): read back as it was stored, to close it on screens. */
  /** A connection joined: its open cards. */
  join(v: CastViewer): void {
    const views: CastView[] = [];
    const mine = new Map<string, string>();
    for (const c of this.host.model().all("cast")) {
      if (c.campaignId !== this.host.campaignId || c.status !== "open") continue;
      const view = this.viewFor(c, v);
      if (!view) continue;
      views.push(view);
      mine.set(c.id, JSON.stringify(view));
    }
    this.sent.set(v.key, mine);
    v.send("cast.views", views);
  }

  // ── after a cast ──────────────────────────────────────────────────────────────────────────────────────

  /** A cast's follow-ups after its commit: save cards, the VFX, the line. */
  followup(f: CastFollowup, by: string): void {
    const c = f.castId ? this.cast(f.castId) : undefined;
    if (c && f.askSaves?.length && c.data.save) this.askSaves(c, f.askSaves, by);
    if (f.fx) this.fx(f.fx);
    if (f.line) this.line(f);
  }

  private askSaves(c: CastEntity, targets: string[], by: string): void {
    const d = c.data;
    if (!d.save) return;
    const r = this.host.askSaves(d.createdBy || by, {
      targets,
      ability: d.save.ability,
      ...(d.dc !== null ? { dc: d.dc } : {}),
      showDc: d.dcRevealed,
      visibility: "public",
      label: `${d.name} · ${ABILITY_SHORT[d.save.ability]} save`,
      castId: c.id,
    });
    try {
      this.host.bus().execute("cast.record", { castId: c.id, requestId: r.id }, SYSTEM_ACTOR);
    } catch {
      // the card closed meanwhile
    }
  }

  /** The VFX, to whoever can see it: the DM, and each player who perceives its caster or a creature it touches. */
  private fx(fx: NonNullable<CastFollowup["fx"]>): void {
    const model = this.host.model();
    const caster = model.get("token", fx.casterTokenId);
    const from = caster ? { x: caster.pos.x, y: caster.pos.y, z: caster.elevation } : null;
    const to = fx.targets
      .map((id) => model.get("token", id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .map((t) => ({ x: t.pos.x, y: t.pos.y, z: t.elevation, id: t.id }));
    for (const v of this.host.viewers()) {
      const sees = v.dm || v.perceives(fx.casterTokenId) || to.some((t) => v.perceives(t.id));
      if (!sees) continue;
      // What a player doesn't perceive of it stays out: the caster, the creatures it hit.
      const seenTo = v.dm ? to : to.filter((t) => v.perceives(t.id));
      v.send("cast.fx", {
        castId: null,
        preset: fx.preset,
        from: v.dm || v.perceives(fx.casterTokenId) ? from : null,
        shape:
          fx.shape && fx.shape.kind === "emanation"
            ? { kind: "emanation", distance: fx.shape.distance, at: from }
            : fx.shape,
        to: seenTo.map(({ x, y, z }) => ({ x, y, z })),
        kind: fx.kind,
      });
    }
  }

  /**
   * "Mira casts Fireball (3rd level) — 4 creatures": the DM, and the players who perceive the caster — card or no card
   * (a hidden lich's Darkness tells no one) — each counting (or naming) only the creatures they perceive.
   */
  private line(f: CastFollowup): void {
    const l = f.line;
    if (!l) return;
    for (const v of this.host.viewers()) {
      if (!v.dm && !v.perceives(l.casterTokenId)) continue;
      const seen = v.dm ? l.targets : l.targets.filter((x) => v.perceives(x.id));
      v.send("cast.line", { text: castLineText(l, seen), castId: f.castId });
    }
  }

  // ── rolls ─────────────────────────────────────────────────────────────────────────────────────────────

  /** A player's save card answered (or the DM's roll for it): its result on the card. */
  answered(r: RollRequest, t: RequestTarget, res: RequestResponse): void {
    if (r.purpose?.kind !== "castSave" || res.state === "skipped" || res.total === undefined) return;
    const c = this.cast(r.purpose.castId);
    if (c?.status !== "open") return;
    const autoFail = (t.autoFail?.length ?? 0) > 0;
    const success = autoFail ? false : r.dc !== undefined ? res.total >= r.dc : null;
    const pc = c.data.targets.find((x) => x.id === t.id)?.pc ?? false;
    this.host.bus().execute(
      "cast.record",
      {
        castId: c.id,
        targetId: t.id,
        save: {
          total: res.total,
          success,
          by: res.state === "dm" ? (pc ? "dm" : "npc") : "player",
          ...(autoFail ? { autoFail: true } : {}),
        },
      },
      SYSTEM_ACTOR,
    );
  }

  /** "Roll all NPC saves" (§8.13): one DM request for the NPCs still to save, each rolled at once. */
  npcSaves(dm: CommandActor, castId: string): { rolled: number } {
    if (!isDm(dm.role)) throw new GloamError("FORBIDDEN", "Only the DM rolls the NPCs' saves.");
    const c = this.cast(castId);
    if (c?.status !== "open") throw new GloamError("NOT_FOUND", "That card is closed.");
    const d = c.data;
    if (!d.save) throw new GloamError("INVALID", `${d.name} has no save.`);
    // The DM's creatures only: one a player controls (a familiar, a summons, an unlinked PC token) is asked on its
    // player's card like a PC's (security review M4) — and a card never says the DC unless the DM showed it.
    const model = this.host.model();
    const ids = [
      ...new Set(
        d.targets
          .filter((t) => t.state === "in" && !t.pc && t.save?.total === undefined)
          .filter((t) => (model.get("token", t.id)?.ownerIds.length ?? 0) === 0)
          .map((t) => t.id),
      ),
    ];
    if (!ids.length) return { rolled: 0 };
    const r = this.host.askSaves(dm.userId, {
      targets: ids,
      ability: d.save.ability,
      ...(d.dc !== null ? { dc: d.dc } : {}),
      showDc: d.dcRevealed,
      visibility: "dm",
      label: `${d.name} · ${ABILITY_SHORT[d.save.ability]} save`,
      castId: c.id,
    });
    for (const id of ids) this.host.answerAsDm(r, id, dm.userId);
    return { rolled: ids.length };
  }

  /**
   * A roll on a card (§8.13 Attack rolls, Damage/healing roll): an attack at a row — against its AC, a natural 20 a
   * critical hit, a 1 a miss — or the damage (the card's for everyone, a row's for its hit, a critical hit's dice
   * doubled), or a number entered instead. Rolled where the table sees it: public for a player's creature, the DM's
   * own rolls as the DM's are.
   */
  roll(
    actor: CommandActor,
    p: {
      castId: string;
      what: "attack" | "damage";
      targetId?: string | undefined;
      entered?: number | undefined;
      dice?: number[] | undefined;
      adv?: "none" | "adv" | "dis" | undefined;
    },
  ): { total: number } {
    const c = this.cast(p.castId);
    if (c?.status !== "open") throw new GloamError("NOT_FOUND", "That card is closed.");
    const d = c.data;
    const dm = isDm(actor.role);
    if (!dm && !this.casterUsers(d).includes(actor.userId))
      throw new GloamError("FORBIDDEN", "Only the DM or the caster rolls on it.");
    const row = p.targetId ? d.targets.find((t) => t.key === p.targetId) : undefined;
    // A row the roller doesn't perceive is as good as not there (no name in an answer, security review L3).
    if (p.targetId && (!row || (!dm && actor.sees && !actor.sees(row.id))))
      throw new GloamError("NOT_FOUND", "That creature isn't on the card.");
    if (row && row.state !== "in") throw new GloamError("CONFLICT", `${row.name} is ${row.state}.`);
    const casterTok = d.caster.tokenId ? this.host.model().get("token", d.caster.tokenId) : undefined;
    const npcCaster = casterTok ? casterTok.ownerIds.length === 0 : true;
    const visibility: "public" | "dm" = dm && npcCaster ? "dm" : "public";
    const tokenId = d.caster.tokenId ?? undefined;
    if (p.what === "attack") {
      if (!d.attack || !row) throw new GloamError("INVALID", "Nothing to attack with here.");
      if (row.attack) throw new GloamError("CONFLICT", `${row.name}'s attack is rolled.`);
      // What it gets (§19.3): the hints' mode unless the roller set it; Exhaustion's penalty on the roll.
      const hints = this.hintsFor(this.ctx(), d, row);
      const mode = p.adv ?? hints.mode;
      const base = hints.penalty ? withPenalty(d.attack.formula, hints.penalty) : d.attack.formula;
      const formula = `${base}${mode !== "none" ? ` ${mode}` : ""}`;
      // A physical roll is entered by its dice — the d20 says whether it's a natural 20 or 1 (security review M3); a
      // total is the DM's own roll behind the screen, its natural unknown (the DM marks a critical by hand).
      if (p.entered !== undefined && !dm)
        throw new GloamError("INVALID", "Enter the d20 you rolled (its face), not a total.");
      // Public labels name no creature (the roll feed is everyone's).
      const label = `${d.name} · attack`;
      const where = { label, visibility, ...(tokenId ? { tokenId } : {}) };
      const roll = p.dice
        ? this.host.manual(actor.userId, { formula, values: p.dice, ...where })
        : p.entered !== undefined
          ? this.host.manual(actor.userId, { formula, total: p.entered, ...where })
          : this.host.roll(actor.userId, { formula, ...where });
      const natural = p.entered !== undefined ? null : (roll.natural ?? null);
      const target = holderOf(this.ctx(), { tokenId: row.id });
      const hit = natural === 20 ? true : natural === 1 ? false : roll.total >= target.stats.ac;
      // A natural 20; or a hit that the target's state makes critical (a melee hit within 5 ft of the Paralyzed).
      const crit = natural === 20 || (hit && hints.critOnHit !== null);
      const entered = p.entered !== undefined || p.dice !== undefined;
      this.host.bus().execute(
        "cast.record",
        {
          castId: c.id,
          targetId: row.key,
          attack: { total: roll.total, natural, crit, hit, ...(entered ? { entered: true } : {}) },
        },
        SYSTEM_ACTOR,
      );
      return { total: roll.total };
    }
    if (!d.damage) throw new GloamError("INVALID", `${d.name} has no damage to roll.`);
    if (d.damage.per === "target" && !row)
      throw new GloamError("INVALID", "Roll it for a creature on the card.");
    if (d.damage.per === "cast" && d.damage.roll) throw new GloamError("CONFLICT", "The damage is rolled.");
    if (row?.roll) throw new GloamError("CONFLICT", `${row.name}'s damage is rolled.`);
    const crit = Boolean(row?.attack?.crit);
    const { parts } = rowFormula(d, d.damage.per === "target" ? (row ?? null) : null);
    // A critical hit's dice: doubled, or rolled plus their maximum under that house rule (§19.6).
    const maxPlus = this.host.model().campaign.houseRules.criticalDamage === "maxPlusRoll";
    const pieces = (parts?.parts ?? []).map((q) => ({
      ...q,
      formula: crit ? (maxPlus ? critMaxFormula(q.formula) : critFormula(q.formula)) : q.formula,
    }));
    const formula = pieces.map((q) => `${q.formula}${d.damage?.healing ? "" : ` [${q.type}]`}`).join(" + ");
    const label = `${d.name} · ${d.damage.healing ? "healing" : "damage"}`;
    let total: number;
    let byType: { amount: number; type: DamageType }[];
    let rollId: string | undefined;
    let entered = p.entered !== undefined;
    const where = { label, visibility, ...(tokenId ? { tokenId } : {}) };
    if (p.entered !== undefined) {
      // A total with no dice: shared among the types as their dice would on average (rules audit m10 — Flame
      // Strike's 30 is 15 fire and 15 radiant, not 30 of the first), the remainder to the first.
      total = p.entered;
      byType = d.damage.healing ? [{ amount: total, type: "force" }] : splitByAverage(total, pieces);
      this.host.manual(actor.userId, { formula, total, ...where });
    } else {
      // Rolled — or entered die by die (a physical roll): each die in its own type.
      const r = p.dice
        ? this.host.manual(actor.userId, { formula, values: p.dice, ...where })
        : this.host.roll(actor.userId, { formula, ...where });
      total = r.total;
      if (p.dice) entered = true;
      rollId = r.id;
      byType = d.damage.healing
        ? [{ amount: r.total, type: "force" }]
        : Object.entries(r.byTag)
            .filter(([, v]) => v > 0)
            .map(([type, amount]) => ({
              amount,
              type: (type === "untyped" ? (pieces[0]?.type ?? "force") : type) as DamageType,
            }));
    }
    this.host.bus().execute(
      "cast.record",
      {
        castId: c.id,
        ...(row && d.damage.per === "target" ? { targetId: row.key } : {}),
        roll: {
          total,
          parts: byType,
          formula,
          ...(entered ? { entered: true } : {}),
          ...(rollId ? { rollId } : {}),
          ...(crit ? { crit: true } : {}),
        },
      },
      SYSTEM_ACTOR,
    );
    return { total };
  }
}

/** A total shared among damage types as their formulas would on average (the remainder to the first). */
function splitByAverage(
  total: number,
  pieces: readonly { formula: string; type: DamageType }[],
): { amount: number; type: DamageType }[] {
  if (pieces.length <= 1) return [{ amount: total, type: pieces[0]?.type ?? "force" }];
  const avg = pieces.map((q) => {
    // Each die's average ((sides + 1) / 2 a die) and every number — enough to weigh the types against each other.
    let a = 0;
    for (const m of q.formula.matchAll(/(\d*)d(\d+)/g)) a += Number(m[1] || 1) * ((Number(m[2]) + 1) / 2);
    const bare = q.formula.replace(/\d*d\d+/g, "");
    for (const m of bare.matchAll(/([+-])?\s*(\d+)/g)) a += (m[1] === "-" ? -1 : 1) * Number(m[2]);
    return Math.max(0, a);
  });
  const sum = avg.reduce((s, x) => s + x, 0) || 1;
  const out = pieces.map((q, i) => ({
    amount: Math.floor((total * (avg[i] as number)) / sum),
    type: q.type,
  }));
  const rest = total - out.reduce((s, x) => s + x.amount, 0);
  if (out[0]) out[0].amount += rest;
  return out.filter((x) => x.amount > 0);
}

/** The card's cover hint (§17.5, AC-SPL-13): the first creature behind cover, and what it's worth. */
function coverNote(d: CastData): string | undefined {
  const t = d.targets.find((x) => x.state === "in" && x.cover !== "none");
  if (!t) return undefined;
  const bonus = COVER_BONUS[t.cover];
  const what =
    t.cover === "half" ? "half cover" : t.cover === "threeQuarters" ? "three-quarters cover" : "total cover";
  if (bonus === null) return `Cover hint: ${t.name} has total cover (it can't be targeted directly).`;
  // Cover adds to AC and to Dexterity saves only (§17.5): a save of another ability gets nothing from it.
  const against = !d.save
    ? "to its AC"
    : d.save.ability === "dex"
      ? `to its ${ABILITY_SHORT.dex} save`
      : `to AC and ${ABILITY_SHORT.dex} saves, not to this ${ABILITY_SHORT[d.save.ability]} save`;
  return `Cover hint: ${t.name} has ${what}: +${bonus} ${against}.`;
}
