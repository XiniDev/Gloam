import { SIZE_MINI_HEIGHT_FT, type Size } from "@gloam/shared";
import { HP_BAND_HIDDEN, HP_BAND_LABELS } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import { Billboard, Html } from "@react-three/drei";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimationMixer,
  type Camera,
  CanvasTexture,
  CircleGeometry,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type ShaderMaterial,
  type SpriteMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
} from "three";
import { audio } from "../../audio/engine.ts";
import { request, useTable } from "../../net/table.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { BoardText } from "../BoardText.tsx";
import { boardApi } from "../boardApi.ts";
import { cameraRig } from "../CameraRig.tsx";
import { C, col, ringColorOf } from "../colors.ts";
import { boardDiag } from "../diag.ts";
import { disposeLater } from "../dispose.ts";
import { CAPS_FONT, NUMBER_FONT } from "../fonts.ts";
import { again, frameDelta, setAnimating } from "../frames.ts";
import { moveAnimAt, moveAnimFade } from "../move/anims.ts";
import { pressToken } from "../move/input.ts";
import { TIERS, useTier } from "../tiers.ts";
import { withFog } from "../vision/fogMaterial.ts";
import { AUTO_COIN_PITCH, approach, crossfadeStep } from "./crossfade.ts";
import { overlayClear, overlayOffset, PRIORITY, registerOverlay, setOverlayBody } from "./declutter.ts";
import { canRaise, heightLabel } from "./elevation.ts";
import { cylinder, plane, torus } from "./geometries.ts";
import { hiddenBadgeTexture, initialsTexture } from "./glyphs.ts";
import { type MiniInstance, useAssetMeta, useAssetTexture, useMini } from "./hooks.ts";
import {
  createGaugeMaterial,
  createHpBarMaterial,
  HpGhost,
  parsePinned,
  setGauge,
  setHpBar,
} from "./hpBar.ts";
import { CHIP_GEOMETRY, createChipMaterial, setChip } from "./plateChip.ts";

/** Pitch above which Auto mode shows the coin (SPEC §8.5, AC-TOK-11) and the crossfade time. */

const BASE_H = 0.14;
const COIN_H = 0.2;
/**
 * A plate leader's pieces, shared by every token: a unit strip along x (scaled to its length and to a few screen
 * pixels across — a GL line is 1 px, too faint to tie a plate to its token), and the dot at its token end.
 */
const LEADER_STRIP = new PlaneGeometry(1, 1).translate(0.5, 0, 0);
const LEADER_DOT = new CircleGeometry(1, 16);
/** A troika text mesh (drei's <Text>): its opacities apply at render, no re-layout. */
type TroikaText = Mesh & {
  fillOpacity: number;
  outlineOpacity: number;
  /** troika's layout, once synced: the text block's [minX, minY, maxX, maxY] in its own units. */
  textRenderInfo?: { blockBounds: [number, number, number, number] } | null;
  /** Pixels outside [minX, minY, maxX, maxY] (its own units) are discarded. */
  clipRect: number[] | null;
  sync(): void;
};

const tmp = new Vector3();
const screenUp = new Vector3();
const screenBack = new Vector3();
const origin = new Vector3();
const corner = new Vector3();
const axis = new Vector3();
const ndc = new Vector3();
const probe = new Vector3();
/** Points sampled around a base or coin rim when finding its top on screen. */
const RIM_SAMPLES = 24;

export interface Viewer {
  userId: string;
  dm: boolean;
}

/** Live HP-bar values per token, read by the test hooks (AC-TOK-05). */
/** Footsteps sound for moves within this distance of the camera's target (SPEC §16.7). */
const FOOTSTEP_RANGE_FT = 60;
const camTarget = new Vector3();
function nearCameraTarget(p: Vector3, ft: number): boolean {
  const c = cameraRig.controls;
  if (!c) return false;
  c.getTarget(camTarget);
  return Math.hypot(p.x - camTarget.x, p.z - camTarget.z) <= ft;
}

/** Tokens move (glide, facing, billboards) before their overlays place themselves (default priority 0). */
const TOKEN_FRAME_PRIORITY = -0.5;

/** How far a prone or dead mini tips over (SPEC §8.5). */
const TIP = (80 * Math.PI) / 180;
const ORIGIN: [number, number, number] = [0, 0, 0];

/** Gap between a token's highest point on screen and its plate's lowest edge, in plate units. */
const PLATE_GAP = 0.2;

/** A token's silhouette on screen (normalised device coordinates). */
interface Silhouette {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Diagnostics (test hooks): each overlay's fade factors this frame. */
export const overlayFade = new Map<string, { far: number; clear: number; target: number; a: number }>();

/** One plane for every token's HP bar (they differ only in their material's uniforms). */
/** The bar is tall enough to carry its numbers (Exact mode) inside it. */
/**
 * Name plate layout, in plate units (≈ 20 px each on screen, never under 18.5): names 13–14 px in Cinzel, HP numbers
 * and descriptor words ≥ 12 px (SPEC §27.3) — numbers in the display face — inside an ink chip (§27.4).
 */
const PLATE_PX = 20;
const PLATE_PX_MIN = 18.5;
const PLATE_PX_MAX = 26;
const NAME_SIZE = 0.7;
const NUM_SIZE = 0.66;
const WORD_SIZE = 0.66;
const BAR_H = 0.74;
const BAR_W = 3.4;
const NAME_GAP = 0.14;
const CHIP_PAD_X = 0.34;
const CHIP_PAD_Y = 0.2;
const CHIP_OPACITY = 0.82;
/**
 * Counters pinned to the token (§8.10 custom blocks, AC-SHEET-03): under the HP bar, each a caps label and its
 * numbers (12 px like the rest) over a thin gauge; at most three, so a plate never becomes a sheet.
 */
const PIN_MAX = 3;
const PIN_TEXT = 0.66;
const PIN_LINE = 0.78;
const PIN_ROW_GAP = 0.16;
const PIN_BAR_H = 0.16;
const PIN_BAR_GAP = 0.06;
const PIN_LABEL_MAX = 18;
/** Between the bar and the temporary HP beside it. */
const TEMP_GAP = 0.18;

export const hpBarState = new Map<
  string,
  { frac: number; temp: number; ghost: number; at: number; ghostStart: number }
>();

type ResolvedMode = "model" | "standee" | "coin" | "auto";

/** How a token appears (SPEC §8.5): the chosen mode, constrained by what its asset can show. */
function resolveMode(t: TokenView, cls: "image" | "model" | null): ResolvedMode {
  if (cls === "model") return t.mode === "coin" || t.mode === "standee" ? t.mode : "model";
  if (cls === "image") return t.mode === "model" ? "auto" : (t.mode as ResolvedMode) || "auto";
  return "coin";
}

/**
 * A token's own material. Graded by the fog and light composite like the floor (a token in dim light looks dim, §15.7
 * step 4) — from one point, its centre (`at`), so a grade boundary never splits a coin; or not at all (`at` null) for
 * the owner/disposition ring, which must read at any light like the plate (AC-TOK-02).
 */
function useTransparentMaterial(make: () => MeshStandardMaterial, deps: unknown[], at: Vector2 | null) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the material's inputs
  const m = useMemo(() => (at ? withFog(make(), "object", { at }) : make()), deps);
  useEffect(() => () => disposeLater(m), [m]);
  return m;
}

/** A token on the table: base, appearance, states and overlay. */
export const TokenObject = memo(function TokenObject({
  token,
  viewer,
  lift = 0,
}: {
  token: TokenView;
  viewer: Viewer;
  /** A hair's lift that orders overlapping bases (TokensLayer). */
  lift?: number;
}) {
  const colorBlind = useSettings((s) => s.colorBlind);
  const selected = useUi((s) => s.selection.includes(token.id));
  const hovered = useUi((s) => s.hover === token.id);
  const tier = useTier((s) => s.name);
  const ring = ringColorOf(token, colorBlind);
  const R = Math.max(0.6, token.sizeFt / 2);
  /** Where the token is graded (its centre on the table): one vector for its life, kept up to date as it glides. */
  const [gradeAt] = useState(() => new Vector2(token.pos.x, token.pos.y));
  const hidden = token.dm?.dmHidden === true; // only DMs ever receive hidden tokens (AC-TOK-08)
  const baseOpacity = hidden ? 0.4 : 1;

  const meta = useAssetMeta(token.assetId || undefined);
  const portrait = useAssetMeta(token.portraitAssetId || undefined);
  const cls = meta ? (meta.cls === "model" ? "model" : meta.cls === "image" ? "image" : null) : null;
  const mode = resolveMode(token, token.assetId ? cls : null);
  const faceMeta = cls === "image" ? meta : portrait?.cls === "image" ? portrait : null;
  const faceTex = useAssetTexture(faceMeta, TIERS[tier].textureCap >= 8192 ? 1024 : 512);
  const size = (token.size || "medium") as Size;
  const mini = useMini(mode === "model" ? meta : null, size);
  // Per-asset overrides (SPEC §8.5): every token using this mini gets them, on top of its own appearance tweaks.
  const ov = meta?.cls === "model" ? meta.overrides : {};
  const miniScale = (mini?.scale ?? 1) * token.scale * (ov.scale ?? 1);
  const miniLift = token.offsetY + (ov.offsetY ?? 0);

  const root = useRef<Group>(null);
  const body = useRef<Group>(null);
  const first = useRef(true);
  const coinW = useRef(mode === "coin" ? 1 : 0);
  const standeeGroup = useRef<Group>(null);
  const coinGroup = useRef<Group>(null);
  const miniGroup = useRef<Group>(null);
  const standeeCard = useRef<Group>(null);
  const selRing = useRef<Mesh>(null);

  // ── materials (per token, so hidden opacity never touches shared ones) ───────────────────────────────
  const baseMat = useTransparentMaterial(
    () => new MeshStandardMaterial({ color: C.baseInk, roughness: 0.42, metalness: 0.15 }),
    [],
    gradeAt,
  );
  const rimMat = useTransparentMaterial(
    () => new MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 }),
    [],
    null,
  );
  const coinFaceMat = useTransparentMaterial(
    () => new MeshStandardMaterial({ roughness: 0.75 }),
    [],
    gradeAt,
  );
  const standeeFront = useTransparentMaterial(
    () => new MeshStandardMaterial({ roughness: 0.85, alphaTest: 0.5 }),
    [],
    gradeAt,
  );
  const standeeBack = useTransparentMaterial(
    () => new MeshStandardMaterial({ color: C.cardboard, roughness: 0.95, alphaTest: 0.5 }),
    [],
    gradeAt,
  );
  // The selection's brass ring (§8.5): unlit and outside tone mapping — a lit, emissive ring came out bone-white.
  const selMat = useMemo(() => new MeshBasicMaterial({ color: C.brass400, toneMapped: false }), []);
  useEffect(() => () => disposeLater(selMat), [selMat]);
  const hoverMat = useTransparentMaterial(
    () => new MeshStandardMaterial({ color: C.hoverRing, emissive: C.hoverRing, emissiveIntensity: 0.35 }),
    [],
    null,
  );

  useEffect(() => {
    rimMat.color.copy(col(ring));
    rimMat.emissive.copy(col(ring));
    rimMat.emissiveIntensity = 0.35;
  }, [ring, rimMat]);

  const face: Texture = faceTex ?? initialsTexture(token.name, ring);
  useEffect(() => {
    coinFaceMat.map = face;
    standeeFront.map = face;
    standeeBack.alphaMap = face;
    coinFaceMat.needsUpdate = true;
    standeeFront.needsUpdate = true;
    standeeBack.needsUpdate = true;
  }, [face, coinFaceMat, standeeFront, standeeBack]);

  // Standee proportions follow the image, within the size category's height.
  const aspect = (() => {
    const s = (faceTex?.userData.size as [number, number] | undefined) ?? [1, 1];
    return s[1] / Math.max(1, s[0]);
  })();
  const standeeW = R * 1.8;
  const standeeH = Math.min(Math.max(standeeW * aspect, R * 1.2), (SIZE_MINI_HEIGHT_FT[size] ?? 5.5) * 1.25);

  // Mini: its shared materials are cloned only while this token needs its own look (hidden / dead).
  useMiniMaterials(mini, hidden ? 0.4 : 1, token.dead);
  const mixer = useMemo(() => {
    if (!mini?.gltf.animations.length) return null;
    const clip = mini.gltf.animations.find((a) => /^idle$/i.test(a.name)) ?? mini.gltf.animations[0];
    const m = new AnimationMixer(mini.root);
    if (clip) m.clipAction(clip).setEffectiveTimeScale(0.8).play();
    return m;
  }, [mini]);
  useEffect(() => () => void mixer?.stopAllAction(), [mixer]);

  const lying = token.prone || token.dead;
  // Lying down: the mini's pose centred on its base, and a flat card no longer than the base is wide.
  const tipped = useMemo(() => {
    if (!mini) return { offset: ORIGIN, height: 0 };
    const b = mini.localBox;
    const c = Math.cos(TIP);
    const s = Math.sin(TIP);
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y]) {
        x0 = Math.min(x0, x * c - y * s);
        x1 = Math.max(x1, x * c - y * s);
        y0 = Math.min(y0, x * s + y * c);
        y1 = Math.max(y1, x * s + y * c);
      }
    return { offset: [-(x0 + x1) / 2, -y0, 0] as [number, number, number], height: y1 - y0 };
  }, [mini]);
  const flatScale = Math.min(1, (R * 1.92) / (BASE_H + standeeH));
  const topY =
    mode === "model" && mini
      ? (lying ? tipped.height : mini.localBox.max.y - mini.localBox.min.y) * miniScale + miniLift
      : mode === "coin"
        ? COIN_H
        : lying
          ? BASE_H + 0.06
          : standeeH + BASE_H;

  /**
   * The token's silhouette on screen (normalised device coordinates): its highest point and horizontal extent over
   * its visible parts —
   * the base and coin rims (sampled circles), the standee card's corners and the mini's box corners, each through
   * its real transform (facing the camera or lying flat; facing, overrides, tipped over). Measured after projection,
   * so perspective (a tall token's top reaching toward the camera) is exact. From the last frame's transforms, so a
   * pose change moves the plate a frame later at most.
   */
  const screenTop = (cam: Camera, out: Silhouette): boolean => {
    const rt = root.current;
    if (!rt) return false;
    origin.setFromMatrixPosition(rt.matrixWorld);
    out.top = Number.NEGATIVE_INFINITY;
    out.bottom = Number.POSITIVE_INFINITY;
    out.left = Number.POSITIVE_INFINITY;
    out.right = Number.NEGATIVE_INFINITY;
    const take = (v: Vector3) => {
      v.project(cam);
      if (v.y > out.top) out.top = v.y;
      if (v.y < out.bottom) out.bottom = v.y;
      if (v.x < out.left) out.left = v.x;
      if (v.x > out.right) out.right = v.x;
    };
    const rim = (y: number) => {
      for (let k = 0; k < RIM_SAMPLES; k++) {
        const a = (k / RIM_SAMPLES) * Math.PI * 2;
        take(corner.set(origin.x + Math.cos(a) * R, origin.y + y, origin.z + Math.sin(a) * R));
      }
    };
    if (mode !== "coin") rim(BASE_H);
    if (mode === "coin" || coinGroup.current?.visible) rim(COIN_H);
    const card = standeeCard.current;
    if (standeeGroup.current?.visible && card)
      for (const x of [-standeeW / 2, standeeW / 2])
        for (const y of [BASE_H, BASE_H + standeeH]) take(corner.set(x, y, 0).applyMatrix4(card.matrixWorld));
    const mg = miniGroup.current;
    if (mode === "model" && mini && mg) {
      const b = mini.localBox;
      for (let i = 0; i < 8; i++)
        take(
          corner
            .set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)
            .applyMatrix4(mg.matrixWorld),
        );
    }
    return Number.isFinite(out.top);
  };

  /** The top's height now: in auto mode, the coin's or the standee's, whichever is showing. */
  const topNow = () =>
    mode === "auto" ? (coinW.current > 0.5 ? COIN_H : standeeH + BASE_H) : Math.max(topY, 0.3);

  // Where it first stands (the frames glide it from there): set at mount, so nothing that looks before its first frame
  // (a click's raycast, a probe) finds it at the board's origin.
  const [spawnAt] = useState<[number, number, number]>(() => [token.pos.x, token.elevation, token.pos.y]);

  // ── per frame: glide to position, facing, auto crossfade, billboarding, pulse ─────────────────────────
  useFrame((state) => {
    const dt = frameDelta();
    const g = root.current;
    if (!g) return;
    const target = tmp.set(token.pos.x, token.elevation, token.pos.y);
    // A committed move glides along the path the server accepted (never straight through a wall).
    const anim = moveAnimAt(token.id);
    if (anim) {
      g.position.set(
        anim.pos.x,
        g.position.y + (token.elevation - g.position.y) * (1 - Math.exp(-dt * 12)),
        anim.pos.y,
      );
      if (anim.step && nearCameraTarget(g.position, FOOTSTEP_RANGE_FT)) audio.play("footstep");
    } else if (first.current) {
      g.position.copy(target);
    } else g.position.lerp(target, 1 - Math.exp(-dt * 12));
    gradeAt.set(g.position.x, g.position.z);
    if (body.current) {
      // Facing turns smoothly (150 ms); while a mini walks it faces where it's going (setting Auto-facing, §16.7).
      const walking =
        anim && anim.heading !== null && mode === "model" && useTable.getState().campaignSettings.autoFacing;
      const want = walking
        ? (anim.heading as number) - (token.rotOffset * Math.PI) / 180
        : (-(token.rotation + token.rotOffset) * Math.PI) / 180;
      const cur = body.current.rotation.y;
      const delta = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
      body.current.rotation.y = first.current ? want : cur + delta * (1 - Math.exp(-dt / 0.05));
      if (Math.abs(delta) > 1e-3) again();
    }
    first.current = false;
    // Auto mode: coin above 70° pitch, standee below, crossfading over 200 ms (AC-TOK-11).
    const wantCoin =
      mode === "coin" ? 1 : mode === "auto" ? (cameraRig.pitchDeg() > AUTO_COIN_PITCH ? 1 : 0) : 0;
    coinW.current = crossfadeStep(coinW.current, wantCoin, dt);
    const cw = mode === "auto" ? coinW.current : wantCoin;
    if (coinGroup.current) coinGroup.current.visible = mode !== "model" && cw > 0.001;
    if (standeeGroup.current) {
      standeeGroup.current.visible = mode !== "model" && cw < 0.999;
      // Billboard around the vertical axis only (SPEC §8.5 Standee). Lying flat, the card instead reads upright on
      // screen: its top (local −z) along the camera's screen-up, flattened onto the table.
      // Every card parallel to the screen: its face turned to the camera's backward direction, flattened onto the
      // table (turned toward the camera's position instead, cards off the screen's centre looked skewed).
      const back = screenBack.setFromMatrixColumn(state.camera.matrixWorld, 2);
      let yaw =
        Math.hypot(back.x, back.z) > 0.05
          ? Math.atan2(back.x, back.z)
          : Math.atan2(state.camera.position.x - g.position.x, state.camera.position.z - g.position.z);
      if (lying) {
        const up = screenUp.setFromMatrixColumn(state.camera.matrixWorld, 1);
        yaw = Math.atan2(-up.x, -up.z);
      }
      standeeGroup.current.rotation.y = yaw - (body.current?.rotation.y ?? 0);
    }
    // Seen only partway (§15.6): fading in where it came into view, out where it left it.
    const o = baseOpacity * moveAnimFade(token.id);
    if (root.current) root.current.visible = o > 0.001;
    setOpacity(coinFaceMat, o * cw);
    setOpacity(standeeFront, o * (1 - cw));
    setOpacity(standeeBack, o * (1 - cw));
    setOpacity(baseMat, o);
    setOpacity(rimMat, o);
    boardDiag.tokenModes.set(token.id, {
      at: performance.now(),
      mode,
      coin: mode === "model" ? 0 : cw,
      standee: mode === "model" ? 0 : 1 - cw,
    });
    if (selRing.current) selRing.current.scale.setScalar(1 + 0.035 * Math.sin(state.clock.elapsedTime * 3.2));
    mixer?.update(dt);
    // On-demand rendering: keep drawing while this token is still gliding or crossfading.
    if (
      g.position.distanceToSquared(target) > 1e-6 ||
      (mode === "auto" && Math.abs(coinW.current - wantCoin) > 1e-3)
    )
      again();
  }, TOKEN_FRAME_PRIORITY);
  // The selection pulse and a mini's idle animation run continuously while they're on.
  useEffect(() => {
    setAnimating(`sel:${token.id}`, selected);
    return () => setAnimating(`sel:${token.id}`, false);
  }, [selected, token.id]);
  useEffect(() => {
    setAnimating(`mix:${token.id}`, mixer !== null);
    return () => setAnimating(`mix:${token.id}`, false);
  }, [mixer, token.id]);
  useEffect(() => () => void boardDiag.tokenModes.delete(token.id), [token.id]);

  // ── interaction: select (Shift toggles), radial menu on right-click or long-press ──────────────────────
  const down = useRef<{ x: number; y: number; button: number; timer: number | null } | null>(null);
  const onDown = (e: ThreeEvent<PointerEvent>) => {
    const n = e.nativeEvent;
    // The Pan tool (H): a left press anywhere, tokens included, drags the view.
    if (n.button === 0 && (useUi.getState().tool === "pan" || cameraRig.spaceHeld)) return;
    // The Walls and Zones tools edit what's under the token, and Measure snaps to it: their presses go through.
    const tool = useUi.getState().tool;
    if (n.button === 0 && (tool === "walls" || tool === "zones" || tool === "measure")) return;
    e.stopPropagation();
    boardApi.claimedPointer = n.pointerId;
    down.current = { x: n.clientX, y: n.clientY, button: n.button, timer: null };
    if (n.button === 0) {
      useUi.getState().select([token.id], n.shiftKey ? "toggle" : "replace");
      // Held and dragged, it moves (SPEC §8.6; move/input.ts decides whether this viewer may).
      if (!n.shiftKey && useUi.getState().tool === "select") pressToken(token.id, n);
      // A press on a token isn't a pan.
      const c = cameraRig.controls;
      if (c) {
        c.enabled = false;
        window.addEventListener(
          "pointerup",
          () => {
            c.enabled = true;
          },
          { once: true },
        );
      }
      if (n.pointerType === "touch") {
        down.current.timer = window.setTimeout(() => {
          useUi.getState().set({ radial: { tokenId: token.id, x: n.clientX, y: n.clientY } });
        }, 500);
      }
    }
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const d = down.current;
    if (d?.timer && Math.hypot(e.nativeEvent.clientX - d.x, e.nativeEvent.clientY - d.y) > 8) {
      clearTimeout(d.timer);
      d.timer = null;
    }
  };
  const onUp = () => {
    if (down.current?.timer) clearTimeout(down.current.timer);
  };
  // Alt+wheel over the token raises or lowers it in 5-ft steps (AC-TOK-07; the camera doesn't zoom while Alt is held).
  const wheelAt = useRef(0);
  const onWheel = (e: ThreeEvent<WheelEvent>) => {
    const n = e.nativeEvent;
    if (!n.altKey || !canRaise(token, viewer)) return;
    // (No preventDefault: wheel listeners are passive, and the camera ignores the wheel while Alt is held.)
    e.stopPropagation();
    const now = performance.now();
    if (now - wheelAt.current < 90) return; // one step per wheel notch, not per trackpad tick
    wheelAt.current = now;
    void request("token.elevation", { tokenId: token.id, delta: n.deltaY < 0 ? 5 : -5 }).catch(() => {});
  };
  const onContext = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    e.nativeEvent.preventDefault();
    const d = down.current;
    // A right-drag orbits the camera; only a right-click (no movement) opens the menu.
    if (d && Math.hypot(e.nativeEvent.clientX - d.x, e.nativeEvent.clientY - d.y) > 5) return;
    useUi
      .getState()
      .set({ radial: { tokenId: token.id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY } });
  };

  return (
    <group ref={root} name={`token:${token.id}`} userData={{ tokenId: token.id }} position={spawnAt}>
      <group
        ref={body}
        position-y={lift}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onContextMenu={onContext}
        onWheel={onWheel}
        onPointerOver={(e) => {
          e.stopPropagation();
          useUi.getState().set({ hover: token.id });
        }}
        onPointerOut={() => {
          if (useUi.getState().hover === token.id) useUi.getState().set({ hover: null });
        }}
      >
        {/* Base: the creature's space, ringed in the owner's or the disposition's colour (AC-TOK-02). */}
        {/* Part geometries are shared per size (geometries.ts); dispose={null} keeps unmounts from freeing them. */}
        {mode !== "coin" ? (
          <group userData={{ part: "base", diameter: R * 2 }}>
            <mesh
              position-y={BASE_H / 2}
              material={baseMat}
              geometry={cylinder(R * 0.97, R, BASE_H)}
              castShadow
              receiveShadow
              dispose={null}
            />
            <mesh
              position-y={BASE_H}
              rotation-x={Math.PI / 2}
              material={rimMat}
              geometry={torus(R * 0.97, Math.max(0.05, R * 0.045))}
              userData={{ rim: true }}
              dispose={null}
            />
          </group>
        ) : null}
        {mode === "model" && mini ? (
          <group
            userData={{ part: "mini" }}
            position-y={BASE_H + miniLift}
            rotation-y={((ov.rotationYDeg ?? 0) * Math.PI) / 180}
            scale={miniScale}
          >
            {/* Prone or dead: tipped 80° onto its side, lying centred on its base (not thrown off it). */}
            <group ref={miniGroup} rotation-z={lying ? TIP : 0} position={lying ? tipped.offset : ORIGIN}>
              <primitive object={mini.root} position={mini.offset} dispose={null} />
            </group>
          </group>
        ) : null}
        {mode !== "model" ? (
          <>
            <group ref={coinGroup} userData={{ part: "coin", diameter: R * 2 }}>
              {/* Cylinder cap UVs run u→+z, v→+x; a quarter turn puts image-up toward the table's north. */}
              <mesh
                position-y={COIN_H / 2}
                rotation-y={Math.PI / 2}
                castShadow
                receiveShadow
                material={[rimMat, coinFaceMat, baseMat]}
                geometry={cylinder(R * 0.96, R * 0.98, COIN_H)}
                dispose={null}
              />
              <mesh
                position-y={COIN_H}
                rotation-x={Math.PI / 2}
                material={rimMat}
                geometry={torus(R * 0.96, Math.max(0.05, R * 0.05))}
                userData={{ rim: true }}
                dispose={null}
              />
            </group>
            <group ref={standeeGroup} userData={{ part: "standee" }}>
              {/* Prone or dead: the card lies flat (face up, its top away from the camera), centred on the base and
                  no longer than the base is wide. Nested so the tip happens before the camera-facing turn. */}
              <group
                ref={standeeCard}
                rotation-x={lying ? -Math.PI / 2 : 0}
                position={lying ? [0, BASE_H + 0.05, (BASE_H + standeeH / 2) * flatScale] : ORIGIN}
                scale={lying ? flatScale : 1}
              >
                <mesh
                  position={[0, BASE_H + standeeH / 2, 0.03]}
                  material={standeeFront}
                  geometry={plane(standeeW, standeeH)}
                  castShadow
                  dispose={null}
                />
                <mesh
                  position={[0, BASE_H + standeeH / 2, -0.03]}
                  rotation-y={Math.PI}
                  material={standeeBack}
                  geometry={plane(standeeW, standeeH)}
                  castShadow
                  dispose={null}
                />
              </group>
            </group>
          </>
        ) : null}
        {selected ? (
          <mesh
            ref={selRing}
            position-y={0.03}
            rotation-x={Math.PI / 2}
            material={selMat}
            geometry={torus(R + 0.28, 0.08, 72)}
            dispose={null}
          />
        ) : null}
        {hovered && !selected ? (
          <mesh
            position-y={0.03}
            rotation-x={Math.PI / 2}
            material={hoverMat}
            geometry={torus(R + 0.18, 0.035, 72)}
            dispose={null}
          />
        ) : null}
      </group>
      <Elevation elevation={token.elevation} radius={R} />
      <Overlay
        token={token}
        viewer={viewer}
        top={topNow}
        screenTop={screenTop}
        // A DM-hidden token is faint (40 %); its plate stays readable for the DM.
        opacity={hidden ? Math.max(0.75, baseOpacity) : baseOpacity}
        hidden={hidden}
      />
    </group>
  );
});

function setOpacity(m: Material, o: number) {
  const transparent = o < 0.999;
  if (m.transparent !== transparent) {
    m.transparent = transparent;
    m.depthWrite = !transparent;
    m.needsUpdate = true;
  }
  m.opacity = o;
}

/** Hidden or dead minis get their own material copies (never mutate the shared ones, AC-TOK-10). */
function useMiniMaterials(mini: MiniInstance | null, opacity: number, dead: boolean) {
  const own = opacity < 1 || dead;
  useEffect(() => {
    if (!mini || !own) return;
    const originals = new Map<Mesh, Material | Material[]>();
    const clones: Material[] = [];
    mini.root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      originals.set(m, m.material);
      const copy = (Array.isArray(m.material) ? m.material : [m.material]).map((mat) => {
        const c = withFog(mat.clone(), "object");
        c.transparent = opacity < 1;
        c.opacity = opacity;
        c.depthWrite = opacity >= 1;
        if (dead && "color" in c) (c as MeshStandardMaterial).color.multiplyScalar(0.45);
        clones.push(c);
        return c;
      });
      m.material = Array.isArray(m.material) ? copy : (copy[0] as Material);
    });
    return () => {
      for (const [m, mat] of originals) m.material = mat;
      disposeLater(...clones);
    };
  }, [mini, own, opacity, dead]);
}

/** Flying tokens: a thin stem to a ground ring and an elevation label (SPEC §8.5 flying). */
let shadowTex: CanvasTexture | null = null;
/** A soft ink shadow for a flyer's ground mark: dark at the centre, gone at the rim. */
function groundShadowTexture(): CanvasTexture {
  if (shadowTex) return shadowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(7,9,12,0.5)");
  r.addColorStop(0.7, "rgba(7,9,12,0.28)");
  r.addColorStop(1, "rgba(7,9,12,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  shadowTex = new CanvasTexture(c);
  shadowTex.colorSpace = SRGBColorSpace;
  return shadowTex;
}

/**
 * Flying tokens (SPEC §8.5 flying; AC-TOK-07): a stem down to the ground, where a brass ring over a soft shadow marks
 * the spot it flies over, and the height as a chip beside the ring — screen-sized, so it reads at any zoom.
 */
function Elevation({ elevation, radius }: { elevation: number; radius: number }) {
  const [stemMat, ringMat, shadowMat] = useMemo(
    () => [
      new MeshStandardMaterial({ color: C.brass300, transparent: true, opacity: 0.8, depthWrite: false }),
      new MeshBasicMaterial({ color: C.brass300, transparent: true, opacity: 0.9, depthWrite: false }),
      new MeshBasicMaterial({ map: groundShadowTexture(), transparent: true, depthWrite: false }),
    ],
    [],
  );
  useEffect(() => () => disposeLater(stemMat, ringMat, shadowMat), [stemMat, ringMat, shadowMat]);
  if (Math.abs(elevation) < 0.5) return null;
  const up = elevation > 0;
  return (
    <group>
      {up ? (
        <mesh position-y={-elevation / 2} material={stemMat} userData={{ part: "elevationStem" }}>
          <cylinderGeometry args={[0.06, 0.06, elevation, 8]} />
        </mesh>
      ) : null}
      <mesh
        position-y={-elevation + 0.02}
        rotation-x={-Math.PI / 2}
        material={shadowMat}
        raycast={() => null}
      >
        <circleGeometry args={[radius * 1.15, 48]} />
      </mesh>
      <mesh
        position-y={-elevation + 0.035}
        rotation-x={Math.PI / 2}
        material={ringMat}
        userData={{ part: "elevationRing" }}
        raycast={() => null}
      >
        <torusGeometry args={[radius, 0.1, 8, 64]} />
      </mesh>
      <group position={[radius + 0.4, -elevation + 0.1, 0]} userData={{ part: "elevationLabel" }}>
        <Html center zIndexRange={[18, 0]} style={{ pointerEvents: "none", transform: "translateX(50%)" }}>
          <span
            data-testid="elevation-label"
            className="whitespace-nowrap rounded-chip border border-line bg-ink-950 px-1.5 text-12 font-bold text-brass-bright tabular"
          >
            {heightLabel(elevation)}
          </span>
        </Html>
      </group>
    </group>
  );
}

/**
 * Name plate + HP bar above the token, facing the camera, scaled with zoom within limits and fading out when far
 * (SPEC §8.5 Overlay, §24.4). HP per display mode: Exact → bar and numbers; Bar → bar; Descriptor → a word; Hidden →
 * nothing. Players always see their own tokens exactly; DMs see every bar.
 */
function Overlay({
  token,
  viewer,
  top,
  screenTop,
  opacity,
  hidden,
}: {
  token: TokenView;
  viewer: Viewer;
  /** Height of the token's top now (auto mode: the coin's or the standee's, whichever is showing). */
  top: () => number;
  /** The token's silhouette on screen, in normalised device coordinates (see TokenObject's `screenTop`). */
  screenTop: (cam: Camera, out: Silhouette) => boolean;
  opacity: number;
  hidden: boolean;
}) {
  const colorBlind = useSettings((s) => s.colorBlind);
  const group = useRef<Group>(null);
  const anchor = useRef<Group>(null);
  const nameText = useRef<TroikaText>(null);
  const numText = useRef<TroikaText>(null);
  /** The numbers again in ink, shown only over the bar's fill (the bone ones only over its empty track). */
  const numInk = useRef<TroikaText>(null);
  const tempText = useRef<TroikaText>(null);
  const barWidth = useRef(BAR_W);
  const wordText = useRef<TroikaText>(null);
  const badge = useRef<SpriteMaterial>(null);
  const bar = useMemo(() => createHpBarMaterial(), []);
  useEffect(() => () => disposeLater(bar), [bar]);
  const ghost = useRef(new HpGhost());
  // The leader: a 2-px brass stroke on a dark halo (it reads on stone, wood and water alike; a bone one read as a
  // scratch on the map) ending in a dot on the token — shared unit strip and disc, placed per token.
  const leader = useMemo(() => {
    const group = new Group();
    group.name = "plateLeader";
    group.visible = false;
    // Not part of the plate's extent (declutter.ts).
    group.userData.overlayDecor = true;
    const haloMat = new MeshBasicMaterial({
      color: C.ink950,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
    });
    const strokeMat = new MeshBasicMaterial({ color: C.brass400, transparent: true, depthTest: false });
    const halo = new Mesh(LEADER_STRIP, haloMat);
    const line = new Mesh(LEADER_STRIP, strokeMat);
    const dotHalo = new Mesh(LEADER_DOT, haloMat);
    const dot = new Mesh(LEADER_DOT, strokeMat);
    for (const o of [halo, dotHalo, line, dot]) {
      o.renderOrder = 18;
      o.raycast = () => {};
      group.add(o);
    }
    return { group, halo, line, dotHalo, dot, haloMat, strokeMat };
  }, []);
  useEffect(() => () => disposeLater(leader.haloMat, leader.strokeMat), [leader]);
  const controls = token.ownerIds.includes(viewer.userId) || viewer.dm;
  const nums = token.hp;
  const frac = nums ? nums.hp / Math.max(1, nums.hpMax) : token.hpFrac;
  const temp = nums ? nums.hpTemp / Math.max(1, nums.hpMax) : token.tempFrac;
  const showBar =
    frac >= 0 && (token.hpDisplay !== "descriptor" || controls) && (token.hpDisplay !== "hidden" || controls);
  const showNumbers = Boolean(nums) && (token.hpDisplay === "exact" || controls);
  const descriptor =
    !showBar && token.hpDisplay === "descriptor" && token.hpBand !== HP_BAND_HIDDEN
      ? (HP_BAND_LABELS[token.hpBand as 0 | 1 | 2 | 3 | 4] ?? null)
      : null;
  const pinKey = JSON.stringify(token.pinnedBars.slice(0, PIN_MAX));
  const pins = useMemo(
    () =>
      (JSON.parse(pinKey) as string[]).map((s) => {
        const p = parsePinned(s);
        return {
          ...p,
          label: p.label.length > PIN_LABEL_MAX ? `${p.label.slice(0, PIN_LABEL_MAX - 1)}…` : p.label,
        };
      }),
    [pinKey],
  );
  const pinMats = useMemo(() => Array.from({ length: PIN_MAX }, createGaugeMaterial), []);
  useEffect(() => () => disposeLater(...pinMats), [pinMats]);
  const pinRows = useRef<{ label: TroikaText | null; value: TroikaText | null; bar: Mesh | null }[]>([]);
  const pinRow = (i: number) => {
    let r = pinRows.current[i];
    if (!r) {
      r = { label: null, value: null, bar: null };
      pinRows.current[i] = r;
    }
    return r;
  };

  // Decluttering: this overlay competes for its spot on screen with its neighbours' (declutter.ts).
  const latest = useRef({ token, viewer });
  latest.current = { token, viewer };
  const clear = useRef(1);
  useEffect(() => {
    const g = group.current;
    if (!g) return;
    return registerOverlay(token.id, g, () => {
      const { token: t, viewer: v } = latest.current;
      const ui = useUi.getState();
      if (ui.hover === t.id) return PRIORITY.hovered;
      if (ui.selection.includes(t.id)) return PRIORITY.selected;
      if (t.ownerIds.includes(v.userId)) return PRIORITY.own;
      return t.disposition === "party" ? PRIORITY.party : PRIORITY.other;
    });
  }, [token.id]);

  const chip = useMemo(() => createChipMaterial(), []);
  useEffect(() => () => disposeLater(chip), [chip]);
  const chipMesh = useRef<Mesh>(null);
  const barMesh = useRef<Mesh>(null);
  const shape = useRef<Silhouette>({ top: 0, bottom: 0, left: 0, right: 0 });
  /** The plate's lowest edge below its origin (plate units), from the last layout. */
  const lowest = useRef(-BAR_H / 2 - CHIP_PAD_Y);

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    // Fresh transforms: this frame's camera and token pose (tokens move before overlays run, TOKEN_FRAME_PRIORITY).
    const a0 = anchor.current;
    const rt = a0?.parent;
    const cam = state.camera;
    cam.updateMatrixWorld();
    if (rt) {
      rt.updateWorldMatrix(true, true);
      axis.setFromMatrixPosition(rt.matrixWorld);
    } else g.getWorldPosition(axis);
    axis.y += top();
    const d = cam.position.distanceTo(axis);
    // Screen pixels per world unit at the token's depth (perspective or orthographic alike).
    const at = ndc.copy(axis).project(cam);
    const up = screenUp.setFromMatrixColumn(cam.matrixWorld, 1);
    const pxPerWorld = Math.max(
      1e-6,
      ((probe.copy(axis).add(up).project(cam).y - at.y) * state.size.height) / 2,
    );
    // The plate keeps its type readable: about 20 px per plate unit, a little larger up close and smaller far away,
    // never below the 12-px minimum for its smallest text (SPEC §27.3); very far away it fades out instead.
    const pxPerPlate = Math.min(
      PLATE_PX_MAX,
      Math.max(PLATE_PX_MIN, PLATE_PX * (70 / Math.max(1, d)) ** 0.3),
    );
    const plate = pxPerPlate / pxPerWorld;
    g.scale.setScalar(plate);
    layoutPlate();
    // The numbers read on either part of the bar: ink over the fill (verdigris, brass, ember or temp cyan — bone
    // there was ~1.7:1), bone over the dark track; the split follows the fill's edge.
    if (numText.current || numInk.current) {
      const w = barWidth.current;
      const edge = -w / 2 + w * Math.min(1, Math.max(0, frac) + Math.max(0, temp));
      const setClip = (t: TroikaText | null, r: [number, number, number, number]) => {
        if (!t) return;
        const c = t.clipRect as number[] | null;
        if (!c || Math.abs((c[0] as number) - r[0]) > 1e-4 || Math.abs((c[2] as number) - r[2]) > 1e-4) {
          t.clipRect = r;
          t.sync();
        }
      };
      setClip(numText.current, [edge, -10, 10, 10]);
      setClip(numInk.current, [-10, -10, edge, 10]);
    }
    // Sit a fixed gap above the token's highest point on screen, centred over its silhouette, at any pitch, pose or
    // perspective: find the spot in screen space, then put the anchor there at the depth of the token's top.
    // Moved aside by the declutter layout when its own spot is taken (a leader line then points back to the token).
    const off = overlayOffset(token.id);
    const seen = a0 && rt && screenTop(cam, shape.current);
    // Its body on screen: other plates moved aside keep off it (declutter.ts).
    if (seen) {
      const s = shape.current;
      const W = state.size.width;
      const H = state.size.height;
      setOverlayBody(token.id, {
        x0: ((s.left + 1) / 2) * W,
        x1: ((s.right + 1) / 2) * W,
        y0: ((1 - s.top) / 2) * H,
        y1: ((1 - s.bottom) / 2) * H,
      });
    } else setOverlayBody(token.id, null);
    if (a0 && rt && seen) {
      const liftPx = (PLATE_GAP - lowest.current) * pxPerPlate;
      at.x = (shape.current.left + shape.current.right) / 2 + (off.dx * 2) / state.size.width;
      at.y = shape.current.top + (liftPx * 2) / state.size.height - (off.dy * 2) / state.size.height;
      at.unproject(cam).sub(probe.setFromMatrixPosition(rt.matrixWorld));
      // Still settling (a pose or view change reaches the plate a frame later): draw once more.
      if (at.distanceToSquared(a0.position) > 1e-6) again();
      a0.position.copy(at);
    }
    // The leader: from the plate's bottom to the top of its token, when the plate sits aside.
    const moved = Math.abs(off.dx) > 0.5 || Math.abs(off.dy) > 0.5;
    leader.group.visible = moved;
    if (moved) {
      const sy = lowest.current;
      const ex = -off.dx / pxPerPlate;
      const ey = off.dy / pxPerPlate + lowest.current - PLATE_GAP;
      const px = 1 / pxPerPlate;
      const len = Math.hypot(ex, ey - sy);
      const rot = Math.atan2(ey - sy, ex);
      for (const [m, across] of [
        [leader.halo, 4],
        [leader.line, 2],
      ] as const) {
        m.position.set(0, sy, 0);
        m.rotation.z = rot;
        m.scale.set(len, across * px, 1);
      }
      // A dot on the token end: 2.5 px, on a 4-px halo, whatever the zoom.
      leader.dot.position.set(ex, ey, 0);
      leader.dot.scale.setScalar(2.5 * px);
      leader.dotHalo.position.set(ex, ey, 0);
      leader.dotHalo.scale.setScalar(4 * px);
    }
    // Overlays always read on top of other tokens and the map (troika re-derives its materials — an array of
    // outline + fill when outlined — so reapply every frame; the chip and bar keep their own lower orders).
    g.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined;
      if (!m || o === chipMesh.current || o === barMesh.current) return;
      for (const x of Array.isArray(m) ? m : [m]) if (x.depthTest) x.depthTest = false;
      o.renderOrder = 30;
    });
    const far = 1 - Math.min(1, Math.max(0, (d - 260) / 80));
    // Clutter fade (150 ms) toward the layout's verdict; while a radial menu is open no plate shows — they'd peek
    // through the gaps between its slices, its own token's behind them (the menu names the token).
    const radial = useUi.getState().radial;
    const target = radial ? 0 : overlayClear(token.id);
    clear.current = approach(clear.current, target, frameDelta() / 0.15);
    if (clear.current !== target) again();
    const fade = far * clear.current;
    g.visible = fade > 0.02;
    const a = fade * opacity;
    for (const t of [nameText.current, numText.current, numInk.current, tempText.current, wordText.current])
      if (t && (t.fillOpacity !== a || t.outlineOpacity !== a)) {
        t.fillOpacity = a;
        t.outlineOpacity = a;
      }
    if (badge.current) badge.current.opacity = fade;
    for (const [i, p] of pins.entries()) {
      const r = pinRows.current[i];
      for (const t of [r?.label, r?.value])
        if (t && (t.fillOpacity !== a || t.outlineOpacity !== a)) {
          t.fillOpacity = a;
          t.outlineOpacity = a;
        }
      const m = pinMats[i];
      if (m) setGauge(m, p.max > 0 ? Math.min(1, Math.max(0, p.value / p.max)) : 0, a);
    }
    leader.strokeMat.opacity = 0.95 * a;
    leader.haloMat.opacity = 0.55 * a;
    overlayFade.set(token.id, { far, clear: clear.current, target, a });
    const now = performance.now();
    const gv = showBar ? ghost.current.update(Math.max(0, frac), now) : 0;
    if (showBar) {
      setHpBar(bar, { frac: Math.max(0, frac), temp: Math.max(0, temp), ghost: gv, opacity: a }, colorBlind);
      hpBarState.set(token.id, {
        frac: Math.max(0, frac),
        temp: Math.max(0, temp),
        ghost: gv,
        at: now,
        ghostStart: ghost.current.startedAt,
      });
    } else hpBarState.delete(token.id);
    // The damage ghost holds and drains over ~1 s: keep drawing until it has caught up.
    if (showBar && Math.abs(gv - Math.max(0, frac)) > 1e-4) again();
    const cm = chipMesh.current;
    if (cm) setChip(chip, cm.scale.x, cm.scale.y, a * CHIP_OPACITY);
  });
  useEffect(() => () => void hpBarState.delete(token.id), [token.id]);

  /**
   * Sizes the chip, the bar and the name around the text as troika has laid it out: the bar at the origin (as wide
   * as its numbers need, at least BAR_W), the name above it, the chip behind both with even padding.
   */
  const layoutPlate = () => {
    const nameB = nameText.current?.textRenderInfo?.blockBounds;
    const numB = numText.current?.textRenderInfo?.blockBounds;
    const wordB = wordText.current?.textRenderInfo?.blockBounds;
    const nameW = nameB ? nameB[2] - nameB[0] : 0;
    const nameTop = BAR_H / 2 + NAME_GAP + (nameB ? nameB[3] - nameB[1] : NAME_SIZE * 1.2);
    // Pinned counters stack under the bar: label left, numbers right, over a gauge. The HP bar and the gauges share
    // one width — the widest of the bar's numbers and the counters' text.
    let pinW = 0;
    for (let i = 0; i < pins.length; i++) {
      const r = pinRows.current[i];
      const lb = r?.label?.textRenderInfo?.blockBounds;
      const vb = r?.value?.textRenderInfo?.blockBounds;
      pinW = Math.max(pinW, (lb ? lb[2] - lb[0] : 0) + (vb ? vb[2] - vb[0] : 0) + 0.6);
    }
    const barW = showBar ? Math.max(BAR_W, numB ? numB[2] - numB[0] + 0.7 : 0, pinW) : 0;
    barWidth.current = barW;
    // Temporary HP stand just right of the bar.
    const tempB = tempText.current?.textRenderInfo?.blockBounds;
    const tempW = tempB && showBar ? tempB[2] - tempB[0] + TEMP_GAP : 0;
    tempText.current?.position.setX(barW / 2 + TEMP_GAP);
    const wordW = wordB ? wordB[2] - wordB[0] : 0;
    const bm = barMesh.current;
    if (bm) bm.scale.set(barW, BAR_H, 1);
    let bottom = showBar || descriptor ? -BAR_H / 2 : BAR_H / 2 + NAME_GAP;
    const gaugeW = pins.length ? Math.max(barW || BAR_W, pinW) : 0;
    for (let i = 0; i < pins.length; i++) {
      const r = pinRows.current[i];
      const textY = bottom - PIN_ROW_GAP - PIN_LINE / 2;
      const barY = textY - PIN_LINE / 2 - PIN_BAR_GAP - PIN_BAR_H / 2;
      r?.label?.position.set(-gaugeW / 2, textY, 0);
      r?.value?.position.set(gaugeW / 2, textY, 0);
      if (r?.bar) {
        r.bar.position.set(0, barY, 0);
        r.bar.scale.set(gaugeW, PIN_BAR_H, 1);
      }
      bottom = barY - PIN_BAR_H / 2;
    }
    const w = Math.max(nameW, barW + 2 * tempW, wordW, gaugeW) + 2 * CHIP_PAD_X;
    const h = nameTop - bottom + 2 * CHIP_PAD_Y;
    const cm = chipMesh.current;
    if (cm) {
      cm.scale.set(w, h, 1);
      cm.position.set(0, (nameTop + bottom) / 2, -0.01);
    }
    lowest.current = bottom - CHIP_PAD_Y;
  };

  return (
    <group ref={anchor}>
      <Billboard>
        <group ref={group} userData={{ part: "overlay" }}>
          <primitive object={leader.group} />
          <mesh
            ref={chipMesh}
            material={chip}
            geometry={CHIP_GEOMETRY}
            renderOrder={19}
            raycast={() => null}
            dispose={null}
            userData={{ part: "plateChip" }}
          />
          <BoardText
            ref={nameText}
            font={CAPS_FONT}
            fontSize={NAME_SIZE}
            letterSpacing={0.08}
            color={C.bone100}
            outlineWidth={0.02}
            outlineColor={C.ink950}
            anchorY="bottom"
            position={[0, BAR_H / 2 + NAME_GAP, 0]}
            raycast={() => null}
          >
            {token.name}
          </BoardText>
          {hidden ? (
            <sprite
              position={[0, BAR_H / 2 + 1.55, 0]}
              scale={[0.7, 0.7, 0.7]}
              raycast={() => null}
              userData={{ part: "hiddenBadge" }}
            >
              <spriteMaterial ref={badge} map={hiddenBadgeTexture()} depthTest={false} transparent />
            </sprite>
          ) : null}
          {showBar ? (
            <mesh
              ref={barMesh}
              material={bar as ShaderMaterial}
              geometry={CHIP_GEOMETRY}
              scale={[BAR_W, BAR_H, 1]}
              renderOrder={20}
              raycast={() => null}
              dispose={null}
            />
          ) : null}
          {showNumbers && nums ? (
            // On the bar, never beside it: the plate is never wider than its name or its bar (the bar grows to fit;
            // DECISIONS). Set off by a thin, soft shadow — a heavy outline swelled the figures into blobs.
            <BoardText
              ref={numText}
              font={NUMBER_FONT}
              fontSize={NUM_SIZE}
              color={C.bone100}
              outlineWidth={0.022}
              outlineBlur={0.12}
              outlineOpacity={0.9}
              outlineColor={C.ink950}
              anchorX="center"
              anchorY="middle"
              position={[0, -0.02, 0.01]}
              raycast={() => null}
            >
              {`${nums.hp} / ${nums.hpMax}`}
            </BoardText>
          ) : null}
          {showNumbers && nums ? (
            <BoardText
              ref={numInk}
              font={NUMBER_FONT}
              fontSize={NUM_SIZE}
              color={C.ink950}
              anchorX="center"
              anchorY="middle"
              position={[0, -0.02, 0.011]}
              raycast={() => null}
            >
              {`${nums.hp} / ${nums.hpMax}`}
            </BoardText>
          ) : null}
          {showNumbers && nums?.hpTemp ? (
            // Temporary HP beside the bar in their own colour (inside it, "+5" straddled the fill's edge).
            <BoardText
              ref={tempText}
              font={NUMBER_FONT}
              fontSize={NUM_SIZE}
              color={C.ice300}
              outlineWidth={0.022}
              outlineBlur={0.12}
              outlineOpacity={0.9}
              outlineColor={C.ink950}
              anchorX="left"
              anchorY="middle"
              position={[BAR_W / 2 + TEMP_GAP, -0.02, 0.01]}
              raycast={() => null}
            >
              {`+${nums.hpTemp}`}
            </BoardText>
          ) : null}
          {descriptor ? (
            <BoardText
              ref={wordText}
              font={CAPS_FONT}
              fontSize={WORD_SIZE}
              letterSpacing={0.08}
              color={C.brass300}
              outlineWidth={0.02}
              outlineColor={C.ink950}
              anchorX="center"
              anchorY="middle"
              position={[0, 0, 0]}
              raycast={() => null}
            >
              {descriptor}
            </BoardText>
          ) : null}
          {pins.map((p, i) => (
            <group key={i} userData={{ part: `pinned:${i}`, pin: p }}>
              <BoardText
                ref={(t) => {
                  pinRow(i).label = t as TroikaText | null;
                }}
                font={CAPS_FONT}
                fontSize={PIN_TEXT}
                letterSpacing={0.06}
                color={C.fog300}
                outlineWidth={0.02}
                outlineColor={C.ink950}
                anchorX="left"
                anchorY="middle"
                raycast={() => null}
              >
                {p.label}
              </BoardText>
              <BoardText
                ref={(t) => {
                  pinRow(i).value = t as TroikaText | null;
                }}
                font={NUMBER_FONT}
                fontSize={PIN_TEXT}
                color={C.bone100}
                outlineWidth={0.022}
                outlineBlur={0.12}
                outlineOpacity={0.9}
                outlineColor={C.ink950}
                anchorX="right"
                anchorY="middle"
                raycast={() => null}
              >
                {`${p.value}/${p.max}`}
              </BoardText>
              <mesh
                ref={(m) => {
                  pinRow(i).bar = m;
                }}
                material={pinMats[i] as ShaderMaterial}
                geometry={CHIP_GEOMETRY}
                renderOrder={20}
                raycast={() => null}
                dispose={null}
              />
            </group>
          ))}
        </group>
      </Billboard>
    </group>
  );
}
