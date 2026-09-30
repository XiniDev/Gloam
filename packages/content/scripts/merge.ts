/**
 * Steps 3–5 of the content pipeline (SPEC §33.2): merge the canonical PDF record with Foundry mechanics,
 * prose findings and overlays into normalised spell records.
 *
 * Precedence per structured field:
 *   overlay (hand-verified against the PDF) > PDF prose ⇄ Foundry.
 * When prose and Foundry both give a value and they disagree, the PDF prose wins (the PDF is canonical,
 * SPEC §33.1), the disagreement is written to the report and the spell is flagged for manual review.
 * Header fields and text always come from the PDF; Foundry's versions are only cross-checked.
 */

import { CONDITION_IDS, DAMAGE_TYPES } from "@gloam/shared/constants";
import type { SpellInput } from "@gloam/shared/schemas";
import type { FoundryPart, FoundrySpell, FoundryTemplate } from "./import-foundry.ts";
import { linearAtLevel } from "./lib/formula.ts";
import { parseCastingTime, parseComponents, parseDuration, parseRange } from "./lib/header.ts";
import { PACK_ID } from "./lib/pins.ts";
import type { OverlayApplication, Overlays } from "./overlays.ts";
import type { PdfSpell } from "./parse-srd-pdf.ts";
import {
  proseArea,
  proseAreaScaling,
  proseAttack,
  proseCantripScaling,
  proseConditions,
  proseDamage,
  proseHealing,
  proseLight,
  proseSave,
  proseSlotScaling,
  proseTargetCount,
  proseTargetCountPerSlot,
} from "./prose.ts";

type Area = NonNullable<SpellInput["area"]>;
type Damage = NonNullable<SpellInput["damage"]>[number];
type DamageType = Damage["type"];
type Healing = NonNullable<SpellInput["healing"]>;
type Condition = NonNullable<SpellInput["conditions"]>[number];
type Vfx = SpellInput["vfx"];

export type NoteKind = "resolved" | "missing" | "disagreement" | "info";

export interface SpellNote {
  field: string;
  kind: NoteKind;
  message: string;
}

export interface MergedSpell {
  record: SpellInput;
  notes: SpellNote[];
  review: string[];
}

const DAMAGE_SET = new Set<string>(DAMAGE_TYPES);
const CONDITION_SET = new Set<string>(CONDITION_IDS);

// ---------------------------------------------------------------------------------------------------------
// Foundry → record helpers

interface FoundryAreaResult {
  area: Area;
  label: string;
  approximate?: string;
}

/** Maps a Foundry template to a §17.1 area at the spell's level. Returns null for unsupported sizes. */
function mapTemplate(t: FoundryTemplate, level: number): FoundryAreaResult | { error: string } {
  const size = linearAtLevel(t.size || "0", level);
  if (!size) return { error: `unsupported size formula "${t.size}"` };
  const scaling = size.perSlot > 0 ? { scaling: { perSlot: size.perSlot } } : {};
  const num = (s: string) => {
    if (s === "") return undefined;
    const f = linearAtLevel(s, level);
    return f ? f.base : undefined;
  };
  const label = `${t.type} ${t.size}${t.width ? ` w${t.width}` : ""}${t.height ? ` h${t.height}` : ""}`;
  switch (t.type) {
    case "sphere":
      return { area: { shape: "sphere", radius: size.base, ...scaling }, label };
    case "cylinder": {
      const height = num(t.height);
      if (height === undefined || height <= 0) return { error: `cylinder without a height (${label})` };
      return { area: { shape: "cylinder", radius: size.base, height, ...scaling }, label };
    }
    case "cone":
      return { area: { shape: "cone", length: size.base, ...scaling }, label };
    case "cube":
      return { area: { shape: "cube", size: size.base, ...scaling }, label };
    case "square":
      return {
        area: { shape: "cube", size: size.base, ...scaling },
        label,
        approximate: "Foundry 'square' (flat) mapped to a Cube of the same side",
      };
    case "line":
      return { area: { shape: "line", length: size.base, width: num(t.width) ?? 5, ...scaling }, label };
    case "radius":
      return { area: { shape: "emanation", distance: size.base, ...scaling }, label };
    case "circle":
      return {
        area: { shape: "sphere", radius: size.base, ...scaling },
        label,
        approximate: "Foundry 'circle' (flat) mapped to a Sphere of the same radius",
      };
    case "wall":
    case "ring": {
      const height = num(t.height);
      const thickness = num(t.width);
      if (height === undefined || thickness === undefined)
        return { error: `wall without height/thickness (${label})` };
      if (t.type === "ring") {
        return { area: { shape: "wall", length: 0, height, thickness, ring: size.base }, label };
      }
      return { area: { shape: "wall", length: size.base, height, thickness, ...scaling }, label };
    }
    default:
      return { error: `unknown template type "${t.type}"` };
  }
}

function foundryTemplates(f: FoundrySpell): { source: string; t: FoundryTemplate }[] {
  const out: { source: string; t: FoundryTemplate }[] = [];
  if (f.template) out.push({ source: "item", t: f.template });
  for (const a of f.activities)
    if (a.template) out.push({ source: `activity "${a.name || a.type}"`, t: a.template });
  return out;
}

/** Translates a Foundry roll term to the §18.1 grammar; null when it uses something we can't express. */
function translateTerm(s: string): string | null {
  const t = s.trim();
  if (t === "") return "";
  if (/^\d+$/.test(t)) return t;
  if (t === "@mod") return "@spellmod";
  return null;
}

function partFormula(p: FoundryPart): { formula: string } | { error: string } {
  if (p.custom) {
    const translated = p.custom.replace(/@mod\b/g, "@spellmod");
    if (/@(?!spellmod\b)/.test(translated) || /[^0-9d+\-*/() @a-z]/i.test(translated)) {
      return { error: `custom formula "${p.custom}" can't be expressed in the dice grammar` };
    }
    if (/\d+d\d+x/.test(translated))
      return { error: `custom formula "${p.custom}" uses Foundry-only syntax` };
    return { formula: translated };
  }
  const bonus = translateTerm(p.bonus);
  if (bonus === null) return { error: `bonus "${p.bonus}" can't be expressed in the dice grammar` };
  if (p.number !== null && p.denomination !== null) {
    return { formula: `${p.number}d${p.denomination}${bonus ? ` + ${bonus}` : ""}` };
  }
  if (bonus) return { formula: bonus };
  return { error: "part has no dice and no bonus" };
}

function partScaling(p: FoundryPart): string | null | { error: string } {
  if (p.scaling.mode === "") return null;
  if (p.scaling.mode !== "whole") return { error: `scaling mode "${p.scaling.mode}"` };
  if (p.scaling.formula) {
    const t = p.scaling.formula.replace(/@mod\b/g, "@spellmod");
    return /@(?!spellmod\b)/.test(t) ? { error: `scaling formula "${p.scaling.formula}"` } : t;
  }
  const n = p.scaling.number ?? 1;
  if (p.denomination === null) return { error: "scaling without dice" };
  return `${n}d${p.denomination}`;
}

const normFormula = (f: string) => f.replace(/\s+/g, "").toLowerCase();

// ---------------------------------------------------------------------------------------------------------
// Area comparison

function areaKey(a: Area): string {
  switch (a.shape) {
    case "sphere":
      return `sphere r${a.radius}`;
    case "cylinder":
      return `cylinder r${a.radius} h${a.height}`;
    case "cone":
      return `cone ${a.length}`;
    case "cube":
      return `cube ${a.size}`;
    case "line":
      return `line ${a.length}x${a.width ?? 5}`;
    case "emanation":
      return `emanation ${a.distance}`;
    case "wall":
      return `wall ${a.length}x${a.height}x${a.thickness}${a.ring ? ` ring ${a.ring}` : ""}`;
  }
}

export function describeArea(a: Area | null | undefined): string {
  if (!a) return "none";
  const s = a.scaling ? ` (+${a.scaling.perSlot} ft/slot)` : "";
  return `${areaKey(a)}${s}`;
}

// ---------------------------------------------------------------------------------------------------------
// VFX

function vfxFor(
  damage: Damage[] | undefined,
  healing: Healing | null | undefined,
): { vfx: Vfx; rule: string } {
  const first = damage?.[0];
  if (first) {
    const t = first.type;
    if (t === "slashing" || t === "piercing" || t === "bludgeoning") {
      return { vfx: "force", rule: `primary damage ${t} → force` };
    }
    return { vfx: t, rule: `primary damage ${t}` };
  }
  if (healing) return { vfx: "healing", rule: "healing spell" };
  return { vfx: "arcane", rule: "no damage or healing → arcane" };
}

// ---------------------------------------------------------------------------------------------------------
// Merge

export function mergeSpell(
  pdf: PdfSpell,
  foundry: FoundrySpell | undefined,
  overlays: Overlays,
): MergedSpell {
  const notes: SpellNote[] = [];
  const review: string[] = [];
  const prov: Record<string, string> = {};
  const note = (field: string, kind: NoteKind, message: string) => notes.push({ field, kind, message });
  const flag = (reason: string) => {
    if (!review.includes(reason)) review.push(reason);
  };
  const higher = pdf.higherLevels?.plain ?? "";
  const text = pdf.prose;

  // --- Header fields (PDF) -------------------------------------------------------------------------------
  const { castingTime, ritual } = parseCastingTime(pdf.header.castingTime);
  const range = parseRange(pdf.header.range);
  const components = parseComponents(pdf.header.components);
  const duration = parseDuration(pdf.header.duration);
  for (const f of [
    "id",
    "name",
    "level",
    "school",
    "classes",
    "castingTime",
    "ritual",
    "range",
    "components",
    "duration",
    "text",
  ]) {
    prov[f] = "pdf";
  }
  if (pdf.higherLevels) prov.higherLevels = "pdf";
  if (pdf.cantripUpgrade) prov.cantripUpgrade = "pdf";

  const record: SpellInput = {
    id: pdf.id,
    name: pdf.name,
    level: pdf.level,
    school: pdf.school as SpellInput["school"],
    classes: pdf.classes,
    castingTime,
    ritual,
    range,
    components,
    duration,
    text: pdf.text,
    vfx: "arcane",
    source: { pack: PACK_ID, page: pdf.page },
  };
  if (pdf.higherLevels) record.higherLevels = pdf.higherLevels.md;
  if (pdf.cantripUpgrade) record.cantripUpgrade = pdf.cantripUpgrade.md;

  if (!foundry) {
    note("*", "missing", "No Foundry record for this spell; all structured data from prose/overlays");
    flag("no Foundry record");
  } else {
    crossCheckHeader(pdf, foundry, record, note);
  }

  const overlayApps = overlays.bySpell.get(pdf.id) ?? [];
  const overlayFor = (field: string): OverlayApplication | undefined =>
    overlayApps.find((o) => field in o.set);

  // --- Area ----------------------------------------------------------------------------------------------
  const pArea = proseArea(text);
  const pScale = higher ? proseAreaScaling(higher) : null;
  const proseAreaValue: Area | null = pArea
    ? ({ ...pArea.value, ...(pScale ? { scaling: { perSlot: pScale.value } } : {}) } as Area)
    : null;
  const fCandidates: { source: string; result: FoundryAreaResult }[] = [];
  for (const { source, t } of foundry ? foundryTemplates(foundry) : []) {
    const r = mapTemplate(t, pdf.level);
    if ("error" in r) note("area", "info", `Foundry ${source} template ignored: ${r.error}`);
    else fCandidates.push({ source, result: r });
  }
  const oArea = overlayFor("area");
  let area: Area | null = null;
  if (oArea) {
    area = (oArea.set.area ?? null) as Area | null;
    prov.area = `overlay:${oArea.file}`;
    const agrees = (a: Area | null) => a !== null && area !== null && areaKey(a) === areaKey(area);
    const fMatch = fCandidates.find((c) => agrees(c.result.area));
    note(
      "area",
      "resolved",
      `overlay (p. ${oArea.page}) → ${describeArea(area)}; prose: ${pArea ? `${describeArea(proseAreaValue)} [${pArea.pattern}]` : "no pattern"}${agrees(proseAreaValue) ? " (agrees)" : ""}; Foundry: ${fCandidates.map((c) => `${c.source} ${describeArea(c.result.area)}`).join(", ") || "no template"}${fMatch ? " (agrees)" : ""}`,
    );
  } else if (proseAreaValue && pArea) {
    area = proseAreaValue;
    const fMatch = fCandidates.find((c) => areaKey(c.result.area) === areaKey(proseAreaValue));
    if (fMatch) {
      prov.area = `prose:${pArea.pattern}+foundry`;
      const fScale = fMatch.result.area.scaling?.perSlot;
      const pS = proseAreaValue.scaling?.perSlot;
      if (fScale !== pS) {
        note(
          "area.scaling",
          "disagreement",
          `prose ${pS ?? "none"} ft/slot vs Foundry ${fScale ?? "none"} ft/slot; prose used`,
        );
        flag("area scaling: prose and Foundry disagree");
      }
    } else if (fCandidates.length > 0) {
      prov.area = `prose:${pArea.pattern}`;
      note(
        "area",
        "disagreement",
        `prose "${pArea.match}" → ${describeArea(proseAreaValue)} vs Foundry ${fCandidates.map((c) => `${c.source} ${c.result.label}`).join(", ")}; prose used`,
      );
      flag("area: prose and Foundry disagree");
    } else {
      prov.area = `prose:${pArea.pattern}`;
      note(
        "area",
        "resolved",
        `Foundry has no template; prose "${pArea.match}" → ${describeArea(proseAreaValue)}`,
      );
    }
  } else if (fCandidates.length > 0) {
    const first = fCandidates[0]!;
    area = first.result.area;
    prov.area = `foundry:${first.source}`;
    note(
      "area",
      "missing",
      `no area phrase in the prose; Foundry ${first.source} template ${first.result.label} → ${describeArea(area)}${first.result.approximate ? ` (${first.result.approximate})` : ""}`,
    );
    flag("area only from Foundry (no prose area phrase)");
  }
  if (area) record.area = area;
  const oAlt = overlayFor("areaAlternatives");
  if (oAlt?.set.areaAlternatives) {
    record.areaAlternatives = oAlt.set.areaAlternatives;
    prov.areaAlternatives = `overlay:${oAlt.file}`;
  }

  // --- Attack --------------------------------------------------------------------------------------------
  const pAttack = proseAttack(text);
  const fAttacks = (foundry?.activities ?? [])
    .filter((a) => a.type === "attack" && a.attack)
    .map((a) => ({ kind: a.attack!.value, cls: a.attack!.classification }));
  const fSpellAttack = fAttacks.find((a) => a.cls === "spell" || a.cls === "");
  const oAttack = overlayFor("attack");
  if (oAttack) {
    record.attack = oAttack.set.attack ?? null;
    prov.attack = `overlay:${oAttack.file}`;
  } else if (pAttack) {
    record.attack = { kind: pAttack.value };
    if (fSpellAttack && fSpellAttack.kind === pAttack.value) prov.attack = "prose+foundry";
    else {
      prov.attack = `prose:${pAttack.pattern}`;
      if (fSpellAttack) {
        note("attack", "disagreement", `prose ${pAttack.value} vs Foundry ${fSpellAttack.kind}; prose used`);
        flag("attack: prose and Foundry disagree");
      } else note("attack", "resolved", `Foundry has no spell attack; prose "${pAttack.match}"`);
    }
  } else if (fAttacks.length > 0) {
    note(
      "attack",
      "info",
      `Foundry attack activity (${fAttacks.map((a) => `${a.kind}/${a.cls || "unclassified"}`).join(", ")}) not recorded: the prose has no spell attack (weapon or creature attack)`,
    );
  }

  // --- Splash (an attack that then bursts: Ice Knife) — only by an overlay ----------------------------------
  const oSplash = overlayFor("splash");
  if (oSplash?.set.splash !== undefined) {
    record.splash = oSplash.set.splash;
    prov.splash = `overlay:${oSplash.file}`;
  }

  // --- Save ----------------------------------------------------------------------------------------------
  const pSave = proseSave(text);
  const fSaveActs = (foundry?.activities ?? []).filter((a) => a.saveAbilities.length > 0);
  const fSaveAbilities = [...new Set(fSaveActs.flatMap((a) => a.saveAbilities))];
  const oSave = overlayFor("save");
  if (oSave) {
    record.save = oSave.set.save ?? null;
    prov.save = `overlay:${oSave.file}`;
  } else if (pSave) {
    record.save = pSave.value;
    if (fSaveAbilities.includes(pSave.value.ability)) {
      prov.save = `prose:${pSave.pattern}+foundry`;
      const fOn = fSaveActs.find((a) => a.saveAbilities.includes(pSave.value.ability))?.onSave ?? "";
      const fDamage = fSaveActs.some((a) => a.damageParts.length > 0);
      if (
        fDamage &&
        fOn &&
        fOn !== pSave.value.onSuccess &&
        !(fOn === "full" && pSave.value.onSuccess === "special")
      ) {
        note(
          "save.onSuccess",
          "disagreement",
          `prose ${pSave.value.onSuccess} vs Foundry onSave ${fOn}; prose used`,
        );
        flag("save outcome: prose and Foundry disagree");
      }
    } else {
      prov.save = `prose:${pSave.pattern}`;
      if (fSaveAbilities.length > 0) {
        note(
          "save",
          "disagreement",
          `prose ${pSave.value.ability} ("${pSave.match}") vs Foundry ${fSaveAbilities.join("/")}; prose used`,
        );
        flag("save ability: prose and Foundry disagree");
      } else note("save", "resolved", `Foundry has no save; prose "${pSave.match}"`);
    }
  } else if (fSaveAbilities.length > 0) {
    const first = fSaveActs[0]!;
    const onSuccess =
      first.onSave === "half" ? "half" : first.onSave === "none" || first.onSave === "" ? "none" : "special";
    record.save = {
      ability: first.saveAbilities[0] as NonNullable<SpellInput["save"]>["ability"],
      onSuccess,
    };
    prov.save = "foundry";
    note(
      "save",
      "missing",
      `no forced-save phrase in the prose; Foundry save ${fSaveAbilities.join("/")} used`,
    );
    flag("save only from Foundry (no prose save phrase)");
  }

  // --- Damage --------------------------------------------------------------------------------------------
  const pDamage = proseDamage(text);
  const fParts: { part: FoundryPart; activity: string }[] = [];
  for (const a of foundry?.activities ?? []) {
    if (a.type === "heal") continue;
    for (const part of a.damageParts) fParts.push({ part, activity: a.name || a.type });
  }
  const oDamage = overlayFor("damage");
  let damage: Damage[] = [];
  let skippedFoundryParts = 0;
  if (oDamage) {
    damage = oDamage.set.damage ?? [];
    prov.damage = `overlay:${oDamage.file}`;
  } else if (fParts.length > 0) {
    const seen = new Set<string>();
    for (const { part, activity } of fParts) {
      const types = part.types.filter((t) => DAMAGE_SET.has(t)) as DamageType[];
      const f = partFormula(part);
      if ("error" in f) {
        note("damage", "info", `Foundry part in "${activity}" skipped: ${f.error}`);
        skippedFoundryParts++;
        continue;
      }
      if (types.length === 0) {
        note(
          "damage",
          "info",
          `Foundry part ${f.formula} in "${activity}" has no damage type (${part.types.join(",") || "none"}); skipped`,
        );
        continue;
      }
      const key = `${normFormula(f.formula)}|${types.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const d: Damage = { formula: f.formula, type: types[0]! };
      if (types.length > 1) d.typeOptions = types;
      if (pdf.level > 0) {
        const sc = partScaling(part);
        if (sc && typeof sc === "object")
          note("damage.scaling", "info", `Foundry scaling ignored: ${sc.error}`);
        else if (typeof sc === "string") d.scaling = { mode: "slot", perLevel: sc };
      }
      damage.push(d);
    }
    if (damage.length > 0) prov.damage = "foundry";
    if (damage.length > 0 && skippedFoundryParts > 0) flag("damage: a Foundry formula is not expressible");
    // Cross-check every Foundry part against the prose dice. A chosen type is usually printed as
    // "3d8 damage of the type you chose", so for a choice the dice alone must appear in the prose.
    const sameDamage = (p: (typeof pDamage)[number], d: Damage) =>
      normFormula(p.value.formula) === normFormula(d.formula) &&
      [p.value.type, ...(p.value.typeOptions ?? [])].some((t) => t === d.type || d.typeOptions?.includes(t));
    for (const d of damage) {
      const hit = pDamage.find((p) => sameDamage(p, d));
      // Tables (e.g. Prismatic Spray's rays) print dice outside the prose paragraphs.
      const dicePattern = d.formula.replace(/[+ ]/g, (c) => (c === "+" ? "\\+" : "\\s*"));
      const diceOnly =
        (d.typeOptions !== undefined && new RegExp(`\\b${dicePattern}\\b`).test(text)) ||
        new RegExp(`\\b${dicePattern} (?:${(d.typeOptions ?? [d.type]).join("|")}) damage`, "i").test(
          pdf.extraPlain,
        );
      if (!hit && !diceOnly) {
        note(
          "damage",
          "disagreement",
          `Foundry ${d.formula} ${d.typeOptions ? d.typeOptions.join("/") : d.type} not found in the prose`,
        );
      }
    }
    for (const p of pDamage) {
      if (!damage.some((d) => sameDamage(p, d))) {
        note(
          "damage",
          "info",
          `prose "${p.match}" has no Foundry damage part (secondary or conditional damage; text only)`,
        );
      }
    }
  }
  // Prose fills the gap when Foundry has no usable damage part (none, untyped or not expressible).
  if (!oDamage && damage.length === 0 && pDamage.length > 0) {
    const seen = new Set<string>();
    for (const p of pDamage) {
      const key = `${normFormula(p.value.formula)}|${p.value.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const d: Damage = { formula: p.value.formula, type: p.value.type };
      if (p.value.typeOptions) d.typeOptions = p.value.typeOptions;
      damage.push(d);
    }
    prov.damage = `prose:${pDamage[0]!.pattern}`;
    note(
      "damage",
      "missing",
      `${fParts.length > 0 ? "Foundry's damage parts are unusable" : "Foundry has no damage parts"}; prose ${pDamage.map((p) => `"${p.match}"`).join(", ")}`,
    );
  } else if (!oDamage && damage.length === 0 && skippedFoundryParts > 0) {
    flag("damage: Foundry formula not expressible and no prose damage phrase");
  }

  // Slot scaling: prose is canonical; Foundry cross-checked.
  const pSlot = higher ? proseSlotScaling(higher) : null;
  if (!oDamage && damage.length > 0 && pdf.level > 0) {
    if (pSlot && pSlot.value.appliesTo !== "healing") {
      const dice = pSlot.value.perLevel;
      // "The initial damage increases…" (Vitriolic Sphere) scales only the first part.
      const initialOnly = /\binitial damage increases\b/.test(higher);
      const targets = pSlot.value.type
        ? damage.filter((d) => d.type === pSlot.value.type)
        : initialOnly
          ? damage.slice(0, 1)
          : damage;
      if (dice.length === 1) {
        for (const d of targets) applySlotScaling(d, dice[0]!, note, flag);
      } else if (dice.length === targets.length) {
        targets.forEach((d, i) => {
          applySlotScaling(d, dice[i]!, note, flag);
        });
      } else {
        note(
          "damage.scaling",
          "disagreement",
          `higher-level text gives ${dice.join(", ")} for ${targets.length} damage parts; left as Foundry`,
        );
        flag("damage scaling ambiguous");
      }
      prov["damage.scaling"] = "prose:increases by NdM for each spell slot level above";
    } else {
      for (const d of damage) {
        if (d.scaling) {
          note(
            "damage.scaling",
            "disagreement",
            `Foundry scales ${d.formula} by ${d.scaling.mode === "slot" ? d.scaling.perLevel : "?"}/slot but the higher-level text has no dice increase; removed`,
          );
          delete d.scaling;
        }
      }
    }
  }
  if (!oDamage && damage.length > 0 && pdf.level === 0) {
    const pc = pdf.cantripUpgrade ? proseCantripScaling(pdf.cantripUpgrade.plain) : null;
    if (pc) {
      const base = damage[0]!;
      const die = /^1d(\d+)$/.exec(base.formula);
      const expect = die ? { "5": `2d${die[1]}`, "11": `3d${die[1]}`, "17": `4d${die[1]}` } : null;
      for (const d of damage) {
        if (normFormula(d.formula).startsWith("1d") && pc.value["5"].endsWith(d.formula.replace(/^1/, ""))) {
          d.scaling = { mode: "cantrip", atLevels: pc.value };
        }
      }
      prov["damage.scaling"] = `prose:${pc.pattern}`;
      if (expect && JSON.stringify(expect) !== JSON.stringify(pc.value)) {
        note(
          "damage.scaling",
          "info",
          `cantrip upgrade ${JSON.stringify(pc.value)} is not the usual 2/3/4 dice progression`,
        );
      }
    } else if (pdf.cantripUpgrade) {
      note(
        "damage.scaling",
        "missing",
        `cantrip upgrade isn't a dice progression ("${pdf.cantripUpgrade.plain.slice(0, 120)}…"); text only`,
      );
      flag("cantrip upgrade is not a damage-dice progression; kept in text only");
    }
  }
  if (damage.length > 0) record.damage = damage;

  // --- Healing -------------------------------------------------------------------------------------------
  const pHeal = proseHealing(text);
  const fHeal = (foundry?.activities ?? []).find((a) => a.type === "heal" && a.healing);
  const oHeal = overlayFor("healing");
  if (oHeal) {
    record.healing = oHeal.set.healing ?? null;
    prov.healing = `overlay:${oHeal.file}`;
  } else if (fHeal?.healing?.types.includes("temphp")) {
    note(
      "healing",
      "info",
      "Foundry heal activity grants Temporary Hit Points (not healing); not recorded as healing",
    );
  } else if (fHeal?.healing) {
    const f = partFormula(fHeal.healing);
    if ("error" in f) {
      note("healing", "info", `Foundry healing skipped: ${f.error}`);
      if (pHeal) {
        record.healing = { formula: pHeal.value };
        prov.healing = `prose:${pHeal.pattern}`;
      } else flag("healing: formula not expressible");
    } else {
      record.healing = { formula: f.formula };
      prov.healing = "foundry";
      if (pHeal && normFormula(pHeal.value) !== normFormula(f.formula)) {
        note("healing", "disagreement", `Foundry ${f.formula} vs prose "${pHeal.match}"; prose used`);
        record.healing = { formula: pHeal.value };
        prov.healing = `prose:${pHeal.pattern}`;
        flag("healing: prose and Foundry disagree");
      } else if (pHeal) prov.healing = `prose:${pHeal.pattern}+foundry`;
    }
  } else if (pHeal) {
    record.healing = { formula: pHeal.value };
    prov.healing = `prose:${pHeal.pattern}`;
    note("healing", "missing", `Foundry has no heal activity; prose "${pHeal.match}"`);
  }
  if (record.healing && !oHeal) {
    const heal = record.healing;
    if (pdf.level > 0 && pSlot && pSlot.value.appliesTo !== "damage") {
      const dice = pSlot.value.perLevel;
      heal.scaling = { mode: "slot", perLevel: dice[dice.length - 1]! };
      prov["healing.scaling"] = "prose:increases by NdM for each spell slot level above";
      const fSc = fHeal?.healing ? partScaling(fHeal.healing) : null;
      if (typeof fSc === "string" && normFormula(fSc) !== normFormula(heal.scaling.perLevel)) {
        note(
          "healing.scaling",
          "disagreement",
          `prose ${heal.scaling.perLevel}/slot vs Foundry ${fSc}/slot; prose used`,
        );
        flag("healing scaling: prose and Foundry disagree");
      }
    } else if (pdf.level > 0 && fHeal?.healing) {
      const fSc = partScaling(fHeal.healing);
      if (typeof fSc === "string") {
        heal.scaling = { mode: "slot", perLevel: fSc };
        prov["healing.scaling"] = "foundry";
        note(
          "healing.scaling",
          "missing",
          `no per-slot increase phrase in the higher-level text; Foundry +${fSc}/slot used`,
        );
      }
    }
  }

  // --- Conditions ----------------------------------------------------------------------------------------
  const pCond = proseConditions(text);
  const fCond = (foundry?.statuses ?? []).filter((s) => CONDITION_SET.has(s));
  const oCond = overlayFor("conditions");
  if (oCond) {
    record.conditions = oCond.set.conditions ?? [];
    prov.conditions = `overlay:${oCond.file}`;
  } else {
    const ids = [...new Set([...(pCond?.value ?? []), ...fCond])] as Condition["id"][];
    if (ids.length > 0) {
      const hasSave = record.save !== undefined && record.save !== null;
      record.conditions = ids.map((id) => ({ id, onFailedSave: hasSave }));
      const onlyProse = (pCond?.value ?? []).filter((c) => !fCond.includes(c));
      const onlyFoundry = fCond.filter((c) => !(pCond?.value ?? []).includes(c as Condition["id"]));
      prov.conditions =
        pCond && fCond.length > 0
          ? `prose:${pCond.pattern}+foundry`
          : pCond
            ? `prose:${pCond.pattern}`
            : "foundry";
      if (onlyProse.length > 0 && fCond.length > 0)
        note("conditions", "info", `prose adds ${onlyProse.join(", ")} (not in Foundry effects)`);
      if (onlyFoundry.length > 0)
        note(
          "conditions",
          "info",
          `Foundry effects add ${onlyFoundry.join(", ")} (no "has the … condition" phrase in the prose)`,
        );
    }
  }
  const foundryOtherStatuses = (foundry?.statuses ?? []).filter((s) => !CONDITION_SET.has(s));
  if (foundryOtherStatuses.length > 0)
    note(
      "conditions",
      "info",
      `Foundry statuses without an SRD condition id ignored: ${foundryOtherStatuses.join(", ")}`,
    );

  // --- Markers (rules audit Q6): Bless's Blessed, Bane's Baned, Haste's Hasted, Slow's Slowed — by overlay only -----
  const oMarkers = overlayFor("markers");
  if (oMarkers) {
    record.markers = oMarkers.set.markers ?? [];
    prov.markers = `overlay:${oMarkers.file}`;
  }

  // --- Light and obscurement -----------------------------------------------------------------------------
  const oLight = overlayFor("light");
  const pLight = proseLight(text);
  if (oLight) {
    record.light = oLight.set.light ?? null;
    prov.light = `overlay:${oLight.file}`;
  } else if (pLight) {
    record.light = {
      bright: pLight.value.bright,
      dim: pLight.value.dim,
      magical: true,
      pierceDarkness: false,
    };
    prov.light = `prose:${pLight.pattern}`;
  }
  const oObsc = overlayFor("obscurement");
  if (oObsc) {
    record.obscurement = oObsc.set.obscurement ?? null;
    prov.obscurement = `overlay:${oObsc.file}`;
  } else {
    const m = /\b(Heavily|Lightly) Obscured\b/.exec(text);
    if (m) {
      record.obscurement = m[1] === "Heavily" ? "heavy" : "light";
      prov.obscurement = "prose:<Heavily|Lightly> Obscured";
    }
  }

  // --- Persistent effect ---------------------------------------------------------------------------------
  const oEffect = overlayFor("effect");
  if (oEffect) {
    record.effect = oEffect.set.effect ?? null;
    prov.effect = `overlay:${oEffect.file}`;
  }

  // --- Targeting -----------------------------------------------------------------------------------------
  const oTarget = overlayFor("targeting");
  if (oTarget?.set.targeting) {
    record.targeting = oTarget.set.targeting;
    prov.targeting = `overlay:${oTarget.file}`;
  } else {
    record.targeting = deriveTargeting(pdf, foundry, record, higher, prov, note);
  }

  // --- VFX -----------------------------------------------------------------------------------------------
  const oVfx = overlayFor("vfx");
  if (oVfx?.set.vfx) {
    record.vfx = oVfx.set.vfx;
    prov.vfx = `overlay:${oVfx.file}`;
  } else {
    const v = vfxFor(record.damage, record.healing);
    record.vfx = v.vfx;
    prov.vfx = `derived:${v.rule}`;
  }

  // Overlay fields that weren't consumed above would be silently ignored: refuse them.
  for (const o of overlayApps) {
    for (const field of Object.keys(o.set)) {
      if (!prov[field]?.startsWith("overlay:"))
        throw new Error(`Overlay ${o.file} sets ${pdf.id}.${field} but it was not applied`);
    }
  }
  for (const o of overlayApps) {
    if (!pdf.pages.includes(o.page)) {
      note("overlay", "info", `${o.file} cites p. ${o.page}; the spell spans pp. ${pdf.pages.join(", ")}`);
    }
    // Judgment calls recorded in overlays stay on the manual-review list until a rules reviewer signs off.
    if (o.review) flag(`judgment call (${o.file}): ${o.review}`);
  }
  if (prov.area?.includes("→ Cube") && !prov.area.startsWith("overlay:")) {
    flag("flat square on the ground represented as a Cube of the same side (§17.1 has no square)");
  }

  record.provenance = Object.fromEntries(Object.entries(prov).sort(([a], [b]) => a.localeCompare(b)));
  return { record, notes, review };
}

function applySlotScaling(
  d: Damage,
  perLevel: string,
  note: (field: string, kind: NoteKind, message: string) => void,
  flag: (reason: string) => void,
) {
  const prior = d.scaling?.mode === "slot" ? d.scaling.perLevel : null;
  if (prior !== null && normFormula(prior) !== normFormula(perLevel)) {
    note(
      "damage.scaling",
      "disagreement",
      `${d.formula}: prose +${perLevel}/slot vs Foundry +${prior}/slot; prose used`,
    );
    flag("damage scaling: prose and Foundry disagree");
  } else if (prior === null) {
    note("damage.scaling", "resolved", `${d.formula}: Foundry has no scaling; prose +${perLevel}/slot`);
  }
  d.scaling = { mode: "slot", perLevel };
}

function deriveTargeting(
  pdf: PdfSpell,
  foundry: FoundrySpell | undefined,
  record: SpellInput,
  higher: string,
  prov: Record<string, string>,
  note: (field: string, kind: NoteKind, message: string) => void,
): NonNullable<SpellInput["targeting"]> {
  if (record.area) {
    prov.targeting = "derived:area";
    return { kind: "area" };
  }
  const affects = foundry?.affects.type ?? "";
  let kind: NonNullable<SpellInput["targeting"]>["kind"];
  if (["creature", "willing", "ally", "enemy", "creatureOrObject", "any"].includes(affects))
    kind = "creatures";
  else if (affects === "object") kind = "object";
  else if (affects === "space") kind = "point";
  else if (affects === "self" || record.range.kind === "self") kind = "self";
  else if (record.attack) kind = "creatures";
  else kind = record.range.kind === "touch" ? "creatures" : "point";
  const out: NonNullable<SpellInput["targeting"]> = { kind };
  prov.targeting =
    foundry && affects ? `foundry:affects.type=${affects}` : `derived:range ${record.range.kind}`;
  if (kind === "creatures" || kind === "object") {
    const count = foundry?.affects.count ?? "";
    const lin = count ? linearAtLevel(count, pdf.level) : null;
    const pCount = proseTargetCount(pdf.prose);
    const pPer = higher ? proseTargetCountPerSlot(higher) : null;
    if (pCount && lin && lin.base >= 1 && pCount.value !== lin.base) {
      // Foundry often counts the caster ("You and up to eight willing creatures" → 9); the PDF wins.
      out.count = pCount.value;
      prov["targeting.count"] = `prose:${pCount.pattern}`;
      note("targeting.count", "disagreement", `Foundry ${lin.base} vs prose "${pCount.match}"; prose used`);
    } else if (lin && lin.base >= 1) {
      out.count = lin.base;
      if (lin.perSlot > 0) out.countPerSlot = lin.perSlot;
    } else if (pCount) {
      out.count = pCount.value;
      prov["targeting.count"] = `prose:${pCount.pattern}`;
    }
    if (pPer && out.countPerSlot === undefined) {
      out.countPerSlot = pPer.value;
      prov["targeting.countPerSlot"] = `prose:${pPer.pattern}`;
      if (out.count === undefined) out.count = 1;
    } else if (pPer && out.countPerSlot !== pPer.value) {
      note(
        "targeting.countPerSlot",
        "disagreement",
        `Foundry ${out.countPerSlot}/slot vs prose "${pPer.match}"`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Header cross-check against Foundry (the PDF wins; differences go to the report)

function crossCheckHeader(
  pdf: PdfSpell,
  f: FoundrySpell,
  record: SpellInput,
  note: (field: string, kind: NoteKind, message: string) => void,
): void {
  if (f.level !== pdf.level) note("level", "disagreement", `Foundry level ${f.level}`);
  if (f.school !== pdf.school) note("school", "disagreement", `Foundry school ${f.school}`);
  const ct = record.castingTime;
  const fUnit = f.activation.type;
  const fAmount = f.activation.value === "" ? 1 : Number(f.activation.value);
  const unitOk = fUnit === ct.unit || (fUnit === "action" && ct.unit === "action");
  if (!unitOk || (["minute", "hour"].includes(ct.unit) && fAmount !== ct.amount)) {
    note(
      "castingTime",
      "disagreement",
      `PDF "${pdf.header.castingTime}" vs Foundry ${f.activation.value || ""} ${fUnit}`.replace(/\s+/g, " "),
    );
  }
  const fRitual = f.properties.includes("ritual");
  if (fRitual !== record.ritual)
    note("ritual", "disagreement", `PDF ritual=${record.ritual} vs Foundry ${fRitual}`);
  const fConc = f.properties.includes("concentration");
  if (fConc !== (record.duration.concentration ?? false)) {
    note(
      "duration.concentration",
      "disagreement",
      `PDF concentration=${record.duration.concentration} vs Foundry ${fConc}`,
    );
  }
  const comps = record.components;
  const fv = f.properties.includes("vocal");
  const fs = f.properties.includes("somatic");
  const fm = f.properties.includes("material");
  if (fv !== comps.v || fs !== comps.s || fm !== comps.m) {
    note(
      "components",
      "disagreement",
      `PDF ${pdf.header.components.split("(")[0]!.trim()} vs Foundry ${[fv && "V", fs && "S", fm && "M"].filter(Boolean).join(", ")}`,
    );
  }
  if (comps.m && (comps.consumed ?? false) !== f.materials.consumed) {
    note(
      "components.consumed",
      "disagreement",
      `PDF consumed=${comps.consumed ?? false} vs Foundry ${f.materials.consumed}`,
    );
  }
  if ((comps.costGp ?? 0) !== f.materials.cost && f.materials.cost > 0) {
    note(
      "components.costGp",
      "disagreement",
      `PDF ${comps.costGp ?? 0} GP vs Foundry ${f.materials.cost} GP`,
    );
  }
  const r = record.range;
  const fr = f.range;
  const rangeFt =
    fr.units === "ft" ? Number(fr.value) : fr.units === "mi" ? Number(fr.value) * 5280 : undefined;
  const rangeOk =
    (r.kind === "self" && fr.units === "self") ||
    (r.kind === "touch" && fr.units === "touch") ||
    (r.kind === "ranged" && rangeFt === r.ft) ||
    (r.kind === "unlimited" && fr.units === "any") ||
    (r.kind === "special" && fr.units === "spec") ||
    (r.kind === "sight" && (fr.units === "spec" || fr.special.toLowerCase().includes("sight")));
  // Foundry encodes some upcast/cantrip scaling in the value itself ("@item.level * 48 - 72"); that is
  // information about scaling, not a disagreement about the base value.
  const isFormula = (v: string) => /[@*()]/.test(v);
  if (!rangeOk && isFormula(fr.value)) {
    note(
      "range",
      "info",
      `Foundry scales the range by formula (${fr.value} ${fr.units}); PDF "${pdf.header.range}"`,
    );
  } else if (!rangeOk && !(fr.units === "mi" && r.text === `${fr.value} miles`)) {
    // (Project Image's "500 miles" is kept as text beyond the Ft bound; Foundry's "500 mi" is the same.)
    note(
      "range",
      "disagreement",
      `PDF "${pdf.header.range}" vs Foundry ${fr.value} ${fr.units}${fr.special ? ` (${fr.special})` : ""}`,
    );
  }
  const d = record.duration;
  const fu = f.duration.units;
  const map: Record<string, string> = { minute: "minute", hour: "hour", day: "day", round: "round" };
  const durOk =
    (d.kind === "instantaneous" && fu === "inst") ||
    (d.kind === "until-dispelled" && (fu === "perm" || fu === "disp" || fu === "dstr")) ||
    (d.kind === "special" && fu === "spec") ||
    (d.kind === "timed" && map[fu] === d.unit && Number(f.duration.value) === d.amount);
  if (!durOk && isFormula(f.duration.value)) {
    note(
      "duration",
      "info",
      `Foundry scales the duration by formula (${f.duration.value} ${fu}); PDF "${pdf.header.duration}"`,
    );
  } else if (!durOk) {
    note("duration", "disagreement", `PDF "${pdf.header.duration}" vs Foundry ${f.duration.value} ${fu}`);
  }
}
