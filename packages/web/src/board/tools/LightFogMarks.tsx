import type { P } from "@gloam/shared/geometry";
import { facingAngle } from "@gloam/shared/vision";
import { useMemo } from "react";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { useDmView } from "../../state/viewAs.ts";
import { C } from "../colors.ts";
import { useFogTool } from "./fog.ts";
import { useLightTool } from "./lights.ts";
import { Dots, Segments } from "./marks.tsx";

const NONE: never[] = [];

/** A circle as segments (for radii and the brush). */
function circle(c: P, r: number, n = 64): { a: P; b: P }[] {
  const out: { a: P; b: P }[] = [];
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    out.push({
      a: { x: c.x + Math.cos(a0) * r, y: c.y + Math.sin(a0) * r },
      b: { x: c.x + Math.cos(a1) * r, y: c.y + Math.sin(a1) * r },
    });
  }
  return out;
}

/**
 * The Lights tool on the board (SPEC §8.8): every light as a ring in its colour (carried ones too, where their bearer
 * is); the selected one filled, with its bright radius drawn solid and its dim reach dashed, and a cone's edges.
 */
export function LightToolLayer() {
  const on = useUi((s) => s.tool === "lights");
  const dm = useDmView();
  const lights = useBoard((d) => d.lights);
  const tokens = useBoard((d) => d.tokens);
  const selected = useLightTool((s) => s.selected);
  const preview = useLightTool((s) => s.preview);
  const marks = useMemo(() => {
    if (!on || !dm) return null;
    const byColor = new Map<string, P[]>();
    let sel: { at: P; bright: number; dim: number; cone: number; dir: number } | null = null;
    for (const l of lights.values()) {
      const carrier = l.link?.tokenId ? tokens.get(l.link.tokenId) : undefined;
      const at = preview?.id === l.id ? preview.at : carrier ? carrier.pos : { x: l.x, y: l.y };
      const list = byColor.get(l.color) ?? [];
      list.push(at);
      byColor.set(l.color, list);
      if (l.id === selected) sel = { at, bright: l.bright, dim: l.dim, cone: l.coneDeg, dir: l.dirDeg };
    }
    return { byColor, sel };
  }, [on, dm, lights, tokens, selected, preview]);
  if (!marks) return null;
  const s = marks.sel as { at: P; bright: number; dim: number; cone: number; dir: number } | null;
  const cone = s && s.cone > 0 && s.cone < 360;
  const edges = [];
  if (s && cone) {
    const f = facingAngle(s.dir);
    const half = (s.cone * Math.PI) / 360;
    const r = s.bright + s.dim;
    for (const a of [f - half, f + half])
      edges.push({ a: s.at, b: { x: s.at.x + Math.cos(a) * r, y: s.at.y + Math.sin(a) * r } });
  }
  return (
    <group name="light-tool">
      {[...marks.byColor].map(([color, points]) => (
        <Dots key={color} points={points} kind="ring" px={20} color={color || C.candle} />
      ))}
      <Dots points={s ? [s.at] : NONE} kind="dot" px={12} color={C.brass300} />
      <Segments
        segs={s && s.bright > 0 ? circle(s.at, s.bright) : NONE}
        color={C.brass300}
        width={2}
        opacity={0.85}
        order={6}
      />
      <Segments
        segs={s && s.dim > 0 ? circle(s.at, s.bright + s.dim) : NONE}
        color={C.brass300}
        width={1.5}
        opacity={0.6}
        order={6}
        dashed
      />
      <Segments segs={edges} color={C.brass300} width={1.5} opacity={0.6} order={6} />
    </group>
  );
}

/**
 * The Fog tool on the board: the brush's reach at the pointer (brass to reveal, bone to hide), the rectangle being
 * dragged, the polygon's corners and its rubber band.
 */
export function FogToolLayer() {
  const on = useUi((s) => s.tool === "fog");
  const dm = useDmView();
  const shape = useFogTool((s) => s.shape);
  const reveal = useFogTool((s) => s.reveal);
  const radius = useFogTool((s) => s.radius);
  const pointer = useFogTool((s) => s.pointer);
  const points = useFogTool((s) => s.points);
  const rect = useFogTool((s) => s.rect);
  if (!on || !dm) return null;
  const color = reveal ? C.brass300 : C.bone100;
  const brush = shape === "brush" && pointer ? circle(pointer, radius) : NONE;
  const box = rect
    ? (() => {
        const c = [rect.a, { x: rect.b.x, y: rect.a.y }, rect.b, { x: rect.a.x, y: rect.b.y }];
        return c.map((p, i) => ({ a: p, b: c[(i + 1) % 4] as P }));
      })()
    : NONE;
  const poly = shape === "polygon" ? points.slice(1).map((p, i) => ({ a: points[i] as P, b: p })) : NONE;
  const live =
    shape === "polygon" && points.length && pointer
      ? [{ a: points[points.length - 1] as P, b: pointer }]
      : NONE;
  return (
    <group name="fog-tool">
      <Segments segs={brush} color={color} width={2} opacity={0.9} order={6} />
      <Segments segs={box} color={color} width={2.5} opacity={0.9} order={6} />
      <Segments segs={poly} color={color} width={2.5} opacity={0.95} order={6} />
      <Segments segs={live} color={color} width={2} opacity={0.9} order={6} dashed />
      <Dots points={shape === "polygon" ? points : NONE} kind="dot" px={9} color={color} />
    </group>
  );
}
