/**
 * Sheet changes as JSON Patch (RFC 6902; SPEC §14.3 `sheet` ops): each change set is a patch and its inverse, so a
 * sheet edit undoes path by path and two edits to different fields of one sheet never conflict. `applyPatch` is the
 * one applier — the server's command bus and the clients' sheet mirrors both use it.
 */

import { assertSafeKey } from "../safeKeys.ts";
import type { SheetChange } from "./sheetLocks.ts";

export interface JsonPatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

/** A JSON Pointer (RFC 6901) for a path of keys and indices. */
export function pointer(path: readonly (string | number)[]): string {
  return path.map((p) => `/${String(p).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/** A JSON Pointer's reference tokens. */
export function tokens(ptr: string): string[] {
  if (ptr === "") return [];
  if (!ptr.startsWith("/")) throw new Error(`not a JSON pointer: ${ptr}`);
  return ptr
    .slice(1)
    .split("/")
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** The patch that makes each change (and the one that takes them back, in reverse). */
export function patchOf(changes: readonly SheetChange[]): { patch: JsonPatchOp[]; inverse: JsonPatchOp[] } {
  const patch: JsonPatchOp[] = [];
  const inverse: JsonPatchOp[] = [];
  for (const c of changes) {
    const path = pointer(c.path);
    if (c.before === undefined) {
      patch.push({ op: "add", path, value: clone(c.after) });
      inverse.unshift({ op: "remove", path });
    } else if (c.after === undefined) {
      patch.push({ op: "remove", path });
      inverse.unshift({ op: "add", path, value: clone(c.before) });
    } else {
      patch.push({ op: "replace", path, value: clone(c.after) });
      inverse.unshift({ op: "replace", path, value: clone(c.before) });
    }
  }
  return { patch, inverse };
}

const isIndex = (t: string) => /^(0|[1-9]\d*)$/.test(t);

/**
 * Applies a patch to a copy of `doc` (RFC 6902 add / remove / replace; "-" appends to an array). Throws if a path's
 * parent doesn't exist or an index is out of range — a patch made against another version of the document.
 */
export function applyPatch<T>(doc: T, patch: readonly JsonPatchOp[]): T {
  let root = clone(doc) as unknown;
  for (const p of patch) {
    const ts = tokens(p.path);
    // (Own properties only, and never a key that reaches Object.prototype: safeKeys.ts.)
    for (const t of ts) assertSafeKey(t);
    if (ts.length === 0) {
      if (p.op === "remove") throw new Error("can't remove the whole document");
      root = clone(p.value);
      continue;
    }
    let parent = root;
    for (const t of ts.slice(0, -1)) {
      if (Array.isArray(parent)) {
        if (!isIndex(t) || Number(t) >= parent.length) throw new Error(`no ${p.path}`);
        parent = parent[Number(t)];
      } else if (parent !== null && typeof parent === "object" && Object.hasOwn(parent, t)) {
        parent = (parent as Record<string, unknown>)[t];
      } else throw new Error(`no ${p.path}`);
    }
    const last = ts[ts.length - 1] as string;
    if (Array.isArray(parent)) {
      const n = parent.length;
      if (p.op === "add") {
        const i = last === "-" ? n : Number(last);
        if (!(last === "-" || isIndex(last)) || i > n) throw new Error(`no ${p.path}`);
        parent.splice(i, 0, clone(p.value));
      } else {
        if (!isIndex(last) || Number(last) >= n) throw new Error(`no ${p.path}`);
        if (p.op === "remove") parent.splice(Number(last), 1);
        else parent[Number(last)] = clone(p.value);
      }
    } else if (parent !== null && typeof parent === "object") {
      const o = parent as Record<string, unknown>;
      if (p.op !== "add" && !Object.hasOwn(o, last)) throw new Error(`no ${p.path}`);
      if (p.op === "remove") delete o[last];
      else o[last] = clone(p.value);
    } else throw new Error(`no ${p.path}`);
  }
  return root as T;
}
