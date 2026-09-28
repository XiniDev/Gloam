import { describe, expect, it } from "vitest";
import { visContains, visRing } from "../geometry/index.ts";
import { ZERO_SENSES } from "../schemas/entities.ts";
import { markSeen } from "./explored.ts";
import {
  BLIND,
  type Creature,
  DARKVISION,
  NONE,
  perceiveCreature,
  perceivePoint,
  prepareViewer,
  SEE_BRIGHT,
  SEE_DIM,
  type Viewer,
} from "./perceive.ts";
import { fillRing, fillVis, LightRaster, Raster, rleDecode, rleEncode } from "./raster.ts";
import {
  BRIGHT,
  DARK,
  DIM,
  groundRadii,
  VisionGeometry,
  type VisionLight,
  type VisionWall,
  VisionWorld,
} from "./world.ts";

const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
const wall = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  kind = "wall",
  door?: "open" | "closed",
): VisionWall => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  kind,
  door,
});
const torch = (x: number, y: number, extra: Partial<VisionLight> = {}): VisionLight => ({
  id: `t${x},${y}`,
  x,
  y,
  bright: 20,
  dim: 20,
  coneDeg: null,
  directionDeg: 0,
  magical: false,
  pierceDarkness: false,
  ...extra,
});
const viewer = (
  x: number,
  y: number,
  senses: Partial<typeof ZERO_SENSES> = {},
  extra: Partial<Viewer> = {},
): Viewer => ({
  x,
  y,
  elevation: 0,
  senses: { ...ZERO_SENSES, ...senses },
  ...extra,
});
const goblin = (x: number, y: number, extra: Partial<Creature> = {}): Creature => ({
  x,
  y,
  elevation: 0,
  sizeFt: 5,
  ...extra,
});
function square(x: number, y: number, s: number) {
  return [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
}

describe("light (§15.3 lightLevel, AC-VIS-03)", () => {
  it("a torch lights 20 ft bright plus 20 ft dim, blocked by walls", () => {
    const geo = new VisionGeometry([wall(40, 0, 40, 60)]);
    const w = new VisionWorld(geo, [torch(10, 30)], "dark", bounds);
    expect(w.lightLevel(10, 30)).toBe(BRIGHT);
    expect(w.lightLevel(29.9, 30)).toBe(BRIGHT);
    expect(w.lightLevel(30.1, 30)).toBe(DIM);
    expect(w.lightLevel(10, 55)).toBe(DIM);
    expect(w.lightLevel(38.2, 58.2)).toBe(DIM); // 39.9 ft
    expect(w.lightLevel(38.5, 58.5)).toBe(DARK); // 40.3 ft
    // Behind the wall, inside the radius: dark.
    expect(w.lightLevel(45, 30)).toBe(DARK);
    // An open door lets it through; a window too (light follows sight); a curtain doesn't.
    for (const [kind, door, through] of [
      ["door", "open", true],
      ["door", "closed", false],
      ["window", undefined, true],
      ["curtain", undefined, false],
    ] as const) {
      const g = new VisionGeometry([wall(30, 0, 30, 60, kind, door)]);
      expect(new VisionWorld(g, [torch(20, 30)], "dark", bounds).lightLevel(45, 30), `${kind} ${door}`).toBe(
        through ? DIM : DARK,
      );
    }
  });

  it("disabled, DM-only and zero lights light nothing; ambient sets the floor", () => {
    const geo = new VisionGeometry([]);
    expect(new VisionWorld(geo, [torch(20, 30, { enabled: false })], "dark", bounds).lightLevel(20, 30)).toBe(
      DARK,
    );
    expect(new VisionWorld(geo, [torch(20, 30, { dmOnly: true })], "dark", bounds).lightLevel(20, 30)).toBe(
      DARK,
    );
    expect(new VisionWorld(geo, [], "dim", bounds).lightLevel(90, 50)).toBe(DIM);
    expect(new VisionWorld(geo, [], "bright", bounds).lightLevel(90, 50)).toBe(BRIGHT);
  });

  it("a bullseye lantern lights only its cone (facing as rotationDeg: 0 faces south, 90 west)", () => {
    const geo = new VisionGeometry([]);
    const l = torch(50, 30, { bright: 60, dim: 60, coneDeg: 53.13, directionDeg: 0 });
    const w = new VisionWorld(geo, [l], "dark", bounds);
    expect(w.lightLevel(50, 50)).toBe(BRIGHT); // south
    expect(w.lightLevel(50, 10)).toBe(DARK); // north: behind it
    expect(w.lightLevel(70, 30)).toBe(DARK); // east: outside the cone
    const west = new VisionWorld(geo, [{ ...l, directionDeg: 90 }], "dark", bounds);
    expect(west.lightLevel(30, 30)).toBe(BRIGHT);
    expect(west.lightLevel(50, 50)).toBe(DARK);
  });
});

describe("perceive a point (§15.3)", () => {
  const dark = (walls: VisionWall[] = [], lights: VisionLight[] = []) =>
    new VisionWorld(new VisionGeometry(walls), lights, "dark", bounds);

  it("AC-VIS-04: darkvision 60 sees darkness within 60 ft as grey, dim light as bright; beyond range nothing", () => {
    const w = dark([], [torch(80, 30, { bright: 0, dim: 15 })]);
    const v = prepareViewer(w, viewer(10, 30, { darkvision: 60 }));
    expect(perceivePoint(w, v, 50, 30)).toBe(DARKVISION);
    expect(perceivePoint(w, v, 71, 50)).toBe(NONE); // dark, out of range
    expect(perceivePoint(w, v, 69, 30)).toBe(SEE_BRIGHT); // dim light within darkvision counts as bright
    expect(perceivePoint(w, v, 80, 30)).toBe(SEE_DIM); // dim light beyond darkvision stays dim
    const human = prepareViewer(w, viewer(10, 30));
    expect(perceivePoint(w, human, 50, 30)).toBe(NONE);
    expect(perceivePoint(w, human, 80, 30)).toBe(SEE_DIM);
  });

  it("walls block sight; windows don't", () => {
    const w = new VisionWorld(
      new VisionGeometry([wall(50, 0, 50, 60), wall(30, 0, 30, 60, "window")]),
      [],
      "bright",
      bounds,
    );
    const v = prepareViewer(w, viewer(10, 30));
    expect(perceivePoint(w, v, 40, 30)).toBe(SEE_BRIGHT);
    expect(perceivePoint(w, v, 60, 30)).toBe(NONE);
  });

  it("blindsight sees in darkness and while Blinded, not through a window (a physical barrier); curtains don't stop it", () => {
    const w = dark([wall(30, 0, 30, 60, "window"), wall(60, 0, 60, 60, "curtain")]);
    const bat = prepareViewer(w, viewer(45, 30, { blindsight: 30 }, { blinded: true }));
    expect(perceivePoint(w, bat, 55, 30)).toBe(BLIND);
    expect(perceivePoint(w, bat, 65, 30)).toBe(BLIND); // through the curtain
    expect(perceivePoint(w, bat, 25, 30)).toBe(NONE); // behind the window
    expect(perceivePoint(w, bat, 80, 30)).toBe(NONE); // out of range
  });

  it("AC-VIS-15: Blinded gives no sight; Unconscious gives nothing at all", () => {
    const w = new VisionWorld(new VisionGeometry([]), [], "bright", bounds);
    expect(perceivePoint(w, prepareViewer(w, viewer(10, 30, {}, { blinded: true })), 20, 30)).toBe(NONE);
    const out = prepareViewer(w, viewer(10, 30, { blindsight: 30, tremorsense: 30 }, { unconscious: true }));
    expect(perceivePoint(w, out, 12, 30)).toBe(NONE);
    expect(perceiveCreature(w, [out], goblin(15, 30))).toBe("none");
  });

  it("magical darkness blocks darkvision and every light; truesight sees through (Daylight doesn't light Darkness — it dispels a lower-level one, an effect of spells, P9)", () => {
    const orb = { kind: "magicalDarkness" as const, poly: square(40, 20, 20), zMin: -1, zMax: 40 };
    const w = new VisionWorld(new VisionGeometry([]), [torch(50, 30)], "dark", bounds, [orb]);
    expect(w.lightLevel(50, 30)).toBe(DARK);
    const dv = prepareViewer(w, viewer(10, 30, { darkvision: 120 }));
    expect(perceivePoint(w, dv, 50, 30)).toBe(NONE);
    expect(perceivePoint(w, dv, 70, 30)).toBe(NONE); // behind the darkness: the sight line crosses it
    const ts = prepareViewer(w, viewer(10, 30, { truesight: 120 }));
    expect(perceivePoint(w, ts, 50, 30)).toBe(DARKVISION);
    const day = new VisionWorld(
      new VisionGeometry([]),
      [torch(50, 30, { magical: true, pierceDarkness: true })],
      "dark",
      bounds,
      [orb],
    );
    // (SRD 5.2.1 Darkness: nonmagical light can't illuminate it; Daylight dispels Darkness of level 3 or lower.
    // Lighting it in place was a mistake the P4 rules audit found: the perception test said NONE regardless.)
    expect(day.lightLevel(50, 30)).toBe(DARK);
    expect(perceivePoint(day, prepareViewer(day, viewer(10, 30)), 50, 30)).toBe(NONE);
  });

  it("heavy obscurement blocks sight into and through it; a viewer inside perceives nothing around (blindsight aside)", () => {
    const fog = { kind: "heavy" as const, poly: square(40, 20, 20), zMin: -1, zMax: 40 };
    const w = new VisionWorld(new VisionGeometry([]), [], "bright", bounds, [fog]);
    const v = prepareViewer(w, viewer(10, 30, { truesight: 120 }));
    expect(perceivePoint(w, v, 50, 30)).toBe(NONE);
    expect(perceivePoint(w, v, 80, 30)).toBe(NONE);
    expect(perceivePoint(w, v, 30, 10)).toBe(SEE_BRIGHT);
    const inside = prepareViewer(w, viewer(50, 30, { blindsight: 10 }));
    expect(perceivePoint(w, inside, 30, 30)).toBe(NONE);
    expect(perceivePoint(w, inside, 55, 30)).toBe(BLIND);
    const haze = new VisionWorld(new VisionGeometry([]), [], "bright", bounds, [{ ...fog, kind: "light" }]);
    expect(perceivePoint(haze, prepareViewer(haze, viewer(10, 30)), 50, 30)).toBe(SEE_BRIGHT);
  });
});

describe("rules audit, P4 (SRD 5.2.1)", () => {
  it("blindsight reaches its full range below the table's level too (a creature in a pit, underwater)", () => {
    const w = new VisionWorld(new VisionGeometry([]), [], "dark", bounds);
    const v = prepareViewer(w, viewer(10, 30, { blindsight: 30 }, { elevation: -10 }));
    expect(perceivePoint(w, v, 35, 30, -10)).toBe(BLIND);
    expect(perceivePoint(w, v, 45, 30, -10)).toBe(NONE);
  });

  it("tremorsense: both on the same surface — a flying or raised viewer feels nothing; one on a balcony feels those beside it", () => {
    const w = new VisionWorld(new VisionGeometry([wall(20, 0, 20, 60)]), [], "dark", bounds);
    const up = prepareViewer(w, viewer(10, 30, { tremorsense: 60 }, { elevation: 20, flying: true }));
    expect(perceiveCreature(w, [up], goblin(30, 30))).toBe("none");
    const balcony = prepareViewer(w, viewer(10, 30, { tremorsense: 60 }, { elevation: 10 }));
    expect(perceiveCreature(w, [balcony], goblin(30, 30))).toBe("none");
    expect(perceiveCreature(w, [balcony], goblin(30, 30, { elevation: 10 }))).toBe("sensed");
  });

  it("inside fog a viewer still sees its own space (AC-VIS-07), nothing beyond it; in magical darkness not even that", () => {
    const fog = { kind: "heavy" as const, poly: square(40, 20, 20), zMin: -1, zMax: 40 };
    const w = new VisionWorld(new VisionGeometry([]), [], "bright", bounds, [fog]);
    const v = prepareViewer(w, viewer(50, 30, {}, { sizeFt: 5 }));
    expect(perceivePoint(w, v, 51.5, 30)).toBe(SEE_BRIGHT);
    expect(perceivePoint(w, v, 54, 30)).toBe(NONE);
    const dark = new VisionWorld(new VisionGeometry([]), [], "bright", bounds, [
      { ...fog, kind: "magicalDarkness" },
    ]);
    expect(perceivePoint(dark, prepareViewer(dark, viewer(50, 30, {}, { sizeFt: 5 })), 51.5, 30)).toBe(NONE);
  });

  it("a sight line passing over a fog bank isn't in it: the heights along the part over its footprint decide", () => {
    const bank = { kind: "heavy" as const, poly: square(40, 20, 20), zMin: 0, zMax: 20 };
    const w = new VisionWorld(new VisionGeometry([]), [], "bright", bounds, [bank]);
    // 100 ft up at x = 10, looking at the ground beyond the bank (x = 80): over x 40–60 the line is 37–62 ft up.
    const high = prepareViewer(w, viewer(10, 30, {}, { elevation: 100 }));
    expect(perceivePoint(w, high, 80, 30)).toBe(SEE_BRIGHT);
    // From the ground it's through the bank.
    expect(perceivePoint(w, prepareViewer(w, viewer(10, 30)), 80, 30)).toBe(NONE);
  });

  it("explored memory never marks ground hidden behind fog (only what the sight line reaches)", () => {
    const bank = { kind: "heavy" as const, poly: square(40, 20, 20), zMin: -1, zMax: 20 };
    const w = new VisionWorld(new VisionGeometry([]), [], "bright", bounds, [bank]);
    const light = new LightRaster(bounds, 1);
    light.build(w);
    const out = Raster.over(bounds, 1);
    markSeen(w, light, [prepareViewer(w, viewer(10, 30))], out);
    expect(out.at(30, 30)).toBe(1); // in front
    expect(out.at(50, 30)).toBe(0); // inside
    expect(out.at(80, 30)).toBe(0); // behind
    expect(out.at(80, 5)).toBe(1); // round it
  });

  it("light radii are spheres round the source: a torch carried 45 ft up lights nothing on the floor; its ground circles shrink with height", () => {
    const high = new VisionWorld(new VisionGeometry([]), [torch(50, 30, { z: 45 })], "dark", bounds);
    expect(high.lightLevel(50, 30)).toBe(DARK);
    expect(high.lightLevel(50, 30, 45)).toBe(BRIGHT);
    expect(high.lightLevel(50, 30, 25)).toBe(BRIGHT);
    expect(high.lightLevel(50, 30, 10)).toBe(DIM);
    const low = new VisionWorld(new VisionGeometry([]), [torch(50, 30, { z: 12 })], "dark", bounds);
    const g = groundRadii(20, 20, 12);
    expect(g.bright).toBeCloseTo(16, 9);
    expect(g.bright + g.dim).toBeCloseTo(Math.sqrt(40 * 40 - 12 * 12), 9);
    expect(low.lightLevel(50 + 15.9, 30)).toBe(BRIGHT);
    expect(low.lightLevel(50 + 16.1, 30)).toBe(DIM);
    expect(low.lightLevel(50 + g.bright + g.dim + 0.1, 30)).toBe(DARK);
    expect(groundRadii(20, 20, 0)).toEqual({ bright: 20, dim: 20 });
    expect(groundRadii(20, 20, 45)).toEqual({ bright: 0, dim: 0 });
  });

  it("solid effect walls (Wall of Force) stop blindsight but not sight", () => {
    const force = [{ a: { x: 30, y: 0 }, b: { x: 30, y: 60 } }];
    const geo = new VisionGeometry([], [], force);
    const w = new VisionWorld(geo, [], "bright", bounds);
    const v = prepareViewer(w, viewer(20, 30, { blindsight: 30 }));
    expect(perceivePoint(w, v, 40, 30)).toBe(SEE_BRIGHT); // seen through it
    const blind = prepareViewer(w, viewer(20, 30, { blindsight: 30 }, { blinded: true }));
    expect(perceivePoint(w, blind, 25, 30)).toBe(BLIND);
    expect(perceivePoint(w, blind, 40, 30)).toBe(NONE); // blindsight stops at it
  });

  it("a light's area is round to the last hair: every point within its radius is lit, however its polygon is cut", () => {
    const w = new VisionWorld(new VisionGeometry([]), [torch(50, 30)], "dark", bounds);
    let unlit = 0;
    for (let k = 0; k < 720; k++) {
      const a = (k / 720) * 2 * Math.PI;
      if (w.lightLevel(50 + Math.cos(a) * 39.97, 30 + Math.sin(a) * 39.97) !== DIM) unlit++;
    }
    expect(unlit).toBe(0);
    expect(w.lightLevel(50 + 40.05, 30)).toBe(DARK);
  });
});

describe("perceive a creature (§15.4)", () => {
  it("AC-VIS-05: in a dark room the darkvision viewer sees the goblin; the one without sees nothing", () => {
    const room = [wall(0, 0, 40, 0), wall(40, 0, 40, 40), wall(40, 40, 0, 40), wall(0, 40, 0, 0)];
    const w = new VisionWorld(new VisionGeometry(room), [], "dark", bounds);
    const a = prepareViewer(w, viewer(5, 20, { darkvision: 60 }));
    const b = prepareViewer(w, viewer(5, 25));
    expect(perceiveCreature(w, [a], goblin(30, 20))).toBe("seen");
    expect(perceiveCreature(w, [b], goblin(30, 20))).toBe("none");
    // Any viewer of the player's suffices (shared vision).
    expect(perceiveCreature(w, [b, a], goblin(30, 20))).toBe("seen");
  });

  it("a creature is seen when any of its 9 samples is: its edge round a corner is enough", () => {
    const w = new VisionWorld(new VisionGeometry([wall(20, 0, 20, 30)]), [], "bright", bounds);
    const v = prepareViewer(w, viewer(10, 10));
    // Centre (21, 32): behind the wall's end for the eye; its western sample (19, 32) is in plain view.
    expect(perceiveCreature(w, [v], goblin(21, 32))).toBe("seen");
    expect(perceiveCreature(w, [v], goblin(30, 10))).toBe("none");
  });

  it("invisible creatures: only blindsight, truesight in range, See Invisibility, or outlined", () => {
    const w = new VisionWorld(new VisionGeometry([]), [], "bright", bounds);
    const ghost = goblin(30, 30, { invisible: true });
    expect(perceiveCreature(w, [prepareViewer(w, viewer(10, 30))], ghost)).toBe("none");
    expect(perceiveCreature(w, [prepareViewer(w, viewer(10, 30, { truesight: 30 }))], ghost)).toBe("seen");
    expect(perceiveCreature(w, [prepareViewer(w, viewer(10, 30, { truesight: 10 }))], ghost)).toBe("none");
    expect(perceiveCreature(w, [prepareViewer(w, viewer(10, 30, {}, { seeInvisible: true }))], ghost)).toBe(
      "seen",
    );
    expect(perceiveCreature(w, [prepareViewer(w, viewer(10, 30, { blindsight: 30 }))], ghost)).toBe("seen");
    expect(perceiveCreature(w, [prepareViewer(w, viewer(10, 30))], { ...ghost, outlined: true })).toBe(
      "seen",
    );
  });

  it("AC-VIS-09: tremorsense senses grounded creatures in range not otherwise seen — never flying or raised ones", () => {
    const w = new VisionWorld(new VisionGeometry([wall(20, 0, 20, 60)]), [], "dark", bounds);
    const v = prepareViewer(w, viewer(10, 30, { tremorsense: 30 }));
    expect(perceiveCreature(w, [v], goblin(30, 30))).toBe("sensed");
    expect(perceiveCreature(w, [v], goblin(45, 30))).toBe("none");
    expect(perceiveCreature(w, [v], goblin(30, 30, { flying: true }))).toBe("none");
    expect(perceiveCreature(w, [v], goblin(30, 30, { elevation: 10 }))).toBe("none");
    // Blinded: tremorsense still works.
    const blinded = prepareViewer(w, viewer(10, 30, { tremorsense: 30 }, { blinded: true }));
    expect(perceiveCreature(w, [blinded], goblin(30, 30))).toBe("sensed");
  });

  it("ranges are 3D: a creature 40 ft up is out of 30-ft darkvision", () => {
    const w = new VisionWorld(new VisionGeometry([]), [], "dark", bounds);
    const v = prepareViewer(w, viewer(10, 30, { darkvision: 30 }));
    expect(perceiveCreature(w, [v], goblin(20, 30))).toBe("seen");
    expect(perceiveCreature(w, [v], goblin(20, 30, { elevation: 40 }))).toBe("none");
  });
});

describe("rasters (§15.5, §15.8)", () => {
  it("a scanline fill of a visibility polygon is exactly its cells (centre test)", () => {
    const geo = new VisionGeometry([wall(30.3, 10, 30.3, 50), wall(50, 0, 70, 30), wall(10, 45.3, 90, 45.3)]);
    const v = geo.losSight(20.2, 30.1, 200);
    const r = Raster.over(bounds, 1);
    const filled = new Uint8Array(r.w * r.h);
    fillVis(r, v, (k) => {
      filled[k] = 1;
    });
    let bad = 0;
    let inside = 0;
    for (let j = 0; j < r.h; j++)
      for (let i = 0; i < r.w; i++) {
        const want = visContains(v, i + 0.5, j + 0.5);
        if (want) inside++;
        if ((filled[j * r.w + i] === 1) !== want) bad++;
      }
    expect(inside).toBeGreaterThan(500);
    expect(bad).toBe(0);
  });

  it("scanline fills are exact for many eyes, clip to a rectangle, stop when asked, and nest", () => {
    const geo = new VisionGeometry([
      wall(30.3, 10, 30.3, 50),
      wall(50, 0, 70, 30),
      wall(10, 45.3, 90, 45.3),
      wall(60.5, 35, 85, 52.2),
    ]);
    const r = Raster.over(bounds, 1);
    let seed = 3;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const bad: string[] = [];
    for (let e = 0; e < 30; e++) {
      const v = geo.losSight(1 + rand() * 98, 1 + rand() * 58, 5 + rand() * 120);
      const clip = {
        x: Math.floor(rand() * 60),
        y: Math.floor(rand() * 40),
        w: 1 + Math.floor(rand() * 40),
        h: 1 + Math.floor(rand() * 20),
      };
      const all = new Uint8Array(r.w * r.h);
      const clipped = new Uint8Array(r.w * r.h);
      fillVis(r, v, (k) => {
        all[k] = 1;
      });
      fillVis(
        r,
        v,
        (k) => {
          clipped[k] = 1;
        },
        clip,
      );
      for (let j = 0; j < r.h; j++)
        for (let i = 0; i < r.w; i++) {
          const k = j * r.w + i;
          const inClip = i >= clip.x && i < clip.x + clip.w && j >= clip.y && j < clip.y + clip.h;
          if ((all[k] === 1) !== visContains(v, i + 0.5, j + 0.5) || clipped[k] !== (inClip ? all[k] : 0))
            if (bad.length < 5) bad.push(`eye ${e} cell ${i},${j}`);
        }
    }
    expect(bad).toEqual([]);
    // Stopping: fn returning true ends the fill at that cell.
    const v = geo.losSight(20, 30, 200);
    let n = 0;
    fillVis(r, v, () => ++n === 7);
    expect(n).toBe(7);
    // Nesting: a fill inside a fill's callback leaves the outer one whole.
    const outer: number[] = [];
    const plain: number[] = [];
    fillVis(r, v, (k) => {
      plain.push(k);
    });
    const inner = geo.losSight(70, 20, 30);
    fillVis(r, v, (k) => {
      outer.push(k);
      if (outer.length % 97 === 0) fillRing(r, visRing(inner), () => {});
    });
    expect(outer).toEqual(plain);
  });

  it("geometry after a wall change keeps the polygons it can't touch — the very same ones — and every polygon equals a fresh computation", () => {
    const walls = [
      wall(20, 0, 20, 17),
      wall(20, 17, 20, 23, "door", "closed"),
      wall(20, 23, 20, 60),
      wall(60, 0, 60, 60),
      wall(70, 10, 90, 10),
    ];
    const before = new VisionGeometry(walls);
    const eyes = [
      [5, 5],
      [10, 40],
      [35, 20],
      [45, 50],
      [75, 30],
      [90, 55],
    ] as const;
    const was = eyes.map(([x, y]) => ({
      s: before.losSight(x, y, 30),
      l: before.lit(x, y, 25),
      b: before.losBlind(x, y, 15),
    }));
    // The door opens.
    const opened = walls.map((w) => (w.kind === "door" ? { ...w, door: "open" as const } : w));
    const after = VisionGeometry.after(before, opened);
    const fresh = new VisionGeometry(opened);
    let kept = 0;
    let redone = 0;
    eyes.forEach(([x, y], i) => {
      const w = was[i] as (typeof was)[number];
      for (const [got, old, want] of [
        [after.losSight(x, y, 30), w.s, fresh.losSight(x, y, 30)],
        [after.lit(x, y, 25), w.l, fresh.lit(x, y, 25)],
        [after.losBlind(x, y, 15), w.b, fresh.losBlind(x, y, 15)],
      ] as const) {
        if (got === old) kept++;
        else redone++;
        const a = [...visRing(got)];
        const b = [...visRing(want)];
        expect(a.length).toBe(b.length);
        for (let k = 0; k < a.length; k++) expect(a[k]).toBeCloseTo(b[k] as number, 9);
      }
    });
    // Eyes far from the door kept theirs; those that saw it (or whose light reached it) were redone.
    expect(kept).toBeGreaterThan(5);
    expect(redone).toBeGreaterThan(5);
  });

  it("run-length encoding round-trips", () => {
    const cells = new Uint8Array(1000);
    for (let k = 0; k < 1000; k++) cells[k] = (k * 7919) % 13 < 5 ? 1 : 0;
    expect(rleDecode(rleEncode(cells), 1000)).toEqual(cells);
    expect(rleEncode(new Uint8Array(5))).toEqual([5]);
    expect(rleEncode(Uint8Array.from([1, 1, 0]))).toEqual([0, 2, 1]);
  });

  it("the light raster refreshed around a moved light equals a full rebuild", () => {
    const geo = new VisionGeometry([wall(40, 0, 40, 40)]);
    const a = new VisionWorld(geo, [torch(20, 30), torch(70, 20)], "dark", bounds);
    const b = new VisionWorld(geo, [torch(25, 35), torch(70, 20)], "dark", bounds);
    const inc = new LightRaster(bounds, 1);
    inc.build(a);
    inc.refresh(b, 20 - 40, 30 - 40, 25 + 40, 35 + 40);
    const full = new LightRaster(bounds, 1);
    full.build(b);
    expect(inc.raster.data).toEqual(full.raster.data);
  });

  it("explored memory marks what's seen — lit or within darkvision, in sight — and says where", () => {
    const geo = new VisionGeometry([wall(40, 0, 40, 60)]);
    const w = new VisionWorld(geo, [torch(20, 30, { bright: 5, dim: 5 })], "dark", bounds);
    const light = new LightRaster(bounds, 1);
    light.build(w);
    const out = Raster.over(bounds, 1);
    const human = prepareViewer(w, viewer(10, 30));
    const rect = markSeen(w, light, [human], out);
    expect(out.at(20, 30)).toBe(1);
    expect(out.at(10, 10)).toBe(0); // dark
    expect(rect !== null && rect.w <= 21 && rect.h <= 21 && rect.w >= 19).toBe(true);
    expect(markSeen(w, light, [human], out)).toBeNull(); // nothing new
    const elf = prepareViewer(w, viewer(10, 30, { darkvision: 25 }));
    markSeen(w, light, [elf], out);
    expect(out.at(10, 10)).toBe(1);
    expect(out.at(45, 30)).toBe(0); // behind the wall
  });
});
