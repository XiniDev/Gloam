/**
 * Short and long rests (SPEC §8.11 Rests, §34.2; SRD 5.2.1 pp. 185, 187 — docs/research/rules-5.2.1.md): what each
 * gives a character, as items the DM previews and may untick before applying (AC-HP-13), and applying the kept ones.
 * A creature needs at least 1 HP to rest. Short: features that recharge on a short rest, Pact Magic slots, and Hit Dice
 * to spend (its player's cards: each die + Con modifier, at least 1 HP a die). Long: all HP, spent Hit Dice (SRD 5.1:
 * up to half the total, at least one), spell and pact slots, features that recharge on a short or long rest,
 * Exhaustion −1, temporary HP gone, death saves cleared. Pure.
 */
import type { TokenStatusT } from "../schemas/entities.ts";
import type { Sheet } from "../schemas/sheet.ts";

export type RestKind = "short" | "long";
export type RulesPack = "srd-5.2.1" | "srd-5.1" | string;

export interface RestItem {
  /** What it restores (the key the DM keeps it by). */
  key:
    | "hp"
    | "hitDice"
    | "hitDiceCards"
    | "slots"
    | "pact"
    | "features"
    | "exhaustion"
    | "tempHp"
    | "deathSaves";
  /** In words, with the numbers ("HP 12 → 28"). */
  label: string;
}

export interface RestPlan {
  /** Why it can't rest (at 0 HP), when it can't. */
  blocked?: string;
  items: RestItem[];
}

const rechargesOn = (recharge: string, kind: RestKind) =>
  recharge === "short" || (kind === "long" && recharge === "long");

/** Hit Dice a long rest gives back, per die: all spent (5.2.1); up to half the total, at least one (5.1). */
function hitDiceBack(sheet: Sheet, pack: RulesPack): { die: string; back: number }[] {
  const dice = sheet.core.hitDice;
  const total = dice.reduce((n, d) => n + d.total, 0);
  let budget = pack === "srd-5.1" ? Math.max(1, Math.floor(total / 2)) : Number.POSITIVE_INFINITY;
  const out: { die: string; back: number }[] = [];
  // Largest dice first (the player would rather have those back).
  for (const d of [...dice].sort((a, b) => Number(b.die.slice(1)) - Number(a.die.slice(1)))) {
    const back = Math.min(d.used, budget);
    if (back > 0) out.push({ die: d.die, back });
    budget -= back;
  }
  return out;
}

/** What a rest would give this character now. */
export function restPlan(sheet: Sheet, status: TokenStatusT, kind: RestKind, pack: RulesPack): RestPlan {
  const c = sheet.core;
  if (c.hp.current < 1) return { blocked: "At 0 HP — it needs at least 1 HP to rest", items: [] };
  const items: RestItem[] = [];
  const features = c.features.filter((f) => f.uses && f.uses.used > 0 && rechargesOn(f.uses.recharge, kind));
  if (kind === "long") {
    if (c.hp.current < c.hp.max) items.push({ key: "hp", label: `HP ${c.hp.current} → ${c.hp.max}` });
    const back = hitDiceBack(sheet, pack);
    if (back.length)
      items.push({
        key: "hitDice",
        label: `Hit Dice back: ${back.map((b) => `${b.back} ${b.die}`).join(", ")}`,
      });
    const slots = (c.spellcasting?.slots ?? []).reduce((n, s) => n + s.used, 0);
    if (slots) items.push({ key: "slots", label: `Spell slots back: ${slots}` });
  } else {
    const left = c.hitDice.reduce((n, d) => n + Math.max(0, d.total - d.used), 0);
    if (left && c.hp.current < c.hp.max)
      items.push({ key: "hitDiceCards", label: `Hit Dice to spend: ${left} (on the player's cards)` });
  }
  const pact = c.spellcasting?.pact;
  if (pact?.used) items.push({ key: "pact", label: `Pact slots back: ${pact.used}` });
  if (features.length)
    items.push({ key: "features", label: `Uses back: ${features.map((f) => f.name).join(", ")}` });
  if (kind === "long") {
    if (status.exhaustion > 0)
      items.push({ key: "exhaustion", label: `Exhaustion ${status.exhaustion} → ${status.exhaustion - 1}` });
    if (c.hp.temp > 0) items.push({ key: "tempHp", label: `Temporary HP ${c.hp.temp} → 0` });
    if (status.deathSaves) items.push({ key: "deathSaves", label: "Death saves cleared" });
  }
  return { items };
}

/** A character after the rest items kept (the sheet as read, and its status). */
export function applyRest(
  sheet: Sheet,
  status: TokenStatusT,
  kind: RestKind,
  pack: RulesPack,
  keep: readonly string[],
): { sheet: Sheet; status: TokenStatusT } {
  const plan = restPlan(sheet, status, kind, pack);
  const on = new Set(plan.items.map((i) => i.key).filter((k) => keep.includes(k)));
  const core = { ...sheet.core };
  let next: TokenStatusT = status;
  if (on.has("hp")) core.hp = { ...core.hp, current: core.hp.max };
  if (on.has("tempHp")) core.hp = { ...core.hp, temp: 0 };
  if (on.has("hitDice")) {
    const back = new Map(hitDiceBack(sheet, pack).map((b) => [b.die, b.back]));
    core.hitDice = core.hitDice.map((d) => ({ ...d, used: Math.max(0, d.used - (back.get(d.die) ?? 0)) }));
  }
  if (core.spellcasting && (on.has("slots") || on.has("pact"))) {
    const sc = { ...core.spellcasting };
    if (on.has("slots")) sc.slots = sc.slots.map((s) => ({ ...s, used: 0 }));
    if (on.has("pact") && sc.pact) sc.pact = { ...sc.pact, used: 0 };
    core.spellcasting = sc;
  }
  if (on.has("features"))
    core.features = core.features.map((f) =>
      f.uses && rechargesOn(f.uses.recharge, kind) ? { ...f, uses: { ...f.uses, used: 0 } } : f,
    );
  if (on.has("exhaustion"))
    next = { ...next, exhaustion: Math.max(0, next.exhaustion - 1) as TokenStatusT["exhaustion"] };
  if (on.has("deathSaves")) {
    next = { ...next, markers: next.markers.filter((m) => m.id !== "deathsaves" && m.id !== "stable") };
    delete next.deathSaves;
  }
  return { sheet: { ...sheet, core }, status: next };
}

/** The die a character spends next on a short rest (the largest with some left), or null. */
export function nextHitDie(sheet: Sheet): { die: string; left: number } | null {
  if (sheet.core.hp.current >= sheet.core.hp.max) return null;
  const d = [...sheet.core.hitDice]
    .filter((x) => x.total - x.used > 0)
    .sort((a, b) => Number(b.die.slice(1)) - Number(a.die.slice(1)))[0];
  return d ? { die: d.die, left: d.total - d.used } : null;
}

/** HP a spent Hit Die restores: its roll with the Con modifier — at least 1 (SRD 5.2.1 p. 187). */
export const hitDieHealing = (total: number) => Math.max(1, Math.trunc(total));
