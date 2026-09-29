import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import type { Material, Mesh, Object3D, Points, ShaderMaterial } from "three";
import type { SfxName } from "../../audio/recipes.ts";
import { type CastFxMessage, castFx } from "../../net/spells.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { prefersReducedMotion } from "../../state/settings.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { playOnBoard } from "../boardSound.ts";
import { disposeLater } from "../dispose.ts";
import { setAnimating } from "../frames.ts";
import { TIERS, useTier } from "../tiers.ts";
import { PRESETS, type Preset } from "./palette.ts";
import {
  areaBurst,
  atCreature,
  type Piece,
  projectile,
  projectileFlight,
  type V3,
  whereOf,
} from "./presets.ts";

/** The element a preset sounds like where it lands (SPEC §31); arcane has only the cast's whoosh. */
const ELEMENT_SOUND: Record<Preset, SfxName | null> = {
  fire: "fire",
  cold: "cold",
  lightning: "lightning",
  thunder: "thunder",
  acid: "acid",
  poison: "poison",
  necrotic: "necrotic",
  radiant: "radiant",
  force: "force",
  psychic: "psychic",
  healing: "heal",
  arcane: null,
};

/**
 * A cast's sounds (SPEC §31, sound.md §2.5): a whoosh at the caster, then its element where it lands — as each
 * projectile strikes, over an area's centre a beat later, or on each creature it touches — panned and attenuated by
 * where that is on the board.
 */
function castSounds(
  preset: Preset,
  kind: CastFxMessage["kind"],
  from: V3 | null,
  to: V3[],
  area: ReturnType<typeof whereOf>,
): void {
  if (from) playOnBoard("spellCast", { x: from[0], y: from[2], z: from[1] });
  const element = ELEMENT_SOUND[preset];
  if (!element) return;
  if (kind === "projectile" && from)
    for (const t of to)
      playOnBoard(element, { x: t[0], y: t[2], z: t[1] }, { delay: projectileFlight(from, t) });
  else if (kind === "burst" && area) {
    const c = area.c;
    playOnBoard(element, { x: c[0], y: c[2], z: c[1] }, { delay: from ? 0.25 : 0 });
  } else
    for (const t of to.length ? to : from ? [from] : [])
      playOnBoard(element, { x: t[0], y: t[2], z: t[1] }, { delay: from ? 0.2 : 0 });
}

/** A string's 32-bit hash (FNV-1a): a burst's seed. */
function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Diagnostics (tests, the bench): what played, and how much of it there was. */
const played: { preset: Preset; kind: string; parts: number; particles: number; at: number }[] = [];

/** Sets each piece's clock (its own delay taken off) and particle scale; hides what hasn't begun. */
export function tickTree(root: Object3D, t: number, px: number, delay = 0): void {
  const d = delay + ((root.userData.delay as number | undefined) ?? 0);
  root.visible = t >= d;
  const mat = (root as Mesh).material as ShaderMaterial | undefined;
  const u = mat?.uniforms;
  if (u?.uTime) (u.uTime as { value: number }).value = t - d;
  if (u?.uPx) (u.uPx as { value: number }).value = px * 1.37;
  for (const c of root.children) tickTree(c, t, px, d);
}

/** Every geometry and material under a piece, let go (on the next frame: it may still be in this one's lists). */
export function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as Material[];
    for (const x of mats) disposeLater(x);
  });
}

function countParticles(root: Object3D): { parts: number; particles: number } {
  let parts = 0;
  let particles = 0;
  root.traverse((o) => {
    if ((o as Mesh).isMesh || (o as Points).isPoints || (o as { isLineSegments?: boolean }).isLineSegments)
      parts++;
    if ((o as Points).isPoints) particles += (o as Points).geometry.getAttribute("position")?.count ?? 0;
  });
  return { parts, particles };
}

/**
 * A cast's VFX on the board (SPEC §8.13 Casting flow 3, §24.5; AC-SPL-09): as the server sends it — to whoever can see
 * it — a burst over its area, a projectile to each creature it strikes, or its effect on them, in the spell's preset;
 * played once and cleared. Reduced motion: a short, still flash of the area instead (the ring and the decal, no
 * flying particles).
 */
export function VfxLayer() {
  const [live, setLive] = useState<{ id: number; piece: Piece; born: number }[]>([]);
  const scale = useTier((s) => TIERS[s.name].particles);
  const clock = useThree((s) => s.clock);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const add = useMemo(() => {
    let n = 0;
    return (pieces: Piece[]) =>
      setLive((l) => [...l, ...pieces.map((piece) => ({ id: ++n, piece, born: clock.getElapsedTime() }))]);
  }, [clock]);
  useEffect(() => {
    const play = (m: CastFxMessage) => {
      const tokens = boardData(useEntities.getState()).tokens;
      const bodyOf = (id: string) => {
        const t = tokens.get(id);
        return t ? { pos: t.pos, r: t.sizeFt / 2, z: t.elevation, height: Math.max(t.sizeFt, 2.5) } : null;
      };
      const from: V3 | null = m.from ? [m.from.x, m.from.z, m.from.y] : null;
      const to: V3[] = m.to.map((t) => [t.x, t.z, t.y]);
      const still = prefersReducedMotion();
      const s = still ? scale * 0.25 : scale;
      // Seeded by what was cast where: everyone who sees it sees the same shapes.
      const seed = hashOf(
        `${m.preset}|${m.from?.x ?? 0},${m.from?.y ?? 0}|${m.to[0]?.x ?? 0},${m.to[0]?.y ?? 0}`,
      );
      const pieces: Piece[] = [];
      const area = m.kind === "burst" ? whereOf(m.shape, to[0] ?? from, bodyOf) : null;
      if (m.kind === "burst") {
        if (area) pieces.push(areaBurst(m.preset, area, s, seed));
      } else if (m.kind === "projectile" && from) {
        for (const [i, t] of to.entries()) pieces.push(projectile(m.preset, from, t, s, seed + i * 31));
      } else {
        for (const [i, t] of (to.length ? to : from ? [from] : []).entries())
          pieces.push(atCreature(m.preset, t, s, seed + i * 17));
      }
      if (!pieces.length) return;
      castSounds(m.preset, m.kind, from, to, area);
      if (__GLOAM_TEST__)
        for (const p of pieces)
          played.push({ preset: m.preset, kind: m.kind, ...countParticles(p.root), at: performance.now() });
      add(pieces);
    };
    const off = castFx.on(play);
    if (__GLOAM_TEST__) {
      provideTestHook("vfxPlayed", () => played.slice());
      provideTestHook("vfxPresets", () => PRESETS.slice());
      // Plays a preset at a point as a cast would (AC-SPL-09: each of the twelve).
      provideTestHook(
        "playVfx",
        (preset: Preset, x: number, y: number, kind: "burst" | "projectile" | "instant" = "burst") => {
          play({
            castId: null,
            preset,
            from: { x: x - 20, y, z: 0 },
            shape: { kind: "sphere", origin: { x, y, z: 0 }, radius: 15 },
            to: [{ x, y, z: 0 }],
            kind,
          });
          return true;
        },
      );
    }
    return off;
  }, [add, scale]);
  useEffect(() => {
    setAnimating("vfx", live.length > 0);
    return () => setAnimating("vfx", false);
  }, [live.length]);
  useFrame(() => {
    if (!live.length) return;
    const now = clock.getElapsedTime();
    const px = size.height * dpr;
    let done = false;
    for (const b of live) {
      const t = now - b.born;
      tickTree(b.piece.root, t, px);
      if (t > b.piece.life + 0.25) done = true;
    }
    if (done)
      setLive((l) =>
        l.filter((b) => {
          const over = now - b.born > b.piece.life + 0.25;
          if (over) disposeTree(b.piece.root);
          return !over;
        }),
      );
  });
  return (
    <group name="vfx">
      {live.map((b) => (
        <primitive key={b.id} object={b.piece.root} />
      ))}
    </group>
  );
}
