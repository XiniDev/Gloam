import { contains, type Footprint, footprint, resolveArea } from "@gloam/shared/aoe";
import type { AreaShape } from "@gloam/shared/schemas";
import { Group, type Object3D } from "three";
import { type Preset, VFX } from "./palette.ts";
import { type EmitterSpec, particleBurst, seeded } from "./particles.ts";
import { bolt, decal, floorRing, pillar, shell } from "./shapes.ts";

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
}

/** A point in an area's footprint (rejection sampling in its box; the centre after a few misses). */
function inside(w: Where, rnd: () => number): V3 {
  const f = w.f;
  if (!f || f.kind === "circle") {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * w.r;
    return [w.c[0] + Math.cos(a) * d, w.c[1], w.c[2] + Math.sin(a) * d];
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
  const out: Where = { c: [cx, z, cy], r, f };
  if ("origin" in area && "dirDeg" in area) {
    const a = ((area.dirDeg + 90) * Math.PI) / 180;
    out.dir = [Math.cos(a), Math.sin(a)];
    out.origin = [area.origin.x, z, area.origin.y];
  }
  return out;
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

/** A cast's burst over an area (§24.5 "Cast / impact"). */
export function areaBurst(preset: Preset, w: Where, scale: number, seed: number): Piece {
  const p = VFX[preset];
  const g = new Group();
  const R = Math.max(2.5, w.r);
  let life = 1.5;
  const add = (o: Object3D, l: number) => {
    g.add(o);
    life = Math.max(life, l);
  };
  const burst = (e: EmitterSpec[], o: Parameters<typeof particleBurst>[1]) =>
    particleBurst(e, { seed, ...o }, scale);
  switch (preset) {
    case "fire":
      add(place(shell({ radius: R, life: 1.1, core: p.core, glow: p.glow, rough: 0.45 }), w.c), 1.1);
      add(
        burst(
          [
            areaEmitter(w, 170, R * 0.9, 10, [0.7, 1.6], [0.5, 1.1], {
              sizeCurve: [1, 0.8, 0.2],
              alphaCurve: [0, 1, 0],
            }),
          ],
          { core: p.core, glow: p.glow, gravity: 6 },
        ),
        1.8,
      );
      add(
        place(decal({ kind: "scorch", radius: R * 0.9, life: 5, core: p.shadow, glow: p.glow }), [
          w.c[0],
          0,
          w.c[2],
        ]),
        5,
      );
      break;
    case "cold":
      add(
        place(floorRing({ radius: R, life: 1.1, core: p.core, glow: p.glow, width: 0.08 }), [
          w.c[0],
          0,
          w.c[2],
        ]),
        1.1,
      );
      add(
        burst(
          [
            areaEmitter(w, 90, R * 1.6, 3, [0.4, 0.9], [0.3, 0.6], {
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
      add(place(shell({ radius: R * 0.45, life: 0.3, core: p.core, glow: p.glow, rough: 0.2 }), w.c), 0.3);
      for (let k = 0; k < 3; k++) {
        const r = seeded(seed + k);
        const a = inside(w, r);
        add(bolt([a[0], 14, a[2]], [a[0], 0.1, a[2]], { life: 0.4, core: p.core, seed: seed + k }), 0.4);
      }
      add(
        burst([areaEmitter(w, 50, R, 6, [0.2, 0.5], [0.15, 0.3])], {
          core: p.core,
          glow: p.glow,
          gravity: 12,
        }),
        0.5,
      );
      break;
    case "thunder":
      add(
        place(floorRing({ radius: R * 1.1, life: 0.8, core: p.core, glow: p.glow, width: 0.14 }), [
          w.c[0],
          0,
          w.c[2],
        ]),
        0.8,
      );
      add(
        burst(
          [
            areaEmitter(w, 80, R * 0.7, 2, [1.0, 1.8], [1.2, 2.2], {
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
        burst([areaEmitter(w, 90, R * 0.6, 14, [0.6, 1.1], [0.3, 0.6])], {
          core: p.core,
          glow: p.glow,
          gravity: 26,
        }),
        1.1,
      );
      add(
        place(
          decal({ kind: "puddle", radius: Math.max(2.5, R * 0.7), life: 4, core: p.core, glow: p.glow }),
          [w.c[0], 0, w.c[2]],
        ),
        4,
      );
      break;
    case "poison":
      add(
        burst(
          [
            areaEmitter(w, 38, R * 0.25, 1, [1.6, 2.6], [2.5, 4.5], {
              sizeCurve: [0.4, 1, 1.2],
              alphaCurve: [0, 0.7, 0],
            }),
          ],
          { core: p.glow, glow: p.shadow, additive: false, opacity: 0.6 },
        ),
        2.6,
      );
      add(
        burst([areaEmitter(w, 40, R * 0.4, 2, [0.8, 1.6], [0.2, 0.4])], {
          core: p.core,
          glow: p.glow,
          seed: seed + 1,
        }),
        1.6,
      );
      break;
    case "necrotic":
      add(
        burst(
          [
            {
              count: 120,
              origin: (_i, r) => {
                const a = r() * Math.PI * 2;
                return [w.c[0] + Math.cos(a) * R, w.c[1] + r() * 2, w.c[2] + Math.sin(a) * R];
              },
              velocity: (i, r) => {
                const a = ((i * 2.399) % (Math.PI * 2)) + r() * 0.2;
                const s = R * (0.9 + r() * 0.3);
                return [-Math.cos(a) * s, 0.5, -Math.sin(a) * s];
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
      add(
        place(
          shell({ radius: R * 0.5, life: 1.2, core: p.core, glow: p.shadow, additive: false, opacity: 0.6 }),
          w.c,
        ),
        1.2,
      );
      break;
    case "radiant":
      add(
        place(pillar({ radius: Math.max(2.5, R * 0.5), height: 24, life: 1.5, core: p.core, glow: p.glow }), [
          w.c[0],
          0,
          w.c[2],
        ]),
        1.5,
      );
      add(burst([areaEmitter(w, 80, 0.6, 5, [1.0, 1.8], [0.2, 0.45])], { core: p.core, glow: p.glow }), 1.8);
      break;
    case "force":
      add(
        place(
          shell({ radius: R, life: 1.0, core: p.core, glow: p.glow, rough: 0.05, facet: true, opacity: 0.7 }),
          w.c,
        ),
        1.0,
      );
      add(place(floorRing({ radius: R, life: 0.9, core: p.core, glow: p.glow }), [w.c[0], 0, w.c[2]]), 0.9);
      break;
    case "psychic":
      for (let k = 0; k < 3; k++) {
        const ring = floorRing({ radius: R, life: 1.0 + k * 0.25, core: p.core, glow: p.glow, width: 0.05 });
        add(place(ring, [w.c[0], 0.05 + k * 0.01, w.c[2]]), 1.0 + k * 0.25);
      }
      add(
        burst([areaEmitter(w, 60, R * 0.3, 2, [0.8, 1.3], [0.3, 0.55])], { core: p.core, glow: p.glow }),
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
      add(
        place(floorRing({ radius: R, life: 1.6, core: p.core, glow: p.glow, runes: true }), [
          w.c[0],
          0,
          w.c[2],
        ]),
        1.6,
      );
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
  },
  name: string,
  shapeKind: string,
  scale: number,
  seed: number,
  wallPoints?: { x: number; y: number }[],
): Object3D {
  const p = VFX[preset];
  const g = new Group();
  const R = Math.max(1, w.r);
  const floor: V3 = [w.c[0], 0, w.c[2]];
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
  if (props.magicalDarkness) {
    // Darkness: an inky sphere with a swirling edge.
    g.add(
      place(
        shell({
          radius: R,
          life: 1,
          core: "#05060A",
          glow: "#1C1426",
          rough: 0.25,
          additive: false,
          opacity: 0.92,
          loop: true,
        }),
        w.c,
      ),
    );
    return g;
  }
  if (props.obscurement === "heavy" && (preset === "poison" || /cloud/i.test(name))) {
    // Stinking Cloud, Cloudkill: slow churning green-grey clouds.
    g.add(
      loopBurst(
        [
          drift(Math.round(R * 2.2), 0.25, [5, 8], [R * 0.45, R * 0.7], {
            sizeCurve: [0.6, 1, 0.9],
            alphaCurve: [0, 0.75, 0],
          }),
        ],
        { core: p.glow, glow: p.shadow, additive: false, opacity: 0.55 },
      ),
    );
    return g;
  }
  if (props.obscurement === "heavy") {
    // Fog Cloud, Sleet Storm: layered soft billboards of grey fog.
    g.add(
      loopBurst(
        [
          drift(Math.round(R * 2.5), 0.15, [6, 9], [R * 0.5, R * 0.8], {
            sizeCurve: [0.7, 1, 0.9],
            alphaCurve: [0, 0.8, 0],
          }),
        ],
        { core: "#B7BEC8", glow: "#8492A6", additive: false, opacity: 0.6 },
      ),
    );
    if (preset === "cold")
      g.add(
        loopBurst([drift(40, -3, [1.2, 2], [0.15, 0.3])], { core: p.core, glow: p.glow, seed: seed + 3 }),
      );
    return g;
  }
  if (props.difficult && shapeKind === "cube" && props.obscurement === "light") {
    // Web: its strands on the floor, faintly shining.
    g.add(
      place(
        decal({
          kind: "web",
          radius: R,
          life: 1,
          core: "#EDE6D6",
          glow: "#A9B4C2",
          loop: true,
          opacity: 0.7,
        }),
        floor,
      ),
    );
    return g;
  }
  if (props.difficult && !props.obscurement) {
    // Spike Growth: thorns.
    g.add(
      place(
        decal({
          kind: "thorns",
          radius: R,
          life: 1,
          core: "#3F5A2A",
          glow: "#1E2A14",
          loop: true,
          opacity: 0.8,
        }),
        floor,
      ),
    );
    return g;
  }
  if (props.speedHalved) {
    // Spirit Guardians: spectral motes orbiting the caster.
    g.add(
      particleBurst(
        [
          {
            count: Math.round(R * 4),
            origin: (_i, r) => {
              const a = r() * Math.PI * 2;
              const d = R * (0.35 + r() * 0.6);
              return [w.c[0] + Math.cos(a) * d, w.c[1] + 1 + r() * 4, w.c[2] + Math.sin(a) * d];
            },
            velocity: (_i, r) => [0, (r() - 0.5) * 0.4, 0],
            life: [3, 5],
            delay: [0, 5],
            size: [0.3, 0.6],
            alphaCurve: [0, 1, 0],
            swirl: 0.9,
          },
        ],
        { core: p.core, glow: p.glow, loop: true, seed, swirlAt: [w.c[0], w.c[2]] },
        scale,
      ),
    );
    return g;
  }
  if (props.silence) {
    // Silence: a faint, muted dome.
    g.add(
      place(
        shell({
          radius: R,
          life: 1,
          core: "#A9B4C2",
          glow: "#4A5A70",
          rough: 0.02,
          opacity: 0.18,
          loop: true,
        }),
        w.c,
      ),
    );
    return g;
  }
  if (shapeKind === "wall" && wallPoints && wallPoints.length >= 2) {
    // Wall of Fire (and other walls): a curtain along its line.
    const segs = wallPoints.slice(1).map((b, i) => [wallPoints[i] as { x: number; y: number }, b] as const);
    const total = segs.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0) || 1;
    g.add(
      loopBurst(
        [
          {
            count: Math.round(total * 5),
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
            size: [0.8, 1.6],
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
          core: "#EEF4FF",
          glow: "#9FB8E8",
          opacity: 0.45,
          loop: true,
        }),
        floor,
      ),
    );
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
              origin: (_i, r) => {
                const a = r() * Math.PI * 2;
                return [w.c[0] + Math.cos(a) * R * 0.95, w.c[1], w.c[2] + Math.sin(a) * R * 0.95];
              },
            },
          ],
          { core: p.core, glow: p.glow },
        ),
      );
      if (R <= 3)
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
      // Call Lightning's storm cloud overhead, and an occasional arc.
      g.add(
        loopBurst(
          [
            {
              ...drift(Math.round(R * 1.2), 0.05, [6, 9], [R * 0.25, R * 0.45], { alphaCurve: [0, 0.8, 0] }),
              origin: (_i, r) => {
                const q = inside(w, r);
                return [q[0], 14 + r() * 2, q[2]];
              },
            },
          ],
          { core: "#3B3A55", glow: "#1F1E2E", additive: false, opacity: 0.7 },
        ),
      );
      break;
    case "thunder":
      g.add(
        place(
          floorRing({ radius: R, life: 1, core: p.core, glow: p.glow, loop: true, opacity: 0.35 }),
          floor,
        ),
      );
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
        place(
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
        ),
      );
      break;
    case "psychic":
      g.add(
        place(floorRing({ radius: R, life: 1, core: p.core, glow: p.glow, loop: true, opacity: 0.4 }), floor),
      );
      break;
    case "healing":
      break;
    case "arcane":
      g.add(
        place(
          floorRing({
            radius: R,
            life: 1,
            core: p.core,
            glow: p.glow,
            runes: true,
            loop: true,
            opacity: 0.5,
          }),
          floor,
        ),
      );
      break;
  }
  return g;
}
