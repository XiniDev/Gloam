import { CB_COLORS } from "@gloam/shared";
import { type P, pathLength } from "@gloam/shared/geometry";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferGeometry, MeshBasicMaterial, type ShaderMaterial } from "three";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { C, ringColorOf } from "../colors.ts";
import { disposeLater } from "../dispose.ts";
import { setAnimating } from "../frames.ts";
import { cylinder, torus } from "../tokens/geometries.ts";
import { useTokenFace } from "../tokens/hooks.ts";
import { Dots } from "../tools/marks.tsx";
import { useMove } from "./drag.ts";
import { useRemoteMoves } from "./remote.ts";
import { buildRibbon, createRibbonMaterial, difficultPieces } from "./ribbon.ts";
import { clientMoveWorld } from "./world.ts";

/**
 * Movement previews on the floor (SPEC §8.6): the viewer's own planned move and other viewers' drags — each a path
 * ribbon (its colour says within reach or not) and a translucent ghost of the token itself (its face on its base)
 * where it would end up. Another viewer's drag rings its ghost in that player's colour, so the DM can tell whose move
 * is whose; the viewer's own waypoints are marked with brass pins.
 */
export function MoveLayer() {
  const preview = useMove((s) => s.preview);
  const tokenId = useMove((s) => s.tokenId);
  const remote = useRemoteMoves((s) => s.byToken);
  const waypoints = useMove((s) => s.waypoints);
  // In combat past its budget (AC-MOV-01): verdigris to the max-reach point, hatched --path-over beyond it — the ghost where the
  // move would stop (clamped there; with "Overlong moves: reject" where it was aimed, refused), a hollow ring there.
  const split = preview?.reach ? splitAt(preview.points, preview.reach) : null;
  const reject = useTable((s) => s.houseRules.overlongMoves) === "reject";
  const cb = useSettings((s) => s.colorBlind);
  return (
    <group name="moves">
      {preview && tokenId && preview.points.length > 1 && !split ? (
        <PathLine tokenId={tokenId} points={preview.points} ok={preview.ok} opacity={0.95} />
      ) : null}
      {preview && tokenId && split ? (
        <>
          <PathLine tokenId={tokenId} points={split.within} ok ghost={!reject} opacity={0.95} />
          {/* What's past its reach reads over the ghost standing at the limit (critic P8 r1 #2): drawn on top. */}
          <PathLine tokenId={tokenId} points={split.beyond} ok={false} ghost={false} opacity={0.95} onTop />
          <Dots points={[preview.reach as P]} kind="ring" px={22} color={C.bone100} />
          <Dots
            points={[split.beyond[split.beyond.length - 1] as P]}
            kind="cross"
            px={16}
            color={cb ? CB_COLORS.pathOver : C.blood500}
          />
        </>
      ) : null}
      {preview?.oa?.length ? (
        <Dots points={preview.oa.map((m) => m.at)} kind="swords" px={26} color={C.ember400} />
      ) : null}
      {[...remote].map(([id, r]) =>
        id === tokenId || r.points.length < 2 ? null : (
          <PathLine key={id} tokenId={id} points={r.points} ok opacity={0.7} mover={r.color} />
        ),
      )}
      <Dots points={tokenId ? waypoints : NONE} kind="diamond" px={14} color={C.brass300} />
    </group>
  );
}
const NONE: P[] = [];

/** A path cut at a point on it: the part up to it, and the rest from it. */
function splitAt(points: P[], at: P): { within: P[]; beyond: P[] } {
  let best = 1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as P;
    const b = points[i] as P;
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * (b.x - a.x) + (at.y - a.y) * (b.y - a.y)) / len2));
    const d = Math.hypot(a.x + (b.x - a.x) * t - at.x, a.y + (b.y - a.y) * t - at.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { within: [...points.slice(0, best), at], beyond: [at, ...points.slice(best)] };
}

export function PathLine({
  tokenId,
  points,
  ok,
  opacity,
  mover,
  ghost = ok,
  onTop = false,
}: {
  tokenId: string;
  points: P[];
  ok: boolean;
  opacity: number;
  /** Another viewer's drag: their player colour, for the ghost's ring. */
  mover?: string;
  /** The token's ghost at the path's end (where it would stand). */
  ghost?: boolean;
  /** Drawn over everything on the floor (the part of a move past its reach, over the ghost at the limit). */
  onTop?: boolean;
}) {
  const cb = useSettings((s) => s.colorBlind);
  // --path-ok / --path-over (SPEC §27.2), their colour-blind swaps from the same constants; past the budget, hatched.
  const color = ok ? (cb ? CB_COLORS.pathOk : C.verdigris400) : cb ? CB_COLORS.pathOver : C.blood500;
  const geo = useMemo(() => new BufferGeometry(), []);
  const mat = useMemo(() => {
    const m = createRibbonMaterial(color, C.ink950, !ok);
    if (onTop) m.depthTest = false;
    return m;
  }, [color, onTop, ok]);
  const token = useEntities((s) => boardData(s).tokens.get(tokenId));
  const face = useTokenFace(token, token ? ringColorOf(token, cb) : C.brass400);
  const ghostMat = useMemo(
    () => new MeshBasicMaterial({ map: face, transparent: true, opacity: 0.4, depthWrite: false }),
    [face],
  );
  const baseMat = useMemo(
    () => new MeshBasicMaterial({ color: C.ink950, transparent: true, opacity: 0.35, depthWrite: false }),
    [],
  );
  const ringMat = useMemo(
    () =>
      new MeshBasicMaterial({ color: mover || color, transparent: true, opacity: 0.7, depthWrite: false }),
    [mover, color],
  );
  useEffect(() => () => disposeLater(mat, ghostMat, baseMat, ringMat), [mat, ghostMat, baseMat, ringMat]);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => {
    const { pts, hard } = difficultPieces(clientMoveWorld(), points);
    buildRibbon(geo, pts, hard);
    const u = (mat as ShaderMaterial).uniforms as { uLength: { value: number }; uOpacity: { value: number } };
    u.uLength.value = pathLength(pts);
    u.uOpacity.value = ok ? opacity : opacity * 0.6;
  }, [geo, mat, points, ok, opacity]);
  // The dashes flow: keep drawing while a path is shown.
  const key = `ribbon:${tokenId}`;
  useEffect(() => {
    setAnimating(key, true);
    return () => setAnimating(key, false);
  }, [key]);
  useFrame((state) => {
    (mat.uniforms as { uTime: { value: number } }).uTime.value = state.clock.elapsedTime;
  });
  const R = (token?.sizeFt ?? 5) / 2;
  const end = points[points.length - 1] as P;
  return (
    <group>
      <mesh geometry={geo} material={mat} renderOrder={onTop ? 7 : 5} raycast={() => null} />
      {ghost ? (
        <group position={[end.x, 0, end.y]} userData={{ part: "moveGhost", tokenId }}>
          <mesh
            position-y={0.08}
            geometry={cylinder(R * 0.97, R, 0.12)}
            material={baseMat}
            renderOrder={6}
            raycast={() => null}
            dispose={null}
          />
          {/* The token's own face on the ghost's base: this is who ends up here. */}
          <mesh
            position-y={0.145}
            rotation-x={-Math.PI / 2}
            material={ghostMat}
            renderOrder={6}
            raycast={() => null}
          >
            <circleGeometry args={[R * 0.9, 48]} />
          </mesh>
          <mesh
            position-y={0.15}
            rotation-x={Math.PI / 2}
            geometry={torus(R * 0.97, Math.max(0.07, R * 0.06))}
            material={ringMat}
            renderOrder={6}
            raycast={() => null}
            dispose={null}
          />
        </group>
      ) : null}
    </group>
  );
}
