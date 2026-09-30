import type { ActingAsView } from "@gloam/shared/protocol";
import { create } from "zustand";
import { useUi } from "../state/ui.ts";
import { toast } from "../ui/Toast.tsx";
import { request, tableEvents, useTable } from "./table.ts";

interface ActAsStore {
  /** The character this DM is acting as (AC-DMP-03), or null. */
  mine: { actorId: string; name: string } | null;
  /** Every DM's, by their user id (a co-DM sees who has which character). */
  byDm: Map<string, ActingAsView>;
  set(p: Partial<Omit<ActAsStore, "set">>): void;
}

export const useActAs = create<ActAsStore>((set) => ({
  mine: null,
  byDm: new Map(),
  set: (p) => set(p),
}));

/**
 * Takes a character's controls on its player's behalf (SPEC §8.19 Act as), or lets go (`null`): what the DM does
 * meanwhile is recorded as "DM as <character>"; the character's sheet opens in the dock.
 */
export async function actAs(actorId: string | null): Promise<void> {
  const v = await request<ActingAsView>("act.as", { actorId });
  useActAs.getState().set({ mine: v.actorId && v.name ? { actorId: v.actorId, name: v.name } : null });
  if (v.actorId) useUi.getState().set({ dock: "sheet", sheetActor: v.actorId });
}

function onActing(v: ActingAsView): void {
  const me = useTable.getState().me;
  if (!me) return;
  const dm = me.role === "dm" || me.role === "admin";
  if (dm) {
    const byDm = new Map(useActAs.getState().byDm);
    if (v.actorId) byDm.set(v.userId, v);
    else byDm.delete(v.userId);
    useActAs.getState().set({
      byDm,
      ...(v.userId === me.userId
        ? { mine: v.actorId && v.name ? { actorId: v.actorId, name: v.name } : null }
        : {}),
    });
    return;
  }
  // A player whose character the DM takes (or gives back): told, plainly.
  if (v.actorId && v.name)
    toast.info(`${v.dmName} is playing ${v.name} for you`, "Their moves and rolls show as theirs.");
  else toast.info(`${v.dmName} gave your character back`, "It's yours to play again.");
}

/** Starts listening (once per page). */
export function watchActAs(): () => void {
  return tableEvents.on("message", ({ type, payload }) => {
    if (type === "act.as") onActing(payload as ActingAsView);
  });
}
