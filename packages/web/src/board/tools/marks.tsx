import type { P } from "@gloam/shared/geometry";
import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
  SRGBColorSpace,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { setSegments } from "../lines.ts";

/**
 * Editing marks shared by the board tools (Walls, Zones): screen-width lines on the floor and screen-sized dots,
 * rings and diamonds — one draw call each. Mount them for as long as the tool can be used and feed them empty lists
 * when there's nothing to show: their materials (and shader programs) then live as long as the board.
 */

/** Just above the walls overlay (0.06). */
export const MARK_LIFT = 0.08;
const LIFT = MARK_LIFT;

/** Screen-width lines on the floor for a list of segments (one draw call). */
export function Segments({
  segs,
  color,
  width,
  opacity,
  order,
  dashed = false,
}: {
  segs: { a: P; b: P }[];
  color: string;
  width: number;
  opacity: number;
  order: number;
  /** A rubber band (dashes in feet): what's still being placed, as against what's there. */
  dashed?: boolean;
}) {
  const size = useThree((s) => s.size);
  const [line, material] = useMemo(() => {
    const m = new LineMaterial({
      linewidth: width,
      depthTest: false,
      transparent: true,
      opacity,
      ...(dashed ? { dashed: true, dashSize: 0.45, gapSize: 0.3 } : {}),
    });
    const l = new LineSegments2(new LineSegmentsGeometry(), m);
    l.renderOrder = order;
    l.frustumCulled = false;
    l.raycast = () => {};
    return [l, m] as const;
  }, [width, opacity, order, dashed]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      material.dispose();
    },
    [line, material],
  );
  useLayoutEffect(() => {
    material.color = new Color(color);
    material.resolution.set(size.width, size.height);
  }, [material, color, size]);
  useLayoutEffect(() => {
    const pos = new Float32Array(segs.length * 6);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i] as { a: P; b: P };
      const o = i * 6;
      pos[o] = s.a.x;
      pos[o + 1] = LIFT;
      pos[o + 2] = s.a.y;
      pos[o + 3] = s.b.x;
      pos[o + 4] = LIFT;
      pos[o + 5] = s.b.y;
    }
    setSegments(line, pos);
    if (dashed && segs.length) line.computeLineDistances();
  }, [line, segs, dashed]);
  return <primitive object={line} />;
}

const textures = new Map<string, CanvasTexture>();
/** A white mark (tinted by the material): a handle dot, a snap ring or an on-wall diamond, with a dark edge. */
function markTexture(kind: "dot" | "ring" | "diamond"): CanvasTexture {
  const cached = textures.get(kind);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.lineJoin = "round";
  if (kind === "dot") {
    g.beginPath();
    g.arc(32, 32, 22, 0, Math.PI * 2);
    g.fillStyle = "#fff";
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = "rgba(10,9,8,0.85)";
    g.stroke();
  } else if (kind === "ring") {
    g.beginPath();
    g.arc(32, 32, 24, 0, Math.PI * 2);
    g.lineWidth = 12;
    g.strokeStyle = "rgba(10,9,8,0.75)";
    g.stroke();
    g.lineWidth = 6;
    g.strokeStyle = "#fff";
    g.stroke();
  } else {
    g.beginPath();
    g.moveTo(32, 8);
    g.lineTo(56, 32);
    g.lineTo(32, 56);
    g.lineTo(8, 32);
    g.closePath();
    g.lineWidth = 12;
    g.strokeStyle = "rgba(10,9,8,0.75)";
    g.stroke();
    g.lineWidth = 6;
    g.strokeStyle = "#fff";
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  textures.set(kind, t);
  return t;
}

/** Screen-sized marks at points on the floor (one draw call). */
export function Dots({
  points,
  kind,
  px,
  color,
}: {
  points: P[];
  kind: "dot" | "ring" | "diamond";
  px: number;
  color: string;
}) {
  const dpr = useThree((s) => s.viewport.dpr);
  const [obj, geometry, material] = useMemo(() => {
    const g = new BufferGeometry();
    const m = new PointsMaterial({
      map: markTexture(kind),
      sizeAttenuation: false,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const o = new Points(g, m);
    o.renderOrder = 8;
    o.frustumCulled = false;
    o.raycast = () => {};
    return [o, g, m] as const;
  }, [kind]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  useLayoutEffect(() => {
    material.size = px * dpr;
    material.color = new Color(color);
  }, [material, px, dpr, color]);
  useLayoutEffect(() => {
    const pos = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as P;
      pos.set([p.x, LIFT + 0.01, p.y], i * 3);
    }
    geometry.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geometry.computeBoundingSphere();
  }, [geometry, points]);
  return <primitive object={obj} />;
}
