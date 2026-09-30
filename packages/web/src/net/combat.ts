/**
 * Combat on the client (SPEC §8.12): the tracker as the server lets this person see it (`combat.view`), whose turn
 * it is and whether it's theirs (`combat.turn`: the chime, the banner, the camera if they asked), what ran out
 * (`combat.expired`), the summary when combat stops — and the actions, each a server command.
 */
import type { CombatExpiredMessage, CombatTurnMessage, CombatView } from "@gloam/shared/protocol";
import { createElement } from "react";
import { create } from "zustand";
import { CombatSummary } from "../hud/combat/CombatSummary.tsx";
import { provideTestHook } from "../test/hooks.ts";
import { toast } from "../ui/Toast.tsx";
import { request, tableEvents } from "./table.ts";

interface CombatStore {
  view: CombatView;
  /** The last turn announced (the banner shows it a moment). */
  turn: (CombatTurnMessage & { at: number }) | null;
  set(p: Partial<Omit<CombatStore, "set">>): void;
}

const NONE: CombatView = {
  active: false,
  begun: false,
  round: 0,
  entries: [],
  activeIndex: -1,
  freeMovement: false,
};

export const useCombat = create<CombatStore>((set) => ({
  view: NONE,
  turn: null,
  set: (p) => set(p),
}));

/** A turn began that's this person's (the HUD plays the chime and shows the banner; the camera follows if asked). */
export const yourTurn = {
  listeners: new Set<(t: CombatTurnMessage) => void>(),
  on(f: (t: CombatTurnMessage) => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  },
  fire(t: CombatTurnMessage): void {
    for (const f of this.listeners) f(t);
  },
};

function onMessage(type: string, payload: unknown): void {
  const s = useCombat.getState();
  switch (type) {
    case "combat.view":
      s.set({ view: payload as CombatView });
      return;
    case "combat.turn": {
      const t = payload as CombatTurnMessage;
      s.set({ turn: { ...t, at: Date.now() } });
      if (t.yours) yourTurn.fire(t);
      return;
    }
    case "combat.expired": {
      const e = payload as CombatExpiredMessage;
      toast.info(`${e.what} ended`, `on ${e.name}`);
      return;
    }
    case "combat.stopped": {
      const p = payload as {
        text: string;
        rounds: number;
        downed?: string[];
        tally?: { name: string; dealt: number; taken: number }[];
      };
      toast.info(
        p.rounds > 0
          ? `Combat ended · ${p.rounds} ${p.rounds === 1 ? "round" : "rounds"}`
          : "Combat called off",
        p.rounds > 0 || p.tally?.length || p.downed?.length
          ? createElement(CombatSummary, { downed: p.downed ?? [], tally: p.tally ?? [] })
          : undefined,
      );
      s.set({ turn: null });
      return;
    }
  }
}

/** Starts watching (once per page). */
export function watchCombat(): () => void {
  if (__GLOAM_TEST__) provideTestHook("combat", () => useCombat.getState().view);
  return tableEvents.on("message", ({ type, payload }) => onMessage(type, payload));
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type InitiativeMethod = "rollAll" | "playersRoll" | "fixed" | "skip";

export const startCombat = (p: {
  participants: string[];
  method: InitiativeMethod;
  group: boolean;
  surprised: string[];
}) => request<{ combatId: string }>("combat.start", p);
export const quickStartCombat = () => request<{ combatId: string }>("combat.quickStart", {});
export const stopCombat = () => request<{ rounds: number }>("combat.stop", {});
export const beginTurns = () => request("combat.begin", {});
export const nextTurn = () => request("combat.next", {});
export const previousTurn = () => request("combat.prev", {});
export const endTurn = (tokenId: string) => request("combat.endTurn", { tokenId });
export const setInitiative = (tokenId: string, initiative: number) =>
  request("combat.set", { tokenId, initiative });
export const reorderCombat = (order: string[]) => request("combat.reorder", { order });
export const delayTurn = (tokenId: string, after: string) => request("combat.delay", { tokenId, after });
export const addToCombat = (tokenIds: string[]) => request("combat.add", { tokenIds });
export const removeFromCombat = (tokenId: string) => request("combat.remove", { tokenId });
export const setFreeMovement = (on: boolean) => request("combat.freeMovement", { on });
export const rollRemaining = (players: boolean) =>
  request<{ rolled: number }>("combat.rollRemaining", { players });
export const setPip = (tokenId: string, pip: "action" | "bonus" | "reaction" | "object", used: boolean) =>
  request<{ pips: number }>("combat.pip", { tokenId, pip, used });
export const resetMove = (tokenId: string) => request("move.reset", { tokenId });
export const dash = (tokenId: string) => request("move.dash", { tokenId });
export const standUp = (tokenId: string) => request("move.stand", { tokenId });
