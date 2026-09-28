import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { Color } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { C, WALL_COLORS } from "../colors.ts";
import { setSegments } from "../lines.ts";
import { useWallTool } from "../tools/walls.ts";

/** Just above the map so the lines never z-fight with it. */
const LIFT_FT = 0.06;

/**
 * The DM's walls overlay (SPEC §8.7): every wall of the scene as a crisp line in its kind's colour, hidden walls
 * dimmed — one batched draw call however many walls there are. Walls the Walls tool is moving are drawn where the
 * edit puts them (its preview) until the server's echo arrives.
 */
export function WallsLayer() {
  const walls = useBoard((d) => d.walls);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const [line, material] = useMemo(() => {
    const m = new LineMaterial({ linewidth: 3, vertexColors: true, depthTest: false, transparent: true });
    const l = new LineSegments2(new LineSegmentsGeometry(), m);
    l.renderOrder = 4;
    l.frustumCulled = false;
    l.name = "walls-overlay";
    return [l, m] as const;
  }, []);
  useEffect(
    () => () => {
      line.geometry.dispose();
      material.dispose();
    },
    [line, material],
  );
  useEffect(() => {
    material.resolution.set(size.width, size.height);
  }, [material, size]);

  const preview = useWallTool((s) => s.preview);
  const selected = useWallTool((s) => s.selected);
  const count = walls.size;
  // A layout effect: the lines match the store in the same commit (no frame drawn with stale walls while editing).
  useLayoutEffect(() => {
    if (!count) return;
    const pos = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const c = new Color();
    const chosen = new Set(selected);
    let i = 0;
    for (const w of walls.values()) {
      const moved = preview?.get(w.id);
      const o = i * 6;
      pos[o] = moved ? moved.a.x : w.ax;
      pos[o + 1] = LIFT_FT;
      pos[o + 2] = moved ? moved.a.y : w.ay;
      pos[o + 3] = moved ? moved.b.x : w.bx;
      pos[o + 4] = LIFT_FT;
      pos[o + 5] = moved ? moved.b.y : w.by;
      // Selected walls (the Walls tool) in brass, whatever their kind; hidden ones dimmed.
      if (chosen.has(w.id)) c.set(C.brass400);
      else {
        c.set(WALL_COLORS[(w.dmKind ?? w.kind) as keyof typeof WALL_COLORS] ?? WALL_COLORS.wall);
        if (w.dmHidden) c.multiplyScalar(0.45);
      }
      colors[o] = colors[o + 3] = c.r;
      colors[o + 1] = colors[o + 4] = c.g;
      colors[o + 2] = colors[o + 5] = c.b;
      i++;
    }
    setSegments(line, pos, colors);
    invalidate();
  }, [walls, count, preview, selected, line, invalidate]);

  if (!dm || !count) return null;
  return <primitive object={line} />;
}
