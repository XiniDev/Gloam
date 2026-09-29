import {
  affected,
  type Barrier,
  canPlace,
  footprint,
  placeArea,
  resolveArea,
  wallLength,
  wallMax,
} from "@gloam/shared/aoe";
import { circlePolygon, type P } from "@gloam/shared/geometry";
import { blocksMove, blocksSight } from "@gloam/shared/movement";
import { areaAtSlot, castArea, targetingKind } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import CameraControlsImpl from "camera-controls";
import { useEffect, useMemo, useRef } from "react";
import { DoubleSide, MeshBasicMaterial, Shape, ShapeGeometry } from "three";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { type Targeting, useTargeting } from "../../state/targeting.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { cameraRig } from "../CameraRig.tsx";
import { C } from "../colors.ts";
import { disposeLater } from "../dispose.ts";
import { again } from "../frames.ts";
import { Dots, Segments } from "../tools/marks.tsx";
import { VFX } from "../vfx/palette.ts";

/** A token as an area's creature (its base, its height). */
export const bodyOfView = (t: TokenView) => ({
  pos: t.pos,
  r: t.sizeFt / 2,
  z: t.elevation,
  height: Math.max(t.sizeFt, 2.5),
});

/** The walls this viewer knows as barriers (§17.3 line of effect, §17.5 cover). */
export function barriersOfView(
  walls: Iterable<{ ax: number; ay: number; bx: number; by: number; kind: string; door: string }>,
): Barrier[] {
  const out: Barrier[] = [];
  for (const w of walls) {
    const door = (w.door || null) as "open" | "closed" | "locked" | null;
    out.push({
      a: { x: w.ax, y: w.ay },
      b: { x: w.bx, y: w.by },
      blocksMove: blocksMove(w.kind, door),
      blocksSight: blocksSight(w.kind, door),
    });
  }
  return out;
}

/** What the board shows while a spell is aimed: its area as placed, whether it can go there, and whom it takes. */
export interface Aim {
  shape: ReturnType<typeof placeArea> | null;
  /** The template's outline on the floor. */
  outline: P[][];
  fill: P[] | null;
  ok: boolean;
  why: string | null;
  /** The caster's range, as a ring on the floor (none for Self and Touch-less). */
  ring: P[] | null;
  inside: string[];
  blocked: string[];
}

/**
 * The aim of a targeting (the board's template and the bar's words share it): the area placed from the pointer
 * (placeArea, as the server will), its range and line of effect from the caster (canPlace), and the creatures it takes
 * — only what this viewer knows (its walls, the creatures it sees); the server decides with everything.
 */
export function aimOf(
  t: Targeting,
  tokens: Map<string, TokenView>,
  barriers: Barrier[],
  coverage: "touches" | "centre",
  dm: boolean,
): Aim {
  const caster = tokens.get(t.casterTokenId);
  const none: Aim = {
    shape: null,
    outline: [],
    fill: null,
    ok: false,
    why: null,
    ring: null,
    inside: [],
    blocked: [],
  };
  if (!caster) return { ...none, why: "The caster isn't on the board." };
  const spell = t.spell;
  const self = spell.range.kind === "self";
  const reach =
    spell.range.kind === "touch" ? 5 : spell.range.kind === "ranged" ? (spell.range.ft ?? null) : null;
  const ring = reach !== null ? circlePolygon(caster.pos, reach + caster.sizeFt / 2, 96, true) : null;
  if (targetingKind(spell) !== "area") return { ...none, ring, ok: true };
  // Where it strikes (Call Lightning's bolt under its cloud), else its area or the alternative form's.
  const base = castArea(spell, t.alt);
  if (!base) return { ...none, ring };
  const area = areaAtSlot(base, spell.level, t.level);
  const at = t.at ?? caster.pos;
  const shape = placeArea(
    area,
    self,
    {
      origin: { x: at.x, y: at.y, z: 0 },
      dirDeg: t.dirDeg,
      ...(area.shape === "wall" && t.points.length >= 2 ? { points: t.points, closed: t.ring } : {}),
    },
    { id: caster.id, pos: caster.pos, sizeFt: caster.sizeFt, elevation: caster.elevation },
  );
  const bodyOf = (id: string) => {
    const x = tokens.get(id);
    return x ? bodyOfView(x) : null;
  };
  const resolved = resolveArea(shape, bodyOf);
  if (!resolved) return { ...none, ring };
  const f = footprint(resolved);
  const outline: P[][] = [];
  let fill: P[] | null = null;
  if (f.kind === "circle") {
    fill = circlePolygon(f.c, f.r, 72, true);
    outline.push(fill);
  } else if (f.kind === "poly") {
    fill = f.points;
    outline.push(f.points);
  } else outline.push(f.closed ? [...f.points, f.points[0] as P] : f.points);
  // Where it can go (§17.3): within range of the caster's base edge, with a clear line; a wall no longer than allowed.
  let ok = true;
  let why: string | null = null;
  const origin =
    shape.kind === "emanation" ? caster.pos : shape.kind === "wall" ? (shape.points[0] as P) : shape.origin;
  if (!self && reach !== null) {
    const r = canPlace(
      bodyOfView(caster),
      origin,
      spell.range.kind === "touch" ? { kind: "touch", reach: 5 } : { kind: "ft", ft: reach },
      barriers,
    );
    if (!r.ok) {
      ok = false;
      why = r.why === "range" ? "Out of range" : "No clear path there";
    }
  }
  if (
    shape.kind === "wall" &&
    t.points.length >= 2 &&
    wallLength(t.points, t.ring) > wallMax(area, t.ring) + 0.5
  ) {
    ok = false;
    why = `At most ${Math.round(wallMax(area, t.ring))} ft of wall`;
  }
  if (!ok && dm) why = `${why} — the DM may cast it anyway`;
  const sourceId = shape.kind === "emanation" ? shape.sourceTokenId : self ? caster.id : null;
  const who = affected(
    resolved,
    [...tokens.values()].map((x) => ({ id: x.id, ...bodyOfView(x) })),
    barriers,
    { coverage, sourceId, includeSource: t.includeSelf },
  );
  return {
    shape,
    outline,
    fill,
    ok,
    why,
    ring,
    inside: who.filter((w) => w.affected).map((w) => w.id),
    blocked: who.filter((w) => !w.affected && w.blocked).map((w) => w.id),
  };
}

const closed = (pts: P[]): { a: P; b: P }[] => pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length] as P }));
const open = (pts: P[]): { a: P; b: P }[] => pts.slice(1).map((b, i) => ({ a: pts[i] as P, b }));

/**
 * The template on the board (SPEC §8.13 Casting flow 2): the area following the pointer (or on its caster), in the
 * spell's colour — ember when it can't go there — the caster's range ring, and a ring round each creature it takes
 * (a dashed one round those a wall cuts off). Creatures picked for a targeted spell are marked the same way.
 */
export function TargetingLayer() {
  const t = useTargeting((s) => s.t);
  const tokens = useEntities((s) => boardData(s).tokens);
  const walls = useEntities((s) => boardData(s).walls);
  const coverage = useTable((s) => s.houseRules.areaCoverage) === "centre" ? "centre" : "touches";
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const barriers = useMemo(() => barriersOfView(walls.values()), [walls]);
  const aim = useMemo(
    () => (t ? aimOf(t, tokens, barriers, coverage, dm) : null),
    [t, tokens, barriers, coverage, dm],
  );
  // Tests: the aim as drawn — where, what it takes, whether it may be cast, the range ring.
  const shown = useRef({ t, aim });
  shown.current = { t, aim };
  useEffect(() => {
    if (!__GLOAM_TEST__) return;
    provideTestHook("targeting", () => {
      const { t: now, aim: a } = shown.current;
      return now
        ? {
            spellId: now.spell.id,
            at: now.at,
            picks: now.picks,
            ok: a?.ok ?? false,
            why: a?.why ?? null,
            inside: a?.inside ?? [],
            blocked: a?.blocked ?? [],
            ring: Boolean(a?.ring),
          }
        : null;
    });
  }, []);
  const color = t ? (aim?.ok ? VFX[t.spell.vfx].glow : C.ember400) : C.bone100;
  const fillMat = useMemo(
    () =>
      new MeshBasicMaterial({
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        depthTest: false,
        side: DoubleSide,
      }),
    [],
  );
  useEffect(() => () => disposeLater(fillMat), [fillMat]);
  fillMat.color.set(color);
  const fillGeo = useMemo(() => {
    if (!aim?.fill || aim.fill.length < 3) return null;
    const s = new Shape(aim.fill.map((p) => ({ x: p.x, y: -p.y }) as never));
    return new ShapeGeometry(s);
  }, [aim?.fill]);
  useEffect(() => () => disposeLater(fillGeo), [fillGeo]);
  // A cone, a line or a cube turns with the wheel while it's aimed: the camera's wheel zoom rests meanwhile.
  const turning =
    t !== null && (aim?.shape?.kind === "cone" || aim?.shape?.kind === "line" || aim?.shape?.kind === "cube");
  useEffect(() => {
    const c = cameraRig.controls;
    if (!c || !turning) return;
    const was = c.mouseButtons.wheel;
    c.mouseButtons.wheel = CameraControlsImpl.ACTION.NONE;
    return () => {
      c.mouseButtons.wheel = was;
    };
  }, [turning]);
  // The board draws on demand: a frame whenever the aim changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a frame per new aim
  useEffect(() => {
    again();
  }, [aim, color]);
  if (!t || !aim) return null;
  const picked = [...new Set(t.picks)];
  const marks = (ids: string[]) => ids.map((id) => tokens.get(id)?.pos).filter((p): p is P => Boolean(p));
  return (
    <group name="targeting">
      {aim.ring ? (
        <Segments segs={closed(aim.ring)} color={C.bone100} width={1.5} opacity={0.55} order={9} dashed />
      ) : null}
      {fillGeo ? (
        <mesh
          geometry={fillGeo}
          material={fillMat}
          rotation-x={-Math.PI / 2}
          position-y={0.07}
          renderOrder={9}
          raycast={() => null}
        />
      ) : null}
      {aim.outline.map((o, i) => (
        <Segments
          key={i}
          segs={aim.shape?.kind === "wall" && !t.ring ? open(o) : closed(o)}
          color={color}
          width={2.5}
          opacity={0.95}
          order={10}
        />
      ))}
      <Dots points={marks(aim.inside)} kind="ring" px={30} color={color} />
      <Dots points={marks(aim.blocked)} kind="ring" px={22} color={C.fog400} />
      <Dots points={marks(picked)} kind="ring" px={30} color={VFX[t.spell.vfx].glow} />
      {t.points.length ? <Dots points={t.points} kind="diamond" px={14} color={C.brass300} /> : null}
    </group>
  );
}
