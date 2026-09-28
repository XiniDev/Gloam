import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, type Mesh, MeshBasicMaterial, RingGeometry } from "three";
import { type SensedMark, useEntities } from "../../state/entities.ts";
import { prefersReducedMotion } from "../../state/settings.ts";
import { useViewAs } from "../../state/viewAs.ts";
import { C, col } from "../colors.ts";
import { setAmbient } from "../frames.ts";

/** One pulse every this long (s). */
const PERIOD = 1.8;

const ripple = new RingGeometry(0.8, 1, 48);
const centre = new RingGeometry(0, 0.35, 24);

/**
 * Tremorsense markers (SPEC §8.8, §15.4): a creature felt through the ground, not seen — a soft ripple spreading
 * from where it is (to the nearest foot), nothing more: no name, no looks, no HP. Paced frames, not a spinning loop.
 */
export function SensedLayer() {
  const live = useEntities((s) => s.live.sensed);
  const as = useViewAs((s) => (s.userId ? s.data : null));
  const marks = useMemo(() => (as ? as.sensed : [...live.values()]), [as, live]);
  useEffect(() => {
    setAmbient("sensed", marks.length > 0 && !prefersReducedMotion(), 12);
    return () => setAmbient("sensed", false);
  }, [marks.length]);
  if (!marks.length) return null;
  return (
    <group name="sensed">
      {marks.map((m) => (
        <Marker key={m.id} m={m} />
      ))}
    </group>
  );
}

function Marker({ m }: { m: SensedMark }) {
  const mats = useMemo(
    () => [
      ...[0, 1].map(
        () =>
          new MeshBasicMaterial({
            color: col(C.ice300),
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
            toneMapped: false,
          }),
      ),
      new MeshBasicMaterial({
        color: col(C.ice300),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        toneMapped: false,
      }),
    ],
    [],
  );
  useEffect(
    () => () => {
      for (const x of mats) x.dispose();
    },
    [mats],
  );
  const rings = useRef<(Mesh | null)[]>([]);
  useFrame(({ clock }) => {
    const reduced = prefersReducedMotion();
    for (const k of [0, 1]) {
      const r = rings.current[k];
      if (!r) continue;
      // Two ripples half a period apart, spreading from 0.6 to 2.4 ft and fading.
      const t = reduced ? 0.35 : (((clock.elapsedTime / PERIOD + k * 0.5) % 1) + 1) % 1;
      r.scale.setScalar(0.6 + 1.8 * t);
      (mats[k] as MeshBasicMaterial).opacity = 0.5 * (1 - t);
    }
  });
  return (
    <group position={[m.x, 0.06, m.y]} rotation-x={-Math.PI / 2} userData={{ part: "sensed", id: m.id }}>
      {[0, 1].map((k) => (
        <mesh
          key={k}
          ref={(r) => {
            rings.current[k] = r;
          }}
          geometry={ripple}
          material={mats[k]}
          renderOrder={7}
          raycast={() => null}
        />
      ))}
      <mesh geometry={centre} material={mats[2]} renderOrder={7} raycast={() => null} />
    </group>
  );
}
