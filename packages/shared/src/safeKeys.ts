/**
 * Keys a path into a document may never name (SPEC §22). Walking or assigning `__proto__`, `constructor` or
 * `prototype` on a plain object reaches the shared `Object.prototype`: one sheet edit could then give every object on
 * the server a property — every token's sight shared with the editor, movement limits lifted (security review H1).
 * Paths from clients are refused with these by their schemas; the walkers refuse them again and only ever step through
 * an object's own properties, whatever reaches them.
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** A key a path may name: any list index, any property name but the three above. */
export function isSafeKey(k: string | number): boolean {
  return typeof k === "number" || !FORBIDDEN_KEYS.has(k);
}

/** Throws on a key no path may name. */
export function assertSafeKey(k: string | number): void {
  if (!isSafeKey(k)) throw new Error(`"${String(k)}" can't be part of a path`);
}

/** An object's own property (never one it inherits), or undefined. */
export function ownGet(o: object, k: string | number): unknown {
  return Object.hasOwn(o, k) ? (o as Record<string | number, unknown>)[k] : undefined;
}
