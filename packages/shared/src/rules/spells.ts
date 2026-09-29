/**
 * Spells as the table uses them (SPEC §8.13, §17, §33.3): which slot a cast spends and what upcasting adds, how many
 * creatures it takes, how big its area grows, how long it lasts, what a save does to the damage, the browser's
 * filters, and the card's words for each field. Pure: the server's cast command and the client's casting flow read
 * the same answers.
 */

import type { z } from "zod";
import type { Ability, DamageType } from "../constants.ts";
import { formatNode } from "../dice/format.ts";
import { type DiceNode, parseFormula } from "../dice/parse.ts";
import type { Spellcasting } from "../schemas/sheet.ts";
import type { Spell, SpellArea } from "../schemas/spell.ts";

type SheetSpellcasting = z.infer<typeof Spellcasting>;

export const SPELL_LEVEL_NAMES = [
  "Cantrip",
  "1st",
  "2nd",
  "3rd",
  "4th",
  "5th",
  "6th",
  "7th",
  "8th",
  "9th",
] as const;

/** "3rd-level evocation", "Evocation cantrip". */
export function levelSchool(s: Pick<Spell, "level" | "school">): string {
  const school = s.school.charAt(0).toUpperCase() + s.school.slice(1);
  return s.level === 0 ? `${school} cantrip` : `${SPELL_LEVEL_NAMES[s.level]}-level ${s.school}`;
}

/** A slot a cast can spend: a level's regular slots or the pact's, with what's left. */
export interface SlotOption {
  level: number;
  kind: "slot" | "pact";
  left: number;
}

/**
 * The slots a levelled spell can be cast with (§8.13 Casting flow 1): every level at or above the spell's with a slot
 * left, the pact's too (at its level), lowest first. A cantrip needs none.
 */
export function slotOptions(spell: Pick<Spell, "level">, sc: SheetSpellcasting | null): SlotOption[] {
  if (spell.level === 0 || !sc) return [];
  const out: SlotOption[] = [];
  for (const s of sc.slots)
    if (s.level >= spell.level && s.max - s.used > 0)
      out.push({ level: s.level, kind: "slot", left: s.max - s.used });
  if (sc.pact && sc.pact.level >= spell.level && sc.pact.max - sc.pact.used > 0)
    out.push({ level: sc.pact.level, kind: "pact", left: sc.pact.max - sc.pact.used });
  return out.sort((a, b) => a.level - b.level || (a.kind === "slot" ? -1 : 1));
}

/** The default slot: the lowest one left (§8.13 "default: lowest available"). */
export const defaultSlot = (options: readonly SlotOption[]): SlotOption | null => options[0] ?? null;

/** Every dice term's count multiplied (a critical hit doubles the damage dice, SRD 5.2.1 p. 16); numbers stay. */
export function critFormula(formula: string): string {
  const p = parseFormula(formula);
  const twice = (n: DiceNode): DiceNode => {
    switch (n.k) {
      case "dice":
        return {
          ...n,
          count:
            n.count.k === "num"
              ? { ...n.count, v: n.count.v * 2 }
              : { k: "bin", op: "*", a: { k: "group", x: n.count }, b: { k: "num", v: 2, at: 0 } },
        };
      case "neg":
        return { ...n, x: twice(n.x) };
      case "group":
        return { ...n, x: twice(n.x) };
      case "bin":
        return n.op === "+" || n.op === "-" ? { ...n, a: twice(n.a), b: twice(n.b) } : n;
      default:
        return n;
    }
  };
  return `${formatNode(twice(p.expr))}${p.tag ? ` [${p.tag}]` : ""}`;
}

/**
 * A formula with another added `times` times, like dice merged ("8d6" + 2 × "1d6" → "10d6"; "2d8 + @spellmod" +
 * "2d8" → "4d8 + @spellmod"). Terms that can't merge are appended.
 */
export function addDice(base: string, extra: string, times: number): string {
  if (times <= 0) return base;
  // Additive terms, each with its sign: plain dice (no modifiers, tags or %) merge by their sides.
  const terms = (f: string): { sign: 1 | -1; n: DiceNode }[] => {
    const out: { sign: 1 | -1; n: DiceNode }[] = [];
    const walk = (n: DiceNode, sign: 1 | -1) => {
      if (n.k === "bin" && (n.op === "+" || n.op === "-")) {
        walk(n.a, sign);
        walk(n.b, n.op === "-" ? (-sign as 1 | -1) : sign);
      } else out.push({ sign, n });
    };
    walk(parseFormula(f).expr, 1);
    return out;
  };
  const plain = (n: DiceNode): n is DiceNode & { k: "dice"; count: { k: "num"; v: number } } =>
    n.k === "dice" && n.count.k === "num" && !n.mods.length && !n.percent && !n.tag;
  const dice = new Map<number, number>();
  let constant = 0;
  const other: string[] = [];
  const add = (f: string, k: number) => {
    for (const { sign, n } of terms(f)) {
      if (plain(n) && sign > 0) dice.set(n.sides, (dice.get(n.sides) ?? 0) + n.count.v * k);
      else if (n.k === "num") constant += sign * n.v * k;
      else for (let i = 0; i < k; i++) other.push(`${sign < 0 ? "-" : "+"} ${formatNode(n)}`);
    }
  };
  add(base, 1);
  add(extra, times);
  const parts = [...dice.entries()].map(([sides, n]) => `${n}d${sides}`);
  let out = parts.join(" + ");
  for (const o of other) out = out ? `${out} ${o}` : o.replace(/^\+ /, "");
  if (constant) out = out ? `${out} ${constant < 0 ? "-" : "+"} ${Math.abs(constant)}` : String(constant);
  return out || "0";
}

type Scaling =
  | { mode: "slot"; perLevel: string }
  | { mode: "cantrip"; atLevels: Partial<Record<"5" | "11" | "17", string>> };

/**
 * A damage or healing formula at a slot level (upcast: `perLevel` for each level above the spell's) or, for a
 * cantrip, at the caster's character level (the formula of the highest threshold reached: 5, 11, 17).
 */
export function scaledFormula(
  formula: string,
  scaling: Scaling | undefined,
  spellLevel: number,
  slot: number | null,
  casterLevel: number,
): string {
  if (!scaling) return formula;
  if (scaling.mode === "slot")
    return addDice(formula, scaling.perLevel, Math.max(0, (slot ?? spellLevel) - spellLevel));
  let out = formula;
  for (const at of ["5", "11", "17"] as const) {
    const f = scaling.atLevels[at];
    if (f && casterLevel >= Number(at)) out = f;
  }
  return out;
}

/**
 * How many creatures a targeted spell takes: its count, plus `countPerSlot` per slot level above its own; a cantrip's
 * at the caster's character level (Eldritch Blast's beams).
 */
export function targetCount(
  spell: Pick<Spell, "level" | "targeting">,
  slot: number | null,
  casterLevel = 1,
): number {
  const t = spell.targeting;
  let base = t?.count ?? 1;
  for (const at of ["5", "11", "17"] as const) {
    const n = t?.countAtLevels?.[at];
    if (n && casterLevel >= Number(at)) base = n;
  }
  return base + Math.max(0, (slot ?? spell.level) - spell.level) * (t?.countPerSlot ?? 0);
}

/**
 * Whether one creature can be picked more than once (a Magic Missile's darts, a Scorching Ray's rays: each an attack
 * or a hit of its own); a spell with a save picks each creature once.
 */
export const repeatTargets = (spell: Pick<Spell, "attack" | "save" | "damage" | "targeting">): boolean =>
  !spell.save &&
  Boolean(spell.attack || spell.damage?.length) &&
  ((spell.targeting?.count ?? 1) > 1 || Boolean(spell.targeting?.countAtLevels));

/** An area's size at a slot: the primary dimension grown by `scaling.perSlot` per level above the spell's (Fog Cloud). */
export function areaAtSlot(area: SpellArea, spellLevel: number, slot: number | null): SpellArea {
  const k = Math.max(0, (slot ?? spellLevel) - spellLevel) * (area.scaling?.perSlot ?? 0);
  if (!k) return area;
  switch (area.shape) {
    case "sphere":
    case "cylinder":
      return { ...area, radius: area.radius + k };
    case "cone":
    case "line":
      return { ...area, length: area.length + k };
    case "cube":
      return { ...area, size: area.size + k };
    case "emanation":
      return { ...area, distance: area.distance + k };
    case "wall":
      return { ...area, length: area.length + k };
  }
}

/** An area's size in words: "20-ft-radius sphere", "15-ft cone", "100 × 5-ft line", "60 × 20-ft wall". */
export function areaText(a: SpellArea): string {
  switch (a.shape) {
    case "sphere":
      return `${a.radius}-ft-radius sphere`;
    case "cylinder":
      return `${a.radius}-ft-radius, ${a.height}-ft-high cylinder`;
    case "cone":
      return `${a.length}-ft cone`;
    case "cube":
      return `${a.size}-ft cube`;
    case "line":
      return `${a.length} × ${a.width}-ft line`;
    case "emanation":
      return `${a.distance}-ft emanation`;
    case "wall":
      return `${a.length} × ${a.height}-ft wall${a.ring ? ` (or a ${a.ring}-ft ring)` : ""}`;
  }
}

/** Rounds in a duration (a minute is 10 rounds); null: no end by the clock (instantaneous gives 0). */
export function durationRounds(d: Spell["duration"]): number | null {
  if (d.kind === "instantaneous") return 0;
  if (d.kind !== "timed" || !d.amount || !d.unit) return null;
  const per = { round: 1, minute: 10, hour: 600, day: 14_400 }[d.unit];
  return d.amount * per;
}

export const castingTimeText = (c: Spell["castingTime"]): string => {
  if (c.text) return c.text;
  const unit = {
    action: c.amount === 1 ? "Action" : "actions",
    bonus: c.amount === 1 ? "Bonus Action" : "bonus actions",
    reaction: c.amount === 1 ? "Reaction" : "reactions",
    minute: c.amount === 1 ? "minute" : "minutes",
    hour: c.amount === 1 ? "hour" : "hours",
  }[c.unit];
  const base =
    c.amount === 1 && (c.unit === "action" || c.unit === "bonus" || c.unit === "reaction")
      ? unit
      : `${c.amount} ${unit}`;
  return c.reactionTrigger ? `${base}, ${c.reactionTrigger}` : base;
};

export const rangeText = (r: Spell["range"]): string => {
  if (r.text) return r.text;
  switch (r.kind) {
    case "self":
      return "Self";
    case "touch":
      return "Touch";
    case "sight":
      return "Sight";
    case "unlimited":
      return "Unlimited";
    case "special":
      return "Special";
    case "ranged":
      return r.ft !== undefined
        ? r.ft >= 5280 && r.ft % 5280 === 0
          ? `${r.ft / 5280} mile${r.ft === 5280 ? "" : "s"}`
          : `${r.ft} feet`
        : "Ranged";
  }
};

export const componentsText = (c: Spell["components"]): string =>
  [c.v ? "V" : "", c.s ? "S" : "", c.m ? `M${c.material ? ` (${c.material})` : ""}` : ""]
    .filter(Boolean)
    .join(", ");

export const durationText = (d: Spell["duration"]): string => {
  if (d.text) return d.text;
  const body =
    d.kind === "instantaneous"
      ? "Instantaneous"
      : d.kind === "until-dispelled"
        ? "Until dispelled"
        : d.kind === "special"
          ? "Special"
          : `${d.amount ?? 1} ${d.unit ?? "round"}${(d.amount ?? 1) === 1 ? "" : "s"}`;
  return d.concentration ? `Concentration, up to ${body.toLowerCase()}` : body;
};

/** What a target takes on a save (§8.13 "full / half / none", from the spell's save effect). */
export function saveOutcome(
  onSuccess: "half" | "none" | "special",
  success: boolean | null,
): "full" | "half" | "none" {
  if (success !== true) return "full";
  return onSuccess === "half" ? "half" : "none";
}

/** The VFX preset (§24.5): the spell's own, else from its first damage type, healing, or arcane. */
const VFX_BY_DAMAGE: Record<DamageType, Spell["vfx"]> = {
  acid: "acid",
  bludgeoning: "force",
  cold: "cold",
  fire: "fire",
  force: "force",
  lightning: "lightning",
  necrotic: "necrotic",
  piercing: "force",
  poison: "poison",
  psychic: "psychic",
  radiant: "radiant",
  slashing: "force",
  thunder: "thunder",
};
export function vfxFor(s: Pick<Spell, "vfx" | "damage" | "healing">): Spell["vfx"] {
  if (s.vfx) return s.vfx;
  const t = s.damage?.[0]?.type;
  if (t) return VFX_BY_DAMAGE[t];
  return s.healing ? "healing" : "arcane";
}
export const vfxForDamage = (t: DamageType): Spell["vfx"] => VFX_BY_DAMAGE[t];

/** The spell browser's filters (§8.13 Content; AC-SPL-02). Empty lists and undefined mean "any". */
export interface SpellFilter {
  q?: string;
  levels?: number[];
  schools?: string[];
  classes?: string[];
  castingTime?: Spell["castingTime"]["unit"][];
  concentration?: boolean;
  ritual?: boolean;
  damageTypes?: DamageType[];
  saves?: Ability[];
  shapes?: (SpellArea["shape"] | "none")[];
  source?: "srd" | "homebrew";
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "");

/** Whether a spell passes the browser's filters; the query matches the name first, then the text. */
export function spellMatches(s: Spell, f: SpellFilter): boolean {
  if (f.levels?.length && !f.levels.includes(s.level)) return false;
  if (f.schools?.length && !f.schools.includes(s.school)) return false;
  if (f.classes?.length && !s.classes.some((c) => f.classes?.includes(c))) return false;
  if (f.castingTime?.length && !f.castingTime.includes(s.castingTime.unit)) return false;
  if (f.concentration !== undefined && s.duration.concentration !== f.concentration) return false;
  if (f.ritual !== undefined && s.ritual !== f.ritual) return false;
  if (f.damageTypes?.length) {
    const types = new Set((s.damage ?? []).flatMap((d) => [d.type, ...(d.typeOptions ?? [])]));
    if (!f.damageTypes.some((t) => types.has(t))) return false;
  }
  if (f.saves?.length && (!s.save || !f.saves.includes(s.save.ability))) return false;
  if (f.shapes?.length) {
    const shape = s.area?.shape ?? "none";
    const alts = (s.areaAlternatives ?? []).map((a) => a.area.shape);
    if (!f.shapes.includes(shape) && !alts.some((x) => f.shapes?.includes(x))) return false;
  }
  if (f.source) {
    const srd = s.source.pack.startsWith("srd");
    if ((f.source === "srd") !== srd) return false;
  }
  if (f.q?.trim()) {
    const words = fold(f.q).split(/\s+/).filter(Boolean);
    const hay = fold(`${s.name} ${s.text}`);
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

/** Search order: name starts with the query, then name contains it, then the rest; by level, then name. */
export function spellRank(s: Spell, q: string | undefined): number {
  const x = q ? fold(q.trim()) : "";
  const name = fold(s.name);
  const r = !x ? 0 : name.startsWith(x) ? 0 : name.includes(x) ? 1 : 2;
  return r * 100 + s.level;
}

/** Every class that appears in a list of spells, sorted. */
export const spellClasses = (spells: readonly Spell[]): string[] =>
  [...new Set(spells.flatMap((s) => s.classes))].sort();

/** The creature- vs area- vs self-targeting a cast takes (§8.13 Casting flow 2). */
export function targetingKind(
  s: Pick<Spell, "targeting" | "area" | "range">,
): "area" | "creatures" | "self" | "point" {
  if (s.area) return "area";
  const k = s.targeting?.kind;
  if (k === "self" || (!k && s.range.kind === "self")) return "self";
  if (k === "point" || k === "object") return "point";
  return "creatures";
}
