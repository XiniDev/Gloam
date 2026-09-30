import type { EffectView, LightView, TokenView, WallView, ZoneView } from "@gloam/shared/state";
import type { Specimens } from "./state.ts";

/** Specimen ids: never a server id (those are `tok_…`, `wal_…`), so nothing mistakes one for the scene's. */
export const SPECIMEN = "~specimen:";
export const isSpecimen = (id: string): boolean => id.startsWith(SPECIMEN);

/** Specimen tokens drawn as if selected or hovered (their rings' materials). */
export const SPECIMEN_FORCED: Record<string, "selected" | "hovered" | undefined> = {
  [`${SPECIMEN}token:2`]: "selected",
  [`${SPECIMEN}token:3`]: "hovered",
};

type P = { x: number; y: number };

function token(n: number, at: P, over: Partial<TokenView>): TokenView {
  return {
    id: `${SPECIMEN}token:${n}`,
    actorId: "",
    kind: "npc",
    name: `Specimen ${n}`,
    pos: at,
    elevation: 0,
    rotation: 0,
    size: "medium",
    sizeFt: 5,
    mode: "coin",
    assetId: "",
    portraitAssetId: "",
    scale: 1,
    offsetY: 0,
    rotOffset: 0,
    tint: "",
    ringColor: "",
    disposition: "hostile",
    ownerIds: [],
    hpDisplay: "bar",
    hpBand: 3,
    hpFrac: 0.6,
    tempFrac: 0,
    conditions: [],
    markers: [],
    exhaustion: 0,
    concentrating: false,
    prone: false,
    dead: false,
    invisibleFx: false,
    outlined: false,
    lightOn: false,
    reachFt: 5,
    locked: false,
    moveSeq: 0,
    pinnedBars: [],
    customMarkers: [],
    ...over,
  };
}

/**
 * One of everything the scene layers draw, round `c` (the camera's target, under the intro's candle): each token look
 * and state, every kind of wall and door, a light of each kind, a zone, and lasting areas — the looks whose shader
 * programs the warm-up compiles (SPEC §24.7). `me` owns the party specimen (its movement parts are drawn only for
 * its controllers).
 */
export function specimenData(c: P, me: string): Specimens {
  const at = (dx: number, dy: number): P => ({ x: c.x + dx, y: c.y + dy });
  const tokens = [
    token(1, at(-10, -5), {
      disposition: "party",
      ownerIds: me ? [me] : [],
      kind: "character",
      hpDisplay: "exact",
      hp: { hp: 12, hpMax: 20, hpTemp: 3 },
      tempFrac: 0.15,
      conditions: ["poisoned", "frightened"],
      markers: ["bless"],
      exhaustion: 2,
      concentrating: true,
      customMarkers: ["m1|Marked|#C9A45C|star|A specimen marker"],
      pinnedBars: ["hp"],
    }),
    token(2, at(-5, -5), { mode: "standee", dead: true, hpBand: 0, hpFrac: 0 }),
    token(3, at(0, -5), { mode: "standee", size: "large", sizeFt: 10, prone: true, invisibleFx: true }),
    token(4, at(5, -5), {
      mode: "auto",
      disposition: "neutral",
      outlined: true,
      lightOn: true,
      elevation: 10,
    }),
    token(5, at(10, -5), {
      disposition: "friendly",
      locked: true,
      dm: { secretNote: "", dmHidden: true, link: "", overridesJson: "", revealJson: "" },
    }),
    token(6, at(-10, 5), { mode: "standee", disposition: "party", hpDisplay: "descriptor", hpBand: 1 }),
    token(7, at(-5, 5), { size: "tiny", sizeFt: 2.5, hpDisplay: "hidden", hpBand: 255, hpFrac: -1 }),
  ];
  const wall = (n: number, a: P, b: P, over: Partial<WallView> = {}): WallView => ({
    id: `${SPECIMEN}wall:${n}`,
    ax: a.x,
    ay: a.y,
    bx: b.x,
    by: b.y,
    kind: "wall",
    door: "",
    ...over,
  });
  const walls = [
    wall(1, at(-14, 9), at(-4, 9)),
    wall(2, at(-4, 9), at(1, 9), { kind: "door", door: "closed", dmDoor: "closed" }),
    wall(3, at(1, 9), at(6, 9), { kind: "door", door: "open", dmDoor: "open" }),
    wall(4, at(6, 9), at(11, 9), { kind: "door", door: "locked", dmDoor: "locked" }),
    wall(5, at(11, 9), at(16, 9), { kind: "window" }),
    wall(6, at(16, 9), at(16, 14), { kind: "curtain" }),
    wall(7, at(16, 14), at(11, 14), { kind: "invisible" }),
    wall(8, at(11, 14), at(6, 14), { kind: "wall", dmKind: "secret", door: "", dmDoor: "closed" }),
    wall(9, at(6, 14), at(1, 14), { kind: "occluder", dmHidden: true }),
    wall(10, at(-14, 9), at(-14, 14)),
    wall(11, at(-14, 14), at(-9, 16)),
  ];
  const light = (n: number, p: P, over: Partial<LightView> = {}): LightView => ({
    id: `${SPECIMEN}light:${n}`,
    x: p.x,
    y: p.y,
    elevation: 0,
    bright: 10,
    dim: 10,
    color: "#FFB86B",
    intensity: 1,
    anim: "none",
    coneDeg: 360,
    dirDeg: 0,
    magical: false,
    pierceDarkness: false,
    on: true,
    preset: "",
    dmOnly: false,
    shuttered: false,
    label: "",
    ...over,
  });
  const lights = [
    light(1, at(-8, 0), { anim: "flicker", preset: "torch" }),
    light(2, at(8, 0), { coneDeg: 60, dirDeg: 90, magical: true, preset: "bullseye-lantern" }),
    light(3, at(0, 12), { dmOnly: true, on: false }),
  ];
  const zones: ZoneView[] = [
    {
      id: `${SPECIMEN}zone:1`,
      kind: "difficult",
      points: [at(-14, 16), at(-6, 16), at(-6, 22), at(-14, 22)],
      label: "Specimen",
      color: "#6FA8DC",
      shapeJson: "",
    },
  ];
  const effect = (n: number, name: string, vfx: string, shape: unknown, props: unknown = {}): EffectView => ({
    id: `${SPECIMEN}effect:${n}`,
    shapeJson: JSON.stringify(shape),
    propsJson: JSON.stringify(props),
    vfx,
    roundsLeft: 10,
    name,
    controlJson: JSON.stringify({ moveBy: "caster", maxFt: 60 }),
  });
  const effects = [
    effect(
      1,
      "Fog Cloud",
      "poison",
      { kind: "sphere", origin: at(20, -10), radius: 5 },
      { obscurement: "heavy" },
    ),
    effect(2, "Wall of Fire", "fire", {
      kind: "wall",
      points: [at(20, 0), at(26, 4)],
      closed: false,
      height: 10,
      thickness: 1,
    }),
    effect(
      3,
      "Web",
      "arcane",
      { kind: "cube", origin: at(20, 10), dirDeg: 0, size: 5, originOnFace: false },
      {
        difficult: true,
        obscurement: "light",
      },
    ),
  ];
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  return {
    tokens: byId(tokens),
    walls: byId(walls),
    lights: byId(lights),
    zones: byId(zones),
    effects: byId(effects),
    scene: { walls3d: true },
  };
}
