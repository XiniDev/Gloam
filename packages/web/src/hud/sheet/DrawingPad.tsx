import { DRAWING_SWATCHES } from "@gloam/shared";
import { ImagePlus, Redo2, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { uploadAsset } from "../../net/upload.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented, Slider } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";
import { type DrawTool, drawStroke, PAD_SIZE, type Stroke, StrokeHistory } from "./drawing.ts";

/** What the drawing becomes: the sheet's portrait, or its token as a paper standee or a coin. */
export type DrawingUse = "portrait" | "standee" | "coin";

/**
 * The drawing pad (SPEC §8.10 Character art, AC-SHEET-10): a 1024 × 1024 transparent canvas — pencil, ink (its width
 * from the pen's pressure), marker and eraser; sixteen swatches and a picker; a size; undo and redo (50 steps); an
 * optional faint photo underneath to trace. Exported as a PNG through the usual upload (a player's waits for the DM),
 * then used as the portrait, a standee or a coin.
 */
export function DrawingPad({
  open,
  onClose,
  onUse,
}: {
  open: boolean;
  onClose: () => void;
  onUse: (assetId: string, as: DrawingUse) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const history = useRef<StrokeHistory | null>(null);
  const current = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<DrawTool>("ink");
  const [color, setColor] = useState<string>(DRAWING_SWATCHES[0].hex);
  const [size, setSize] = useState(6);
  const [reference, setReference] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  const redraw = useCallback(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    g.clearRect(0, 0, PAD_SIZE, PAD_SIZE);
    if (base.current) g.drawImage(base.current, 0, 0);
    for (const s of history.current?.recent ?? []) drawStroke(g, s);
    if (current.current) drawStroke(g, current.current);
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!base.current) {
      base.current = document.createElement("canvas");
      base.current.width = PAD_SIZE;
      base.current.height = PAD_SIZE;
    }
    const b = base.current;
    history.current ??= new StrokeHistory((s) => {
      const g = b.getContext("2d");
      if (g) drawStroke(g, s);
    });
    redraw();
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) history.current?.redo();
      else history.current?.undo();
      redraw();
    };
    window.addEventListener("keydown", onKey);
    // Test builds: a journey draws strokes with given pressures, and reads the picture back.
    provideTestHook("drawStroke", (s: Stroke) => {
      history.current?.push(s);
      redraw();
    });
    provideTestHook("drawingPixels", () => {
      const g = canvas.current?.getContext("2d");
      return g ? Array.from(g.getImageData(0, 0, PAD_SIZE, PAD_SIZE).data) : null;
    });
    return () => window.removeEventListener("keydown", onKey);
  }, [open, redraw]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * PAD_SIZE,
      y: ((e.clientY - r.top) / r.height) * PAD_SIZE,
      // A mouse has no pressure (0.5 while pressed); a pen or finger reports it.
      p: e.pressure > 0 ? e.pressure : 0.5,
    };
  };
  const undo = () => {
    history.current?.undo();
    redraw();
  };
  const redo = () => {
    history.current?.redo();
    redraw();
  };
  const clear = () => {
    history.current?.clear();
    base.current?.getContext("2d")?.clearRect(0, 0, PAD_SIZE, PAD_SIZE);
    redraw();
  };
  const use = async (as: DrawingUse) => {
    const c = canvas.current;
    if (!c) return;
    setBusy(true);
    try {
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
      if (!blob) throw new Error("The drawing couldn't be saved.");
      const asset = await uploadAsset(
        new File([blob], "drawing.png", { type: "image/png" }),
        as === "portrait" ? "portrait" : "token",
        {
          name: "Drawing",
        },
      );
      if (asset.status === "approved") {
        onUse(asset.id, as);
        toast.success(
          as === "portrait" ? "Your new portrait" : as === "standee" ? "Your new standee" : "Your new coin",
        );
      } else toast.info("Sent to the DM", "It becomes yours to use once they approve it.");
      onClose();
    } catch (e) {
      toast.danger("Couldn't save the drawing", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const canUndo = (history.current?.recent.length ?? 0) > 0;
  const canRedo = (history.current?.undone.length ?? 0) > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Drawing pad"
      width={760}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" loading={busy} onClick={() => void use("coin")}>
            Use as coin
          </Button>
          <Button variant="secondary" loading={busy} onClick={() => void use("standee")}>
            Use as standee
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void use("portrait")}>
            Use as portrait
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3" data-testid="drawing-pad">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Tool"
            size="S"
            value={tool}
            onChange={setTool}
            options={[
              { value: "pencil", label: "Pencil" },
              { value: "ink", label: "Ink", hint: "Its width follows your pen's pressure" },
              { value: "marker", label: "Marker" },
              { value: "eraser", label: "Eraser" },
            ]}
          />
          <span className="ml-auto" />
          <IconButton label="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={undo}>
            <Undo2 size={16} />
          </IconButton>
          <IconButton label="Redo" shortcut="Ctrl+Shift+Z" disabled={!canRedo} onClick={redo}>
            <Redo2 size={16} />
          </IconButton>
          <IconButton label="Clear the drawing" tone="danger" onClick={clear}>
            <Trash2 size={16} />
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Colour">
          {DRAWING_SWATCHES.map((s) => (
            <button
              key={s.hex}
              type="button"
              role="radio"
              aria-checked={color === s.hex}
              aria-label={s.name}
              title={s.name}
              onClick={() => setColor(s.hex)}
              className={`grid h-7 min-h-[var(--touch-min)] w-7 min-w-[var(--touch-min)] place-items-center rounded-full border-2 ${color === s.hex ? "border-bone" : "border-transparent"}`}
            >
              <span
                aria-hidden
                className="block h-5 w-5 rounded-full"
                style={{
                  background: s.hex,
                  boxShadow: "0 0 0 1px color-mix(in srgb, var(--fog-300) 55%, transparent)",
                }}
              />
            </button>
          ))}
          <label className="ml-1 inline-flex items-center gap-1 text-12 text-muted">
            <input
              type="color"
              aria-label="Any colour"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-7 w-9 cursor-pointer bg-transparent"
            />
            other
          </label>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-3">
          <Slider
            label="Size"
            value={size}
            min={1}
            max={48}
            step={1}
            format={(v) => `${Math.round(v)} px`}
            onChange={setSize}
          />
          <label className="inline-flex cursor-pointer items-center gap-1 text-13 text-muted">
            <ImagePlus size={15} aria-hidden />
            {reference ? "Another photo to trace" : "A photo to trace"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (reference) URL.revokeObjectURL(reference);
                setReference(f ? URL.createObjectURL(f) : null);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <div
          className="relative mx-auto aspect-square w-full max-w-[560px] overflow-hidden rounded-[var(--radius-control)] border border-line"
          style={{
            backgroundImage:
              "linear-gradient(45deg, var(--ink-800) 25%, transparent 25%), linear-gradient(-45deg, var(--ink-800) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--ink-800) 75%), linear-gradient(-45deg, transparent 75%, var(--ink-800) 75%)",
            backgroundSize: "20px 20px",
            backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0",
          }}
        >
          {reference ? (
            // A faint photo to trace — under the drawing, never in it.
            <img
              src={reference}
              alt=""
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-30"
            />
          ) : null}
          <canvas
            ref={canvas}
            width={PAD_SIZE}
            height={PAD_SIZE}
            data-testid="drawing-canvas"
            aria-label="Drawing"
            className="absolute inset-0 h-full w-full touch-none"
            style={{ cursor: "crosshair" }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              current.current = { tool, color, size, points: [point(e)] };
              redraw();
            }}
            onPointerMove={(e) => {
              if (!current.current) return;
              const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
              const r = e.currentTarget.getBoundingClientRect();
              for (const ev of events)
                current.current.points.push({
                  x: ((ev.clientX - r.left) / r.width) * PAD_SIZE,
                  y: ((ev.clientY - r.top) / r.height) * PAD_SIZE,
                  p: ev.pressure > 0 ? ev.pressure : 0.5,
                });
              redraw();
            }}
            onPointerUp={() => {
              if (current.current) history.current?.push(current.current);
              current.current = null;
              redraw();
            }}
            onPointerCancel={() => {
              current.current = null;
              redraw();
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
