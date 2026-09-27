import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { WALL_COLORS } from "../colors.ts";

/** Just above the map so the lines never z-fight with it. */
const LIFT_FT = 0.06;

/**
 * The DM's walls overlay (SPEC §8.7): every wall of the scene as a crisp line in its kind's colour, hidden walls
 * dimmed — one batched draw call however many walls there are. The editor tools and door handles arrive in P3.
 */
export function WallsLayer() {
  const walls = useBoard((d) => d.walls);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const [line, geometry, material] = useMemo(() => {
    const g = new LineSegmentsGeometry();
    const m = new LineMaterial({ linewidth: 3, vertexColors: true, depthTest: false, transparent: true });
    const l = new LineSegments2(g, m);
    l.renderOrder = 4;
    l.frustumCulled = false;
    l.name = "walls-overlay";
    return [l, g, m] as const;
  }, []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  useEffect(() => {
    material.resolution.set(size.width, size.height);
  }, [material, size]);

  const count = walls.size;
  useEffect(() => {
    if (!count) return;
    const pos = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const c = new Color();
    let i = 0;
    for (const w of walls.values()) {
      pos.set([w.ax, LIFT_FT, w.ay, w.bx, LIFT_FT, w.by], i * 6);
      c.set(WALL_COLORS[(w.dmKind ?? w.kind) as keyof typeof WALL_COLORS] ?? WALL_COLORS.wall);
      if (w.dmHidden) c.multiplyScalar(0.45);
      colors.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
      i++;
    }
    geometry.setPositions(pos);
    geometry.setColors(colors);
    line.computeLineDistances();
    invalidate();
  }, [walls, count, geometry, line, invalidate]);

  if (!dm || !count) return null;
  return <primitive object={line} />;
}
