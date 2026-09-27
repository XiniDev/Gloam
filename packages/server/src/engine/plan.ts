import { GloamError } from "@gloam/shared/protocol";
import { isDm } from "@gloam/shared/rules";
import type { EntityMap } from "./codecs.ts";
import type { CommandCtx } from "./commandBus.ts";
import { clone, type EntityKind, jsonEqual, type Op } from "./ops.ts";

/** Set ops for each top-level field of `patch` that differs from the entity (deep compare). */
export function setOps<K extends EntityKind>(
  kind: K,
  entity: EntityMap[K],
  patch: Partial<EntityMap[K]>,
): Op[] {
  const ops: Op[] = [];
  const e = entity as unknown as Record<string, unknown>;
  const id = e.id as string;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === "id") continue;
    if (!jsonEqual(e[k], v))
      ops.push({ k: "set", e: kind, id, path: [k], value: clone(v), prev: clone(e[k]) });
  }
  return ops;
}

/** One nested field set (e.g. ["appearance","mode"]). */
export function setPathOp<K extends EntityKind>(
  kind: K,
  entity: EntityMap[K],
  path: string[],
  value: unknown,
): Op | null {
  let cur: unknown = entity;
  for (const p of path)
    cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
  if (jsonEqual(cur, value)) return null;
  return {
    k: "set",
    e: kind,
    id: (entity as unknown as { id: string }).id,
    path,
    value: clone(value),
    prev: clone(cur),
  };
}

export function createOp<K extends EntityKind>(kind: K, entity: EntityMap[K]): Op {
  return { k: "create", e: kind, id: (entity as unknown as { id: string }).id, value: clone(entity) };
}

export function deleteOp<K extends EntityKind>(kind: K, entity: EntityMap[K]): Op {
  return { k: "delete", e: kind, id: (entity as unknown as { id: string }).id, prev: clone(entity) };
}

export function requireDm(ctx: CommandCtx): void {
  if (!isDm(ctx.actor.role)) throw new GloamError("FORBIDDEN", "Only the DM can do that.");
}

export function mustGet<K extends EntityKind>(ctx: CommandCtx, kind: K, id: string): EntityMap[K] {
  const e = ctx.model.get(kind, id);
  if (!e) throw new GloamError("NOT_FOUND", `That ${kind} no longer exists.`);
  return e;
}
