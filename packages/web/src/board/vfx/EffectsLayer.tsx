import { clipOutlineToRect, clipPolygonToRect } from "@gloam/shared/geometry";
import type { EffectView } from "@gloam/shared/state";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { DoubleSide, type Group, Mesh, MeshBasicMaterial, Shape, ShapeGeometry } from "three";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { prefersReducedMotion, useSettings } from "../../state/settings.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { disposeLater } from "../dispose.ts";
import { setAmbient } from "../frames.ts";
import { boundsFromJson } from "../scene.ts";
import { TIERS, useTier } from "../tiers.ts";
import { Segments } from "../tools/marks.tsx";
import { type Preset, VFX } from "./palette.ts";
import { areaLoop, whereOf } from "./presets.ts";
import { disposeTree, tickTree } from "./VfxLayer.tsx";

/** What each lasting effect draws (tests: that every one of them shows). */
const drawn = new Map<string, { name: string; preset: string; parts: number }>();

/**
 * Lasting areas on the board (SPEC §8.13 Persistent effects, §24.5 "Persistent areas"; AC-SPL-08/09): each effect the
 * viewer has — its extent (a faint fill and edge in its colour) and its look: Fog Cloud's layered fog, Darkness's inky
 * sphere, Web's strands, Spirit Guardians' orbiting motes, Moonbeam's pale column, Spike Growth's thorns, Wall of Fire's
 * curtain, Silence's muted dome, a cloud's churning, or its preset's quiet loop. They animate as ambient motion (24
 * frames a second at most; still under reduced motion), within the tier's particle budget.
 */
export function EffectsLayer() {
  const effects = useBoard((d) => d.effects);
  const list = [...effects.values()];
  const still = useSettings(() => prefersReducedMotion());
  useEffect(() => {
    setAmbient("effects", list.length > 0 && !still, 24);
    return () => setAmbient("effects", false);
  }, [list.length, still]);
  useEffect(() => {
    if (__GLOAM_TEST__)
      provideTestHook("effectsDrawn", () => [...drawn.entries()].map(([id, x]) => ({ id, ...x })));
  }, []);
  return (
    <group name="effects">
      {list.map((e) => (
        <EffectLook key={e.id} e={e} still={still} />
      ))}
    </group>
  );
}

function EffectLook({ e, still }: { e: EffectView; still: boolean }) {
  const tokens = useBoard((d) => d.tokens);
  const boundsJson = useBoard((d) => d.scene?.boundsJson);
  const tier = useTier((s) => s.name);
  // The DM sees into a cloud or darkness (their look is thinner): they have to see what's inside.
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const clock = useThree((s) => s.clock);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const shape = useMemo(() => parse<Record<string, unknown>>(e.shapeJson), [e.shapeJson]);
  const props = useMemo(() => parse<Record<string, unknown>>(e.propsJson) ?? {}, [e.propsJson]);
  const preset = (e.vfx in VFX ? e.vfx : "arcane") as Preset;
  const bodyOf = (id: string) => {
    const t = tokens.get(id);
    return t ? { pos: t.pos, r: t.sizeFt / 2, z: t.elevation, height: Math.max(t.sizeFt, 2.5) } : null;
  };
  const where = whereOf(shape, null, bodyOf);
  const key = where ? `${where.c.join(",")}|${where.r}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt when the area moves or its look changes (key)
  const look = useMemo(() => {
    if (!where || !shape) return null;
    const pts = shape.kind === "wall" ? (shape.points as { x: number; y: number }[]) : undefined;
    return areaLoop(
      preset,
      where,
      props,
      e.name,
      String(shape.kind),
      TIERS[tier].particles,
      hashOf(e.id),
      pts,
      {
        ...(typeof shape.height === "number" ? { height: shape.height } : {}),
        solid: shape.opaque === true || props.opaque === true,
        dm,
      },
    );
  }, [key, preset, props, e.name, tier, shape, dm]);
  useEffect(() => {
    if (!look) return;
    let parts = 0;
    look.traverse((o) => {
      if ((o as Mesh).isMesh || (o as { isPoints?: boolean }).isPoints) parts++;
    });
    drawn.set(e.id, { name: e.name, preset, parts });
    return () => {
      drawn.delete(e.id);
      disposeTree(look);
    };
  }, [look, e.id, e.name, preset]);
  // Its extent: a faint fill of the footprint in its colour, and its edge (none for a wall: the curtain is its line) —
  // both cut to the scene, so neither runs onto the table round the map (critic P9 r2 #6: Darkness's body and every
  // dashed edge did).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt when the area moves (key) or the scene resizes
  const fill = useMemo(() => {
    if (!where?.f || where.f.kind === "strip") return null;
    const outline =
      where.f.kind === "circle" ? circleOutline(where.f.c.x, where.f.c.y, where.f.r) : where.f.points;
    const bounds = boundsFromJson(boundsJson);
    const inside = clipPolygonToRect(outline, bounds);
    if (inside.length < 3) return null;
    const s = new Shape(inside.map((p) => ({ x: p.x, y: -p.y }) as never));
    const m = new Mesh(
      new ShapeGeometry(s),
      new MeshBasicMaterial({
        color: VFX[preset].glow,
        transparent: true,
        opacity: props.magicalDarkness ? 0.35 : 0.06,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.065;
    m.renderOrder = 8;
    m.raycast = () => {};
    return { mesh: m, edge: clipOutlineToRect(outline, bounds) };
  }, [key, preset, props.magicalDarkness, boundsJson]);
  useEffect(() => {
    if (!fill) return;
    return () => {
      fill.mesh.geometry.dispose();
      disposeLater(fill.mesh.material as MeshBasicMaterial);
    };
  }, [fill]);
  useFrame(() => {
    if (!look) return;
    tickTree(look as Group, still ? 1 : clock.getElapsedTime(), size.height * dpr);
  });
  if (!where) return null;
  return (
    <group name={`effect:${e.id}`} userData={{ effectId: e.id }}>
      {fill ? <primitive object={fill.mesh} /> : null}
      {fill ? (
        // In its own colour, strong enough to tell one effect's edge from another's (critic P9 r2 #8: nine faint
        // rings read as one off-white).
        <Segments segs={fill.edge} color={VFX[preset].glow} width={2} opacity={0.75} order={8} dashed />
      ) : null}
      {look ? <primitive object={look} /> : null}
    </group>
  );
}

function circleOutline(x: number, y: number, r: number): { x: number; y: number }[] {
  return Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2;
    return { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
  });
}

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
