import { type P, pathLength, simplifyPath } from "@gloam/shared/geometry";
import {
  clearanceRadius,
  type MoveWorld,
  maxReachPoint,
  type OpportunityMark,
  opportunityMarks,
  pathCost,
  route,
  type Side,
  truncateAtCollision,
  withCreatureSpaces,
} from "@gloam/shared/movement";
import { incapacitates, PIP, stuckName } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import { create } from "zustand";
import { useCombat } from "../../net/combat.ts";
import { request, send, useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useToasts } from "../../ui/Toast.tsx";
import { playOnBoard } from "../boardSound.ts";
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
  /** In combat, on its turn: the movement left (ft); absent where no budget applies (exploration, the DM). */
  budget?: number;
  /** Where the budget runs out along the path — the hollow marker (AC-MOV-01) — when it does. */
  reach?: P;
  /** Where the path leaves a visible hostile's reach (AC-MOV-15). */
  oa?: OpportunityMark[];
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

const REFUSED = "move-refused";

/** A move refused: a warning, not an error (critic P8 r2 N12) — replaced by the next, cleared by the next try. */
function refused(title: string, body?: string): void {
  useToasts.getState().push({ kind: "warning", title, body, key: REFUSED });
}

/** Starts planning a move for a token (drag start, or a controllable token selected with click-to-move). */
export function beginMove(tokenId: string, opts: { dragging: boolean }): void {
  const t = tokenOf(tokenId);
  if (!t) return;
  // A creature that can't move at all says why at once (§8.6: "Can't move — Grappled"), instead of planning a move
  // the server would refuse; the DM's moves are never held.
  if (t.own?.stuck && !isDm()) {
    if (opts.dragging) refused(`Can't move — ${stuckName(t.own.stuck)}`);
    return;
  }
  useToasts.getState().dismissKey(REFUSED);
  useMove.setState({
    ...EMPTY,
    tokenId,
    dragging: opts.dragging,
    from: { x: t.pos.x, y: t.pos.y },
  });
  // Lifted off the felt (SPEC §31): a drag picks the mini up; it's set down where it lands (or back where it was).
  if (opts.dragging) playOnBoard("tokenPickUp", { ...t.pos, z: t.elevation });
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
  if (s.dragging && s.from) playOnBoard("tokenPutDown", s.from);
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
  if (s.dragging && t) playOnBoard("tokenPutDown", (p?.ok && p.points.at(-1)) || t.pos);
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
    refused("Couldn't move there", (e as Error).message);
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

const dmOverrides = (t: TokenView): { countAsMovement?: boolean } => {
  try {
    return t.dm?.overridesJson ? (JSON.parse(t.dm.overridesJson) as { countAsMovement?: boolean }) : {};
  } catch {
    return {};
  }
};

/**
 * The movement a planned move may spend (§8.6, §16.5): in combat, the creature whose turn it is — its budget less
 * what it used — unless it (or everyone) moves freely; a DM's move only when its "Count as movement" is on. Else none.
 */
function budgetFor(t: TokenView): number | null {
  const v = useCombat.getState().view;
  if (!v.active || !v.begun || v.freeMovement || t.own?.freeMovement || !t.own) return null;
  if (v.entries[v.activeIndex]?.tokenId !== t.id) return null;
  if (isDm() && !dmOverrides(t).countAsMovement) return null;
  return Math.max(0, t.own.budgetFt - t.own.usedFt);
}

/** Whether other creatures' spaces shape a player's move now (house rule "Enforce creature spaces"). */
function spacesApply(): boolean {
  if (isDm()) return false;
  const rule = useTable.getState().houseRules.creatureSpaces;
  return rule === "always" || (rule === "combat" && useCombat.getState().view.active);
}

const side = (t: TokenView) => (t.disposition || "neutral") as Side;
const others = (t: TokenView) =>
  [...boardData(useEntities.getState()).tokens.values()].filter((o) => o.id !== t.id);

/** The world with the other creatures' spaces in it, rebuilt only when they (or the scene) change. */
let spaced: { base: MoveWorld; key: string; world: MoveWorld } | null = null;
function withSpaces(base: MoveWorld, t: TokenView): MoveWorld {
  const crowd = others(t).map((o) => ({
    id: o.id,
    pos: { x: o.pos.x, y: o.pos.y },
    sizeFt: o.sizeFt,
    size: (o.size || "medium") as "medium",
    disposition: side(o),
    incapacitated: incapacitates(o.conditions),
  }));
  const key = `${t.id}|${t.size}|${t.disposition}|${JSON.stringify(crowd)}`;
  if (spaced?.base === base && spaced.key === key) return spaced.world;
  const me = {
    id: t.id,
    pos: t.pos,
    sizeFt: t.sizeFt,
    size: (t.size || "medium") as "medium",
    disposition: side(t),
    incapacitated: false,
  };
  const world = withCreatureSpaces(base, me, crowd, useTable.getState().rulesPack);
  spaced = { base, key, world };
  return world;
}

/** Who a world is built for: swimmers treat water as ground; an effect's designated creatures skip its slowing. */
function creatureOf(t: TokenView): { swim: boolean; id: string } {
  return { swim: (t.own?.speedSwim ?? 0) > 0, id: t.id };
}

/**
 * What the movement range overlay measures for a token (§8.6, §16.6): the world a move of its would be planned in
 * (with the creatures' spaces where they shape a player's move), its clearance and crawl, and its budget — the
 * movement left on its turn in combat, else one move at its speed.
 */
export function rangeInputs(
  t: TokenView,
): { world: MoveWorld; rc: number; crawl: boolean; budget: number } | null {
  const base = clientMoveWorld(creatureOf(t));
  if (!base || !t.own) return null;
  const world = spacesApply() ? withSpaces(base, t) : base;
  const left = budgetFor(t);
  return { world, ...optionsFor(t), budget: left ?? t.own.budgetFt };
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
  const base = clientMoveWorld(creatureOf(t));
  if (!base) return;
  const world = spacesApply() ? withSpaces(base, t) : base;
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
  // Its budget and where it runs out; where it leaves a hostile's reach (in combat, a hint only).
  const budget = budgetFor(t);
  if (budget !== null && preview.ok) {
    preview.budget = budget;
    const reach = maxReachPoint(world, preview.points, opts, budget);
    if (reach) preview.reach = reach;
  }
  if (useCombat.getState().view.active && preview.ok) {
    const marks = opportunityMarks(
      preview.points,
      { sizeFt: t.sizeFt, disposition: side(t), disengaged: t.markers.includes("disengaged") },
      others(t).map((o) => ({
        id: o.id,
        name: o.name,
        pos: o.pos,
        sizeFt: o.sizeFt,
        reachFt: o.reachFt || 5,
        disposition: side(o),
        incapacitated: incapacitates(o.conditions),
        // Its Reaction spent (known only where its pips are: the DM, its own players), and whether it can see the
        // mover — not Blinded, the mover not Invisible (a hint: what it senses beyond sight isn't this screen's).
        canReact: o.own ? (o.own.pips & PIP.reaction) === 0 : true,
        seesMover: !o.conditions.includes("blinded") && !t.conditions.includes("invisible"),
      })),
    );
    if (marks.length) preview.oa = marks;
  }
  useMove.setState({ preview });
  moveDiag.resultAt = performance.now();
  moveDiag.resultOk = preview.ok;
}

/**
 * `move.preview` to the other viewers, at most 15 times a second (an empty path clears it) — and, while a drag is held
 * still, the same path again every HEARTBEAT_MS: viewers drop a preview that goes quiet for 1.5 s (a connection lost
 * mid-drag, remote.ts), and a player pausing to think hasn't lost theirs.
 */
let lastSent = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_MS = 500;
function broadcast(clear: boolean): void {
  const s = useMove.getState();
  const id = s.tokenId ?? lastToken;
  if (!id) return;
  const payload = () => previewPayload(id, clear);
  if (s.tokenId) lastToken = s.tokenId;
  const now = performance.now();
  const gap = 1000 / PREVIEW_HZ;
  if (pending) clearTimeout(pending);
  if (clear && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  } else if (!clear && !heartbeat)
    heartbeat = setInterval(() => {
      const cur = useMove.getState().tokenId;
      // The plan went without a clear (the token vanished, the page reset): nothing more to keep alive.
      if (!cur) {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        return;
      }
      if (performance.now() - lastSent < HEARTBEAT_MS) return;
      lastSent = performance.now();
      send("move.preview", previewPayload(cur, false));
    }, HEARTBEAT_MS / 2);
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

function previewPayload(tokenId: string, clear: boolean) {
  const p = useMove.getState().preview;
  const pts = clear || !p?.ok ? [] : decimate(p.points, PREVIEW_MAX_POINTS);
  return { tokenId, points: pts, cost: clear || !p ? 0 : Math.min(100_000, p.cost) };
}

/** At most n points, keeping the ends (previews are for show; the commit sends the full path). */
function decimate(points: P[], n: number): P[] {
  if (points.length <= n) return points;
  const out: P[] = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round((i * (points.length - 1)) / (n - 1))] as P);
  return out;
}
