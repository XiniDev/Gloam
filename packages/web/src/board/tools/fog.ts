import type { P } from "@gloam/shared/geometry";
import { create } from "zustand";
import { request } from "../../net/table.ts";
import { useEntities } from "../../state/entities.ts";
import { toast } from "../../ui/Toast.tsx";
import { boardApi } from "../boardApi.ts";
import { cameraRig } from "../CameraRig.tsx";
import { wake } from "../frames.ts";
import type { PointerLike } from "./walls.ts";

/** The DM's fog tools (SPEC §8.8): brush, rectangle, polygon and Reveal room; reveal or hide; for all players or one. */
export type FogShapeMode = "brush" | "rect" | "polygon" | "room";

interface FogToolState {
  shape: FogShapeMode;
  reveal: boolean;
  /** "all" or a player's user id. */
  target: string;
  /** Brush radius (ft). */
  radius: number;
  /** A brush stroke or rectangle being drawn, or polygon corners placed so far. */
  points: P[];
  rect: { a: P; b: P } | null;
  pointer: P | null;
}

export const useFogTool = create<FogToolState>(() => ({
  shape: "brush",
  reveal: true,
  target: "all",
  radius: 5,
  points: [],
  rect: null,
  pointer: null,
}));

const set = (p: Partial<FogToolState>) => {
  useFogTool.setState(p);
  wake();
};

function lockCamera(on: boolean): void {
  const c = cameraRig.controls;
  if (c) c.enabled = !on;
}

const group = () =>
  `fog_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("")}`;

/** A stroke goes to the server in pieces while it's painted: one undo step for the whole stroke. */
let stroke: { group: string; sent: number; last: P | null } | null = null;
const STROKE_STEP_FT = 0.75;

function sceneId(): string | null {
  return useEntities.getState().live.scene?.id ?? null;
}

async function paint(shape: object, undoGroup?: string): Promise<void> {
  const s = useFogTool.getState();
  const id = sceneId();
  if (!id) return;
  try {
    await request("fog.paint", {
      sceneId: id,
      mode: s.reveal ? "reveal" : "hide",
      target: s.target,
      shape,
      ...(undoGroup ? { undoGroup } : {}),
    });
  } catch (e) {
    toast.danger("Couldn't paint the fog", (e as Error).message);
  }
}

/** Sends the stroke's new points (with the last sent one again, so the pieces join). */
function flushStroke(final: boolean): void {
  const st = stroke;
  const s = useFogTool.getState();
  if (!st) return;
  const pts = s.points.slice(Math.max(0, st.sent - 1));
  if (pts.length === 0 || (!final && pts.length < 12)) return;
  st.sent = s.points.length;
  void paint({ kind: "brush", points: pts, radius: s.radius }, st.group);
}

export function fogDown(e: PointerLike): boolean {
  const p = boardApi.groundAt(e.clientX, e.clientY);
  if (!p) return false;
  const s = useFogTool.getState();
  switch (s.shape) {
    case "brush":
      stroke = { group: group(), sent: 0, last: p };
      set({ points: [p], pointer: p });
      lockCamera(true);
      return true;
    case "rect":
      set({ rect: { a: p, b: p }, pointer: p });
      lockCamera(true);
      return true;
    case "polygon": {
      const first = s.points[0];
      if (first && s.points.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < 1) {
        closePolygon();
        return true;
      }
      set({ points: [...s.points, p], pointer: p });
      return true;
    }
    case "room":
      void paint({ kind: "room", x: p.x, y: p.y });
      return true;
  }
}

export function fogMove(e: PointerLike): void {
  const p = boardApi.groundAt(e.clientX, e.clientY);
  if (!p) return;
  const s = useFogTool.getState();
  if (s.shape === "brush" && stroke) {
    const last = stroke.last;
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= STROKE_STEP_FT) {
      stroke.last = p;
      set({ points: [...s.points, p], pointer: p });
      flushStroke(false);
    } else set({ pointer: p });
    return;
  }
  if (s.shape === "rect" && s.rect) {
    set({ rect: { a: s.rect.a, b: p }, pointer: p });
    return;
  }
  set({ pointer: p });
}

export function fogUp(): void {
  const s = useFogTool.getState();
  lockCamera(false);
  if (s.shape === "brush" && stroke) {
    flushStroke(true);
    stroke = null;
    set({ points: [] });
    return;
  }
  if (s.shape === "rect" && s.rect) {
    const { a, b } = s.rect;
    set({ rect: null });
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (w >= 0.5 && h >= 0.5)
      void paint({ kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w, h });
  }
}

export function closePolygon(): void {
  const s = useFogTool.getState();
  if (s.points.length >= 3) void paint({ kind: "polygon", points: s.points });
  set({ points: [] });
}

/** Esc: drops the polygon or rectangle being drawn; with nothing drawn, says so (the tool then closes). */
export function fogEscape(): boolean {
  const s = useFogTool.getState();
  if (!s.points.length && !s.rect) return false;
  set({ points: [], rect: null });
  return true;
}

/** Reveal all / Hide all, whatever mode the brush is in. */
export async function paintAll(reveal: boolean): Promise<void> {
  const s = useFogTool.getState();
  const id = sceneId();
  if (!id) return;
  try {
    await request("fog.paint", {
      sceneId: id,
      mode: reveal ? "reveal" : "hide",
      target: s.target,
      shape: { kind: "all" },
    });
  } catch (e) {
    toast.danger("Couldn't paint the fog", (e as Error).message);
  }
}

export function setFogShape(shape: FogShapeMode): void {
  set({ shape, points: [], rect: null });
}
