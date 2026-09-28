import type { P } from "@gloam/shared/geometry";
import { create } from "zustand";
import { request } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { toast } from "../../ui/Toast.tsx";
import { boardApi } from "../boardApi.ts";
import { cameraRig } from "../CameraRig.tsx";
import { wake } from "../frames.ts";
import type { PointerLike } from "./walls.ts";

/** The DM's Lights tool (SPEC §8.8 Light; Appendix H: I): place lights from presets, select, move, edit, delete. */
interface LightToolState {
  /** The preset a click on empty floor places. */
  preset: string;
  selected: string | null;
  /** A light being dragged: where it would go. */
  preview: { id: string; at: P } | null;
}

export const useLightTool = create<LightToolState>(() => ({
  preset: "torch",
  selected: null,
  preview: null,
}));

const set = (p: Partial<LightToolState>) => {
  useLightTool.setState(p);
  wake();
};

/** A press grabs a light within this many screen pixels (or 1 ft). */
const GRAB_PX = 18;
const DRAG_PX = 4;
let press: { id: string | null; sx: number; sy: number; at: P; moved: boolean } | null = null;

function lockCamera(on: boolean): void {
  const c = cameraRig.controls;
  if (c) c.enabled = !on;
}

/** The free-standing light under a screen point (carried lights go with their tokens). */
function lightAt(clientX: number, clientY: number): string | null {
  const lights = boardData(useEntities.getState()).lights;
  let best: string | null = null;
  let bestD = GRAB_PX;
  for (const l of lights.values()) {
    if (l.link?.tokenId) continue;
    const s = boardApi.project(l.x, l.y, l.elevation);
    if (!s) continue;
    const d = Math.hypot(s.sx - clientX, s.sy - clientY);
    if (d <= bestD) {
      bestD = d;
      best = l.id;
    }
  }
  return best;
}

export function lightsDown(e: PointerLike): boolean {
  const p = boardApi.groundAt(e.clientX, e.clientY);
  if (!p) return false;
  const id = lightAt(e.clientX, e.clientY);
  press = { id, sx: e.clientX, sy: e.clientY, at: p, moved: false };
  if (id) {
    set({ selected: id });
    lockCamera(true);
  }
  return true;
}

export function lightsMove(e: PointerLike): void {
  if (!press?.id) return;
  if (!press.moved && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) < DRAG_PX) return;
  press.moved = true;
  const p = boardApi.groundAt(e.clientX, e.clientY);
  if (p) set({ preview: { id: press.id, at: p } });
}

export function lightsUp(): void {
  const pr = press;
  press = null;
  lockCamera(false);
  if (!pr) return;
  if (pr.id) {
    const pv = useLightTool.getState().preview;
    if (pr.moved && pv) {
      void request("light.update", { lightId: pr.id, pos: { x: pv.at.x, y: pv.at.y } })
        .catch((err) => toast.danger("Couldn't move the light", (err as Error).message))
        .finally(() => set({ preview: null }));
    } else set({ preview: null });
    return;
  }
  // A click on empty floor places a light from the preset (and selects it).
  const scene = useEntities.getState().live.scene;
  if (!scene) return;
  void request<{ lightId: string }>("light.create", {
    sceneId: scene.id,
    pos: { x: pr.at.x, y: pr.at.y },
    preset: useLightTool.getState().preset,
  })
    .then((r) => set({ selected: r.lightId }))
    .catch((err) => toast.danger("Couldn't place the light", (err as Error).message));
}

/** Delete/Backspace removes the selected light; Esc drops the selection. */
export function lightsKey(e: KeyboardEvent): boolean {
  const s = useLightTool.getState();
  if ((e.key === "Delete" || e.key === "Backspace") && s.selected) {
    const id = s.selected;
    set({ selected: null });
    void request("light.delete", { lightIds: [id] }).catch((err) =>
      toast.danger("Couldn't remove the light", (err as Error).message),
    );
    return true;
  }
  if (e.key === "Escape" && s.selected) {
    set({ selected: null });
    return true;
  }
  return false;
}
