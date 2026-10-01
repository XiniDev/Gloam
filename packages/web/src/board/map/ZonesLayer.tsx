import { inPolygon, type P } from "@gloam/shared/geometry";
import { type WorldZoneShape, zonePolygon } from "@gloam/shared/movement";
import type { TokenView, ZoneView } from "@gloam/shared/state";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BufferGeometry,
  type Camera,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  type Group,
  type Material,
  type Mesh,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
} from "three";
import { useBoardCovers, useHudObstacles } from "../../hud/insets.ts";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { knownAt } from "../../state/fog.ts";
import { useDmView, useViewAs } from "../../state/viewAs.ts";
import { BoardText } from "../BoardText.tsx";
import { C } from "../colors.ts";
import { disposeLater } from "../dispose.ts";
import { CAPS_FONT } from "../fonts.ts";
import { useZoneTool } from "../tools/zones.ts";
import { fogUniforms } from "../vision/fogMaterial.ts";
import { useDrawn } from "../warmup/state.ts";
import { parseZoneShape } from "./zoneShape.ts";

/**
 * Zones on the floor (SPEC §8.7 Zones): difficult terrain with a subtle hatch, water with a slow ripple, hazards with a
 * warm cross-hatch, impassable ground dark and densely hatched, a named area (Label) as an engraved dashed border with
 * its name set like a plaque inside the top edge — each in its colour. Names lie on the floor at the shape's most
 * interior point, kept between 12 and 20 px on screen whatever the zoom. DMs also see zones hidden from players,
 * dimmer.
 */
export function ZonesLayer() {
  const zones = useDrawn("zones");
  // Viewing as a player: their zones only (zones hidden from players never reach them).
  const dmView = useDmView();
  const as = useViewAs((s) => s.userId !== null);
  return (
    <group name="zones">
      {[...zones.values()]
        .filter((z) => !(as && z.dmHidden))
        .map((z) => (
          <ZoneMesh key={z.id} zone={z} dmView={dmView} />
        ))}
    </group>
  );
}

const PATTERN: Record<string, number> = { difficult: 1, water: 2, hazard: 3, impassable: 4, label: 0 };

function ZoneMesh({ zone, dmView }: { zone: ZoneView; dmView: boolean }) {
  const dm = dmView;
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
  // Where the name may go; it takes the spot tokens cover least (ClampedLabel decides each frame, from the camera).
  const tokens = useBoard((d) => d.tokens);
  const spots = useMemo(
    () => (shape ? labelSpots(shape, zone.kind, zone.label) : []),
    [shape, zone.kind, zone.label],
  );
  // Walls running through a spot hide the name too (from above, a wall's top covers it): counted per wall change.
  const walls = useBoard((d) => d.walls);
  const wallCost = useMemo(
    () =>
      spots.map((sp) => {
        const w = sp.size * Math.max(3, zone.label.length) * 0.62 + 1;
        const h = sp.size * 1.2 + 1;
        let n = 0;
        for (const wl of walls.values())
          if (
            segHitsBox(
              wl.ax,
              wl.ay,
              wl.bx,
              wl.by,
              sp.at.x - w / 2,
              sp.at.y - h / 2,
              sp.at.x + w / 2,
              sp.at.y + h / 2,
            )
          )
            n++;
        return n * 4;
      }),
    [spots, walls, zone.label],
  );
  const place = spots[0] ?? null;
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
        <ClampedLabel
          spots={spots}
          wallCost={wallCost}
          tokens={tokens}
          chars={zone.label.length}
          dim={hidden && dm}
        >
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
 * Where a zone's name may go and how big it is on the floor (feet), in order of preference: at the most interior point,
 * as large as fits across the room there (it's clamped on screen afterwards), then higher and lower; a named area's
 * name like a plaque just inside its top edge, then its bottom edge, then as a tab just outside either.
 */
function labelSpots(shape: WorldZoneShape, kind: string, label: string): { at: P; size: number }[] {
  const chars = Math.max(3, label.length);
  const fit = (room: number) => Math.min(2.4, Math.max(0.6, room / (chars * 0.62)));
  if (shape.kind === "circle") {
    const size = fit(shape.r * 1.6);
    const at = (dy: number) => ({ at: { x: shape.x, y: shape.y + dy }, size });
    return kind === "label"
      ? [
          at(-shape.r + size * 1.1),
          at(shape.r - size * 1.1),
          at(-shape.r - size * 0.9),
          at(shape.r + size * 0.9),
        ]
      : [
          at(0),
          at(-shape.r / 2),
          at(shape.r / 2),
          // Left and right halves too: a panel over one side leaves the other to read it on (critic RSP-01 r2).
          { at: { x: shape.x - shape.r / 2, y: shape.y }, size: fit(shape.r * 0.8) },
          { at: { x: shape.x + shape.r / 2, y: shape.y }, size: fit(shape.r * 0.8) },
        ];
  }
  if (shape.kind === "rect") {
    const size = fit(shape.w * 0.9);
    const at = (y: number) => ({ at: { x: shape.x + shape.w / 2, y }, size });
    return kind === "label"
      ? [
          at(shape.y + size * 0.95),
          at(shape.y + shape.h - size * 0.95),
          at(shape.y - size * 0.9),
          at(shape.y + shape.h + size * 0.9),
        ]
      : [
          at(shape.y + shape.h / 2),
          at(shape.y + shape.h / 4),
          at(shape.y + (shape.h * 3) / 4),
          // Left and right halves too, sized for them: a panel over one side leaves the other (critic RSP-01 r2:
          // "BLACK WA" under the dock's panel).
          { at: { x: shape.x + shape.w * 0.25, y: shape.y + shape.h / 2 }, size: fit(shape.w * 0.45) },
          { at: { x: shape.x + shape.w * 0.75, y: shape.y + shape.h / 2 }, size: fit(shape.w * 0.45) },
        ];
  }
  const { p, r } = interiorPoint(shape.points);
  const size = fit(r * 2);
  const out = [{ at: p, size }];
  for (const dy of [-r * 0.6, r * 0.6]) {
    const q = { x: p.x, y: p.y + dy };
    if (inPolygon(q, shape.points)) out.push({ at: q, size });
  }
  // Left and right of it too, where they're inside: a panel over one side leaves the other (critic RSP-01 r2).
  for (const dx of [-r * 0.8, r * 0.8]) {
    const q = { x: p.x + dx, y: p.y };
    if (inPolygon(q, shape.points)) out.push({ at: q, size: fit(r) });
  }
  return out;
}

/**
 * How much of a label spot (a w × h rectangle on the floor) the tokens hide from this camera: their bases, and the
 * floor behind a standing figure — its height over the camera's slope, away from the camera.
 */
function coveredArea(
  at: P,
  w: number,
  h: number,
  tokens: Map<string, TokenView>,
  away: { x: number; y: number },
  slope: number,
): number {
  let cost = 0;
  const overlap = (x0: number, y0: number, x1: number, y1: number) => {
    const ox = Math.min(at.x + w / 2, x1) - Math.max(at.x - w / 2, x0);
    const oy = Math.min(at.y + h / 2, y1) - Math.max(at.y - h / 2, y0);
    return ox > 0 && oy > 0 ? ox * oy : 0;
  };
  for (const t of tokens.values()) {
    const r = (t.sizeFt / 2) * 1.15;
    cost += overlap(t.pos.x - r, t.pos.y - r, t.pos.x + r, t.pos.y + r);
    if (t.mode === "coin" || slope <= 0) continue;
    // A standing figure (standee or mini, about 1.3 × its space tall) hides the floor behind it.
    const len = Math.min(40, (t.sizeFt * 1.3) / slope);
    const ex = t.pos.x + away.x * len;
    const ey = t.pos.y + away.y * len;
    cost +=
      overlap(
        Math.min(t.pos.x, ex) - r,
        Math.min(t.pos.y, ey) - r,
        Math.max(t.pos.x, ex) + r,
        Math.max(t.pos.y, ey) + r,
      ) * 0.8;
  }
  return cost;
}

const LABEL_PX = { min: 12, max: 20 };
const hud3 = new Vector3();
const hudSide3 = new Vector3();

/**
 * How much of a label at a spot the HUD hides on screen (0–1): its box as drawn — its clamped size, its letters' width —
 * against each cover's rectangle.
 */
function hudHidden(
  at: P,
  chars: number,
  size: number,
  camera: Camera,
  viewport: { width: number; height: number },
  covers: readonly { left: number; top: number; right: number; bottom: number }[],
): number {
  if (!covers.length) return 0;
  hud3.set(at.x, 0, at.y).project(camera);
  if (hud3.z > 1) return 0;
  hudSide3
    .set(1, 0, 0)
    .applyQuaternion(camera.quaternion)
    .add(hud3.set(at.x, 0, at.y))
    .project(camera);
  hud3.set(at.x, 0, at.y).project(camera);
  const ppf = (Math.hypot(hudSide3.x - hud3.x, hudSide3.y - hud3.y) * viewport.width) / 2;
  const px = Math.min(LABEL_PX.max, Math.max(LABEL_PX.min, size * ppf));
  const w = px * Math.max(3, chars) * 0.62;
  const h = px * 1.2;
  const cx = ((hud3.x + 1) / 2) * viewport.width;
  const cy = ((1 - hud3.y) / 2) * viewport.height;
  const box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  let hidden = 0;
  for (const r of covers) {
    const ox = Math.min(box.x1, r.right) - Math.max(box.x0, r.left);
    const oy = Math.min(box.y1, r.bottom) - Math.max(box.y0, r.top);
    if (ox > 0 && oy > 0) hidden += ox * oy;
  }
  return Math.min(1, hidden / (w * h));
}
const at3 = new Vector3();
const side3 = new Vector3();
const back3 = new Vector3();

/**
 * A name lying on the floor, kept legible: its size on screen stays within 12–20 px however far the camera is (the
 * text is laid out once; only its scale follows the zoom), at the spot tokens hide least from where the camera is.
 */
function ClampedLabel({
  spots,
  wallCost,
  tokens,
  chars,
  dim,
  children,
}: {
  spots: { at: P; size: number }[];
  wallCost: number[];
  tokens: Map<string, TokenView>;
  chars: number;
  dim: boolean;
  children: string;
}) {
  const group = useRef<Group>(null);
  const chosen = useRef(0);
  const camera = useThree((s) => s.camera);
  const viewport = useThree((s) => s.size);
  const size = spots[0]?.size ?? 1;
  useFrame(() => {
    const g = group.current;
    if (!g || !spots.length) return;
    // The spot: least hidden (a clear margin needed to leave the current one, so it doesn't flicker).
    back3.setFromMatrixColumn(camera.matrixWorld, 2);
    const flat = Math.hypot(back3.x, back3.z);
    const away = flat > 1e-3 ? { x: -back3.x / flat, y: -back3.z / flat } : { x: 0, y: 0 };
    const slope = flat > 1e-3 ? back3.y / flat : 0;
    const w = size * Math.max(3, chars) * 0.62;
    // The HUD over the board (the dock's panel, the rails, cards): a spot it hides loses to any it doesn't, as a
    // plate's does (critic RSP-01 r2: "BLACK WA" cut by the panel at 1440 × 900).
    const covers = [
      ...Object.values(useHudObstacles.getState().rects),
      ...Object.values(useBoardCovers.getState().rects),
    ];
    const costs = spots.map(
      (sp, i) =>
        coveredArea(sp.at, w, size * 1.2, tokens, away, slope) +
        (wallCost[i] ?? 0) +
        hudHidden(sp.at, chars, size, camera, viewport, covers) * 1e4 +
        i * 0.01,
    );
    let best = chosen.current < spots.length ? chosen.current : 0;
    for (let i = 0; i < costs.length; i++) if ((costs[i] as number) < (costs[best] as number) - 0.5) best = i;
    chosen.current = best;
    const at = (spots[best] as { at: P }).at;
    if (g.position.x !== at.x || g.position.z !== at.y) g.position.set(at.x, 0.04, at.y);
    // A player reads a zone's name only over ground they know.
    g.visible = fogUniforms.gDm.value > 0.5 || knownAt(at.x, at.y, useTable.getState().me?.userId ?? null);
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
    // Grown past its zone to stay readable (a small board on a phone), it reaches over the walls round it: drawn over
    // them then, not cut by them ("LACK WATEI", critic RSP-01 r1). At its own size it stays depth-tested — tokens
    // standing on it in front. (troika re-derives its materials: set each frame.)
    const over = k > 1.02;
    g.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) if (x.depthTest === over) x.depthTest = !over;
    });
  });
  const first = spots[0]?.at ?? { x: 0, y: 0 };
  return (
    <group ref={group} position={[first.x, 0.04, first.y]}>
      <BoardText
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
        // After the DM's walls overlay (order 3–4, no depth test), so a wall line doesn't strike through the name;
        // still depth-tested, so tokens standing on it stay in front.
        renderOrder={5}
        raycast={() => null}
      >
        {children}
      </BoardText>
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
uniform float gMode; uniform float gDm; uniform sampler2D gMem; uniform vec4 gMemRect;
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
  // A player sees a zone only where the ground is known to them (revealed or explored), never over the unknown.
  float known = 1.0;
  if (gMode > 0.5 && gDm < 0.5) known = texture2D(gMem, (p - gMemRect.xy) / gMemRect.zw).r;
  gl_FragColor = vec4(uColor, a * uAlpha * known);
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
      gMode: fogUniforms.gMode,
      gDm: fogUniforms.gDm,
      gMem: fogUniforms.gMem,
      gMemRect: fogUniforms.gMemRect,
    },
  });
}

/** Whether segment ab passes through the box (either end inside, or crossing it). */
function segHitsBox(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  // Liang–Barsky: clip the segment to the box.
  for (const [p, q] of [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}
