import { type P, pathLength, simplifyPath } from "@gloam/shared/geometry";
import { clearanceRadius, pathCost, route, truncateAtCollision } from "@gloam/shared/movement";
import type { TokenView } from "@gloam/shared/state";
import { create } from "zustand";
import { request, send, useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { toast } from "../../ui/Toast.tsx";
import { wake } from "../frames.ts";
import { clientMoveWorld } from "./world.ts";

/**
 * Moving a token (SPEC §8.6 Moving a token): the preview while dragging (or hovering, with click-to-move), its
 * waypoints, and the commit. The preview is routed around the walls this viewer knows with the shared pathfinder —
 * at most once per animation frame — or, holding Alt, follows the pointer's own trail (simplified at 0.5 ft) and
 * stops where it would hit a wall. Other viewers get the path at up to 15 Hz (`move.preview`).
 */
export interface MovePreview {
  points: P[];
  /** Movement cost in feet (§16.4) — difficult terrain counts double. */
  cost: number;
  /** Feet of the path inside difficult terrain. */
  difficultFt: number;
  /** A route exists (routed mode) — false shows "No path". */
  ok: boolean;
}

export type MoveMode = "route" | "freehand";

interface MoveState {
  /** The token being moved (dragged, or planned with click-to-move), or null. */
  tokenId: string | null;
  /** A drag (pointer held) rather than click-to-move hovering. */
  dragging: boolean;
  mode: MoveMode;
  from: P | null;
  /** Where the pointer is on the table. */
  goal: P | null;
  /** Where the pointer is on screen (the label follows it). */
  screen: { x: number; y: number } | null;
  waypoints: P[];
  /** Freehand: the pointer's trail on the table. */
  trail: P[];
  preview: MovePreview | null;
  /** A commit is on its way to the server. */
  sending: boolean;
}

const EMPTY: MoveState = {
  tokenId: null,
  dragging: false,
  mode: "route",
  from: null,
  goal: null,
  screen: null,
  waypoints: [],
  trail: [],
  preview: null,
  sending: false,
};

export const useMove = create<MoveState>(() => EMPTY);

const FREEHAND_TOL_FT = 0.5;
const PREVIEW_HZ = 15;
const PREVIEW_MAX_POINTS = 64;

function tokenOf(id: string | null): TokenView | undefined {
  return id ? boardData(useEntities.getState()).tokens.get(id) : undefined;
}

const isDm = () => {
  const r = useTable.getState().me?.role;
  return r === "dm" || r === "admin";
};

/** The token's clearance and cost options (§16.2, §16.4). */
function optionsFor(t: TokenView) {
  return {
    rc: clearanceRadius(t.sizeFt, useTable.getState().houseRules.squeeze),
    crawl: t.prone,
  };
}

/** Starts planning a move for a token (drag start, or a controllable token selected with click-to-move). */
export function beginMove(tokenId: string, opts: { dragging: boolean }): void {
  const t = tokenOf(tokenId);
  if (!t) return;
  useMove.setState({
    ...EMPTY,
    tokenId,
    dragging: opts.dragging,
    from: { x: t.pos.x, y: t.pos.y },
  });
}

/** The pointer moved: a new goal (and, dragging with Alt, one more trail point). */
export function pointerAt(goal: P | null, screen: { x: number; y: number } | null, alt: boolean): void {
  const s = useMove.getState();
  if (!s.tokenId) return;
  const mode: MoveMode = alt && s.dragging ? "freehand" : "route";
  let trail = s.trail;
  if (mode === "freehand" && goal) {
    const last = trail[trail.length - 1];
    if (!last || Math.hypot(goal.x - last.x, goal.y - last.y) > 0.1) trail = [...trail, goal];
  } else trail = [];
  useMove.setState({ goal, screen, mode, trail });
  schedule();
}

/** Ctrl/Cmd+click: route through this point next (AC-MOV-17). */
export function addWaypoint(p: P): void {
  const s = useMove.getState();
  if (!s.tokenId) return;
  useMove.setState({ waypoints: [...s.waypoints, p] });
  schedule();
}

/** Esc: drop the waypoints first, then the whole plan. */
export function cancelMove(): boolean {
  const s = useMove.getState();
  if (!s.tokenId) return false;
  if (s.waypoints.length && !s.dragging) {
    useMove.setState({ waypoints: [] });
    schedule();
    return true;
  }
  useMove.setState(EMPTY);
  broadcast(true);
  wake();
  return true;
}

/** Release, click or Enter: send the previewed path (§16.5 validates it). */
export async function commitMove(): Promise<void> {
  const s = useMove.getState();
  const t = tokenOf(s.tokenId);
  compute();
  const p = useMove.getState().preview;
  if (!t || !p?.ok || p.points.length < 2 || pathLength(p.points) < 0.05) {
    useMove.setState(EMPTY);
    broadcast(true);
    return;
  }
  useMove.setState({ ...EMPTY, sending: true });
  broadcast(true);
  try {
    await request("move.commit", { tokenId: t.id, points: p.points.slice(0, 256) });
  } catch (e) {
    toast.danger("Couldn't move there", (e as Error).message);
  } finally {
    useMove.setState({ sending: false });
    wake();
  }
}

// A plan follows the world: when a door opens or a wall moves, the preview re-routes at once (AC-WAL-03), not on
// the next pointer move.
let seen: { walls: unknown; zones: unknown } | null = null;
useEntities.subscribe((st) => {
  const d = boardData(st);
  if (seen && seen.walls === d.walls && seen.zones === d.zones) return;
  seen = { walls: d.walls, zones: d.zones };
  if (!useMove.getState().tokenId) return;
  // At once, not on the next animation frame (which a slow renderer can hold back): routing takes milliseconds.
  moveDiag.worldAt = performance.now();
  compute();
  broadcast(false);
  wake();
});

/** Diagnostics (test hooks): when the world last changed under a plan, and when the preview was last computed. */
export const moveDiag = { worldAt: 0, resultAt: 0, resultOk: false };

let frame = 0;
function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    compute();
    broadcast(false);
    wake();
  });
}

/** Recomputes the preview for the current goal, waypoints and mode. */
function compute(): void {
  const s = useMove.getState();
  const t = tokenOf(s.tokenId);
  if (!t || !s.from || !s.goal) {
    if (s.preview) useMove.setState({ preview: null });
    return;
  }
  const opts = optionsFor(t);
  const world = clientMoveWorld({ swim: false });
  if (!world) return;
  let preview: MovePreview;
  if (s.mode === "freehand") {
    const raw = simplifyPath([s.from, ...s.trail], FREEHAND_TOL_FT);
    // The DM's moves ignore blocking; everyone else's stop where they'd hit a wall they know about.
    const points = isDm() ? raw : truncateAtCollision(world, raw, opts).points;
    const c = pathCost(world, points, opts);
    preview = { points, cost: c.cost, difficultFt: c.difficultFt, ok: points.length > 1 };
  } else {
    const r = route(world, s.from, s.goal, s.waypoints, opts);
    preview = r
      ? { points: r.points, cost: r.cost, difficultFt: r.difficultFt, ok: true }
      : { points: [s.from, ...s.waypoints, s.goal], cost: 0, difficultFt: 0, ok: false };
  }
  useMove.setState({ preview });
  moveDiag.resultAt = performance.now();
  moveDiag.resultOk = preview.ok;
}

/** `move.preview` to the other viewers, at most 15 times a second (an empty path clears it). */
let lastSent = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
function broadcast(clear: boolean): void {
  const s = useMove.getState();
  const id = s.tokenId ?? lastToken;
  if (!id) return;
  const payload = () => {
    const p = useMove.getState().preview;
    const pts = clear || !p?.ok ? [] : decimate(p.points, PREVIEW_MAX_POINTS);
    return { tokenId: id, points: pts, cost: clear || !p ? 0 : Math.min(100_000, p.cost) };
  };
  if (s.tokenId) lastToken = s.tokenId;
  const now = performance.now();
  const gap = 1000 / PREVIEW_HZ;
  if (pending) clearTimeout(pending);
  if (clear || now - lastSent >= gap) {
    lastSent = now;
    send("move.preview", payload());
    if (clear) lastToken = null;
  } else
    pending = setTimeout(
      () => {
        pending = null;
        lastSent = performance.now();
        send("move.preview", payload());
      },
      gap - (now - lastSent),
    );
}
let lastToken: string | null = null;

/** At most n points, keeping the ends (previews are for show; the commit sends the full path). */
function decimate(points: P[], n: number): P[] {
  if (points.length <= n) return points;
  const out: P[] = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round((i * (points.length - 1)) / (n - 1))] as P);
  return out;
}
