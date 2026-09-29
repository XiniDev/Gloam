import type { DiceSkin, TumbleDie } from "@gloam/shared/dice";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import {
  AgXToneMapping,
  AmbientLight,
  DirectionalLight,
  type Material,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShadowMaterial,
  Vector3,
} from "three";
import { audio } from "../audio/engine.ts";
import type { SfxName } from "../audio/recipes.ts";
import { again } from "../board/frames.ts";
import { frameBounds, pxPerFoot } from "../board/framing.ts";
import type { TierSpec } from "../board/tiers.ts";
import { bodyRects } from "../board/tokens/declutter.ts";
import {
  clearArea,
  isPhoneNow,
  largestClear,
  type ScreenArea,
  useHudInsets,
  useHudObstacles,
} from "../hud/insets.ts";
import { useTable } from "../net/table.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";
import { dieGeometry, type FaceSet } from "./atlas.ts";
import { contactShadowTexture, diceEnvironment, diceMaterial } from "./materials.ts";
import type { ThrowResult } from "./simulate.ts";
import { POSE, STEP_S, TRAY_MAX, trayFor } from "./simulate.ts";
import { type DieKind, landedMarker, markerFor, remap, type Solid, solid } from "./solids.ts";
import { type FeedRoll, isMasked, useDiceStage, useRolls } from "./state.ts";
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
 * One throw is in the tray at a time: dice at rest fade as the next throw is released (they'd pass through each
 * other, and the view would have to take in both). Each die has a soft contact shadow under it — the only shadow on
 * tiers without shadow maps.
 */

const HOLD_MS = 2500;
/** How long dice rest before fading: HOLD_MS, or longer while a test build photographs them (`diceHold`). */
let holdMs = HOLD_MS;
const FADE_MS = 400;
/** A die that hasn't slept by the last recorded step is eased onto its face over this long (§18.4). */
const REST_TWEEN_MS = 200;
/** Throws waiting behind the one in the air beyond this many are settled at once (their totals show, no dice). */
const MAX_WAITING = 3;
const PHYSICAL_MAX = 20;

interface Throw {
  roll: FeedRoll;
  kinds: DieKind[];
  /** Its tray (the same on every client: sized by the dice). */
  tray: { w: number; d: number };
  tumble: Pick<TumbleDie, "kind" | "percentile">[];
  /** The marker each die must show (null: a masked die, any face — they all read "?"). */
  wanted: (number | null)[];
  result: ThrowResult | null;
  meshes: Mesh[];
  materials: Material[];
  /** Each die's contact shadow. */
  shadows: Mesh[];
  /** The symmetry per die (the mesh is drawn at q_body · S). */
  sym: Quaternion[];
  start: number;
  /** When it came to rest (all dice), and the eased rest pose for dice that hadn't slept. */
  settledAt: number | null;
  /** When it starts to fade: its hold after settling, or sooner when the next throw is released. */
  fadeAt: number | null;
  rest: (Quaternion | null)[];
  contact: number;
  ticked: boolean[];
  lastClack: number[];
  clacks: { step: number; die: number; other: "tray" | "die"; gain: number }[];
  reduced: boolean;
  done: boolean;
  /** The dice camera has taken this throw in (it jumps to a new throw's arc once). */
  framed?: boolean;
  /** Framed clear of the tokens on the board too (decided once per throw: see `clearOfTokens`). */
  avoidTokens?: boolean;
  /** Its tumbling bed (one voice per throw), and when every die had come to rest. */
  rumble?: ReturnType<typeof audio.rumble>;
  quietSince?: number;
}

/** What the dice showed (test hooks): per throw, each die's kind and the face on top when it came to rest. */
export const diceLog: {
  id: string;
  masked: boolean;
  dice: { kind: DieKind; percentile?: "tens" | "units"; shown: number | null }[];
  settled: boolean;
  /** The skin the dice were drawn in. */
  skin: DiceSkin;
  /** Each clack played: its contact's step, the die, what it struck, and the gain from its impulse. */
  clacks: { step: number; die: number; other: "tray" | "die"; gain: number }[];
}[] = [];

export function DiceOverlay({ tier }: { tier: TierSpec }) {
  // Mounted only while there are dice to show: its render pass (after the board's) exists only then.
  const queued = useRolls((s) => s.queue.length);
  const [active, setActive] = useState(false);
  useEffect(() => useDiceStage.setState({ on: active }), [active]);
  useEffect(() => {
    if (queued > 0) setActive(true);
  }, [queued]);
  useEffect(() => {
    provideTestHook("diceThrows", () => diceLog.slice(-20));
    // Test builds: dice rest this long before fading (key-screen shots under software GL can't catch a 2.5-s rest).
    // Test builds: a throw's playback held at this many ms in (a mid-air frame, photographed however slow the page
    // is), then let go from where it stood.
    provideTestHook("diceFreeze", (ms: number | null) => {
      const now = performance.now();
      if (ms === null && freezeMs !== null)
        for (const t of liveThrows) if (t.result && t.settledAt === null) t.start = now - playedMs(t, now);
      freezeMs = ms;
      again();
    });
    provideTestHook("diceHold", (ms: number | null) => {
      holdMs = ms ?? HOLD_MS;
    });
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
    const key = new DirectionalLight(0xffffff, 1.5);
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
    scene.add(key, key.target, new AmbientLight(0xffffff, 0.12));
    const floor = new Mesh(
      new PlaneGeometry(TRAY_MAX.w + 40, TRAY_MAX.d + 40),
      new ShadowMaterial({ opacity: 0.32, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = shadows;
    floor.visible = shadows;
    scene.add(floor);
    const blobGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    return { scene, camera, floor, blobGeometry };
  }, [shadows]);
  // Reflections for metal and glassy skins: the lantern-lit room, made once per renderer.
  const env = useMemo(() => diceEnvironment(gl), [gl]);
  useEffect(
    () => () => {
      stage.floor.geometry.dispose();
      (stage.floor.material as Material).dispose();
      stage.blobGeometry.dispose();
    },
    [stage],
  );

  const throws = useMemo<Throw[]>(() => [], []);
  liveThrows = throws;
  // The HUD moving (a sheet opening over the bottom, the feed growing) re-frames dice already at rest: a frame is asked
  // for, and the camera eases them into the new clear area — they'd otherwise stay put under the new panel.
  useEffect(() => {
    const a = useHudInsets.subscribe(() => again());
    const b = useHudObstacles.subscribe(() => again());
    return () => {
      a();
      b();
    };
  }, []);
  // A new round of dice starts from the tray's framing, not wherever the last ones came to rest.
  useEffect(() => {
    camReady = false;
  }, []);
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
      const tray = trayFor(kinds.length);
      // Dice at rest make way for the new throw.
      const now = performance.now();
      for (const o of throws)
        if (!o.done && o.settledAt !== null) o.fadeAt = Math.min(o.fadeAt ?? Number.POSITIVE_INFINITY, now);
      const masked = isMasked(roll);
      const wanted = tumble.map((d) => {
        if (masked) return null;
        const t = d as TumbleDie;
        return markerFor(solid(t.kind), t.percentile === "tens" ? t.face / 10 : t.face);
      });
      const skin = roll.skin;
      const materials: Material[] = [];
      const shadowsOf: Mesh[] = [];
      const meshes = tumble.map((d) => {
        const s = solid(d.kind as DieKind);
        const set: FaceSet = masked ? "masked" : d.percentile === "tens" ? "tens" : "values";
        const m = diceMaterial(s, skin, set, high, env);
        materials.push(m);
        const mesh = new Mesh(dieGeometry(s), m);
        mesh.castShadow = shadows;
        mesh.visible = false;
        stage.scene.add(mesh);
        const blob = new Mesh(
          stage.blobGeometry,
          new MeshBasicMaterial({
            map: contactShadowTexture(),
            color: 0x000000,
            transparent: true,
            depthWrite: false,
            opacity: 0,
          }),
        );
        blob.visible = false;
        blob.renderOrder = -1;
        stage.scene.add(blob);
        shadowsOf.push(blob);
        return mesh;
      });
      const t: Throw = {
        roll,
        kinds,
        tray,
        tumble,
        wanted,
        result: null,
        meshes,
        materials,
        shadows: shadowsOf,
        sym: [],
        start: 0,
        settledAt: null,
        fadeAt: null,
        rest: kinds.map(() => null),
        contact: 0,
        ticked: kinds.map(() => false),
        lastClack: kinds.map(() => Number.NEGATIVE_INFINITY),
        clacks: [],
        reduced: prefersReducedMotion(),
        done: false,
      };
      throws.push(t);
      const seed = roll.seed ?? hashId(roll.id);
      throwDice({ dice: kinds, seed, tray, from: roll.userId === me ? "near" : "far" })
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
  }, [throws, stage, high, shadows, me, env]);

  // Diagnostics (test builds): the dice camera and where each die is drawn on screen.
  useEffect(() => {
    provideTestHook("diceStage", () => {
      const cam = stage.camera;
      const v = new Vector3();
      const W = gl.domElement.clientWidth;
      const H = gl.domElement.clientHeight;
      const f = 1 / Math.tan(((cam.fov / 2) * Math.PI) / 180);
      return {
        camera: cam.position.toArray(),
        aspect: cam.aspect,
        easing: camEasing,
        throws: throws.map((t) => ({
          id: t.roll.id,
          done: t.done,
          settledAt: t.settledAt,
          tray: t.tray,
          dice: t.meshes.map((m) => {
            v.copy(m.position).project(cam);
            const ndc = [v.x, v.y, v.z];
            // Where it's drawn (CSS px) and how large: its 1.6-cm width seen from the camera's distance.
            const dist = m.position.distanceTo(cam.position);
            return {
              visible: m.visible,
              ndc,
              pos: m.position.toArray(),
              screen: [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H],
              sizePx: (1.6 / dist) * f * (H / 2),
            };
          }),
        })),
      };
    });
  }, [stage, throws, gl]);
  const up = useMemo(() => new Vector3(0, 1, 0), []);
  const qa = useMemo(() => new Quaternion(), []);
  const qb = useMemo(() => new Quaternion(), []);
  const ndc = useMemo(() => new Vector3(), []);

  useFrame(
    (state) => {
      const now = performance.now();
      const W = state.size.width;
      const H = state.size.height;
      const cam = stage.camera;

      let live = false;
      for (const t of throws) {
        if (t.done) continue;
        live = true;
        const res = t.result;
        if (!res) continue;
        const n = t.kinds.length;
        const played = playedMs(t, now);
        const stepF = t.reduced ? res.steps : Math.min(res.steps, played / (STEP_S * 1000));
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
            const e = Math.min(1, (played - res.steps * STEP_S * 1000) / REST_TWEEN_MS);
            qa.slerp(rest, t.reduced ? 1 : e);
          }
          mesh.quaternion.copy(qa).multiply(t.sym[i] as Quaternion);
          // Its contact shadow: under it on the floor, widening and fading as it rises.
          const blob = t.shadows[i] as Mesh;
          const lift = Math.min(1, Math.max(0, (mesh.position.y - 0.8) / 10));
          blob.visible = true;
          // Cast away from the key light (at −8, 30, 14): further off the higher the die.
          const h = mesh.position.y;
          blob.position.set(mesh.position.x + h * 0.27, 0.02, mesh.position.z - h * 0.47);
          blob.scale.setScalar(2.3 + lift * 2.4);
          (blob.material as MeshBasicMaterial).opacity =
            (shadows ? 0.35 : 0.8) * (1 - lift) ** 2 * fade(t, now);
          // Its settle tick, once, as it stops.
          if (!t.ticked[i] && k >= (res.restStep[i] ?? res.steps)) {
            t.ticked[i] = true;
            if (!t.reduced) play("diceSettle", { pan: panOf(mesh.position) });
          }
        }
        // The tumble's friction bed (sound.md §2.1 "rolls/slides"): its level from how fast the dice on the floor spin,
        // from the recorded poses; it stops 150 ms after the last die sleeps.
        if (!t.reduced) {
          if (t.rumble === undefined && k < res.steps)
            t.rumble = audio.rumble(panOf(t.meshes[0]?.position ?? up));
          if (t.rumble) {
            let spin = 0;
            const k0 = Math.max(0, k - 1);
            for (let i = 0; i < n && k > 0 && k <= res.steps; i++) {
              if (t.ticked[i]) continue;
              const fr = res.frames;
              const o0 = (k0 * n + i) * POSE;
              const o1 = (k * n + i) * POSE;
              const restY = fr[(res.steps * n + i) * POSE + 1] as number;
              if ((fr[o1 + 1] as number) > 1.2 * restY) continue;
              const dot = Math.abs(
                (fr[o0 + 3] as number) * (fr[o1 + 3] as number) +
                  (fr[o0 + 4] as number) * (fr[o1 + 4] as number) +
                  (fr[o0 + 5] as number) * (fr[o1 + 5] as number) +
                  (fr[o0 + 6] as number) * (fr[o1 + 6] as number),
              );
              const omega = (2 * Math.acos(Math.min(1, dot))) / STEP_S;
              spin += Math.min(1, omega / 20);
            }
            t.rumble.set(Math.min(1, spin / 2));
            if (t.ticked.every(Boolean)) {
              t.quietSince ??= now;
              if (now - t.quietSince >= 150) {
                t.rumble.stop();
                t.rumble = null;
              }
            }
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
            t.clacks.push({ step: c.step, die: c.die, other: c.other, gain: v ** 1.5 });
            play(clackName(t.roll.skin.material, c.other), {
              gain: v ** 1.5,
              rate: (0.85 + 0.3 * v) * (0.97 + Math.random() * 0.06),
              pan: panOf(mesh.position),
            });
          }
        const restMs = res.steps * STEP_S * 1000 + (res.settled ? 0 : REST_TWEEN_MS);
        if (t.settledAt === null && (t.reduced || played >= restMs)) finish(t, now);
        // Held, then faded out.
        if (t.settledAt !== null) {
          const a = fade(t, now);
          for (const m of t.materials) {
            m.transparent = a < 1;
            m.opacity = a;
          }
          if (a <= 0) {
            for (const mesh of t.meshes) stage.scene.remove(mesh);
            for (const b of t.shadows) {
              stage.scene.remove(b);
              (b.material as Material).dispose();
            }
            for (const m of t.materials) m.dispose();
            t.rumble?.stop();
            t.done = true;
          }
        }
      }
      const easing = frameDice(stage, throws, W, H, now);
      // Frames only while something moves — dice in the air, the camera easing in, a fade; dice at rest hold still
      // without drawing (a laptop's battery, a phone's, the host PC also running the server), until their fade.
      const moving = throws.some((t) => !t.done && (t.settledAt === null || now >= fadeStart(t)));
      if (moving || easing) again();
      else if (live) {
        const fadeAt = Math.min(...throws.filter((t) => !t.done && t.settledAt !== null).map(fadeStart));
        if (Number.isFinite(fadeAt) && !holdTimer) {
          holdTimer = setTimeout(
            () => {
              holdTimer = null;
              again();
            },
            Math.max(0, fadeAt - now),
          );
        }
      } else if (throws.length && useRolls.getState().queue.length === 0) {
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

/** Test builds: playback held at this many ms into each throw (null: playing). */
let freezeMs: number | null = null;
/** The throws on the stage now (the freeze hook lets them go from where they stood). */
let liveThrows: Throw[] = [];

/** How far into its recording a throw has played (ms). */
function playedMs(t: Throw, now: number): number {
  const ms = now - t.start;
  return freezeMs === null ? ms : Math.min(ms, freezeMs);
}

/** When a throw at rest starts to fade (its hold, or sooner when the next throw came). */
function fadeStart(t: Throw): number {
  return Math.min((t.settledAt as number) + holdMs, t.fadeAt ?? Number.POSITIVE_INFINITY);
}
/** A throw's opacity: whole in the air and while held, then fading out. */
function fade(t: Throw, now: number): number {
  if (t.settledAt === null) return 1;
  const since = now - fadeStart(t);
  return since <= 0 ? 1 : Math.max(0, 1 - since / FADE_MS);
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
    skin: t.roll.skin,
    clacks: t.clacks,
  });
  if (diceLog.length > 60) diceLog.splice(0, diceLog.length - 60);
  again();
}

/** The dice camera's pitch (°): steep enough that the numbers on top read square-on, low enough to see solids. */
const DICE_PITCH = 72;
/**
 * Never framed tighter than this: a lone die at rest reads large, not enormous — at most 12 cm across, and on a
 * small screen tight enough that it's drawn at least about 64 px (a phone's clear area is ~320 px across).
 */
const MAX_MIN_FRAME_CM = 12;
const MIN_DIE_PX = 64;
const DIE_CM = 1.6;
/** The smallest a die may be drawn at rest (px): below this its number stops reading on a phone. */
const LEGIBLE_DIE_PX = 48;

/**
 * How large (px) a throw's dice would be drawn at rest if framed inside `visible` — from the recording's last poses,
 * framed as `frameDice` frames them.
 */
function restingDiePx(t: Throw, visible: ScreenArea, W: number, H: number): number {
  const res = t.result;
  if (!res) return Number.POSITIVE_INFINITY;
  const n = t.kinds.length;
  let [x0, x1, z0, z1] = [
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let i = 0; i < n; i++) {
    const o = (res.steps * n + i) * POSE;
    const [x, y, z] = [res.frames[o] as number, res.frames[o + 1] as number, res.frames[o + 2] as number];
    x0 = Math.min(x0, x - DIE_R);
    x1 = Math.max(x1, x + DIE_R);
    z0 = Math.min(z0, z - y * cot - DIE_R);
    z1 = Math.max(z1, z + DIE_R);
  }
  if (!Number.isFinite(x0)) return Number.POSITIVE_INFINITY;
  const margin = isPhoneNow() ? 12 : 24;
  const short = Math.max(
    1,
    Math.min(visible.right - visible.left, visible.bottom - visible.top) - 2 * margin,
  );
  const minFrame = Math.min(MAX_MIN_FRAME_CM, (short / MIN_DIE_PX) * DIE_CM);
  const grow = (a: number, b: number) => {
    const c = (a + b) / 2;
    const h = Math.max(minFrame, b - a) / 2;
    return [c - h, c + h] as const;
  };
  const [minX, maxX] = grow(x0, x1);
  const [minY, maxY] = grow(z0, z1);
  const f = frameBounds({
    bounds: { minX, maxX, minY, maxY },
    width: W,
    height: H,
    fovDeg: 30,
    pitchDeg: DICE_PITCH,
    visible,
    margin,
  });
  return pxPerFoot(f, W, H, 30) * DIE_CM;
}
/** Room kept round each die's centre in the frame (cm): its circumradius (0.8) and a little. */
const DIE_R = 0.95;
/**
 * How far ahead (steps of 1/120 s) the dice camera looks: 0.8 s — a throw's whole rise and fall is framed from the
 * start, and as the dice settle the view closes in on where they rest.
 */
const LOOKAHEAD_STEPS = 96;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
const cot = 1 / Math.tan((DICE_PITCH * Math.PI) / 180);
const camPos = new Vector3();
const camTarget = new Vector3();
let camReady = false;
let camAt = 0;
/** The dice camera is still moving to its framing (test hook: dice are checked where they finally show). */
let camEasing = false;

/**
 * Frames the dice, not the tray: every die's footprint, and where its height carries it on screen (a die up in the
 * air looks like one farther back on the table), in the part of the screen the HUD leaves clear — the whole arc of a
 * throw in view, then easing in on where they came to rest. The camera keeps well above the highest die.
 */
function frameDice(
  stage: { camera: PerspectiveCamera },
  throws: Throw[],
  W: number,
  H: number,
  now: number,
): boolean {
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let z0 = Number.POSITIVE_INFINITY;
  let z1 = Number.NEGATIVE_INFINITY;
  let top = 0;
  let reduced = false;
  // A throw just begun: the view jumps to its arc rather than easing out after dice already rising out of it.
  let fresh = false;
  const take = (x: number, y: number, z: number) => {
    x0 = Math.min(x0, x - DIE_R);
    x1 = Math.max(x1, x + DIE_R);
    z0 = Math.min(z0, z - y * cot - DIE_R);
    z1 = Math.max(z1, z + DIE_R);
    top = Math.max(top, y);
  };
  for (const t of throws) {
    const res = t.result;
    // Dice fading out (the next throw is coming) are no longer framed.
    if (t.done || !res || (t.settledAt !== null && now >= fadeStart(t))) continue;
    reduced ||= t.reduced;
    // Where the dice are, and where they'll be over the next 0.3 s (the recording says): the view is there first.
    const n = t.kinds.length;
    const k = t.reduced ? res.steps : Math.min(res.steps, Math.floor(playedMs(t, now) / (STEP_S * 1000)));
    if (!t.framed) {
      t.framed = true;
      fresh = true;
    }
    for (let s = k; s <= Math.min(res.steps, k + LOOKAHEAD_STEPS); s += 8)
      for (let i = 0; i < n; i++) {
        const o = (s * n + i) * POSE;
        take(res.frames[o] as number, res.frames[o + 1] as number, res.frames[o + 2] as number);
      }
    for (const m of t.meshes) take(m.position.x, m.position.y, m.position.z);
  }
  if (!Number.isFinite(x0)) {
    // Nothing in the air yet: the latest throw's tray.
    const last = throws[throws.length - 1];
    const tray = last?.tray ?? TRAY_MAX;
    x0 = -tray.w / 2;
    x1 = tray.w / 2;
    z0 = -tray.d / 2;
    z1 = tray.d / 2;
  }
  // The screen the HUD leaves clear, and within it the largest part clear of the feed and an open tray for the
  // latest throw's tray (across, and in depth as the pitch foreshortens it) — chosen by the tray, which a throw keeps,
  // not by the dice's momentary spread: an arc in flight and a spread at rest want different parts of the screen, and
  // the view swung across the HUD between them.
  const area = clearArea(useHudInsets.getState(), W, H, isPhoneNow());
  const shape = throws[throws.length - 1]?.tray ?? TRAY_MAX;
  const aspect = shape.w / (shape.d * Math.sin((DICE_PITCH * Math.PI) / 180));
  // Clear of the tokens as well — dice resting on a token read as sitting on it (critic P7 r1) — unless that would
  // leave them much less room than the HUD alone does (a crowded board). Decided once per throw: no jumping mid-roll.
  const hud = Object.values(useHudObstacles.getState().rects);
  const latest = throws[throws.length - 1];
  // Nor when the dice, at rest where the recording puts them, would read smaller than LEGIBLE_DIE_PX in that room: a
  // phone zoomed in on the party has big tokens, and keeping clear of them squeezed the dice under the floor.
  if (latest?.result && latest.avoidTokens === undefined) {
    const fit = (r: typeof area) => Math.min((r.right - r.left) / aspect, r.bottom - r.top);
    const clearOfTokens = largestClear(area, [...hud, ...tokenAreas()], aspect);
    latest.avoidTokens =
      fit(clearOfTokens) >= 0.6 * fit(largestClear(area, hud, aspect)) &&
      restingDiePx(latest, clearOfTokens, W, H) >= LEGIBLE_DIE_PX;
  }
  const visible = largestClear(area, latest?.avoidTokens ? [...hud, ...tokenAreas()] : hud, aspect);
  // A phone keeps less margin round the dice (its screen is the tightest); obstacles already carry their own gap.
  const margin = isPhoneNow() ? 12 : 24;
  const short = Math.max(
    1,
    Math.min(visible.right - visible.left, visible.bottom - visible.top) - 2 * margin,
  );
  const minFrame = Math.min(MAX_MIN_FRAME_CM, (short / MIN_DIE_PX) * DIE_CM);
  const grow = (a: number, b: number) => {
    const c = (a + b) / 2;
    const h = Math.max(minFrame, b - a) / 2;
    return [c - h, c + h] as const;
  };
  const [minX, maxX] = grow(x0, x1);
  const [minY, maxY] = grow(z0, z1);
  const cam = stage.camera;
  const f = frameBounds({
    bounds: { minX, maxX, minY, maxY },
    width: W,
    height: H,
    fovDeg: 30,
    pitchDeg: DICE_PITCH,
    visible,
    margin,
    minDistance: (top + 12) / Math.sin((DICE_PITCH * Math.PI) / 180),
  });
  // Eased in wall-clock time, however slow the frames: a slow machine (software GL, a Low-tier laptop at a few frames
  // a second) sees the same ~1.4 s ease, not a slow-motion one. No cap is needed — 1 − e^(−dt/τ) never passes 1, so a
  // long frame (or a stall in a hidden tab) lands on the target rather than beyond it.
  const dt = camReady ? Math.max(0, now - camAt) : 0;
  camAt = now;
  const k = !camReady || reduced || fresh ? 1 : 1 - Math.exp(-dt / 160);
  if (!camReady) {
    camPos.set(...f.position);
    camTarget.set(...f.target);
    camReady = true;
  } else {
    camPos.lerp(tmpV.set(...f.position), k);
    camTarget.lerp(tmpV.set(...f.target), k);
  }
  const easing = camPos.distanceTo(tmpV.set(...f.position)) > 0.02;
  camEasing = easing;
  cam.aspect = W / Math.max(1, H);
  cam.position.copy(camPos);
  cam.lookAt(camTarget);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return easing;
}
const tmpV = new Vector3();

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

/** The tokens on the board as screen areas (with a little room round them), for the dice to keep off. */
function tokenAreas(): { left: number; top: number; right: number; bottom: number }[] {
  return bodyRects().map(({ r }) => ({ left: r.x0 - 8, top: r.y0 - 8, right: r.x1 + 8, bottom: r.y1 + 8 }));
}
