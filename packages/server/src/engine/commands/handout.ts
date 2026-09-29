import {
  GloamError,
  HandoutCreate,
  HandoutDelete,
  HandoutShow,
  HandoutUpdate,
  type HandoutView,
  NoteSecret,
} from "@gloam/shared/protocol";
import type { z } from "zod";
import { newId } from "../../ids.ts";
import type { HandoutEntity } from "../codecs.ts";
import type { CommandCtx, CommandDef, RoomEvent } from "../commandBus.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps } from "../plan.ts";

/** A handout or note as a DM's list has it (with who has it) or as a player's (without). */
export function handoutView(h: HandoutEntity, dm: boolean): HandoutView {
  return {
    id: h.id,
    kind: h.kind,
    title: h.title,
    bodyMd: h.bodyMd,
    imageAssetId: h.imageAssetId,
    createdAt: h.createdAt,
    ...(dm ? { recipients: h.recipients } : {}),
  };
}

/** Whether a person has been given it. */
export function holds(h: HandoutEntity, userId: string): boolean {
  return h.recipients === "all" || h.recipients.includes(userId);
}

/** An image for a handout: one of this campaign's approved pictures. */
function checkImage(ctx: CommandCtx, assetId: string | null | undefined): void {
  if (!assetId) return;
  const a = ctx.model.get("asset", assetId);
  if (!a || a.deletedAt !== null || a.status !== "approved" || a.campaignId !== ctx.model.campaign.id)
    throw new GloamError("NOT_FOUND", "That picture isn't in the library.");
  if (ctx.app.assets.file(a.fileId)?.kind !== "image")
    throw new GloamError("INVALID", "A handout's picture must be an image.");
}

/** The DMs' lists follow every change (a draft, an edit, who has it). */
const toDms = (h: HandoutEntity | null, id: string): RoomEvent => ({
  name: "handout.changed",
  payload: h ? handoutView(h, true) : { id, deleted: true },
  to: { dms: true },
});

/**
 * Handouts (SPEC §8.18; DM): made as drafts — a title, Markdown text, a picture — edited, deleted (undoable), and
 * shown to everyone or to chosen players, who each keep it in their Handouts list. Showing can't be taken back (they
 * have read it), so it isn't undoable.
 */
export const handoutCreate: CommandDef<z.infer<typeof HandoutCreate>, { handoutId: string }> = {
  type: "handout.create",
  schema: HandoutCreate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    checkImage(ctx, p.imageAssetId);
    const h: HandoutEntity = {
      id: newId("hnd"),
      campaignId: ctx.model.campaign.id,
      kind: "handout",
      title: p.title,
      bodyMd: p.bodyMd,
      imageAssetId: p.imageAssetId,
      recipients: [],
      createdBy: ctx.actor.userId,
      createdAt: ctx.now,
    };
    return {
      ops: [createOp("handout", h)],
      summary: `Wrote the handout "${h.title}"`,
      result: { handoutId: h.id },
      events: [toDms(h, h.id)],
    };
  },
};

export const handoutUpdate: CommandDef<z.infer<typeof HandoutUpdate>> = {
  type: "handout.update",
  schema: HandoutUpdate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const h = mustGet(ctx, "handout", p.handoutId);
    if (p.imageAssetId !== undefined) checkImage(ctx, p.imageAssetId);
    const patch: Partial<HandoutEntity> = {
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.bodyMd !== undefined ? { bodyMd: p.bodyMd } : {}),
      ...(p.imageAssetId !== undefined ? { imageAssetId: p.imageAssetId } : {}),
    };
    const next = { ...h, ...patch };
    // Those who have it see the change too.
    const users = h.recipients === "all" ? null : h.recipients;
    return {
      ops: setOps("handout", h, patch),
      summary: `Edited the handout "${next.title}"`,
      events: [
        toDms(next, h.id),
        ...(h.recipients.length || h.recipients === "all"
          ? [
              users
                ? { name: "handout.update", payload: handoutView(next, false), to: { users } }
                : { name: "handout.update", payload: handoutView(next, false), to: { all: true as const } },
            ]
          : []),
      ],
    };
  },
};

export const handoutDelete: CommandDef<z.infer<typeof HandoutDelete>> = {
  type: "handout.delete",
  schema: HandoutDelete,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const h = mustGet(ctx, "handout", p.handoutId);
    return {
      ops: [deleteOp("handout", h)],
      summary: `Deleted the ${h.kind === "note" ? "note" : `handout "${h.title}"`}`,
      events: [toDms(null, h.id), { name: "handout.gone", payload: { id: h.id }, to: { all: true } }],
    };
  },
};

export const handoutShow: CommandDef<z.infer<typeof HandoutShow>, { recipients: string[] | "all" }> = {
  type: "handout.show",
  schema: HandoutShow,
  undoable: false,
  authorize: requireDm,
  plan(ctx, p) {
    const h = mustGet(ctx, "handout", p.handoutId);
    if (h.kind !== "handout") throw new GloamError("INVALID", "That's a note: send it with Secret note.");
    const players = new Set(ctx.app.campaigns.members(ctx.model.campaign.id).map((m) => m.userId));
    if (p.to !== "all")
      for (const u of p.to)
        if (!players.has(u)) throw new GloamError("NOT_FOUND", "That player isn't in this campaign.");
    const recipients: string[] | "all" =
      p.to === "all" || h.recipients === "all" ? "all" : [...new Set([...h.recipients, ...p.to])];
    const view = handoutView(h, false);
    // Unfurled for those it's new to (a second showing doesn't unroll it again for those who have it).
    const had = h.recipients === "all" ? null : new Set(h.recipients);
    const fresh = p.to === "all" ? null : p.to.filter((u) => !had || !had.has(u));
    const reveal: RoomEvent[] =
      h.recipients === "all" || (fresh && !fresh.length)
        ? []
        : [
            {
              name: "handout",
              payload: view,
              to: fresh ? { users: fresh } : { all: true, exceptUsers: had ? [...had] : [] },
            },
          ];
    return {
      ops: setOps("handout", h, { recipients }),
      summary: `Showed the handout "${h.title}" to ${p.to === "all" ? "everyone" : `${p.to.length} ${p.to.length === 1 ? "player" : "players"}`}`,
      result: { recipients },
      events: [
        toDms({ ...h, recipients }, h.id),
        // The reveal: a parchment card unfurling on each recipient's screen.
        ...reveal,
        {
          name: "log.append",
          payload: {
            kind: "handout",
            text: `The DM showed the handout "${h.title}"${p.to === "all" ? "" : ` to ${p.to.length === 1 ? "a player" : `${p.to.length} players`}`}.`,
            visibility: p.to === "all" ? "everyone" : `only:${p.to.join(",")}`,
          },
          to: { dms: true },
        },
      ],
    };
  },
};

/** `note.secret` (DM): a note for one player alone; kept in their Handouts list, never shown to anyone else. */
export const noteSecret: CommandDef<z.infer<typeof NoteSecret>, { handoutId: string }> = {
  type: "note.secret",
  schema: NoteSecret,
  undoable: false,
  authorize: requireDm,
  plan(ctx, p) {
    const member = ctx.app.campaigns.members(ctx.model.campaign.id).find((m) => m.userId === p.userId);
    if (!member) throw new GloamError("NOT_FOUND", "That player isn't in this campaign.");
    const h: HandoutEntity = {
      id: newId("hnd"),
      campaignId: ctx.model.campaign.id,
      kind: "note",
      title: "A secret note",
      bodyMd: p.text,
      imageAssetId: null,
      recipients: [p.userId],
      createdBy: ctx.actor.userId,
      createdAt: ctx.now,
    };
    return {
      ops: [createOp("handout", h)],
      summary: `Sent a secret note to ${member.displayName}`,
      result: { handoutId: h.id },
      events: [toDms(h, h.id), { name: "note", payload: handoutView(h, false), to: { users: [p.userId] } }],
    };
  },
};

export const HANDOUT_COMMANDS = [
  handoutCreate,
  handoutUpdate,
  handoutDelete,
  handoutShow,
  noteSecret,
] as CommandDef<never, unknown>[];
