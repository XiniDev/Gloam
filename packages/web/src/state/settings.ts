import { create } from "zustand";

/** Per-device preferences (SPEC §8.22), persisted to localStorage (wrapped in try/catch: storage may be blocked). */
export interface DeviceSettings {
  /** Slider positions 0–1, heard through a −48 dB law (sound.md §6.1: engine.ts `sliderGain`). */
  volumes: Record<"master" | "dice" | "effects" | "ui" | "music" | "ambience", number>;
  channelMuted: Record<"master" | "dice" | "effects" | "ui" | "music" | "ambience", boolean>;
  muted: boolean;
  tier: "auto" | "ultra" | "high" | "medium" | "low";
  uiScale: number;
  motion: "system" | "full" | "reduced";
  colorBlind: boolean;
  dmCanMoveCamera: boolean;
  focusOnMyTurn: boolean;
  shareRulers: boolean | null;
  diceAnimation: boolean;
  units: "campaign" | "ft" | "m";
  /** With a token you control selected, hovering the floor previews a move and a click commits it (SPEC §8.6). */
  clickToMove: boolean;
  /** The dice tray stays open after a roll (it closes by default, so the dice have the board). */
  diceTrayKeepOpen: boolean;
  /** Which law `volumes` are saved under ("db48"); older saves held linear gains. */
  volumeLaw?: "db48";
  /**
   * The DM's wall lines (SPEC §8.19 "walls overlay toggle"): every wall, only the ones 3D walls don't show for what
   * they are (secret, hidden, invisible, windows, curtains, doors), or none. Unset: every wall on a flat map, only
   * those with 3D walls (every wall in bone-white over stone walls read as a floor plan: critic P12 r1 B4).
   */
  wallLines: "all" | "special" | "none" | null;
}

const KEY = "gloam.settings.v1";

export const DEFAULT_SETTINGS: DeviceSettings = {
  // Master −3 dB, dice and effects 0, UI −3, music and ambience −6 (sound.md §6.1).
  volumes: { master: 0.94, dice: 1, effects: 1, ui: 0.94, music: 0.875, ambience: 0.875 },
  channelMuted: { master: false, dice: false, effects: false, ui: false, music: false, ambience: false },
  muted: false,
  tier: "auto",
  uiScale: 1,
  motion: "system",
  colorBlind: false,
  dmCanMoveCamera: true,
  focusOnMyTurn: true,
  shareRulers: null,
  diceAnimation: true,
  units: "campaign",
  clickToMove: true,
  diceTrayKeepOpen: false,
  volumeLaw: "db48",
  wallLines: null,
};

function load(): DeviceSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<DeviceSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // Volumes saved before the slider law (linear gains) start again from the defaults.
      volumes: { ...DEFAULT_SETTINGS.volumes, ...(parsed.volumeLaw === "db48" ? parsed.volumes : {}) },
      volumeLaw: "db48",
      channelMuted: { ...DEFAULT_SETTINGS.channelMuted, ...parsed.channelMuted },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface SettingsStore extends DeviceSettings {
  update(patch: Partial<DeviceSettings>): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  update(patch) {
    set(patch);
    const { update: _u, ...rest } = get();
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(rest));
    } catch {
      // private window or blocked storage: settings last for this page only
    }
    applyDocumentSettings();
  },
}));

/** Reflects scale, motion and colour-blind choices on <html> so CSS tokens respond. */
export function applyDocumentSettings(): void {
  if (typeof document === "undefined") return;
  const s = useSettings.getState();
  const root = document.documentElement;
  root.style.setProperty("--ui-scale", String(Math.min(1.3, Math.max(0.9, s.uiScale))));
  if (s.motion === "system") delete root.dataset.motion;
  else root.dataset.motion = s.motion;
  if (s.colorBlind) root.dataset.cb = "1";
  else delete root.dataset.cb;
}

/** True when animations should be reduced (setting, or the OS preference when set to "system"). */
export function prefersReducedMotion(): boolean {
  const s = useSettings.getState();
  if (s.motion === "reduced") return true;
  if (s.motion === "full") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
