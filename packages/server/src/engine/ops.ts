/**
 * Operations (SPEC §14.3): the unit of change the command bus persists, broadcasts, and inverts for undo.
 */
export type EntityKind =
  | "campaign"
  | "scene"
  | "wall"
  | "light"
  | "zone"
  | "token"
  | "actor"
  | "effect"
  | "combat"
  | "handout"
  | "template"
  | "content";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface JsonPatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

export type Op =
  | { k: "set"; e: EntityKind; id: string; path: string[]; value: unknown; prev: unknown }
  | { k: "create"; e: EntityKind; id: string; value: unknown }
  | { k: "delete"; e: EntityKind; id: string; prev: unknown }
  | { k: "fog"; sceneId: string; layer: string; rect: Rect; before: string; after: string }
  | { k: "sheet"; actorId: string; patch: JsonPatchOp[]; inverse: JsonPatchOp[] };

/** `inverse(ops)` = reversed list with set.value↔prev, create↔delete, fog after↔before, sheet patch↔inverse. */
export function inverse(ops: Op[]): Op[] {
  return [...ops].reverse().map((op): Op => {
    switch (op.k) {
      case "set":
        return { ...op, value: op.prev, prev: op.value };
      case "create":
        return { k: "delete", e: op.e, id: op.id, prev: op.value };
      case "delete":
        return { k: "create", e: op.e, id: op.id, value: op.prev };
      case "fog":
        return { ...op, before: op.after, after: op.before };
      case "sheet":
        return { ...op, patch: op.inverse, inverse: op.patch };
      default:
        throw new Error(`unknown op ${(op as { k: string }).k}`);
    }
  });
}

/** Structured-clone for plain JSON documents. */
export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Returns a copy of `obj` with `path` set to `value` (undefined deletes the key). */
export function setPath<T>(obj: T, path: string[], value: unknown): T {
  if (path.length === 0) return clone(value) as T;
  const root = clone(obj) as Record<string, unknown>;
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as string;
    const next = cur[k];
    if (next === null || typeof next !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = path[path.length - 1] as string;
  if (value === undefined) delete cur[last];
  else cur[last] = clone(value);
  return root as T;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keys an op touches, for undo conflict detection (SPEC §14.4). */
export function touchedKeys(ops: Op[]): string[] {
  const keys: string[] = [];
  for (const op of ops) {
    switch (op.k) {
      case "set":
        keys.push(`${op.e}:${op.id}:${op.path.join(".")}`);
        break;
      case "create":
      case "delete":
        keys.push(`${op.e}:${op.id}:`);
        break;
      case "fog":
        keys.push(`fog|${op.sceneId}|${op.layer}|${op.rect.x},${op.rect.y},${op.rect.w},${op.rect.h}`);
        break;
      case "sheet":
        for (const p of op.patch) keys.push(`actor:${op.actorId}:sheet${p.path.replaceAll("/", ".")}`);
        break;
    }
  }
  return keys;
}

function rectOverlap(a: string, b: string): boolean {
  const [ax, ay, aw, ah] = a.split(",").map(Number) as [number, number, number, number];
  const [bx, by, bw, bh] = b.split(",").map(Number) as [number, number, number, number];
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** Two keys overlap when they address the same entity and one path is a prefix of the other. */
export function keysOverlap(a: string, b: string): boolean {
  // Fog keys use "|" because layer names contain ":" (reveal:all, explored:<userId>).
  if (a.startsWith("fog|") || b.startsWith("fog|")) {
    if (!a.startsWith("fog|") || !b.startsWith("fog|")) return false;
    const pa = a.split("|");
    const pb = b.split("|");
    return pa[1] === pb[1] && pa[2] === pb[2] && rectOverlap(pa[3] ?? "", pb[3] ?? "");
  }
  const [ea, ia, ...ra] = a.split(":");
  const [eb, ib, ...rb] = b.split(":");
  if (ea !== eb || ia !== ib) return false;
  const pa = ra.join(":");
  const pb = rb.join(":");
  if (pa === "" || pb === "") return true;
  return pa === pb || pa.startsWith(`${pb}.`) || pb.startsWith(`${pa}.`);
}
