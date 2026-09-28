import type { P } from "@gloam/shared/geometry";
import { formatDistance } from "@gloam/shared/units";
import { Html } from "@react-three/drei";
import { useMemo } from "react";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { C } from "../colors.ts";
import { useUnits } from "../useUnits.ts";
import { Dots, MARK_LIFT, Segments } from "./marks.tsx";
import { useWallTool } from "./walls.ts";

const LIFT = MARK_LIFT;

const NONE: never[] = [];

/**
 * What the Walls tool draws over the board (SPEC §8.7 Editor tools): the chain or room being drawn with the length of
 * the segment under way, the snap ring, the selection's glow and its end handles, and walls just drawn until they
 * arrive. One draw call per kind of mark, whatever the number of walls.
 *
 * Every mark stays mounted for DMs — empty when there's nothing to show — so its material, and the shader program
 * behind it, lives as long as the board: marks that came and went disposed their materials, three.js freed the
 * programs, and the next selection recompiled them mid-edit (a stall of tens of milliseconds on a GPU, a second in
 * software).
 */
export function WallToolLayer() {
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  if (!dm) return null;
  return <Marks />;
}

function Marks() {
  const on = useUi((s) => s.tool === "walls");
  const ghosts = useWallTool((s) => s.ghosts);
  const mode = useWallTool((s) => s.mode);
  const chain = useWallTool((s) => s.chain);
  const pointer = useWallTool((s) => s.pointer);
  const snap = useWallTool((s) => s.snap);
  const rect = useWallTool((s) => s.rect);
  const selected = useWallTool((s) => s.selected);
  const hover = useWallTool((s) => s.hover);
  const handle = useWallTool((s) => s.handle);
  const preview = useWallTool((s) => s.preview);
  const units = useUnits();
  const walls = useBoard((d) => d.walls);

  const { glow, hovered, ends } = useMemo(() => {
    if (!on) return { glow: NONE, hovered: NONE, ends: NONE };
    const at = (id: string) => {
      const moved = preview?.get(id);
      if (moved) return moved;
      const w = walls.get(id);
      return w ? { a: { x: w.ax, y: w.ay }, b: { x: w.bx, y: w.by } } : undefined;
    };
    const glow: { a: P; b: P }[] = [];
    // Every end of the selection (a joint's ends coincide and draw as one handle).
    const ends: P[] = [];
    for (const id of selected) {
      const w = at(id);
      if (!w) continue;
      glow.push(w);
      ends.push(w.a, w.b);
    }
    const hw = hover && !selected.includes(hover) ? at(hover) : undefined;
    if (hw) ends.push(hw.a, hw.b);
    return { glow, hovered: hw ? [hw] : NONE, ends };
  }, [on, selected, hover, preview, walls]);

  const drawing = on && mode !== "select";
  const last = chain[chain.length - 1];
  const liveSegs = useMemo(
    () => (drawing && last && pointer ? [{ a: last, b: pointer }] : NONE),
    [drawing, last, pointer],
  );
  const live = liveSegs[0] ?? null;
  const placed = useMemo(() => {
    const out: { a: P; b: P }[] = [];
    for (let i = 1; i < chain.length; i++) out.push({ a: chain[i - 1] as P, b: chain[i] as P });
    return out;
  }, [chain]);
  const rectSegs = useMemo(() => {
    if (!rect) return NONE;
    const { a, b } = rect;
    const c = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    return c.map((p, i) => ({ a: p, b: c[(i + 1) % 4] as P }));
  }, [rect]);
  const closing = useMemo(
    () => (on && mode === "room" && chain.length >= 2 && pointer ? [{ a: pointer, b: chain[0] as P }] : NONE),
    [on, mode, chain, pointer],
  );
  const snapAt = pointer && on && (drawing || preview) ? pointer : null;
  const ring = useMemo(() => (snapAt && snap === "end" ? [snapAt] : NONE), [snapAt, snap]);
  const diamond = useMemo(() => (snapAt && snap === "wall" ? [snapAt] : NONE), [snapAt, snap]);
  const handleAt = useMemo(() => (on && mode === "select" && handle ? [handle] : NONE), [on, mode, handle]);

  return (
    <group name="wall-tool">
      <Segments segs={ghosts} color={C.brass300} width={3} opacity={0.6} order={5} />
      <Segments segs={glow} color={C.brass300} width={14} opacity={0.55} order={2} />
      <Segments segs={hovered} color={C.bone100} width={8} opacity={0.18} order={3} />
      <Segments segs={drawing ? placed : NONE} color={C.brass400} width={3.5} opacity={1} order={6} />
      <Segments segs={liveSegs} color={C.brass300} width={2.5} opacity={0.95} order={6} dashed />
      <Segments segs={closing} color={C.brass300} width={1.5} opacity={0.35} order={6} />
      <Segments segs={on ? rectSegs : NONE} color={C.brass300} width={3} opacity={0.9} order={6} />
      <Dots points={on && mode === "select" ? ends : NONE} kind="dot" px={11} color={C.bone100} />
      <Dots points={handleAt} kind="dot" px={16} color={C.brass300} />
      <Dots points={drawing ? chain : NONE} kind="dot" px={8} color={C.brass300} />
      <Dots points={ring} kind="ring" px={26} color={C.brass300} />
      <Dots points={diamond} kind="diamond" px={18} color={C.brass300} />
      {live && Math.hypot(live.b.x - live.a.x, live.b.y - live.a.y) >= 0.5 ? (
        <Html
          position={[(live.a.x + live.b.x) / 2, LIFT, (live.a.y + live.b.y) / 2]}
          center
          zIndexRange={[20, 0]}
          style={{ transform: "translateY(-16px)" }}
        >
          <span
            data-testid="wall-length"
            className="pointer-events-none whitespace-nowrap rounded-chip border border-line bg-ink-950 px-1.5 text-12 font-bold text-bone tabular"
          >
            {formatDistance(Math.hypot(live.b.x - live.a.x, live.b.y - live.a.y), units)}
          </span>
        </Html>
      ) : null}
      {on && rect ? (
        <Html
          position={[rect.b.x, LIFT, rect.b.y]}
          center
          zIndexRange={[20, 0]}
          style={{ transform: "translate(0, 18px)" }}
        >
          <span
            data-testid="room-size"
            className="pointer-events-none whitespace-nowrap rounded-chip border border-line bg-ink-950 px-1.5 text-12 font-bold text-bone tabular"
          >
            {formatDistance(Math.abs(rect.b.x - rect.a.x), units)} ×{" "}
            {formatDistance(Math.abs(rect.b.y - rect.a.y), units)}
          </span>
        </Html>
      ) : null}
    </group>
  );
}
