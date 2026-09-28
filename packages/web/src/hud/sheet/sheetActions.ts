/**
 * What a sheet does (SPEC §8.10): edits — checked against the sheet's lock before they're sent, so a player's edit
 * to a locked field becomes a proposal instead of an error — and rolls from any roll-able value (Alt = advantage,
 * Ctrl/Cmd = disadvantage; on touch a long press offers Normal / Advantage / Disadvantage / Physical).
 */
import type { ActorView } from "@gloam/shared/protocol";
import { applyChanges, lockedChanges, pathLabel, type SheetChange } from "@gloam/shared/rules";
import { Sheet } from "@gloam/shared/schemas";
import { create } from "zustand";
import { rollDice } from "../../net/dice.ts";
import { changeSheet, proposeChange, type SheetChangeIn } from "../../net/sheets.ts";
import { useTable } from "../../net/table.ts";
import { useUi } from "../../state/ui.ts";
import { toast } from "../../ui/Toast.tsx";

export type RollMode = "normal" | "adv" | "dis";

/** A proposal waiting for the player's note (the sheet's Propose dialog). */
interface ProposeState {
  pending: {
    actor: ActorView;
    changes: SheetChangeIn[];
    fields: { label: string; before: unknown; after: unknown }[];
  } | null;
  set(p: Partial<Omit<ProposeState, "set">>): void;
}
export const usePropose = create<ProposeState>((set) => ({ pending: null, set: (p) => set(p) }));

export const isDmRole = (role: string | undefined) => role === "dm" || role === "admin";

/** Whether this person may edit the sheet at all (DMs any; players their own). */
export function mayEdit(actor: ActorView): boolean {
  const me = useTable.getState().me;
  if (!me) return false;
  return isDmRole(me.role) || (me.role === "player" && actor.ownerUserId === me.userId);
}

/**
 * Makes an edit: refused before sending when it doesn't make a valid sheet (with the reason), turned into a proposal
 * when the lock covers it, otherwise sent. Resolves to whether it went through.
 */
export async function editSheet(actor: ActorView, changes: SheetChangeIn[]): Promise<boolean> {
  const me = useTable.getState().me;
  if (!me || !mayEdit(actor)) return false;
  const after = Sheet.safeParse(applyChanges(actor.sheet, changes as SheetChange[]));
  if (!after.success) {
    const i = after.error.issues[0];
    toast.warning("That doesn't fit the sheet", i ? `${i.path.join(".")}: ${i.message}` : undefined);
    return false;
  }
  const locked = lockedChanges(actor.lockLevel, actor.sheet, after.data, isDmRole(me.role));
  if (locked.length) {
    usePropose.getState().set({
      pending: {
        actor,
        changes,
        fields: locked.map((c) => ({ label: pathLabel(c.path), before: c.before, after: c.after })),
      },
    });
    return false;
  }
  try {
    await changeSheet(actor.id, changes);
    return true;
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "LOCKED_SHEET") {
      // Locked since this client last heard: propose it instead.
      usePropose.getState().set({ pending: { actor, changes, fields: [] } });
      return false;
    }
    toast.danger("Couldn't change the sheet", err.message);
    return false;
  }
}

export async function sendProposal(
  actor: ActorView,
  changes: SheetChangeIn[],
  note: string,
): Promise<boolean> {
  try {
    await proposeChange(actor.id, changes, note);
    toast.info("Sent to the DM", "You'll see their answer here.");
    return true;
  } catch (e) {
    toast.danger("Couldn't send it", (e as Error).message);
    return false;
  }
}

/** Advantage from Alt, disadvantage from Ctrl/Cmd (SPEC §8.9 Rolling from anywhere). */
export function modeOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): RollMode {
  if (e.altKey) return "adv";
  if (e.ctrlKey || e.metaKey) return "dis";
  return "normal";
}

/** A formula with advantage or disadvantage (for d20 rolls; others are as they are). */
export function withMode(formula: string, mode: RollMode): string {
  if (mode === "normal" || !/\bd20\b/i.test(formula) || /\b(adv|dis)\s*$/i.test(formula)) return formula;
  return `${formula} ${mode}`;
}

/** Rolls from the sheet: the server resolves its `@` references from this character. */
export async function rollFromSheet(
  actor: ActorView,
  formula: string,
  label: string,
  mode: RollMode,
): Promise<void> {
  try {
    await rollDice({ formula: withMode(formula, mode), label, visibility: "public", actorId: actor.id });
  } catch (e) {
    toast.danger("Couldn't roll", (e as Error).message);
  }
}

/** A roll made with real dice: the tray opens on the formula, ready to enter what landed. */
export function rollPhysically(formula: string, label: string): void {
  const ui = useUi.getState();
  ui.set({ diceDraft: { ...ui.diceDraft, formula, label, manual: true }, diceTray: true });
}

const ABILITY_NAMES = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
} as const;
export type AbilityKey = keyof typeof ABILITY_NAMES;
export const abilityName = (a: AbilityKey) => ABILITY_NAMES[a];

/** A skill's name as printed ("sleightOfHand" → "Sleight of Hand"). */
export function skillName(id: string): string {
  const words = id.replace(/([A-Z])/g, " $1").split(" ");
  return words
    .map((w, i) =>
      i && ["Of", "And"].includes(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

export const signed = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
