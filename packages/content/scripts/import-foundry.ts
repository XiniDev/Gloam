/**
 * Step 3 of the content pipeline (SPEC §33.2): read Foundry VTT dnd5e `spells24` YAML at the pinned commit
 * and normalise the structured mechanics we use (area template, save, damage parts and scaling, attack
 * type, healing, concentration/ritual flags, materials, range/duration units, applied statuses).
 *
 * The YAML is third-party input: it is parsed with a zod schema that keeps only the fields we read, and
 * anything unexpected fails loudly. Merging into spell records happens in merge.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { FOUNDRY } from "./lib/pins.ts";

const Num = z.union([z.number(), z.string()]).nullish();

const Template = z
  .object({
    type: z.string().nullish(),
    size: Num,
    width: Num,
    height: Num,
    units: z.string().nullish(),
    count: Num,
  })
  .partial();

const Affects = z
  .object({
    type: z.string().nullish(),
    count: Num,
    choice: z.boolean().nullish(),
    special: z.string().nullish(),
  })
  .partial();

const Part = z.object({
  number: Num,
  denomination: Num,
  bonus: z.string().nullish(),
  types: z.array(z.string()).nullish(),
  custom: z.object({ enabled: z.boolean().nullish(), formula: z.string().nullish() }).partial().nullish(),
  scaling: z
    .object({ mode: z.string().nullish(), number: Num, formula: z.string().nullish() })
    .partial()
    .nullish(),
});

const Activity = z.object({
  type: z.string(),
  name: z.string().nullish(),
  sort: z.number().nullish(),
  activation: z.object({ type: z.string().nullish(), override: z.boolean().nullish() }).partial().nullish(),
  target: z
    .object({ override: z.boolean().nullish(), template: Template.nullish(), affects: Affects.nullish() })
    .partial()
    .nullish(),
  attack: z
    .object({
      type: z
        .object({ value: z.string().nullish(), classification: z.string().nullish() })
        .partial()
        .nullish(),
    })
    .partial()
    .nullish(),
  damage: z
    .object({ onSave: z.string().nullish(), parts: z.array(Part).nullish() })
    .partial()
    .nullish(),
  healing: Part.nullish(),
  save: z
    .object({ ability: z.union([z.string(), z.array(z.string())]).nullish() })
    .partial()
    .nullish(),
  effects: z
    .array(z.object({ _id: z.string().nullish(), onSave: z.boolean().nullish() }).partial())
    .nullish(),
});

const SpellYaml = z.object({
  name: z.string(),
  type: z.literal("spell"),
  system: z.object({
    description: z.object({ value: z.string().nullish() }).partial().nullish(),
    activation: z
      .object({ type: z.string().nullish(), value: Num, condition: z.string().nullish() })
      .partial(),
    duration: z.object({ value: Num, units: z.string().nullish() }).partial(),
    target: z.object({ affects: Affects.nullish(), template: Template.nullish() }).partial().nullish(),
    range: z.object({ value: Num, units: z.string().nullish(), special: z.string().nullish() }).partial(),
    level: z.number().int().min(0).max(9),
    school: z.string(),
    properties: z.array(z.string()).nullish(),
    materials: z
      .object({ value: z.string().nullish(), consumed: z.boolean().nullish(), cost: Num, supply: Num })
      .partial()
      .nullish(),
    activities: z.record(z.string(), Activity).nullish(),
    identifier: z.string().nullish(),
  }),
  effects: z
    .array(
      z
        .object({
          _id: z.string().nullish(),
          name: z.string().nullish(),
          statuses: z.array(z.string()).nullish(),
          duration: z.object({ value: Num, units: z.string().nullish() }).partial().nullish(),
        })
        .partial(),
    )
    .nullish(),
});

export interface FoundryTemplate {
  type: string;
  size: string;
  width: string;
  height: string;
  count: string;
}

export interface FoundryPart {
  number: number | null;
  denomination: number | null;
  bonus: string;
  types: string[];
  custom: string;
  scaling: { mode: string; number: number | null; formula: string };
}

export interface FoundryActivity {
  id: string;
  type: string;
  name: string;
  template: FoundryTemplate | null;
  affects: { type: string; count: string } | null;
  attack: { value: string; classification: string } | null;
  saveAbilities: string[];
  onSave: string;
  damageParts: FoundryPart[];
  healing: FoundryPart | null;
  effectIds: string[];
}

export interface FoundrySpell {
  slug: string;
  file: string;
  name: string;
  level: number;
  school: string;
  activation: { type: string; value: string; condition: string };
  duration: { value: string; units: string };
  range: { value: string; units: string; special: string };
  template: FoundryTemplate | null;
  affects: { type: string; count: string; choice: boolean; special: string };
  properties: string[];
  materials: { value: string; consumed: boolean; cost: number };
  activities: FoundryActivity[];
  /** Status ids applied by the item's active effects (e.g. "paralyzed"). */
  statuses: string[];
  descriptionHtml: string;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function template(t: z.infer<typeof Template> | null | undefined): FoundryTemplate | null {
  if (!t) return null;
  const type = str(t.type);
  if (type === "") return null;
  return { type, size: str(t.size), width: str(t.width), height: str(t.height), count: str(t.count) };
}

function part(p: z.infer<typeof Part>): FoundryPart {
  return {
    number: numOrNull(p.number),
    denomination: numOrNull(p.denomination),
    bonus: str(p.bonus),
    types: (p.types ?? []).map((t) => t.toLowerCase()),
    custom: p.custom?.enabled ? str(p.custom.formula) : "",
    scaling: {
      mode: str(p.scaling?.mode),
      number: numOrNull(p.scaling?.number),
      formula: str(p.scaling?.formula),
    },
  };
}

export const FOUNDRY_SCHOOLS: Record<string, string> = {
  abj: "abjuration",
  con: "conjuration",
  div: "divination",
  enc: "enchantment",
  evo: "evocation",
  ill: "illusion",
  nec: "necromancy",
  trs: "transmutation",
};

export interface FoundryImport {
  spells: Map<string, FoundrySpell>;
  /** Files skipped because they are not spells (e.g. supplemental items). */
  skipped: string[];
}

export function importFoundry(spellsDir: string): FoundryImport {
  const spells = new Map<string, FoundrySpell>();
  const skipped: string[] = [];
  for (const dir of FOUNDRY.levelDirs) {
    const files = readdirSync(join(spellsDir, dir))
      .filter((f) => f.endsWith(".yml") && f !== "_folder.yml")
      .sort();
    for (const f of files) {
      const rel = `${FOUNDRY.spellsPath}/${dir}/${f}`;
      const raw: unknown = parse(readFileSync(join(spellsDir, dir, f), "utf8"));
      const parsed = SpellYaml.safeParse(raw);
      if (!parsed.success) {
        const type = (raw as { type?: unknown } | null)?.type;
        if (type !== "spell") {
          skipped.push(`${rel} (type ${String(type)})`);
          continue;
        }
        throw new Error(`Foundry ${rel} failed validation: ${parsed.error.message}`);
      }
      const d = parsed.data;
      const s = d.system;
      const slug = f.replace(/\.yml$/, "");
      const activities = Object.entries(s.activities ?? {})
        .map(([id, a], index) => ({ id, a, index }))
        .sort((x, y) => (x.a.sort ?? 0) - (y.a.sort ?? 0) || x.index - y.index)
        .map(({ id, a }): FoundryActivity => {
          const ab = a.save?.ability;
          return {
            id,
            type: a.type,
            name: str(a.name),
            template: a.target?.override ? template(a.target.template) : null,
            affects:
              a.target?.override && a.target.affects
                ? { type: str(a.target.affects.type), count: str(a.target.affects.count) }
                : null,
            attack: a.attack?.type
              ? { value: str(a.attack.type.value), classification: str(a.attack.type.classification) }
              : null,
            saveAbilities: (Array.isArray(ab) ? ab : ab ? [ab] : []).filter((x) => x !== ""),
            onSave: str(a.damage?.onSave),
            damageParts: (a.damage?.parts ?? []).map(part),
            healing: a.healing ? part(a.healing) : null,
            effectIds: (a.effects ?? []).map((e) => str(e._id)).filter((x) => x !== ""),
          };
        });
      spells.set(slug, {
        slug,
        file: rel,
        name: d.name,
        level: s.level,
        school: FOUNDRY_SCHOOLS[s.school] ?? s.school,
        activation: {
          type: str(s.activation.type),
          value: str(s.activation.value),
          condition: str(s.activation.condition),
        },
        duration: { value: str(s.duration.value), units: str(s.duration.units) },
        range: { value: str(s.range.value), units: str(s.range.units), special: str(s.range.special) },
        template: template(s.target?.template),
        affects: {
          type: str(s.target?.affects?.type),
          count: str(s.target?.affects?.count),
          choice: s.target?.affects?.choice ?? false,
          special: str(s.target?.affects?.special),
        },
        properties: [...(s.properties ?? [])].sort(),
        materials: {
          value: str(s.materials?.value),
          consumed: s.materials?.consumed ?? false,
          cost: numOrNull(s.materials?.cost) ?? 0,
        },
        activities,
        statuses: [...new Set((d.effects ?? []).flatMap((e) => e.statuses ?? []))].sort(),
        descriptionHtml: str(s.description?.value),
      });
    }
  }
  return { spells, skipped };
}
