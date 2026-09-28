/**
 * The DM's prompts (SPEC §8.11, §19.1; AC-HP-12): what follows from damage, healing or a condition put to the DM to
 * apply, edit or skip — going down, death-save failures, an NPC at 0 HP, a death, concentration ending — and a
 * player's damage to another creature waiting on the DM (house rule "Player-applied damage: via DM confirmation").
 * Stored in SQLite (`dm_prompts`): a pending decision survives a restart. A prompt remembers the history entry it came
 * from, so undoing that closes it.
 */
import type { DmPromptView } from "@gloam/shared/protocol";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { dmPrompts } from "../db/schema.ts";
import { newId } from "../ids.ts";

export interface DmPrompt extends DmPromptView {
  campaignId: string;
  /** Who caused it (the damage's sender). */
  createdBy: string;
  /** The history entry it came from (undoing that closes it), when there was one. */
  entryId: number | null;
  resolvedBy: string | null;
}

export type NewPrompt = Omit<DmPrompt, "id" | "createdAt" | "status" | "resolvedAt" | "resolvedBy">;

/** A prompt as the DMs see it (no campaign or history bookkeeping). */
export function promptView(p: DmPrompt): DmPromptView {
  const { campaignId: _c, createdBy: _b, entryId: _e, resolvedBy: _r, ...view } = p;
  return view;
}

export class PromptService {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(p: NewPrompt): DmPrompt {
    const prompt: DmPrompt = {
      ...p,
      id: newId("prm"),
      createdAt: Date.now(),
      status: "open",
      resolvedAt: null,
      resolvedBy: null,
    };
    this.db
      .insert(dmPrompts)
      .values({
        id: prompt.id,
        campaignId: prompt.campaignId,
        dataJson: JSON.stringify(prompt),
        status: "open",
        createdAt: prompt.createdAt,
        resolvedAt: null,
      })
      .run();
    return prompt;
  }

  get(id: string): DmPrompt | null {
    const row = this.db.select().from(dmPrompts).where(eq(dmPrompts.id, id)).get();
    if (!row) return null;
    try {
      return {
        ...(JSON.parse(row.dataJson as string) as DmPrompt),
        status: row.status,
        resolvedAt: row.resolvedAt,
      };
    } catch {
      return null;
    }
  }

  /** Marks a prompt applied or skipped. */
  resolve(p: DmPrompt, status: "applied" | "skipped", by: string): DmPrompt {
    const next: DmPrompt = { ...p, status, resolvedAt: Date.now(), resolvedBy: by };
    this.db
      .update(dmPrompts)
      .set({ dataJson: JSON.stringify(next), status, resolvedAt: next.resolvedAt })
      .where(eq(dmPrompts.id, p.id))
      .run();
    return next;
  }

  /** A campaign's open prompts, oldest first (the order they happened). */
  open(campaignId: string): DmPrompt[] {
    return this.db
      .select()
      .from(dmPrompts)
      .where(and(eq(dmPrompts.campaignId, campaignId), eq(dmPrompts.status, "open")))
      .orderBy(desc(dmPrompts.createdAt))
      .limit(100)
      .all()
      .reverse()
      .map((r) => this.get(r.id))
      .filter((p): p is DmPrompt => p !== null);
  }

  /** The open prompts that came from a history entry (it was undone: they no longer apply). */
  fromEntry(campaignId: string, entryId: number): DmPrompt[] {
    return this.open(campaignId).filter((p) => p.entryId === entryId);
  }
}
