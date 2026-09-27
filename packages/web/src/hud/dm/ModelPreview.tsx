import { Bounds, Center } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import type { Group } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { C } from "../../board/colors.ts";
import { acquireGlb } from "../../board/resources.ts";

function Turntable({ assetId }: { assetId: string }) {
  const [root, setRoot] = useState<Group | null>(null);
  const spin = useRef<Group>(null);
  useEffect(() => {
    let cancelled = false;
    const h = acquireGlb(assetId);
    h.promise.then(
      (g) => {
        if (!cancelled) setRoot(cloneSkinned(g.scene) as Group);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      h.release();
    };
  }, [assetId]);
  useFrame((_s, dt) => {
    if (spin.current) spin.current.rotation.y += dt * 0.5;
  });
  if (!root) return null;
  return (
    <Bounds fit clip observe margin={1.15}>
      <group ref={spin}>
        <Center>
          <primitive object={root} />
        </Center>
      </group>
    </Bounds>
  );
}

/** A turntable preview of an optimised GLB (the file players would load), for the Approvals inbox (SPEC §8.16). */
export default function ModelPreview({ assetId }: { assetId: string }) {
  return (
    <div className="h-48 w-full overflow-hidden rounded-[var(--radius-control)] border border-line bg-ink-950">
      <Canvas
        camera={{ fov: 35, position: [2.4, 1.6, 3.2] }}
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 1.5]}
      >
        <color attach="background" args={[C.ink950]} />
        <hemisphereLight args={[C.hemiSky, C.hemiGround, 1.1]} />
        <directionalLight position={[3, 5, 4]} intensity={2.2} color={C.keyLight} />
        <Turntable assetId={assetId} />
      </Canvas>
    </div>
  );
}
