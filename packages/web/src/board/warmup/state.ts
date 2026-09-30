import type { EffectView, LightView, SceneView, TokenView, WallView, ZoneView } from "@gloam/shared/state";
import { useMemo } from "react";
import { create } from "zustand";
import { type SceneData, useBoard } from "../../state/entities.ts";
import type { TierName } from "../tiers.ts";

/**
 * The shader warm-up's state (SPEC §24.7; AC-PERF-05). While the intro's candle covers the board, the board draws one
 * of everything it can draw — the specimens — so that every shader program play will need is compiled then, not in
 * the middle of a move or a spell.
 */
export interface WarmupState {
  /** "waiting" before the board has a tier; "warming" while specimens are drawn; "done" once compiled. */
  phase: "waiting" | "warming" | "done";
  /** The tier the programs were compiled for. */
  tier: TierName | null;
  /** How many programs the board had when the warm-up started and ended, and how long it took (ms). */
  programsBefore: number;
  programsAfter: number;
  ms: number;
  /** Warm-ups run (a tier change before the board shows warms again). */
  rounds: number;
  /** Not warmed on purpose (software GL; test builds that didn't ask). */
  skipped?: boolean;
  /** Each step's time (ms), keyed by step and the program count after it: the perf overlay and the bench read it. */
  steps?: Record<string, number>;
  /** When each step ended (performance.now()). */
  ends?: Record<string, number>;
  /** When it was done and the board could show (performance.now()). */
  doneAt?: number;
  /** When (ms from its start) the other tiers' programs were ready too (compiled in idle moments after). */
  allTiersMs?: number;
}

export const useWarmup = create<WarmupState>(() => ({
  phase: "waiting",
  tier: null,
  programsBefore: 0,
  programsAfter: 0,
  ms: 0,
  rounds: 0,
}));

/** Entities drawn only while warming: each drawing layer shows them beside the scene's own (never the HUD). */
export interface Specimens {
  tokens: Map<string, TokenView>;
  walls: Map<string, WallView>;
  lights: Map<string, LightView>;
  zones: Map<string, ZoneView>;
  effects: Map<string, EffectView>;
  /** Scene switches the layers read (3-D walls on, so their materials are made). */
  scene: Partial<SceneView>;
}

export const useSpecimens = create<{ data: Specimens | null }>(() => ({ data: null }));

type Collection = "tokens" | "walls" | "lights" | "zones" | "effects";

/**
 * A drawing layer's view of a collection: the scene's, plus the warm-up's specimens while it runs. Only the board's
 * layers read this — panels, lists and the tracker read the scene alone.
 */
export function useDrawn<K extends Collection>(key: K): SceneData[K] {
  const real = useBoard((d) => d[key]);
  const spec = useSpecimens((s) => (s.data ? (s.data[key] as SceneData[K]) : null));
  return useMemo(() => {
    if (!spec?.size) return real;
    const all = new Map<string, unknown>(real);
    for (const [id, v] of spec) all.set(id, v);
    return all as SceneData[K];
  }, [real, spec]);
}

/** Whether the warm-up is drawing: layers that only draw in some scenes (3-D walls) draw their specimens then. */
export const useWarming = (): boolean => useSpecimens((s) => s.data !== null);
