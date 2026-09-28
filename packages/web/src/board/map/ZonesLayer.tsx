import type { P } from "@gloam/shared/geometry";
import { type WorldZoneShape, zonePolygon } from "@gloam/shared/movement";
import type { ZoneView } from "@gloam/shared/state";
import { Text } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  type Group,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
} from "three";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { C } from "../colors.ts";
import { disposeLater } from "../dispose.ts";
import { CAPS_FONT } from "../fonts.ts";
import { useZoneTool } from "../tools/zones.ts";
import { parseZoneShape } from "./zoneShape.ts";

/**
 * Zones on the floor (SPEC §8.7 Zones): difficult terrain with a subtle hatch, water with a slow ripple, hazards with a
 * warm cross-hatch, impassable ground dark and densely hatched, a named area (Label) as an engraved dashed border with
 * its name set like a plaque inside the top edge — each in its colour. Names lie on the floor at the shape's most
 * interior point, kept between 12 and 20 px on screen whatever the zoom. DMs also see zones hidden from players,
 * dimmer.
 */
export function ZonesLayer() {
  const zones = useBoard((d) => d.zones);
  return (
    <group name="zones">
      {[...zones.values()].map((z) => (
        <ZoneMesh key={z.id} zone={z} />
      ))}
    </group>
  );
}

const PATTERN: Record<string, number> = { difficult: 1, water: 2, hazard: 3, impassable: 4, label: 0 };

function ZoneMesh({ zone }: { zone: ZoneView }) {
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  // Being moved or reshaped with the Zones tool: drawn where the edit puts it.
  const edited = useZoneTool((s) => (s.preview?.id === zone.id ? s.preview.shape : null));
  const stored = useMemo(() => parseZoneShape(zone.shapeJson), [zone.shapeJson]);
  const shape = edited ?? stored;
  // A zone hidden from players: DMs see it dimmer.
  const hidden = zone.dmHidden === true;
  const fill = useMemo(() => (shape ? fillGeometry(shape) : null), [shape]);
  const outline = useMemo(() => (shape ? outlineGeometry(shape) : null), [shape]);
  const mat = useMemo(
    () => zoneMaterial(zone.color || C.brass600, PATTERN[zone.kind] ?? 0),
    [zone.color, zone.kind],
  );
  // A named area's border is dashed (engraved), so it never reads as a selection box.
  const lineMat = useMemo(
    () => zoneMaterial(zone.color || C.brass600, zone.kind === "label" ? 10 : 9),
    [zone.color, zone.kind],
  );
  useEffect(() => () => disposeLater(mat, lineMat, fill, outline), [mat, lineMat, fill, outline]);
  useEffect(() => {
    const k = hidden && dm ? 0.5 : 1;
    (mat.uniforms.uAlpha as { value: number }).value = k;
    (lineMat.uniforms.uAlpha as { value: number }).value = k;
  }, [hidden, dm, mat, lineMat]);
  const place = useMemo(
    () => (shape ? labelPlace(shape, zone.kind, zone.label) : null),
    [shape, zone.kind, zone.label],
  );
  if (!shape || !fill || !outline || !place) return null;
  return (
    <group userData={{ part: "zone", zoneId: zone.id, zoneKind: zone.kind }}>
      <mesh
        geometry={fill}
        material={mat}
        rotation-x={Math.PI / 2}
        position-y={0.02}
        renderOrder={2}
        raycast={() => null}
      />
      <mesh geometry={outline} material={lineMat} position-y={0.025} renderOrder={3} raycast={() => null} />
      {zone.label ? (
        <ClampedLabel at={place.at} size={place.size} dim={hidden && dm}>
          {zone.label}
        </ClampedLabel>
      ) : null}
    </group>
  );
}

/** The zone's area, in the XY plane (the mesh turns it onto the floor). */
function fillGeometry(shape: WorldZoneShape): BufferGeometry {
  if (shape.kind === "circle") {
    const g = new CircleGeometry(shape.r, 64);
    g.translate(shape.x, shape.y, 0);
    return g;
  }
  const pts = zonePolygon(shape);
  return new ShapeGeometry(new Shape(pts.map((p) => ({ x: p.x, y: p.y }) as never)));
}

/** A 0.12-ft band along the zone's edge, on the floor. */
function outlineGeometry(shape: WorldZoneShape): BufferGeometry {
  const pts: P[] =
    shape.kind === "circle"
      ? Array.from({ length: 96 }, (_, k) => ({
          x: shape.x + Math.cos((k / 96) * Math.PI * 2) * shape.r,
          y: shape.y + Math.sin((k / 96) * Math.PI * 2) * shape.r,
        }))
      : zonePolygon(shape);
  const w = 0.14;
  const pos: number[] = [];
  const dist: number[] = [];
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as P;
    const b = pts[(i + 1) % pts.length] as P;
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / l) * (w / 2);
    const ny = ((b.x - a.x) / l) * (w / 2);
    pos.push(a.x + nx, 0, a.y + ny, b.x + nx, 0, b.y + ny, b.x - nx, 0, b.y - ny);
    pos.push(a.x + nx, 0, a.y + ny, b.x - nx, 0, b.y - ny, a.x - nx, 0, a.y - ny);
    // Distance along the border, for dashes that run evenly round it.
    dist.push(run, run + l, run + l, run, run + l, run);
    run += l;
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("aDist", new Float32BufferAttribute(dist, 1));
  return g;
}

/** Distance from p to the polygon's border. */
function edgeDistance(p: P, pts: P[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as P;
    const b = pts[(i + 1) % pts.length] as P;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/** The point inside a polygon farthest from its border (a grid search, refined once): where a name fits best. */
function interiorPoint(pts: P[]): { p: P; r: number } {
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best = { p: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, r: 0 };
  for (let pass = 0; pass < 2; pass++) {
    const n = 20;
    for (let a = 0; a <= n; a++)
      for (let b = 0; b <= n; b++) {
        const p = { x: x0 + ((x1 - x0) * a) / n, y: y0 + ((y1 - y0) * b) / n };
        if (!inside(p, pts)) continue;
        const r = edgeDistance(p, pts);
        if (r > best.r) best = { p, r };
      }
    const hw = (x1 - x0) / 10;
    const hh = (y1 - y0) / 10;
    [x0, x1, y0, y1] = [best.p.x - hw, best.p.x + hw, best.p.y - hh, best.p.y + hh];
  }
  return best;
}
function inside(p: P, pts: P[]): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i] as P;
    const b = pts[j] as P;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/**
 * Where a zone's name goes and how big it is on the floor (feet): at the most interior point, as large as fits across
 * the room there (it's clamped on screen afterwards); a named area's name sits like a plaque just inside its top edge.
 */
function labelPlace(shape: WorldZoneShape, kind: string, label: string): { at: P; size: number } {
  const chars = Math.max(3, label.length);
  const fit = (room: number) => Math.min(2.4, Math.max(0.6, room / (chars * 0.62)));
  if (shape.kind === "circle") {
    const size = fit(shape.r * 1.6);
    return kind === "label"
      ? { at: { x: shape.x, y: shape.y - shape.r + size * 1.1 }, size }
      : { at: { x: shape.x, y: shape.y }, size };
  }
  if (shape.kind === "rect") {
    const size = fit(shape.w * 0.9);
    return kind === "label"
      ? { at: { x: shape.x + shape.w / 2, y: shape.y + size * 0.95 }, size }
      : { at: { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 }, size };
  }
  const { p, r } = interiorPoint(shape.points);
  return { at: p, size: fit(r * 2) };
}

const LABEL_PX = { min: 12, max: 20 };
const at3 = new Vector3();
const side3 = new Vector3();

/**
 * A name lying on the floor, kept legible: its size on screen stays within 12–20 px however far the camera is (the
 * text is laid out once; only its scale follows the zoom).
 */
function ClampedLabel({ at, size, dim, children }: { at: P; size: number; dim: boolean; children: string }) {
  const group = useRef<Group>(null);
  const camera = useThree((s) => s.camera);
  const viewport = useThree((s) => s.size);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    // Pixels per foot here: a foot along the screen's horizontal, projected.
    at3.set(at.x, 0, at.y).project(camera);
    side3
      .set(1, 0, 0)
      .applyQuaternion(camera.quaternion)
      .add(at3.set(at.x, 0, at.y))
      .project(camera);
    at3.set(at.x, 0, at.y).project(camera);
    const ppf = (Math.hypot(side3.x - at3.x, side3.y - at3.y) * viewport.width) / 2;
    const px = size * ppf;
    const k = px > 0 ? Math.min(LABEL_PX.max, Math.max(LABEL_PX.min, px)) / px : 1;
    if (Math.abs(g.scale.x - k) > 1e-3) g.scale.setScalar(k);
  });
  return (
    <group ref={group} position={[at.x, 0.04, at.y]}>
      <Text
        font={CAPS_FONT}
        fontSize={size}
        letterSpacing={0.08}
        color={C.bone100}
        fillOpacity={dim ? 0.5 : 1}
        outlineWidth={size * 0.1}
        outlineColor={C.ink950}
        outlineOpacity={0.9}
        anchorX="center"
        anchorY="middle"
        rotation-x={-Math.PI / 2}
        raycast={() => null}
      >
        {children}
      </Text>
    </group>
  );
}

const VERT = /* glsl */ `
attribute float aDist;
varying vec3 vWorld;
varying float vDist;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vDist = aDist;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uPattern; uniform float uAlpha;
varying vec3 vWorld;
varying float vDist;
float lines(float v, float period, float width) {
  float f = fract(v / period);
  return smoothstep(0.0, 0.04, f) * (1.0 - smoothstep(width, width + 0.04, f));
}
void main() {
  vec2 p = vWorld.xz;
  float a = 0.0;
  if (uPattern > 9.5) { if (fract(vDist / 1.1) > 0.58) discard; a = 0.95; }     // dashed border (a named area)
  else if (uPattern > 8.5) a = 0.9;                                              // outline band
  else if (uPattern > 3.5) a = 0.38 + 0.4 * max(lines(p.x + p.y, 0.9, 0.18), lines(p.x - p.y, 0.9, 0.18)); // impassable
  else if (uPattern > 2.5) a = 0.12 + 0.3 * max(lines(p.x + p.y, 1.6, 0.1), lines(p.x - p.y, 1.6, 0.1));    // hazard
  else if (uPattern > 1.5) a = 0.2 + 0.1 * sin(p.x * 1.3 + sin(p.y * 0.9) * 1.6) + 0.12 * lines(p.y + 0.35 * sin(p.x * 0.8), 1.8, 0.06); // water
  else if (uPattern > 0.5) a = 0.08 + 0.34 * lines(p.x + p.y, 1.4, 0.1);                                      // difficult
  else a = 0.07;                                                                                                // label
  gl_FragColor = vec4(uColor, a * uAlpha);
}`;

function zoneMaterial(color: string, pattern: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uColor: { value: new Color(color) },
      uPattern: { value: pattern },
      uAlpha: { value: 1 },
    },
  });
}
