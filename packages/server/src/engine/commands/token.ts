import { SIZE_BASE_FT, type Size } from "@gloam/shared";
import {
  GloamError,
  TokenCreate,
  TokenDelete,
  TokenDuplicate,
  TokenElevation,
  TokenFacing,
  TokenPlace,
  TokenSetLink,
  TokenUpdate,
} from "@gloam/shared/protocol";
import { type ActorLike, controlsToken, effectiveTokenState, isDm } from "@gloam/shared/rules";
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
import { createOp, deleteOp, mustGet, requireDm, setOps } from "../plan.ts";

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
      name: p.name,
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
    for (const t of src) {
      const copy: TokenEntity = {
        ...clone(t),
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
    const ops = setOps("token", t, { elevation });
    const light = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
    if (light && ops.length) ops.push(...setOps("light", light, { elevation: elevation + 3 }));
    return { ops, summary: `${t.name} to ${elevation} ft`, sceneId: t.sceneId };
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
  tokenFacing,
  tokenCreate,
  tokenUpdate,
  tokenPlace,
  tokenDelete,
  tokenDuplicate,
] as CommandDef<never, unknown>[];
