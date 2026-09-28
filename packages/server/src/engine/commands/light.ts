import { LIGHT_PRESETS, type LightPreset } from "@gloam/shared";
import {
  GloamError,
  LightCarry,
  LightCreate,
  LightDelete,
  LightToggle,
  LightUpdate,
} from "@gloam/shared/protocol";
import { controlsToken, isDm } from "@gloam/shared/rules";
import type { LightEntity, TokenEntity } from "@gloam/shared/schemas";
import type { z } from "zod";
import { newId } from "../../ids.ts";
import type { CommandCtx, CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps } from "../plan.ts";

/** Light commands (SPEC §8.8 Light): the DM places and edits lights; a token's owners light, douse and hood theirs. */

function preset(id: string | undefined | null): LightPreset | undefined {
  if (!id) return undefined;
  const p = LIGHT_PRESETS.find((l) => l.id === id);
  if (!p) throw new GloamError("INVALID", "That light source isn't known.");
  return p;
}

function newLight(sceneId: string, carrier: TokenEntity | null, p: z.infer<typeof LightCreate>): LightEntity {
  const pre = preset(p.preset);
  return {
    id: newId("lgt"),
    sceneId,
    tokenId: carrier?.id ?? null,
    pos: carrier ? { ...carrier.pos } : { x: p.pos?.x ?? 0, y: p.pos?.y ?? 0 },
    elevation: p.elevation ?? 0,
    bright: p.bright ?? pre?.bright ?? 20,
    dim: p.dim ?? pre?.dim ?? 20,
    color: p.color ?? pre?.color ?? LIGHT_PRESETS[1].color,
    intensity: p.intensity ?? 1,
    animation: p.animation ?? pre?.animation ?? "none",
    coneDeg: p.coneDeg !== undefined ? p.coneDeg : (pre?.coneDeg ?? null),
    directionDeg: p.directionDeg ?? 0,
    magical: p.magical ?? false,
    pierceDarkness: p.pierceDarkness ?? false,
    enabled: p.enabled ?? true,
    dmOnly: p.dmOnly ?? false,
    preset: pre?.id ?? null,
    shuttered: false,
  };
}

const nameOf = (l: LightEntity) =>
  LIGHT_PRESETS.find((p) => p.id === l.preset)?.name.toLowerCase() ?? "light";

export const lightCreate: CommandDef<z.infer<typeof LightCreate>, { lightId: string }> = {
  type: "light.create",
  schema: LightCreate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    mustGet(ctx, "scene", p.sceneId);
    const carrier = p.tokenId ? mustGet(ctx, "token", p.tokenId) : null;
    if (carrier && carrier.sceneId !== p.sceneId)
      throw new GloamError("INVALID", "That token is in another scene.");
    if (carrier?.lightId) throw new GloamError("INVALID", `${carrier.name} already carries a light.`);
    if (!carrier && !p.pos) throw new GloamError("INVALID", "A light needs a place or a token to carry it.");
    const l = newLight(p.sceneId, carrier, p);
    const ops: Op[] = [createOp("light", l)];
    if (carrier) ops.push(...setOps("token", carrier, { lightId: l.id }));
    return {
      ops,
      summary: carrier ? `Gave ${carrier.name} a ${nameOf(l)}` : `Placed a ${nameOf(l)}`,
      sceneId: p.sceneId,
      result: { lightId: l.id },
    };
  },
};

export const lightUpdate: CommandDef<z.infer<typeof LightUpdate>> = {
  type: "light.update",
  schema: LightUpdate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const l = mustGet(ctx, "light", p.lightId);
    const { lightId: _id, preset: presetId, ...rest } = p;
    const patch = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    ) as Partial<LightEntity>;
    if (presetId !== undefined) {
      const pre = preset(presetId);
      patch.preset = pre?.id ?? null;
      if (pre) {
        patch.bright ??= pre.bright;
        patch.dim ??= pre.dim;
        if (p.coneDeg === undefined) patch.coneDeg = pre.coneDeg;
        patch.animation ??= pre.animation;
        patch.color ??= pre.color;
      }
    }
    if (p.pos && l.tokenId) throw new GloamError("INVALID", "A carried light goes where its token goes.");
    return { ops: setOps("light", l, patch), summary: `Edited a ${nameOf(l)}`, sceneId: l.sceneId };
  },
};

export const lightDelete: CommandDef<z.infer<typeof LightDelete>> = {
  type: "light.delete",
  schema: LightDelete,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const ops: Op[] = [];
    let sceneId: string | null = null;
    for (const id of p.lightIds) {
      const l = ctx.model.get("light", id);
      if (!l) continue;
      sceneId = l.sceneId;
      const carrier = l.tokenId ? ctx.model.get("token", l.tokenId) : undefined;
      if (carrier?.lightId === l.id) ops.push(...setOps("token", carrier, { lightId: null }));
      ops.push(deleteOp("light", l));
    }
    const n = p.lightIds.length;
    return { ops, summary: `Removed ${n} light${n === 1 ? "" : "s"}`, sceneId };
  },
};

/** The DM, or the owners of the token carrying the light while the DM hasn't locked it. */
function mayHandle(ctx: CommandCtx, l: LightEntity): void {
  if (isDm(ctx.actor.role)) return;
  const carrier = l.tokenId ? ctx.model.get("token", l.tokenId) : undefined;
  if (!carrier) throw new GloamError("FORBIDDEN");
  mayCarry(ctx, carrier);
}

/** A token's owners handle its light like its other controls: not while the DM has locked it (as moving, raising
 * and turning it). */
function mayCarry(ctx: CommandCtx, t: TokenEntity): void {
  if (isDm(ctx.actor.role)) return;
  if (!controlsToken(ctx.actor.role, ctx.actor.userId, t)) throw new GloamError("FORBIDDEN");
  if (t.locked) throw new GloamError("FORBIDDEN", "The DM locked this token.");
}

export const lightToggle: CommandDef<z.infer<typeof LightToggle>> = {
  type: "light.toggle",
  schema: LightToggle,
  undoable: true,
  authorize(ctx, p) {
    mayHandle(ctx, mustGet(ctx, "light", p.lightId));
  },
  plan(ctx, p) {
    const l = mustGet(ctx, "light", p.lightId);
    const patch: Partial<LightEntity> = {};
    if (p.enabled !== undefined) patch.enabled = p.enabled;
    else if (p.shuttered === undefined) patch.enabled = !l.enabled;
    if (p.shuttered !== undefined) {
      if (l.preset !== "hooded-lantern") throw new GloamError("INVALID", "Only a hooded lantern has a hood.");
      patch.shuttered = p.shuttered;
    }
    const what =
      patch.shuttered !== undefined
        ? patch.shuttered
          ? "Lowered the hood of"
          : "Raised the hood of"
        : patch.enabled
          ? "Lit"
          : "Put out";
    return { ops: setOps("light", l, patch), summary: `${what} a ${nameOf(l)}`, sceneId: l.sceneId };
  },
};

export const lightCarry: CommandDef<z.infer<typeof LightCarry>, { lightId: string | null }> = {
  type: "light.carry",
  schema: LightCarry,
  undoable: true,
  authorize(ctx, p) {
    mayCarry(ctx, mustGet(ctx, "token", p.tokenId));
  },
  plan(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    const cur = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
    const ops: Op[] = [];
    if (p.preset === null) {
      if (!cur)
        return { ops, summary: `${t.name} carries no light`, sceneId: t.sceneId, result: { lightId: null } };
      ops.push(...setOps("token", t, { lightId: null }), deleteOp("light", cur));
      return {
        ops,
        summary: `${t.name} put away the ${nameOf(cur)}`,
        sceneId: t.sceneId,
        result: { lightId: null },
      };
    }
    const pre = preset(p.preset) as LightPreset;
    if (cur) {
      ops.push(
        ...setOps("light", cur, {
          preset: pre.id,
          bright: pre.bright,
          dim: pre.dim,
          coneDeg: pre.coneDeg,
          animation: pre.animation,
          color: pre.color,
          enabled: true,
          shuttered: false,
        }),
      );
      return {
        ops,
        summary: `${t.name} took up a ${pre.name.toLowerCase()}`,
        sceneId: t.sceneId,
        result: { lightId: cur.id },
      };
    }
    const l = newLight(t.sceneId, t, { sceneId: t.sceneId, preset: pre.id });
    ops.push(createOp("light", l), ...setOps("token", t, { lightId: l.id }));
    return {
      ops,
      summary: `${t.name} lit a ${pre.name.toLowerCase()}`,
      sceneId: t.sceneId,
      result: { lightId: l.id },
    };
  },
};

export const LIGHT_COMMANDS = [lightCreate, lightUpdate, lightDelete, lightToggle, lightCarry] as CommandDef<
  never,
  unknown
>[];
