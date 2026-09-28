/**
 * Proposals (SPEC §8.10 Ownership and locks): a player's change to locked fields of their own sheet, kept for the DM,
 * who sees it as a before/after diff and approves it (applied onto the sheet as it is then) or denies it with a note.
 * Stored in SQLite so an unanswered proposal survives the table closing.
 */
import { GloamError, type ProposalView } from "@gloam/shared/protocol";
import { applyChanges, diffSheet, pathLabel, type SheetChange } from "@gloam/shared/rules";
import { Sheet } from "@gloam/shared/schemas";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { sheetProposals } from "../db/schema.ts";
import { newId } from "../ids.ts";

export type ProposalStatus = "pending" | "approved" | "denied" | "withdrawn";

export interface Proposal {
  id: string;
  campaignId: string;
  actorId: string;
  userId: string;
  changes: SheetChange[];
  note: string;
  status: ProposalStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/** How many unanswered proposals one player may have waiting on one sheet. */
export const PENDING_PER_SHEET = 20;

type Row = typeof sheetProposals.$inferSelect;

function fromRow(r: Row): Proposal {
  let changes: SheetChange[] = [];
  try {
    changes = JSON.parse(r.changesJson as string) as SheetChange[];
  } catch {
    changes = [];
  }
  return {
    id: r.id,
    campaignId: r.campaignId,
    actorId: r.actorId,
    userId: r.userId,
    changes,
    note: r.note,
    status: r.status as ProposalStatus,
    decidedBy: r.decidedBy,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}

export class ProposalService {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(p: {
    campaignId: string;
    actorId: string;
    userId: string;
    changes: SheetChange[];
    note: string;
  }): Proposal {
    const waiting = this.db
      .select()
      .from(sheetProposals)
      .where(
        and(
          eq(sheetProposals.actorId, p.actorId),
          eq(sheetProposals.userId, p.userId),
          eq(sheetProposals.status, "pending"),
        ),
      )
      .all().length;
    if (waiting >= PENDING_PER_SHEET)
      throw new GloamError(
        "RATE_LIMITED",
        "You have many changes waiting on this sheet — let the DM catch up.",
      );
    const row: Row = {
      id: newId("prp"),
      campaignId: p.campaignId,
      actorId: p.actorId,
      userId: p.userId,
      changesJson: JSON.stringify(p.changes),
      note: p.note,
      status: "pending",
      decidedBy: null,
      decisionNote: null,
      createdAt: Date.now(),
      decidedAt: null,
    };
    this.db.insert(sheetProposals).values(row).run();
    return fromRow(row);
  }

  get(id: string): Proposal | null {
    const r = this.db.select().from(sheetProposals).where(eq(sheetProposals.id, id)).get();
    return r ? fromRow(r) : null;
  }

  /** A campaign's proposals: the pending ones, and the latest decided (for the proposer's own list). */
  list(campaignId: string, opts: { userId?: string; limit?: number } = {}): Proposal[] {
    const where = opts.userId
      ? and(eq(sheetProposals.campaignId, campaignId), eq(sheetProposals.userId, opts.userId))
      : eq(sheetProposals.campaignId, campaignId);
    return this.db
      .select()
      .from(sheetProposals)
      .where(where)
      .orderBy(desc(sheetProposals.createdAt))
      .limit(opts.limit ?? 100)
      .all()
      .map(fromRow);
  }

  /** Marks a pending proposal decided; refuses one already decided (a second DM's click, a stale card). */
  decide(id: string, by: string, status: "approved" | "denied" | "withdrawn", note: string): Proposal {
    const cur = this.get(id);
    if (!cur) throw new GloamError("NOT_FOUND", "That proposal no longer exists.");
    if (cur.status !== "pending") throw new GloamError("CONFLICT", "That proposal was already answered.");
    const decidedAt = Date.now();
    this.db
      .update(sheetProposals)
      .set({ status, decidedBy: by, decisionNote: note || null, decidedAt })
      .where(eq(sheetProposals.id, id))
      .run();
    return { ...cur, status, decidedBy: by, decisionNote: note || null, decidedAt };
  }
}

/**
 * What a client is shown of a proposal: what approving it would change on the sheet as it is now — each change by
 * its readable path, the value now and the one proposed — or, when it no longer fits the sheet (someone changed it
 * since), that it doesn't.
 */
export function proposalView(
  p: Proposal,
  names: { actor: string; user: string },
  now: Sheet | null,
): ProposalView {
  let changes: { path: (string | number)[]; label: string; before: unknown; after: unknown }[] = [];
  let fits = now !== null;
  if (now) {
    const would = Sheet.safeParse(applyChanges(now, p.changes));
    if (would.success)
      changes = diffSheet(now, would.data).map((c) => ({
        path: c.path,
        label: pathLabel(c.path),
        before: c.before,
        after: c.after,
      }));
    else fits = false;
  }
  return {
    id: p.id,
    actorId: p.actorId,
    actorName: names.actor,
    userId: p.userId,
    userName: names.user,
    note: p.note,
    status: p.status,
    decisionNote: p.decisionNote,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    fits,
    changes,
  };
}
