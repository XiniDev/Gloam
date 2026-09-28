import { create } from "zustand";
import { useTable } from "../net/table.ts";
import type { SensedMark } from "./entities.ts";
import type { FogSnapshotMsg } from "./fog.ts";

/** What a player would hold (`vision.viewAs`, SPEC §8.8 View as). */
export interface ViewAsData {
  tokens: string[];
  sensed: SensedMark[];
  viewers: string[];
  fog: FogSnapshotMsg | null;
}

interface ViewAsStore {
  /** The player the DM is viewing as, or null (the DM's own view). */
  userId: string | null;
  name: string;
  data: ViewAsData | null;
  set(p: Partial<Omit<ViewAsStore, "set">>): void;
}

/** View as (DM): the board drawn exactly as one player sees it; nothing changes for anyone else. */
export const useViewAs = create<ViewAsStore>((set) => ({
  userId: null,
  name: "",
  data: null,
  set: (p) => set(p),
}));

/** The DM's own view: everything, the DM-only aids included (false for players, and while viewing as a player). */
export function useDmView(): boolean {
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const as = useViewAs((s) => s.userId !== null);
  return dm && !as;
}
