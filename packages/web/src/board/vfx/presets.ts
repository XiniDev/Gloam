import { contains, type Footprint, footprint, resolveArea } from "@gloam/shared/aoe";
import type { AreaShape } from "@gloam/shared/schemas";
import { type BufferGeometry, Group, type Object3D } from "three";
import { type Preset, VFX } from "./palette.ts";
import { type EmitterSpec, particleBurst, seeded } from "./particles.ts";
import {
  bolt,
  curtain,
  decal,
  floorRing,
  footprintGeometry,
  glowDisc,
  orb,
  pillar,
  shell,
} from "./shapes.ts";

/**
 * The twelve VFX presets (SPEC §24.5): what a cast looks like — a burst over its area, a projectile to each creature it
 * strikes, an effect on the creatures themselves — and each one's subtle loop for a lasting area. A burst is a group
 * of pieces with the time it lasts; the layer ticks them and takes them away (VfxLayer). Particle counts scale with
 * the tier (§24.6: 100 / 70 / 40 / 20 %).
 */

export type V3 = [number, number, number];
export interface Piece {
  root: Object3D;
  /** Seconds it lasts (the longest of its parts). */
  life: number;
}

/** Where an area is on the floor: a disc's centre and radius, and its footprint for sampling. */
export interface Where {
  c: V3;
  r: number;
  f: Footprint | null;
  /** The way a cone or line points (unit, x and z), from its origin. */
  dir?: [number, number];
  origin?: V3;
  /** The area's shape (a line's bolt runs along it). */
  kind?: string;
}

/** A point along a polyline (by length), and the line's unit normal there. */
function alongLine(pts: { x: number; y: number }[], closed: boolean, t: number) {
  const ring = closed && pts.length > 2 ? [...pts, pts[0] as { x: number; y: number }] : pts;
  const segs = ring.slice(1).map((b, i) => [ring[i] as { x: number; y: number }, b] as const);
  const total = segs.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0);
  let d = t * total;
  for (const [a, b] of segs) {
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= l && l > 0)
      return {
        x: a.x + ((b.x - a.x) * d) / l,
        y: a.y + ((b.y - a.y) * d) / l,
        nx: -(b.y - a.y) / l,
        ny: (b.x - a.x) / l,
      };
    d -= l;
  }
  const last = ring[ring.length - 1] ?? { x: 0, y: 0 };
  return { x: last.x, y: last.y, nx: 0, ny: 0 };
}

/** A point in an area's footprint (a wall's along its line; others by rejection sampling in their box). */
function inside(w: Where, rnd: () => number): V3 {
  const f = w.f;
  if (!f || f.kind === "circle") {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * w.r;
    return [w.c[0] + Math.cos(a) * d, w.c[1], w.c[2] + Math.sin(a) * d];
  }
  if (f.kind === "strip") {
    const q = alongLine(f.points, f.closed, rnd());
    const off = (rnd() * 2 - 1) * f.halfWidth;
    return [q.x + q.nx * off, w.c[1], q.y + q.ny * off];
  }
  const pts = f.points;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let k = 0; k < 12; k++) {
    const p = { x: x0 + (x1 - x0) * rnd(), y: y0 + (y1 - y0) * rnd() };
    if (contains(f, p)) return [p.x, w.c[1], p.y];
  }
  return w.c;
}

/** A point on an area's edge: a disc's rim, a polygon's sides, a wall's line. */
function onEdge(w: Where, rnd: () => number): V3 {
  const f = w.f;
  if (!f || f.kind === "circle") {
    const a = rnd() * Math.PI * 2;
    return [w.c[0] + Math.cos(a) * w.r, w.c[1], w.c[2] + Math.sin(a) * w.r];
  }
  const q = alongLine(f.points, f.kind === "poly" || f.closed, rnd());
  return [q.x, w.c[1], q.y];
}

/**
 * How a floor piece lies over an area: a disc about its centre for a round one; any other, its own footprint about
 * its origin (a cone's apex, a line's start: a sweeping ring runs out from there) or its middle, and how far that
 * reaches. A wall's strip is at least `minHalf` ft either side of its line.
 */
function floorOf(w: Where, minHalf = 0) {
  const f = w.f;
  if (!f || f.kind === "circle")
    return {
      round: true,
      at: [w.c[0], 0, w.c[2]] as V3,
      reach: w.r,
      geometry: (): BufferGeometry | undefined => undefined,
    };
  const o = w.origin ?? w.c;
  const at: V3 = [o[0], 0, o[2]];
  const pad = f.kind === "strip" ? Math.max(f.halfWidth, minHalf) : 0;
  const reach = Math.max(2.5, ...f.points.map((p) => Math.hypot(p.x - at[0], p.y - at[2]) + pad));
  return {
    round: false,
    at,
    reach,
    geometry: (): BufferGeometry | undefined => footprintGeometry(f, { x: at[0], y: at[2] }, minHalf),
  };
}

/** An area's where: an effect's shape resolved (an emanation from its creature), or a cast's shape as sent. */
export function whereOf(
  shape: unknown,
  fallback: V3 | null,
  bodyOf: (id: string) => { pos: { x: number; y: number }; r: number; z: number; height: number } | null,
): Where | null {
  const s = shape as {
    kind?: string;
    distance?: number;
    at?: { x: number; y: number; z: number } | null;
    baseRadius?: number;
  } | null;
  if (s?.kind === "emanation" && "at" in s) {
    const at = s.at ?? (fallback ? { x: fallback[0], y: fallback[2], z: fallback[1] } : null);
    if (!at) return null;
    const r = (s.distance ?? 0) + (s.baseRadius ?? 2.5);
    return { c: [at.x, at.z + 0.1, at.y], r, f: { kind: "circle", c: { x: at.x, y: at.y }, r } };
  }
  if (!s?.kind) return fallback ? { c: fallback, r: 2.5, f: null } : null;
  const area = resolveArea(s as AreaShape, bodyOf);
  if (!area) return fallback ? { c: fallback, r: 2.5, f: null } : null;
  const f = footprint(area);
  const z = (area.z ?? 0) + 0.1;
  if (f.kind === "circle") return { c: [f.c.x, z, f.c.y], r: f.r, f };
  const pts = f.points;
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const r = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)));
  const out: Where = { c: [cx, z, cy], r, f, kind: area.kind };
  if ("origin" in area && "dirDeg" in area) {
    const a = ((area.dirDeg + 90) * Math.PI) / 180;
    out.dir = [Math.cos(a), Math.sin(a)];
    out.origin = [area.origin.x, z, area.origin.y];
  }
  return out;
}

/** Two colours mixed (`t` of the way from a to b), as a hex string. */
function mixHex(a: string, b: string, t: number): string {
  const ca = Number.parseInt(a.slice(1), 16);
  const cb = Number.parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((ca >> s) & 255) * (1 - t) + ((cb >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

const place = (o: Object3D, at: V3) => {
  o.position.set(at[0], at[1], at[2]);
  return o;
};

/** Particles bursting through an area: from inside it, outward (or along a cone's or line's way), up a little. */
function areaEmitter(
  w: Where,
  count: number,
  speed: number,
  up: number,
  life: [number, number],
  size: [number, number],
  extra: Partial<EmitterSpec> = {},
): EmitterSpec {
  return {
    count,
    origin: (_i, r) => inside(w, r),
    velocity: (_i, r) => {
      if (w.dir) {
        const s = speed * (0.5 + r());
        return [w.dir[0] * s + (r() - 0.5) * speed * 0.4, up * r(), w.dir[1] * s + (r() - 0.5) * speed * 0.4];
      }
      const a = r() * Math.PI * 2;
      const s = speed * (0.3 + r());
      return [Math.cos(a) * s, up * (0.3 + r()), Math.sin(a) * s];
    },
    life,
    size,
    ...extra,
  };
}

/**
 * A cast's burst over an area (§24.5 "Cast / impact"). A round area (a sphere, a cylinder, an emanation) gets its
 * shells and pillars; any other — a cone, a line, a cube, a wall — only pieces that keep to its footprint: its rings
 * sweep out from its origin clipped to its shape, its scorch or puddle is its shape, a line's lightning runs along it.
 */
export function areaBurst(preset: Preset, w: Where, scale: number, seed: number): Piece {
  const p = VFX[preset];
  const g = new Group();
  const R = Math.max(2.5, w.r);
  const fl = floorOf(w);
  const round = fl.round;
  let life = 1.5;
  const add = (o: Object3D, l: number) => {
    g.add(o);
    life = Math.max(life, l);
  };
  const burst = (e: EmitterSpec[], o: Parameters<typeof particleBurst>[1]) =>
    particleBurst(e, { seed, ...o }, scale);
  /** A ring sweeping out over the area: a disc's `r` for a round one, its footprint (from its origin) for any other. */
  const sweep = (o: Omit<Parameters<typeof floorRing>[0], "radius" | "geometry">, r = R) => {
    const geometry = fl.geometry();
    return place(
      floorRing({ ...o, radius: geometry ? fl.reach : r, ...(geometry ? { geometry } : {}) }),
      fl.at,
    );
  };
  /** A decal over the area: a disc of `r` for a round one (about its centre), its footprint for any other. */
  const stain = (o: Omit<Parameters<typeof decal>[0], "radius" | "geometry">, r: number, minHalf = 0) => {
    const f = floorOf(w, minHalf);
    const geometry = f.geometry();
    return place(decal({ ...o, radius: r, ...(geometry ? { geometry } : {}) }), f.at);
  };
  switch (preset) {
    case "fire":
      if (round)
        add(place(shell({ radius: R, life: 1.1, core: p.core, glow: p.glow, rough: 0.45 }), w.c), 1.1);
      add(
        burst(
          [
            areaEmitter(w, 170, round ? R * 0.9 : 1.5, 10, [0.7, 1.6], [0.5, 1.1], {
              sizeCurve: [1, 0.8, 0.2],
              alphaCurve: [0, 1, 0],
            }),
          ],
          { core: p.core, glow: p.glow, gravity: 6 },
        ),
        1.8,
      );
      // The ground it burnt: a wall's a band either side of its line.
      add(stain({ kind: "scorch", life: 5, core: p.shadow, glow: p.glow }, R * 0.9, 2), 5);
      break;
    case "cold":
      add(sweep({ life: 1.1, core: p.core, glow: p.glow, width: 0.08 }), 1.1);
      add(
        burst(
          [
            areaEmitter(w, 90, round ? R * 1.6 : 2, 3, [0.4, 0.9], [0.3, 0.6], {
              sizeCurve: [1, 1, 0.4],
              colorShift: 0.5,
            }),
          ],
          { core: p.core, glow: p.glow, soft: 0.6 },
        ),
        0.9,
      );
      add(
        burst([areaEmitter(w, 60, 0.8, 1.2, [1.6, 2.6], [0.25, 0.5])], {
          core: p.core,
          glow: p.glow,
          seed: seed + 1,
        }),
        2.6,
      );
      break;
    case "lightning":
      if (round)
        add(place(shell({ radius: R * 0.45, life: 0.3, core: p.core, glow: p.glow, rough: 0.2 }), w.c), 0.3);
      if (w.kind === "line" && w.dir && w.origin && w.f?.kind === "poly") {
        // A line (Lightning Bolt): the bolt itself, from the caster's hand to the line's end, and a second fork.
        const o = w.origin;
        const d = w.dir;
        const far = Math.max(...w.f.points.map((q) => (q.x - o[0]) * d[0] + (q.y - o[2]) * d[1]));
        for (let k = 0; k < 2; k++)
          add(
            bolt([o[0], 3, o[2]], [o[0] + d[0] * far, 3, o[2] + d[1] * far], {
              life: 0.45,
              core: p.core,
              seed: seed + k,
            }),
            0.45,
          );
      } else
        for (let k = 0; k < 3; k++) {
          const r = seeded(seed + k);
          const a = inside(w, r);
          add(bolt([a[0], 14, a[2]], [a[0], 0.1, a[2]], { life: 0.4, core: p.core, seed: seed + k }), 0.4);
        }
      add(
        burst([areaEmitter(w, 50, round ? R : 3, 6, [0.2, 0.5], [0.15, 0.3])], {
          core: p.core,
          glow: p.glow,
          gravity: 12,
        }),
        0.5,
      );
      break;
    case "thunder":
      add(sweep({ life: 0.8, core: p.core, glow: p.glow, width: 0.14 }, R * 1.1), 0.8);
      add(
        burst(
          [
            areaEmitter(w, 80, round ? R * 0.7 : 2, 2, [1.0, 1.8], [1.2, 2.2], {
              sizeCurve: [0.5, 1, 1.3],
              alphaCurve: [0, 0.5, 0],
            }),
          ],
          { core: p.shadow, glow: p.glow, additive: false, opacity: 0.55 },
        ),
        1.8,
      );
      break;
    case "acid":
      add(
        burst([areaEmitter(w, 90, round ? R * 0.6 : 2, 14, [0.6, 1.1], [0.3, 0.6])], {
          core: p.core,
          glow: p.glow,
          gravity: 26,
        }),
        1.1,
      );
      add(stain({ kind: "puddle", life: 4, core: p.core, glow: p.glow }, Math.max(2.5, R * 0.7), 1.5), 4);
      break;
    case "poison":
      add(
        burst(
          [
            areaEmitter(w, 38, round ? R * 0.25 : 1, 1, [1.6, 2.6], [2.5, 4.5], {
              sizeCurve: [0.4, 1, 1.2],
              alphaCurve: [0, 0.7, 0],
            }),
          ],
          { core: p.glow, glow: p.shadow, additive: false, opacity: 0.6 },
        ),
        2.6,
      );
      add(
        burst([areaEmitter(w, 40, round ? R * 0.4 : 1.5, 2, [0.8, 1.6], [0.2, 0.4])], {
          core: p.core,
          glow: p.glow,
          seed: seed + 1,
        }),
        1.6,
      );
      break;
    case "necrotic": {
      // Wisps drawn in from its edge to its middle (for any shape: its sides, then straight in — they stay inside it).
      const rnd = seeded(seed + 5);
      const from = Array.from({ length: 120 }, () => onEdge(w, rnd));
      add(
        burst(
          [
            {
              count: from.length,
              origin: (i, r) => {
                const q = from[i] as V3;
                return [q[0], w.c[1] + r() * 2, q[2]];
              },
              velocity: (i, r) => {
                const q = from[i] as V3;
                const k = 0.9 + r() * 0.3;
                return [(w.c[0] - q[0]) * k, 0.5, (w.c[2] - q[2]) * k];
              },
              life: [0.8, 1.2],
              size: [0.35, 0.7],
              colorShift: 1,
            },
          ],
          { core: p.glow, glow: p.shadow, additive: false, opacity: 0.85 },
        ),
        1.2,
      );
      if (round)
        add(
          place(
            shell({
              radius: R * 0.5,
              life: 1.2,
              core: p.core,
              glow: p.shadow,
              additive: false,
              opacity: 0.6,
            }),
            w.c,
          ),
          1.2,
        );
      break;
    }
    case "radiant":
      if (round)
        add(
          place(
            pillar({ radius: Math.max(2.5, R * 0.5), height: 24, life: 1.5, core: p.core, glow: p.glow }),
            [w.c[0], 0, w.c[2]],
          ),
          1.5,
        );
      // A line or cone of light (Sunbeam): a broad sweep of it along the ground.
      else add(sweep({ life: 1.2, core: p.core, glow: p.glow, width: 0.3 }), 1.2);
      add(burst([areaEmitter(w, 80, 0.6, 5, [1.0, 1.8], [0.2, 0.45])], { core: p.core, glow: p.glow }), 1.8);
      break;
    case "force":
      if (round)
        add(
          place(
            shell({
              radius: R,
              life: 1.0,
              core: p.core,
              glow: p.glow,
              rough: 0.05,
              facet: true,
              opacity: 0.7,
            }),
            w.c,
          ),
          1.0,
        );
      add(sweep({ life: 0.9, core: p.core, glow: p.glow }), 0.9);
      break;
    case "psychic":
      for (let k = 0; k < 3; k++) {
        const ring = sweep({ life: 1.0 + k * 0.25, core: p.core, glow: p.glow, width: 0.05 });
        ring.position.y = 0.05 + k * 0.01;
        add(ring, 1.0 + k * 0.25);
      }
      add(
        burst([areaEmitter(w, 60, round ? R * 0.3 : 1, 2, [0.8, 1.3], [0.3, 0.55])], {
          core: p.core,
          glow: p.glow,
        }),
        1.3,
      );
      break;
    case "healing":
      add(
        burst([areaEmitter(w, 90, 0.4, 3.5, [1.0, 1.6], [0.25, 0.5], { sizeCurve: [0.4, 1, 0.3] })], {
          core: p.core,
          glow: p.glow,
          gravity: -1,
        }),
        1.6,
      );
      break;
    case "arcane":
      // A runic circle for a round area; a sweep of light through any other (runes cut by a cone's sides read broken).
      add(sweep({ life: 1.6, core: p.core, glow: p.glow, runes: round }), 1.6);
      add(burst([areaEmitter(w, 60, 0.8, 3, [0.8, 1.5], [0.2, 0.4])], { core: p.core, glow: p.glow }), 1.5);
      break;
  }
  return { root: g, life };
}

/** A projectile to a creature, then its impact there (§24.5 "a projectile or instant form"). */
export function projectile(preset: Preset, from: V3, to: V3, scale: number, seed: number): Piece {
  const p = VFX[preset];
  const g = new Group();
  const a: V3 = [from[0], from[1] + 3, from[2]];
  const b: V3 = [to[0], to[1] + 2.5, to[2]];
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const flight = Math.min(0.6, Math.max(0.15, dist / 90));
  if (preset === "lightning") {
    g.add(bolt(a, b, { life: 0.45, core: p.core, seed }));
  } else {
    // A streak: particles strung along the way, each leaving as the head passes.
    g.add(
      particleBurst(
        [
          {
            count: 70,
            origin: () => a,
            velocity: (_i, r) => [
              ((b[0] - a[0]) / flight) * (0.97 + r() * 0.06),
              ((b[1] - a[1]) / flight) * (0.97 + r() * 0.06),
              ((b[2] - a[2]) / flight) * (0.97 + r() * 0.06),
            ],
            life: [flight * 0.9, flight * 1.05],
            delay: [0, flight * 0.25],
            size: [0.35, 0.7],
            sizeCurve: [1, 0.9, 0.5],
            alphaCurve: [1, 1, 0.2],
            colorShift: 0.6,
          },
        ],
        { core: p.core, glow: p.glow, seed },
        scale,
      ),
    );
  }
  const hit = areaBurst(preset, { c: b, r: 2.5, f: null }, scale * 0.5, seed + 7);
  // The impact lands when the head does.
  hit.root.userData.delay = flight;
  g.add(hit.root);
  return { root: g, life: flight + hit.life };
}

/** On a creature itself (a healing, a sense, a buff): the preset's small burst at it. */
export function atCreature(preset: Preset, at: V3, scale: number, seed: number): Piece {
  return areaBurst(preset, { c: [at[0], at[1] + 0.1, at[2]], r: 2.5, f: null }, scale * 0.6, seed);
}

/** A lasting area's loop (§24.5 "Persistent loop"; the named areas' own looks come first). */
export function areaLoop(
  preset: Preset,
  w: Where,
  props: {
    obscurement?: string;
    magicalDarkness?: boolean;
    difficult?: boolean;
    silence?: boolean;
    speedHalved?: boolean;
    outline?: boolean;
    light?: unknown;
    bodyFt?: number;
  },
  name: string,
  shapeKind: string,
  scale: number,
  seed: number,
  wallPoints?: { x: number; y: number }[],
  /** A wall's height and whether it's opaque; `dm`: the DM's view (they see what's inside a cloud or darkness). */
  extra: { height?: number; solid?: boolean; dm?: boolean } = {},
): Object3D {
  const p = VFX[preset];
  const g = new Group();
  const R = Math.max(1, w.r);
  const floor: V3 = [w.c[0], 0, w.c[2]];
  const fl = floorOf(w);
  /** A decal over the area: a disc of R for a round one, its footprint for any other. */
  const lying = (o: Omit<Parameters<typeof decal>[0], "radius" | "geometry">) => {
    const geometry = fl.geometry();
    return place(decal({ ...o, radius: R, ...(geometry ? { geometry } : {}) }), fl.at);
  };
  /** A ring over the area: a disc of R, or clipped to its footprint (from its origin). */
  const ringOver = (o: Omit<Parameters<typeof floorRing>[0], "radius" | "geometry">) => {
    const geometry = fl.geometry();
    return place(
      floorRing({ ...o, radius: geometry ? fl.reach : R, ...(geometry ? { geometry } : {}) }),
      fl.at,
    );
  };
  const loopBurst = (e: EmitterSpec[], o: Parameters<typeof particleBurst>[1]) =>
    particleBurst(e, { seed, loop: true, ...o }, scale);
  const drift = (
    count: number,
    up: number,
    life: [number, number],
    size: [number, number],
    extra: Partial<EmitterSpec> = {},
  ): EmitterSpec => ({
    count,
    origin: (_i, r) => {
      const q = inside(w, r);
      return [q[0], q[1] + r() * 2, q[2]];
    },
    velocity: (_i, r) => [(r() - 0.5) * 0.6, up * (0.5 + r()), (r() - 0.5) * 0.6],
    life,
    delay: [0, life[1]],
    size,
    ...extra,
  });
  // Named looks (§24.5 "Persistent areas").
  // Lightly obscured (Web; a fog the DM thins): a haze — a low, translucent mist that hides nothing (AC-VIS-07) —
  // under whatever else it draws.
  if (props.obscurement === "light") {
    if (fl.round) {
      const haze = shell({
        radius: R,
        life: 1,
        core: "#D8DEE6",
        glow: "#9AA6B4",
        rough: 0.5,
        additive: false,
        opacity: 0.3,
        loop: true,
        soft: true,
      });
      haze.scale.set(1, 0.28, 1);
      g.add(place(haze, [w.c[0], w.c[1] + R * 0.05, w.c[2]]));
    } else
      g.add(lying({ kind: "mist", life: 1, core: "#D8DEE6", glow: "#9AA6B4", loop: true, opacity: 0.45 }));
    // Only a haze (a thinned fog): nothing of its preset's loop over it. (Web adds its strands below.)
    if (!props.difficult) return g;
  }
  if (props.magicalDarkness) {
    // Darkness: an inky sphere with a swirling edge — thinner for the DM, who has to see what's in it.
    const opacity = extra.dm ? 0.6 : 0.92;
    g.add(
      fl.round
        ? place(
            shell({
              radius: R,
              life: 1,
              core: "#05060A",
              glow: "#1C1426",
              rough: 0.25,
              additive: false,
              opacity,
              loop: true,
              soft: true,
            }),
            w.c,
          )
        : lying({ kind: "mist", life: 1, core: "#1C1426", glow: "#05060A", loop: true, opacity }),
    );
    return g;
  }
  if (props.obscurement === "heavy") {
    // Clouds that hide what's in them (Fog Cloud, Sleet Storm, Stinking Cloud, Cloudkill): a soft body — a squat
    // noise-edged dome, so it reads as heavy at every tier — and big billboards churning in it; in each one's colour.
    const gas = /stinking/i.test(name)
      ? { core: "#D9C85A", glow: "#8A7B2A" }
      : /cloudkill/i.test(name) || preset === "poison"
        ? { core: "#B9C95A", glow: "#5F6E24" }
        : preset === "cold"
          ? { core: "#DCE6F0", glow: "#8FA3B8" }
          : { core: "#C9D0D8", glow: "#8492A6" };
    const thin = extra.dm ? 0.65 : 1;
    // A mist lying on the ground over its whole footprint (its edge fading, no outline), and puffs of cloud through
    // its volume at several heights — densest low and in the middle, drifting slowly; no dome with a silhouette
    // (critic P9 r1 #6: it read as frosted glass).
    g.add(lying({ kind: "mist", life: 1, core: gas.core, glow: gas.glow, loop: true, opacity: 0.75 * thin }));
    const tall = fl.round ? Math.min(R * 0.6, 14) : 8;
    g.add(
      particleBurst(
        [
          {
            ...drift(Math.round(R * 2.6), 0.15, [7, 11], [R * 0.3, R * 0.62], {
              sizeCurve: [0.75, 1, 0.9],
              alphaCurve: [0, 0.75, 0],
            }),
            origin: (_i, r) => {
              const q = inside(w, r);
              const lift = r() * r() * tall;
              return [q[0], q[1] + 1 + lift, q[2]];
            },
          },
        ],
        {
          seed,
          loop: true,
          core: gas.core,
          glow: gas.glow,
          additive: false,
          opacity: 0.42 * thin,
          soft: 0,
          puff: true,
        },
        // Billboards this big cost fill, not count: a floor under the tier's share, or the cloud comes apart.
        Math.max(scale, 0.6),
      ),
    );
    if (preset === "cold")
      // Sleet: streaks falling through it.
      g.add(
        particleBurst(
          [drift(Math.round(R * 3), -9, [0.6, 1.1], [0.12, 0.22], { alphaCurve: [0, 0.9, 0] })],
          { seed: seed + 3, loop: true, core: "#EEF4FA", glow: "#B7C6D6" },
          Math.max(scale, 0.5),
        ),
      );
    return g;
  }
  if (props.bodyFt) {
    // An object at its centre (Flaming Sphere): the burning ball itself (hot at its heart, embers at its limb, a glow
    // round it), the light it throws on the floor, flames licking up off it, and a faint ring where its heat reaches
    // (the zone a creature ending its turn in burns).
    const r = props.bodyFt / 2;
    g.add(
      place(orb({ radius: r, core: p.core, glow: p.glow, ember: p.shadow }), [w.c[0], w.c[1] + r, w.c[2]]),
    );
    g.add(place(glowDisc({ radius: Math.max(R, r * 3), color: p.glow, opacity: 0.4, flicker: true }), floor));
    g.add(
      loopBurst(
        [
          {
            ...drift(Math.round(40 * r), 3.2, [0.5, 0.9], [0.4, 0.8], { sizeCurve: [0.8, 1, 0.2] }),
            origin: (_i, rnd) => {
              const a = rnd() * Math.PI * 2;
              const u = rnd() * 2 - 1;
              const s2 = Math.sqrt(1 - u * u);
              return [w.c[0] + Math.cos(a) * s2 * r, w.c[1] + r + u * r, w.c[2] + Math.sin(a) * s2 * r];
            },
          },
        ],
        { core: p.core, glow: p.glow },
      ),
    );
    g.add(
      place(floorRing({ radius: R, life: 1, core: p.core, glow: p.glow, loop: true, opacity: 0.25 }), floor),
    );
    return g;
  }
  if (props.difficult && shapeKind === "cube" && props.obscurement === "light") {
    // Web: its strands across its cube's floor, faintly shining.
    g.add(lying({ kind: "web", life: 1, core: "#F6F2E6", glow: "#A9B4C2", loop: true, opacity: 1 }));
    return g;
  }
  if (props.difficult && !props.obscurement) {
    // Spike Growth: thorns.
    g.add(lying({ kind: "thorns", life: 1, core: "#3F5A2A", glow: "#1E2A14", loop: true, opacity: 1 }));
    return g;
  }
  if (props.speedHalved) {
    // Spirit Guardians: dozens of spectral motes circling the caster at three heights, each with fainter ones just
    // behind it on its orbit (a short trail), and a faint ring on the ground where they reach (critic P9 r1 #7).
    const motes = Math.round(R * 7);
    const orbit = (i: number, r: () => number, lag: number): [number, number, number] => {
      // The same mote's place on its orbit, `lag` radians behind (its trail), by its index.
      const rr = seeded(seed + i * 7919);
      const a = rr() * Math.PI * 2 - lag;
      const d = R * (0.35 + rr() * 0.6);
      const band = [1.2, 3.2, 5.4][i % 3] as number;
      void r;
      return [w.c[0] + Math.cos(a) * d, w.c[1] + band + rr() * 0.8, w.c[2] + Math.sin(a) * d];
    };
    const spec = (lag: number, size: [number, number]): EmitterSpec => ({
      count: motes,
      origin: (i, r) => orbit(i, r, lag),
      velocity: (_i, r) => [0, (r() - 0.5) * 0.3, 0],
      life: [4, 6],
      delay: [0, 6],
      size,
      alphaCurve: [0, 1, 0],
      swirl: 0.9,
    });
    g.add(
      particleBurst(
        [spec(0, [0.35, 0.7])],
        { core: p.core, glow: p.glow, loop: true, seed, swirlAt: [w.c[0], w.c[2]] },
        scale,
      ),
    );
    g.add(
      particleBurst(
        [spec(0.12, [0.25, 0.45]), spec(0.24, [0.15, 0.3])],
        { core: p.glow, glow: p.glow, loop: true, seed, swirlAt: [w.c[0], w.c[2]], opacity: 0.5 },
        scale,
      ),
    );
    g.add(ringOver({ life: 1, core: p.core, glow: p.glow, loop: true, opacity: 0.22, width: 0.03 }));
    return g;
  }
  if (props.silence) {
    // Silence: a hush, not a cloud (critic P9 r1 #6) — the faintest shell, only its rim catching the light, and a
    // slow ripple settling inward from the edge along the floor.
    g.add(
      place(
        shell({
          radius: R,
          life: 1,
          core: "#6F7F95",
          glow: "#3E4B5E",
          rough: 0.02,
          opacity: 0.09,
          loop: true,
        }),
        w.c,
      ),
    );
    g.add(
      ringOver({
        life: 1,
        core: "#A9B4C2",
        glow: "#5A6B80",
        loop: true,
        opacity: 0.28,
        width: 0.04,
        inward: true,
      }),
    );
    return g;
  }
  if (shapeKind === "wall" && wallPoints && wallPoints.length >= 2) {
    const height = Math.max(1, extra.height ?? 10);
    if (preset !== "fire") {
      // Every other wall (ice, stone, thorns, force, wind): a pane as tall as it is, dense if it's opaque, and its
      // line on the floor — what shows of it seen edge-on.
      const closed = w.f?.kind === "strip" && w.f.closed;
      const pane = { points: wallPoints, closed, core: p.core, glow: p.glow, look: "pane" as const };
      g.add(curtain({ ...pane, height, opacity: 0.9, solid: extra.solid === true }));
      g.add(curtain({ ...pane, height: 0, opacity: 0.8, floor: 1.2, solid: true }));
      return g;
    }
    // Wall of Fire: a curtain of flame along its line as tall as the wall, the embers above.
    const closed = w.f?.kind === "strip" && w.f.closed;
    const fire = {
      points: wallPoints,
      closed,
      core: p.core,
      glow: p.glow,
      ember: mixHex(p.glow, p.shadow, 0.35),
    };
    g.add(curtain({ ...fire, height, opacity: 0.85 }));
    // The burning ground along it (light on the floor): seen from above, where the curtain is edge-on.
    g.add(curtain({ ...fire, height: 0, opacity: 0.32, floor: 1.2, additive: true }));
    const segs = wallPoints.slice(1).map((b, i) => [wallPoints[i] as { x: number; y: number }, b] as const);
    const total = segs.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0) || 1;
    g.add(
      loopBurst(
        [
          {
            // Embers: many and small (a few px at the table's zoom — not bokeh).
            count: Math.round(total * 9),
            origin: (_i, r) => {
              let d = r() * total;
              for (const [a, b] of segs) {
                const l = Math.hypot(b.x - a.x, b.y - a.y);
                if (d <= l) {
                  const t = d / l;
                  return [a.x + (b.x - a.x) * t, 0.2, a.y + (b.y - a.y) * t];
                }
                d -= l;
              }
              return [wallPoints[0]?.x ?? 0, 0.2, wallPoints[0]?.y ?? 0];
            },
            velocity: (_i, r) => [(r() - 0.5) * 0.4, 5 + r() * 5, (r() - 0.5) * 0.4],
            life: [0.6, 1.3],
            delay: [0, 1.3],
            size: [0.15, 0.35],
            sizeCurve: [0.6, 1, 0.3],
            alphaCurve: [0, 1, 0],
          },
        ],
        { core: p.core, glow: p.glow },
      ),
    );
    return g;
  }
  if (shapeKind === "cylinder" && props.light && preset === "radiant") {
    // Moonbeam: a pale column of light.
    g.add(
      place(
        pillar({
          radius: R,
          height: 30,
          life: 1,
          core: "#D6E2F7",
          glow: "#8FA8D8",
          opacity: 0.26,
          loop: true,
        }),
        floor,
      ),
    );
    // The dim light it throws round its foot.
    g.add(place(glowDisc({ radius: R + 3, color: "#AFC4EC", opacity: 0.3 }), floor));
    return g;
  }
  if (props.outline) {
    // Faerie Fire's glow on a creature: motes round it.
    g.add(loopBurst([drift(18, 0.6, [1.2, 2], [0.2, 0.35])], { core: p.core, glow: "#B07FE0" }));
    return g;
  }
  // The preset's own loop.
  switch (preset) {
    case "fire":
      g.add(
        loopBurst(
          [
            {
              ...drift(Math.round(R * 6), 3, [0.6, 1.1], [0.5, 1.0], { sizeCurve: [0.8, 1, 0.2] }),
              // Flames round its edge (a disc's rim, a cone's sides).
              origin: (_i, r) => onEdge(w, r),
            },
          ],
          { core: p.core, glow: p.glow },
        ),
      );
      if (R <= 3 && fl.round)
        g.add(
          place(
            shell({ radius: R, life: 1, core: p.core, glow: p.glow, rough: 0.5, loop: true, opacity: 0.8 }),
            [w.c[0], w.c[1] + R, w.c[2]],
          ),
        );
      break;
    case "cold":
      g.add(
        loopBurst([drift(Math.round(R * 2), 0.3, [2, 3.5], [0.15, 0.3])], { core: p.core, glow: p.glow }),
      );
      break;
    case "lightning":
      // Call Lightning's storm cloud overhead, and an occasional arc. (Big billboards: a floor under the tier's share.)
      g.add(
        particleBurst(
          [
            {
              ...drift(Math.round(R * 1.2), 0.05, [6, 9], [R * 0.25, R * 0.45], { alphaCurve: [0, 0.8, 0] }),
              origin: (_i, r) => {
                const q = inside(w, r);
                return [q[0], 14 + r() * 2, q[2]];
              },
            },
          ],
          { seed, loop: true, core: "#3B3A55", glow: "#1F1E2E", additive: false, opacity: 0.7 },
          Math.max(scale, 0.6),
        ),
      );
      break;
    case "thunder":
      g.add(ringOver({ life: 1, core: p.core, glow: p.glow, loop: true, opacity: 0.35 }));
      break;
    case "acid":
      g.add(
        loopBurst([drift(Math.round(R * 3), 1.2, [0.8, 1.4], [0.15, 0.3])], { core: p.core, glow: p.glow }),
      );
      break;
    case "poison":
      g.add(
        loopBurst(
          [drift(Math.round(R * 1.2), 0.2, [5, 8], [R * 0.3, R * 0.5], { alphaCurve: [0, 0.6, 0] })],
          { core: p.glow, glow: p.shadow, additive: false, opacity: 0.45 },
        ),
      );
      break;
    case "necrotic":
      g.add(
        loopBurst([drift(Math.round(R * 2), 1, [1.5, 2.5], [0.3, 0.6])], {
          core: p.glow,
          glow: p.shadow,
          additive: false,
          opacity: 0.6,
        }),
      );
      break;
    case "radiant":
      g.add(
        loopBurst([drift(Math.round(R * 2), 0.8, [1.5, 2.5], [0.15, 0.3])], { core: p.core, glow: p.glow }),
      );
      break;
    case "force":
      g.add(
        fl.round
          ? place(
              shell({
                radius: R,
                life: 1,
                core: p.core,
                glow: p.glow,
                rough: 0.02,
                facet: true,
                opacity: 0.22,
                loop: true,
              }),
              w.c,
            )
          : ringOver({ life: 1, core: p.core, glow: p.glow, loop: true, opacity: 0.3 }),
      );
      break;
    case "psychic":
      g.add(ringOver({ life: 1, core: p.core, glow: p.glow, loop: true, opacity: 0.4 }));
      break;
    case "healing":
      break;
    case "arcane":
      // A runic circle on a round area; a slow sweep of light through any other.
      g.add(ringOver({ life: 1, core: p.core, glow: p.glow, runes: fl.round, loop: true, opacity: 0.5 }));
      break;
  }
  return g;
}
