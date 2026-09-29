import { useEffect } from "react";
import {
  endTurn,
  nextTurn,
  previousTurn,
  quickStartCombat,
  resetMove,
  stopCombat,
  useCombat,
} from "../../net/combat.ts";
import { useTable } from "../../net/table.ts";
import { useUi } from "../../state/ui.ts";
import { toast } from "../../ui/Toast.tsx";

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
};

/** The creature whose turn it is, when it's this person's to play (theirs, or any for the DM). */
export function myActiveTurn(): string | null {
  const v = useCombat.getState().view;
  const me = useTable.getState().me;
  const dm = me?.role === "dm" || me?.role === "admin";
  if (!v.begun || v.activeIndex < 0) return null;
  const e = v.entries[v.activeIndex];
  return e?.tokenId && (dm || e.mine) ? e.tokenId : null;
}

/**
 * Combat's keys (Appendix H): Ctrl+Enter ends your turn, Backspace resets your move; the DM's Ctrl/Cmd+Shift+C starts
 * a quick combat or stops the one running, N and P step the turn.
 */
export function useCombatKeys(): void {
  useEffect(() => {
    const act = (p: Promise<unknown>, what: string) =>
      void p.catch((e: Error) => toast.danger(what, e.message));
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.altKey) return;
      const me = useTable.getState().me;
      const dm = me?.role === "dm" || me?.role === "admin";
      const v = useCombat.getState().view;
      if (dm && e.code === "KeyC" && e.shiftKey && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        act(
          v.active ? stopCombat() : quickStartCombat(),
          v.active ? "Couldn't stop" : "Couldn't start combat",
        );
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.code === "Enter") {
          const t = myActiveTurn();
          if (!t) return;
          e.preventDefault();
          act(endTurn(t), "Couldn't end the turn");
        }
        return;
      }
      if (e.shiftKey) return;
      // (Backspace belongs to a drawing tool while one is picked: it takes back the last wall or zone point.)
      const tool = useUi.getState().tool;
      if (e.code === "Backspace" && (tool === "select" || tool === "pan")) {
        const t = myActiveTurn();
        if (!t) return;
        e.preventDefault();
        act(resetMove(t), "Couldn't reset the move");
        return;
      }
      if (dm && v.begun && (e.code === "KeyN" || e.code === "KeyP")) {
        e.preventDefault();
        act(e.code === "KeyN" ? nextTurn() : previousTurn(), "Couldn't change the turn");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
