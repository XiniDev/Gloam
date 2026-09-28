import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { CircleGeometry, Color, type Mesh, MeshBasicMaterial, RingGeometry } from "three";
import { create } from "zustand";
import { audio } from "../audio/engine.ts";
import { C } from "./colors.ts";
import { disposeLater } from "./dispose.ts";
import { setAnimating, wake } from "./frames.ts";

/**
 * Pings (SPEC §8.18; AC-FUN-02): an expanding ring in the sender's colour at a spot on the table, seen by everyone,
 * with a soft sonar sound. The DM Spotlight rings brass and larger (and moves opted-in cameras, CameraRig).
 */
export interface Ping {
  id: number;
  x: number;
  y: number;
  color: string;
  spotlight: boolean;
  by: string;
  at: number;
}

export const usePings = create<{ pings: Ping[] }>(() => ({ pings: [] }));
const LIFE_MS = 1600;
let seq = 0;

export function addPing(p: Omit<Ping, "id" | "at">): void {
  const ping: Ping = { ...p, id: ++seq, at: performance.now() };
  usePings.setState({ pings: [...usePings.getState().pings, ping].slice(-12) });
  audio.play("ping");
  wake();
  setTimeout(
    () => usePings.setState({ pings: usePings.getState().pings.filter((x) => x.id !== ping.id) }),
    LIFE_MS,
  );
}

const RING = new RingGeometry(0.85, 1, 64);
/** The ink under each ring, a little wider: the rings hold on any floor or map. */
const UNDER = new RingGeometry(0.8, 1.05, 64);
const PIP = new CircleGeometry(0.45, 32);
const PIP_EDGE = new RingGeometry(0.45, 0.62, 32);

export function PingLayer() {
  const pings = usePings((s) => s.pings);
  useEffect(() => {
    setAnimating("pings", pings.length > 0);
    return () => setAnimating("pings", false);
  }, [pings.length]);
  return (
    <group name="pings">
      {pings.map((p) => (
        <PingRings key={p.id} ping={p} />
      ))}
    </group>
  );
}

function PingRings({ ping }: { ping: Ping }) {
  const color = ping.spotlight ? C.brass300 : ping.color || C.brass300;
  const mats = useMemo(
    () =>
      [0, 1, 2].map(
        () =>
          new MeshBasicMaterial({
            color: new Color(color),
            transparent: true,
            depthWrite: false,
            depthTest: false,
          }),
      ),
    [color],
  );
  const underMats = useMemo(
    () =>
      [0, 1, 2].map(
        () =>
          new MeshBasicMaterial({
            color: new Color(C.ink950),
            transparent: true,
            depthWrite: false,
            depthTest: false,
          }),
      ),
    [],
  );
  const [pip, pipEdge] = useMemo(
    () => [
      new MeshBasicMaterial({
        color: new Color(color),
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
      new MeshBasicMaterial({
        color: new Color(C.ink950),
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    ],
    [color],
  );
  useEffect(() => () => disposeLater(...mats, ...underMats, pip, pipEdge), [mats, underMats, pip, pipEdge]);
  const rings = useRef<(Mesh | null)[]>([]);
  const unders = useRef<(Mesh | null)[]>([]);
  const size = ping.spotlight ? 9 : 6;
  useFrame(() => {
    const t = (performance.now() - ping.at) / LIFE_MS;
    rings.current.forEach((m, i) => {
      if (!m) return;
      // Three rings, 180 ms apart, each growing to full size and fading out.
      const k = Math.min(1, Math.max(0, t * 1.4 - i * 0.16));
      m.scale.setScalar(0.2 + k * size);
      const a = k > 0 && k < 1 ? (1 - k) * 0.95 : 0;
      (m.material as MeshBasicMaterial).opacity = a;
      const u = unders.current[i];
      if (u) {
        u.scale.setScalar(0.2 + k * size);
        (u.material as MeshBasicMaterial).opacity = a * 0.45;
      }
    });
    // The pip marks the exact spot for the ping's whole life, fading only at the end.
    const fade = Math.min(1, Math.max(0, (1 - t) / 0.25));
    pip.opacity = fade;
    pipEdge.opacity = fade * 0.7;
  });
  return (
    <group
      position={[ping.x, 0.1, ping.y]}
      rotation-x={-Math.PI / 2}
      userData={{ part: "ping", by: ping.by }}
    >
      {underMats.map((m, i) => (
        <mesh
          key={`u${i}`}
          ref={(el) => {
            unders.current[i] = el;
          }}
          geometry={UNDER}
          material={m}
          renderOrder={39}
          raycast={() => null}
        />
      ))}
      {mats.map((m, i) => (
        <mesh
          key={i}
          ref={(el) => {
            rings.current[i] = el;
          }}
          geometry={RING}
          material={m}
          renderOrder={40}
          raycast={() => null}
        />
      ))}
      <mesh geometry={PIP_EDGE} material={pipEdge} renderOrder={41} raycast={() => null} />
      <mesh geometry={PIP} material={pip} renderOrder={41} raycast={() => null} />
    </group>
  );
}
