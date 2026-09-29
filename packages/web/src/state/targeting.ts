/**
 * Casting on the board (SPEC §8.13 Casting flow 2; AC-SPL-03/04): what's being cast, by whom, at what level, and where
 * its template stands or whom it's aimed at. The board draws it (board/cast/TargetingLayer.tsx) and the targeting bar
 * (hud/spells/TargetingBar.tsx) says what's asked; a click on the board casts an area where it stands, a click on a
 * creature picks it (a single target casts at once; more once they're all picked, or Cast now).
 */
import { targetingKind } from "@gloam/shared/rules";
import type { Spell } from "@gloam/shared/schemas";
import { create } from "zustand";
import { useUi } from "./ui.ts";

export interface Targeting {
  spell: Spell;
  casterTokenId: string;
  /** The slot spent (a levelled spell cast with one). */
  slot?: { level: number; kind: "slot" | "pact" } | undefined;
  /** The level it's cast at (a slot's, or a ritual's or free cast's). */
  level: number;
  mode: "slot" | "ritual" | "free";
  damageType?: string | undefined;
  /** One of the spell's alternative forms (Darkness on an object), by index. */
  alt?: number | undefined;
  /** The area's point (scene ft) and its facing, as the pointer leaves them. */
  at: { x: number; y: number } | null;
  dirDeg: number;
  /** A facing set with [ and ] (a ranged cube's; otherwise it faces the pointer from the caster). */
  turned: boolean;
  /** Creatures picked (a targeted spell), repeats allowed for darts and rays. */
  picks: string[];
  /** The area's source among those it affects (§17.2). */
  includeSelf: boolean;
  /** How many it takes (targeted spells). */
  max: number;
  /** Whether a creature can be picked more than once. */
  repeat: boolean;
  /** A wall's points as they're laid (Wall of Fire). */
  points: { x: number; y: number }[];
  ring: boolean;
  /** Sending it (the bar says so; the board stops following). */
  busy: boolean;
  /** A sheet's attack aimed instead of a spell (its index on the sheet; §8.13 Weapons and abilities). */
  attack?: { index: number } | undefined;
  /** Why the last creature clicked couldn't be picked (out of range, behind total cover) — the bar says so. */
  refusal?: string | null | undefined;
  /**
   * Cast on an object put down at a point (Light on a stone within reach): aimed as a small area — a click where the
   * object lies, within the spell's reach.
   */
  point?: boolean | undefined;
  /** Creatures the caster designates to be unaffected (Spirit Guardians: clicked while it's aimed). */
  spare?: string[] | undefined;
}

/** Whether the caster designates creatures its effect leaves alone (Spirit Guardians, SRD p. 164). */
export function designates(t: Pick<Targeting, "spell">): boolean {
  return t.spell.effect?.props.speedHalved === true;
}

/** How a targeting is aimed: an area (or an object at a point, the same way), creatures, or nothing to aim. */
export function aimKind(t: Pick<Targeting, "spell" | "point">): "area" | "creatures" | "self" | "point" {
  return t.point ? "area" : targetingKind(t.spell);
}

interface TargetingStore {
  t: Targeting | null;
  set(p: Partial<Targeting>): void;
  start(
    t: Omit<Targeting, "at" | "dirDeg" | "turned" | "picks" | "includeSelf" | "points" | "ring" | "busy">,
  ): void;
  stop(): void;
}

export const useTargeting = create<TargetingStore>((set, get) => ({
  t: null,
  set(p) {
    const t = get().t;
    if (t) set({ t: { ...t, ...p } });
  },
  start(t) {
    set({
      t: {
        ...t,
        at: null,
        dirDeg: 0,
        turned: false,
        picks: [],
        includeSelf: false,
        points: [],
        ring: false,
        busy: false,
      },
    });
    // The board's own tools step aside while it lasts (Esc ends it).
    useUi.getState().set({ tool: "target", radial: null });
  },
  stop() {
    set({ t: null });
    if (useUi.getState().tool === "target") useUi.getState().set({ tool: "select" });
  },
}));
