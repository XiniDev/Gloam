/**
 * A throw of 3D dice (SPEC §18.4): a deterministic Rapier world — the same build and the same seed give every client
 * the same tumble — stepped until every die sleeps, recording each die's pose per step and the contacts (for the
 * clack sounds). Runs in the dice worker (and in Node for tests); nothing here touches the DOM.
 *
 * The world: 1 unit = 1 cm, gravity −981, a floor and four invisible walls round the tray, restitution 0.3, friction
 * 0.6, damping 0.1, a 1/120 s step, at most 1 200 steps (a die still moving then is eased onto its nearest face by
 * the player).
 */
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { Quaternion } from "three";
import { type DieKind, landedMarker, solid } from "./solids.ts";

export const STEP_S = 1 / 120;
export const MAX_STEPS = 1200;
/** Floats per die per recorded step: position (x, y, z) and rotation (x, y, z, w). */
export const POSE = 7;
/** Contact response (§18.4). */
export const RESTITUTION = 0.3;
export const FRICTION = 0.6;

export interface ThrowInput {
  dice: DieKind[];
  /** The roll's seed (uint32): every client derives the same throw from it. */
  seed: number;
  /** The tray on the table (cm): x across, z deep; the floor at y = 0. */
  tray: { w: number; d: number };
  /** Thrown from the near edge (the roller's own roll) or the far one (someone else's). */
  from: "near" | "far";
}

export interface ThrowResult {
  steps: number;
  /** POSE floats per die per step, step-major: frames[(step · n + die) · POSE + k]. */
  frames: Float32Array;
  /** The marker each die came to rest with up (see solids.ts). */
  landed: number[];
  /** Contacts worth a sound: step, die, force magnitude. */
  contacts: { step: number; die: number; force: number }[];
  /** Every die fell asleep within MAX_STEPS. */
  settled: boolean;
}

/** mulberry32: the throw's initial conditions from the roll's seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let ready: Promise<void> | null = null;
/** Loads Rapier's WebAssembly (embedded: no fetch; the CSP needs only 'wasm-unsafe-eval'). */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export async function simulate(input: ThrowInput): Promise<ThrowResult> {
  await initPhysics();
  const r = mulberry32(input.seed);
  const n = input.dice.length;
  const world = new RAPIER.World({ x: 0, y: -981, z: 0 });
  world.timestep = STEP_S;
  // 1 unit = 1 cm: Rapier's tolerances and sleep thresholds scale with it (they assume metres otherwise).
  world.lengthUnit = 100;
  const { w, d } = input.tray;
  // Floor and walls (static cuboids), a little thicker than any die can tunnel through.
  const wall = (hx: number, hy: number, hz: number, x: number, y: number, z: number) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setRestitution(RESTITUTION).setFriction(FRICTION),
      body,
    );
  };
  const T = 5;
  wall(w / 2 + T, T, d / 2 + T, 0, -T, 0);
  wall(T, 40, d / 2 + T, -w / 2 - T, 40, 0);
  wall(T, 40, d / 2 + T, w / 2 + T, 40, 0);
  wall(w / 2 + T, 40, T, 0, 40, -d / 2 - T);
  wall(w / 2 + T, 40, T, 0, 40, d / 2 + T);
  const bodies: RAPIER.RigidBody[] = [];
  const handleToDie = new Map<number, number>();
  const edge = input.from === "near" ? d / 2 - 3 : -d / 2 + 3;
  const toward = input.from === "near" ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const s = solid(input.dice[i] as DieKind);
    // Tossed from the thrower's edge: up and forward in an arc, spinning, landing mid-tray and tumbling on — about
    // 1.1–1.8 s from the throw to rest (measured; §8.9 asks 1.2–2.5 s).
    const x = (r() - 0.5) * Math.min(w * 0.6, 4 + n * 2.2);
    const y = 10 + r() * 4 + (i % 3) * 2;
    const z = edge + (r() - 0.5) * 2;
    const q = new Quaternion(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinvel((r() - 0.5) * 90 - x * 1.5, 220 + r() * 60, toward * (180 + r() * 80))
        .setAngvel({ x: (r() - 0.5) * 160, y: (r() - 0.5) * 160, z: (r() - 0.5) * 160 })
        .setLinearDamping(0.1)
        .setAngularDamping(0.1)
        .setCanSleep(true)
        .setCcdEnabled(true),
    );
    const verts = new Float32Array(s.vertices.flatMap((p) => [p.x, p.y, p.z]));
    const desc = RAPIER.ColliderDesc.convexHull(verts);
    if (!desc) throw new Error(`no hull for a ${s.kind}`);
    desc
      .setRestitution(RESTITUTION)
      .setFriction(FRICTION)
      .setDensity(1.2)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(2000);
    const collider = world.createCollider(desc, body);
    handleToDie.set(collider.handle, i);
    bodies.push(body);
  }
  const queue = new RAPIER.EventQueue(true);
  const frames: number[] = [];
  const contacts: ThrowResult["contacts"] = [];
  let steps = 0;
  let settled = false;
  const record = () => {
    for (const b of bodies) {
      const t = b.translation();
      const q = b.rotation();
      frames.push(t.x, t.y, t.z, q.x, q.y, q.z, q.w);
    }
  };
  record();
  while (steps < MAX_STEPS) {
    world.step(queue);
    steps++;
    record();
    queue.drainContactForceEvents((e) => {
      const die = handleToDie.get(e.collider1()) ?? handleToDie.get(e.collider2());
      if (die !== undefined) contacts.push({ step: steps, die, force: e.totalForceMagnitude() });
    });
    if (bodies.every((b) => b.isSleeping())) {
      settled = true;
      break;
    }
  }
  const landed = bodies.map((b, i) => {
    const q = b.rotation();
    return landedMarker(solid(input.dice[i] as DieKind), new Quaternion(q.x, q.y, q.z, q.w));
  });
  queue.free();
  world.free();
  return { steps, frames: Float32Array.from(frames), landed, contacts, settled };
}
