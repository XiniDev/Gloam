import { Move, Rotate3d, Scaling, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { type MapTransform, useMapAlign } from "../../board/map/mapAlign.ts";
import { sceneCalibration } from "../../board/scene.ts";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { toast } from "../../ui/Toast.tsx";
import { underTopBar, useHudInsets, useIsPhone } from "../insets.ts";

const BATCH = 500;

const sameTransform = (a: MapTransform, b: MapTransform) =>
  Math.abs(a.position.x - b.position.x) < 1e-6 &&
  Math.abs(a.position.y - b.position.y) < 1e-6 &&
  Math.abs(a.position.z - b.position.z) < 1e-6 &&
  Math.abs(a.rotationYDeg - b.rotationYDeg) < 1e-6 &&
  Math.abs(a.scale - b.scale) < 1e-9;

function NumField({
  label,
  value,
  suffix,
  onCommit,
  min,
  max,
}: {
  label: string;
  value: number;
  suffix: string;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(Number(value.toFixed(2)))), [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
      setText(String(Number(value.toFixed(2))));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="caps mb-1 block text-12 text-fog">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setText(String(value));
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="h-8 w-full rounded-[var(--radius-control)] border border-line bg-ink-900 px-2 pr-6 text-14 text-bone tabular-nums hover:border-line-strong focus:border-brass"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-12 text-faint">
          {suffix}
        </span>
      </div>
    </div>
  );
}

const randomGroup = () =>
  `genwalls_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("")}`;

/**
 * 3D map tools (SPEC §8.3; AC-SCN-04): align the GLB on the table (gizmo on the board or exact numbers here) and
 * Generate walls from a horizontal slice. The generated walls are ordinary walls: editable, and one Ctrl+Z removes
 * the whole set.
 */
export function MapToolsPanel() {
  const mapTool = useUi((s) => s.mapTool);
  const scene = useBoard((d) => d.scene);
  const wallIds = useBoard((d) => d.walls);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const mode = useMapAlign((s) => s.mode);
  const live = useMapAlign((s) => s.live);
  const object = useMapAlign((s) => s.object);
  const banner = useHudInsets((s) => s.banner);
  const dockRight = useHudInsets((s) => s.right);
  const phone = useIsPhone();
  // On a phone the dock's panel would cover the map being aligned: close it while the tools are open.
  const aligning = dm && scene?.mapKind === "model" && mapTool === scene.id;
  useEffect(() => {
    if (phone && aligning) useUi.getState().set({ dock: null });
  }, [phone, aligning]);
  const [slice, setSlice] = useState(5);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Edits sent but not yet echoed back: quick successive field commits (X, then Z, then Turn) each build on the
   * previous one instead of on the last confirmed transform, which would undo them.
   */
  const draft = useRef<MapTransform | null>(null);
  const [, redraw] = useState(0);

  const open = dm && !!scene && scene.mapKind === "model" && mapTool === scene.id;
  const calib = sceneCalibration(scene);
  useEffect(() => {
    if (open) setSlice(calib.sliceFt ?? 5);
  }, [open, calib.sliceFt]);

  // Keyboard: W / E / R pick move, rotate, scale while the tools are open (as in most 3D tools).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const m = { KeyW: "translate", KeyE: "rotate", KeyR: "scale" } as const;
      const next = m[e.code as keyof typeof m];
      if (next) useMapAlign.getState().set({ mode: next });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !scene) return null;
  const confirmed: MapTransform = {
    position: calib.position ?? { x: 0, y: 0, z: 0 },
    rotationYDeg: calib.rotationYDeg ?? 0,
    scale: calib.scale ?? 1,
  };
  // The server has caught up (or the gizmo took over): the draft is done.
  if (draft.current && (live || sameTransform(draft.current, confirmed))) draft.current = null;
  const t: MapTransform = live ?? draft.current ?? confirmed;
  const save = (next: Partial<MapTransform>, sliceFt?: number) => {
    const base = draft.current ?? t;
    const transform = { ...base, ...next, position: { ...base.position, ...next.position } };
    draft.current = transform;
    redraw((n) => n + 1);
    return request("scene.calibrate", {
      sceneId: scene.id,
      transform,
      ...(sliceFt !== undefined ? { sliceFt } : {}),
    }).catch((e) => {
      draft.current = null;
      redraw((n) => n + 1);
      toast.danger("Couldn't move the map", (e as Error).message);
    });
  };

  const generate = async (replace: boolean) => {
    setAsking(false);
    if (!object) return;
    setBusy("Slicing the map…");
    // Let the label paint before the (synchronous) slice.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
      // three-mesh-bvh loads only when a DM actually generates walls.
      const { generateWalls } = await import("../../board/map/wallGen.ts");
      const walls = generateWalls(object, slice);
      if (!walls.length) {
        toast.info(
          "No walls at that height",
          `Nothing of the map crosses ${slice} ft. Try another slice height.`,
        );
        return;
      }
      const group = randomGroup();
      if (slice !== (calib.sliceFt ?? 5)) await save({}, slice);
      if (replace) {
        const ids = [...wallIds.keys()];
        for (let i = 0; i < ids.length; i += BATCH) {
          setBusy(`Removing old walls… ${Math.min(i + BATCH, ids.length)} / ${ids.length}`);
          await request("wall.delete", { wallIds: ids.slice(i, i + BATCH), undoGroup: group });
        }
      }
      for (let i = 0; i < walls.length; i += BATCH) {
        setBusy(`Creating walls… ${Math.min(i + BATCH, walls.length)} / ${walls.length}`);
        await request("wall.create", {
          sceneId: scene.id,
          undoGroup: group,
          walls: walls.slice(i, i + BATCH).map((w) => ({ a: w.a, b: w.b, kind: "wall" })),
        });
      }
      toast.success(
        `Generated ${walls.length} wall${walls.length === 1 ? "" : "s"}`,
        "They're ordinary walls you can edit. Ctrl+Z removes the whole set.",
      );
    } catch (e) {
      toast.danger("Couldn't generate walls", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label="3D map tools"
      data-testid="map-tools"
      // Beside the toolbar, below the top bar and the prep banner (never over either). On phones it takes the width
      // up to the dock's rail, and the toolbar steps aside while aligning (its tools don't apply here).
      className="panel pointer-events-auto absolute z-30 flex flex-col gap-3 p-3"
      style={
        phone
          ? { top: underTopBar(banner), left: 12, right: dockRight }
          : { top: underTopBar(banner), left: 76, width: "min(300px, calc(100vw - 96px))" }
      }
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="caps text-12 text-brass">Align 3D map</h2>
        <IconButton label="Close the map tools" onClick={() => useUi.getState().set({ mapTool: null })}>
          <X size={16} />
        </IconButton>
      </header>
      <Segmented<"translate" | "rotate" | "scale">
        label="Gizmo"
        size="S"
        value={mode}
        onChange={(m) => useMapAlign.getState().set({ mode: m })}
        options={[
          { value: "translate", label: <Move size={16} aria-label="Move (W)" />, hint: "Move (W)" },
          {
            value: "rotate",
            label: <Rotate3d size={16} aria-label="Rotate about Y (E)" />,
            hint: "Rotate about Y (E)",
          },
          {
            value: "scale",
            label: <Scaling size={16} aria-label="Uniform scale (R)" />,
            hint: "Uniform scale (R)",
          },
        ]}
      />
      <div className="grid grid-cols-3 gap-2">
        <NumField
          label="X"
          suffix="ft"
          value={t.position.x}
          onCommit={(x) => void save({ position: { ...t.position, x } })}
        />
        <NumField
          label="Height"
          suffix="ft"
          value={t.position.y}
          onCommit={(y) => void save({ position: { ...t.position, y } })}
        />
        <NumField
          label="Z"
          suffix="ft"
          value={t.position.z}
          onCommit={(z) => void save({ position: { ...t.position, z } })}
        />
        <NumField
          label="Turn"
          suffix="°"
          min={-360}
          max={360}
          value={t.rotationYDeg}
          onCommit={(rotationYDeg) => void save({ rotationYDeg })}
        />
        <NumField
          label="Scale"
          suffix="×"
          min={0.001}
          max={1000}
          value={t.scale}
          onCommit={(scale) => void save({ scale })}
        />
      </div>
      <div className="border-t border-[var(--line-soft)] pt-3">
        <div className="flex items-end gap-2">
          <div className="w-24">
            <NumField label="Slice at" suffix="ft" min={1} max={20} value={slice} onCommit={setSlice} />
          </div>
          <Button
            size="S"
            variant="primary"
            loading={busy !== null}
            disabled={!object}
            onClick={() => (wallIds.size ? setAsking(true) : void generate(false))}
          >
            Generate walls
          </Button>
        </div>
        <p className="mt-1.5 text-12 text-faint">
          Slices the map {slice} ft above the table and turns what it cuts into walls.
        </p>
        {busy ? (
          <p role="status" className="mt-1.5 text-13 text-muted">
            {busy}
          </p>
        ) : null}
        {asking ? (
          <div
            role="alertdialog"
            aria-label="Existing walls"
            className="mt-2 flex flex-col gap-2 rounded-[var(--radius-control)] border border-line p-2"
          >
            <p className="text-13 text-bone">
              This scene already has {wallIds.size} wall{wallIds.size === 1 ? "" : "s"}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="S" variant="primary" onClick={() => void generate(true)}>
                Replace them
              </Button>
              <Button size="S" variant="secondary" onClick={() => void generate(false)}>
                Add to them
              </Button>
              <Button size="S" variant="ghost" onClick={() => setAsking(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
