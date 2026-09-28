import type { HpFx } from "@gloam/shared/protocol";
import { GloamError, RestApply, RestHitDie } from "@gloam/shared/protocol";
import {
  applyRest,
  nextHitDie,
  projectSheet,
  type RestKind,
  restPlan,
  statusFromActor,
} from "@gloam/shared/rules";
import type { z } from "zod";
import type { ActorEntity } from "../codecs.ts";
import type { CommandCtx, CommandDef, RoomEvent } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { mustGet, requireDm } from "../plan.ts";
import { readSheet, sheetEditOps } from "./actor.ts";

/**
 * Rests (SPEC §8.11 Rests; AC-HP-13): the DM rests the chosen characters — each with the items kept from its preview
 * (rules/rests.ts) — as one undoable command; after a short rest each character with Hit Dice to spend gets its
 * player's card (the room's follow-up), one die at a time.
 */

/** The room message a short rest's Hit Dice cards travel in. */
export const REST_FOLLOWUPS = "rest.followups";
export interface RestFollowups {
  /** Characters with Hit Dice to spend. */
  actors: string[];
  by: string;
}

function live(ctx: CommandCtx, actorId: string): ActorEntity {
  const a = mustGet(ctx, "actor", actorId);
  if (a.deletedAt !== null) throw new GloamError("NOT_FOUND", "That character no longer exists.");
  return a;
}

/** The tokens that show a character (its linked ones, on every scene). */
const tokensOfActor = (ctx: CommandCtx, actorId: string) =>
  ctx.model
    .all("token")
    .filter((t) => t.actorId === actorId && t.link === "linked")
    .map((t) => t.id);

/** `rest.apply` (DM) — a short or long rest for the chosen characters, each with the items the DM kept. */
export const restApply: CommandDef<z.infer<typeof RestApply>, { rested: string[]; cards: string[] }> = {
  type: "rest.apply",
  schema: RestApply,
  undoable: true,
  authorize(ctx, p) {
    requireDm(ctx);
    for (const id of Object.keys(p.actors)) live(ctx, id);
  },
  plan(ctx, p) {
    const pack = ctx.model.campaign.rulesPack;
    const kind = p.kind as RestKind;
    const ops: Op[] = [];
    const rested: string[] = [];
    const names: string[] = [];
    const cards: string[] = [];
    for (const [actorId, keep] of Object.entries(p.actors)) {
      const actor = live(ctx, actorId);
      const before = readSheet(actor);
      const status = statusFromActor(actor.status);
      if (restPlan(before, status, kind, pack).blocked) continue;
      const { sheet: after, status: next } = applyRest(before, status, kind, pack, keep);
      ops.push(...sheetEditOps(ctx, actor, before, projectSheet(after, next), next));
      rested.push(actorId);
      names.push(before.core.name);
      if (kind === "short" && keep.includes("hitDiceCards") && nextHitDie(after)) cards.push(actorId);
    }
    if (!rested.length)
      throw new GloamError("INVALID", "No one here can rest (a creature needs at least 1 HP).");
    const events: RoomEvent[] = cards.length
      ? [
          {
            name: REST_FOLLOWUPS,
            payload: { actors: cards, by: ctx.actor.userId } satisfies RestFollowups,
            to: { dms: true },
          },
        ]
      : [];
    return {
      ops,
      summary: `${kind === "long" ? "Long" : "Short"} rest: ${names.join(", ")}`,
      events,
      result: { rested, cards },
    };
  },
};

/** `rest.hitDie` (internal) — a Hit Die spent on a short rest: one of that die used, the HP its roll brought. */
export const restHitDie: CommandDef<z.infer<typeof RestHitDie>, { hp: number }> = {
  type: "rest.hitDie",
  schema: RestHitDie,
  undoable: true,
  internal: true,
  authorize(ctx, p) {
    live(ctx, p.actorId);
  },
  plan(ctx, p) {
    const actor = live(ctx, p.actorId);
    const before = readSheet(actor);
    const i = before.core.hitDice.findIndex((d) => d.die === p.die && d.total - d.used > 0);
    if (i < 0) throw new GloamError("CONFLICT", `No ${p.die} Hit Dice left.`);
    const hp = before.core.hp;
    const current = Math.min(hp.max, Math.max(0, hp.current) + p.heal);
    const hitDice = before.core.hitDice.map((d, j) => (j === i ? { ...d, used: d.used + 1 } : d));
    const after = { ...before, core: { ...before.core, hitDice, hp: { ...hp, current } } };
    const gained = current - Math.max(0, hp.current);
    const events: RoomEvent[] = tokensOfActor(ctx, actor.id).map((tokenId) => ({
      name: "hp.fx",
      payload: { tokenId, kind: "heal", amount: gained } satisfies HpFx,
      to: { viewersOf: tokenId },
    }));
    return {
      ops: sheetEditOps(ctx, actor, before, after),
      summary: `${before.core.name} spent a Hit Die (${p.die}): +${gained} HP`,
      events,
      result: { hp: current },
    };
  },
};

export const REST_COMMANDS = [restApply, restHitDie] as CommandDef<never, unknown>[];
