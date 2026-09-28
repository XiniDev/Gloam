import type { P } from "@gloam/shared/geometry";
import type { WallView } from "@gloam/shared/state";
import { create } from "zustand";
import { request } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useUi, type WallDrawKind } from "../../state/ui.ts";
import { toast } from "../../ui/Toast.tsx";
import { boardApi } from "../boardApi.ts";
import { cameraRig } from "../CameraRig.tsx";
import { wake } from "../frames.ts";
import {
  chainSegments,
  EndIndex,
  type EndRef,
  footOn,
  MIN_WALL_FT,
  movedWalls,
  rectCorners,
  type Seg,
  SNAP_FT,
  type SnapKind,
  samePoint,
  segHitsRect,
  snapPoint,
  wallAt,
} from "./wallEdit.ts";

/**
 * The Walls tool (SPEC §8.7 Editor tools, Appendix H; AC-WAL-02, AC-WAL-07), DM only.
 *
 * - **Draw**: click points to chain walls; double-click, Enter, Esc or Done finishes; Backspace removes the last
 *   segment. Points snap to wall ends within 1 ft (a ring shows) or onto a wall's line; Shift snaps the angle to 15°;
 *   Ctrl/Cmd turns snapping off.
 * - **Room**: drag a rectangle, or click a polygon (closing on its first point, double-click, Enter or Esc).
 * - **Select**: click a wall (Shift adds), drag on empty table for a box; drag an end to move its joint — every wall
 *   meeting there follows (Alt pulls only the selected walls' ends away); drag a wall to move the selection (walls
 *   joined to it stretch to follow; Alt detaches); double-click a wall to split it; Join makes two walls meeting at
 *   an end one; kind and "hidden" apply to the selection; Delete/Backspace removes it.
 *
 * Edits show at once (a local preview) and are sent as one command — one undo step — on release.
 */

export type WallMode = "select" | "draw" | "room";

interface Drag {
  kind: "joint" | "move";
  refs: EndRef[];
  /** The world point grabbed. */
  grab: P;
  /** For a move: the selected walls' own ends, which snap (stretched neighbours follow them). */
  own: EndRef[];
  /** Walls being edited (not snapped onto). */
  moving: Set<string>;
  /** Everything else's ends (snapping). */
  index: EndIndex;
  /** Shift's angle origin for a joint drag (the far end of the wall being dragged). */
  from: P | null;
  sx: number;
  sy: number;
  started: boolean;
}

interface WallToolState {
  mode: WallMode;
  /** Points placed in the chain or room polygon being drawn. */
  chain: P[];
  /** Where the next point would go (snapped). */
  pointer: P | null;
  snap: SnapKind | null;
  /** The room rectangle being dragged. */
  rect: { a: P; b: P } | null;
  selected: string[];
  hover: string | null;
  /** The wall end under the pointer (select mode). */
  handle: P | null;
  /** Box selection, in screen pixels. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Walls where an edit is putting them — while dragging, and until the server's echo arrives. */
  preview: ReadonlyMap<string, { a: P; b: P }> | null;
  /** Walls just drawn, shown until they arrive. */
  ghosts: { a: P; b: P }[];
}

export const useWallTool = create<WallToolState>(() => ({
  mode: "draw",
  chain: [],
  pointer: null,
  snap: null,
  rect: null,
  selected: [],
  hover: null,
  handle: null,
  box: null,
  preview: null,
  ghosts: [],
}));

const BATCH = 500;
const DRAG_PX = 4;
const HANDLE_PX = 9;
const HIT_PX = 7;

let drag: Drag | null = null;
let roomPress: { p: P; sx: number; sy: number; moved: boolean } | null = null;

// ---------------------------------------------------------------- the walls as the tool sees them

let cache: { walls: ReadonlyMap<string, WallView>; segs: Map<string, Seg>; index: EndIndex } | null = null;
/** The scene's walls as segments (true positions; DMs hold every wall) and an index of their ends. */
export function wallSegs(): { segs: Map<string, Seg>; index: EndIndex } {
  const walls = boardData(useEntities.getState()).walls;
  if (!cache || cache.walls !== walls) {
    const segs = new Map<string, Seg>();
    for (const w of walls.values())
      segs.set(w.id, { id: w.id, a: { x: w.ax, y: w.ay }, b: { x: w.bx, y: w.by } });
    cache = { walls, segs, index: new EndIndex(segs.values()) };
  }
  return cache;
}

/** Feet per screen pixel at a screen point (the tool's pixel tolerances in table units). */
function ftPerPx(x: number, y: number): number {
  const p = boardApi.groundAt(x, y);
  const q = boardApi.groundAt(x + 10, y);
  return p && q ? Math.hypot(q.x - p.x, q.y - p.y) / 10 : 0.05;
}

const set = (p: Partial<WallToolState>) => {
  useWallTool.setState(p);
  wake();
};

function lockCamera(on: boolean): void {
  const c = cameraRig.controls;
  if (c) c.enabled = !on;
}

export interface PointerLike {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

function snapFor(raw: P, e: PointerLike, from: P | null): { p: P; kind: SnapKind | null } {
  const { segs, index } = wallSegs();
  const chain = useWallTool.getState().chain;
  return snapPoint(raw, {
    ends: index,
    segs: segs.values(),
    extra: chain,
    from,
    angle: e.shiftKey,
    off: e.ctrlKey || e.metaKey,
  });
}

// ---------------------------------------------------------------- pointer input

/** A left press with the Walls tool. False when the board should handle it instead (Alt+click on empty table pings). */
export function wallsDown(e: PointerLike): boolean {
  const raw = boardApi.groundAt(e.clientX, e.clientY);
  if (!raw) return false;
  const s = useWallTool.getState();
  if (s.mode === "draw") {
    if (e.altKey) return false;
    const last = s.chain[s.chain.length - 1] ?? null;
    const { p, kind } = snapFor(raw, e, last);
    // A double-click's second press lands on the point just placed.
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_WALL_FT) return true;
    const first = s.chain[0];
    if (first && s.chain.length >= 2 && samePoint(p, first)) {
      set({ chain: [...s.chain, first], pointer: p, snap: kind });
      finishChain();
      return true;
    }
    set({ chain: [...s.chain, p], pointer: p, snap: kind });
    return true;
  }
  if (s.mode === "room") {
    if (e.altKey) return false;
    const last = s.chain[s.chain.length - 1] ?? null;
    const { p, kind } = snapFor(raw, e, last);
    if (s.chain.length) {
      // A polygon room in progress: each click is a corner; its first corner closes it.
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_WALL_FT) return true;
      if (s.chain.length >= 3 && samePoint(p, s.chain[0] as P)) {
        closeRoom();
        return true;
      }
      set({ chain: [...s.chain, p], pointer: p, snap: kind });
      return true;
    }
    roomPress = { p, sx: e.clientX, sy: e.clientY, moved: false };
    lockCamera(true);
    return true;
  }
  // Select.
  const { segs, index } = wallSegs();
  const tolHandle = HANDLE_PX * ftPerPx(e.clientX, e.clientY);
  const end = handleAt(raw, tolHandle);
  const selected = new Set(s.selected);
  if (end) {
    let refs = index.joint(end);
    if (e.altKey) {
      // Pull only the selected walls' ends (or this wall's, with nothing selected) out of the joint.
      const mine = refs.filter((r) => selected.has(r.id));
      refs = mine.length ? mine : refs.filter((r) => r.id === s.hover).slice(0, 1);
      if (!refs.length) refs = index.joint(end).slice(0, 1);
    }
    const moving = new Set(refs.map((r) => r.id));
    const first = refs[0] as EndRef;
    const w = segs.get(first.id) as Seg;
    drag = {
      kind: "joint",
      refs,
      own: refs,
      grab: end,
      moving,
      index: new EndIndex(segs.values(), (id) => moving.has(id)),
      from: refs.length === 1 ? (first.end === "a" ? w.b : w.a) : null,
      sx: e.clientX,
      sy: e.clientY,
      started: false,
    };
    lockCamera(true);
    return true;
  }
  const hit = wallAt(raw, segs.values(), HIT_PX * ftPerPx(e.clientX, e.clientY));
  if (hit) {
    let sel = s.selected;
    if (e.shiftKey) {
      sel = selected.has(hit) ? s.selected.filter((id) => id !== hit) : [...s.selected, hit];
      set({ selected: sel });
      if (!sel.includes(hit)) return true;
    } else if (!selected.has(hit)) {
      sel = [hit];
      set({ selected: sel });
    }
    const own: EndRef[] = sel.flatMap((id) => [
      { id, end: "a" as const },
      { id, end: "b" as const },
    ]);
    const chosen = new Set(sel);
    const refs = [...own];
    if (!e.altKey) {
      // Walls joined to the selection stretch to follow it.
      for (const r of own) {
        const w = segs.get(r.id);
        if (!w) continue;
        for (const j of index.joint(r.end === "a" ? w.a : w.b)) if (!chosen.has(j.id)) refs.push(j);
      }
    }
    const moving = new Set(refs.map((r) => r.id));
    drag = {
      kind: "move",
      refs,
      own,
      grab: raw,
      moving,
      index: new EndIndex(segs.values(), (id) => moving.has(id)),
      from: null,
      sx: e.clientX,
      sy: e.clientY,
      started: false,
    };
    lockCamera(true);
    return true;
  }
  if (e.altKey) return false;
  set({ box: { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY } });
  boxAdd = e.shiftKey;
  lockCamera(true);
  return true;
}
let boxAdd = false;

/** The end of a selected (or the hovered) wall within `tol` of p. */
function handleAt(p: P, tol: number): P | null {
  const s = useWallTool.getState();
  const { segs } = wallSegs();
  let best: P | null = null;
  let bestD = tol;
  const ids = s.hover && !s.selected.includes(s.hover) ? [...s.selected, s.hover] : s.selected;
  for (const id of ids) {
    const w = segs.get(id);
    if (!w) continue;
    for (const q of [w.a, w.b]) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d <= bestD) {
        best = q;
        bestD = d;
      }
    }
  }
  return best;
}

export function wallsMove(e: PointerLike & { buttons: number }): void {
  const raw = boardApi.groundAt(e.clientX, e.clientY);
  if (!raw) return;
  const s = useWallTool.getState();
  if (s.mode === "draw") {
    const { p, kind } = snapFor(raw, e, s.chain[s.chain.length - 1] ?? null);
    set({ pointer: p, snap: kind });
    return;
  }
  if (s.mode === "room") {
    if (roomPress) {
      if (!roomPress.moved && Math.hypot(e.clientX - roomPress.sx, e.clientY - roomPress.sy) < DRAG_PX)
        return;
      roomPress.moved = true;
      const { p, kind } = snapFor(raw, e, null);
      set({ rect: { a: roomPress.p, b: p }, pointer: p, snap: kind });
      return;
    }
    const { p, kind } = snapFor(raw, e, s.chain[s.chain.length - 1] ?? null);
    set({ pointer: p, snap: kind });
    return;
  }
  if (s.box) {
    set({ box: { ...s.box, x1: e.clientX, y1: e.clientY } });
    return;
  }
  if (drag) {
    if (!drag.started && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < DRAG_PX) return;
    drag.started = true;
    const { segs } = wallSegs();
    const d = drag;
    const skip = (id: string) => d.moving.has(id);
    if (d.kind === "joint") {
      const to = snapPoint(raw, {
        ends: d.index,
        segs: segs.values(),
        from: d.from,
        angle: e.shiftKey,
        off: e.ctrlKey || e.metaKey,
        skip,
      });
      set({ preview: movedWalls(segs, d.refs, () => to.p), pointer: to.p, snap: to.kind });
      return;
    }
    let dx = raw.x - d.grab.x;
    let dy = raw.y - d.grab.y;
    let kind: SnapKind | null = null;
    if (!(e.ctrlKey || e.metaKey)) {
      // The selection's end that comes nearest to another wall's end snaps onto it; the rest keep their places.
      let best = SNAP_FT;
      let fix: { x: number; y: number } | null = null;
      for (const r of d.own) {
        const w = segs.get(r.id);
        if (!w) continue;
        const q = r.end === "a" ? w.a : w.b;
        const at = { x: q.x + dx, y: q.y + dy };
        const n = d.index.nearest(at, best);
        if (n && n.d < best) {
          best = n.d;
          fix = { x: n.p.x - at.x, y: n.p.y - at.y };
        }
      }
      if (fix) {
        dx += fix.x;
        dy += fix.y;
        kind = "end";
      }
    }
    set({
      preview: movedWalls(segs, d.refs, (q) => ({ x: q.x + dx, y: q.y + dy })),
      snap: kind,
      pointer: null,
    });
    return;
  }
  // Hovering: the wall under the pointer and the end it's near.
  const hover = wallAt(raw, wallSegs().segs.values(), HIT_PX * ftPerPx(e.clientX, e.clientY));
  if (hover !== s.hover) set({ hover });
  const handle = handleAt(raw, HANDLE_PX * ftPerPx(e.clientX, e.clientY));
  if (handle !== s.handle) set({ handle });
}

export function wallsUp(): void {
  const s = useWallTool.getState();
  lockCamera(false);
  if (s.mode === "room" && roomPress) {
    const press = roomPress;
    roomPress = null;
    if (s.rect) {
      const { a, b } = s.rect;
      set({ rect: null });
      if (Math.abs(b.x - a.x) >= MIN_WALL_FT && Math.abs(b.y - a.y) >= MIN_WALL_FT)
        void createWalls(chainSegments(rectCorners(a, b), true));
    } else set({ chain: [press.p], pointer: press.p });
    return;
  }
  if (s.box) {
    const box = s.box;
    set({ box: null });
    if (Math.abs(box.x1 - box.x0) < DRAG_PX && Math.abs(box.y1 - box.y0) < DRAG_PX) {
      if (!boxAdd) set({ selected: [] });
      return;
    }
    const ids: string[] = [];
    for (const w of wallSegs().segs.values()) {
      const a = boardApi.project(w.a.x, w.a.y);
      const b = boardApi.project(w.b.x, w.b.y);
      if (a && b && segHitsRect({ x: a.sx, y: a.sy }, { x: b.sx, y: b.sy }, box)) ids.push(w.id);
    }
    set({ selected: boxAdd ? [...new Set([...s.selected, ...ids])] : ids });
    return;
  }
  const d = drag;
  drag = null;
  if (!d?.started || !s.preview) {
    if (d?.started) set({ preview: null });
    return;
  }
  void commitPreview(s.preview);
}

export function wallsDoubleClick(e: PointerLike): void {
  const s = useWallTool.getState();
  if (s.mode === "draw") finishChain();
  else if (s.mode === "room") {
    if (s.chain.length >= 3) closeRoom();
  } else {
    const raw = boardApi.groundAt(e.clientX, e.clientY);
    if (!raw) return;
    const { segs } = wallSegs();
    const id = wallAt(raw, segs.values(), HIT_PX * ftPerPx(e.clientX, e.clientY));
    const w = id ? segs.get(id) : undefined;
    if (!id || !w) return;
    const at = footOn(raw, w.a, w.b).p;
    void request<{ wallIds: string[] }>("wall.split", { wallId: id, at })
      .then((r) => set({ selected: r.wallIds }))
      .catch((err: Error) => toast.info("Can't split there", err.message));
  }
}

/** Keys while the Walls tool is active; true when handled. */
export function wallsKey(e: KeyboardEvent): boolean {
  const s = useWallTool.getState();
  const drawing = s.mode !== "select" && s.chain.length > 0;
  if (e.key === "Escape") {
    if (drag) {
      drag = null;
      lockCamera(false);
      set({ preview: null });
    } else if (s.rect || roomPress) {
      roomPress = null;
      lockCamera(false);
      set({ rect: null });
    } else if (drawing) {
      if (s.mode === "draw") finishChain();
      else if (s.chain.length >= 3) closeRoom();
      else set({ chain: [] });
    } else if (s.selected.length) set({ selected: [] });
    else useUi.getState().set({ tool: "select" });
    return true;
  }
  if (e.key === "Enter" && drawing) {
    if (s.mode === "draw") finishChain();
    else if (s.chain.length >= 3) closeRoom();
    return true;
  }
  if (e.key === "Backspace" && drawing) {
    removeLastPoint();
    return true;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && s.mode === "select" && s.selected.length) {
    void deleteSelected();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- actions (also the tool bar's buttons)

export function setWallMode(mode: WallMode): void {
  finishChain();
  drag = null;
  roomPress = null;
  set({ mode, chain: [], rect: null, box: null, pointer: null, snap: null, handle: null, hover: null });
}

/** Backspace while drawing: the last segment goes (the last point). */
export function removeLastPoint(): void {
  const chain = useWallTool.getState().chain;
  set({ chain: chain.slice(0, -1) });
}

/** Ends the chain being drawn, creating its walls. */
export function finishChain(): void {
  const s = useWallTool.getState();
  if (s.mode !== "draw" || !s.chain.length) return;
  const segs = chainSegments(s.chain);
  set({ chain: [] });
  if (segs.length) void createWalls(segs);
}

/** Closes the polygon room being drawn. */
export function closeRoom(): void {
  const s = useWallTool.getState();
  if (s.mode !== "room" || s.chain.length < 3) return;
  const segs = chainSegments(s.chain, true);
  set({ chain: [] });
  void createWalls(segs);
}

const randomGroup = () =>
  `walls_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("")}`;

/** Sends batches of ≤ 500 under one undo group. */
async function batched(
  type: string,
  items: unknown[],
  payload: (chunk: unknown[]) => object,
): Promise<unknown[]> {
  const group = items.length > BATCH ? randomGroup() : undefined;
  const out: unknown[] = [];
  for (let i = 0; i < items.length; i += BATCH)
    out.push(
      await request(type, { ...payload(items.slice(i, i + BATCH)), ...(group ? { undoGroup: group } : {}) }),
    );
  return out;
}

/** Waits for the table state to show an edit (or gives up after 2 s), then runs `done`. */
function onEcho(arrived: () => boolean, done: () => void): void {
  if (arrived()) {
    done();
    return;
  }
  const off = useEntities.subscribe(() => {
    if (!arrived()) return;
    off();
    clearTimeout(timer);
    done();
  });
  const timer = setTimeout(() => {
    off();
    done();
  }, 2000);
}

async function createWalls(segs: { a: P; b: P }[]): Promise<void> {
  const sceneId = boardData(useEntities.getState()).scene?.id;
  if (!sceneId || !segs.length) return;
  const ui = useUi.getState();
  const kind: WallDrawKind = ui.wallKind;
  set({ ghosts: [...useWallTool.getState().ghosts, ...segs] });
  const drop = () => set({ ghosts: useWallTool.getState().ghosts.filter((g) => !segs.includes(g)) });
  try {
    const res = (await batched(
      "wall.create",
      segs.map((s) => ({ a: s.a, b: s.b, kind, hidden: ui.wallHidden })),
      (walls) => ({ sceneId, walls }),
    )) as { wallIds: string[] }[];
    const ids = res.flatMap((r) => r.wallIds);
    onEcho(() => ids.every((id) => boardData(useEntities.getState()).walls.has(id)), drop);
  } catch (err) {
    drop();
    toast.danger("Couldn't add those walls", (err as Error).message);
  }
}

const near = (x: number, y: number, p: P) => Math.abs(x - p.x) < 1e-3 && Math.abs(y - p.y) < 1e-3;

async function commitPreview(preview: ReadonlyMap<string, { a: P; b: P }>): Promise<void> {
  const { segs } = wallSegs();
  const patches: { wallId: string; a?: P; b?: P }[] = [];
  for (const [id, w] of preview) {
    const cur = segs.get(id);
    if (!cur) continue;
    const p: { wallId: string; a?: P; b?: P } = { wallId: id };
    if (cur.a.x !== w.a.x || cur.a.y !== w.a.y) p.a = w.a;
    if (cur.b.x !== w.b.x || cur.b.y !== w.b.y) p.b = w.b;
    if (p.a || p.b) patches.push(p);
  }
  if (!patches.length) {
    set({ preview: null });
    return;
  }
  const clear = () => {
    if (useWallTool.getState().preview === preview) set({ preview: null });
  };
  try {
    await batched("wall.update", patches, (walls) => ({ walls }));
    const matches = () => {
      const walls = boardData(useEntities.getState()).walls;
      return patches.every((p) => {
        const w = walls.get(p.wallId);
        // Gone (collapsed to a point) or where the edit put it (the synced state holds float32 coordinates).
        return !w || ((!p.a || near(w.ax, w.ay, p.a)) && (!p.b || near(w.bx, w.by, p.b)));
      });
    };
    onEcho(matches, clear);
  } catch (err) {
    clear();
    toast.danger("Couldn't move those walls", (err as Error).message);
  }
}

export async function deleteSelected(): Promise<void> {
  const ids = useWallTool.getState().selected;
  if (!ids.length) return;
  set({ selected: [], hover: null, handle: null });
  try {
    await batched("wall.delete", ids, (wallIds) => ({ wallIds }));
    toast.info(`Deleted ${ids.length === 1 ? "a wall" : `${ids.length} walls`}`, "Ctrl+Z brings them back.");
  } catch (err) {
    toast.danger("Couldn't delete those walls", (err as Error).message);
  }
}

/** Kind or "hidden" for the selected walls (Select), or for the walls drawn next. */
export async function applyToSelection(patch: { kind?: WallDrawKind; hidden?: boolean }): Promise<void> {
  const s = useWallTool.getState();
  if (s.mode !== "select" || !s.selected.length) {
    useUi.getState().set({
      ...(patch.kind ? { wallKind: patch.kind } : {}),
      ...(patch.hidden !== undefined ? { wallHidden: patch.hidden } : {}),
    });
    return;
  }
  try {
    await batched(
      "wall.update",
      s.selected.map((wallId) => ({ wallId, ...patch })),
      (walls) => ({ walls }),
    );
  } catch (err) {
    toast.danger("Couldn't change those walls", (err as Error).message);
  }
}

/** Two selected walls meeting at an end become one. */
export async function joinSelected(): Promise<void> {
  const [a, b] = useWallTool.getState().selected;
  if (!a || !b) return;
  try {
    const r = await request<{ wallId: string }>("wall.join", { wallIds: [a, b] });
    set({ selected: [r.wallId] });
  } catch (err) {
    toast.info("Can't join those", (err as Error).message);
  }
}

/** Can the two selected walls be joined (they meet at an end)? */
export function canJoin(selected: string[]): boolean {
  if (selected.length !== 2) return false;
  const { segs } = wallSegs();
  const [w1, w2] = selected.map((id) => segs.get(id));
  if (!w1 || !w2) return false;
  return [w1.a, w1.b].some((p) => samePoint(p, w2.a) || samePoint(p, w2.b));
}

// ---------------------------------------------------------------- housekeeping

// Leaving the tool finishes what's being drawn; a new scene starts clean; deleted walls leave the selection.
useUi.subscribe((ui, prev) => {
  if (prev.tool === "walls" && ui.tool !== "walls") {
    finishChain();
    if (useWallTool.getState().mode === "room") closeRoom();
    drag = null;
    roomPress = null;
    set({ chain: [], rect: null, box: null, selected: [], hover: null, handle: null, pointer: null });
  }
});
let lastScene: string | null = null;
useEntities.subscribe((st) => {
  const d = boardData(st);
  const scene = d.scene?.id ?? null;
  if (scene !== lastScene) {
    lastScene = scene;
    drag = null;
    roomPress = null;
    useWallTool.setState({
      chain: [],
      rect: null,
      box: null,
      selected: [],
      hover: null,
      handle: null,
      preview: null,
    });
    return;
  }
  const s = useWallTool.getState();
  if (s.selected.some((id) => !d.walls.has(id)))
    useWallTool.setState({ selected: s.selected.filter((id) => d.walls.has(id)) });
});
