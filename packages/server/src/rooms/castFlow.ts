/**
 * The room's half of spells and attacks (SPEC §8.13, §29.5): each resolution card as its reader may see it — the DM's
 * whole card, the caster's rolls, nobody else's (§13.4) — kept in step after every commit; a cast's save cards for the
 * players it caught (the DC shown only once the DM shows it) and its NPCs' saves on one DM click; the attacks and
 * damage rolled (or entered) from a card, as rolls the table sees; the cast's VFX for whoever can see it; and its line
 * for everyone who can see its caster ("Mira casts Fireball (3rd level) — 4 creatures").
 */
import type { Ability, DamageType } from "@gloam/shared";
import { COVER_BONUS } from "@gloam/shared/aoe";
import { type CastTargetView, type CastView, GloamError } from "@gloam/shared/protocol";
import { applyDamage, applyHealing, critFormula, isDm } from "@gloam/shared/rules";
import type { RequestResponse, RequestTarget, RollRequest } from "../dice/requests.ts";
import type { RollRecord } from "../dice/service.ts";
import type { CastEntity } from "../engine/codecs.ts";
import type { CommandActor, CommandBus, CommandCtx } from "../engine/commandBus.ts";
import type { CastData, CastTargetData } from "../engine/commands/castData.ts";
import { holderOf } from "../engine/commands/health.ts";
import { SYSTEM_ACTOR } from "../engine/commands/party.ts";
import {
  adjusted,
  CAST_FOLLOWUP,
  type CastFollowup,
  conditionsFor,
  outcomeOf,
  rowFormula,
  rowParts,
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
  manual(
    userId: string,
    p: { formula: string; total: number; label: string; visibility: "public" | "dm"; tokenId?: string },
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
      targets.push(v.dm ? this.dmRow(ctx, d, t) : this.casterRow(d, t));
    }
    const cover = v.dm ? coverNote(d) : undefined;
    return {
      id: c.id,
      kind: d.kind,
      name: d.name,
      subtitle: d.subtitle,
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
    const base = this.casterRow(d, t);
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
      ...(t.attack ? { attack: { ...t.attack, ...(h ? { ac: h.stats.ac } : {}) } } : {}),
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
      const a = adjusted(h, t.ignore);
      const p = applyDamage(
        {
          hp: h.hp,
          hpMax: h.hpMax,
          hpTemp: h.hpTemp,
          resistances: a.stats.resist,
          immunities: a.stats.immune,
          vulnerabilities: a.stats.vuln,
          conditions: a.status.conditions.map((x) => x.id),
          concentrating: Boolean(h.status.concentration),
          isPC: h.isPC,
        },
        parts.parts,
      );
      row.computed = parts.final ? (t.final ?? p.total) : p.total;
      row.hp = { now: h.hp, max: h.hpMax, after: p.hp };
    } else if (d.damage && outcomeOf(d, t) === "none") {
      row.computed = 0;
      row.hp = { now: h.hp, max: h.hpMax, after: h.hp };
    }
    if (t.final !== undefined && t.final !== null) row.final = t.final;
    return row;
  }

  /** What the caster sees of a row: who, whether it's in, their own rolls — no DC, AC, resistances or HP. */
  private casterRow(d: CastData, t: CastTargetData): CastTargetView {
    return {
      key: t.key,
      id: t.id,
      name: t.name,
      state: t.state,
      pc: t.pc,
      cover: t.cover,
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
              natural: t.attack.natural,
              crit: t.attack.crit,
              ...(typeof t.attack.hit === "boolean" ? { hit: t.attack.hit } : {}),
            },
          }
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
    if (f.line) this.line(f, c);
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

  /** "Mira casts Fireball (3rd level) — 4 creatures": the DM, and the players who perceive the caster. */
  private line(f: CastFollowup, c: CastEntity | undefined): void {
    const caster = c?.data.caster.tokenId;
    for (const v of this.host.viewers())
      if (v.dm || !caster || v.perceives(caster)) v.send("cast.line", { text: f.line, castId: f.castId });
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
    const ids = [
      ...new Set(
        d.targets.filter((t) => t.state === "in" && !t.pc && t.save?.total === undefined).map((t) => t.id),
      ),
    ];
    if (!ids.length) return { rolled: 0 };
    const r = this.host.askSaves(dm.userId, {
      targets: ids,
      ability: d.save.ability,
      ...(d.dc !== null ? { dc: d.dc } : {}),
      showDc: true,
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
      adv: "none" | "adv" | "dis";
    },
  ): { total: number } {
    const c = this.cast(p.castId);
    if (c?.status !== "open") throw new GloamError("NOT_FOUND", "That card is closed.");
    const d = c.data;
    const dm = isDm(actor.role);
    if (!dm && !this.casterUsers(d).includes(actor.userId))
      throw new GloamError("FORBIDDEN", "Only the DM or the caster rolls on it.");
    const row = p.targetId ? d.targets.find((t) => t.key === p.targetId) : undefined;
    if (p.targetId && !row) throw new GloamError("NOT_FOUND", "That creature isn't on the card.");
    if (row && row.state !== "in") throw new GloamError("CONFLICT", `${row.name} is ${row.state}.`);
    const casterTok = d.caster.tokenId ? this.host.model().get("token", d.caster.tokenId) : undefined;
    const npcCaster = casterTok ? casterTok.ownerIds.length === 0 : true;
    const visibility: "public" | "dm" = dm && npcCaster ? "dm" : "public";
    const tokenId = d.caster.tokenId ?? undefined;
    if (p.what === "attack") {
      if (!d.attack || !row) throw new GloamError("INVALID", "Nothing to attack with here.");
      if (row.attack) throw new GloamError("CONFLICT", `${row.name}'s attack is rolled.`);
      const formula = `${d.attack.formula}${p.adv !== "none" ? ` ${p.adv}` : ""}`;
      const roll =
        p.entered !== undefined
          ? this.host.manual(actor.userId, {
              formula,
              total: p.entered,
              label: `${d.name} · attack · ${row.name}`,
              visibility,
              ...(tokenId ? { tokenId } : {}),
            })
          : this.host.roll(actor.userId, {
              formula,
              label: `${d.name} · attack · ${row.name}`,
              visibility,
              ...(tokenId ? { tokenId } : {}),
            });
      const natural = roll.natural ?? roll.total;
      const target = holderOf(this.ctx(), { tokenId: row.id });
      const crit = natural === 20;
      const hit = crit ? true : natural === 1 ? false : roll.total >= target.stats.ac;
      this.host
        .bus()
        .execute(
          "cast.record",
          { castId: c.id, targetId: row.key, attack: { total: roll.total, natural, crit, hit } },
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
    const pieces = (parts?.parts ?? []).map((q) => ({
      ...q,
      formula: crit ? critFormula(q.formula) : q.formula,
    }));
    const formula = pieces.map((q) => `${q.formula}${d.damage?.healing ? "" : ` [${q.type}]`}`).join(" + ");
    const label = `${d.name} · ${d.damage.healing ? "healing" : "damage"}${row ? ` · ${row.name}` : ""}`;
    let total: number;
    let byType: { amount: number; type: DamageType }[];
    let rollId: string | undefined;
    if (p.entered !== undefined) {
      total = p.entered;
      const first = pieces[0]?.type ?? "force";
      byType = [{ amount: total, type: first }];
      this.host.manual(actor.userId, { formula, total, label, visibility, ...(tokenId ? { tokenId } : {}) });
    } else {
      const r = this.host.roll(actor.userId, { formula, label, visibility, ...(tokenId ? { tokenId } : {}) });
      total = r.total;
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
          ...(p.entered !== undefined ? { entered: true } : {}),
          ...(rollId ? { rollId } : {}),
          ...(crit ? { crit: true } : {}),
        },
      },
      SYSTEM_ACTOR,
    );
    return { total };
  }
}

/** The card's cover hint (§17.5, AC-SPL-13): the first creature behind cover, and what it's worth. */
function coverNote(d: CastData): string | undefined {
  const t = d.targets.find((x) => x.state === "in" && x.cover !== "none");
  if (!t) return undefined;
  const bonus = COVER_BONUS[t.cover];
  const what =
    t.cover === "half" ? "half cover" : t.cover === "threeQuarters" ? "three-quarters cover" : "total cover";
  if (bonus === null) return `Cover hint: ${t.name} has total cover (it can't be targeted directly).`;
  const against = d.save
    ? d.save.ability === "dex"
      ? ` to its ${ABILITY_SHORT.dex} save`
      : " (to AC; not this save)"
    : " to its AC";
  return `Cover hint: ${t.name} has ${what} (+${bonus}${against}).`;
}
