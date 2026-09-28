/**
 * Sheet locks and proposals (SPEC §8.10 Ownership and locks): what a player may change on their own sheet at each
 * lock level, found by diffing the sheet before and after — **Unlocked**: anything; **Core locked**: only the
 * play-state of a session (current and temp HP, slots, uses and hit dice used, death saves, conditions and
 * exhaustion, inspiration and concentration, which spells are prepared, inventory quantities, currency, notes, custom
 * counters' values); **Fully locked**: nothing. DMs are never locked. A player's change to a locked field becomes a
 * proposal: the DM sees the diff and approves or denies it.
 */

export type LockLevel = "unlocked" | "core" | "full";

/** One changed value: its path (object keys and array indices) and before/after (undefined: absent). */
export interface SheetChange {
  path: (string | number)[];
  before: unknown;
  after: unknown;
}

/** Every leaf that differs between two JSON values; an array whose length changed counts as one change (the whole). */
export function diffSheet(before: unknown, after: unknown, path: (string | number)[] = []): SheetChange[] {
  if (Object.is(before, after)) return [];
  const bothObj =
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after);
  if (!bothObj) return [{ path, before, after }];
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [{ path, before, after }];
    return before.flatMap((b, i) => diffSheet(b, after[i], [...path, i]));
  }
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys].flatMap((k) => diffSheet(b[k], a[k], [...path, k]));
}

/** Paths a player may change under "core locked" (`*` matches any array index; a prefix covers everything below). */
const PLAY_STATE: (string | number)[][] = [
  ["core", "hp", "current"],
  ["core", "hp", "temp"],
  ["core", "spellcasting", "slots", "*", "used"],
  ["core", "spellcasting", "pact", "used"],
  ["core", "spellcasting", "spells", "*", "prepared"],
  ["core", "features", "*", "uses", "used"],
  ["core", "hitDice", "*", "used"],
  ["core", "deathSaves"],
  ["core", "conditions"],
  ["core", "exhaustion"],
  ["core", "inspiration"],
  ["core", "concentration"],
  ["core", "inventory", "*", "qty"],
  ["core", "currency"],
  ["core", "notes"],
];

function matches(pattern: (string | number)[], path: (string | number)[]): boolean {
  if (path.length < pattern.length) return false;
  return pattern.every((p, i) => (p === "*" ? typeof path[i] === "number" : p === path[i]));
}

/** A custom counter's value (only the value: its title, max and pin are the sheet's shape). */
function isCounterValue(change: SheetChange, before: unknown): boolean {
  const [a, i, k] = change.path;
  if (a !== "custom" || typeof i !== "number" || k !== "value" || change.path.length !== 3) return false;
  const block = (before as { custom?: { type?: string }[] })?.custom?.[i];
  return block?.type === "counter";
}

/**
 * The changes a player isn't allowed to make at a lock level (empty: the edit may go through as it is). DMs pass
 * `dm: true` and are never refused.
 */
export function lockedChanges(level: LockLevel, before: unknown, after: unknown, dm: boolean): SheetChange[] {
  const changes = diffSheet(before, after);
  if (dm || level === "unlocked") return [];
  if (level === "full") return changes;
  return changes.filter((c) => !PLAY_STATE.some((p) => matches(p, c.path)) && !isCounterValue(c, before));
}

/** A readable path: core.abilities.str, core.inventory[2].qty. */
export function pathLabel(path: (string | number)[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("");
}

/** Sheets are plain JSON. */
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Applies a set of changes (a proposal's) onto a sheet as it is now: only those paths change. */
export function applyChanges<T>(sheet: T, changes: SheetChange[]): T {
  const out = clone(sheet) as Record<string | number, unknown>;
  for (const c of changes) {
    if (c.path.length === 0) return clone(c.after) as T;
    let o: Record<string | number, unknown> = out;
    for (let i = 0; i < c.path.length - 1; i++) {
      const k = c.path[i] as string | number;
      const next = o[k];
      if (next === null || typeof next !== "object") {
        o[k] = typeof c.path[i + 1] === "number" ? [] : {};
      }
      o = o[k] as Record<string | number, unknown>;
    }
    const last = c.path[c.path.length - 1] as string | number;
    if (c.after === undefined) delete o[last];
    else o[last] = clone(c.after);
  }
  return out as T;
}
