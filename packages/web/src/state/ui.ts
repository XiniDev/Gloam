import type { RollVisibility } from "@gloam/shared/dice";
import { create } from "zustand";

/** Board tools (SPEC §29.3 left toolbar). DM-only tools arrive with their phases. */
export type Tool = "select" | "pan" | "measure" | "ping" | "target" | "walls" | "zones" | "lights" | "fog";
export type WallDrawKind = "wall" | "door" | "window" | "curtain" | "invisible" | "secret";
export type DockTab = "party" | "sheet" | "spells" | "log" | "dm";
export type DmSection = "scenes" | "library" | "approvals";

export interface CameraMemory {
  position: [number, number, number];
  target: [number, number, number];
}

interface UiStore {
  tool: Tool;
  selection: string[];
  hover: string | null;
  dock: DockTab | null;
  dmSection: DmSection;
  /** The scene a DM is preparing (SPEC §13.7), or null for the live scene. */
  prepSceneId: string | null;
  /** Radial menu anchor (screen px) and token, or null. */
  radial: { tokenId: string; x: number; y: number } | null;
  quickUnit: { x: number; y: number } | null;
  /** The scene whose 3D map the DM is aligning (transform gizmo + Generate walls), or null. */
  mapTool: string | null;
  /** The New scene wizard: open (true) or open with a map already chosen (its asset id), or closed. */
  sceneWizard: true | { assetId: string } | null;
  /** Last camera per scene, restored after a reconnect or reload (AC-AUTH-07). */
  cameras: Record<string, CameraMemory>;
  /** Walls tool: the kind drawn next, and whether new walls are hidden from players (SPEC §8.7). */
  wallKind: WallDrawKind;
  wallHidden: boolean;
  /** Zones tool: the kind drawn next. */
  zoneKind: "difficult" | "water" | "hazard" | "impassable" | "label";
  /** Measure tool shape (SPEC §8.6 Measurement tools) and the line tool's width in feet. */
  measureShape: "ruler" | "radius" | "cone" | "line" | "cube";
  lineWidthFt: number;
  /** The dice tray is open (SPEC §8.9, hotkey D). */
  diceTray: boolean;
  /** What's in the tray: kept while it's closed (a phone's tray closes to show the dice; it opens again as it was). */
  diceDraft: { formula: string; label: string; visibility: RollVisibility };
  set(p: Partial<UiStore>): void;
  select(ids: string[], mode?: "replace" | "toggle"): void;
  rememberCamera(sceneId: string, cam: CameraMemory): void;
}

const KEY = "gloam.ui.v1";
type Persisted = Pick<UiStore, "selection" | "cameras" | "dock">;

function load(): Partial<Persisted> {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
  } catch {
    return {};
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Saves (debounced 250 ms) whatever the store holds when the timer fires — not the state of the first call. */
function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const s = useUi.getState();
      const p: Persisted = { selection: s.selection, cameras: s.cameras, dock: s.dock };
      globalThis.sessionStorage?.setItem(KEY, JSON.stringify(p));
    } catch {
      // storage blocked: the view just won't survive a reload
    }
  }, 250);
}

const initial = load();

export const useUi = create<UiStore>((set, get) => ({
  tool: "select",
  selection: initial.selection ?? [],
  hover: null,
  dock: initial.dock ?? null,
  dmSection: "scenes",
  prepSceneId: null,
  radial: null,
  quickUnit: null,
  mapTool: null,
  sceneWizard: null,
  cameras: initial.cameras ?? {},
  wallKind: "wall",
  wallHidden: false,
  zoneKind: "difficult",
  measureShape: "ruler",
  lineWidthFt: 5,
  diceTray: false,
  diceDraft: { formula: "1d20", label: "", visibility: "public" },
  set(p) {
    set(p);
    persist();
  },
  select(ids, mode = "replace") {
    if (mode === "replace") set({ selection: [...new Set(ids)] });
    else {
      const cur = new Set(get().selection);
      for (const id of ids) {
        if (cur.has(id)) cur.delete(id);
        else cur.add(id);
      }
      set({ selection: [...cur] });
    }
    persist();
  },
  rememberCamera(sceneId, cam) {
    set({ cameras: { ...get().cameras, [sceneId]: cam } });
    persist();
  },
}));
