import {
  CombatAdd,
  CombatDelay,
  CombatEndTurn,
  CombatFreeMovement,
  CombatInitiative,
  CombatNone,
  CombatPip,
  CombatQuickStart,
  CombatRemove,
  CombatReorder,
  CombatSet,
  CombatStart,
  GloamError,
  MoveTurn,
} from "@gloam/shared/protocol";
import {
  bonusMoveActive,
  CONDITIONS,
  type CombatantEntry,
  type CombatData,
  type ConditionInfo,
  controlsToken,
  effectiveSpeed,
  effectiveTokenState,
  emptyTally,
  fixedInitiative,
  groupIdentical,
  type InitiativeMethod,
  initiativeHints,
  isDm,
  moveAfter,
  orderCombatants,
  PIP,
  standUpCost,
  stepTurn,
  type TieBreak,
  type TurnState,
  turnBudget,
} from "@gloam/shared/rules";
import type { TokenEntity } from "@gloam/shared/schemas";
import type { z } from "zod";
import { newId } from "../../ids.ts";
import type { CombatEntity } from "../codecs.ts";
import type { CommandCtx, CommandDef, RoomEvent } from "../commandBus.ts";
import type { CampaignModel } from "../model.ts";
import type { Op } from "../ops.ts";
import { createOp, mustGet, requireDm, setOps, setPathOp } from "../plan.ts";
import { holderOf, holderOps, mustBeAbleToAct } from "./health.ts";

/**
 * Combat and initiative (SPEC §8.12; AC-CMB-01…11): a combat on the active scene — its combatants in tracker order,
 * how initiative is found, the active combatant's turn (its movement bookkeeping, §16.5), the pips and a tally for
 * the summary — kept in `combats.data_json` and changed only by these commands (each undoable). What the rolls,
 * the players' cards, the turn's prompts and the per-client tracker need is the room's (rooms/combat.ts), told by the
 * events below.
 */

/** The room's cue to find initiative: players' cards, and the server's rolls for those it rolls now. */
export const COMBAT_COLLECT = "combat.collect";
export interface CombatCollect {
  combatId: string;
  /** The combatants whose initiative is wanted. */
  tokenIds: string[];
  method: InitiativeMethod;
  /** The server rolls the NPCs among them now (quick start, a creature added, "Roll for everyone"). */
  rollNpcs: boolean;
}
/** A turn began (and the one before ended): the room's start- and end-of-turn processing. */
export const COMBAT_TURN = "combat.turn";
export interface CombatTurn {
  combatId: string;
  sceneId: string;
  /** The combatant whose turn ended (none when turns begin, or going back). */
  from: string | null;
  to: string | null;
  round: number;
  /** Going back (Previous): no end-of-turn processing, no start-of-turn prompts. */
  back: boolean;
}
/** Combat stopped: the room writes the summary to the log and tells everyone. */
export const COMBAT_STOPPED = "combat.stopped";
export interface CombatStopped {
  combatId: string;
  sceneId: string;
  rounds: number;
  /** Who went down (the room tells each person only of those they perceived or control). */
  downed: { tokenId: string; name: string }[];
  tally: { tokenId: string; name: string; dealt: number; taken: number }[];
}

// ── reading a combat ─────────────────────────────────────────────────────────────────────────────────────

/** The running combat on a scene, if any. */
export function combatOn(model: CampaignModel, sceneId: string): CombatEntity | undefined {
  return model.inScene("combat", sceneId).find((c) => c.active);
}

/** The running combat on the active scene, if any. */
export function activeCombat(ctx: CommandCtx): CombatEntity | undefined {
  const scene = ctx.model.activeScene;
  return scene ? combatOn(ctx.model, scene.id) : undefined;
}

function mustCombat(ctx: CommandCtx): CombatEntity {
  const c = activeCombat(ctx);
  if (!c) throw new GloamError("NOT_FOUND", "No combat is running on this scene.");
  return c;
}

/** A combat's data, whatever an older row lacks filled in. */
export function dataOf(c: CombatEntity): CombatData {
  const d = c.data as Partial<CombatData>;
  return {
    method: d.method ?? "playersRoll",
    combatants: d.combatants ?? [],
    begun: d.begun ?? false,
    turn: d.turn ?? null,
    freeMovement: d.freeMovement ?? false,
    pips: d.pips ?? {},
    tally: d.tally ?? emptyTally(),
  };
}

/** The combatant whose turn it is (once turns have begun). */
export function activeEntry(c: CombatEntity): CombatantEntry | undefined {
  const d = dataOf(c);
  return d.begun ? d.combatants[c.turnIndex] : undefined;
}

const tieBreak = (ctx: CommandCtx): TieBreak =>
  ctx.model.campaign.houseRules.initiativeTies === "dmDecides" ? "dm" : "dexThenPcs";

function tokenIn(ctx: CommandCtx, id: string, sceneId: string): TokenEntity {
  const t = mustGet(ctx, "token", id);
  if (t.sceneId !== sceneId) throw new GloamError("INVALID", `${t.name} isn't on this scene.`);
  return t;
}

function stateOf(ctx: CommandCtx, t: TokenEntity) {
  const actor = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
  return effectiveTokenState(t, actor && actor.deletedAt === null ? actor : undefined);
}

function entryFor(ctx: CommandCtx, t: TokenEntity): CombatantEntry {
  const { stats } = stateOf(ctx, t);
  return { tokenId: t.id, name: t.name, initiative: null, dexMod: stats.dexMod, pc: stats.isPC };
}

/** Initiative's hint for a combatant: its conditions, and Surprised (SRD 5.1 has no initiative disadvantage). */
export function initiativeModeOf(ctx: CommandCtx, t: TokenEntity, surprised: boolean) {
  const { status } = stateOf(ctx, t);
  const pack = ctx.model.campaign.rulesPack;
  return initiativeHints(
    status.conditions.map((c) => c.id as string),
    surprised && pack !== "srd-5.1",
  );
}

/** A combatant's Exhaustion level (its −2 a level on every D20 Test, initiative's roll included). */
export function exhaustionOf(ctx: CommandCtx, t: TokenEntity): number {
  return stateOf(ctx, t).status.exhaustion;
}

/** A combatant's initiative modifier: Dex modifier plus any initiative bonus (§19.5). */
export function initiativeModOf(ctx: CommandCtx, t: TokenEntity): number {
  const { stats } = stateOf(ctx, t);
  return stats.dexMod + (stats.initBonus ?? 0);
}

/** Where a combatant stands as its turn begins (Reset puts it back exactly so, prone included). */
export function freshTurn(ctx: CommandCtx, tokenId: string): TurnState {
  const t = mustGet(ctx, "token", tokenId);
  const { status } = stateOf(ctx, t);
  return {
    tokenId,
    usedFt: 0,
    dashes: 0,
    turnStart: {
      x: t.pos.x,
      y: t.pos.y,
      elevation: t.elevation,
      prone: status.conditions.some((c) => c.id === "prone"),
    },
    segments: [],
    stood: false,
  };
}

/**
 * The move to the turn at `index` in `round`: its fresh turn, its pips cleared (the Reaction with them: its own turn),
 * bonus movement that ran out taken away — a "this turn" grant when that creature's turn ends, an "N rounds" grant
 * when its last round is over — and the room told.
 */
function turnTo(
  ctx: CommandCtx,
  c: CombatEntity,
  d: CombatData,
  index: number,
  round: number,
  opts: { from: string | null; back?: boolean },
): { ops: Op[]; events: RoomEvent[]; data: CombatData } {
  const entry = d.combatants[index];
  const data: CombatData = {
    ...d,
    begun: true,
    turn: entry ? freshTurn(ctx, entry.tokenId) : null,
    pips: entry ? { ...d.pips, [entry.tokenId]: 0 } : d.pips,
  };
  const ops = setOps("combat", c, { round, turnIndex: index, data });
  for (const t of ctx.model.inScene("token", c.sceneId)) {
    const b = t.overrides.bonusMove;
    if (!b) continue;
    const endedTurn = b.until === "turn" && opts.from === t.id && !opts.back;
    const pastRounds = b.untilRound !== undefined && round > b.untilRound;
    if (endedTurn || pastRounds) {
      const { bonusMove: _gone, ...rest } = t.overrides;
      ops.push(...setOps("token", t, { overrides: rest, updatedAt: ctx.now }));
    }
  }
  const events: RoomEvent[] = [
    {
      name: COMBAT_TURN,
      payload: {
        combatId: c.id,
        sceneId: c.sceneId,
        from: opts.from,
        to: entry?.tokenId ?? null,
        round,
        back: opts.back === true,
      } satisfies CombatTurn,
      to: { dms: true },
    },
  ];
  return { ops, events, data };
}

/** The order after a change, the active combatant kept active (its place may move). */
function reorderKeepingActive(
  c: CombatEntity,
  d: CombatData,
  order: CombatantEntry[],
): { combatants: CombatantEntry[]; turnIndex: number } {
  const active = d.begun ? d.combatants[c.turnIndex]?.tokenId : undefined;
  const i = active ? order.findIndex((e) => e.tokenId === active) : -1;
  return { combatants: order, turnIndex: i >= 0 ? i : 0 };
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────────────────

function planStart(
  ctx: CommandCtx,
  ids: readonly string[],
  method: InitiativeMethod,
  group: boolean,
  surprised: ReadonlySet<string>,
  quick: boolean,
) {
  const scene = ctx.model.activeScene;
  if (!scene) throw new GloamError("INVALID", "There's no active scene.");
  if (combatOn(ctx.model, scene.id))
    throw new GloamError("CONFLICT", "A combat is already running — stop it first.");
  const tokens = [...new Set(ids)].map((id) => tokenIn(ctx, id, scene.id));
  if (!tokens.length) throw new GloamError("INVALID", "No one to fight.");
  const groups = group
    ? groupIdentical(
        tokens.map((t) => {
          const { stats } = stateOf(ctx, t);
          return {
            tokenId: t.id,
            actorId: t.actorId,
            linked: t.link === "linked",
            name: t.name,
            dexMod: stats.dexMod,
            pc: stats.isPC,
          };
        }),
      )
    : new Map<string, string>();
  let entries: CombatantEntry[] = tokens.map((t) => {
    const g = groups.get(t.id);
    return {
      ...entryFor(ctx, t),
      ...(g ? { group: g } : {}),
      ...(surprised.has(t.id) ? { surprised: true } : {}),
    };
  });
  const ties = tieBreak(ctx);
  if (method === "fixed")
    entries = entries.map((e) => {
      const t = mustGet(ctx, "token", e.tokenId);
      return {
        ...e,
        initiative: fixedInitiative(
          initiativeModOf(ctx, t),
          initiativeModeOf(ctx, t, e.surprised === true).mode,
        ),
      };
    });
  // Skipping the rolls, the DM sets the order: as they listed them. Otherwise by what's known (Dex, then name).
  if (method !== "skip") entries = orderCombatants(entries, ties);
  const base: CombatEntity = {
    id: newId("cmb"),
    sceneId: scene.id,
    active: true,
    round: 1,
    turnIndex: 0,
    data: {
      method,
      combatants: entries,
      begun: false,
      turn: null,
      freeMovement: false,
      pips: {},
      tally: emptyTally(),
    } satisfies CombatData,
    startedAt: ctx.now,
    endedAt: null,
  };
  const events: RoomEvent[] = [];
  let entity = base;
  // Fixed initiative is known at once: turns begin.
  if (method === "fixed") {
    const first = entries[0] as CombatantEntry;
    const d = dataOf(base);
    entity = {
      ...base,
      data: { ...d, begun: true, turn: freshTurn(ctx, first.tokenId), pips: { [first.tokenId]: 0 } },
    };
    events.push({
      name: COMBAT_TURN,
      payload: {
        combatId: base.id,
        sceneId: scene.id,
        from: null,
        to: first.tokenId,
        round: 1,
        back: false,
      } satisfies CombatTurn,
      to: { dms: true },
    });
  } else if (method !== "skip")
    events.push({
      name: COMBAT_COLLECT,
      payload: {
        combatId: base.id,
        tokenIds: entries.map((e) => e.tokenId),
        method,
        rollNpcs: quick || method === "rollAll",
      } satisfies CombatCollect,
      to: { dms: true },
    });
  return {
    ops: [createOp("combat", entity)],
    summary: `Combat started (${entries.length} combatants)`,
    sceneId: scene.id,
    events,
    result: { combatId: base.id },
  };
}

/** `combat.start` (DM): the participants, the initiative method, identical NPCs grouped, who's surprised. */
export const combatStart: CommandDef<z.infer<typeof CombatStart>, { combatId: string }> = {
  type: "combat.start",
  schema: CombatStart,
  undoable: true,
  authorize: requireDm,
  plan: (ctx, p) => planStart(ctx, p.participants, p.method, p.group, new Set(p.surprised), false),
};

/** `combat.quickStart` (DM): every creature on the scene not hidden, the campaign's default method, no dialog. */
export const combatQuickStart: CommandDef<z.infer<typeof CombatQuickStart>, { combatId: string }> = {
  type: "combat.quickStart",
  schema: CombatQuickStart,
  undoable: true,
  authorize: requireDm,
  plan(ctx) {
    const scene = ctx.model.activeScene;
    if (!scene) throw new GloamError("INVALID", "There's no active scene.");
    const ids = ctx.model
      .inScene("token", scene.id)
      .filter((t) => !t.hidden)
      .map((t) => t.id);
    return planStart(ctx, ids, ctx.model.campaign.houseRules.defaultInitiative, true, new Set(), true);
  },
};

/** `combat.stop` (DM): back to exploration; the summary goes to the log (the room writes it). */
export const combatStop: CommandDef<z.infer<typeof CombatNone>, { rounds: number }> = {
  type: "combat.stop",
  schema: CombatNone,
  undoable: true,
  authorize: requireDm,
  plan(ctx) {
    const c = mustCombat(ctx);
    const d = dataOf(c);
    const name = (id: string) =>
      d.combatants.find((e) => e.tokenId === id)?.name ?? ctx.model.get("token", id)?.name ?? "Someone";
    const ids = new Set([...Object.keys(d.tally.dealt), ...Object.keys(d.tally.taken)]);
    const stopped: CombatStopped = {
      combatId: c.id,
      sceneId: c.sceneId,
      rounds: d.begun ? c.round : 0,
      downed: d.tally.downed.map((id) => ({ tokenId: id, name: name(id) })),
      tally: [...ids].map((id) => ({
        tokenId: id,
        name: name(id),
        dealt: d.tally.dealt[id] ?? 0,
        taken: d.tally.taken[id] ?? 0,
      })),
    };
    return {
      ops: setOps("combat", c, { active: false, endedAt: ctx.now, data: { ...d, turn: null } }),
      summary: "Combat stopped",
      sceneId: c.sceneId,
      events: [{ name: COMBAT_STOPPED, payload: stopped, to: { dms: true } }],
      result: { rounds: stopped.rounds },
    };
  },
};

/** `combat.begin` (DM): turns begin — the unrolled last, by Dex modifier (skipped rolls: in the DM's order). */
export const combatBegin: CommandDef<z.infer<typeof CombatNone>, { tokenId: string | null }> = {
  type: "combat.begin",
  schema: CombatNone,
  undoable: true,
  authorize: requireDm,
  plan(ctx) {
    const c = mustCombat(ctx);
    const d = dataOf(c);
    if (d.begun) throw new GloamError("CONFLICT", "Turns have already begun.");
    return beginPlan(ctx, c, d);
  },
};

function beginPlan(ctx: CommandCtx, c: CombatEntity, d: CombatData) {
  const order = d.method === "skip" ? d.combatants : orderCombatants(d.combatants, tieBreak(ctx));
  const { ops, events, data } = turnTo(ctx, c, { ...d, combatants: order }, 0, 1, { from: null });
  return {
    ops,
    summary: "Turns begin",
    sceneId: c.sceneId,
    events,
    result: { tokenId: data.turn?.tokenId ?? null },
  };
}

function advance(ctx: CommandCtx, c: CombatEntity, dir: 1 | -1) {
  const d = dataOf(c);
  if (!d.begun) throw new GloamError("CONFLICT", "Turns haven't begun yet.");
  if (!d.combatants.length) throw new GloamError("CONFLICT", "No one's left in the fight.");
  const from = d.combatants[c.turnIndex]?.tokenId ?? null;
  const at = stepTurn({ index: c.turnIndex, round: c.round }, d.combatants.length, dir);
  const { ops, events, data } = turnTo(ctx, c, d, at.index, at.round, { from, back: dir < 0 });
  const who = data.turn ? (d.combatants[at.index]?.name ?? "") : "";
  return {
    ops,
    summary: `${dir > 0 ? "Next turn" : "Previous turn"}: ${who} (round ${at.round})`,
    sceneId: c.sceneId,
    events,
    result: { tokenId: data.turn?.tokenId ?? null, round: at.round },
  };
}

/** `combat.next` / `combat.prev` (DM). */
export const combatNext: CommandDef<z.infer<typeof CombatNone>, { tokenId: string | null; round: number }> = {
  type: "combat.next",
  schema: CombatNone,
  undoable: true,
  authorize: requireDm,
  plan: (ctx) => advance(ctx, mustCombat(ctx), 1),
};
export const combatPrev: CommandDef<z.infer<typeof CombatNone>, { tokenId: string | null; round: number }> = {
  type: "combat.prev",
  schema: CombatNone,
  undoable: true,
  authorize: requireDm,
  plan: (ctx) => advance(ctx, mustCombat(ctx), -1),
};

/** `combat.endTurn` (the active combatant's controller, or the DM): the turn passes to the next. */
export const combatEndTurn: CommandDef<
  z.infer<typeof CombatEndTurn>,
  { tokenId: string | null; round: number }
> = {
  type: "combat.endTurn",
  schema: CombatEndTurn,
  undoable: true,
  authorize(ctx, p) {
    const c = mustCombat(ctx);
    const active = activeEntry(c);
    if (!active || active.tokenId !== p.tokenId)
      throw new GloamError("CONFLICT", "It isn't that creature's turn.");
    const t = mustGet(ctx, "token", p.tokenId);
    if (!controlsToken(ctx.actor.role, ctx.actor.userId, t))
      throw new GloamError("FORBIDDEN", "It isn't your turn to end.");
  },
  plan: (ctx) => advance(ctx, mustCombat(ctx), 1),
};

/** A combat's order changed by initiative (set, rolled): sorted, the active combatant kept active. */
function withInitiatives(ctx: CommandCtx, c: CombatEntity, values: Record<string, number>) {
  const d = dataOf(c);
  const combatants = d.combatants.map((e) =>
    values[e.tokenId] !== undefined ? { ...e, initiative: values[e.tokenId] as number } : e,
  );
  const sorted = orderCombatants(combatants, tieBreak(ctx));
  const { combatants: order, turnIndex } = reorderKeepingActive(c, d, sorted);
  return { d, order, turnIndex };
}

/** `combat.set` (DM): a combatant's initiative — the order follows it. */
export const combatSet: CommandDef<z.infer<typeof CombatSet>, { order: string[] }> = {
  type: "combat.set",
  schema: CombatSet,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const c = mustCombat(ctx);
    if (!dataOf(c).combatants.some((e) => e.tokenId === p.tokenId))
      throw new GloamError("NOT_FOUND", "That creature isn't in the fight.");
    const { d, order, turnIndex } = withInitiatives(ctx, c, { [p.tokenId]: p.initiative });
    const name = order.find((e) => e.tokenId === p.tokenId)?.name ?? "";
    return {
      ops: setOps("combat", c, { turnIndex, data: { ...d, combatants: order } }),
      summary: `${name}'s initiative: ${p.initiative}`,
      sceneId: c.sceneId,
      result: { order: order.map((e) => e.tokenId) },
    };
  },
};

/**
 * `combat.initiative` (internal): initiatives found — a player's card, the server's rolls for the NPCs (one per group
 * of identical creatures) — the order follows; once every one is known, turns begin.
 */
export const combatInitiative: CommandDef<z.infer<typeof CombatInitiative>, { begun: boolean }> = {
  type: "combat.initiative",
  schema: CombatInitiative,
  undoable: true,
  internal: true,
  authorize: () => {},
  plan(ctx, p) {
    const c = mustCombat(ctx);
    const { d, order, turnIndex } = withInitiatives(ctx, c, p.values);
    const next: CombatData = { ...d, combatants: order };
    if (!d.begun && (p.begin || order.every((e) => e.initiative !== null))) {
      const b = beginPlan(ctx, c, next);
      return { ...b, summary: "Initiative is in: turns begin", result: { begun: true } };
    }
    return {
      ops: setOps("combat", c, { turnIndex, data: next }),
      summary: "Initiative",
      sceneId: c.sceneId,
      result: { begun: d.begun },
    };
  },
};

/** `combat.reorder` (DM): the tracker as the DM dragged it — every combatant, once; the active one stays so. */
export const combatReorder: CommandDef<z.infer<typeof CombatReorder>, { order: string[] }> = {
  type: "combat.reorder",
  schema: CombatReorder,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const c = mustCombat(ctx);
    const d = dataOf(c);
    const byId = new Map(d.combatants.map((e) => [e.tokenId, e]));
    if (
      p.order.length !== byId.size ||
      new Set(p.order).size !== byId.size ||
      p.order.some((id) => !byId.has(id))
    )
      throw new GloamError("INVALID", "The new order has to hold every combatant, once.");
    const order = p.order.map((id) => byId.get(id) as CombatantEntry);
    const { combatants, turnIndex } = reorderKeepingActive(c, d, order);
    return {
      ops: setOps("combat", c, { turnIndex, data: { ...d, combatants } }),
      summary: "Initiative order changed",
      sceneId: c.sceneId,
      result: { order: p.order },
    };
  },
};

/**
 * `combat.delay` (DM): a combatant acts later — just after another. Delaying the one whose turn it is hands the turn
 * to the next in line (it hasn't finished: no end-of-turn processing).
 */
export const combatDelay: CommandDef<z.infer<typeof CombatDelay>, { order: string[] }> = {
  type: "combat.delay",
  schema: CombatDelay,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const c = mustCombat(ctx);
    const d = dataOf(c);
    const me = d.combatants.find((e) => e.tokenId === p.tokenId);
    if (!me || !d.combatants.some((e) => e.tokenId === p.after))
      throw new GloamError("NOT_FOUND", "Both have to be in the fight.");
    const order = moveAfter(d.combatants, p.tokenId, p.after);
    const wasActive = d.begun && d.combatants[c.turnIndex]?.tokenId === p.tokenId;
    if (wasActive) {
      const { ops, events } = turnTo(ctx, c, { ...d, combatants: order }, c.turnIndex, c.round, {
        from: null,
      });
      return {
        ops,
        summary: `${me.name} delays`,
        sceneId: c.sceneId,
        events,
        result: { order: order.map((e) => e.tokenId) },
      };
    }
    const { combatants, turnIndex } = reorderKeepingActive(c, d, order);
    return {
      ops: setOps("combat", c, { turnIndex, data: { ...d, combatants } }),
      summary: `${me.name} delays`,
      sceneId: c.sceneId,
      result: { order: order.map((e) => e.tokenId) },
    };
  },
};

/** `combat.add` (DM): creatures join; each is asked for initiative (the NPCs rolled at once). */
export const combatAdd: CommandDef<z.infer<typeof CombatAdd>, { added: string[] }> = {
  type: "combat.add",
  schema: CombatAdd,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const c = mustCombat(ctx);
    const d = dataOf(c);
    const have = new Set(d.combatants.map((e) => e.tokenId));
    const fresh = [...new Set(p.tokenIds)].filter((id) => !have.has(id));
    if (!fresh.length) throw new GloamError("CONFLICT", "They're already in the fight.");
    const added = fresh.map((id) => entryFor(ctx, tokenIn(ctx, id, c.sceneId)));
    const combatants = [...d.combatants, ...added];
    return {
      ops: setOps("combat", c, { data: { ...d, combatants } }),
      summary: `${added.map((e) => e.name).join(", ")} joined the fight`,
      sceneId: c.sceneId,
      events: [
        {
          name: COMBAT_COLLECT,
          payload: {
            combatId: c.id,
            tokenIds: fresh,
            method: d.method === "skip" || d.method === "fixed" ? "playersRoll" : d.method,
            rollNpcs: true,
          } satisfies CombatCollect,
          to: { dms: true },
        },
      ],
      result: { added: fresh },
    };
  },
};

/** `combat.remove` (DM): a creature leaves the fight; if it was its turn, the next one's begins. */
export const combatRemove: CommandDef<z.infer<typeof CombatRemove>, { removed: string }> = {
  type: "combat.remove",
  schema: CombatRemove,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const c = mustCombat(ctx);
    const d = dataOf(c);
    const i = d.combatants.findIndex((e) => e.tokenId === p.tokenId);
    if (i < 0) throw new GloamError("NOT_FOUND", "That creature isn't in the fight.");
    const gone = d.combatants[i] as CombatantEntry;
    const combatants = d.combatants.filter((_, j) => j !== i);
    const { [p.tokenId]: _pips, ...pips } = d.pips;
    const rest: CombatData = { ...d, combatants, pips };
    const summary = `${gone.name} left the fight`;
    if (d.begun && i === c.turnIndex) {
      // Its turn: the one after it (now at its place) takes the turn; past the end, the next round's first.
      const wrap = i >= combatants.length;
      const { ops, events } = turnTo(ctx, c, rest, wrap ? 0 : i, wrap ? c.round + 1 : c.round, {
        from: null,
      });
      return { ops, summary, sceneId: c.sceneId, events, result: { removed: p.tokenId } };
    }
    const turnIndex = d.begun && i < c.turnIndex ? c.turnIndex - 1 : c.turnIndex;
    return {
      ops: setOps("combat", c, { turnIndex, data: rest }),
      summary,
      sceneId: c.sceneId,
      result: { removed: p.tokenId },
    };
  },
};

/** `combat.freeMovement` (DM): everyone moves freely (no turn order, no budget), or not. */
export const combatFreeMovement: CommandDef<z.infer<typeof CombatFreeMovement>, { on: boolean }> = {
  type: "combat.freeMovement",
  schema: CombatFreeMovement,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const c = mustCombat(ctx);
    const d = dataOf(c);
    return {
      ops: setOps("combat", c, { data: { ...d, freeMovement: p.on } }),
      summary: p.on ? "Free movement for everyone" : "Turn order again",
      sceneId: c.sceneId,
      result: { on: p.on },
    };
  },
};

/**
 * `combat.pip` (the combatant's controller, or the DM): an action pip marked used or not (§8.12: a tracker, not a
 * jail — the client asks "already used — continue?" before marking one twice).
 */
export const combatPip: CommandDef<z.infer<typeof CombatPip>, { pips: number }> = {
  type: "combat.pip",
  schema: CombatPip,
  undoable: true,
  authorize(ctx, p) {
    const c = mustCombat(ctx);
    if (!dataOf(c).combatants.some((e) => e.tokenId === p.tokenId))
      throw new GloamError("NOT_FOUND", "That creature isn't in the fight.");
    const t = mustGet(ctx, "token", p.tokenId);
    if (!controlsToken(ctx.actor.role, ctx.actor.userId, t))
      throw new GloamError("FORBIDDEN", "That creature isn't yours.");
  },
  plan(ctx, p) {
    const c = mustCombat(ctx);
    const d = dataOf(c);
    const cur = d.pips[p.tokenId] ?? 0;
    const bit = PIP[p.pip];
    const pips = p.used ? cur | bit : cur & ~bit;
    // Its own path (undoing a pip never clashes with a move, nor a move with a pip).
    const op = setPathOp("combat", c, ["data", "pips", p.tokenId], pips);
    return {
      ops: op ? [op] : [],
      summary: `${p.pip} ${p.used ? "used" : "back"}`,
      sceneId: c.sceneId,
      result: { pips },
    };
  },
};

/**
 * A creature's movement in a combat (§19.4): its speed in its movement mode after conditions and Exhaustion, times
 * (1 + dashes), plus the DM's bonus movement while it lasts (never doubled by Dash); what it has used this turn (only
 * the creature whose turn it is has used any). Outside a combat, or for a creature not in it: none.
 */
export function movementOf(
  model: CampaignModel,
  t: TokenEntity,
): { budget: number; used: number; dashes: number; bonus: number; speed: number; active: boolean } | null {
  const c = combatOn(model, t.sceneId);
  if (!c) return null;
  const d = dataOf(c);
  if (!d.combatants.some((e) => e.tokenId === t.id)) return null;
  const a = t.actorId ? model.get("actor", t.actorId) : undefined;
  const { stats, status } = effectiveTokenState(t, a && a.deletedAt === null ? a : undefined);
  const modes = ["walk", "fly", "swim", "climb", "burrow"] as const;
  const mode = modes.find((m) => m === t.moveMode) ?? "walk";
  const speed = effectiveSpeed(
    t.overrides.speedOverride ?? stats.speeds[mode],
    status.conditions.map((x) => x.id as string),
    status.exhaustion,
    t.overrides.ignoreConditionSpeed === true,
  );
  // A Speed of 0 can't be increased (SPEC R1 §19.4): a Speed-0 condition zeroes the bonus with the rest.
  const zeroed =
    t.overrides.ignoreConditionSpeed !== true &&
    status.conditions.some((x) => (CONDITIONS as Record<string, ConditionInfo>)[x.id]?.speedZero);
  const bonus =
    !zeroed && bonusMoveActive(t.overrides.bonusMove, c.round) ? (t.overrides.bonusMove?.ft ?? 0) : 0;
  const active = d.begun && d.combatants[c.turnIndex]?.tokenId === t.id;
  const turn = active && d.turn?.tokenId === t.id ? d.turn : null;
  const dashes = turn?.dashes ?? 0;
  return { budget: turnBudget(speed, dashes, bonus), used: turn?.usedFt ?? 0, dashes, bonus, speed, active };
}

/** Whether a player may act for this token now: DMs always; a controller on its turn, or while it moves freely. */
export function onItsTurn(ctx: CommandCtx, c: CombatEntity, t: TokenEntity): boolean {
  if (isDm(ctx.actor.role)) return true;
  const d = dataOf(c);
  if (d.freeMovement || t.overrides.freeMovement) return true;
  return d.begun && d.combatants[c.turnIndex]?.tokenId === t.id;
}

// ── the turn's own moves: Reset, Dash, Stand up (§8.6, §16.5) ─────────────────────────────────────────────────

/** The combat and turn of the creature whose turn it is, for a command about it (its controller, or the DM). */
function ownTurn(ctx: CommandCtx, tokenId: string) {
  const t = mustGet(ctx, "token", tokenId);
  if (!controlsToken(ctx.actor.role, ctx.actor.userId, t))
    throw new GloamError("FORBIDDEN", "That creature isn't yours.");
  const c = combatOn(ctx.model, t.sceneId);
  if (!c) throw new GloamError("CONFLICT", "There's no combat running.");
  const d = dataOf(c);
  const turn = d.turn;
  if (!d.begun || !turn || turn.tokenId !== t.id || d.combatants[c.turnIndex]?.tokenId !== t.id)
    throw new GloamError("NOT_YOUR_TURN", "It isn't this creature's turn.");
  return { t, c, d, turn };
}

/**
 * `move.reset` (§8.6 Reset move; AC-MOV-05): the creature back where its turn began — as it was, prone included — its
 * movement unspent (a stand-up refunded with it); a Dash already taken stays. Players only on its turn, and by the
 * house rule: always (Xini's choice), until an action is used, or never.
 */
export const moveReset: CommandDef<z.infer<typeof MoveTurn>, { pos: { x: number; y: number } }> = {
  type: "move.reset",
  schema: MoveTurn,
  undoable: true,
  authorize(ctx, p) {
    const { d } = ownTurn(ctx, p.tokenId);
    if (isDm(ctx.actor.role)) return;
    const rule = ctx.model.campaign.houseRules.moveReset;
    if (rule === "never") throw new GloamError("FORBIDDEN", "Moves can't be reset at this table.");
    if (rule === "untilAction" && ((d.pips[p.tokenId] ?? 0) & PIP.action) !== 0)
      throw new GloamError("FORBIDDEN", "Its action is used: the move can't be reset now.");
  },
  plan(ctx, p) {
    const { t, c, turn } = ownTurn(ctx, p.tokenId);
    const start = turn.turnStart;
    const ops: Op[] = [];
    const patch: Partial<TokenEntity> = {};
    if (t.pos.x !== start.x || t.pos.y !== start.y) patch.pos = { x: start.x, y: start.y };
    if (t.elevation !== start.elevation) patch.elevation = start.elevation;
    ops.push(...setOps("token", t, patch));
    const light = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
    if (light && patch.pos) ops.push(...setOps("light", light, { pos: patch.pos }));
    // Prone as it was when the turn began (a stand-up undone, or a fall).
    const h = holderOf(ctx, { tokenId: t.id });
    const prone = h.status.conditions.some((x) => x.id === "prone");
    if (prone !== start.prone) {
      const status = start.prone
        ? { ...h.status, conditions: [...h.status.conditions, { id: "prone" as const }] }
        : { ...h.status, conditions: h.status.conditions.filter((x) => x.id !== "prone") };
      ops.push(...holderOps(ctx, h, { hp: h.hp, hpTemp: h.hpTemp, status }));
    }
    for (const [path, value] of [
      [["data", "turn", "usedFt"], 0],
      [["data", "turn", "segments"], []],
      [["data", "turn", "stood"], false],
    ] as const) {
      const op = setPathOp("combat", c, [...path], value);
      if (op) ops.push(op);
    }
    const events: RoomEvent[] = patch.pos
      ? [
          {
            name: "token.moved",
            payload: { id: t.id, path: [t.pos, patch.pos], durationMs: 350 },
            to: { viewersOf: t.id },
          },
        ]
      : [];
    return { ops, summary: `${t.name}'s move reset`, sceneId: t.sceneId, events, result: { pos: start } };
  },
};

/** `move.dash` (§19.4; AC-MOV-09): another speed's worth of movement this turn (not the DM's bonus); its action used. */
export const moveDash: CommandDef<z.infer<typeof MoveTurn>, { dashes: number }> = {
  type: "move.dash",
  schema: MoveTurn,
  undoable: true,
  authorize(ctx, p) {
    const { t } = ownTurn(ctx, p.tokenId);
    // Dash is an action: none while Incapacitated (rules audit A11).
    mustBeAbleToAct(ctx, holderOf(ctx, { tokenId: t.id }), "Dash");
  },
  plan(ctx, p) {
    const { t, c, d, turn } = ownTurn(ctx, p.tokenId);
    const dashes = turn.dashes + 1;
    const ops = [
      setPathOp("combat", c, ["data", "turn", "dashes"], dashes),
      setPathOp("combat", c, ["data", "pips", t.id], (d.pips[t.id] ?? 0) | PIP.action),
    ].filter((o): o is Op => o !== null);
    return { ops, summary: `${t.name} dashes`, sceneId: t.sceneId, result: { dashes } };
  },
};

/** `move.stand` (§19.4; AC-MOV-09): up from Prone for half its speed — refused when that much isn't left. */
export const moveStand: CommandDef<z.infer<typeof MoveTurn>, { cost: number }> = {
  type: "move.stand",
  schema: MoveTurn,
  undoable: true,
  authorize(ctx, p) {
    ownTurn(ctx, p.tokenId);
  },
  plan(ctx, p) {
    const { t, c, turn } = ownTurn(ctx, p.tokenId);
    const h = holderOf(ctx, { tokenId: t.id });
    if (!h.status.conditions.some((x) => x.id === "prone"))
      throw new GloamError("CONFLICT", `${t.name} isn't prone.`);
    const m = movementOf(ctx.model, t);
    const walk = (() => {
      const a = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
      const { stats, status } = effectiveTokenState(t, a && a.deletedAt === null ? a : undefined);
      return effectiveSpeed(
        t.overrides.speedOverride ?? stats.speeds.walk,
        status.conditions.map((x) => x.id as string),
        status.exhaustion,
        t.overrides.ignoreConditionSpeed === true,
      );
    })();
    const cost = standUpCost(walk);
    const left = m ? m.budget - m.used : 0;
    if (walk <= 0) throw new GloamError("SPEED_ZERO", `${t.name} can't stand: its speed is 0.`);
    if (cost > left + 0.05)
      throw new GloamError(
        "OVER_BUDGET",
        `Standing up takes ${cost} ft; ${Math.max(0, Math.floor(left))} ft left.`,
      );
    const status = { ...h.status, conditions: h.status.conditions.filter((x) => x.id !== "prone") };
    const ops: Op[] = [
      ...holderOps(ctx, h, { hp: h.hp, hpTemp: h.hpTemp, status }),
      ...[
        setPathOp("combat", c, ["data", "turn", "usedFt"], turn.usedFt + cost),
        setPathOp("combat", c, ["data", "turn", "stood"], true),
      ].filter((o): o is Op => o !== null),
    ];
    return { ops, summary: `${t.name} stands up (${cost} ft)`, sceneId: t.sceneId, result: { cost } };
  },
};

export const COMBAT_COMMANDS = [
  combatStart,
  combatQuickStart,
  combatStop,
  combatBegin,
  combatNext,
  combatPrev,
  combatEndTurn,
  combatSet,
  combatInitiative,
  combatReorder,
  combatDelay,
  combatAdd,
  combatRemove,
  combatFreeMovement,
  combatPip,
  moveReset,
  moveDash,
  moveStand,
] as unknown as CommandDef<never, unknown>[];
