/**
 * A roll as the table sees it (SPEC §18.2–18.3): the record its roller, the DMs and (for public rolls) everyone get,
 * the masked card the others get, and the dice a roll throws in 3D. Pure: the server decides and sends, clients read.
 */
import type { RollOutcome, RollTerm } from "./evaluate.ts";

export type RollVisibility = "public" | "dm" | "blind" | "self";

/** A die for the 3D tumble: its kind and the face it must land on (d100 as its tens and units d10s). */
export interface TumbleDie {
  kind: "d4" | "d6" | "d8" | "d10" | "d12" | "d20";
  /** The face value to show (d10: 0–9 with 0 for 10; a d100's tens die: 0, 10, … 90). */
  face: number;
  /** A percentile die's tens (00–90) or units. */
  percentile?: "tens" | "units";
  kept: boolean;
}

/** A roll as its roller, the DMs and (public) everyone get it. */
export interface RollRecord extends RollOutcome {
  id: string;
  userId: string;
  name: string;
  color: string;
  skin: DiceSkin;
  tokenId?: string;
  label?: string;
  visibility: RollVisibility;
  purpose?: string;
  manual: boolean;
  /** The 3D throw's seed (uint32). */
  seed: number;
  /** The dice to throw, the first 20 physically (§8.9). */
  tumble: TumbleDie[];
  at: number;
  /** Rolled by a DM acting as this character (AC-DMP-03): the card reads "DM as <character>". */
  actingAs?: string;
}

/** What someone who may not see a roll gets instead (§18.3): who rolled, and dice with "?" faces. */
export interface MaskedRoll {
  id: string;
  userId: string;
  name: string;
  color: string;
  skin: DiceSkin;
  masked: true;
  /** "Mira rolled privately", "The DM rolls…", "Mira rolled for the DM", "Mira rolled for themselves". */
  text: string;
  /** Rolled by a DM: the card reads "The DM" with the seal, not the host's name. */
  byDm: boolean;
  /** The roll's label, only on the roller's own masked view (a player's blind roll): to anyone else it's information. */
  label?: string;
  seed: number;
  tumble: { kind: TumbleDie["kind"]; percentile?: TumbleDie["percentile"] }[];
  manual: boolean;
  at: number;
}

export interface DiceSkin {
  body: string;
  material: "resin" | "gemstone" | "metal" | "bone" | "obsidian";
  number: string;
}

export const DEFAULT_SKIN: DiceSkin = { body: "#2B3A55", material: "resin", number: "#F2E6C9" };

export interface Roller {
  userId: string;
  name: string;
  color: string;
  skin: DiceSkin;
  dm: boolean;
  /** A DM acting as a character: its name (the roll is the character's). */
  actingAs?: string;
}

/** The rows of §18.3: what a viewer gets of a roll. */
export function viewOfRoll(
  r: RollRecord,
  viewer: { userId: string; dm: boolean },
  rollerIsDm: boolean,
): RollRecord | MaskedRoll | null {
  const own = viewer.userId === r.userId;
  const mask = (text: string): MaskedRoll => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    color: r.color,
    skin: r.skin,
    masked: true,
    text,
    byDm: rollerIsDm,
    ...(own && r.label !== undefined ? { label: r.label } : {}),
    seed: r.seed,
    tumble: r.tumble.map((d) => ({ kind: d.kind, ...(d.percentile ? { percentile: d.percentile } : {}) })),
    manual: r.manual,
    at: r.at,
  });
  switch (r.visibility) {
    case "public":
      return r;
    case "dm":
      if (own || viewer.dm) return r;
      return mask(rollerIsDm ? "The DM rolls…" : `${r.name} rolled privately`);
    case "blind":
      if (viewer.dm) return r;
      if (own) return mask(`${r.name} rolled for the DM`);
      return mask(rollerIsDm ? "The DM rolls…" : `${r.name} rolled for the DM`);
    case "self":
      if (own) return r;
      if (viewer.dm) return mask(`${r.name} rolled for themselves`);
      return null;
  }
}

/** The dice a roll throws: every kept and dropped die of each term, d100s as their pair of d10s. */
export function tumbleOf(terms: RollTerm[]): TumbleDie[] {
  const out: TumbleDie[] = [];
  for (const t of terms) {
    if (t.kind !== "dice") continue;
    for (const d of t.dice) {
      if (t.sides === 100) {
        const v = d.value % 100;
        out.push({ kind: "d10", face: v - (v % 10), percentile: "tens", kept: d.kept });
        out.push({ kind: "d10", face: v % 10, percentile: "units", kept: d.kept });
      } else if ([4, 6, 8, 10, 12, 20].includes(t.sides)) {
        out.push({
          kind: `d${t.sides}` as TumbleDie["kind"],
          face: t.sides === 10 ? d.value % 10 : d.value,
          kept: d.kept,
        });
      }
    }
  }
  return out;
}
