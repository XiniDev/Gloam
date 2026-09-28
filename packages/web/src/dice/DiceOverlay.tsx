import type { DiceSkin, TumbleDie } from "@gloam/shared/dice";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import {
  AgXToneMapping,
  AmbientLight,
  DirectionalLight,
  type Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Scene,
  ShadowMaterial,
  type Texture,
  Vector3,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { audio } from "../audio/engine.ts";
import type { SfxName } from "../audio/recipes.ts";
import { again } from "../board/frames.ts";
import { frameBounds } from "../board/framing.ts";
import type { TierSpec } from "../board/tiers.ts";
import { clearArea, isPhoneNow, useHudInsets } from "../hud/insets.ts";
import { useTable } from "../net/table.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";
import { dieGeometry, type FaceSet, faceAtlas } from "./atlas.ts";
import type { ThrowResult } from "./simulate.ts";
import { POSE, STEP_S } from "./simulate.ts";
import { type DieKind, landedMarker, markerFor, remap, type Solid, solid } from "./solids.ts";
import { type FeedRoll, isMasked, useRolls } from "./state.ts";
import { throwDice } from "./throws.ts";

/**
 * The 3D dice (SPEC §8.9 3D dice, §18.4): each roll this client may see is thrown in a tray over the board — its own
 * scene drawn after the board's (depth cleared), so the dice read at any camera angle. The throw is the physics
 * worker's recording of a deterministic tumble from the roll's seed (every client sees the same one), drawn with each
 * die turned by the symmetry that puts the server's number on top: the dice land on exactly the server's values
 * (masked rolls land showing "?"). Thrown from the bottom edge for your own rolls, the top for everyone else's; the
 * card's total appears as they settle; they fade 2.5 s later. Clacks come from the recorded contacts (loudness and
 * brightness from each impulse, per skin material), a settle tick as each die stops, a flourish for a natural 20 or 1.
 * Reduced motion shows the dice where they come to rest. The first 20 dice are thrown; the rest stay chips on the card.
 */

/** The tray (cm): 1 unit = 1 cm in the dice world (§18.4). */
const TRAY = { w: 30, d: 19 } as const;
const HOLD_MS = 2500;
const FADE_MS = 400;
/** A die that hasn't slept by the last recorded step is eased onto its face over this long (§18.4). */
const REST_TWEEN_MS = 200;
/** Throws waiting behind the one in the air beyond this many are settled at once (their totals show, no dice). */
const MAX_WAITING = 3;
const PHYSICAL_MAX = 20;

interface Throw {
  roll: FeedRoll;
  kinds: DieKind[];
  tumble: Pick<TumbleDie, "kind" | "percentile">[];
  /** The marker each die must show (null: a masked die, any face — they all read "?"). */
  wanted: (number | null)[];
  result: ThrowResult | null;
  meshes: Mesh[];
  materials: Material[];
  /** The symmetry per die (the mesh is drawn at q_body · S). */
  sym: Quaternion[];
  start: number;
  /** When it came to rest (all dice), and the eased rest pose for dice that hadn't slept. */
  settledAt: number | null;
  rest: (Quaternion | null)[];
  contact: number;
  ticked: boolean[];
  lastClack: number[];
  reduced: boolean;
  done: boolean;
}

/** What the dice showed (test hooks): per throw, each die's kind and the face on top when it came to rest. */
export const diceLog: {
  id: string;
  masked: boolean;
  dice: { kind: DieKind; percentile?: "tens" | "units"; shown: number | null }[];
  settled: boolean;
}[] = [];

const envByRenderer = new WeakMap<object, Texture>();

export function DiceOverlay({ tier }: { tier: TierSpec }) {
  // Mounted only while there are dice to show: its render pass (after the board's) exists only then.
  const queued = useRolls((s) => s.queue.length);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (queued > 0) setActive(true);
  }, [queued]);
  useEffect(() => {
    provideTestHook("diceThrows", () => diceLog.slice(-20));
  }, []);
  return active ? <DiceStage tier={tier} onIdle={() => setActive(false)} /> : null;
}

function DiceStage({ tier, onIdle }: { tier: TierSpec; onIdle: () => void }) {
  const gl = useThree((s) => s.gl);
  const composer = Boolean(tier.bloom || tier.ao || tier.smaa);
  const high = tier.name === "ultra" || tier.name === "high";
  const shadows = tier.shadowMap > 0;
  const stage = useMemo(() => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(30, 1, 1, 400);
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(-8, 30, 14);
    key.castShadow = shadows;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = -24;
    sc.right = 24;
    sc.top = 20;
    sc.bottom = -20;
    sc.near = 1;
    sc.far = 80;
    key.shadow.bias = -0.0008;
    scene.add(key, key.target, new AmbientLight(0xffffff, 0.35));
    const floor = new Mesh(
      new PlaneGeometry(TRAY.w + 16, TRAY.d + 16),
      new ShadowMaterial({ opacity: 0.32, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = shadows;
    scene.add(floor);
    return { scene, camera, floor };
  }, [shadows]);
  useEffect(() => {
    // Reflections for metal and gems: a small procedural room, made once per renderer (no files, no network).
    let env = envByRenderer.get(gl);
    if (!env) {
      const pmrem = new PMREMGenerator(gl);
      env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      envByRenderer.set(gl, env);
    }
    stage.scene.environment = env;
  }, [gl, stage]);
  useEffect(
    () => () => {
      stage.floor.geometry.dispose();
      (stage.floor.material as Material).dispose();
    },
    [stage],
  );

  const throws = useMemo<Throw[]>(() => [], []);
  const me = useTable((s) => s.me?.userId ?? "");

  // Take throws off the queue: one in the air at a time; a long backlog settles at once.
  useEffect(() => {
    const pull = () => {
      const s = useRolls.getState();
      while (s.queue.length > MAX_WAITING + (throws.some((t) => !t.done) ? 0 : 1)) {
        const r = useRolls.getState().take();
        if (r) useRolls.getState().settle(r.id);
        else break;
      }
      if (throws.some((t) => !t.done && t.settledAt === null)) return;
      const r = useRolls.getState().take();
      if (r) start(r);
    };
    const start = (roll: FeedRoll) => {
      const tumble = roll.tumble.slice(0, PHYSICAL_MAX);
      const kinds = tumble.map((d) => d.kind as DieKind);
      const masked = isMasked(roll);
      const wanted = tumble.map((d) => {
        if (masked) return null;
        const t = d as TumbleDie;
        return markerFor(solid(t.kind), t.percentile === "tens" ? t.face / 10 : t.face);
      });
      const skin = roll.skin;
      const materials: Material[] = [];
      const meshes = tumble.map((d) => {
        const s = solid(d.kind as DieKind);
        const set: FaceSet = masked ? "masked" : d.percentile === "tens" ? "tens" : "values";
        const m = diceMaterial(s, skin, set, high);
        materials.push(m);
        const mesh = new Mesh(dieGeometry(s), m);
        mesh.castShadow = shadows;
        mesh.visible = false;
        stage.scene.add(mesh);
        return mesh;
      });
      const t: Throw = {
        roll,
        kinds,
        tumble,
        wanted,
        result: null,
        meshes,
        materials,
        sym: [],
        start: 0,
        settledAt: null,
        rest: kinds.map(() => null),
        contact: 0,
        ticked: kinds.map(() => false),
        lastClack: kinds.map(() => Number.NEGATIVE_INFINITY),
        reduced: prefersReducedMotion(),
        done: false,
      };
      throws.push(t);
      const seed = isMasked(roll) ? hashId(roll.id) : roll.seed;
      throwDice({ dice: kinds, seed, tray: TRAY, from: roll.userId === me ? "near" : "far" })
        .then((res) => {
          t.result = res;
          t.sym = kinds.map((k, i) => {
            const w = wanted[i];
            return w === null || w === undefined
              ? new Quaternion()
              : remap(solid(k), res.landed[i] as number, w);
          });
          t.start = performance.now();
          again();
        })
        .catch(() => {
          // No physics (the worker failed to load): the card's total shows without dice.
          finish(t, performance.now());
          t.done = true;
        });
    };
    pull();
    return useRolls.subscribe(pull);
  }, [throws, stage, high, shadows, me]);

  const up = useMemo(() => new Vector3(0, 1, 0), []);
  const qa = useMemo(() => new Quaternion(), []);
  const qb = useMemo(() => new Quaternion(), []);
  const ndc = useMemo(() => new Vector3(), []);

  useFrame(
    (state) => {
      const now = performance.now();
      const W = state.size.width;
      const H = state.size.height;
      // The tray framed in the part of the screen the HUD leaves clear, seen from the thrower's side.
      const cam = stage.camera;
      const f = frameBounds({
        bounds: { minX: -TRAY.w / 2, maxX: TRAY.w / 2, minY: -TRAY.d / 2, maxY: TRAY.d / 2 },
        width: W,
        height: H,
        fovDeg: 30,
        pitchDeg: 62,
        visible: clearArea(useHudInsets.getState(), W, H, isPhoneNow()),
        margin: 8,
      });
      cam.aspect = W / Math.max(1, H);
      cam.position.set(...f.position);
      cam.lookAt(...f.target);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();

      let live = false;
      for (const t of throws) {
        if (t.done) continue;
        live = true;
        const res = t.result;
        if (!res) continue;
        const n = t.kinds.length;
        const stepF = t.reduced ? res.steps : Math.min(res.steps, (now - t.start) / (STEP_S * 1000));
        const k = Math.floor(stepF);
        const u = stepF - k;
        const k1 = Math.min(res.steps, k + 1);
        for (let i = 0; i < n; i++) {
          const mesh = t.meshes[i] as Mesh;
          mesh.visible = true;
          const o = (k * n + i) * POSE;
          const o1 = (k1 * n + i) * POSE;
          const fr = res.frames;
          mesh.position.set(
            lerp(fr[o] as number, fr[o1] as number, u),
            lerp(fr[o + 1] as number, fr[o1 + 1] as number, u),
            lerp(fr[o + 2] as number, fr[o1 + 2] as number, u),
          );
          qa.set(fr[o + 3] as number, fr[o + 4] as number, fr[o + 5] as number, fr[o + 6] as number);
          qb.set(fr[o1 + 3] as number, fr[o1 + 4] as number, fr[o1 + 5] as number, fr[o1 + 6] as number);
          qa.slerp(qb, u);
          // Past the last step without sleeping: eased onto the face that's up (§18.4).
          if (k >= res.steps && !res.settled) {
            let rest = t.rest[i];
            if (!rest) {
              const s = solid(t.kinds[i] as DieKind);
              const m = landedMarkerDir(s, qa);
              rest = new Quaternion().setFromUnitVectors(m, up).multiply(qa);
              t.rest[i] = rest;
            }
            const e = Math.min(1, (now - t.start - res.steps * STEP_S * 1000) / REST_TWEEN_MS);
            qa.slerp(rest, t.reduced ? 1 : e);
          }
          mesh.quaternion.copy(qa).multiply(t.sym[i] as Quaternion);
          // Its settle tick, once, as it stops.
          if (!t.ticked[i] && k >= (res.restStep[i] ?? res.steps)) {
            t.ticked[i] = true;
            if (!t.reduced) play("diceSettle", { pan: panOf(mesh.position) });
          }
        }
        // Clacks from the recorded contacts, as playback reaches them.
        if (!t.reduced)
          while (t.contact < res.contacts.length && (res.contacts[t.contact] as { step: number }).step <= k) {
            const c = res.contacts[t.contact++] as ThrowResult["contacts"][number];
            const v = impulseLevel(c.force, res.masses[c.die] ?? 1);
            const mesh = t.meshes[c.die];
            const at = c.step * STEP_S * 1000;
            // Resting dice report force every step: a new clack needs a real hit and 25 ms since the last.
            if (v < 0.05 || at - (t.lastClack[c.die] as number) < 25 || !mesh) continue;
            t.lastClack[c.die] = at;
            play(clackName(t.roll.skin.material, c.other), {
              gain: v ** 1.5,
              rate: (0.85 + 0.3 * v) * (0.97 + Math.random() * 0.06),
              pan: panOf(mesh.position),
            });
          }
        const restMs = res.steps * STEP_S * 1000 + (res.settled ? 0 : REST_TWEEN_MS);
        if (t.settledAt === null && (t.reduced || now - t.start >= restMs)) finish(t, now);
        // Held, then faded out.
        if (t.settledAt !== null) {
          const since = now - t.settledAt;
          const a = since <= HOLD_MS ? 1 : Math.max(0, 1 - (since - HOLD_MS) / FADE_MS);
          for (const m of t.materials) {
            m.transparent = a < 1;
            m.opacity = a;
          }
          if (a <= 0) {
            for (const mesh of t.meshes) stage.scene.remove(mesh);
            for (const m of t.materials) m.dispose();
            t.done = true;
          }
        }
      }
      if (live) again();
      else if (throws.length && useRolls.getState().queue.length === 0) {
        throws.length = 0;
        onIdle();
        return;
      }

      // Drawn after the board (its composer, or the renderer's own pass), over it, tone-mapped like it.
      if (!composer) {
        state.gl.autoClear = true;
        state.gl.render(state.scene, state.camera);
      }
      const gl = state.gl;
      const tm = gl.toneMapping;
      const auto = gl.autoClear;
      gl.toneMapping = AgXToneMapping;
      gl.autoClear = false;
      gl.clearDepth();
      gl.render(stage.scene, cam);
      gl.toneMapping = tm;
      gl.autoClear = auto;

      function panOf(p: Vector3): number {
        ndc.copy(p).project(cam);
        return Math.max(-1, Math.min(1, ndc.x));
      }
    },
    composer ? 2 : 1,
  );
  return null;
}

/** A throw at rest: its card shows the total, the flourish sounds, the log records what each die showed. */
function finish(t: Throw, now: number) {
  t.settledAt = now;
  useRolls.getState().settle(t.roll.id);
  const masked = isMasked(t.roll);
  if (!masked && !t.reduced) {
    const nat = (t.roll as { natural?: number }).natural;
    if (nat === 20) play("nat20", {});
    else if (nat === 1) play("nat1", {});
  }
  diceLog.push({
    id: t.roll.id,
    masked,
    dice: t.kinds.map((k, i) => {
      const mesh = t.meshes[i];
      const s = solid(k);
      const pct = t.tumble[i]?.percentile;
      if (!mesh || masked || !t.result) return { kind: k, ...(pct ? { percentile: pct } : {}), shown: null };
      const label = s.labels[landedMarker(s, mesh.quaternion)] as number;
      // As the roll's tumble counts them: a tens die 00–90, a d10 0–9 (0 for 10), the rest their face.
      return { kind: k, ...(pct ? { percentile: pct } : {}), shown: pct === "tens" ? label * 10 : label };
    }),
    settled: true,
  });
  if (diceLog.length > 60) diceLog.splice(0, diceLog.length - 60);
  again();
}

function play(name: SfxName, opts: { gain?: number; rate?: number; pan?: number }): void {
  audio.play(name, opts);
}

/** A contact's loudness 0–1 (research §2.1): its impulse on a log scale from a 10-cm drop's twentieth to the drop. */
function impulseLevel(force: number, mass: number): number {
  const j = force * STEP_S;
  const ref = mass * Math.sqrt(2 * 981 * 10) * 1.3;
  const min = ref / 20;
  if (j <= min) return 0;
  return Math.min(1, Math.log(j / min) / Math.log(ref / min));
}

function clackName(material: DiceSkin["material"], other: "tray" | "die"): SfxName {
  const m = (material[0] as string).toUpperCase() + material.slice(1);
  return `dice${other === "die" ? "Die" : "Tray"}${m}` as SfxName;
}

/** The world direction of the marker most nearly up for a body at q. */
function landedMarkerDir(s: Solid, q: Quaternion): Vector3 {
  return (s.markers[landedMarker(s, q)] as Vector3).clone().applyQuaternion(q);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A masked roll's throw seed from its id (the tumble is for show; the seed says nothing about the values). */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h;
}

const materialCache = new Map<string, Material>();
/** A die's material for a skin (§8.9 Dice skins): cached per die kind, skin and face set; each throw fades a clone. */
function diceMaterial(s: Solid, skin: DiceSkin, set: FaceSet, high: boolean): Material {
  const key = `${s.kind}|${skin.body}|${skin.number}|${skin.material}|${set}|${high ? "h" : "l"}`;
  let base = materialCache.get(key);
  if (!base) {
    const map = faceAtlas(s, skin, set);
    base =
      skin.material === "gemstone" && high
        ? new MeshPhysicalMaterial({
            map,
            roughness: 0.08,
            metalness: 0,
            transmission: 0.55,
            thickness: 1.2,
            ior: 1.54,
            envMapIntensity: 1.1,
          })
        : new MeshStandardMaterial({
            map,
            ...(skin.material === "metal"
              ? { metalness: 0.85, roughness: 0.3 }
              : skin.material === "bone"
                ? { metalness: 0, roughness: 0.72 }
                : skin.material === "obsidian"
                  ? { metalness: 0.05, roughness: 0.14 }
                  : skin.material === "gemstone"
                    ? { metalness: 0.1, roughness: 0.12 }
                    : { metalness: 0, roughness: 0.36 }),
          });
    materialCache.set(key, base);
  }
  return base.clone();
}
