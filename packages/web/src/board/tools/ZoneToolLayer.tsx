import type { P } from "@gloam/shared/geometry";
import { type WorldZoneShape, zonePolygon } from "@gloam/shared/movement";
import { useMemo } from "react";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { C } from "../colors.ts";
import { parseZoneShape } from "../map/zoneShape.ts";
import { Dots, Segments } from "./marks.tsx";
import { handlesOf, useZoneTool } from "./zones.ts";

const NONE: never[] = [];

/** A shape's outline as segments (a circle as 64 chords). */
function outline(s: WorldZoneShape | null): { a: P; b: P }[] {
  if (!s) return NONE;
  const pts =
    s.kind === "circle"
      ? Array.from({ length: 64 }, (_, k) => ({
          x: s.x + Math.cos((k / 64) * Math.PI * 2) * s.r,
          y: s.y + Math.sin((k / 64) * Math.PI * 2) * s.r,
        }))
      : zonePolygon(s);
  return pts.map((p, i) => ({ a: p, b: pts[(i + 1) % pts.length] as P }));
}

/**
 * What the Zones tool draws (SPEC §8.7 Zones): the shape being drawn, the selected zone's outline and handles. Every
 * mark stays mounted for DMs (see marks.tsx).
 */
export function ZoneToolLayer() {
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  if (!dm) return null;
  return <Marks />;
}

function Marks() {
  const on = useUi((s) => s.tool === "zones");
  const mode = useZoneTool((s) => s.mode);
  const points = useZoneTool((s) => s.points);
  const pointer = useZoneTool((s) => s.pointer);
  const draft = useZoneTool((s) => s.draft);
  const selected = useZoneTool((s) => s.selected);
  const preview = useZoneTool((s) => s.preview);
  const handle = useZoneTool((s) => s.handle);
  const zones = useBoard((d) => d.zones);

  const selShape = useMemo(() => {
    if (!on || !selected) return null;
    if (preview?.id === selected) return preview.shape;
    const z = zones.get(selected);
    return z ? parseZoneShape(z.shapeJson) : null;
  }, [on, selected, preview, zones]);
  const selOutline = useMemo(() => outline(selShape), [selShape]);
  const selHandles = useMemo(() => (selShape ? handlesOf(selShape) : NONE), [selShape]);
  const draftOutline = useMemo(() => (on ? outline(draft) : NONE), [on, draft]);
  const drawing = on && mode === "polygon";
  const placed = useMemo(() => {
    if (!drawing) return NONE;
    const out: { a: P; b: P }[] = [];
    for (let i = 1; i < points.length; i++) out.push({ a: points[i - 1] as P, b: points[i] as P });
    const last = points[points.length - 1];
    if (last && pointer) out.push({ a: last, b: pointer });
    return out;
  }, [drawing, points, pointer]);
  const closing = useMemo(
    () => (drawing && points.length >= 2 && pointer ? [{ a: pointer, b: points[0] as P }] : NONE),
    [drawing, points, pointer],
  );
  const handleAt = useMemo(() => (on && handle ? [handle] : NONE), [on, handle]);

  return (
    <group name="zone-tool">
      <Segments segs={selOutline} color={C.brass300} width={3} opacity={0.95} order={6} />
      <Segments segs={draftOutline} color={C.brass300} width={2.5} opacity={0.9} order={6} />
      <Segments segs={placed} color={C.brass300} width={2.5} opacity={0.9} order={6} />
      <Segments segs={closing} color={C.brass300} width={1.5} opacity={0.35} order={6} />
      <Dots points={on ? selHandles : NONE} kind="dot" px={12} color={C.bone100} />
      <Dots points={handleAt} kind="dot" px={16} color={C.brass300} />
      <Dots points={drawing ? points : NONE} kind="dot" px={8} color={C.brass300} />
    </group>
  );
}
