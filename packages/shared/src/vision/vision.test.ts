import { describe, expect, it } from "vitest";
import { visContains } from "../geometry/index.ts";
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
import { fillVis, LightRaster, Raster, rleDecode, rleEncode } from "./raster.ts";
import {
  BRIGHT,
  DARK,
  DIM,
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

  it("magical darkness blocks darkvision and ordinary light; truesight sees through; only a piercing magical light lights it", () => {
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
    expect(day.lightLevel(50, 30)).toBe(BRIGHT);
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
