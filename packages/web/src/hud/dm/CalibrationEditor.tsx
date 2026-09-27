import { Minus, Plus, Scan } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { IconButton } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { TextInput } from "../../ui/Field.tsx";
import { useAssetImage } from "../useAssetImage.ts";

type Method = "presets" | "known" | "width";
type Pt = { x: number; y: number };

export const PX_PRESETS = [50, 70, 100, 140, 200] as const;

/**
 * Map calibration (SPEC §8.3): presets "pixels per 5 ft", Known distance (drag across a feature and type its real
 * length), or Map width in feet — with a ruler that reads in feet and ticks every 5 ft, so the DM sees the result
 * before saving (AC-SCN-01). All geometry is in source-image pixels.
 */
export function CalibrationEditor({
  assetId,
  imageW,
  imageH,
  ftPerPx,
  onChange,
}: {
  assetId: string;
  imageW: number;
  imageH: number;
  ftPerPx: number;
  onChange: (ftPerPx: number) => void;
}) {
  const src = useAssetImage(assetId, 2048);
  const [method, setMethod] = useState<Method>("presets");
  const [known, setKnown] = useState<{ a: Pt; b: Pt } | null>(null);
  const [knownFt, setKnownFt] = useState("5");
  const [widthFt, setWidthFt] = useState(() => String(Math.round(imageW * ftPerPx)));
  // A ruler long enough to see and grab: about a quarter of the map, in whole 5-ft steps.
  const [ruler, setRuler] = useState<{ a: Pt; b: Pt }>(() => {
    const ft = Math.max(5, Math.round((imageW * ftPerPx * 0.25) / 5) * 5);
    const len = Math.min(imageW * 0.8, ft / ftPerPx);
    return { a: { x: (imageW - len) / 2, y: imageH * 0.5 }, b: { x: (imageW + len) / 2, y: imageH * 0.5 } };
  });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const drag = useRef<
    | { kind: "pan"; x: number; y: number; pan: Pt }
    | { kind: "known" }
    | { kind: "ruler"; end: "a" | "b" | "both"; last: Pt }
    | null
  >(null);

  // Fit the whole image in the viewport at zoom 1.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setFit(Math.min(r.width / imageW, r.height / imageH));
      setVp({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [imageW, imageH]);

  const scale = fit * zoom;
  // Centred in the viewport (and zooming about the centre); panning moves it from there.
  const offset = { x: (vp.w - imageW * scale) / 2 + pan.x, y: (vp.h - imageH * scale) / 2 + pan.y };
  const toImage = (clientX: number, clientY: number): Pt => {
    const r = layer.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: ((clientX - r.left) / r.width) * imageW, y: ((clientY - r.top) / r.height) * imageH };
  };
  const dist = (p: { a: Pt; b: Pt }) => Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);

  const applyKnown = (line: { a: Pt; b: Pt } | null, ft: string) => {
    const f = Number(ft);
    if (line && dist(line) > 2 && f > 0) onChange(f / dist(line));
  };

  const onDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const handle = (e.target as Element).getAttribute?.("data-handle") as "a" | "b" | "both" | null;
    if (handle) {
      drag.current = { kind: "ruler", end: handle, last: toImage(e.clientX, e.clientY) };
      return;
    }
    if (method === "known" && e.button === 0) {
      const p = toImage(e.clientX, e.clientY);
      setKnown({ a: p, b: p });
      drag.current = { kind: "known" };
      return;
    }
    drag.current = { kind: "pan", x: e.clientX, y: e.clientY, pan };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") setPan({ x: d.pan.x + e.clientX - d.x, y: d.pan.y + e.clientY - d.y });
    else if (d.kind === "known") setKnown((k) => (k ? { a: k.a, b: toImage(e.clientX, e.clientY) } : k));
    else {
      const p = toImage(e.clientX, e.clientY);
      const dx = p.x - d.last.x;
      const dy = p.y - d.last.y;
      d.last = p;
      setRuler((r) => ({
        a: d.end !== "b" ? { x: r.a.x + dx, y: r.a.y + dy } : r.a,
        b: d.end !== "a" ? { x: r.b.x + dx, y: r.b.y + dy } : r.b,
      }));
    }
  };
  const onUp = () => {
    if (drag.current?.kind === "known") applyKnown(known, knownFt);
    drag.current = null;
  };

  const stepPx = 5 / ftPerPx;
  const rulerFt = dist(ruler) * ftPerPx;
  const ticks = (() => {
    const len = dist(ruler);
    if (len < 1e-6 || stepPx * scale < 4) return [];
    const ux = (ruler.b.x - ruler.a.x) / len;
    const uy = (ruler.b.y - ruler.a.y) / len;
    const out: { i: number; x: number; y: number; nx: number; ny: number; len: number }[] = [];
    for (let i = 0; i * stepPx <= len + 1e-6 && i <= 400; i++)
      out.push({
        i,
        x: ruler.a.x + ux * i * stepPx,
        y: ruler.a.y + uy * i * stepPx,
        nx: -uy,
        ny: ux,
        len: (i % 5 === 0 ? 10 : 6) / scale,
      });
    return out;
  })();
  const nudge = (end: "a" | "b", dx: number, dy: number) =>
    setRuler((r) => ({ ...r, [end]: { x: r[end].x + dx, y: r[end].y + dy } }));

  return (
    <div className="flex flex-col gap-3">
      <Segmented<Method>
        label="Calibration method"
        value={method}
        onChange={setMethod}
        options={[
          { value: "presets", label: "Presets" },
          { value: "known", label: "Known distance" },
          { value: "width", label: "Map width" },
        ]}
      />
      {method === "presets" ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="text-13 text-muted">Pixels per 5 ft:</span>
          <div className="grid grid-cols-5 gap-2 sm:flex">
            {PX_PRESETS.map((px) => {
              const active = Math.abs(5 / ftPerPx - px) < 0.01;
              return (
                <button
                  key={px}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange(5 / px)}
                  className={`tabular h-8 rounded-[var(--radius-control)] border px-3 text-14 font-bold ${
                    active
                      ? "border-brass bg-[var(--glow-brass-soft)] text-brass-bright"
                      : "border-line text-muted hover:text-bone"
                  }`}
                >
                  {px}
                </button>
              );
            })}
          </div>
        </div>
      ) : method === "known" ? (
        <div className="flex flex-wrap items-end gap-3">
          <p className="max-w-[36ch] text-13 text-muted">
            Drag across something whose real size you know — one printed grid square is usually 5 ft, a door 5
            ft.
          </p>
          <TextInput
            label="Its length (ft)"
            inputMode="decimal"
            value={knownFt}
            className="w-32"
            onChange={(e) => {
              setKnownFt(e.target.value);
              applyKnown(known, e.target.value);
            }}
          />
        </div>
      ) : (
        <TextInput
          label="The whole map is this wide (ft)"
          inputMode="decimal"
          value={widthFt}
          className="w-56"
          onChange={(e) => {
            setWidthFt(e.target.value);
            const f = Number(e.target.value);
            if (f > 0) onChange(f / imageW);
          }}
        />
      )}

      <div
        ref={viewport}
        className="relative h-[360px] touch-none select-none overflow-hidden rounded-[var(--radius-control)] border border-line bg-ink-950"
        onWheel={(e) => setZoom((z) => Math.min(8, Math.max(0.5, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        style={{ cursor: method === "known" ? "crosshair" : "grab" }}
      >
        <div
          ref={layer}
          data-testid="calibration-image"
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: imageW,
            height: imageH,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        >
          {src ? (
            <img src={src} alt="The map being calibrated" className="h-full w-full" draggable={false} />
          ) : null}
          <svg
            className="absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${imageW} ${imageH}`}
            aria-hidden
          >
            {known && method === "known" ? (
              <line
                x1={known.a.x}
                y1={known.a.y}
                x2={known.b.x}
                y2={known.b.y}
                stroke="var(--ember-400)"
                strokeWidth={3 / scale}
              />
            ) : null}
          </svg>
          {/* The ruler: always available to check the scale. */}
          <svg
            className="absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${imageW} ${imageH}`}
            role="group"
            aria-label="Ruler"
          >
            <line
              data-handle="both"
              x1={ruler.a.x}
              y1={ruler.a.y}
              x2={ruler.b.x}
              y2={ruler.b.y}
              stroke="var(--bone-100)"
              strokeWidth={4 / scale}
              style={{ cursor: "move" }}
            />
            {/* A tick every 5 ft (taller every 25 ft): lay the ruler along a printed grid to check the scale — Gloam
                itself draws no grid (SPEC §8.6). */}
            {ticks.map((t) => (
              <line
                key={t.i}
                x1={t.x - t.nx * t.len}
                y1={t.y - t.ny * t.len}
                x2={t.x + t.nx * t.len}
                y2={t.y + t.ny * t.len}
                stroke="var(--bone-100)"
                strokeWidth={2 / scale}
                pointerEvents="none"
              />
            ))}
            {(["a", "b"] as const).map((end) => (
              <circle
                key={end}
                data-handle={end}
                role="slider"
                tabIndex={0}
                aria-label={end === "a" ? "Ruler start" : "Ruler end"}
                aria-valuetext={`${rulerFt.toFixed(1)} ft`}
                aria-valuenow={Number(rulerFt.toFixed(1))}
                aria-valuemin={0}
                cx={ruler[end].x}
                cy={ruler[end].y}
                r={9 / scale}
                fill="var(--ink-950)"
                stroke="var(--brass-300)"
                strokeWidth={3 / scale}
                style={{ cursor: "grab" }}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 10 : 1;
                  if (e.key === "ArrowLeft") nudge(end, -step, 0);
                  else if (e.key === "ArrowRight") nudge(end, step, 0);
                  else if (e.key === "ArrowUp") nudge(end, 0, -step);
                  else if (e.key === "ArrowDown") nudge(end, 0, step);
                  else return;
                  e.preventDefault();
                }}
              />
            ))}
          </svg>
        </div>
        <div className="pointer-events-none absolute left-3 top-3 rounded-chip bg-[var(--scrim)] px-2 py-1">
          <span className="caps text-12 text-fog">Ruler </span>
          <span data-testid="ruler-length" className="tabular text-14 font-bold text-bone">
            {rulerFt.toFixed(1)} ft
          </span>
        </div>
        <div className="absolute bottom-3 right-3 flex gap-1 rounded-[var(--radius-control)] bg-[var(--scrim)] p-1">
          <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}>
            <Minus size={16} />
          </IconButton>
          <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>
            <Plus size={16} />
          </IconButton>
          <IconButton
            label="Fit"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            <Scan size={16} />
          </IconButton>
        </div>
      </div>
      <p className="tabular text-13 text-muted" data-testid="calibration-summary">
        One 5-ft square = {(5 / ftPerPx).toFixed(1)} px · the map is {(imageW * ftPerPx).toFixed(0)} ×{" "}
        {(imageH * ftPerPx).toFixed(0)} ft
      </p>
    </div>
  );
}
