/**
 * Step 6 of the content pipeline (SPEC §33.2): validate every record with the spell schema, assert the
 * counts (AC-SPL-01), and cross-check header fields against Open5e and 5e-bits and saves/per-slot dice
 * against Open5e. Cross-check sources never change the output; disagreements go to the report.
 */
import { type Spell, type SpellInput, SpellSchema } from "@gloam/shared/schemas";
import { EXPECTED_PER_LEVEL, EXPECTED_TOTAL } from "./lib/pins.ts";
import { nameKey } from "./lib/util.ts";

export interface ValidationResult {
  spells: Spell[];
  errors: string[];
}

export function validateSpells(records: SpellInput[]): ValidationResult {
  const spells: Spell[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const r of records) {
    const parsed = SpellSchema.safeParse(r);
    if (!parsed.success) {
      errors.push(
        `${r.id}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
      continue;
    }
    if (ids.has(parsed.data.id)) errors.push(`${parsed.data.id}: duplicate id`);
    ids.add(parsed.data.id);
    spells.push(parsed.data);
  }
  return { spells, errors };
}

export function perLevelCounts(spells: { level: number }[]): number[] {
  return Array.from({ length: 10 }, (_, l) => spells.filter((s) => s.level === l).length);
}

/** Throws unless there are exactly 339 spells with the SRD 5.2.1 per-level counts. */
export function assertCounts(spells: { level: number }[]): void {
  const counts = perLevelCounts(spells);
  if (spells.length !== EXPECTED_TOTAL || counts.some((c, i) => c !== EXPECTED_PER_LEVEL[i])) {
    throw new Error(
      `Spell counts wrong: total ${spells.length} (expected ${EXPECTED_TOTAL}); per level ${counts.join("/")} ` +
        `(expected ${EXPECTED_PER_LEVEL.join("/")})`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------
// Cross-checks

export interface CrossCheckDisagreement {
  id: string;
  source: "open5e" | "5e-bits";
  field: string;
  ours: string;
  theirs: string;
}

interface Open5eSpell {
  pk: string;
  fields: {
    name: string;
    level: number;
    school: string;
    classes: string[];
    casting_time: string;
    reaction_condition: string | null;
    ritual: boolean;
    range_text: string;
    verbal: boolean;
    somatic: boolean;
    material: boolean;
    material_specified: string | null;
    material_cost: string | number | null;
    material_consumed: boolean;
    duration: string;
    concentration: boolean;
    saving_throw_ability: string | null;
    attack_roll: boolean;
    damage_roll: string | null;
    damage_types: string[];
    shape_type: string | null;
    shape_size: number | null;
  };
}

interface Open5eCastingOption {
  fields: { parent: string; type: string; damage_roll: string | null };
}

interface FiveEBitsSpell {
  index: string;
  name: string;
  level: number;
  school: { index: string };
  classes: { index: string }[];
  casting_time: string;
  ritual: boolean;
  range: string;
  components: string[];
  material?: string;
  duration: string;
  concentration: boolean;
}

const ABILITY_NAMES: Record<string, string> = {
  strength: "str",
  dexterity: "dex",
  constitution: "con",
  intelligence: "int",
  wisdom: "wis",
  charisma: "cha",
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();

function ourCastingTimeKey(s: Spell): string {
  const ct = s.castingTime;
  if (ct.unit === "action") return "action";
  if (ct.unit === "bonus") return "bonus-action";
  if (ct.unit === "reaction") return "reaction";
  return `${ct.amount}${ct.unit}${ct.amount > 1 ? "s" : ""}`;
}

function ourRangeText(s: Spell): string {
  const r = s.range;
  if (r.text !== undefined) return norm(r.text);
  switch (r.kind) {
    case "self":
      return "self";
    case "touch":
      return "touch";
    case "sight":
      return "sight";
    case "unlimited":
      return "unlimited";
    case "special":
      return "special";
    case "ranged": {
      const ft = r.ft ?? 0;
      if (ft >= 5280 && ft % 5280 === 0) return `${ft / 5280} mile${ft === 5280 ? "" : "s"}`;
      return `${ft} feet`;
    }
  }
}

function ourDurationText(s: Spell, concentrationPrefix: string): string {
  const d = s.duration;
  if (d.text !== undefined) return norm(d.text);
  switch (d.kind) {
    case "instantaneous":
      return "instantaneous";
    case "until-dispelled":
      return "until dispelled";
    case "special":
      return "special";
    case "timed": {
      const unit = `${d.unit}${(d.amount ?? 1) > 1 ? "s" : ""}`;
      return `${d.concentration ? concentrationPrefix : ""}${d.amount} ${unit}`;
    }
  }
}

/** base "8d6" + per level "1d6" × steps → "10d6" (same die) or "8d6 + 2d8". */
export function scaleFormula(base: string, perLevel: string, steps: number): string {
  if (steps <= 0) return base;
  const b = /^(\d+)d(\d+)(.*)$/.exec(base.replace(/\s+/g, ""));
  const p = /^(\d+)d(\d+)$/.exec(perLevel.replace(/\s+/g, ""));
  if (b && p && b[2] === p[2]) return `${Number(b[1]) + Number(p[1]) * steps}d${b[2]}${b[3]}`;
  if (p) return `${base} + ${Number(p[1]) * steps}d${p[2]}`;
  return `${base} + ${steps} × (${perLevel})`;
}

export function crossCheck(
  spells: Spell[],
  open5e: Open5eSpell[],
  castingOptions: Open5eCastingOption[],
  bits: FiveEBitsSpell[],
): { disagreements: CrossCheckDisagreement[]; missing: string[]; observations: string[] } {
  const out: CrossCheckDisagreement[] = [];
  const missing: string[] = [];
  const o5 = new Map(open5e.map((s) => [nameKey(s.fields.name), s]));
  const b5 = new Map(bits.map((s) => [nameKey(s.name), s]));
  const ours = new Set(spells.map((s) => nameKey(s.name)));
  for (const k of o5.keys())
    if (!ours.has(k)) missing.push(`Open5e has "${o5.get(k)!.fields.name}", not in the PDF list`);
  for (const k of b5.keys())
    if (!ours.has(k)) missing.push(`5e-bits has "${b5.get(k)!.name}", not in the PDF list`);
  const options = new Map<string, Map<string, string>>();
  for (const o of castingOptions) {
    const m = options.get(o.fields.parent) ?? new Map<string, string>();
    if (o.fields.damage_roll) m.set(o.fields.type, o.fields.damage_roll);
    options.set(o.fields.parent, m);
  }

  for (const s of spells) {
    const push = (source: CrossCheckDisagreement["source"], field: string, a: unknown, b: unknown) =>
      out.push({ id: s.id, source, field, ours: String(a), theirs: String(b) });
    const key = nameKey(s.name);
    const o = o5.get(key);
    if (!o) missing.push(`${s.name}: not in Open5e`);
    else {
      const f = o.fields;
      if (f.level !== s.level) push("open5e", "level", s.level, f.level);
      if (f.school !== s.school) push("open5e", "school", s.school, f.school);
      const oc = f.classes.map((c) => c.replace(/^srd-2024_/, "")).sort();
      if (oc.join(",") !== [...s.classes].sort().join(","))
        push("open5e", "classes", s.classes.join(", "), oc.join(", "));
      if (f.casting_time !== ourCastingTimeKey(s))
        push("open5e", "castingTime", ourCastingTimeKey(s), f.casting_time);
      if (f.ritual !== s.ritual) push("open5e", "ritual", s.ritual, f.ritual);
      if (norm(f.range_text) !== ourRangeText(s)) push("open5e", "range", ourRangeText(s), f.range_text);
      if (f.verbal !== s.components.v || f.somatic !== s.components.s || f.material !== s.components.m) {
        push(
          "open5e",
          "components",
          [s.components.v && "V", s.components.s && "S", s.components.m && "M"].filter(Boolean).join(","),
          [f.verbal && "V", f.somatic && "S", f.material && "M"].filter(Boolean).join(","),
        );
      }
      if (s.components.m && norm(f.material_specified ?? "") !== norm(s.components.material ?? "")) {
        push("open5e", "components.material", s.components.material ?? "", f.material_specified ?? "");
      }
      const oCost = f.material_cost === null ? undefined : Number(f.material_cost);
      if ((oCost ?? 0) !== (s.components.costGp ?? 0))
        push("open5e", "components.costGp", s.components.costGp ?? "none", oCost ?? "none");
      if (f.material_consumed !== (s.components.consumed ?? false)) {
        push("open5e", "components.consumed", s.components.consumed ?? false, f.material_consumed);
      }
      if (norm(f.duration) !== ourDurationText(s, ""))
        push("open5e", "duration", ourDurationText(s, ""), f.duration);
      if (f.concentration !== s.duration.concentration)
        push("open5e", "concentration", s.duration.concentration, f.concentration);
      const oSave = f.saving_throw_ability
        ? (ABILITY_NAMES[f.saving_throw_ability.toLowerCase()] ?? f.saving_throw_ability)
        : "none";
      if (oSave !== (s.save?.ability ?? "none")) push("open5e", "save", s.save?.ability ?? "none", oSave);
      if (f.attack_roll !== Boolean(s.attack))
        push("open5e", "attack", s.attack?.kind ?? "none", f.attack_roll);
      const first = s.damage?.[0];
      const oDmg = (f.damage_roll ?? "").replace(/\s+/g, "");
      const dice = (formula: string | undefined) =>
        (formula ?? "")
          .replace(/\s+/g, "")
          .replace(/\+@spellmod$/, "")
          .toLowerCase();
      // Open5e stores healing dice in damage_roll too; compare those with our healing formula.
      const healingMatches = !first && s.healing && dice(s.healing.formula) === oDmg.toLowerCase();
      if ((oDmg !== "" || first) && !healingMatches && oDmg.toLowerCase() !== dice(first?.formula)) {
        push(
          "open5e",
          "damage.formula",
          first?.formula ?? s.healing?.formula ?? "none",
          f.damage_roll ?? "none",
        );
      }
      const ourTypes = [...new Set((s.damage ?? []).flatMap((d) => d.typeOptions ?? [d.type]))].sort();
      const theirTypes = [...new Set(f.damage_types.map((t) => t.toLowerCase()))].sort();
      if (ourTypes.join(",") !== theirTypes.join(","))
        push("open5e", "damage.types", ourTypes.join(", ") || "none", theirTypes.join(", ") || "none");
      if (f.shape_type) {
        const a = s.area;
        const ourShape = a ? a.shape : "none";
        const ourSize =
          a === null || a === undefined
            ? undefined
            : a.shape === "sphere" || a.shape === "cylinder"
              ? a.radius
              : a.shape === "cone" || a.shape === "line" || a.shape === "wall"
                ? a.length
                : a.shape === "cube"
                  ? a.size
                  : a.distance;
        if (ourShape !== f.shape_type || ourSize !== f.shape_size) {
          push("open5e", "area", a ? `${ourShape} ${ourSize}` : "none", `${f.shape_type} ${f.shape_size}`);
        }
      }
      // Per-slot / per-character-level dice.
      const opts = options.get(o.pk);
      if (opts && first) {
        for (const [type, roll] of opts) {
          const slot = /^slot_level_(\d)$/.exec(type);
          const player = /^player_level_(\d+)$/.exec(type);
          let expected: string | undefined;
          if (slot && first.scaling?.mode === "slot")
            expected = scaleFormula(first.formula, first.scaling.perLevel, Number(slot[1]) - s.level);
          else if (slot) expected = first.formula;
          else if (player && first.scaling?.mode === "cantrip") {
            const lvl = Number(player[1]);
            const at = first.scaling.atLevels as Record<string, string>;
            expected = lvl >= 17 ? at["17"] : lvl >= 11 ? at["11"] : lvl >= 5 ? at["5"] : first.formula;
          } else if (player) expected = first.formula;
          const e = (expected ?? "")
            .replace(/\s+/g, "")
            .replace(/\+@spellmod$/, "")
            .toLowerCase();
          if (expected !== undefined && e !== roll.replace(/\s+/g, "").toLowerCase()) {
            push("open5e", `damage@${type}`, expected, roll);
          }
        }
      }
    }
    const b = b5.get(key);
    if (!b) missing.push(`${s.name}: not in 5e-bits`);
    else {
      if (b.level !== s.level) push("5e-bits", "level", s.level, b.level);
      if (b.school.index !== s.school) push("5e-bits", "school", s.school, b.school.index);
      const bc = b.classes.map((c) => c.index).sort();
      if (bc.join(",") !== [...s.classes].sort().join(","))
        push("5e-bits", "classes", s.classes.join(", "), bc.join(", "));
      const ct = s.castingTime;
      const base =
        ct.unit === "action"
          ? "action"
          : ct.unit === "bonus"
            ? "bonus action"
            : ct.unit === "reaction"
              ? "reaction"
              : `${ct.amount} ${ct.unit}${ct.amount > 1 ? "s" : ""}`;
      const ourCt =
        ct.text !== undefined
          ? norm(ct.text)
          : ct.reactionTrigger !== undefined
            ? norm(`${base}, which you take ${ct.reactionTrigger}`)
            : base;
      if (norm(b.casting_time) !== ourCt) push("5e-bits", "castingTime", ourCt, b.casting_time);
      if (b.ritual !== s.ritual) push("5e-bits", "ritual", s.ritual, b.ritual);
      if (norm(b.range) !== ourRangeText(s)) push("5e-bits", "range", ourRangeText(s), b.range);
      const bComp = [...b.components].sort().join(",");
      const oComp = [s.components.m && "M", s.components.s && "S", s.components.v && "V"]
        .filter(Boolean)
        .join(",");
      if (bComp !== oComp) push("5e-bits", "components", oComp, bComp);
      if (s.components.m && norm(b.material ?? "") !== norm(s.components.material ?? "")) {
        push("5e-bits", "components.material", s.components.material ?? "", b.material ?? "");
      }
      if (norm(b.duration) !== ourDurationText(s, "up to "))
        push("5e-bits", "duration", ourDurationText(s, "up to "), b.duration);
      if (b.concentration !== s.duration.concentration)
        push("5e-bits", "concentration", s.duration.concentration, b.concentration);
    }
  }
  return { disagreements: out, missing, observations: observe(spells, open5e, bits, out) };
}

/** Systematic patterns in the cross-check sources, counted from their data (for the report). */
function observe(
  spells: Spell[],
  open5e: Open5eSpell[],
  bits: FiveEBitsSpell[],
  out: CrossCheckDisagreement[],
): string[] {
  const obs: string[] = [];
  const count = (source: string, field: string) =>
    out.filter((d) => d.source === source && d.field.startsWith(field)).length;
  const countExact = (source: string, field: string) =>
    out.filter((d) => d.source === source && d.field === field).length;
  const withCost = spells.filter((s) => s.components.costGp !== undefined).length;
  const nullCost = open5e.filter((s) => s.fields.material_cost === null).length;
  obs.push(
    `Open5e \`material_cost\` is null for ${nullCost} of ${open5e.length} spells, while ${withCost} SRD spells name a cost ("worth N+ GP") → ${count("open5e", "components.costGp")} costGp differences.`,
  );
  const textOf = new Map(spells.map((s) => [nameKey(s.name), s]));
  const attackNoSpellAttack = open5e.filter((o) => {
    const s = textOf.get(nameKey(o.fields.name));
    return o.fields.attack_roll && s !== undefined && !/spell attack/i.test(s.text);
  }).length;
  obs.push(
    `Open5e sets \`attack_roll\` on ${attackNoSpellAttack} spells whose text makes no spell attack (buffs and debuffs that mention attack rolls, e.g. Bless, Faerie Fire) → most of the ${count("open5e", "attack")} attack differences.`,
  );
  obs.push(
    `Open5e \`damage_roll\` also holds non-damage dice (healing, Bless/Guidance d4s, Confusion's d10, Teleport's d100) and its \`damage_types\` include types a spell only resists or mentions → ${count("open5e", "damage.formula")} formula and ${count("open5e", "damage.types")} type differences.`,
  );
  const ctDiff = out.filter((d) => d.source === "open5e" && d.field === "castingTime");
  const minuteToOne = ctDiff.filter((d) => /^\d+minutes$/.test(d.ours) && d.theirs === "1minute").length;
  const hoursToOne = ctDiff.filter((d) => /^\d+hours$/.test(d.ours) && d.theirs === "1hour").length;
  obs.push(
    `Open5e records ${minuteToOne} multi-minute casting times as "1minute" and ${hoursToOne} multi-hour ones as "1hour" → ${ctDiff.length} casting-time differences in all.`,
  );
  obs.push(
    `Open5e's per-slot dice (SpellCastingOption) disagree with the SRD's "Using a Higher-Level Spell Slot" text for ${new Set(out.filter((d) => d.field.startsWith("damage@slot")).map((d) => d.id)).size} spells (e.g. Ice Knife's options scale the 1d10 Piercing die, but the SRD scales the Cold damage; Wall of Ice adds 1d6 per level where the SRD says 2d6) → ${count("open5e", "damage@")} slot-level differences.`,
  );
  const bitsComponentTypo = bits.filter((b) => /Component:/.test(b.range)).length;
  obs.push(
    `5e-bits mis-parses the PDF's "Component:" (singular) header typo: ${bitsComponentTypo} spells have "Component: …" appended to \`range\` and an empty \`components\` list → ${countExact("5e-bits", "range")} range and ${countExact("5e-bits", "components")} component differences.`,
  );
  const bitsMaterialArtefacts = bits.filter((b) =>
    /,\s*,|\+,|^\(|, the spell|, GP/.test(b.material ?? ""),
  ).length;
  obs.push(
    `5e-bits material strings carry line-break artefacts (stray commas, a leading "(") in ${bitsMaterialArtefacts} spells → most of the ${count("5e-bits", "components.material")} material differences.`,
  );
  return obs;
}
