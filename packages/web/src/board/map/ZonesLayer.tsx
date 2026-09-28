import type { P } from "@gloam/shared/geometry";
import { type WorldZoneShape, zonePolygon } from "@gloam/shared/movement";
import type { ZoneView } from "@gloam/shared/state";
import { Text } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import {
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
} from "three";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { C } from "../colors.ts";
import { disposeLater } from "../dispose.ts";
import { CAPS_FONT } from "../fonts.ts";
import { useZoneTool } from "../tools/zones.ts";
import { parseZoneShape } from "./zoneShape.ts";

/**
 * Zones on the floor (SPEC §8.7 Zones): difficult terrain with a subtle hatch, water as a cool tint, hazards with a
 * warm cross-hatch, impassable ground dark and densely hatched, labels as a named area — each in its colour, with its
 * label lying on the floor. DMs also see zones hidden from players, dimmer.
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
  const lineMat = useMemo(() => zoneMaterial(zone.color || C.brass600, 9), [zone.color]);
  useEffect(() => () => disposeLater(mat, lineMat, fill, outline), [mat, lineMat, fill, outline]);
  useEffect(() => {
    const k = hidden && dm ? 0.5 : 1;
    (mat.uniforms.uAlpha as { value: number }).value = k;
    (lineMat.uniforms.uAlpha as { value: number }).value = k;
  }, [hidden, dm, mat, lineMat]);
  if (!shape || !fill || !outline) return null;
  const c = centroid(shape);
  const size = labelSize(shape);
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
        <Text
          font={CAPS_FONT}
          fontSize={size}
          letterSpacing={0.08}
          color={C.bone100}
          fillOpacity={hidden && dm ? 0.45 : 0.85}
          outlineWidth={size * 0.06}
          outlineColor={C.ink950}
          outlineOpacity={0.7}
          anchorX="center"
          anchorY="middle"
          rotation-x={-Math.PI / 2}
          position={[c.x, 0.04, c.y]}
          raycast={() => null}
        >
          {zone.label}
        </Text>
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
  const w = 0.12;
  const pos: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as P;
    const b = pts[(i + 1) % pts.length] as P;
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / l) * (w / 2);
    const ny = ((b.x - a.x) / l) * (w / 2);
    pos.push(a.x + nx, 0, a.y + ny, b.x + nx, 0, b.y + ny, b.x - nx, 0, b.y - ny);
    pos.push(a.x + nx, 0, a.y + ny, b.x - nx, 0, b.y - ny, a.x - nx, 0, a.y - ny);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  return g;
}

function centroid(shape: WorldZoneShape): P {
  if (shape.kind === "circle") return { x: shape.x, y: shape.y };
  if (shape.kind === "rect") return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
  const pts = shape.points;
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function labelSize(shape: WorldZoneShape): number {
  const w = shape.kind === "circle" ? shape.r * 2 : shape.kind === "rect" ? shape.w : spanOf(shape.points);
  return Math.min(2.4, Math.max(0.8, w / 9));
}
const spanOf = (pts: P[]) => Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uPattern; uniform float uAlpha;
varying vec3 vWorld;
float lines(float v, float period, float width) {
  float f = fract(v / period);
  return smoothstep(0.0, 0.04, f) * (1.0 - smoothstep(width, width + 0.04, f));
}
void main() {
  vec2 p = vWorld.xz;
  float a = 0.0;
  if (uPattern > 8.5) a = 0.85;                                                  // outline band
  else if (uPattern > 3.5) a = 0.38 + 0.4 * max(lines(p.x + p.y, 0.9, 0.18), lines(p.x - p.y, 0.9, 0.18)); // impassable
  else if (uPattern > 2.5) a = 0.12 + 0.3 * max(lines(p.x + p.y, 1.6, 0.1), lines(p.x - p.y, 1.6, 0.1));    // hazard
  else if (uPattern > 1.5) a = 0.22 + 0.06 * sin(p.x * 1.3 + sin(p.y * 0.9) * 1.6);                           // water
  else if (uPattern > 0.5) a = 0.08 + 0.34 * lines(p.x + p.y, 1.4, 0.1);                                      // difficult
  else a = 0.05;                                                                                                // label
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
