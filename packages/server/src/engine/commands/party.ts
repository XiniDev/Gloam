import { LIGHT_PRESETS, SIZE_BASE_FT } from "@gloam/shared";
import { spawnSpots } from "@gloam/shared/movement";
import type { LightEntity, TokenEntity } from "@gloam/shared/schemas";
import { z } from "zod";
import { newId } from "../../ids.ts";
import type { ActorEntity } from "../codecs.ts";
import type { CommandActor, CommandCtx, CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, mustGet } from "../plan.ts";
import { readSheet } from "./actor.ts";

/** Who the server acts as when it places the party (history: "Gloam placed …"). */
export const SYSTEM_ACTOR: CommandActor = { userId: "system", role: "admin", name: "Gloam" };

const PartyPlace = z.strictObject({
  sceneId: z.string().min(1).max(64),
  actorIds: z.array(z.string().min(1).max(64)).max(50),
});

/** A linked token for a character (SPEC §8.5 Linked tokens): its sheet's name, art and size, owned by its player. */
export function characterToken(
  actor: ActorEntity,
  sceneId: string,
  pos: { x: number; y: number },
  now: number,
): TokenEntity {
  const core = readSheet(actor).core;
  return {
    id: newId("tok"),
    sceneId,
    actorId: actor.id,
    link: "linked",
    name: core.name,
    pos,
    elevation: 0,
    rotationDeg: 0,
    sizeFt: SIZE_BASE_FT[core.size],
    appearance: {
      mode: "auto",
      ...(core.tokenAssetId ? { assetId: core.tokenAssetId } : {}),
      ...(core.portraitAssetId ? { portraitAssetId: core.portraitAssetId } : {}),
      scale: 1,
      offsetY: 0,
      rotationOffsetDeg: 0,
    },
    ownerIds: actor.ownerUserId ? [actor.ownerUserId] : [],
    disposition: "party",
    hidden: false,
    revealTo: "vision",
    hpDisplay: "exact",
    stats: null,
    status: null,
    overrides: {},
    lightId: null,
    locked: false,
    dmNote: "",
    moveMode: "walk",
    createdAt: now,
    updatedAt: now,
  };
}

/** The light a character's sheet says it carries, on its new token. */
function carried(actor: ActorEntity, token: TokenEntity): LightEntity | null {
  const pre = LIGHT_PRESETS.find((l) => l.id === readSheet(actor).core.light);
  if (!pre) return null;
  return {
    id: newId("lgt"),
    sceneId: token.sceneId,
    tokenId: token.id,
    pos: { ...token.pos },
    elevation: 0,
    bright: pre.bright,
    dim: pre.dim,
    color: pre.color,
    intensity: 1,
    animation: pre.animation,
    coneDeg: pre.coneDeg,
    directionDeg: 0,
    magical: false,
    pierceDarkness: false,
    enabled: true,
    dmOnly: false,
    preset: pre.id,
    shuttered: false,
  };
}

/**
 * `party.place` (the server's own) — characters without a token on a scene get one round its party spawn point
 * (SPEC §8.3, AC-SCN-06): when their player is admitted, when a scene becomes active, when a character is made for
 * someone at the table. Spiral placement clear of tokens and walls (movement/spawn.ts).
 */
export const partyPlace: CommandDef<z.infer<typeof PartyPlace>, { placed: string[] }> = {
  type: "party.place",
  schema: PartyPlace,
  undoable: false,
  internal: true,
  authorize() {},
  plan(ctx: CommandCtx, p) {
    const scene = mustGet(ctx, "scene", p.sceneId);
    const tokens = ctx.model.inScene("token", scene.id);
    const actors = p.actorIds
      .map((id) => ctx.model.get("actor", id))
      .filter(
        (a): a is ActorEntity =>
          !!a && a.deletedAt === null && a.kind === "character" && !tokens.some((t) => t.actorId === a.id),
      );
    if (!actors.length) return { ops: [], summary: "", result: { placed: [] } };
    const spots = spawnSpots({
      spawn: scene.spawn,
      bounds: scene.bounds,
      walls: ctx.model.inScene("wall", scene.id),
      occupied: tokens.map((t) => ({ x: t.pos.x, y: t.pos.y, size: t.sizeFt })),
      sizes: actors.map((a) => SIZE_BASE_FT[readSheet(a).core.size]),
    });
    const ops: Op[] = [];
    const placed: string[] = [];
    actors.forEach((a, i) => {
      const token = characterToken(a, scene.id, spots[i] as { x: number; y: number }, ctx.now);
      const light = carried(a, token);
      if (light) token.lightId = light.id;
      ops.push(createOp("token", token));
      if (light) ops.push(createOp("light", light));
      placed.push(token.id);
    });
    const names = actors.map((a) => readSheet(a).core.name);
    return {
      ops,
      summary: `Placed ${names.join(", ")} at the party spawn`,
      sceneId: scene.id,
      result: { placed },
    };
  },
};

export const PARTY_COMMANDS = [partyPlace] as CommandDef<never, unknown>[];
