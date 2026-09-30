import { SIZE_BASE_FT, type Size } from "@gloam/shared";
import {
  GloamError,
  TokenCreate,
  TokenDelete,
  TokenDuplicate,
  TokenElevation,
  TokenFacing,
  TokenMoveMode,
  TokenPlace,
  TokenSetLink,
  TokenUpdate,
} from "@gloam/shared/protocol";
import {
  type ActorLike,
  controlsToken,
  effectiveTokenState,
  isDm,
  speedZeroCondition,
  statusName,
} from "@gloam/shared/rules";
import {
  DEFAULT_SPEEDS,
  EMPTY_STATUS,
  type TokenEntity,
  type TokenStats,
  type TokenStatusT,
} from "@gloam/shared/schemas";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { assets } from "../../db/schema.ts";
import { newId } from "../../ids.ts";
import type { CommandCtx, CommandDef } from "../commandBus.ts";
import { clone, type Op } from "../ops.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps, setPathOp } from "../plan.ts";
import { combatOn, dataOf, movementOf, onItsTurn } from "./combat.ts";

/** An asset reference usable on this campaign's board (approved, or the uploader's own pending upload for DMs). */
export function assertAsset(ctx: CommandCtx, assetId: string | undefined): void {
  if (!assetId) return;
  const a = ctx.app.db
    .select()
    .from(assets)
    .where(
      and(eq(assets.id, assetId), eq(assets.campaignId, ctx.model.campaign.id), isNull(assets.deletedAt)),
    )
    .get();
  if (!a) throw new GloamError("NOT_FOUND", "That image or model isn't in this campaign's library.");
  if (a.status !== "approved" && !isDm(ctx.actor.role))
    throw new GloamError("FORBIDDEN", "That upload hasn't been approved yet.");
  if (a.status === "rejected") throw new GloamError("INVALID", "That upload was rejected.");
}

function defaultStats(size: Size): TokenStats {
  return {
    hp: 10,
    hpMax: 10,
    hpTemp: 0,
    ac: 10,
    speeds: { ...DEFAULT_SPEEDS },
    senses: { darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0 },
    saves: {},
    dexMod: 0,
    initBonus: 0,
    resist: [],
    immune: [],
    vuln: [],
    conditionImmune: [],
    reachFt: 5,
    size,
    isPC: false,
  };
}

function inBounds(ctx: CommandCtx, sceneId: string, pos: { x: number; y: number }): { x: number; y: number } {
  const s = mustGet(ctx, "scene", sceneId);
  const pad = 20;
  return {
    x: Math.min(s.bounds.maxX + pad, Math.max(s.bounds.minX - pad, pos.x)),
    y: Math.min(s.bounds.maxY + pad, Math.max(s.bounds.minY - pad, pos.y)),
  };
}

/**
 * A name told apart from the scene's others (§8.6 "Goblin 2", §29.5): a creature placed where one of the same name
 * already stands takes the next number ("Goblin", "Goblin 2", "Goblin 3"); the first keeps its plain name. Numbers
 * are part of the name — the tracker, the cards and the log all say the same — and initiative still groups them as
 * identical (rules/combat.ts ignores a trailing number). `taken` holds names given in the same command.
 */
export function numberedName(ctx: CommandCtx, sceneId: string, name: string, taken: string[] = []): string {
  const base = name.trim().replace(/\s*#?\d+$/, "");
  const key = base.toLowerCase();
  const names = [...ctx.model.inScene("token", sceneId).map((t) => t.name), ...taken];
  let top = 0;
  for (const n of names) {
    const m = /^(.*?)\s*#?(\d+)?$/.exec(n.trim());
    if (!m || (m[1] ?? "").toLowerCase() !== key) continue;
    top = Math.max(top, m[2] ? Number(m[2]) : 1);
  }
  return top === 0 ? name.trim() : `${base} ${top + 1}`;
}

/** `token.create` — DM places any unit with any values (SPEC §8.5 Creation; Quick Unit, AC-TOK-09). */
export const tokenCreate: CommandDef<z.infer<typeof TokenCreate>, { tokenId: string }> = {
  type: "token.create",
  schema: TokenCreate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    mustGet(ctx, "scene", p.sceneId);
    assertAsset(ctx, p.appearance.assetId);
    assertAsset(ctx, p.appearance.portraitAssetId);
    const actor = p.actorId ? mustGet(ctx, "actor", p.actorId) : null;
    const isCharacter = actor?.kind === "character";
    const link = p.link ?? (isCharacter ? "linked" : "unlinked");
    // An unlinked token made from a character or creature starts with a copy of its sheet's numbers and status (ten
    // goblins from one entry each keep their own HP, AC-TOK-13); otherwise from the defaults for its size.
    const fromActor =
      actor && link === "unlinked" ? effectiveTokenState({ link: "linked" } as TokenEntity, actor) : null;
    const size = p.stats?.size ?? (fromActor ? fromActor.stats.size : p.size);
    const stats: TokenStats | null =
      link === "linked"
        ? null
        : ({
            ...(fromActor ? clone(fromActor.stats) : defaultStats(size)),
            ...(p.stats ? clone(p.stats) : {}),
            size,
          } as TokenStats);
    const hr = ctx.model.campaign.houseRules;
    const token: TokenEntity = {
      id: newId("tok"),
      sceneId: p.sceneId,
      actorId: actor?.id ?? null,
      link,
      // A character's token is the character (its own name); a creature placed beside its twins gets its number.
      name: link === "linked" ? p.name : numberedName(ctx, p.sceneId, p.name),
      pos: inBounds(ctx, p.sceneId, p.pos),
      elevation: p.elevation,
      rotationDeg: 0,
      sizeFt: p.sizeFt ?? SIZE_BASE_FT[size],
      appearance: { ...p.appearance },
      ownerIds: p.ownerIds,
      disposition: p.disposition,
      hidden: p.hidden,
      revealTo: "vision",
      hpDisplay: p.hpDisplay ?? (isCharacter || p.stats?.isPC ? "exact" : hr.npcHpDisplay),
      stats,
      status: link === "linked" ? null : clone(fromActor ? fromActor.status : EMPTY_STATUS),
      overrides: {},
      lightId: null,
      locked: false,
      dmNote: "",
      moveMode: "walk",
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    return {
      ops: [createOp("token", token)],
      summary: `Placed ${token.name}`,
      sceneId: p.sceneId,
      result: { tokenId: token.id },
    };
  },
};

const OWNER_FIELDS = new Set(["appearance", "name"]);

type AppearancePatchT = NonNullable<z.infer<typeof TokenUpdate>["appearance"]>;
type StatsPatchT = NonNullable<z.infer<typeof TokenUpdate>["stats"]>;

/** Field-by-field appearance merge; `null` clears an optional field (e.g. back to no image). */
function mergeAppearance(cur: TokenEntity["appearance"], p: AppearancePatchT): TokenEntity["appearance"] {
  const next: TokenEntity["appearance"] = { ...cur };
  if (p.mode !== undefined) next.mode = p.mode;
  if (p.scale !== undefined) next.scale = p.scale;
  if (p.offsetY !== undefined) next.offsetY = p.offsetY;
  if (p.rotationOffsetDeg !== undefined) next.rotationOffsetDeg = p.rotationOffsetDeg;
  for (const k of ["assetId", "portraitAssetId", "tint"] as const) {
    const v = p[k];
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = v;
  }
  return next;
}

/** Deep merge of a stats patch (speeds, senses and saves merge key by key). */
function mergeStats(cur: TokenStats, p: StatsPatchT): TokenStats {
  const next: TokenStats = clone(cur);
  const { speeds, senses, saves, ...flat } = p;
  for (const [k, v] of Object.entries(flat))
    if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = clone(v);
  if (speeds)
    for (const [k, v] of Object.entries(speeds))
      if (v !== undefined) (next.speeds as unknown as Record<string, unknown>)[k] = v;
  if (senses)
    for (const [k, v] of Object.entries(senses))
      if (v !== undefined) (next.senses as unknown as Record<string, unknown>)[k] = v;
  if (saves) next.saves = { ...next.saves, ...saves };
  if (next.hp > next.hpMax && p.hp === undefined) next.hp = next.hpMax;
  return next;
}

/**
 * The DM's per-token overrides (§8.19) applied: null clears one; bonus movement's end is fixed now from the scene's
 * combat — "this turn" lasts through the current round, "N rounds" through the round N − 1 after it (§19.4).
 */
function withOverrides(
  ctx: Parameters<CommandDef["plan"]>[0],
  t: TokenEntity,
  cur: TokenEntity["overrides"],
  p: NonNullable<z.infer<typeof TokenUpdate>["overrides"]>,
): TokenEntity["overrides"] {
  const next = { ...cur };
  const round = combatOn(ctx.model, t.sceneId)?.round ?? 1;
  if (p.speedOverride !== undefined) {
    if (p.speedOverride === null) delete next.speedOverride;
    else next.speedOverride = p.speedOverride;
  }
  if (p.bonusMove !== undefined) {
    if (p.bonusMove === null || p.bonusMove.ft <= 0) delete next.bonusMove;
    else
      next.bonusMove = {
        ft: p.bonusMove.ft,
        until: p.bonusMove.until,
        ...(p.bonusMove.until === "turn" ? { untilRound: round } : {}),
        ...(p.bonusMove.until === "rounds"
          ? { rounds: p.bonusMove.rounds ?? 1, untilRound: round + (p.bonusMove.rounds ?? 1) - 1 }
          : {}),
      };
  }
  for (const k of ["freeMovement", "lockMovement", "ignoreConditionSpeed", "countAsMovement"] as const)
    if (p[k] !== undefined) {
      if (p[k]) next[k] = true;
      else delete next[k];
    }
  return next;
}

/** `token.update` — DMs change anything; a token's owners may change its appearance and name. */
export const tokenUpdate: CommandDef<z.infer<typeof TokenUpdate>> = {
  type: "token.update",
  schema: TokenUpdate,
  undoable: true,
  authorize(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    if (isDm(ctx.actor.role)) return;
    const keys = Object.keys(p).filter((k) => k !== "tokenId");
    if (!controlsToken(ctx.actor.role, ctx.actor.userId, t) || keys.some((k) => !OWNER_FIELDS.has(k))) {
      throw new GloamError("FORBIDDEN");
    }
  },
  plan(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    if (p.appearance) {
      assertAsset(ctx, p.appearance.assetId ?? undefined);
      assertAsset(ctx, p.appearance.portraitAssetId ?? undefined);
    }
    const patch: Partial<TokenEntity> = {};
    if (p.name !== undefined) patch.name = p.name;
    if (p.elevation !== undefined) patch.elevation = p.elevation;
    if (p.rotationDeg !== undefined) patch.rotationDeg = ((p.rotationDeg % 360) + 360) % 360;
    if (p.disposition !== undefined) patch.disposition = p.disposition;
    if (p.hpDisplay !== undefined) patch.hpDisplay = p.hpDisplay;
    if (p.ownerIds !== undefined) patch.ownerIds = p.ownerIds;
    if (p.hidden !== undefined) patch.hidden = p.hidden;
    if (p.revealTo !== undefined) patch.revealTo = p.revealTo;
    if (p.locked !== undefined) patch.locked = p.locked;
    if (p.dmNote !== undefined) patch.dmNote = p.dmNote;
    if (p.shareVisionWith !== undefined)
      patch.overrides = { ...t.overrides, shareVisionWith: [...new Set(p.shareVisionWith)] };
    if (p.overrides)
      patch.overrides = withOverrides(ctx, t, { ...t.overrides, ...patch.overrides }, p.overrides);
    if (p.appearance) patch.appearance = mergeAppearance(t.appearance, p.appearance);
    if (p.size !== undefined) {
      patch.sizeFt = SIZE_BASE_FT[p.size];
      if (t.stats) patch.stats = { ...(patch.stats ?? t.stats), size: p.size };
    }
    if (p.sizeFt !== undefined) patch.sizeFt = p.sizeFt;
    if (p.stats) {
      if (!t.stats) throw new GloamError("INVALID", "A linked token's numbers live on its character sheet.");
      patch.stats = mergeStats(patch.stats ?? t.stats, p.stats);
    }
    const ops = setOps("token", t, patch);
    if (ops.length)
      ops.push({ k: "set", e: "token", id: t.id, path: ["updatedAt"], value: ctx.now, prev: t.updatedAt });
    return { ops, summary: `Updated ${t.name}`, sceneId: t.sceneId };
  },
};

/** `token.place` — DM teleport / paste (no path, ignores budgets and blocking; SPEC §8.6 DM moves). */
export const tokenPlace: CommandDef<z.infer<typeof TokenPlace>> = {
  type: "token.place",
  schema: TokenPlace,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    const patch: Partial<TokenEntity> = { pos: inBounds(ctx, t.sceneId, p.pos) };
    if (p.elevation !== undefined) patch.elevation = p.elevation;
    const ops = setOps("token", t, patch);
    const light = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
    if (light && patch.pos) ops.push(...setOps("light", light, { pos: patch.pos }));
    return { ops, summary: `Moved ${t.name}`, sceneId: t.sceneId };
  },
};

/** `token.delete` — removes tokens and the lights they carry (undoable). */
export const tokenDelete: CommandDef<z.infer<typeof TokenDelete>> = {
  type: "token.delete",
  schema: TokenDelete,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const ops: Op[] = [];
    let sceneId: string | null = null;
    for (const id of p.tokenIds) {
      const t = ctx.model.get("token", id);
      if (!t) continue;
      sceneId = t.sceneId;
      const light = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
      if (light) ops.push(deleteOp("light", light));
      ops.push(deleteOp("token", t));
    }
    const n = p.tokenIds.length;
    return {
      ops,
      summary:
        n === 1
          ? `Deleted ${ctx.model.get("token", p.tokenIds[0] as string)?.name ?? "a token"}`
          : `Deleted ${n} tokens`,
      sceneId,
    };
  },
};

/** What a relink would replace: the token's own numbers that differ from its character's. */
function relinkLosses(t: TokenEntity, actor: ActorLike): string[] {
  if (!t.stats) return [];
  const own = { stats: t.stats, status: t.status ?? EMPTY_STATUS };
  const sheet = effectiveTokenState({ ...t, link: "linked" }, actor);
  const out: string[] = [];
  if (own.stats.hp !== sheet.stats.hp || own.stats.hpMax !== sheet.stats.hpMax)
    out.push(`HP ${own.stats.hp}/${own.stats.hpMax} (the sheet has ${sheet.stats.hp}/${sheet.stats.hpMax})`);
  if (own.stats.hpTemp !== sheet.stats.hpTemp) out.push(`temporary HP ${own.stats.hpTemp}`);
  if (own.stats.ac !== sheet.stats.ac) out.push(`AC ${own.stats.ac}`);
  const conds = (s: TokenStatusT) =>
    s.conditions
      .map((c) => c.id)
      .sort()
      .join(",");
  if (conds(own.status) !== conds(sheet.status))
    out.push(
      own.status.conditions.length
        ? `conditions (${own.status.conditions.map((c) => c.id).join(", ")})`
        : "conditions",
    );
  if (own.status.exhaustion !== sheet.status.exhaustion) out.push(`exhaustion ${own.status.exhaustion}`);
  return out;
}

/**
 * `token.setLink` (DM) — a token becomes a view of its character, or its own copy (SPEC §8.5, AC-TOK-13): unlinking
 * copies the current values; relinking replaces the token's own values with the sheet's, so it asks first — refused
 * as CONFLICT listing what would be lost, unless `overwrite`. A relinked token takes its character's name and size.
 */
export const tokenSetLink: CommandDef<z.infer<typeof TokenSetLink>> = {
  type: "token.setLink",
  schema: TokenSetLink,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    if (t.link === p.link) return { ops: [], summary: "", sceneId: t.sceneId };
    const actor = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
    if (!actor || actor.deletedAt !== null)
      throw new GloamError("INVALID", "This token has no character sheet to link to.");
    if (p.link === "unlinked") {
      const cur = effectiveTokenState(t, actor);
      const ops = setOps("token", t, {
        link: "unlinked",
        stats: clone(cur.stats),
        status: clone(cur.status),
      });
      return { ops, summary: `Unlinked ${t.name} from its sheet`, sceneId: t.sceneId };
    }
    const losses = relinkLosses(t, actor);
    if (losses.length && !p.overwrite)
      throw new GloamError(
        "CONFLICT",
        `Relinking replaces this token's ${losses.join(", ")} with the sheet's.`,
        {
          losses,
        },
      );
    const core = (actor.sheet as { core?: { name?: string; size?: Size } }).core;
    const ops = setOps("token", t, {
      link: "linked",
      stats: null,
      status: null,
      ...(core?.name ? { name: core.name } : {}),
      ...(core?.size ? { sizeFt: SIZE_BASE_FT[core.size] } : {}),
    });
    return { ops, summary: `Linked ${t.name} to its sheet`, sceneId: t.sceneId };
  },
};

/** `token.duplicate` — copies tokens (with their own stats) at an offset or at the cursor (Ctrl/Cmd+V). */
export const tokenDuplicate: CommandDef<z.infer<typeof TokenDuplicate>, { tokenIds: string[] }> = {
  type: "token.duplicate",
  schema: TokenDuplicate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const src = p.tokenIds.map((id) => mustGet(ctx, "token", id));
    const first = src[0] as TokenEntity;
    const off = p.at ? { x: p.at.x - first.pos.x, y: p.at.y - first.pos.y } : (p.offset ?? { x: 5, y: 5 });
    const ops: Op[] = [];
    const ids: string[] = [];
    const named: string[] = [];
    for (const t of src) {
      const name = numberedName(ctx, t.sceneId, t.name, named);
      named.push(name);
      const copy: TokenEntity = {
        ...clone(t),
        name,
        id: newId("tok"),
        link: "unlinked",
        stats: t.stats ? clone(t.stats) : null,
        status: t.status ? clone(t.status) : clone(EMPTY_STATUS),
        pos: inBounds(ctx, t.sceneId, { x: t.pos.x + off.x, y: t.pos.y + off.y }),
        lightId: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      if (t.link === "linked") continue;
      ids.push(copy.id);
      ops.push(createOp("token", copy));
    }
    return {
      ops,
      summary: `Duplicated ${ids.length} token${ids.length === 1 ? "" : "s"}`,
      sceneId: first.sceneId,
      result: { tokenIds: ids },
    };
  },
};

/** Whoever controls the token (its owners, DMs) may raise, lower and turn it (SPEC §13.5 controller commands). */
function requireController(ctx: CommandCtx, p: { tokenId: string }): void {
  const t = mustGet(ctx, "token", p.tokenId);
  if (!controlsToken(ctx.actor.role, ctx.actor.userId, t)) throw new GloamError("FORBIDDEN");
  if (t.locked && !isDm(ctx.actor.role)) throw new GloamError("FORBIDDEN", "The DM locked this token.");
}

/**
 * A player's height change in a fight (§16.4; rules audit A3): it's movement — on the creature's turn, a flier's, able
 * to move, paid for foot for foot out of what's left (the DM, free movement and exploration aren't held to it).
 * Returns the feet it costs, or null when it isn't counted.
 */
function elevationCost(ctx: CommandCtx, t: TokenEntity, to: number): number | null {
  if (isDm(ctx.actor.role)) return null;
  const c = combatOn(ctx.model, t.sceneId);
  const d = c ? dataOf(c) : null;
  if (!c || !d?.combatants.some((e) => e.tokenId === t.id)) return null;
  if (d.freeMovement || t.overrides.freeMovement) return null;
  if (!onItsTurn(ctx, c, t))
    throw new GloamError(
      "NOT_YOUR_TURN",
      d.begun ? "It isn't this creature's turn." : "Initiative is still being found.",
    );
  const actor = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
  const { stats, status } = effectiveTokenState(t, actor);
  if (!(stats.speeds.fly > 0))
    throw new GloamError("INVALID", `${t.name} can't fly — only a flier rises or sinks in a fight.`);
  if (!t.overrides.ignoreConditionSpeed) {
    const zero = speedZeroCondition(
      status.conditions.map((x) => x.id),
      ctx.model.campaign.rulesPack,
    );
    if (zero) throw new GloamError("SPEED_ZERO", `${t.name} can't move — ${statusName(zero)}.`);
  }
  const cost = Math.abs(to - t.elevation);
  const m = movementOf(ctx.model, t);
  const left = m ? Math.max(0, m.budget - m.used) : 0;
  if (cost > left + 0.05)
    throw new GloamError("OVER_BUDGET", `That's ${cost} ft; ${Math.floor(left)} ft of movement left.`);
  return cost;
}

/** `token.elevation` — absolute or relative, snapped to 5-ft steps (AC-TOK-07's stepper; P3 adds Alt+wheel). */
export const tokenElevation: CommandDef<z.infer<typeof TokenElevation>> = {
  type: "token.elevation",
  schema: TokenElevation,
  undoable: true,
  authorize: requireController,
  plan(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    const raw = p.elevation ?? t.elevation + (p.delta ?? 0);
    const elevation = Math.max(-1000, Math.round(raw / 5) * 5);
    const cost = elevationCost(ctx, t, elevation);
    const ops = setOps("token", t, { elevation });
    // In a fight, on its turn: what it spent, as a segment of its movement (undo refunds it).
    const c = cost !== null && ops.length ? combatOn(ctx.model, t.sceneId) : undefined;
    const turn = c ? dataOf(c).turn : null;
    if (c && turn?.tokenId === t.id && cost !== null)
      for (const op of [
        setPathOp("combat", c, ["data", "turn", "usedFt"], turn.usedFt + cost),
        setPathOp("combat", c, ["data", "turn", "segments"], [...turn.segments, { cost }]),
      ])
        if (op) ops.push(op);
    const light = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
    if (light && ops.length) ops.push(...setOps("light", light, { elevation: elevation + 3 }));
    return { ops, summary: `${t.name} to ${elevation} ft`, sceneId: t.sceneId };
  },
};

const MOVING = {
  walk: "walking",
  fly: "flying",
  swim: "swimming",
  climb: "climbing",
  burrow: "burrowing",
} as const;

/**
 * `token.moveMode` (controller or DM; rules audit C1): the speed it moves by now — one it has (walking always), not
 * flying while Prone (it stands first) unless it hovers, and not leaving the air above the ground but by flying down.
 * Its budget in a fight is the new speed's, less what it has moved this turn (SRD 5.2.1 p. 188).
 */
export const tokenMoveMode: CommandDef<z.infer<typeof TokenMoveMode>, { mode: string }> = {
  type: "token.moveMode",
  schema: TokenMoveMode,
  undoable: true,
  authorize(ctx, p) {
    requireController(ctx, p);
    const t = mustGet(ctx, "token", p.tokenId);
    const a = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
    const { stats, status } = effectiveTokenState(t, a && a.deletedAt === null ? a : undefined);
    if (p.mode !== "walk" && !((stats.speeds[p.mode] ?? 0) > 0))
      throw new GloamError("INVALID", `${t.name} has no ${MOVING[p.mode]} speed.`);
    if (p.mode === "fly" && !stats.speeds.hover && status.conditions.some((c) => c.id === "prone"))
      throw new GloamError("INVALID", `${t.name} is Prone: it stands before it flies.`);
    if (p.mode !== "fly" && t.moveMode === "fly" && t.elevation > 0 && !isDm(ctx.actor.role))
      throw new GloamError("INVALID", `${t.name} is ${t.elevation} ft up: it flies down first.`);
  },
  plan(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    return {
      ops: setOps("token", t, { moveMode: p.mode }),
      summary: `${t.name} moves by ${MOVING[p.mode]}`,
      sceneId: t.sceneId,
      result: { mode: p.mode },
    };
  },
};

/** `token.facing` — turn the token (SPEC §8.5 Facing). */
export const tokenFacing: CommandDef<z.infer<typeof TokenFacing>> = {
  type: "token.facing",
  schema: TokenFacing,
  undoable: true,
  authorize: requireController,
  plan(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    const raw = p.rotationDeg ?? t.rotationDeg + (p.delta ?? 0);
    const rotationDeg = ((raw % 360) + 360) % 360;
    return { ops: setOps("token", t, { rotationDeg }), summary: `Turned ${t.name}`, sceneId: t.sceneId };
  },
};

export const TOKEN_COMMANDS = [
  tokenSetLink,
  tokenElevation,
  tokenMoveMode,
  tokenFacing,
  tokenCreate,
  tokenUpdate,
  tokenPlace,
  tokenDelete,
  tokenDuplicate,
] as CommandDef<never, unknown>[];
