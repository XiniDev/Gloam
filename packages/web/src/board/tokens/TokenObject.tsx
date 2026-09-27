import { SIZE_MINI_HEIGHT_FT, type Size } from "@gloam/shared";
import { HP_BAND_HIDDEN, HP_BAND_LABELS } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import { Billboard, Html, Text } from "@react-three/drei";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { ChevronDown, ChevronUp } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  AnimationMixer,
  type Camera,
  type Group,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  type ShaderMaterial,
  type SpriteMaterial,
  type Texture,
  Vector3,
} from "three";
import { audio } from "../../audio/engine.ts";
import { request, useTable } from "../../net/table.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { IconButton } from "../../ui/Button.tsx";
import { toast } from "../../ui/Toast.tsx";
import { boardApi } from "../boardApi.ts";
import { cameraRig } from "../CameraRig.tsx";
import { C, col, ringColorOf } from "../colors.ts";
import { boardDiag } from "../diag.ts";
import { disposeLater } from "../dispose.ts";
import { CAPS_FONT, NUMBER_FONT } from "../fonts.ts";
import { again, frameDelta, setAnimating } from "../frames.ts";
import { moveAnimAt } from "../move/anims.ts";
import { pressToken } from "../move/input.ts";
import { TIERS, useTier } from "../tiers.ts";
import { AUTO_COIN_PITCH, approach, crossfadeStep } from "./crossfade.ts";
import { overlayClear, PRIORITY, registerOverlay } from "./declutter.ts";
import { cylinder, plane, torus } from "./geometries.ts";
import { hiddenBadgeTexture, initialsTexture } from "./glyphs.ts";
import { type MiniInstance, useAssetMeta, useAssetTexture, useMini } from "./hooks.ts";
import { createHpBarMaterial, HpGhost, setHpBar } from "./hpBar.ts";
import { CHIP_GEOMETRY, createChipMaterial, setChip } from "./plateChip.ts";

/** Pitch above which Auto mode shows the coin (SPEC §8.5, AC-TOK-11) and the crossfade time. */

const BASE_H = 0.14;
const COIN_H = 0.2;
/** A troika text mesh (drei's <Text>): its opacities apply at render, no re-layout. */
type TroikaText = Mesh & {
  fillOpacity: number;
  outlineOpacity: number;
  /** troika's layout, once synced: the text block's [minX, minY, maxX, maxY] in its own units. */
  textRenderInfo?: { blockBounds: [number, number, number, number] } | null;
};

const tmp = new Vector3();
const screenUp = new Vector3();
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

function useTransparentMaterial(make: () => MeshStandardMaterial, deps: unknown[]) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the material's inputs
  const m = useMemo(make, deps);
  useEffect(() => () => disposeLater(m), [m]);
  return m;
}

/** A token on the table: base, appearance, states and overlay. */
export const TokenObject = memo(function TokenObject({
  token,
  viewer,
}: {
  token: TokenView;
  viewer: Viewer;
}) {
  const colorBlind = useSettings((s) => s.colorBlind);
  const selected = useUi((s) => s.selection.includes(token.id));
  const hovered = useUi((s) => s.hover === token.id);
  const tier = useTier((s) => s.name);
  const ring = ringColorOf(token, colorBlind);
  const R = Math.max(0.6, token.sizeFt / 2);
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
    () => new MeshStandardMaterial({ color: C.baseInk, roughness: 0.55 }),
    [],
  );
  const rimMat = useTransparentMaterial(
    () => new MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 }),
    [],
  );
  const coinFaceMat = useTransparentMaterial(() => new MeshStandardMaterial({ roughness: 0.75 }), []);
  const standeeFront = useTransparentMaterial(
    () => new MeshStandardMaterial({ roughness: 0.85, alphaTest: 0.5 }),
    [],
  );
  const standeeBack = useTransparentMaterial(
    () => new MeshStandardMaterial({ color: C.cardboard, roughness: 0.95, alphaTest: 0.5 }),
    [],
  );
  const selMat = useTransparentMaterial(
    () => new MeshStandardMaterial({ color: C.selectGlow, emissive: C.selectGlow, emissiveIntensity: 1.6 }),
    [],
  );
  const hoverMat = useTransparentMaterial(
    () => new MeshStandardMaterial({ color: C.hoverRing, emissive: C.hoverRing, emissiveIntensity: 0.35 }),
    [],
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
    out.left = Number.POSITIVE_INFINITY;
    out.right = Number.NEGATIVE_INFINITY;
    const take = (v: Vector3) => {
      v.project(cam);
      if (v.y > out.top) out.top = v.y;
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
      const cam = state.camera.position;
      let yaw = Math.atan2(cam.x - g.position.x, cam.z - g.position.z);
      if (lying) {
        const up = screenUp.setFromMatrixColumn(state.camera.matrixWorld, 1);
        yaw = Math.atan2(-up.x, -up.z);
      }
      standeeGroup.current.rotation.y = yaw - (body.current?.rotation.y ?? 0);
    }
    setOpacity(coinFaceMat, baseOpacity * cw);
    setOpacity(standeeFront, baseOpacity * (1 - cw));
    setOpacity(standeeBack, baseOpacity * (1 - cw));
    setOpacity(baseMat, baseOpacity);
    setOpacity(rimMat, baseOpacity);
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
    <group ref={root} name={`token:${token.id}`} userData={{ tokenId: token.id }}>
      <group
        ref={body}
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
      {selected && canRaise(token, viewer) ? <ElevationStepper token={token} radius={R} /> : null}
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
        const c = mat.clone();
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
/** Who may raise this token: a DM always; its controller when it can fly (SPEC §8.6 Speeds and modes). */
function canRaise(t: TokenView, viewer: Viewer): boolean {
  if (viewer.dm) return true;
  return t.ownerIds.includes(viewer.userId) && (t.own?.speedFly ?? 0) > 0;
}

/**
 * The HUD elevation stepper (AC-TOK-07): ▲/▼ in 5-ft steps beside the selected token, with its height. Alt+wheel
 * over the token does the same.
 */
function ElevationStepper({ token, radius }: { token: TokenView; radius: number }) {
  const step = (delta: number) =>
    void request("token.elevation", { tokenId: token.id, delta }).catch((e) =>
      toast.danger("Couldn't change its height", (e as Error).message),
    );
  return (
    <Html position={[radius + 1.4, 0.2, 0]} center zIndexRange={[25, 0]}>
      <div
        className="panel flex flex-col items-center gap-0.5 p-1"
        role="group"
        aria-label={`Elevation of ${token.name}`}
        data-testid="elevation-stepper"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <IconButton label="Raise 5 ft (Alt+wheel)" onClick={() => step(5)}>
          <ChevronUp size={16} />
        </IconButton>
        <span className="tabular text-12 font-bold text-bone" data-testid="elevation-value">
          {token.elevation > 0 ? "+" : ""}
          {Math.round(token.elevation)} ft
        </span>
        <IconButton label="Lower 5 ft (Alt+wheel)" onClick={() => step(-5)}>
          <ChevronDown size={16} />
        </IconButton>
      </div>
    </Html>
  );
}

function Elevation({ elevation, radius }: { elevation: number; radius: number }) {
  const mat = useMemo(
    () =>
      new MeshStandardMaterial({ color: C.brass300, transparent: true, opacity: 0.55, depthWrite: false }),
    [],
  );
  useEffect(() => () => disposeLater(mat), [mat]);
  if (Math.abs(elevation) < 0.5) return null;
  const up = elevation > 0;
  return (
    <group>
      {up ? (
        <mesh position-y={-elevation / 2} material={mat} userData={{ part: "elevationStem" }}>
          <cylinderGeometry args={[0.05, 0.05, elevation, 8]} />
        </mesh>
      ) : null}
      <mesh
        position-y={-elevation + 0.03}
        rotation-x={Math.PI / 2}
        material={mat}
        userData={{ part: "elevationRing" }}
      >
        <torusGeometry args={[radius, 0.05, 8, 64]} />
      </mesh>
      <Billboard position={[radius + 0.6, -elevation + 0.6, 0]}>
        <Text
          userData={{ part: "elevationLabel" }}
          font={CAPS_FONT}
          fontSize={0.5}
          color={C.brass300}
          outlineWidth={0.05}
          outlineColor={C.ink950}
          raycast={() => null}
        >
          {`${up ? "+" : "−"}${Math.abs(Math.round(elevation))} ft`}
        </Text>
      </Billboard>
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
  const wordText = useRef<TroikaText>(null);
  const badge = useRef<SpriteMaterial>(null);
  const bar = useMemo(() => createHpBarMaterial(), []);
  useEffect(() => () => disposeLater(bar), [bar]);
  const ghost = useRef(new HpGhost());
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
  const shape = useRef<Silhouette>({ top: 0, left: 0, right: 0 });
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
    // Sit a fixed gap above the token's highest point on screen, centred over its silhouette, at any pitch, pose or
    // perspective: find the spot in screen space, then put the anchor there at the depth of the token's top.
    if (a0 && rt && screenTop(cam, shape.current)) {
      const liftPx = (PLATE_GAP - lowest.current) * pxPerPlate;
      at.x = (shape.current.left + shape.current.right) / 2;
      at.y = shape.current.top + (liftPx * 2) / state.size.height;
      at.unproject(cam).sub(probe.setFromMatrixPosition(rt.matrixWorld));
      // Still settling (a pose or view change reaches the plate a frame later): draw once more.
      if (at.distanceToSquared(a0.position) > 1e-6) again();
      a0.position.copy(at);
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
    // Clutter fade (150 ms) toward the layout's verdict; while a radial menu is open, only its token's plate shows
    // (others would peek through the gaps between its slices).
    const radial = useUi.getState().radial;
    const target = radial && radial.tokenId !== token.id ? 0 : overlayClear(token.id);
    clear.current = approach(clear.current, target, frameDelta() / 0.15);
    if (clear.current !== target) again();
    const fade = far * clear.current;
    g.visible = fade > 0.02;
    const a = fade * opacity;
    for (const t of [nameText.current, numText.current, wordText.current])
      if (t && (t.fillOpacity !== a || t.outlineOpacity !== a)) {
        t.fillOpacity = a;
        t.outlineOpacity = a;
      }
    if (badge.current) badge.current.opacity = fade;
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
    const barW = showBar ? Math.max(BAR_W, numB ? numB[2] - numB[0] + 0.7 : 0) : 0;
    const wordW = wordB ? wordB[2] - wordB[0] : 0;
    const bm = barMesh.current;
    if (bm) bm.scale.set(barW, BAR_H, 1);
    const bottom = showBar || descriptor ? -BAR_H / 2 : BAR_H / 2 + NAME_GAP;
    const w = Math.max(nameW, barW, wordW) + 2 * CHIP_PAD_X;
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
          <mesh
            ref={chipMesh}
            material={chip}
            geometry={CHIP_GEOMETRY}
            renderOrder={19}
            raycast={() => null}
            dispose={null}
            userData={{ part: "plateChip" }}
          />
          <Text
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
          </Text>
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
            // On the bar, never beside it: the plate is never wider than its name or its bar (the bar grows to fit).
            <Text
              ref={numText}
              font={NUMBER_FONT}
              fontSize={NUM_SIZE}
              color={C.bone100}
              outlineWidth={0.075}
              outlineColor={C.ink950}
              anchorX="center"
              anchorY="middle"
              position={[0, -0.02, 0.01]}
              raycast={() => null}
            >
              {`${nums.hp} / ${nums.hpMax}${nums.hpTemp ? `  +${nums.hpTemp}` : ""}`}
            </Text>
          ) : null}
          {descriptor ? (
            <Text
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
            </Text>
          ) : null}
        </group>
      </Billboard>
    </group>
  );
}
