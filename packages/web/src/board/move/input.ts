import { controlsToken } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { boardApi } from "../boardApi.ts";
import { addWaypoint, beginMove, cancelMove, commitMove, pointerAt, useMove } from "./drag.ts";

/**
 * Board input for moving tokens (SPEC §8.6): press-and-drag a token you control (Alt for freehand); or, with
 * click-to-move on and one such token selected, hover the floor to preview and click to go (Ctrl/Cmd+click adds a
 * waypoint; Enter commits; Esc drops the waypoints, then the plan).
 */
const DRAG_START_PX = 5;

function me() {
  return useTable.getState().me;
}

/** Can this viewer move this token at all (their own, or any as DM; locked tokens only by the DM)? */
export function canMove(t: TokenView | undefined): t is TokenView {
  const m = me();
  if (!t || !m || m.role === "spectator") return false;
  if (!controlsToken(m.role, m.userId, t)) return false;
  const dm = m.role === "dm" || m.role === "admin";
  return dm || (!t.locked && !t.own?.lockMovement);
}

/** A left press on a token (its own handler calls this): becomes a drag once the pointer travels 5 px. */
export function pressToken(tokenId: string, e: PointerEvent): void {
  const t = boardData(useEntities.getState()).tokens.get(tokenId);
  if (!canMove(t)) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    if (!dragging) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
      dragging = true;
      beginMove(tokenId, { dragging: true });
    }
    pointerAt(boardApi.groundAt(ev.clientX, ev.clientY), { x: ev.clientX, y: ev.clientY }, ev.altKey);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!dragging) return;
    if (ev.type === "pointercancel") cancelMove();
    else void commitMove();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** The one selected token click-to-move applies to, if any. */
function clickToMoveToken(): TokenView | undefined {
  if (!useSettings.getState().clickToMove) return undefined;
  const ui = useUi.getState();
  if (ui.tool !== "select" || ui.selection.length !== 1) return undefined;
  const t = boardData(useEntities.getState()).tokens.get(ui.selection[0] as string);
  return canMove(t) ? t : undefined;
}

/** The pointer is over the board (no button held): with click-to-move, preview a move there. */
export function hoverBoard(clientX: number, clientY: number, overToken: boolean): void {
  const s = useMove.getState();
  if (s.dragging || s.sending) return;
  const t = clickToMoveToken();
  if (!t || overToken) {
    // Keep a plan with waypoints (the pointer may cross a token on the way); drop a bare hover preview.
    if (s.tokenId && !s.waypoints.length) cancelMove();
    return;
  }
  if (s.tokenId !== t.id) beginMove(t.id, { dragging: false });
  pointerAt(boardApi.groundAt(clientX, clientY), { x: clientX, y: clientY }, false);
}

/** The pointer left the board: a bare hover preview goes with it. */
export function leaveBoard(): void {
  const s = useMove.getState();
  if (s.tokenId && !s.dragging && !s.waypoints.length) cancelMove();
}

/**
 * A click on empty floor. Returns true when it was a move (the board then keeps the selection instead of clearing
 * it): Ctrl/Cmd+click adds a waypoint, a plain click commits.
 */
export function clickFloor(clientX: number, clientY: number, mod: boolean): boolean {
  const t = clickToMoveToken();
  const s = useMove.getState();
  if (!t || s.tokenId !== t.id || s.dragging) return false;
  const p = boardApi.groundAt(clientX, clientY);
  if (!p) return false;
  if (mod) {
    addWaypoint(p);
    return true;
  }
  pointerAt(p, { x: clientX, y: clientY }, false);
  void commitMove();
  return true;
}

/** Keys while planning: Enter commits, Esc steps back. Returns true when handled. */
export function moveKey(e: KeyboardEvent): boolean {
  const s = useMove.getState();
  if (!s.tokenId) return false;
  if (e.key === "Enter" && !s.dragging) {
    void commitMove();
    return true;
  }
  if (e.key === "Escape") return cancelMove();
  return false;
}
