/**
 * Parses the four header fields of an SRD 5.2.1 spell ("Casting Time", "Range", "Components", "Duration")
 * into the normalised record's structures. Every accepted form is listed explicitly; anything else throws,
 * so a new phrasing in the PDF can't silently turn into wrong data.
 */
import type { SpellInput } from "@gloam/shared/schemas";

type CastingTime = SpellInput["castingTime"];
type Range = SpellInput["range"];
type Components = SpellInput["components"];
type Duration = SpellInput["duration"];

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };
const num = (s: string): number => NUMBER_WORDS[s.toLowerCase()] ?? Number(s.replace(/,/g, ""));

export function parseCastingTime(raw: string): { castingTime: CastingTime; ritual: boolean } {
  let text = raw.trim();
  let ritual = false;
  if (/ or Ritual$/.test(text)) {
    ritual = true;
    text = text.replace(/ or Ritual$/, "");
  }
  if (text === "Action") return { castingTime: { amount: 1, unit: "action" }, ritual };
  if (text === "Bonus Action") return { castingTime: { amount: 1, unit: "bonus" }, ritual };
  // "Reaction, which you take when …" and the smites' "Bonus Action, which you take immediately after …":
  // the trigger is kept in `reactionTrigger` (the schema's only trigger field) so it isn't lost.
  const triggered = /^(Reaction|Bonus Action), which you take (.+)$/.exec(text);
  if (triggered) {
    const unit = triggered[1] === "Reaction" ? "reaction" : "bonus";
    return { castingTime: { amount: 1, unit, reactionTrigger: triggered[2]!.trim() }, ritual };
  }
  const timed = /^(\d+) (minute|hour)s?$/.exec(text);
  if (timed) {
    return { castingTime: { amount: Number(timed[1]), unit: timed[2] as "minute" | "hour" }, ritual };
  }
  // Plant Growth: "Action (Overgrowth) or 8 hours (Enrichment)" — two options; the first is structured and
  // the printed text is kept because the body doesn't repeat the 8 hours.
  const options = /^Action \(([^)]+)\) or (\d+) (minute|hour)s? \(([^)]+)\)$/.exec(text);
  if (options) return { castingTime: { amount: 1, unit: "action", text }, ritual };
  throw new Error(`Unrecognised casting time "${raw}"`);
}

export function parseRange(raw: string): Range {
  const text = raw.trim();
  if (text === "Self") return { kind: "self" };
  if (text === "Touch") return { kind: "touch" };
  if (text === "Sight") return { kind: "sight" };
  if (text === "Unlimited") return { kind: "unlimited" };
  if (text === "Special") return { kind: "special" };
  const feet = /^([\d,]+) feet$/.exec(text);
  if (feet) return { kind: "ranged", ft: num(feet[1]!) };
  const miles = /^([\d,]+) miles?$/.exec(text);
  if (miles) {
    const ft = num(miles[1]!) * 5280;
    // The shared Ft type is bounded at 100,000 ft; Project Image's 500 miles keeps its printed text instead.
    return ft <= 100_000 ? { kind: "ranged", ft } : { kind: "ranged", text };
  }
  throw new Error(`Unrecognised range "${raw}"`);
}

export function parseComponents(raw: string): Components {
  const text = raw.trim();
  const open = text.indexOf("(");
  const letters = (open >= 0 ? text.slice(0, open) : text).split(",").map((s) => s.trim());
  for (const l of letters) {
    if (!["V", "S", "M"].includes(l)) throw new Error(`Unrecognised components "${raw}"`);
  }
  const out: Components = { v: letters.includes("V"), s: letters.includes("S"), m: letters.includes("M") };
  if (open >= 0) {
    if (!out.m || !text.endsWith(")")) throw new Error(`Unrecognised material component "${raw}"`);
    const material = text.slice(open + 1, -1).trim();
    out.material = material;
    const cost = /worth ([\d,]+)\+? GP/.exec(material);
    if (cost) out.costGp = num(cost[1]!);
    if (/\bconsumes\b/.test(material)) out.consumed = true;
  } else if (out.m) {
    throw new Error(`Material component without a description "${raw}"`);
  }
  return out;
}

export function parseDuration(raw: string): Duration {
  const text = raw.trim();
  if (text === "Instantaneous") return { kind: "instantaneous", concentration: false };
  if (text === "Until dispelled") return { kind: "until-dispelled", concentration: false };
  if (text === "Until dispelled or triggered") return { kind: "until-dispelled", concentration: false, text };
  if (text === "Special") return { kind: "special", concentration: false };
  // "Concentration up to 10 minutes" (no comma) is printed once (Protection from Evil and Good, p. 157).
  const m = /^(Concentration,? up to |Up to )?(\d+) (round|minute|hour|day)s?$/.exec(text);
  if (m) {
    const concentration = m[1]?.startsWith("Concentration") ?? false;
    const out: Duration = {
      kind: "timed",
      amount: Number(m[2]),
      unit: m[3] as "round" | "minute" | "hour" | "day",
      concentration,
    };
    // A non-concentration "Up to 1 hour" (Prestidigitation, Thaumaturgy, Etherealness) is a maximum.
    if (m[1] === "Up to ") out.text = text;
    return out;
  }
  throw new Error(`Unrecognised duration "${raw}"`);
}
