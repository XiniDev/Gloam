import { LIGHT_PRESETS, SIZE_BASE_FT } from "@gloam/shared";
import {
  ActorChange,
  ActorCreate,
  ActorDelete,
  ActorQuickCreate,
  ActorReplace,
  ActorSetLock,
  ActorSetOwner,
  GloamError,
  TemplateDelete,
  TemplateSave,
} from "@gloam/shared/protocol";
import {
  applyChanges,
  diffSheet,
  isDm,
  lockedChanges,
  patchOf,
  pathLabel,
  projectSheet,
  type SheetChange,
  statusFromActor,
  statusFromSheet,
  storedSheet,
} from "@gloam/shared/rules";
import {
  type CustomBlock,
  EMPTY_STATUS,
  type LightEntity,
  Sheet,
  type TokenEntity,
  type TokenStatusT,
} from "@gloam/shared/schemas";
import type { z } from "zod";
import { newId } from "../../ids.ts";
import type { ActorEntity, TemplateEntity } from "../codecs.ts";
import type { CommandCtx, CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps, setPathOp } from "../plan.ts";
import { assertAsset } from "./token.ts";

/**
 * Character sheets (SPEC §8.10): creating characters (a whole sheet, an import, a template or the quick-create
 * dialog), editing them — every edit checked against the whole sheet schema and, for players, the sheet's lock
 * (§8.10 Ownership and locks: a refused edit names the locked fields so the player can propose it) — replacing one on
 * import, locking, handing over and deleting them, and saving a sheet's custom-block layout as a template. A sheet
 * edit is a `sheet` op (a JSON Patch and its inverse), so it undoes path by path; the character's status (conditions,
 * exhaustion, death saves, concentration) lives in the actor's status and the sheet's fields for it are routed there
 * (sheetStatus.ts). Linked tokens follow their sheet: name, art, size and the light the character carries.
 */

/** The whole sheet schema (Appendix F.3); a document that isn't one is refused with readable paths. */
export function checkSheet(doc: unknown): Sheet {
  const r = Sheet.safeParse(doc);
  if (r.success) return r.data;
  const issues = r.error.issues
    .slice(0, 20)
    .map((i) => ({ path: i.path.join(".") || "(the sheet)", message: i.message }));
  throw new GloamError(
    "INVALID",
    issues
      .slice(0, 3)
      .map((i) => `${i.path}: ${i.message}`)
      .join("; "),
    { issues },
  );
}

/** An actor's sheet as it's read: the stored document with its status filled in. */
export function readSheet(actor: ActorEntity): Sheet {
  const r = Sheet.safeParse(actor.sheet);
  const sheet = r.success ? r.data : Sheet.parse({ core: { name: looseName(actor.sheet) } });
  return projectSheet(sheet, statusFromActor(actor.status));
}

function looseName(doc: Record<string, unknown>): string {
  const core = doc.core as { name?: unknown } | undefined;
  return typeof core?.name === "string" && core.name.trim() ? core.name.trim().slice(0, 120) : "Unnamed";
}

/** DMs edit any sheet; players their own characters. */
function mayEdit(ctx: CommandCtx, actor: ActorEntity): boolean {
  return isDm(ctx.actor.role) || (ctx.actor.role === "player" && actor.ownerUserId === ctx.actor.userId);
}

function live(ctx: CommandCtx, actorId: string): ActorEntity {
  const a = mustGet(ctx, "actor", actorId);
  if (a.deletedAt !== null) throw new GloamError("NOT_FOUND", "That character no longer exists.");
  return a;
}

/** Every image a sheet points at is a usable library asset (the ones it already had stay as they are). */
function assertSheetAssets(ctx: CommandCtx, before: Sheet | null, after: Sheet): void {
  const ids = (s: Sheet | null) =>
    new Set(
      [
        s?.core.portraitAssetId,
        s?.core.tokenAssetId,
        ...(s?.custom ?? []).map((b) => (b.type === "image" ? b.assetId : undefined)),
      ].filter((x): x is string => typeof x === "string"),
    );
  const had = ids(before);
  for (const id of ids(after)) if (!had.has(id)) assertAsset(ctx, id);
  const light = after.core.light;
  if (light && light !== before?.core.light && !LIGHT_PRESETS.some((l) => l.id === light))
    throw new GloamError("INVALID", "That light source isn't known.");
}

/** "Fighter 3", "Rogue 2 / Wizard 3", "Cleric" (level 1) → the sheet's classes. */
export function parseClassLevels(text: string): { name: string; level: number }[] {
  return text
    .split(/[/,;+]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((part) => {
      const m = part.match(/^(.*?)\s*(\d{1,2})$/);
      const name = (m ? (m[1] as string) : part).trim() || part;
      const level = m ? Math.min(20, Math.max(1, Number(m[2]))) : 1;
      return { name: name.slice(0, 120), level };
    });
}

/**
 * A template's layout from a sheet's custom blocks: their kinds, titles and shape kept (a table's columns and rows,
 * a checklist's items, a list's keys, a counter's maximum), what's been filled in cleared (numbers to 0, counters
 * full, checklists unticked, values emptied).
 */
export function layoutOf(blocks: readonly CustomBlock[]): CustomBlock[] {
  return blocks.map((b): CustomBlock => {
    switch (b.type) {
      case "number":
        return { ...b, value: 0 };
      case "counter":
        return { ...b, value: b.max };
      case "checklist":
        return { ...b, items: b.items.map((i) => ({ ...i, done: false })) };
      case "keyValue":
        return { ...b, entries: b.entries.map((e) => ({ key: e.key, value: "" })) };
      default:
        return { ...b };
    }
  });
}

/** A template's blocks for a new character, each with a new id. */
function fromTemplate(ctx: CommandCtx, templateId: string | undefined): CustomBlock[] {
  if (!templateId) return [];
  const tpl = mustGet(ctx, "template", templateId);
  return (tpl.blocks as CustomBlock[]).map((b) => ({ ...b, id: newId("blk") }));
}

function ownerFor(ctx: CommandCtx, requested: string | null | undefined): string | null {
  if (!isDm(ctx.actor.role)) {
    if (requested && requested !== ctx.actor.userId)
      throw new GloamError("FORBIDDEN", "Players create their own characters.");
    return ctx.actor.userId;
  }
  if (!requested) return null;
  if (!ctx.app.campaigns.membership(ctx.model.campaign.id, requested))
    throw new GloamError("NOT_FOUND", "That person doesn't play in this campaign.");
  return requested;
}

function newActor(
  ctx: CommandCtx,
  kind: ActorEntity["kind"],
  owner: string | null,
  sheet: Sheet,
): ActorEntity {
  return {
    id: newId("act"),
    campaignId: ctx.model.campaign.id,
    kind,
    ownerUserId: owner,
    templateId: null,
    lockLevel: ctx.model.campaign.houseRules.sheetLockDefault,
    sheet: storedSheet(sheet) as unknown as Record<string, unknown>,
    status: statusFromSheet(sheet, EMPTY_STATUS) as unknown as Record<string, unknown>,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    deletedAt: null,
  };
}

function authorizeCreate(ctx: CommandCtx, p: { ownerUserId?: string | null | undefined }): void {
  if (ctx.actor.role === "spectator") throw new GloamError("FORBIDDEN", "Spectators watch.");
  ownerFor(ctx, p.ownerUserId);
}

/** `actor.create` — a character (or, for DMs, an NPC) from a whole sheet, an import, or a template. */
export const actorCreate: CommandDef<z.infer<typeof ActorCreate>, { actorId: string }> = {
  type: "actor.create",
  schema: ActorCreate,
  undoable: true,
  authorize(ctx, p) {
    authorizeCreate(ctx, p);
    if (p.kind === "npc") requireDm(ctx);
  },
  plan(ctx, p) {
    const doc = p.sheet ?? { core: { name: "New character" } };
    const base = checkSheet(doc);
    const sheet = p.templateId
      ? { ...base, custom: [...fromTemplate(ctx, p.templateId), ...base.custom] }
      : base;
    const checked = checkSheet(sheet);
    assertSheetAssets(ctx, null, checked);
    const actor = newActor(ctx, p.kind, ownerFor(ctx, p.ownerUserId), checked);
    if (p.templateId) actor.templateId = p.templateId;
    return {
      ops: [createOp("actor", actor)],
      summary: `Created ${checked.core.name}`,
      result: { actorId: actor.id },
    };
  },
};

/** `actor.quickCreate` — a playable character from one dialog (AC-SHEET-01): the rest can be filled in later. */
export const actorQuickCreate: CommandDef<z.infer<typeof ActorQuickCreate>, { actorId: string }> = {
  type: "actor.quickCreate",
  schema: ActorQuickCreate,
  undoable: true,
  authorize: authorizeCreate,
  plan(ctx, p) {
    const sheet = checkSheet({
      core: {
        name: p.name,
        classes: parseClassLevels(p.classLevel),
        hp: { max: p.hpMax, current: p.hpMax, temp: 0 },
        ac: { value: p.ac },
        speeds: { walk: p.speed },
        senses: { darkvision: p.darkvision },
        ...(p.portraitAssetId ? { portraitAssetId: p.portraitAssetId } : {}),
        ...(p.tokenAssetId ? { tokenAssetId: p.tokenAssetId } : {}),
      },
      custom: fromTemplate(ctx, p.templateId),
    });
    assertSheetAssets(ctx, null, sheet);
    const actor = newActor(ctx, "character", ownerFor(ctx, p.ownerUserId), sheet);
    if (p.templateId) actor.templateId = p.templateId;
    return {
      ops: [createOp("actor", actor)],
      summary: `Created ${sheet.core.name}`,
      result: { actorId: actor.id },
    };
  },
};

/**
 * The ops that make a sheet edit: the stored sheet's patch, the status the sheet's status fields now describe, and
 * the linked tokens following (name, art, size, carried light). `before`/`after` are the sheet as read.
 */
export function sheetEditOps(
  ctx: CommandCtx,
  actor: ActorEntity,
  before: Sheet,
  after: Sheet,
  /** The status as a whole (HP rules set markers and death saves the sheet's fields don't carry). */
  statusNext?: TokenStatusT,
): Op[] {
  const ops: Op[] = [];
  // Against the document as stored (not as parsed: parsing fills in defaults it may not have yet).
  const changes = diffSheet(actor.sheet, storedSheet(after));
  if (changes.length) {
    const { patch, inverse } = patchOf(changes);
    ops.push({ k: "sheet", actorId: actor.id, patch, inverse });
  }
  const prevStatus = statusFromActor(actor.status);
  const status = statusNext ?? statusFromSheet(after, prevStatus);
  const s = setPathOp("actor", actor, ["status"], status as unknown as TokenStatusT);
  if (s) ops.push(s);
  ops.push(...linkedTokenOps(ctx, actor, before, after));
  if (ops.length) ops.push(...setOps("actor", actor, { updatedAt: ctx.now }));
  return ops;
}

/** Linked tokens are views of their character (SPEC §8.5): they follow its name, art, size and carried light. */
function linkedTokenOps(ctx: CommandCtx, actor: ActorEntity, before: Sheet, after: Sheet): Op[] {
  const ops: Op[] = [];
  const b = before.core;
  const a = after.core;
  for (const t of ctx.model.all("token")) {
    if (t.actorId !== actor.id || t.link !== "linked") continue;
    if (a.name !== b.name) ops.push(...setOps("token", t, { name: a.name }));
    if (a.tokenAssetId !== b.tokenAssetId || a.portraitAssetId !== b.portraitAssetId) {
      const appearance = { ...t.appearance };
      if (a.tokenAssetId !== b.tokenAssetId) {
        if (a.tokenAssetId) appearance.assetId = a.tokenAssetId;
        else delete appearance.assetId;
      }
      if (a.portraitAssetId !== b.portraitAssetId) {
        if (a.portraitAssetId) appearance.portraitAssetId = a.portraitAssetId;
        else delete appearance.portraitAssetId;
      }
      ops.push(...setOps("token", t, { appearance }));
    }
    if (a.size !== b.size) ops.push(...setOps("token", t, { sizeFt: SIZE_BASE_FT[a.size] }));
    if (a.light !== b.light) ops.push(...carriedLightOps(ctx, t, a.light));
  }
  return ops;
}

/** The light a linked token carries, as its sheet says (light.carry's rules: one carried light per token). */
function carriedLightOps(ctx: CommandCtx, token: TokenEntity, presetId: string | undefined): Op[] {
  const cur = token.lightId ? ctx.model.get("light", token.lightId) : undefined;
  if (!presetId) return cur ? [...setOps("token", token, { lightId: null }), deleteOp("light", cur)] : [];
  const pre = LIGHT_PRESETS.find((l) => l.id === presetId);
  if (!pre) return [];
  const look = {
    preset: pre.id,
    bright: pre.bright,
    dim: pre.dim,
    coneDeg: pre.coneDeg,
    animation: pre.animation,
    color: pre.color,
    enabled: true,
    shuttered: false,
  };
  if (cur) return setOps("light", cur, look);
  const light: LightEntity = {
    id: newId("lgt"),
    sceneId: token.sceneId,
    tokenId: token.id,
    pos: { ...token.pos },
    elevation: 0,
    intensity: 1,
    directionDeg: 0,
    magical: false,
    pierceDarkness: false,
    dmOnly: false,
    ...look,
  };
  return [createOp("light", light), ...setOps("token", token, { lightId: light.id })];
}

/** A player's edit refused for its locked fields: the fields, what they are and what was asked (for a proposal). */
function refuseLocked(locked: SheetChange[]): never {
  const fields = locked
    .slice(0, 40)
    .map((c) => ({ path: pathLabel(c.path), before: c.before, after: c.after }));
  throw new GloamError(
    "LOCKED_SHEET",
    `Locked on this sheet: ${fields
      .slice(0, 4)
      .map((f) => f.path)
      .join(", ")}${fields.length > 4 ? "…" : ""}. You can propose the change to the DM.`,
    { locked: fields },
  );
}

/**
 * `actor.change` — edits applied onto the sheet as it is now (someone else's concurrent edit to another field isn't
 * lost), checked against the schema and, for a player, the sheet's lock.
 */
export const actorChange: CommandDef<z.infer<typeof ActorChange>, { updatedAt: number }> = {
  type: "actor.change",
  schema: ActorChange,
  undoable: true,
  authorize(ctx, p) {
    if (!mayEdit(ctx, live(ctx, p.actorId))) throw new GloamError("FORBIDDEN", "That isn't your sheet.");
  },
  plan(ctx, p) {
    const actor = live(ctx, p.actorId);
    const before = readSheet(actor);
    const after = checkSheet(applyChanges(before, p.changes as SheetChange[]));
    const locked = lockedChanges(actor.lockLevel, before, after, isDm(ctx.actor.role));
    if (locked.length) refuseLocked(locked);
    assertSheetAssets(ctx, before, after);
    const ops = sheetEditOps(ctx, actor, before, after);
    return { ops, summary: `Edited ${after.core.name}'s sheet`, result: { updatedAt: ctx.now } };
  },
};

/** `actor.replace` — the whole sheet at once (an import over an existing character, after its preview and diff). */
export const actorReplace: CommandDef<z.infer<typeof ActorReplace>, { updatedAt: number }> = {
  type: "actor.replace",
  schema: ActorReplace,
  undoable: true,
  authorize(ctx, p) {
    if (!mayEdit(ctx, live(ctx, p.actorId))) throw new GloamError("FORBIDDEN", "That isn't your sheet.");
  },
  plan(ctx, p) {
    const actor = live(ctx, p.actorId);
    const before = readSheet(actor);
    const after = checkSheet(p.sheet);
    const locked = lockedChanges(actor.lockLevel, before, after, isDm(ctx.actor.role));
    if (locked.length) refuseLocked(locked);
    assertSheetAssets(ctx, before, after);
    return {
      ops: sheetEditOps(ctx, actor, before, after),
      summary: `Imported ${after.core.name}'s sheet`,
      result: { updatedAt: ctx.now },
    };
  },
};

/** `actor.setLock` (DM) — Unlocked, Core locked or Fully locked (§8.10). */
export const actorSetLock: CommandDef<z.infer<typeof ActorSetLock>, void> = {
  type: "actor.setLock",
  schema: ActorSetLock,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const actor = live(ctx, p.actorId);
    const name = readSheet(actor).core.name;
    const label = { unlocked: "Unlocked", core: "Core locked", full: "Fully locked" }[p.level];
    return { ops: setOps("actor", actor, { lockLevel: p.level }), summary: `${name}'s sheet: ${label}` };
  },
};

/** `actor.setOwner` (DM) — who plays the character (or no one). */
export const actorSetOwner: CommandDef<z.infer<typeof ActorSetOwner>, void> = {
  type: "actor.setOwner",
  schema: ActorSetOwner,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const actor = live(ctx, p.actorId);
    const owner = ownerFor(ctx, p.ownerUserId);
    return {
      ops: setOps("actor", actor, { ownerUserId: owner }),
      summary: `${readSheet(actor).core.name} changed hands`,
    };
  },
};

/**
 * `actor.delete` — the DM, or a player their own unlocked character: it goes, and so do its linked tokens (their
 * carried lights with them). Unlinked copies keep their own numbers. Undoable.
 */
export const actorDelete: CommandDef<z.infer<typeof ActorDelete>, void> = {
  type: "actor.delete",
  schema: ActorDelete,
  undoable: true,
  authorize(ctx, p) {
    const actor = live(ctx, p.actorId);
    if (isDm(ctx.actor.role)) return;
    if (actor.ownerUserId !== ctx.actor.userId)
      throw new GloamError("FORBIDDEN", "That isn't your character.");
    if (actor.lockLevel !== "unlocked")
      throw new GloamError("LOCKED_SHEET", "Ask the DM to remove a locked sheet.");
  },
  plan(ctx, p) {
    const actor = live(ctx, p.actorId);
    const ops: Op[] = [];
    for (const t of ctx.model.all("token")) {
      if (t.actorId !== actor.id || t.link !== "linked") continue;
      const l = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
      if (l) ops.push(deleteOp("light", l));
      ops.push(deleteOp("token", t));
    }
    ops.push(...setOps("actor", actor, { deletedAt: ctx.now }));
    return { ops, summary: `Removed ${readSheet(actor).core.name}` };
  },
};

/** `template.save` — a sheet's custom-block layout, for new characters (AC-SHEET-04). The sheet's owner or a DM. */
export const templateSave: CommandDef<z.infer<typeof TemplateSave>, { templateId: string }> = {
  type: "template.save",
  schema: TemplateSave,
  undoable: true,
  authorize(ctx, p) {
    if (!mayEdit(ctx, live(ctx, p.fromActorId))) throw new GloamError("FORBIDDEN", "That isn't your sheet.");
  },
  plan(ctx, p) {
    const sheet = readSheet(live(ctx, p.fromActorId));
    if (!sheet.custom.length) throw new GloamError("INVALID", "That sheet has no custom blocks to save.");
    const tpl: TemplateEntity = {
      id: newId("tpl"),
      campaignId: ctx.model.campaign.id,
      name: p.name,
      blocks: layoutOf(sheet.custom),
      createdBy: ctx.actor.userId,
      createdAt: ctx.now,
    };
    return {
      ops: [createOp("template", tpl)],
      summary: `Saved the template “${p.name}”`,
      result: { templateId: tpl.id },
    };
  },
};

/** `template.delete` — the DM, or whoever saved it. */
export const templateDelete: CommandDef<z.infer<typeof TemplateDelete>, void> = {
  type: "template.delete",
  schema: TemplateDelete,
  undoable: true,
  authorize(ctx, p) {
    const tpl = mustGet(ctx, "template", p.templateId);
    if (!isDm(ctx.actor.role) && tpl.createdBy !== ctx.actor.userId)
      throw new GloamError("FORBIDDEN", "That template isn't yours.");
  },
  plan(ctx, p) {
    const tpl = mustGet(ctx, "template", p.templateId);
    return { ops: [deleteOp("template", tpl)], summary: `Deleted the template “${tpl.name}”` };
  },
};

export const ACTOR_COMMANDS = [
  actorCreate,
  actorQuickCreate,
  actorChange,
  actorReplace,
  actorSetLock,
  actorSetOwner,
  actorDelete,
  templateSave,
  templateDelete,
] as CommandDef<never, unknown>[];
