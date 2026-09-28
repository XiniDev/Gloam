import { type P, pathLength } from "@gloam/shared/geometry";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferGeometry, MeshBasicMaterial, type ShaderMaterial } from "three";
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

/** Colour-blind palette for paths (SPEC §27.2 --path-ok / --path-over). */
const CB = { ok: "#56b4e9", no: "#e69f00" };

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
  return (
    <group name="moves">
      {preview && tokenId && preview.points.length > 1 ? (
        <PathLine tokenId={tokenId} points={preview.points} ok={preview.ok} opacity={0.95} />
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

function PathLine({
  tokenId,
  points,
  ok,
  opacity,
  mover,
}: {
  tokenId: string;
  points: P[];
  ok: boolean;
  opacity: number;
  /** Another viewer's drag: their player colour, for the ghost's ring. */
  mover?: string;
}) {
  const cb = useSettings((s) => s.colorBlind);
  const color = ok ? (cb ? CB.ok : C.verdigris400) : cb ? CB.no : C.ember400;
  const geo = useMemo(() => new BufferGeometry(), []);
  const mat = useMemo(() => createRibbonMaterial(color, C.ink950), [color]);
  const token = useEntities((s) => boardData(s).tokens.get(tokenId));
  const face = useTokenFace(token, token ? ringColorOf(token, cb) : C.brass400);
  const ghostMat = useMemo(
    () => new MeshBasicMaterial({ map: face, transparent: true, opacity: 0.42, depthWrite: false }),
    [face],
  );
  const baseMat = useMemo(
    () => new MeshBasicMaterial({ color: C.ink950, transparent: true, opacity: 0.35, depthWrite: false }),
    [],
  );
  const ringMat = useMemo(
    () =>
      new MeshBasicMaterial({ color: mover || color, transparent: true, opacity: 0.9, depthWrite: false }),
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
      <mesh geometry={geo} material={mat} renderOrder={5} raycast={() => null} />
      {ok ? (
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
