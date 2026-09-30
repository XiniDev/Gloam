/**
 * Step 5 of the content pipeline (SPEC §33.2): hand-authored overlays in packages/content/overlays/.
 *
 * Every spell overlay entry cites the PDF page it comes from and quotes or paraphrases the passage
 * ("source"); those notes stay in the overlay files and the report, not in spells.json. `set` holds the
 * record fields to apply; it is validated against the spell schema's own field schemas, and a field may be
 * set by only one overlay file (a second setter is a build error, so overlays can't silently fight).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Slug, SpellSchema } from "@gloam/shared/schemas";
import { z } from "zod";
import { OVERLAYS_DIR } from "./lib/pins.ts";

/** Record fields an overlay may set (header fields and text always come from the PDF). */
export const OVERLAY_FIELDS = [
  "area",
  "areaAlternatives",
  "targeting",
  "attack",
  "splash",
  "save",
  "damage",
  "healing",
  "conditions",
  "markers",
  "effect",
  "light",
  "obscurement",
  "vfx",
] as const;
export type OverlayField = (typeof OVERLAY_FIELDS)[number];

const OverlaySet = SpellSchema.pick({
  area: true,
  areaAlternatives: true,
  targeting: true,
  attack: true,
  splash: true,
  save: true,
  damage: true,
  healing: true,
  conditions: true,
  markers: true,
  effect: true,
  light: true,
  obscurement: true,
  vfx: true,
})
  .partial()
  .strict();

const OverlayEntry = z
  .object({
    page: z.number().int().min(1).max(364),
    source: z.string().min(1).max(2000),
    /** A judgment call a rules reviewer should confirm; flags the spell for manual review in the report. */
    review: z.string().min(1).max(300).optional(),
    set: OverlaySet,
  })
  .strict();

const OverlayFile = z
  .object({
    $comment: z.string().optional(),
    spells: z.record(Slug, OverlayEntry),
  })
  .strict();

const HyphenationFile = z
  .object({
    $comment: z.string().optional(),
    keep: z.array(z.string().regex(/^[a-z’']+-[a-z’']+$/)),
    join: z.array(z.string().regex(/^[a-z’']+-[a-z’']+$/)),
  })
  .strict();
export type Hyphenation = z.infer<typeof HyphenationFile>;

/** Applied in this order; each file owns the fields it sets for a spell. */
export const SPELL_OVERLAY_FILES = [
  "spell-areas.json",
  "spell-light.json",
  "spell-effects.json",
  "spell-mechanics.json",
  "spell-vfx.json",
] as const;

export interface OverlayApplication {
  file: string;
  page: number;
  source: string;
  review?: string;
  set: z.infer<typeof OverlaySet>;
}

export interface Overlays {
  bySpell: Map<string, OverlayApplication[]>;
  hyphenation: Hyphenation;
  files: { file: string; entries: number }[];
}

/**
 * JSON.parse keeps the last of two identical keys without a word, which would silently drop an overlay
 * entry; scan the text and refuse duplicates within any object.
 */
export function assertNoDuplicateKeys(text: string, file: string): void {
  const stack: (Set<string> | null)[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i + 1, j);
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      const keys = stack[stack.length - 1];
      if (text[k] === ":" && keys) {
        const key = JSON.parse(`"${raw}"`) as string;
        if (keys.has(key)) throw new Error(`Overlay ${file}: duplicate key "${key}"`);
        keys.add(key);
      }
      i = j + 1;
      continue;
    }
    if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    i++;
  }
}

function readJsonFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  assertNoDuplicateKeys(text, path);
  return JSON.parse(text);
}

export function loadOverlays(dir = OVERLAYS_DIR): Overlays {
  const bySpell = new Map<string, OverlayApplication[]>();
  const files: { file: string; entries: number }[] = [];
  for (const file of SPELL_OVERLAY_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) throw new Error(`Missing overlay file ${path}`);
    const parsed = OverlayFile.safeParse(readJsonFile(path));
    if (!parsed.success) throw new Error(`Overlay ${file} is invalid:\n${z.prettifyError(parsed.error)}`);
    const entries = Object.entries(parsed.data.spells);
    files.push({ file, entries: entries.length });
    for (const [id, entry] of entries) {
      const list = bySpell.get(id) ?? [];
      for (const prior of list) {
        for (const field of Object.keys(entry.set)) {
          if (field in prior.set) {
            throw new Error(`Overlay conflict for ${id}.${field}: set by both ${prior.file} and ${file}`);
          }
        }
      }
      const app: OverlayApplication = { file, page: entry.page, source: entry.source, set: entry.set };
      if (entry.review !== undefined) app.review = entry.review;
      list.push(app);
      bySpell.set(id, list);
    }
  }
  const hyphPath = join(dir, "hyphenation.json");
  const hyph = HyphenationFile.safeParse(readJsonFile(hyphPath));
  if (!hyph.success) throw new Error(`Overlay hyphenation.json is invalid:\n${z.prettifyError(hyph.error)}`);
  return { bySpell, hyphenation: hyph.data, files };
}
