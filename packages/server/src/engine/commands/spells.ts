import type { ConditionId, DamageType } from "@gloam/shared";
import {
  type AreaShape as Area,
  affected as areaAffected,
  type Barrier,
  type Body,
  canPlace,
  contains,
  coverHint,
  dirOf,
  type Footprint,
  footprint,
  footprintsOverlap,
  overlaps,
  resolveArea,
} from "@gloam/shared/aoe";
import { parseFormula } from "@gloam/shared/dice";
import type { P } from "@gloam/shared/geometry";
import { blocksMove, blocksSight } from "@gloam/shared/movement";
import {
  AttackStart,
  CastApply,
  CastCancel,
  CastClose,
  CastRevealDc,
  CastSet,
  CastSkip,
  CastTarget,
  EffectAct,
  EffectMove,
  EffectRemove,
  EffectUpdate,
  GloamError,
  Id,
  SpellCast,
} from "@gloam/shared/protocol";
import {
  addDice,
  applyToStatus,
  areaAtSlot,
  attackRangeFt,
  CONDITIONS,
  castArea,
  castAttach,
  controlsToken,
  deriveSheet,
  durationRounds,
  incapacitates,
  isDm,
  PIP,
  roundsFrom,
  SPELL_LEVEL_NAMES,
  saveOutcome,
  scaledFormula,
  sheetRefs,
  sortConsequences,
  targetCount,
  targetingKind,
  vfxFor,
} from "@gloam/shared/rules";
import type {
  AreaShape,
  EffectEntity,
  EffectTrigger,
  Sheet,
  Spell,
  SpellArea,
  TokenEntity,
  TokenStatusT,
} from "@gloam/shared/schemas";
import { z } from "zod";
import { newId } from "../../ids.ts";
import { inSilence } from "../../vision/sources.ts";
import type { ActorEntity, CastEntity } from "../codecs.ts";
import type { CommandCtx, CommandDef, RoomEvent } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps, setPathOp } from "../plan.ts";
import { readSheet, sheetEditOps } from "./actor.ts";
import type { CastData, CastTargetData, DamageRoll } from "./castData.ts";
import { activeCombat, dataOf } from "./combat.ts";
import {
  FOLLOWUPS,
  type Followups,
  type Holder,
  holderOf,
  holderOps,
  itemOf,
  outcomeFor,
  promptTitle,
  tokensOf,
} from "./health.ts";
import { type Hurt, tallyOps } from "./tally.ts";

/**
 * Spells, sheet attacks and persistent effects (SPEC §8.13, §17, §29.5). A cast spends its slot, takes up
 * concentration, marks its pip, places its area and finds who's in it, makes its persistent effect — one undoable
 * step — and opens a resolution card when there's anything to resolve (saves, attacks, damage, healing, conditions).
 * Each step on the card is a command of its own on the card's document (castData.ts); applying runs the HP pipeline
 * (health.ts) for every target at once. Rolls are the room's (the dice service), recorded here by `cast.record`.
 */

/** A cast's line before it's told to anyone (castFlow words it for each reader). */
export interface CastLine {
  casterTokenId: string;
  caster: string;
  verb: "casts" | "attacks";
  /** "Fireball (3rd level)"; an attack's weapon. */
  what: string;
  /** The creatures on the card. */
  targets: { id: string; name: string }[];
  /** A cast says how many of them (only a card's; a spell with none says nothing). */
  count: boolean;
}

/** A cast's line for one reader: the creatures in it they perceive (the DM: all), counted or named. */
export function castLineText(l: CastLine, seen: readonly { id: string; name: string }[]): string {
  if (l.verb === "attacks") {
    const names = [...new Set(seen.map((x) => x.name))].join(", ");
    return names ? `${l.caster} attacks ${names} with ${l.what}` : `${l.caster} attacks with ${l.what}`;
  }
  const n = new Set(seen.map((x) => x.id)).size;
  return `${l.caster} casts ${l.what}${l.count && n ? ` — ${n} ${n === 1 ? "creature" : "creatures"}` : ""}`;
}

/** The room message that asks the room to follow a cast up (save cards, the VFX, the log line). */
export const CAST_FOLLOWUP = "cast.followup";
export interface CastFollowup {
  castId: string | null;
  /** Ask these player targets for their saves. */
  askSaves?: string[];
  /** The cast's VFX for whoever can see it. */
  fx?: {
    casterTokenId: string;
    preset: Spell["vfx"];
    shape: AreaShape | null;
    targets: string[];
    kind: "burst" | "projectile" | "instant";
  };
  /**
   * Its line in the log and the feed (§8.13): who casts or attacks, and with what — to the DM and to the players who
   * perceive the caster, each told only of the creatures they perceive (how many for a cast, which for an attack).
   */
  line?: CastLine;
  spellId?: string | null;
}

// ── spells ───────────────────────────────────────────────────────────────────────────────────────────────

/** A spell by id: the SRD pack's, else the campaign's homebrew (active only). */
export function spellById(ctx: CommandCtx, id: string): Spell | null {
  const srd = ctx.app.content.spellById.get(id);
  if (srd) return srd;
  // In use; the DM's own only for the DM (and the table itself acting for them).
  const dm = isDm(ctx.actor.role);
  for (const c of ctx.model.all("content"))
    if (c.type === "spell" && c.slug === id && (c.status === "active" || (dm && c.status === "private")))
      return c.data as unknown as Spell;
  return null;
}

// ── the caster ───────────────────────────────────────────────────────────────────────────────────────────

interface Caster {
  token: TokenEntity;
  h: Holder;
  /** Its character (a linked token's): the sheet with its slots. */
  actor?: ActorEntity;
  sheet?: Sheet;
  level: number;
  dc: number | null;
  attackBonus: number | null;
  refs: (path: readonly string[]) => number | undefined;
}

function casterOf(ctx: CommandCtx, tokenId: string): Caster {
  const token = mustGet(ctx, "token", tokenId);
  const h = holderOf(ctx, { tokenId });
  const a = token.actorId ? ctx.model.get("actor", token.actorId) : undefined;
  const actor = a && a.deletedAt === null ? a : undefined;
  const sheet = actor ? readSheet(actor) : undefined;
  if (!sheet) return { token, h, level: 1, dc: null, attackBonus: null, refs: () => undefined };
  const d = deriveSheet(sheet.core);
  const sc = sheet.core.spellcasting;
  return {
    token,
    h,
    ...(token.link === "linked" && actor ? { actor } : {}),
    sheet,
    level: Math.max(1, d.values.level),
    dc: sc ? d.values["spell.dc"] : null,
    attackBonus: sc ? d.values["spell.attack"] : null,
    refs: sheetRefs(sheet.core),
  };
}

function mayAct(ctx: CommandCtx, t: TokenEntity): void {
  if (ctx.actor.role === "spectator") throw new GloamError("FORBIDDEN", "Spectators watch.");
  if (!controlsToken(ctx.actor.role, ctx.actor.userId, t))
    throw new GloamError("FORBIDDEN", "That creature isn't yours.");
}

/** A formula with its `@` references filled in from the caster's sheet (a card shows numbers; an NPC's are 0). */
function resolveRefs(formula: string, refs: Caster["refs"]): string {
  const out = formula.replace(/@([a-z][a-zA-Z.]*)/g, (_, ref: string) => String(refs(ref.split(".")) ?? 0));
  return out
    .replace(/\+\s*-\s*(\d)/g, "- $1")
    .replace(/\s*\+\s*0(?![\d.])/g, "")
    .trim();
}

/** A creature's body for areas (its base, its height), from its token. */
export function bodyOf(t: TokenEntity): Body {
  return { pos: t.pos, r: t.sizeFt / 2, z: t.elevation, height: Math.max(t.sizeFt, 2.5) };
}

/**
 * A scene's walls as barriers to lines of effect and cover (§17.3, §17.5): its walls and doors, and wall effects.
 * `known`: only those a player knows of (a hidden wall only if it blocks sight — they see its shadow, §13.4).
 */
export function barriersOf(ctx: CommandCtx, sceneId: string, opts: { known?: boolean } = {}): Barrier[] {
  const out: Barrier[] = [];
  for (const w of ctx.model.inScene("wall", sceneId)) {
    if (opts.known && w.hidden && !blocksSight(w.kind, w.doorState)) continue;
    out.push({
      a: w.a,
      b: w.b,
      blocksMove: blocksMove(w.kind, w.doorState),
      blocksSight: blocksSight(w.kind, w.doorState),
    });
  }
  for (const e of ctx.model.inScene("effect", sceneId)) {
    const sh = e.shape;
    if (sh.kind !== "wall") continue;
    const opaque = sh.opaque || e.props.opaque === true;
    if (!opaque && !sh.blocksMove) continue;
    const n = sh.points.length;
    for (let i = 0; i + 1 < n + (sh.closed ? 1 : 0); i++)
      out.push({
        a: sh.points[i] as { x: number; y: number },
        b: sh.points[(i + 1) % n] as { x: number; y: number },
        blocksMove: sh.blocksMove,
        blocksSight: opaque,
      });
  }
  return out;
}

const tokenBody = (ctx: CommandCtx) => (id: string) => {
  const t = ctx.model.get("token", id);
  return t ? bodyOf(t) : null;
};

/** The area a stored shape covers right now (the board's and the triggers' "inside"). */
export function effectArea(ctx: CommandCtx, e: EffectEntity): Area | null {
  return resolveArea(e.shape, tokenBody(ctx));
}

// ── placing an area ──────────────────────────────────────────────────────────────────────────────────────

type Placement = NonNullable<z.infer<typeof SpellCast>["placement"]>;

/**
 * The area as placed (§17.1–17.2): spheres and cylinders on the chosen point; self-origin cones, lines and cubes on
 * the caster's base edge in the aimed direction (the server puts them there, whatever point came with them); a ranged
 * cube centred on its point; an emanation from the caster (or the object it's cast on); a wall along its points.
 */
function placeShape(
  spell: Spell,
  area: SpellArea,
  level: number,
  pl: Placement,
  caster: TokenEntity,
  attach: ReturnType<typeof castAttach>,
  onto: string | null,
): AreaShape {
  const a = areaAtSlot(area, spell.level, level);
  const self = spell.range.kind === "self";
  const size = pl.size;
  const d = dirOf(pl.dirDeg);
  const r = caster.sizeFt / 2;
  const edge = { x: caster.pos.x + d.x * r, y: caster.pos.y + d.y * r, z: caster.elevation };
  const at = { x: pl.origin.x, y: pl.origin.y, z: pl.origin.z };
  switch (a.shape) {
    case "sphere":
      return {
        kind: "sphere",
        origin: self ? { x: caster.pos.x, y: caster.pos.y, z: caster.elevation } : at,
        radius: size ?? a.radius,
      };
    case "cylinder":
      return { kind: "cylinder", origin: at, radius: size ?? a.radius, height: a.height };
    case "cone":
      return { kind: "cone", origin: edge, dirDeg: pl.dirDeg, length: size ?? a.length };
    case "line":
      return {
        kind: "line",
        origin: self ? edge : at,
        dirDeg: pl.dirDeg,
        length: size ?? a.length,
        width: a.width,
      };
    case "cube":
      return self
        ? { kind: "cube", origin: edge, dirDeg: pl.dirDeg, size: size ?? a.size, originOnFace: true }
        : { kind: "cube", origin: at, dirDeg: pl.dirDeg, size: size ?? a.size, originOnFace: false };
    case "emanation": {
      const reach = size ?? a.distance;
      // Round an object (§33.4): one that's held moves with its holder (the DM's pick); one put down at a point
      // stays there — Flaming Sphere's sphere, Darkness cast on an object — the distance out from the object's edge.
      if (attach === "object")
        return onto
          ? { kind: "emanation", sourceTokenId: onto, distance: reach }
          : { kind: "sphere", origin: at, radius: reach + (spell.effect?.bodyFt ?? 0) / 2 };
      // Round where the caster stands, staying there (Tiny Hut, Globe of Invulnerability: immobile).
      if (attach === "point")
        return {
          kind: "sphere",
          origin: { x: caster.pos.x, y: caster.pos.y, z: caster.elevation },
          radius: reach + caster.sizeFt / 2,
        };
      // Round the caster, going where it goes (Spirit Guardians) — or the creature the DM puts it on.
      return { kind: "emanation", sourceTokenId: onto ?? caster.id, distance: reach };
    }
    case "wall":
      return {
        kind: "wall",
        points: pl.points ?? [
          { x: at.x, y: at.y },
          { x: at.x + d.x * a.length, y: at.y + d.y * a.length },
        ],
        closed: pl.closed === true,
        height: pl.closed && a.ringHeight ? a.ringHeight : a.height,
        thickness: a.thickness,
        opaque: a.opaque,
        blocksMove: a.blocksMove,
        ...(a.damagingSide ? { damagingSide: a.damagingSide } : {}),
      };
  }
}

/**
 * What a cast is put on when the caster names a token (§8.13; the security review's H2): the DM may put it on any
 * token on the caster's scene (P2) — a creature's torch, an object token; a player only on the caster itself, and only
 * where the spell allows it — something they carry for a spell cast on an object (Light: "isn't being worn or carried
 * by someone else"), their own space for one that goes with the caster. Anything else goes on an object at a point.
 */
function castOnto(
  ctx: CommandCtx,
  spell: Spell,
  attach: ReturnType<typeof castAttach>,
  caster: TokenEntity,
  id: string | undefined,
  dm: boolean,
): string | null {
  if (!id) return null;
  const h = ctx.model.get("token", id);
  if (!h || h.sceneId !== caster.sceneId) throw new GloamError("INVALID", "That isn't on this scene.");
  if (dm) return h.id;
  // Cast on the object itself (Light), not an area round one (Darkness on an object must lie where no one holds it).
  const carried = attach === "object" && !spell.area;
  if (h.id === caster.id && (carried || attach === "caster")) return h.id;
  throw new GloamError(
    "FORBIDDEN",
    carried
      ? `${spell.name} goes on something ${caster.name} carries, or on an object put down within reach.`
      : `${spell.name} can't be put on a creature.`,
  );
}

/**
 * Whether a row's save is its player's to roll (on their card): a PC, or any creature a player controls — a familiar,
 * a summons, an unlinked PC token (security review M4) — never the DM's "Roll NPC saves".
 */
function playersRoll(ctx: CommandCtx, row: { id: string; pc: boolean }): boolean {
  return row.pc || (ctx.model.get("token", row.id)?.ownerIds.length ?? 0) > 0;
}

/** How many open cards a player's creature may have at once (each is re-sent on every change to it). */
export const OPEN_CARDS_MAX = 6;

/** A player's creature with too many open cards can't start another (the DM's can — P2). */
function roomForACard(ctx: CommandCtx, t: TokenEntity): void {
  if (isDm(ctx.actor.role)) return;
  const open = ctx.model
    .all("cast")
    .filter((c) => c.status === "open" && c.data.kind !== "trigger" && c.data.caster.tokenId === t.id).length;
  if (open >= OPEN_CARDS_MAX)
    throw new GloamError(
      "CONFLICT",
      `${t.name} has ${OPEN_CARDS_MAX} cards open — finish or close some first.`,
    );
}

/** A condition's end by a creature's next turn (`until`), as the condition's fields. */
function turnBound(
  until: CastData["conditions"][number]["until"],
  casterId: string | null,
  targetId: string,
  active: string | undefined,
): { endsWithTurnOf?: string; turnsLeft?: number; endsAtStartOf?: string } {
  if (!until) return {};
  if (until === "casterTurnStart") return casterId ? { endsAtStartOf: casterId } : {};
  const who = until === "casterTurnEnd" ? casterId : targetId;
  if (!who) return {};
  return { endsWithTurnOf: who, ...(active === who ? { turnsLeft: 1 } : {}) };
}

/**
 * The burst after an attack (Ice Knife: "Hit or miss, the shard then explodes. The target and each creature within 5
 * feet of it must succeed on a Dexterity saving throw"): a card of its own round the attack's target — its save,
 * the damage that rides on it, those it catches (the target too).
 */
function splashCard(
  ctx: CommandCtx,
  spell: Spell,
  level: number,
  caster: Caster,
  attackCard: CastData,
  picked: CastTargetData[],
  chosen: DamageType | undefined,
): CastEntity | null {
  const target = picked.find((x) => x.state === "in");
  const splash = spell.splash;
  if (!target || !splash || !spell.save) return null;
  const all = damageOf(spell, level, caster, chosen);
  const onSave = (spell.damage ?? []).map((x) => x.on === "save");
  const shape: AreaShape = { kind: "emanation", sourceTokenId: target.id, distance: splash };
  const rows = areaTargets(ctx, shape, caster.token.sceneId, { sourceId: target.id, includeSource: true });
  const tok = ctx.model.get("token", target.id);
  const data: CastData = {
    ...attackCard,
    subtitle: "it bursts — hit or miss",
    origin: tok ? { x: tok.pos.x, y: tok.pos.y, z: tok.elevation } : attackCard.origin,
    area: shape,
    save: { ability: spell.save.ability, onSuccess: spell.save.onSuccess },
    dc: caster.dc,
    attack: null,
    damage: all ? { ...all, per: "cast", parts: all.parts.filter((_, i) => onSave[i]) } : null,
    conditions: [],
    targets: rows.map((x) =>
      x.state === "in"
        ? { ...x, save: playersRoll(ctx, x) ? { pending: true, by: "player" as const } : {} }
        : x,
    ),
    // The attack's card holds the slot and the concentration; this one only the burst.
    spent: null,
    effectId: null,
    concentration: false,
  };
  return {
    id: newId("cst"),
    campaignId: ctx.model.campaign.id,
    sceneId: caster.token.sceneId,
    status: "open",
    data,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/** A wall's drawn length (a ring's circumference). */
function wallLength(sh: Extract<AreaShape, { kind: "wall" }>): number {
  let len = 0;
  const n = sh.points.length;
  for (let i = 0; i + 1 < n + (sh.closed ? 1 : 0); i++) {
    const a = sh.points[i] as { x: number; y: number };
    const b = sh.points[(i + 1) % n] as { x: number; y: number };
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

/** The point an area spreads from (its origin; an emanation's source; a wall's first point). */
export function originPoint(ctx: CommandCtx, sh: AreaShape): { x: number; y: number; z: number } | null {
  if (sh.kind === "emanation") {
    const t = ctx.model.get("token", sh.sourceTokenId);
    return t ? { x: t.pos.x, y: t.pos.y, z: t.elevation } : null;
  }
  if (sh.kind === "wall") {
    const p = sh.points[0];
    return p ? { x: p.x, y: p.y, z: 0 } : null;
  }
  return sh.origin;
}

// ── targets ──────────────────────────────────────────────────────────────────────────────────────────────

export function targetRow(
  ctx: CommandCtx,
  t: TokenEntity,
  from: { x: number; y: number } | null,
  barriers: Barrier[],
  sceneTokens: TokenEntity[],
  state: CastTargetData["state"],
  opts: { key?: string; times?: number } = {},
): CastTargetData {
  const h = holderOf(ctx, { tokenId: t.id });
  const others = sceneTokens.filter((o) => o.id !== t.id).map((o) => ({ pos: o.pos, r: o.sizeFt / 2 }));
  const cover =
    from && (from.x !== t.pos.x || from.y !== t.pos.y)
      ? coverHint(from, { pos: t.pos, r: t.sizeFt / 2 }, barriers, others).cover
      : ("none" as const);
  return {
    key: opts.key ?? t.id,
    id: t.id,
    name: t.name,
    pc: h.isPC,
    times: opts.times ?? 1,
    state,
    cover,
    ignore: { resist: false, vuln: false, immune: false },
  };
}

/** Who an area takes (§17.3): each token in the scene, in or out, or cut off by a wall (the card's "blocked"). */
function areaTargets(
  ctx: CommandCtx,
  sh: AreaShape,
  sceneId: string,
  opts: { sourceId: string | null; includeSource: boolean },
): CastTargetData[] {
  const area = resolveArea(sh, tokenBody(ctx));
  if (!area) return [];
  const barriers = barriersOf(ctx, sceneId);
  const tokens = ctx.model.inScene("token", sceneId);
  const coverage = ctx.model.campaign.houseRules.areaCoverage === "centre" ? "centre" : "touches";
  const who = areaAffected(
    area,
    tokens.map((t) => ({ id: t.id, ...bodyOf(t) })),
    barriers,
    { coverage, sourceId: opts.sourceId, includeSource: opts.includeSource },
  );
  // Cover is measured from the area's origin — a wall has none (its first point means nothing; rules audit m9).
  const origin = sh.kind === "wall" ? null : originPoint(ctx, sh);
  const out: CastTargetData[] = [];
  for (const w of who) {
    if (!w.affected && !w.blocked) continue;
    const t = tokens.find((x) => x.id === w.id);
    if (!t) continue;
    out.push(targetRow(ctx, t, origin, barriers, tokens, w.affected ? "in" : "blocked"));
  }
  return out;
}

/**
 * The creatures picked for a targeted spell, each checked: in range, seen, not behind total cover (§8.13). Picks at
 * the same creature: another row each when every pick is an attack of its own (rays, beams), else one row with the
 * count (darts).
 */
function pickedTargets(
  ctx: CommandCtx,
  spell: Spell,
  caster: Caster,
  ids: readonly string[],
  max: number,
): CastTargetData[] {
  if (ids.length > max)
    throw new GloamError(
      "INVALID",
      `${spell.name} takes ${max} ${max === 1 ? "target" : "targets"} at this level.`,
    );
  const dm = isDm(ctx.actor.role);
  const sceneId = caster.token.sceneId;
  const barriers = barriersOf(ctx, sceneId);
  const tokens = ctx.model.inScene("token", sceneId);
  const reach = spell.range.kind === "touch" ? caster.h.stats.reachFt || 5 : spell.range.ft;
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const out: CastTargetData[] = [];
  for (const [id, times] of counts) {
    const t = ctx.model.get("token", id);
    if (!t || t.sceneId !== sceneId || (!dm && ctx.actor.sees && !ctx.actor.sees(id)))
      throw new GloamError("NOT_FOUND", "That creature isn't here.");
    if (!dm && reach !== undefined && (spell.range.kind === "touch" || spell.range.kind === "ranged")) {
      const gap =
        Math.hypot(t.pos.x - caster.token.pos.x, t.pos.y - caster.token.pos.y) -
        t.sizeFt / 2 -
        caster.token.sizeFt / 2;
      if (gap > reach + 0.5) throw new GloamError("INVALID", `${t.name} is out of range (${reach} ft).`);
      const cover = coverHint(caster.token.pos, { pos: t.pos, r: t.sizeFt / 2 }, barriers).cover;
      if (cover === "total" && t.id !== caster.token.id)
        throw new GloamError("BLOCKED", `${t.name} is behind total cover.`);
    }
    if (spell.attack && times > 1)
      for (let k = 0; k < times; k++)
        out.push(
          targetRow(ctx, t, caster.token.pos, barriers, tokens, "in", { key: k ? `${t.id}#${k + 1}` : t.id }),
        );
    else out.push(targetRow(ctx, t, caster.token.pos, barriers, tokens, "in", { times }));
  }
  return out;
}

// ── the caster's state: slot, concentration, pips ─────────────────────────────────────────────────────────

/** The caster's slot spent (or refunded) and its status, in one change of its character (or its token). */
function casterStateOps(
  ctx: CommandCtx,
  c: Caster,
  spend: { kind: "slot" | "pact"; level: number } | null,
  status: TokenStatusT,
  refund = false,
): Op[] {
  if (c.actor) {
    const before = readSheet(c.actor);
    let after = before;
    const sc = before.core.spellcasting;
    if (spend && sc) {
      const d = refund ? -1 : 1;
      const spellcasting =
        spend.kind === "pact" && sc.pact
          ? { ...sc, pact: { ...sc.pact, used: Math.max(0, Math.min(sc.pact.max, sc.pact.used + d)) } }
          : {
              ...sc,
              slots: sc.slots.map((s) =>
                s.level === spend.level ? { ...s, used: Math.max(0, Math.min(s.max, s.used + d)) } : s,
              ),
            };
      after = { ...before, core: { ...before.core, spellcasting } };
    }
    return sheetEditOps(ctx, c.actor, before, after, status);
  }
  return holderOps(ctx, c.h, { hp: c.h.hp, hpTemp: c.h.hpTemp, status });
}

/** A status with its concentration set (or ended: null). */
function withConcentration(s: TokenStatusT, conc: TokenStatusT["concentration"] | null): TokenStatusT {
  const next = { ...s };
  if (conc) next.concentration = conc;
  else delete next.concentration;
  return next;
}

/** In a running combat, the pip its casting time takes (§8.12: a tracker — an Action already used isn't refused). */
function pipOps(ctx: CommandCtx, tokenId: string, unit: Spell["castingTime"]["unit"]): Op[] {
  const bit =
    unit === "action" ? PIP.action : unit === "bonus" ? PIP.bonus : unit === "reaction" ? PIP.reaction : 0;
  if (!bit) return [];
  const c = activeCombat(ctx);
  if (!c) return [];
  const d = dataOf(c);
  if (!d.begun || !d.combatants.some((x) => x.tokenId === tokenId)) return [];
  const op = setPathOp("combat", c, ["data", "pips", tokenId], (d.pips[tokenId] ?? 0) | bit);
  return op ? [op] : [];
}

/** The Silence a token stands in (a Verbal component can't be spoken there). */
function silencedAt(ctx: CommandCtx, t: TokenEntity): EffectEntity | undefined {
  for (const e of ctx.model.inScene("effect", t.sceneId)) {
    if (!e.props.silence) continue;
    const area = effectArea(ctx, e);
    if (area && overlaps(footprint(area), t.pos, t.sizeFt / 2)) return e;
  }
  return undefined;
}

// ── persistent effects ───────────────────────────────────────────────────────────────────────────────────

/** Default colours of spell light (warm for fire, pale for moonlight, gold for radiant). */
const LIGHT_COLOR: Partial<Record<Spell["vfx"], string>> = {
  fire: "#FFB86B",
  radiant: "#FFE7A8",
  cold: "#CFE7FF",
  lightning: "#D8E4FF",
  arcane: "#E3D6FF",
  necrotic: "#B9A7D6",
  poison: "#C9F0B0",
};

/**
 * The effect a cast leaves (§8.13 Persistent effects): on the board where it was placed, on the caster, or on one
 * creature (`on`: Darkvision's, Faerie Fire's glow) — none when the spell is instantaneous or has nothing lasting.
 */
function makeEffect(
  ctx: CommandCtx,
  spell: Spell,
  level: number,
  shape: AreaShape | null,
  caster: Caster,
  castId: string,
  on: string | null,
  chosenType?: DamageType,
): EffectEntity | null {
  const tpl = spell.effect;
  if (!tpl) return null;
  const rounds = durationRounds(spell.duration);
  if (rounds === 0) return null;
  const vfx = vfxFor(spell);
  let sh = shape;
  // A spell that strikes within its lasting area (Call Lightning): the cast was a strike; the effect is the spell's
  // area — the cloud — over its caster (or where the strike was, if the text puts it there).
  if (tpl.strike && spell.area) {
    const home = { x: caster.token.pos.x, y: caster.token.pos.y, z: caster.token.elevation };
    const o = tpl.centre === "caster" || !shape ? home : (originPoint(ctx, shape) ?? home);
    sh = ownArea(spell.area, o, tpl.centre === "caster" ? CLOUD_ABOVE_FT : 0);
  }
  if (!sh) sh = { kind: "emanation", sourceTokenId: on ?? caster.token.id, distance: 0 };
  else if (tpl.attach === "caster" && sh.kind !== "emanation")
    sh = {
      kind: "emanation",
      sourceTokenId: caster.token.id,
      distance: sh.kind === "sphere" ? sh.radius : 0,
    };
  const c = activeCombat(ctx);
  const props: EffectEntity["props"] = {};
  const tp = tpl.props;
  if (tp.difficult) props.difficult = true;
  if (tp.obscurement) props.obscurement = tp.obscurement;
  if (tp.magicalDarkness) props.magicalDarkness = true;
  if (tp.opaque) props.opaque = true;
  if (tp.silence) props.silence = true;
  if (tp.outline) props.outline = true;
  if (tp.speedHalved) {
    props.speedHalved = true;
    // Spirit Guardians: its caster is never slowed by its own spirits (the DM designates others on the effect).
    props.exempt = [caster.token.id];
  }
  if (tp.seeInvisible) props.seeInvisible = true;
  if (tpl.oncePerTurn) props.oncePerTurn = true;
  if (tpl.bodyFt) props.bodyFt = tpl.bodyFt;
  if (tp.senses) props.senses = { ...tp.senses };
  if (tp.light)
    props.light = {
      bright: tp.light.bright,
      dim: tp.light.dim,
      color: tp.light.color ?? LIGHT_COLOR[vfx] ?? "#FFE7A8",
      magical: tp.light.magical,
      pierceDarkness: tp.light.pierceDarkness,
    };
  const dc = caster.dc;
  const damage = spell.damage?.[0];
  return {
    id: newId("eff"),
    sceneId: caster.token.sceneId,
    name: spell.name,
    source: { kind: "spell", contentId: spell.id, casterTokenId: caster.token.id, slot: level, castId },
    shape: sh,
    attachedTokenId: sh.kind === "emanation" ? sh.sourceTokenId : (on ?? null),
    props,
    triggers: tpl.triggers.map((t) => ({
      when: t.when,
      ...(t.save
        ? { save: { ability: t.save.ability, dc: t.save.dc ?? dc ?? 10, onSuccess: t.save.onSuccess } }
        : {}),
      // A trigger's damage grows with the slot like the spell's own (Moonbeam at 3rd: 3d10).
      ...(t.damage
        ? {
            damage: {
              formula:
                damage && damage.formula === t.damage.formula
                  ? scaledFormula(t.damage.formula, damage.scaling, spell.level, level, caster.level)
                  : t.damage.formula,
              // The type the caster chose, where the spell offers one (Spirit Guardians' Necrotic for an evil caster).
              type:
                chosenType && damage?.typeOptions?.includes(chosenType) && t.damage.type === damage.type
                  ? chosenType
                  : t.damage.type,
            },
          }
        : {}),
      ...(t.condition ? { condition: t.condition } : {}),
      ...(t.conditionEnds ? { conditionEnds: t.conditionEnds } : {}),
      ...(t.breaksConcentration ? { breaksConcentration: true } : {}),
      ...(t.side !== undefined ? { sideFt: t.side } : {}),
      ...(t.when === "action"
        ? { strikeFt: tpl.strike && "radius" in tpl.strike ? (tpl.strike.radius as number) : 5 }
        : {}),
      ...(t.note ? { note: t.note } : {}),
    })),
    concentrationTokenId: spell.duration.concentration ? caster.token.id : null,
    // Rounds count in a running combat from the caster's turn; outside one the DM ends it (or a rest does).
    expires:
      rounds !== null && c && dataOf(c).begun
        ? roundsFrom(c.round, caster.token.id, rounds)
        : { never: true },
    visibility: "everyone",
    vfx,
    movement: tpl.movement
      ? {
          by: tpl.movement.by,
          ...(tpl.movement.maxFt !== undefined ? { maxFt: tpl.movement.maxFt } : {}),
          ...(tpl.movement.drift ? { drift: tpl.movement.drift } : {}),
        }
      : null,
    createdAt: ctx.now,
  };
}

/**
 * Light and darkness undo each other (SRD 5.2.1 p. 122): Daylight dispels any spell Darkness of level 3 or lower its
 * area overlaps; Darkness dispels spell light of level 2 or lower it overlaps. The dispelled effects, as delete ops.
 */
/**
 * Light and darkness meeting (SRD p. 122, both spells' texts; rules audit I10), whichever came last: a Darkness
 * overlapping the light of a spell of level 2 or lower dispels that spell; a Daylight overlapping a Darkness of level
 * 3 or lower dispels the Darkness. So a Darkness cast (or moved) into a Daylight of 3rd level or lower goes itself, and
 * a light of 2nd level or lower cast, moved or carried into a Darkness goes itself. A light's area is where it
 * shines (bright and dim, from its source's edge), not its body. `e` is the effect as it now is (created or moved);
 * `self`: whether it is dispelled itself.
 */
function dispelOps(ctx: CommandCtx, e: EffectEntity): Op[] & { self?: boolean } {
  const ops: Op[] & { self?: boolean } = [];
  const lvl = (x: EffectEntity) => (x.source.kind === "spell" ? (x.source.slot ?? 0) : 99);
  const isDaylight = (x: EffectEntity) => x.props.light?.pierceDarkness === true && x.props.light.bright > 0;
  const isDark = (x: EffectEntity) => x.props.magicalDarkness === true;
  const isLight = (x: EffectEntity) => Boolean(x.props.light);
  const mineDark = isDark(e) ? darkArea(ctx, e) : null;
  const mineLit = isLight(e) ? litArea(ctx, e) : null;
  if (!mineDark && !mineLit) return ops;
  for (const o of ctx.model.inScene("effect", e.sceneId)) {
    if (o.id === e.id || o.source.kind !== "spell") continue;
    // This darkness meets that light.
    if (mineDark && isLight(o)) {
      const lit = litArea(ctx, o);
      if (lit && footprintsOverlap(mineDark, lit)) {
        if (lvl(o) <= 2) ops.push(...endEffectOps(ctx, o));
        // A Daylight (3rd) standing there dispels a Darkness of 3rd level or lower coming into it.
        else if (isDaylight(o) && lvl(e) <= 3) ops.self = true;
      }
    }
    // This light meets that darkness.
    if (mineLit && isDark(o)) {
      const dark = darkArea(ctx, o);
      if (dark && footprintsOverlap(mineLit, dark)) {
        if (isDaylight(e) && lvl(o) <= 3) ops.push(...endEffectOps(ctx, o));
        else if (lvl(e) <= 2) ops.self = true;
      }
    }
  }
  return ops;
}

/** A darkness effect's area on the map. */
function darkArea(ctx: CommandCtx, e: EffectEntity): Footprint | null {
  const a = effectArea(ctx, e);
  return a ? footprint(a) : null;
}

/** Where an effect's light shines (bright and dim), as a disc round its centre — from its source's edge. */
function litArea(ctx: CommandCtx, e: EffectEntity): Footprint | null {
  const light = e.props.light;
  const a = effectArea(ctx, e);
  if (!light || !a) return null;
  const f = footprint(a);
  const c =
    f.kind === "circle"
      ? f.c
      : f.kind === "poly"
        ? {
            x: f.points.reduce((s, p) => s + p.x, 0) / f.points.length,
            y: f.points.reduce((s, p) => s + p.y, 0) / f.points.length,
          }
        : (f.points[0] ?? { x: 0, y: 0 });
  const src = e.shape.kind === "emanation" ? ctx.model.get("token", e.shape.sourceTokenId) : undefined;
  const base = src ? src.sizeFt / 2 : e.props.bodyFt ? e.props.bodyFt / 2 : 0;
  return { kind: "circle", c, r: base + light.bright + light.dim };
}

/**
 * An effect ending — ended by the DM or its caster, dispelled, or its time up: it goes, and so does its caster's
 * Concentration on it (§8.13: the spell ends; its other effects and conditions follow in concentration.cleanup).
 */
function endEffectOps(ctx: CommandCtx, e: EffectEntity): Op[] {
  const ops: Op[] = [deleteOp("effect", e)];
  const casterId = e.concentrationTokenId;
  if (casterId && ctx.model.get("token", casterId)) {
    const caster = casterOf(ctx, casterId);
    const conc = caster.h.status.concentration;
    if (conc && (conc.effectId === e.id || (e.source.castId && conc.castId === e.source.castId)))
      ops.push(...casterStateOps(ctx, caster, null, withConcentration(caster.h.status, null)));
  }
  return ops;
}

/** Whose turn it is in the scene's running fight, if one has begun. */
function activeTurnOf(ctx: CommandCtx): string | undefined {
  const cb = activeCombat(ctx);
  const d = cb ? dataOf(cb) : null;
  return cb && d?.begun ? d.combatants[cb.turnIndex]?.tokenId : undefined;
}

/** How high over its caster a cloud it calls stands (Call Lightning: "at a point … above yourself"). */
const CLOUD_ABOVE_FT = 20;

/** An effect's own area placed at a point (Call Lightning's cloud), raised by `z` over it. */
function ownArea(a: SpellArea, o: { x: number; y: number; z: number }, z: number): AreaShape {
  const at = { x: o.x, y: o.y, z: o.z + z };
  switch (a.shape) {
    case "cylinder":
      return { kind: "cylinder", origin: at, radius: a.radius, height: a.height };
    case "cube":
      return { kind: "cube", origin: at, dirDeg: 0, size: a.size, originOnFace: false };
    case "sphere":
      return { kind: "sphere", origin: at, radius: a.radius };
    default:
      return { kind: "sphere", origin: at, radius: "radius" in a ? (a.radius as number) : 5 };
  }
}

/**
 * Whether the cast itself resolves on a card. A lasting area whose triggers are what act (Web, Spirit Guardians,
 * Stinking Cloud, Sleet Storm, Spike Growth, Flaming Sphere) asks nothing of those already in it when it appears — only
 * where the text says they save then (`onAppear`: Moonbeam, Cloudkill, Wall of Fire); an effect on each target that
 * fails (Faerie Fire) and one whose only trigger is its caster's action (Call Lightning's first bolt) resolve at once.
 */
function castResolves(spell: Spell): boolean {
  const e = spell.effect;
  if (!e || e.attach === "target" || e.onAppear) return true;
  return !e.triggers.some((t) => t.when !== "action");
}

// ── the card ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a spell's card resolves (nothing: a utility spell leaves no card). */
function needsCard(spell: Spell): boolean {
  return Boolean(
    spell.save ||
      spell.attack ||
      spell.damage?.length ||
      spell.healing ||
      spell.conditions?.some((c) => c.onFailedSave) ||
      (spell.effect?.attach === "target" && spell.save),
  );
}

function damageOf(
  spell: Spell,
  level: number,
  caster: Caster,
  chosen: DamageType | undefined,
): CastData["damage"] {
  if (spell.healing) {
    const f = scaledFormula(spell.healing.formula, spell.healing.scaling, spell.level, level, caster.level);
    return {
      parts: [{ formula: resolveRefs(f, caster.refs), type: "force" }],
      healing: true,
      per: "cast",
      roll: null,
    };
  }
  if (!spell.damage?.length) return null;
  const parts = spell.damage.map((d, i) => {
    const f = scaledFormula(d.formula, d.scaling, spell.level, level, caster.level);
    const type = i === 0 && chosen && (d.typeOptions ?? [d.type]).includes(chosen) ? chosen : d.type;
    return { formula: resolveRefs(f, caster.refs), type };
  });
  // A save spell rolls once for everyone (Fireball); an attack or a dart rolls for each target it hits.
  return { parts, healing: false, per: spell.save ? "cast" : "target", roll: null };
}

/** The formula a row's damage rolls with: the card's parts, a dart's times over, doubled dice on a critical hit. */
export function rowFormula(
  c: CastData,
  t: CastTargetData | null,
): { formula: string; parts: CastData["damage"] } {
  const dmg = c.damage;
  if (!dmg) return { formula: "", parts: null };
  const times = t?.times ?? 1;
  const parts = dmg.parts.map((p) => ({
    ...p,
    formula: times > 1 ? addDice(p.formula, p.formula, times - 1) : p.formula,
  }));
  return {
    formula: parts.map((p) => `${p.formula}${dmg.healing ? "" : ` [${p.type}]`}`).join(" + "),
    parts: { ...dmg, parts },
  };
}

function subtitleOf(spell: Spell, level: number, mode: "slot" | "ritual" | "free"): string {
  const base = spell.level === 0 ? "cantrip" : `${SPELL_LEVEL_NAMES[level]} level`;
  return mode === "ritual"
    ? `${base}, as a ritual`
    : mode === "free" && spell.level > 0
      ? `${base}, no slot`
      : base;
}

function mustCast(ctx: CommandCtx, id: string): CastEntity {
  const c = mustGet(ctx, "cast", id);
  if (c.campaignId !== ctx.model.campaign.id)
    throw new GloamError("NOT_FOUND", "That card no longer exists.");
  return c;
}

export function openCast(ctx: CommandCtx, id: string): CastEntity {
  const c = mustCast(ctx, id);
  if (c.status !== "open") throw new GloamError("CONFLICT", "That card is closed.");
  return c;
}

/** Who may roll on a card: the DM, or the caster's players. */
export function castMayRoll(ctx: CommandCtx, c: CastEntity): boolean {
  if (isDm(ctx.actor.role)) return true;
  const t = c.data.caster.tokenId ? ctx.model.get("token", c.data.caster.tokenId) : undefined;
  return Boolean(t && ctx.actor.role === "player" && t.ownerIds.includes(ctx.actor.userId));
}

export function rowIndex(c: CastEntity, key: string): number {
  const i = c.data.targets.findIndex((t) => t.key === key);
  if (i < 0) throw new GloamError("NOT_FOUND", "That creature isn't on the card.");
  return i;
}

const castPathOp = (c: CastEntity, path: string[], value: unknown): Op[] => {
  const op = setPathOp("cast", c, ["data", ...path], value);
  return op ? [op] : [];
};

/** `spell.cast` (§8.13 Casting flow; AC-SPL-03/04/06/07). */
export const spellCast: CommandDef<
  z.infer<typeof SpellCast>,
  { castId: string | null; effectId: string | null; given: string[] }
> = {
  type: "spell.cast",
  schema: SpellCast as unknown as z.ZodType<z.infer<typeof SpellCast>>,
  undoable: true,
  authorize(ctx, p) {
    const t = mustGet(ctx, "token", p.casterTokenId);
    mayAct(ctx, t);
    const spell = spellById(ctx, p.spellId);
    if (!spell) throw new GloamError("NOT_FOUND", "That spell isn't in this campaign.");
    const dm = isDm(ctx.actor.role);
    const c = casterOf(ctx, t.id);
    // The slot: a cantrip needs none; a ritual is cast at its own level; a free cast at any; else a slot left.
    if (spell.level > 0 && p.mode === "slot") {
      if (!p.slot) throw new GloamError("INVALID", "Choose the slot to cast it with.");
      if (p.slot.level < spell.level)
        throw new GloamError("INVALID", `${spell.name} needs a slot of level ${spell.level} or higher.`);
      if (!c.actor)
        throw new GloamError("INVALID", "Only a character's sheet has slots — cast it without one.");
      const sc = c.sheet?.core.spellcasting;
      const row = sc?.slots.find((s) => s.level === p.slot?.level);
      const left =
        p.slot.kind === "pact"
          ? sc?.pact && sc.pact.level === p.slot.level
            ? sc.pact.max - sc.pact.used
            : 0
          : (row?.max ?? 0) - (row?.used ?? 0);
      if (left <= 0)
        throw new GloamError("INVALID", `No ${SPELL_LEVEL_NAMES[p.slot.level]}-level slots left.`);
    }
    if (p.mode === "ritual" && !spell.ritual)
      throw new GloamError("INVALID", `${spell.name} isn't a ritual.`);
    if (!p.narrative) roomForACard(ctx, t);
    if (!dm) {
      // On the scene in play (a token left on a prep scene isn't at the table).
      if (t.sceneId !== ctx.model.campaign.activeSceneId)
        throw new GloamError("FORBIDDEN", `${t.name} isn't on the scene in play.`);
      // An area's size is the spell's (and its slot's); resizing one is the DM's (P2).
      if (p.placement?.size !== undefined)
        throw new GloamError("FORBIDDEN", "Only the DM can change an area's size.");
      // Without a slot (P2's override for a sheet that's wrong): a spell the sheet has, at a level it could cast.
      if (p.mode === "free" && spell.level > 0) {
        const sc = c.sheet?.core.spellcasting;
        const has = sc?.spells.some(
          (x) => x.contentId === spell.id || x.name.trim().toLowerCase() === spell.name.toLowerCase(),
        );
        if (!has)
          throw new GloamError(
            "FORBIDDEN",
            `${spell.name} isn't on ${t.name}'s sheet — only the DM can cast it without a slot.`,
          );
        const top = Math.max(
          spell.level,
          ...(sc?.slots ?? []).filter((s) => s.max > 0).map((s) => s.level),
          sc?.pact?.level ?? 0,
        );
        if ((p.level ?? spell.level) > top)
          throw new GloamError(
            "FORBIDDEN",
            `${t.name} can cast it at ${SPELL_LEVEL_NAMES[top]} level at most.`,
          );
      }
    }
    // Concentration (§8.13): a second one asks first.
    const conc = c.h.status.concentration;
    if (spell.duration.concentration && conc && !p.endConcentration)
      throw new GloamError("CONFLICT", `${t.name} is concentrating on ${conc.spellName ?? "a spell"}.`, {
        concentrating: conc.spellName ?? null,
      });
    if (!dm) {
      // Its own turn for an action or a bonus action; a reaction any time.
      const cb = activeCombat(ctx);
      const d = cb ? dataOf(cb) : null;
      if (
        cb &&
        d?.begun &&
        d.combatants.some((x) => x.tokenId === t.id) &&
        (spell.castingTime.unit === "action" || spell.castingTime.unit === "bonus") &&
        d.combatants[cb.turnIndex]?.tokenId !== t.id
      )
        throw new GloamError("NOT_YOUR_TURN", `It isn't ${t.name}'s turn — only a reaction can be cast now.`);
      const hush = spell.components.v ? silencedAt(ctx, t) : undefined;
      if (hush)
        throw new GloamError(
          "FORBIDDEN",
          // A Silence the DM keeps hidden isn't named (the caster finds no sound comes out).
          hush.visibility === "everyone"
            ? `${t.name} is inside Silence: no spell with a Verbal component.`
            : `${t.name} can't make a sound here: no spell with a Verbal component.`,
        );
    }
  },
  plan(ctx, p) {
    const spell = spellById(ctx, p.spellId) as Spell;
    const caster = casterOf(ctx, p.casterTokenId);
    const t = caster.token;
    const dm = isDm(ctx.actor.role);
    // A ritual is cast at its own level only (SRD p. 187); a free cast at the level asked.
    const level =
      spell.level === 0
        ? 0
        : p.mode === "slot"
          ? (p.slot?.level ?? spell.level)
          : p.mode === "ritual"
            ? spell.level
            : Math.max(spell.level, p.level ?? spell.level);
    const castId = newId("cst");
    const ops: Op[] = [];
    const kind = targetingKind(spell);
    const spend = spell.level > 0 && p.mode === "slot" && p.slot ? p.slot : null;

    // Where it goes, and who it takes.
    let shape: AreaShape | null = null;
    let targets: CastTargetData[] = [];
    // Where it strikes: its strike's area under a lasting one (Call Lightning's bolt), else its (alternative) area.
    const area = castArea(spell, p.placement?.alt) ?? null;
    // What it hangs on: the caster, a creature, an object (held, or put down at a point) — the holder checked.
    const attach = castAttach(spell, p.placement?.alt);
    const onto = castOnto(
      ctx,
      spell,
      attach,
      t,
      p.placement?.attachTo ??
        // The DM's older way to name the holder of a spell cast on an object (Light on a creature's torch).
        (dm && attach === "object" && !area ? p.targets?.[0] : undefined),
      dm,
    );
    if (!p.narrative && area && kind === "area") {
      // An area that is simply round the caster (an emanation; a sphere on itself) has nothing to place: an API
      // caller needn't send a placement for it.
      const around: Placement | undefined =
        area.shape === "emanation" || (spell.range.kind === "self" && area.shape === "sphere")
          ? { origin: { x: t.pos.x, y: t.pos.y, z: t.elevation }, dirDeg: 0 }
          : undefined;
      const pl: Placement | undefined = p.placement ?? around;
      if (!pl) throw new GloamError("INVALID", "Place the area first.");
      shape = placeShape(spell, area, level, pl, t, attach, onto);
      if (shape.kind === "wall" && !dm) {
        const scaled = areaAtSlot(area, spell.level, level);
        const max =
          scaled.shape === "wall" ? (pl.closed && scaled.ring ? Math.PI * scaled.ring : scaled.length) : 0;
        if (wallLength(shape) > max + 0.5)
          throw new GloamError("INVALID", `The wall can be at most ${Math.round(max)} ft long.`);
      }
      // In range, with a clear line from the caster (§17.3) — the DM may place anywhere (P2).
      const o = originPoint(ctx, shape);
      // A strike from a lasting area over its caster (Call Lightning's bolt) lands under it.
      const reach = spell.effect?.strike && spell.effect.centre === "caster" ? spell.area : undefined;
      if (
        !dm &&
        o &&
        reach &&
        "radius" in reach &&
        Math.hypot(o.x - t.pos.x, o.y - t.pos.y) > reach.radius + 0.5
      )
        throw new GloamError("INVALID", `That point isn't under ${spell.name}'s cloud.`);
      if (!dm && o && spell.range.kind !== "self") {
        const r =
          spell.range.kind === "touch"
            ? { kind: "touch" as const, reach: caster.h.stats.reachFt || 5 }
            : spell.range.kind === "ranged" && spell.range.ft !== undefined
              ? { kind: "ft" as const, ft: spell.range.ft }
              : null;
        if (r) {
          const ok = canPlace(bodyOf(t), o, r, barriersOf(ctx, t.sceneId));
          if (!ok.ok)
            throw new GloamError(
              ok.why === "range" ? "INVALID" : "BLOCKED",
              ok.why === "range" ? "That point is out of range." : "No clear path to that point.",
            );
        }
      }
      const sourceId =
        shape.kind === "emanation" ? shape.sourceTokenId : spell.range.kind === "self" ? t.id : null;
      targets = areaTargets(ctx, shape, t.sceneId, { sourceId, includeSource: p.includeSelf });
    } else if (!p.narrative && kind === "creatures") {
      targets = pickedTargets(ctx, spell, caster, p.targets ?? [], targetCount(spell, level, caster.level));
    } else if (!p.narrative && kind === "self") {
      targets = [targetRow(ctx, t, null, [], [], "in")];
    }

    // What stays on the board.
    let effect: EffectEntity | null = null;
    const effects: EffectEntity[] = [];
    if (!p.narrative && spell.effect) {
      if (spell.effect.attach === "target") {
        // On each creature it's cast on (Darkvision, True Seeing); Faerie Fire's come with its card, on a failed save.
        if (kind !== "area")
          for (const x of targets) {
            const e = makeEffect(ctx, spell, level, null, caster, castId, x.id, p.damageType);
            if (e) effects.push(e);
          }
      } else {
        // On an object with no area of its own (Light): the caster's gear or the token the DM chose (the holder), or
        // an object put down at a point within reach — the light shines from there.
        let at = shape;
        if (!at && attach === "object" && !onto) {
          const o = p.placement?.origin;
          if (!o)
            throw new GloamError(
              "INVALID",
              `Choose what ${spell.name} is cast on: something ${t.name} carries, or a point within reach.`,
            );
          if (!dm) {
            const ok = canPlace(
              bodyOf(t),
              o,
              spell.range.kind === "touch"
                ? { kind: "touch", reach: caster.h.stats.reachFt || 5 }
                : { kind: "ft", ft: spell.range.kind === "ranged" ? (spell.range.ft ?? 5) : 5 },
              barriersOf(ctx, t.sceneId),
            );
            if (!ok.ok)
              throw new GloamError(
                ok.why === "range" ? "INVALID" : "BLOCKED",
                ok.why === "range" ? "That point is out of reach." : "No clear path to that point.",
              );
          }
          at = { kind: "sphere", origin: { x: o.x, y: o.y, z: o.z }, radius: 0 };
        }
        // Cast again, the earlier one ends (Light).
        if (spell.effect.recastEnds)
          for (const old of ctx.model.all("effect"))
            if (old.source.contentId === spell.id && old.source.casterTokenId === t.id)
              ops.push(...endEffectOps(ctx, old));
        effect = makeEffect(ctx, spell, level, at, caster, castId, onto, p.damageType);
        if (effect) effects.push(effect);
      }
    }
    const dispelled = new Set<string>();
    for (const e of effects) {
      const d = dispelOps(ctx, e);
      ops.push(...d);
      // Cast into what dispels it (a Light into a Darkness): the slot is spent, nothing stays.
      if (d.self) dispelled.add(e.id);
      else ops.push(createOp("effect", e));
    }
    if (effect && dispelled.has(effect.id)) effect = null;

    // The caster: its slot, its concentration (the old one's effects go after this commit — concentration.cleanup).
    const concentration = spell.duration.concentration
      ? { spellId: spell.id, spellName: spell.name, castId, ...(effect ? { effectId: effect.id } : {}) }
      : undefined;
    let casterStatus = concentration ? withConcentration(caster.h.status, concentration) : caster.h.status;

    // Conditions a touch or self spell simply gives (Invisibility): on at once, for as long as the spell lasts.
    const given: string[] = [];
    const gives = (spell.conditions ?? []).filter((x) => !x.onFailedSave);
    if (!p.narrative && gives.length && !spell.save && !spell.attack && kind !== "area") {
      for (const x of targets) {
        const h = x.id === t.id ? { ...caster.h, status: casterStatus } : holderOf(ctx, { tokenId: x.id });
        let s = h.status;
        for (const g of gives)
          if (!s.conditions.some((k) => k.id === g.id) && !h.stats.conditionImmune.includes(g.id))
            s = {
              ...s,
              conditions: [
                ...s.conditions,
                {
                  id: g.id,
                  source: spell.name,
                  sourceTokenId: t.id,
                  ...(spell.duration.concentration ? { castId } : {}),
                },
              ],
            };
        if (s === h.status) continue;
        if (x.id === t.id) casterStatus = s;
        else ops.push(...holderOps(ctx, h, { hp: h.hp, hpTemp: h.hpTemp, status: s }));
        given.push(x.id);
      }
    }
    ops.unshift(...casterStateOps(ctx, caster, spend, casterStatus));
    ops.push(...pipOps(ctx, t.id, spell.castingTime.unit));

    // The card.
    const inArea = targets.filter((x) => x.state === "in");
    const card =
      !p.narrative && needsCard(spell) && castResolves(spell) && (targets.length > 0 || Boolean(shape));
    let cast: CastEntity | null = null;
    let burst: CastEntity | null = null;
    if (card) {
      const origin = shape ? originPoint(ctx, shape) : { x: t.pos.x, y: t.pos.y, z: t.elevation };
      const data: CastData = {
        kind: "spell",
        name: spell.name,
        subtitle: subtitleOf(spell, level, p.mode),
        spell,
        spellId: spell.id,
        level,
        spent:
          spend && caster.actor ? { actorId: caster.actor.id, kind: spend.kind, level: spend.level } : null,
        caster: { tokenId: t.id, actorId: caster.actor?.id ?? null, name: t.name },
        origin,
        area: shape,
        save: spell.save ? { ability: spell.save.ability, onSuccess: spell.save.onSuccess } : null,
        dc: spell.save ? caster.dc : null,
        dcRevealed: false,
        attack: spell.attack
          ? {
              formula: `1d20 ${(caster.attackBonus ?? 0) < 0 ? "-" : "+"} ${Math.abs(caster.attackBonus ?? 0)}`,
              kind: spell.attack.kind,
            }
          : null,
        damage: damageOf(spell, level, caster, p.damageType),
        conditions: (spell.conditions ?? [])
          .filter((x) => x.onFailedSave)
          .map((x) => ({
            id: x.id,
            onFailedSave: true,
            ...(x.duration?.rounds ? { rounds: x.duration.rounds } : {}),
            ...(x.duration?.until ? { until: x.duration.until } : {}),
            ...(x.choice ? { choice: x.choice } : {}),
            ...(x.stage ? { stage: x.stage } : {}),
            ...(x.pick ? { pick: true } : {}),
          })),
        targets: targets.map((x) =>
          spell.save && x.state === "in"
            ? { ...x, save: playersRoll(ctx, x) ? { pending: true, by: "player" as const } : {} }
            : x,
        ),
        effectId: effect?.id ?? null,
        concentration: spell.duration.concentration,
        requestId: null,
        vfx: vfxFor(spell),
        createdBy: ctx.actor.userId,
      };
      // An attack that then bursts (Ice Knife, rules audit m11): this card is the attack and what rides on its hit;
      // the burst — hit or miss — is a card of its own, the target and those round it making the save.
      if (spell.attack && spell.save && spell.splash && data.damage) {
        const onHit = (spell.damage ?? []).map((x) => x.on !== "save");
        data.save = null;
        data.dc = null;
        data.targets = data.targets.map(({ save: _s, ...x }) => x);
        data.damage = { ...data.damage, per: "target", parts: data.damage.parts.filter((_, i) => onHit[i]) };
        burst = splashCard(ctx, spell, level, caster, data, targets, p.damageType);
      }
      cast = {
        id: castId,
        campaignId: ctx.model.campaign.id,
        sceneId: t.sceneId,
        status: "open",
        data,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      ops.push(createOp("cast", cast));
      if (burst) ops.push(createOp("cast", burst));
    }
    const what = `${spell.name}${spell.level > 0 ? ` (${SPELL_LEVEL_NAMES[level]} level)` : ""}`;
    const line: CastLine = {
      casterTokenId: t.id,
      caster: t.name,
      verb: "casts",
      what,
      targets: inArea.map((x) => ({ id: x.id, name: x.name })),
      count: Boolean(card),
    };
    const follow: CastFollowup = {
      castId: cast?.id ?? null,
      line,
      spellId: spell.id,
      ...(p.narrative
        ? {}
        : {
            fx: {
              casterTokenId: t.id,
              preset: vfxFor(spell),
              shape,
              targets: [...new Set(inArea.map((x) => x.id))],
              kind: shape
                ? "burst"
                : spell.attack || (spell.damage?.length && kind === "creatures")
                  ? "projectile"
                  : "instant",
            },
          }),
      ...(cast && spell.save
        ? {
            askSaves: [
              ...new Set(
                cast.data.targets.filter((x) => x.state === "in" && playersRoll(ctx, x)).map((x) => x.id),
              ),
            ],
          }
        : {}),
    };
    const events: RoomEvent[] = [{ name: CAST_FOLLOWUP, payload: follow, to: { dms: true } }];
    // The burst's save cards (Ice Knife).
    if (burst)
      events.push({
        name: CAST_FOLLOWUP,
        payload: {
          castId: burst.id,
          askSaves: [
            ...new Set(
              burst.data.targets.filter((x) => x.state === "in" && playersRoll(ctx, x)).map((x) => x.id),
            ),
          ],
        } satisfies CastFollowup,
        to: { dms: true },
      });
    // The history's words: who cast what — no count of creatures (the caster may not perceive them all).
    return {
      ops,
      summary: `${t.name} casts ${what}${p.mode === "free" && spell.level > 0 ? " (no slot)" : p.mode === "ritual" ? " (ritual)" : ""}`,
      sceneId: t.sceneId,
      events,
      result: { castId: cast?.id ?? null, effectId: effect?.id ?? null, given },
    };
  },
};

/** `attack.start` (§8.13 Weapons and abilities; AC-SPL-12): a sheet's attack through the same card. */
export const attackStart: CommandDef<z.infer<typeof AttackStart>, { castId: string }> = {
  type: "attack.start",
  schema: AttackStart,
  undoable: true,
  authorize(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    mayAct(ctx, t);
    const c = casterOf(ctx, t.id);
    const a = c.sheet?.core.attacks[p.attack];
    if (!a) throw new GloamError("NOT_FOUND", "That attack isn't on the sheet.");
    if (!a.attack && !a.damage) throw new GloamError("INVALID", `${a.name} has no attack or damage to roll.`);
    if (isDm(ctx.actor.role)) return;
    roomForACard(ctx, t);
    // A player's attack as the rules have one (security review L1, rules audit I12): on the scene in play, on its
    // own turn in combat (an action), at most four swings (the Attack action's most, Extra Attack at its highest — the
    // DM makes more), each at a creature they see, within its range (SRD p. 16), not behind total cover (p. 106).
    if (t.sceneId !== ctx.model.campaign.activeSceneId)
      throw new GloamError("FORBIDDEN", `${t.name} isn't on the scene in play.`);
    if (p.targets.length > 4)
      throw new GloamError("INVALID", "An Attack action is four attacks at most — the DM can add more.");
    const cb = activeCombat(ctx);
    const d = cb ? dataOf(cb) : null;
    if (
      cb &&
      d?.begun &&
      d.combatants.some((x) => x.tokenId === t.id) &&
      d.combatants[cb.turnIndex]?.tokenId !== t.id
    )
      throw new GloamError("NOT_YOUR_TURN", `It isn't ${t.name}'s turn.`);
    const reach = attackRangeFt(a.range);
    const walls = barriersOf(ctx, t.sceneId, { known: true });
    for (const id of new Set(p.targets)) {
      const x = ctx.model.get("token", id);
      if (!x || x.sceneId !== t.sceneId || (ctx.actor.sees && !ctx.actor.sees(id)))
        throw new GloamError("NOT_FOUND", "That creature isn't here.");
      const gap = Math.hypot(x.pos.x - t.pos.x, x.pos.y - t.pos.y) - x.sizeFt / 2 - t.sizeFt / 2;
      if (gap > reach + 0.5) throw new GloamError("INVALID", `${x.name} is out of range (${reach} ft).`);
      if (coverHint(t.pos, { pos: x.pos, r: x.sizeFt / 2 }, walls, []).cover === "total")
        throw new GloamError("BLOCKED", `${x.name} is behind total cover.`);
    }
  },
  plan(ctx, p) {
    const caster = casterOf(ctx, p.tokenId);
    const t = caster.token;
    const a = caster.sheet?.core.attacks[p.attack] as NonNullable<Sheet["core"]["attacks"][number]>;
    const dm = isDm(ctx.actor.role);
    const barriers = barriersOf(ctx, t.sceneId);
    const tokens = ctx.model.inScene("token", t.sceneId);
    const counts = new Map<string, number>();
    for (const id of p.targets) counts.set(id, (counts.get(id) ?? 0) + 1);
    const targets: CastTargetData[] = [];
    for (const [id, times] of counts) {
      const x = ctx.model.get("token", id);
      if (!x || x.sceneId !== t.sceneId || (!dm && ctx.actor.sees && !ctx.actor.sees(id)))
        throw new GloamError("NOT_FOUND", "That creature isn't here.");
      // Each swing at the same creature is an attack of its own (Extra Attack).
      for (let k = 0; k < times; k++)
        targets.push(
          targetRow(ctx, x, t.pos, barriers, tokens, "in", { key: k ? `${x.id}#${k + 1}` : x.id }),
        );
    }
    // "1d8 + @str [slashing]": its trailing tag types the damage (§18.1).
    const parts: { formula: string; type: DamageType }[] = [];
    if (a.damage) {
      const parsed = parseFormula(a.damage);
      const type = (parsed.tag ?? "bludgeoning") as DamageType;
      const body = a.damage.replace(/\s*\[[^\]]+\]\s*$/, "");
      parts.push({ formula: resolveRefs(body, caster.refs), type });
    }
    const castId = newId("cst");
    const melee = !a.range || /^\s*(5|10)\s*(ft|feet)/i.test(a.range) || /reach|melee/i.test(a.range);
    const data: CastData = {
      kind: "attack",
      name: a.name,
      subtitle: melee ? "melee attack" : "ranged attack",
      spell: null,
      spellId: null,
      level: null,
      spent: null,
      caster: { tokenId: t.id, actorId: caster.actor?.id ?? null, name: t.name },
      origin: { x: t.pos.x, y: t.pos.y, z: t.elevation },
      area: null,
      save: null,
      dc: null,
      dcRevealed: false,
      attack: a.attack
        ? { formula: resolveRefs(a.attack, caster.refs), kind: melee ? "melee" : "ranged" }
        : null,
      damage: parts.length ? { parts, healing: false, per: "target", roll: null } : null,
      conditions: [],
      targets,
      effectId: null,
      concentration: false,
      requestId: null,
      vfx: "force",
      createdBy: ctx.actor.userId,
    };
    const cast: CastEntity = {
      id: castId,
      campaignId: ctx.model.campaign.id,
      sceneId: t.sceneId,
      status: "open",
      data,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    const line: CastLine = {
      casterTokenId: t.id,
      caster: t.name,
      verb: "attacks",
      what: a.name,
      targets: targets.map((x) => ({ id: x.id, name: x.name })),
      count: false,
    };
    const follow: CastFollowup = { castId, line, spellId: null };
    return {
      ops: [createOp("cast", cast), ...pipOps(ctx, t.id, "action")],
      summary: castLineText(line, line.targets),
      sceneId: t.sceneId,
      events: [{ name: CAST_FOLLOWUP, payload: follow, to: { dms: true } }],
      result: { castId },
    };
  },
};

/** `cast.target` (DM): a creature in or out of the list — a blocked one added anyway, a new one picked. */
export const castTarget: CommandDef<z.infer<typeof CastTarget>, { state: string }> = {
  type: "cast.target",
  schema: CastTarget,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    openCast(ctx, p.castId);
  },
  plan(ctx, p) {
    const c = openCast(ctx, p.castId);
    const i = c.data.targets.findIndex((t) => t.key === p.targetId);
    const events: RoomEvent[] = [];
    const ask = (id: string): RoomEvent => ({
      name: CAST_FOLLOWUP,
      payload: { castId: c.id, askSaves: [id] } satisfies CastFollowup,
      to: { dms: true },
    });
    if (i < 0) {
      if (!p.include) return { ops: [], summary: "", result: { state: "removed" }, undoable: false };
      const t = mustGet(ctx, "token", p.targetId);
      if (t.sceneId !== c.sceneId) throw new GloamError("NOT_FOUND", "That creature isn't on this scene.");
      const row = targetRow(
        ctx,
        t,
        c.data.origin,
        barriersOf(ctx, t.sceneId),
        ctx.model.inScene("token", t.sceneId),
        "in",
      );
      const full = c.data.save
        ? { ...row, save: playersRoll(ctx, row) ? { pending: true, by: "player" as const } : {} }
        : row;
      if (c.data.save && row.pc) events.push(ask(row.id));
      return {
        ops: castPathOp(c, ["targets"], [...c.data.targets, full]),
        summary: `${c.data.name}: ${t.name} added`,
        events,
        result: { state: "in" },
      };
    }
    const row = c.data.targets[i] as CastTargetData;
    if (row.state === "applied" || row.state === "skipped")
      throw new GloamError("CONFLICT", `${row.name} is already ${row.state}.`);
    const state = p.include ? "in" : "removed";
    const needsSave = p.include && c.data.save && !row.save;
    if (needsSave && row.pc) events.push(ask(row.id));
    return {
      ops: [
        ...castPathOp(c, ["targets", String(i), "state"], state),
        ...(needsSave
          ? castPathOp(c, ["targets", String(i), "save"], row.pc ? { pending: true, by: "player" } : {})
          : []),
      ],
      summary: `${c.data.name}: ${row.name} ${p.include ? "added" : "left out"}`,
      events,
      result: { state },
    };
  },
};

/** `cast.set` (DM): a target's row edited — its save, hit, outcome, adjustments, conditions, final number. */
export const castSet: CommandDef<z.infer<typeof CastSet>, { ok: true }> = {
  type: "cast.set",
  schema: CastSet,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    rowIndex(openCast(ctx, p.castId), p.targetId);
  },
  plan(ctx, p) {
    const c = openCast(ctx, p.castId);
    const i = String(rowIndex(c, p.targetId));
    const row = c.data.targets[Number(i)] as CastTargetData;
    const ops: Op[] = [];
    if (p.saveSuccess !== undefined)
      ops.push(
        ...castPathOp(c, ["targets", i, "save"], {
          ...(row.save ?? {}),
          success: p.saveSuccess,
          pending: false,
          by: row.save?.by ?? "dm",
        }),
      );
    if (p.hit !== undefined && row.attack) ops.push(...castPathOp(c, ["targets", i, "attack", "hit"], p.hit));
    if (p.crit !== undefined && row.attack)
      ops.push(
        ...castPathOp(c, ["targets", i, "attack"], {
          ...row.attack,
          crit: p.crit,
          // A critical hit hits (SRD p. 16).
          ...(p.crit ? { hit: true } : {}),
        }),
      );
    if (p.outcome) ops.push(...castPathOp(c, ["targets", i, "outcome"], p.outcome));
    if (p.ignore) ops.push(...castPathOp(c, ["targets", i, "ignore"], { ...row.ignore, ...p.ignore }));
    if (p.conditions) ops.push(...castPathOp(c, ["targets", i, "conditions"], p.conditions));
    if (p.final !== undefined) ops.push(...castPathOp(c, ["targets", i, "final"], p.final));
    return { ops, summary: `${c.data.name}: ${row.name} changed`, result: { ok: true } };
  },
};

/** `cast.revealDc` (DM): the DC shown on the players' save cards, or hidden again. */
export const castRevealDc: CommandDef<z.infer<typeof CastRevealDc>, { ok: true }> = {
  type: "cast.revealDc",
  schema: CastRevealDc,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    openCast(ctx, p.castId);
  },
  plan(ctx, p) {
    const c = openCast(ctx, p.castId);
    return {
      ops: castPathOp(c, ["dcRevealed"], p.reveal),
      summary: `${c.data.name}: DC ${p.reveal ? "shown" : "hidden"}`,
      result: { ok: true },
    };
  },
};

/**
 * What a row takes (§8.13 "per-target outcome"): the DM's choice, else — an attack: full on a hit, none on a miss or
 * before it's rolled; a save: from the spell's save effect (a creature that fails automatically fails); else full.
 */
export function outcomeOf(c: CastData, t: CastTargetData): "full" | "half" | "none" {
  if (t.outcome) return t.outcome;
  if (c.attack) return t.attack?.hit ? "full" : "none";
  if (c.save) return saveOutcome(c.save.onSuccess, t.save?.autoFail ? false : (t.save?.success ?? null));
  return "full";
}

/** The damage (or healing) a row rolls with: its own roll, else the card's. */
export function rollOf(c: CastData, t: CastTargetData): DamageRoll | null {
  return c.damage?.per === "target" ? (t.roll ?? null) : (c.damage?.roll ?? null);
}

/** A holder's resistances with the DM's toggles (auto, each toggleable). */
export function adjusted(h: Holder, ignore: CastTargetData["ignore"]): Holder {
  return {
    ...h,
    stats: {
      ...h.stats,
      resist: ignore.resist ? [] : h.stats.resist,
      vuln: ignore.vuln ? [] : h.stats.vuln,
      immune: ignore.immune ? [] : h.stats.immune,
    },
    status: ignore.resist
      ? { ...h.status, conditions: h.status.conditions.filter((x) => x.id !== "petrified") }
      : h.status,
  };
}

/**
 * A creature entirely inside a Silence is immune to Thunder damage (SRD p. 162; rules audit I6) — as the DM sees
 * it, whoever else is shown the Silence.
 */
export function silenced(ctx: CommandCtx, h: Holder): Holder {
  if (!h.token || h.stats.immune.includes("thunder") || !inSilence(ctx.model, h.token)) return h;
  return { ...h, stats: { ...h.stats, immune: [...h.stats.immune, "thunder"] } };
}

/**
 * A row's damage as the SRD counts instances (p. 17): one per attack or ray (a row), and one per dart of a row
 * picked more than once (Magic Missile's darts at one creature, p. 146) — its total shared among them as evenly as it
 * goes (the first takes what's left), each type likewise.
 */
export function rowInstances(
  c: CastData,
  t: CastTargetData,
): { amount: number; type: DamageType | "untyped" }[][] {
  const x = rowParts(c, t);
  if (!x) return [];
  const n = Math.max(1, t.times ?? 1);
  if (n === 1) return [x.parts];
  return Array.from({ length: n }, (_, i) =>
    x.parts.map((p) => {
      const each = Math.floor(p.amount / n);
      return { type: p.type, amount: i === 0 ? p.amount - each * (n - 1) : each };
    }),
  );
}

/** The conditions a row's hit (or failed save) lands (the DM's choice, else the spell's). */
export function conditionsFor(c: CastData, t: CastTargetData): ConditionId[] {
  if (t.conditions) return t.conditions;
  // What lands at first (rules audit I11): one of each group of alternatives (its first — the DM picks another),
  // no later stage (Sleep's Unconscious waits for a second failure), nothing the DM has to judge (Divine Word).
  const seen = new Set<string>();
  const first = c.conditions.filter((x) => {
    if (x.stage || x.pick) return false;
    if (!x.choice) return true;
    if (seen.has(x.choice)) return false;
    seen.add(x.choice);
    return true;
  });
  // A save not rolled when the DM applies counts as failed — for the conditions as for the damage (rules audit m7).
  const failed = c.save ? (t.save?.autoFail ? true : t.save?.success !== true) : true;
  const hit = c.attack ? t.attack?.hit === true : true;
  return first.filter((x) => (x.onFailedSave ? failed && hit : hit)).map((x) => x.id);
}

/** A row's damage instances after its outcome (half: each halved first, SRD 5.2.1 p. 17), or its DM-edited final. */
export function rowParts(
  c: CastData,
  t: CastTargetData,
): { parts: { amount: number; type: DamageType | "untyped" }[]; final: boolean } | null {
  const roll = rollOf(c, t);
  const outcome = outcomeOf(c, t);
  if (!c.damage || outcome === "none") return null;
  if (t.final != null) return { parts: [{ amount: t.final, type: "untyped" }], final: true };
  if (!roll) return null;
  return {
    parts: roll.parts.map((x) => ({
      amount: outcome === "half" ? Math.floor(x.amount / 2) : x.amount,
      type: x.type,
    })),
    final: false,
  };
}

/**
 * `cast.apply` (DM; §8.13 Apply / Apply all): the card's outcome for these rows (or all still waiting) — the HP
 * pipeline with each creature's damage instances (several rays at one creature: one pass, every instance its own), the
 * conditions ticked, what follows (0 HP, concentration saves) — one undoable step.
 */
export const castApply: CommandDef<z.infer<typeof CastApply>, { applied: number }> = {
  type: "cast.apply",
  schema: CastApply,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    openCast(ctx, p.castId);
  },
  plan(ctx, p) {
    const c = openCast(ctx, p.castId);
    const d = c.data;
    const rules = ctx.model.campaign.houseRules;
    const cRules = {
      bloodied: rules.bloodied && ctx.model.campaign.rulesPack !== "srd-5.1",
      npcAtZero: rules.npcAtZero,
    };
    const ops: Op[] = [];
    const events: RoomEvent[] = [];
    const follow: Followups = { prompts: [], concentration: [], by: ctx.actor.userId };
    const hurt: Hurt = { taken: new Map(), downed: [] };
    const lines: string[] = [];
    const want = new Set(p.targets ?? d.targets.filter((t) => t.state === "in").map((t) => t.key));
    const rows = d.targets
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => want.has(row.key) && row.state === "in" && ctx.model.get("token", row.id));
    if (!rows.length) throw new GloamError("CONFLICT", "Nothing on the card is waiting to be applied.");
    const cb = activeCombat(ctx);
    // One pass per creature: its rows' instances together.
    const byCreature = new Map<string, typeof rows>();
    for (const r of rows) byCreature.set(r.row.id, [...(byCreature.get(r.row.id) ?? []), r]);
    for (const [id, mine] of byCreature) {
      const h = holderOf(ctx, { tokenId: id });
      const ignore = mine[0]?.row.ignore ?? { resist: false, vuln: false, immune: false };
      let hp = h.hp;
      let hpTemp = h.hpTemp;
      let status = h.status;
      if (d.damage?.healing) {
        const amount = mine.reduce((s, { row }) => {
          const x = rowParts(d, row);
          return s + (x ? x.parts.reduce((a, b) => a + b.amount, 0) : 0);
        }, 0);
        if (amount > 0) {
          const o = outcomeFor(
            h,
            { kind: "heal", amount, targets: [id], halved: false, crit: false, tempChoice: "best" },
            id,
            true,
            cRules,
          );
          const { apply } = sortConsequences(o.cons, rules.automation);
          for (const { consequence, choice } of apply) status = applyToStatus(status, consequence, choice);
          hp = o.hp;
          for (const tid of tokensOf(ctx, h))
            events.push({ name: "hp.fx", payload: { ...o.fx, tokenId: tid }, to: { viewersOf: tid } });
          lines.push(o.line);
        }
      } else if (d.damage) {
        // Each attack, ray or dart is damage of its own (rules audit B1, SRD pp. 17, 146, 179): applied one after
        // another, its HP carried on — a death-save failure each at 0 HP, a massive-damage check each, a
        // Concentration save each — not one lump from all of them.
        const instances = mine.flatMap(({ row }) =>
          rowInstances(d, row).map((parts) => ({ row, parts: parts.filter((x) => x.amount > 0) })),
        );
        const saves: NonNullable<Followups["concentration"]> = [];
        const asked: ReturnType<typeof sortConsequences>["ask"] = [];
        const details: string[] = [];
        let cur: Holder = h;
        for (const inst of instances) {
          if (!inst.parts.length) continue;
          const crit = Boolean(inst.row.attack?.crit && outcomeOf(d, inst.row) !== "none");
          const o = outcomeFor(
            silenced(ctx, adjusted(cur, ignore)),
            { kind: "damage", targets: [id], parts: inst.parts, halved: false, crit, tempChoice: "best" },
            id,
            true,
            cRules,
          );
          const { apply, ask } = sortConsequences(o.cons, rules.automation);
          let st = cur.status;
          for (const { consequence, choice } of apply) st = applyToStatus(st, consequence, choice);
          for (const { consequence: x } of apply)
            if (x.kind === "concentrationSave")
              saves.push({
                tokenId: id,
                actorId: h.actor?.id ?? null,
                name: h.name,
                dc: x.dc,
                ...(h.status.concentration?.spellName ? { spell: h.status.concentration.spellName } : {}),
              });
          asked.push(...ask);
          details.push(o.detail);
          for (const tid of tokensOf(ctx, h))
            events.push({ name: "hp.fx", payload: { ...o.fx, tokenId: tid }, to: { viewersOf: tid } });
          lines.push(o.line);
          cur = { ...cur, hp: o.hp, hpTemp: o.hpTemp, status: st };
        }
        follow.concentration.push(...saves);
        if (asked.length)
          follow.prompts.push({
            kind: "consequences",
            tokenId: id,
            actorId: h.actor?.id ?? null,
            name: h.name,
            title: promptTitle(h.name, asked),
            detail: `${details.join("; ")} (${d.name})`,
            items: asked.map(itemOf),
          });
        if (cur !== h) {
          hp = cur.hp;
          hpTemp = cur.hpTemp;
          status = cur.status;
          const lost = Math.max(0, h.hp + h.hpTemp - (hp + hpTemp));
          for (const tid of tokensOf(ctx, h)) {
            hurt.taken.set(tid, (hurt.taken.get(tid) ?? 0) + lost);
            if (h.hp > 0 && hp <= 0) hurt.downed.push(tid);
          }
        }
      }
      const incapacitatedBefore = incapacitates(status.conditions.map((x) => x.id));
      // Conditions (§8.13 "conditions to apply"): a concentration spell's end with it (castId).
      for (const { row } of mine)
        for (const cid of conditionsFor(d, row)) {
          if (status.conditions.some((x) => x.id === cid) || h.stats.conditionImmune.includes(cid)) continue;
          const spec = d.conditions.find((x) => x.id === cid);
          const rounds = spec?.rounds;
          status = {
            ...status,
            conditions: [
              ...status.conditions,
              {
                id: cid,
                source: d.name,
                ...(d.caster.tokenId ? { sourceTokenId: d.caster.tokenId } : {}),
                // The spell's cast (a trigger card's: the cast that made its effect), so the condition ends with it.
                ...(d.concentration || d.sourceCastId ? { castId: d.sourceCastId ?? c.id } : {}),
                ...(rounds && cb ? { untilRound: cb.round + rounds } : {}),
                // "Until the end of the current turn" — the turn it's in (its own, when a trigger at its start).
                ...(spec?.endsTurn ? { endsWithTurnOf: activeTurnOf(ctx) ?? id } : {}),
                // "Until the end (start) of your next turn", "until the end of its next turn" (rules audit m8): a turn
                // under way that is that creature's doesn't count — the next one does.
                ...turnBound(spec?.until, d.caster.tokenId, id, activeTurnOf(ctx)),
              },
            ],
          };
          lines.push(`${h.name}: ${CONDITIONS[cid].name}`);
        }
      // A condition that incapacitates ends its Concentration (SRD p. 179; rules audit I2): Hold Person on a caster
      // holding a spell — as the DM's automation setting has it (at once, or asked).
      if (status.concentration && !incapacitatedBefore && incapacitates(status.conditions.map((x) => x.id))) {
        const cause =
          status.conditions.find((x) => CONDITIONS[x.id as ConditionId]?.incapacitated)?.id ??
          "incapacitated";
        const { apply, ask } = sortConsequences(
          [{ kind: "concentrationEnds", reason: CONDITIONS[cause as ConditionId]?.name ?? "Incapacitated" }],
          rules.automation,
        );
        for (const { consequence, choice } of apply) status = applyToStatus(status, consequence, choice);
        if (apply.length) lines.push(`${h.name} loses Concentration`);
        if (ask.length)
          follow.prompts.push({
            kind: "consequences",
            tokenId: id,
            actorId: h.actor?.id ?? null,
            name: h.name,
            title: promptTitle(h.name, ask),
            detail: `Became incapacitated (${d.name})`,
            items: ask.map(itemOf),
          });
      }
      // A failed save that also ends Concentration (Sleet Storm): its spell's effects go with it (cleanup).
      if (
        d.breaksConcentration &&
        status.concentration &&
        mine.some(({ row }) => (d.save ? row.save?.autoFail || row.save?.success === false : true))
      ) {
        status = withConcentration(status, null);
        lines.push(`${h.name} loses Concentration`);
      }
      // An effect on each creature that failed (Faerie Fire's outline and glow).
      const spell = d.spell;
      if (
        spell?.effect?.attach === "target" &&
        d.caster.tokenId &&
        ctx.model.get("token", d.caster.tokenId)
      ) {
        const failed = mine.some(({ row }) => outcomeOf(d, row) !== "none");
        const has = ctx.model.all("effect").some((e) => e.source.castId === c.id && e.attachedTokenId === id);
        if (failed && !has) {
          const e = makeEffect(
            ctx,
            spell,
            d.level ?? spell.level,
            null,
            casterOf(ctx, d.caster.tokenId),
            c.id,
            id,
          );
          if (e) {
            ops.push(createOp("effect", e));
            lines.push(`${h.name}: ${spell.name}`);
          }
        }
      }
      if (hp !== h.hp || hpTemp !== h.hpTemp || status !== h.status)
        ops.push(...holderOps(ctx, h, { hp, hpTemp, status }));
      for (const { i } of mine) ops.push(...castPathOp(c, ["targets", String(i), "state"], "applied"));
    }
    ops.push(...tallyOps(ctx, hurt));
    const left = d.targets.some((t) => t.state === "in" && !want.has(t.key));
    if (!left) ops.push(...setOps("cast", c, { status: "done", updatedAt: ctx.now }));
    if (follow.prompts.length || follow.concentration.length)
      events.push({ name: FOLLOWUPS, payload: follow, to: { dms: true } });
    const shown = lines.slice(0, 3).join("; ");
    return {
      ops,
      summary: `${d.name}: ${shown || "applied"}${lines.length > 3 ? ` and ${lines.length - 3} more` : ""}`,
      sceneId: c.sceneId,
      events,
      result: { applied: rows.length },
    };
  },
};

/** `cast.skip` (DM): a target takes nothing. */
export const castSkip: CommandDef<z.infer<typeof CastSkip>, { ok: true }> = {
  type: "cast.skip",
  schema: CastSkip,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    rowIndex(openCast(ctx, p.castId), p.targetId);
  },
  plan(ctx, p) {
    const c = openCast(ctx, p.castId);
    const i = rowIndex(c, p.targetId);
    const row = c.data.targets[i] as CastTargetData;
    const ops = castPathOp(c, ["targets", String(i), "state"], "skipped");
    if (!c.data.targets.some((t, j) => j !== i && t.state === "in"))
      ops.push(...setOps("cast", c, { status: "done", updatedAt: ctx.now }));
    return { ops, summary: `${c.data.name}: ${row.name} skipped`, result: { ok: true } };
  },
};

/**
 * `cast.cancel` (DM, or the caster before anything's applied; AC-SPL-06): the slot back, the effect gone, the
 * concentration on it ended, the card closed.
 */
export const castCancel: CommandDef<z.infer<typeof CastCancel>, { ok: true }> = {
  type: "cast.cancel",
  schema: CastCancel,
  undoable: true,
  authorize(ctx, p) {
    const c = openCast(ctx, p.castId);
    if (isDm(ctx.actor.role)) return;
    if (!castMayRoll(ctx, c)) throw new GloamError("FORBIDDEN", "That card isn't yours.");
    // An effect's trigger card is the DM's to close (its save is owed); a card once rolled on stands — cancelling
    // it then would be a free re-roll with the slot back (security review L2).
    if (c.data.kind === "trigger") throw new GloamError("FORBIDDEN", "Only the DM closes this card.");
    const d = c.data;
    const rolled = d.damage?.roll || d.targets.some((t) => t.attack || t.roll || t.save?.total !== undefined);
    if (rolled) throw new GloamError("CONFLICT", "It's been rolled on — ask the DM to cancel it.");
    if (c.data.targets.some((t) => t.state === "applied"))
      throw new GloamError("CONFLICT", "Part of it was applied already — ask the DM.");
  },
  plan(ctx, p) {
    const c = openCast(ctx, p.castId);
    const d = c.data;
    const ops: Op[] = [];
    const tok = d.caster.tokenId ? ctx.model.get("token", d.caster.tokenId) : undefined;
    if (tok) {
      const caster = casterOf(ctx, tok.id);
      const s = caster.h.status;
      const status = s.concentration?.castId === c.id ? withConcentration(s, null) : s;
      ops.push(
        ...casterStateOps(
          ctx,
          caster,
          d.spent ? { kind: d.spent.kind, level: d.spent.level } : null,
          status,
          true,
        ),
      );
    }
    for (const e of ctx.model.all("effect")) if (e.source.castId === c.id) ops.push(deleteOp("effect", e));
    ops.push(...setOps("cast", c, { status: "cancelled", updatedAt: ctx.now }));
    return {
      ops,
      summary: `${d.name} cancelled${d.spent ? " (slot refunded)" : ""}`,
      sceneId: c.sceneId,
      result: { ok: true },
    };
  },
};

/** `cast.close` (DM): the card put away (whatever's left isn't applied). */
export const castClose: CommandDef<z.infer<typeof CastClose>, { ok: true }> = {
  type: "cast.close",
  schema: CastClose,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    openCast(ctx, p.castId);
  },
  plan(ctx, p) {
    const c = openCast(ctx, p.castId);
    return {
      ops: setOps("cast", c, { status: "done", updatedAt: ctx.now }),
      summary: `${c.data.name} closed`,
      result: { ok: true },
    };
  },
};

/** What the room records on a card after a roll (`cast.record`, internal; rolls are facts: not undoable). */
export const CastRecord = z.strictObject({
  castId: z.string().min(3).max(40),
  targetId: z.string().min(3).max(44).optional(),
  save: z
    .strictObject({
      total: z.number().int(),
      success: z.boolean().nullable(),
      by: z.enum(["npc", "player", "dm"]),
      autoFail: z.boolean().optional(),
    })
    .optional(),
  attack: z
    .strictObject({
      total: z.number().int(),
      // Unknown for the DM's entered total (no die to read it from).
      natural: z.number().int().nullable(),
      crit: z.boolean(),
      hit: z.boolean().nullable(),
      entered: z.boolean().optional(),
    })
    .optional(),
  roll: z
    .strictObject({
      total: z.number().int(),
      parts: z.array(z.strictObject({ amount: z.number().int(), type: z.string() })),
      formula: z.string().max(200),
      entered: z.boolean().optional(),
      rollId: z.string().max(40).optional(),
      crit: z.boolean().optional(),
    })
    .optional(),
  requestId: z.string().max(40).optional(),
});
export const castRecord: CommandDef<z.infer<typeof CastRecord>, { ok: true }> = {
  type: "cast.record",
  schema: CastRecord,
  undoable: false,
  internal: true,
  authorize(ctx, p) {
    openCast(ctx, p.castId);
  },
  plan(ctx, p) {
    const c = openCast(ctx, p.castId);
    const ops: Op[] = [];
    if (p.requestId) ops.push(...castPathOp(c, ["requestId"], p.requestId));
    if (p.targetId) {
      // A save is the creature's (every row of it); an attack and its damage are the row's.
      c.data.targets.forEach((row, i) => {
        if (p.save && row.id === p.targetId)
          ops.push(
            ...castPathOp(c, ["targets", String(i), "save"], { ...row.save, ...p.save, pending: false }),
          );
        if (row.key !== p.targetId) return;
        if (p.attack) ops.push(...castPathOp(c, ["targets", String(i), "attack"], p.attack));
        if (p.roll && c.data.damage?.per === "target")
          ops.push(...castPathOp(c, ["targets", String(i), "roll"], p.roll));
      });
    } else if (p.roll) ops.push(...castPathOp(c, ["damage", "roll"], p.roll));
    return { ops, summary: `${c.data.name}: rolled`, result: { ok: true } };
  },
};

// ── effects ──────────────────────────────────────────────────────────────────────────────────────────────

function mayMoveEffect(ctx: CommandCtx, e: EffectEntity): boolean {
  if (isDm(ctx.actor.role)) return true;
  // Its caster moves it only as the spell says it can (a distance a turn); one that only drifts (Cloudkill, SRD p. 116:
  // 10 ft away at the start of each of the caster's turns) moves by itself — or by the DM.
  if (e.movement?.by !== "caster" || e.movement.maxFt === undefined || !e.source.casterTokenId) return false;
  const t = ctx.model.get("token", e.source.casterTokenId);
  return Boolean(t && controlsToken(ctx.actor.role, ctx.actor.userId, t));
}

/** The combat turn under way on the actor's scene ("combat:round:index"), or null out of combat. */
function turnKey(ctx: CommandCtx): string | null {
  const c = activeCombat(ctx);
  if (!c) return null;
  const d = dataOf(c);
  return d.begun ? `${c.id}:${c.round}:${c.turnIndex}` : null;
}

/** Whether segments p–q and a–b cross (touching counts). */
function segmentsCross(p: P, q: P, a: P, b: P): boolean {
  const o = (u: P, v: P, w: P) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const d1 = o(a, b, p);
  const d2 = o(a, b, q);
  const d3 = o(p, q, a);
  const d4 = o(p, q, b);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0);
}

/** Where an effect is (its origin; a wall's first point); an emanation is where its creature is. */
export function effectAt(e: EffectEntity): { x: number; y: number } | null {
  const sh = e.shape;
  if (sh.kind === "wall") return sh.points[0] ?? null;
  if (sh.kind === "emanation") return null;
  return sh.origin;
}

/** An effect's shape moved to `to` (a wall by its first point), turned to `dirDeg`. */
export function movedShape(sh: AreaShape, to: { x: number; y: number }, dirDeg?: number): AreaShape {
  if (sh.kind === "wall") {
    const a = sh.points[0] as { x: number; y: number };
    const dx = to.x - a.x;
    const dy = to.y - a.y;
    return { ...sh, points: sh.points.map((q) => ({ x: q.x + dx, y: q.y + dy })) };
  }
  if (sh.kind === "emanation") return sh;
  const origin = { ...sh.origin, x: to.x, y: to.y };
  if ((sh.kind === "cone" || sh.kind === "cube" || sh.kind === "line") && dirDeg !== undefined)
    return { ...sh, origin, dirDeg };
  return { ...sh, origin };
}

/** `effect.move` (the DM; its caster within its limit — Moonbeam 60 ft, Flaming Sphere 30 ft). */
export const effectMove: CommandDef<z.infer<typeof EffectMove>, { ok: true }> = {
  type: "effect.move",
  schema: EffectMove,
  undoable: true,
  authorize(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    if (!mayMoveEffect(ctx, e)) throw new GloamError("FORBIDDEN", "Only the DM or its caster moves it.");
    const at = effectAt(e);
    if (!at) throw new GloamError("INVALID", "It moves with its creature.");
    // Its caster moves it on its own turn (Moonbeam's Magic action, Flaming Sphere's Bonus Action).
    if (!isDm(ctx.actor.role) && e.source.casterTokenId) {
      const cb = activeCombat(ctx);
      const d = cb ? dataOf(cb) : null;
      const caster = e.source.casterTokenId;
      if (
        cb &&
        d?.begun &&
        d.combatants.some((x) => x.tokenId === caster) &&
        d.combatants[cb.turnIndex]?.tokenId !== caster
      )
        throw new GloamError("NOT_YOUR_TURN", `${e.name} moves on its caster's turn.`);
    }
    if (!isDm(ctx.actor.role) && e.movement?.maxFt !== undefined) {
      const d = Math.hypot(p.to.x - at.x, p.to.y - at.y);
      // In combat, its distance is a turn's (Moonbeam 60 ft, Flaming Sphere 30 ft), however many drags it takes; a
      // sphere that rammed a creature stops for the turn (SRD p. 132). Out of combat, a move at a time.
      const turn = turnKey(ctx);
      const used = turn && e.used?.turn === turn ? e.used : null;
      if (used?.stopped)
        throw new GloamError(
          "INVALID",
          `${e.name} stopped when it hit a creature: it moves again next turn.`,
        );
      const left = e.movement.maxFt - (used?.movedFt ?? 0);
      if (d > left + 0.5)
        throw new GloamError(
          "INVALID",
          used
            ? `${e.name} can move ${Math.max(0, Math.round(left))} ft more this turn.`
            : `${e.name} moves at most ${e.movement.maxFt} ft ${turn ? "a turn" : "at a time"}.`,
        );
      // Somewhere its caster could send it: within the spell's range, with a clear line from the caster.
      const caster = e.source.casterTokenId ? ctx.model.get("token", e.source.casterTokenId) : undefined;
      const spell = e.source.contentId ? spellById(ctx, e.source.contentId) : undefined;
      if (caster && spell?.range.kind === "ranged" && spell.range.ft !== undefined) {
        const ok = canPlace(
          bodyOf(caster),
          { x: p.to.x, y: p.to.y },
          { kind: "ft", ft: spell.range.ft },
          barriersOf(ctx, e.sceneId),
        );
        if (!ok.ok)
          throw new GloamError(
            ok.why === "range" ? "INVALID" : "BLOCKED",
            ok.why === "range"
              ? `That's out of ${spell.name}'s range.`
              : `${caster.name} has no clear line there.`,
          );
      }
    }
    // An object rolls along the floor: not through a wall (Flaming Sphere, SRD p. 132 — barriers up to 5 ft tall only).
    if (!isDm(ctx.actor.role) && e.props.bodyFt) {
      const wall = barriersOf(ctx, e.sceneId).some((w) => w.blocksMove && segmentsCross(at, p.to, w.a, w.b));
      if (wall) throw new GloamError("BLOCKED", `A wall is in ${e.name}'s way.`);
    }
  },
  plan(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    const at = effectAt(e);
    // An object rolled along (Flaming Sphere): it stops at the first creature it runs into, which saves (SRD p. 132).
    const ram = rammed(ctx, e, p.to);
    const to = ram ? ram.at : p.to;
    const shape = movedShape(e.shape, to, p.dirDeg);
    // Its caster's use of it this turn (combat): the feet, and a stop after a ram.
    const turn = turnKey(ctx);
    const was = turn && e.used?.turn === turn ? e.used : null;
    const moved = at ? Math.hypot(to.x - at.x, to.y - at.y) : 0;
    const used = turn
      ? {
          turn,
          movedFt: (was?.movedFt ?? 0) + moved,
          ...(ram || was?.stopped ? { stopped: true } : {}),
          ...(was?.acted ? { acted: true } : {}),
        }
      : undefined;
    const ops = setOps("effect", e, used ? { shape, used } : { shape });
    const d = dispelOps(ctx, { ...e, shape });
    ops.push(...d);
    // Moved into what dispels it: it goes.
    if (d.self) ops.push(...endEffectOps(ctx, e));
    return {
      ops,
      summary: ram ? `${e.name} rolled into ${ram.name}` : `${e.name} moved`,
      sceneId: e.sceneId,
      events: [
        {
          name: "effect.moved",
          payload: { effectId: e.id, before: e.shape, after: shape, ...(ram ? { rammed: ram.id } : {}) },
          to: { dms: true },
        },
      ],
      result: { ok: true },
    };
  },
};

/**
 * Where an effect's object (`bodyFt`, with a moveInto trigger) moving from where it stands toward `to` first runs
 * into a creature's space — the creature, and the point it stops at (touching it) — or null when nothing is in its way.
 */
function rammed(ctx: CommandCtx, e: EffectEntity, to: P): { id: string; name: string; at: P } | null {
  const body = e.props.bodyFt;
  const from = effectAt(e);
  if (!body || !from || !e.triggers.some((t) => t.when === "moveInto")) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  let best: { id: string; name: string; at: P; s: number } | null = null;
  for (const t of ctx.model.inScene("token", e.sceneId)) {
    if (t.hidden || e.props.exempt?.includes(t.id)) continue;
    const R = body / 2 + t.sizeFt / 2;
    // Where along the way the object's edge first meets the creature's (ray–circle), past where it began.
    const fx = from.x - t.pos.x;
    const fy = from.y - t.pos.y;
    if (Math.hypot(fx, fy) < R - 1e-6) continue; // already against it: moving away isn't running into it
    const b = fx * ux + fy * uy;
    const c = fx * fx + fy * fy - R * R;
    const disc = b * b - c;
    if (disc < 0) continue;
    const s = -b - Math.sqrt(disc);
    if (s < 0 || s > len) continue;
    if (!best || s < best.s)
      best = { id: t.id, name: t.name, at: { x: from.x + ux * s, y: from.y + uy * s }, s };
  }
  return best ? { id: best.id, name: best.name, at: best.at } : null;
}

/** `effect.remove` (the DM; its caster): it ends (its caster's concentration on it with it). */
export const effectRemove: CommandDef<z.infer<typeof EffectRemove>, { ok: true }> = {
  type: "effect.remove",
  schema: EffectRemove,
  undoable: true,
  authorize(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    if (isDm(ctx.actor.role)) return;
    const t = e.source.casterTokenId ? ctx.model.get("token", e.source.casterTokenId) : undefined;
    if (!t || !controlsToken(ctx.actor.role, ctx.actor.userId, t))
      throw new GloamError("FORBIDDEN", "Only the DM or its caster ends it.");
  },
  plan(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    return {
      ops: endEffectOps(ctx, e),
      summary: `${e.name} ended`,
      sceneId: e.sceneId,
      result: { ok: true },
    };
  },
};

/** `effect.update` (DM): who sees it, its size, what it does to the ground and to sight. */
export const effectUpdate: CommandDef<z.infer<typeof EffectUpdate>, { ok: true }> = {
  type: "effect.update",
  schema: EffectUpdate,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    mustGet(ctx, "effect", p.effectId);
  },
  plan(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    const patch: Partial<EffectEntity> = {};
    if (p.visibility) patch.visibility = p.visibility;
    if (p.props) {
      const props: Record<string, unknown> = { ...e.props };
      for (const [k, v] of Object.entries(p.props)) {
        if (v === null || v === false) delete props[k];
        else props[k] = v;
      }
      patch.props = props as EffectEntity["props"];
    }
    if (p.size !== undefined) {
      const sh = e.shape;
      patch.shape =
        sh.kind === "sphere" || sh.kind === "cylinder"
          ? { ...sh, radius: p.size }
          : sh.kind === "cone" || sh.kind === "line"
            ? { ...sh, length: p.size }
            : sh.kind === "cube"
              ? { ...sh, size: p.size }
              : sh.kind === "emanation"
                ? { ...sh, distance: p.size }
                : sh;
    }
    return {
      ops: setOps("effect", e, patch),
      summary: `${e.name} changed`,
      sceneId: e.sceneId,
      result: { ok: true },
    };
  },
};

/**
 * `concentration.cleanup` (internal; after a commit that ended a creature's concentration): the effects of the cast
 * it was concentrating on and the conditions that cast put on anyone, gone — joined to that commit's undo step.
 */
export const ConcentrationCleanup = z.strictObject({
  castId: z.string().min(3).max(40).optional(),
  effectId: z.string().min(3).max(40).optional(),
  spellName: z.string().max(80).optional(),
});
export const concentrationCleanup: CommandDef<z.infer<typeof ConcentrationCleanup>, { removed: number }> = {
  type: "concentration.cleanup",
  schema: ConcentrationCleanup,
  undoable: true,
  internal: true,
  authorize() {},
  plan(ctx, p) {
    const ops: Op[] = [];
    let removed = 0;
    for (const e of ctx.model.all("effect"))
      if ((p.castId && e.source.castId === p.castId) || (p.effectId && e.id === p.effectId)) {
        ops.push(deleteOp("effect", e));
        removed++;
      }
    if (p.castId) {
      // The conditions the cast put on (Hold Person's Paralyzed, Invisibility's Invisible, Web's Restrained).
      const seen = new Set<string>();
      for (const t of ctx.model.all("token")) {
        let h: Holder;
        try {
          h = holderOf(ctx, { tokenId: t.id });
        } catch {
          continue;
        }
        const key = h.actor ? `a:${h.actor.id}` : `t:${t.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const keep = h.status.conditions.filter((x) => x.castId !== p.castId);
        if (keep.length === h.status.conditions.length) continue;
        removed += h.status.conditions.length - keep.length;
        ops.push(
          ...holderOps(ctx, h, { hp: h.hp, hpTemp: h.hpTemp, status: { ...h.status, conditions: keep } }),
        );
      }
    }
    return {
      ops,
      summary: `${p.spellName ?? "Concentration"} ended${removed ? ` — ${removed} ${removed === 1 ? "thing" : "things"} it held up gone` : ""}`,
      result: { removed },
      ...(ops.length ? {} : { undoable: false }),
    };
  },
};

/**
 * Concentration ended by a commit (§8.13 Concentration; AC-SPL-07): each creature whose status lost its concentration
 * (or changed it to another cast), with what it was.
 */
export function concentrationsEnded(
  ops: readonly Op[],
): { castId?: string; effectId?: string; spellName?: string }[] {
  const out: { castId?: string; effectId?: string; spellName?: string }[] = [];
  for (const op of ops) {
    if (op.k !== "set" || (op.e !== "token" && op.e !== "actor")) continue;
    if (op.path.length !== 1 || op.path[0] !== "status") continue;
    const before = (op.prev as TokenStatusT | undefined)?.concentration;
    const after = (op.value as TokenStatusT | undefined)?.concentration;
    if (!before) continue;
    if (after && (after.castId ?? after.spellName) === (before.castId ?? before.spellName)) continue;
    if (!before.castId && !before.effectId) continue;
    out.push({
      ...(before.castId ? { castId: before.castId } : {}),
      ...(before.effectId ? { effectId: before.effectId } : {}),
      ...(before.spellName ? { spellName: before.spellName } : {}),
    });
  }
  return out;
}

/**
 * `cast.trigger` (internal; SPEC §8.13 Persistent effects "triggers … create DM prompts with the configured save and
 * damage"): an effect's trigger fired for these creatures — entering it, starting or ending a turn in it, each 5 ft
 * moved in it — as a resolution card for the DM: its save at the effect's DC, its damage (grown with the slot it was
 * cast at; per 5 ft, that many times over), its condition. The DM rolls, applies or skips it like any card.
 */
export const CastTriggerIn = z.strictObject({
  effectId: z.string().min(3).max(40),
  when: z.enum(["enter", "startTurn", "endTurn", "per5ft", "moveInto"]),
  tokenIds: z.array(z.string().min(3).max(40)).min(1).max(40),
  /** Per 5 ft: how many 5-ft stretches. */
  times: z.number().int().min(1).max(100).default(1),
});
const WHEN_TEXT: Record<EffectTrigger["when"], string> = {
  enter: "entered it",
  startTurn: "started a turn in it",
  endTurn: "ended a turn in it",
  per5ft: "moved in it",
  moveInto: "had it rolled into them",
  action: "were under the bolt",
};
export const castTrigger: CommandDef<z.infer<typeof CastTriggerIn>, { castId: string | null }> = {
  type: "cast.trigger",
  schema: CastTriggerIn as unknown as z.ZodType<z.infer<typeof CastTriggerIn>>,
  undoable: false,
  internal: true,
  authorize(ctx, p) {
    mustGet(ctx, "effect", p.effectId);
  },
  plan(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    const card = triggerCard(ctx, e, p.when, p.tokenIds, p.times, null);
    if (!card) return { ops: [], summary: "", result: { castId: null }, undoable: false };
    return { ...card, result: { castId: card.castId } };
  },
};

/**
 * A trigger's card for the DM (§8.13: effects' triggers "create DM prompts with the configured save and damage"): its
 * creatures (those the effect spares left out), its save, its damage (per 5 ft: as many times over), the condition a
 * failure lands — for how long — and whether it ends Concentration. `from`: where it strikes from (a bolt's point),
 * else the effect's centre or its caster.
 */
function triggerCard(
  ctx: CommandCtx,
  e: EffectEntity,
  when: EffectTrigger["when"],
  tokenIds: string[],
  times: number,
  from0: P | null,
): { ops: Op[]; summary: string; sceneId: string; events: RoomEvent[]; castId: string } | null {
  const trig = e.triggers.find((t) => t.when === when);
  if (!trig || (!trig.save && !trig.damage && !trig.condition)) return null;
  const exempt = new Set(e.props.exempt ?? []);
  const tokens = tokenIds
    .map((id) => ctx.model.get("token", id))
    .filter((t): t is TokenEntity => Boolean(t) && !exempt.has((t as TokenEntity).id));
  if (!tokens.length) return null;
  const casterTok = e.source.casterTokenId ? ctx.model.get("token", e.source.casterTokenId) : undefined;
  const origin = from0 ?? effectAt(e);
  const barriers = barriersOf(ctx, e.sceneId);
  const all = ctx.model.inScene("token", e.sceneId);
  // (A wall's trigger has no point to measure cover from.)
  const from = e.shape.kind === "wall" && !from0 ? null : (origin ?? (casterTok ? casterTok.pos : null));
  const targets = tokens.map((t) => {
    const row = targetRow(ctx, t, from, barriers, all, "in");
    return trig.save
      ? { ...row, save: playersRoll(ctx, row) ? { pending: true, by: "player" as const } : {} }
      : row;
  });
  const formula = trig.damage
    ? times > 1
      ? addDice(trig.damage.formula, trig.damage.formula, times - 1)
      : trig.damage.formula
    : null;
  const castId = newId("cst");
  const names = tokens.map((t) => t.name).join(", ");
  const verb = when === "per5ft" ? `moved ${times * 5} ft in it` : WHEN_TEXT[when];
  const data: CastData = {
    kind: "trigger",
    name: e.name,
    subtitle: `${names} ${verb}`,
    spell: null,
    spellId: e.source.contentId ?? null,
    level: e.source.slot ?? null,
    spent: null,
    caster: { tokenId: casterTok?.id ?? null, actorId: null, name: casterTok?.name ?? e.name },
    origin: from ? { x: from.x, y: from.y, z: 0 } : null,
    area: e.shape,
    save: trig.save ? { ability: trig.save.ability, onSuccess: trig.save.onSuccess } : null,
    dc: trig.save ? trig.save.dc : null,
    dcRevealed: false,
    attack: null,
    damage:
      formula && trig.damage
        ? { parts: [{ formula, type: trig.damage.type }], healing: false, per: "cast", roll: null }
        : null,
    conditions: trig.condition
      ? [
          {
            id: trig.condition,
            onFailedSave: Boolean(trig.save),
            ...(trig.conditionEnds === "turnEnd" ? { endsTurn: true } : {}),
          },
        ]
      : [],
    ...(trig.breaksConcentration ? { breaksConcentration: true } : {}),
    targets,
    effectId: e.id,
    ...(e.source.castId ? { sourceCastId: e.source.castId } : {}),
    concentration: Boolean(e.concentrationTokenId),
    requestId: null,
    vfx: e.vfx,
    trigger: { effectId: e.id, when, verb, ...(trig.note ? { note: trig.note } : {}) },
    createdBy: "system",
  };
  const cast: CastEntity = {
    id: castId,
    campaignId: ctx.model.campaign.id,
    sceneId: e.sceneId,
    status: "open",
    data,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  const follow: CastFollowup = {
    castId,
    ...(trig.save
      ? { askSaves: [...new Set(targets.filter((t) => playersRoll(ctx, t)).map((t) => t.id))] }
      : {}),
  };
  return {
    ops: [createOp("cast", cast)],
    summary: `${e.name}: ${data.subtitle}`,
    sceneId: e.sceneId,
    events: [{ name: CAST_FOLLOWUP, payload: follow, to: { dms: true } }],
    castId,
  };
}

/**
 * `effect.act` (its caster's controller, on its turn; the DM): an effect's action again at a point in it — Call
 * Lightning's next bolt, a Magic action: those within its bolt's reach of the point (the spell's own area there, with
 * a clear line) on a card, as its trigger says.
 */
export const effectAct: CommandDef<z.infer<typeof EffectAct>, { castId: string | null }> = {
  type: "effect.act",
  schema: EffectAct,
  undoable: true,
  authorize(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    if (!e.triggers.some((t) => t.when === "action"))
      throw new GloamError("INVALID", `${e.name} has no action to take again.`);
    const caster = e.source.casterTokenId ? ctx.model.get("token", e.source.casterTokenId) : undefined;
    if (isDm(ctx.actor.role)) return;
    if (!caster || !controlsToken(ctx.actor.role, ctx.actor.userId, caster))
      throw new GloamError("FORBIDDEN", "Only its caster (or the DM) calls it.");
    const cb = activeCombat(ctx);
    const d = cb ? dataOf(cb) : null;
    if (
      cb &&
      d?.begun &&
      d.combatants.some((x) => x.tokenId === caster.id) &&
      d.combatants[cb.turnIndex]?.tokenId !== caster.id
    )
      throw new GloamError("NOT_YOUR_TURN", `It isn't ${caster.name}'s turn.`);
    // The point first (a bad one says so, whatever else), then the turn's allowance.
    const area = effectArea(ctx, e);
    if (!area || !contains(footprint(area), p.at))
      throw new GloamError("INVALID", `That point isn't under ${e.name}.`);
    // A Magic action: once a turn (the DM gives another, as with Action Surge).
    const turn = turnKey(ctx);
    if (turn && e.used?.turn === turn && e.used.acted)
      throw new GloamError("INVALID", `${e.name} has already been called this turn.`);
  },
  plan(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    const area = effectArea(ctx, e);
    if (!area || !contains(footprint(area), p.at))
      throw new GloamError("INVALID", `That point isn't under ${e.name}.`);
    const bolt: AreaShape = {
      kind: "sphere",
      origin: { x: p.at.x, y: p.at.y, z: 0 },
      radius: e.triggers.find((t) => t.when === "action")?.strikeFt ?? 5,
    };
    const inBolt = areaTargets(ctx, bolt, e.sceneId, { sourceId: null, includeSource: true })
      .filter((x) => x.state === "in")
      .map((x) => x.id);
    const card = inBolt.length ? triggerCard(ctx, e, "action", inBolt, 1, p.at) : null;
    const turn = turnKey(ctx);
    const was = turn && e.used?.turn === turn ? e.used : null;
    const acted = turn
      ? setOps("effect", e, {
          used: { turn, movedFt: was?.movedFt ?? 0, ...(was?.stopped ? { stopped: true } : {}), acted: true },
        })
      : [];
    // Its caller hears of a card only if they perceive someone on it — else a bolt that struck "nobody" would say
    // whether an unseen creature stood there.
    const dm = isDm(ctx.actor.role);
    const told = dm || (card !== null && inBolt.some((id) => ctx.actor.sees?.(id) ?? true));
    return {
      ops: [...(card?.ops ?? []), ...acted],
      summary: dm ? (card ? card.summary : `${e.name}: nobody there`) : `${e.name} strikes`,
      sceneId: e.sceneId,
      events: card?.events ?? [],
      result: { castId: told ? (card?.castId ?? null) : null },
    };
  },
};

export const EffectRecheck = z.strictObject({ effectId: Id });
/**
 * `effect.recheck` (internal): a lasting light or darkness carried by a creature, where the creature now stands
 * (rules audit I10: a Light carried into a Darkness goes; a Darkness carried into a light of 2nd level or lower
 * dispels it).
 */
export const effectRecheck: CommandDef<z.infer<typeof EffectRecheck>, { ok: true }> = {
  type: "effect.recheck",
  schema: EffectRecheck,
  undoable: false,
  internal: true,
  authorize(ctx, p) {
    mustGet(ctx, "effect", p.effectId);
  },
  plan(ctx, p) {
    const e = mustGet(ctx, "effect", p.effectId);
    const d = dispelOps(ctx, e);
    const ops: Op[] = [...d, ...(d.self ? endEffectOps(ctx, e) : [])];
    return {
      ops,
      summary: ops.length ? `${e.name}: light and darkness met` : "",
      sceneId: e.sceneId,
      result: { ok: true },
    };
  },
};

export const SPELL_COMMANDS = [
  spellCast,
  attackStart,
  castTarget,
  castSet,
  castRevealDc,
  castApply,
  castSkip,
  castCancel,
  castClose,
  castRecord,
  effectMove,
  effectRemove,
  effectUpdate,
  concentrationCleanup,
  castTrigger,
  effectAct,
  effectRecheck,
] as unknown as CommandDef<never, unknown>[];
