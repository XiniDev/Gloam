/**
 * The board's input while a spell is aimed (SPEC §8.13 Casting flow 2, J6 "Fireball"): the template follows the
 * pointer — a cone, line or self-cube turning to face it from its caster, a ranged cube turned in 15° steps with [ and ]
 * or the wheel — and a click casts it there (J6: "She clicks. The fireball explodes"). A wall is laid point by point
 * (Enter or Cast finishes it; a click on its first point closes a ring). A targeted spell picks creatures by clicking
 * them: one that takes a single target goes at once, others when they're all picked (or Cast now). Esc cancels.
 */
import { areaAtSlot, targetingKind } from "@gloam/shared/rules";
import { commitCast } from "../../hud/spells/casting.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useTargeting } from "../../state/targeting.ts";
import { boardApi } from "../boardApi.ts";
import { again } from "../frames.ts";

const STEP = 15;

/** The template's area kind now (its alternative form's, when one is chosen). */
function areaShape(): string | null {
  const t = useTargeting.getState().t;
  if (!t) return null;
  const alt = t.alt !== undefined ? t.spell.areaAlternatives?.[t.alt] : undefined;
  const a = alt?.area ?? t.spell.area;
  return a ? areaAtSlot(a, t.spell.level, t.level).shape : null;
}

/** Does it turn to face the pointer from its caster (a cone, a line, a cube from its caster)? */
function facesPointer(): boolean {
  const t = useTargeting.getState().t;
  const shape = areaShape();
  if (!t || !shape) return false;
  if (shape === "cone") return true;
  if (shape === "line" || shape === "cube") return t.spell.range.kind === "self";
  return false;
}

/** The pointer moved over the board. */
export function targetMove(clientX: number, clientY: number): void {
  const s = useTargeting.getState();
  const t = s.t;
  if (!t || t.busy) return;
  const p = boardApi.groundAt(clientX, clientY);
  if (!p) return;
  const shape = areaShape();
  if (shape === "emanation") return;
  const caster = boardData(useEntities.getState()).tokens.get(t.casterTokenId);
  const patch: Partial<typeof t> = { at: { x: p.x, y: p.y } };
  if (caster && facesPointer() && !t.turned)
    patch.dirDeg = (Math.atan2(p.y - caster.pos.y, p.x - caster.pos.x) * 180) / Math.PI - 90;
  s.set(patch);
  again();
}

/** A press on the board's floor (not on a creature): cast the area there, or lay a wall's point. */
export function targetDown(clientX: number, clientY: number): boolean {
  const t = useTargeting.getState().t;
  if (!t || t.busy) return false;
  const p = boardApi.groundAt(clientX, clientY);
  if (!p) return true;
  const kind = targetingKind(t.spell);
  if (kind !== "area") return true;
  const shape = areaShape();
  if (shape === "wall") {
    const first = t.points[0];
    // Back on its first point: the wall closes into a ring.
    if (first && t.points.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < 2) {
      useTargeting.getState().set({ ring: true });
      void commitCast({ ...t, ring: true });
      return true;
    }
    useTargeting.getState().set({ points: [...t.points, { x: p.x, y: p.y }] });
    again();
    return true;
  }
  if (shape === "emanation") {
    void commitCast(t);
    return true;
  }
  const next = { ...t, at: { x: p.x, y: p.y } };
  useTargeting.getState().set({ at: next.at });
  void commitCast(next);
  return true;
}

/** A creature clicked while aiming: picked (a targeted spell), or where the area goes (on it). */
export function targetToken(tokenId: string): void {
  const t = useTargeting.getState().t;
  if (!t || t.busy) return;
  const kind = targetingKind(t.spell);
  if (kind === "area") {
    const tok = boardData(useEntities.getState()).tokens.get(tokenId);
    if (!tok) return;
    const shape = areaShape();
    if (shape === "wall" || shape === "emanation") return;
    const next = { ...t, at: { ...tok.pos } };
    useTargeting.getState().set({ at: next.at });
    void commitCast(next);
    return;
  }
  if (kind !== "creatures") return;
  let picks = t.picks;
  if (!t.repeat && picks.includes(tokenId)) picks = picks.filter((x) => x !== tokenId);
  else if (picks.length < t.max) picks = [...picks, tokenId];
  useTargeting.getState().set({ picks });
  again();
  if (picks.length === t.max) void commitCast({ ...t, picks });
}

/** A key while aiming: Esc cancels, Enter casts, [ and ] turn it. */
export function targetKey(e: KeyboardEvent): boolean {
  const t = useTargeting.getState().t;
  if (!t) return false;
  if (e.key === "Escape") {
    // A wall's last point first, then the whole cast.
    if (t.points.length) useTargeting.getState().set({ points: t.points.slice(0, -1) });
    else useTargeting.getState().stop();
    again();
    return true;
  }
  if (e.key === "Enter") {
    if (!t.busy) void commitCast(t);
    return true;
  }
  if (e.key === "[" || e.key === "]") {
    turn(e.key === "]" ? STEP : -STEP);
    return true;
  }
  return false;
}

/** The wheel while aiming a directional template turns it (and doesn't zoom). */
export function targetWheel(deltaY: number): boolean {
  const t = useTargeting.getState().t;
  const shape = areaShape();
  if (!t || !shape || !(shape === "cone" || shape === "line" || shape === "cube")) return false;
  turn(deltaY > 0 ? STEP : -STEP);
  return true;
}

function turn(by: number): void {
  const t = useTargeting.getState().t;
  if (!t) return;
  const snapped = Math.round((t.dirDeg + by) / STEP) * STEP;
  useTargeting.getState().set({ dirDeg: ((snapped % 360) + 360) % 360, turned: true });
  again();
}
