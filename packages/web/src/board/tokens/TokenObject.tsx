import { SIZE_MINI_HEIGHT_FT, type Size } from "@gloam/shared";
import { HP_BAND_HIDDEN, HP_BAND_LABELS } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import { Billboard, Text } from "@react-three/drei";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  AnimationMixer,
  type Group,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  type ShaderMaterial,
  type Texture,
  Vector3,
} from "three";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { cameraRig } from "../CameraRig.tsx";
import { C, col, ringColorOf } from "../colors.ts";
import { boardDiag } from "../diag.ts";
import { disposeLater } from "../dispose.ts";
import { CAPS_FONT } from "../fonts.ts";
import { setAnimating } from "../frames.ts";
import { TIERS, useTier } from "../tiers.ts";
import { cylinder, plane, torus } from "./geometries.ts";
import { hiddenBadgeTexture, initialsTexture } from "./glyphs.ts";
import { type MiniInstance, useAssetMeta, useAssetTexture, useMini } from "./hooks.ts";
import { createHpBarMaterial, HpGhost, setHpBar } from "./hpBar.ts";

/** Pitch above which Auto mode shows the coin (SPEC §8.5, AC-TOK-11) and the crossfade time. */
export const AUTO_COIN_PITCH = 70;
const CROSSFADE_S = 0.2;
const BASE_H = 0.14;
const COIN_H = 0.2;
const tmp = new Vector3();
const screenUp = new Vector3();

export interface Viewer {
  userId: string;
  dm: boolean;
}

/** Live HP-bar values per token, read by the test hooks (AC-TOK-05). */
export const hpBarState = new Map<string, { frac: number; temp: number; ghost: number }>();

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

  const root = useRef<Group>(null);
  const body = useRef<Group>(null);
  const first = useRef(true);
  const coinW = useRef(mode === "coin" ? 1 : 0);
  const standeeGroup = useRef<Group>(null);
  const coinGroup = useRef<Group>(null);
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

  const topY =
    mode === "model" && mini ? mini.height * token.scale : mode === "coin" ? COIN_H : standeeH + BASE_H;

  // ── per frame: glide to position, facing, auto crossfade, billboarding, pulse ─────────────────────────
  useFrame((state, dt) => {
    const g = root.current;
    if (!g) return;
    const target = tmp.set(token.pos.x, token.elevation, token.pos.y);
    if (first.current) {
      g.position.copy(target);
      first.current = false;
    } else g.position.lerp(target, 1 - Math.exp(-dt * 12));
    if (body.current) {
      body.current.rotation.y = (-(token.rotation + token.rotOffset) * Math.PI) / 180;
    }
    // Auto mode: coin above 70° pitch, standee below, crossfading over 200 ms (AC-TOK-11).
    const wantCoin =
      mode === "coin" ? 1 : mode === "auto" ? (cameraRig.pitchDeg() > AUTO_COIN_PITCH ? 1 : 0) : 0;
    const step = dt / CROSSFADE_S;
    coinW.current =
      wantCoin > coinW.current ? Math.min(1, coinW.current + step) : Math.max(0, coinW.current - step);
    const cw = mode === "auto" ? coinW.current : wantCoin;
    if (coinGroup.current) coinGroup.current.visible = mode !== "model" && cw > 0.001;
    if (standeeGroup.current) {
      standeeGroup.current.visible = mode !== "model" && cw < 0.999;
      // Billboard around the vertical axis only (SPEC §8.5 Standee).
      const cam = state.camera.position;
      standeeGroup.current.rotation.y =
        Math.atan2(cam.x - g.position.x, cam.z - g.position.z) - (body.current?.rotation.y ?? 0);
    }
    setOpacity(coinFaceMat, baseOpacity * cw);
    setOpacity(standeeFront, baseOpacity * (1 - cw));
    setOpacity(standeeBack, baseOpacity * (1 - cw));
    setOpacity(baseMat, baseOpacity);
    setOpacity(rimMat, baseOpacity);
    boardDiag.tokenModes.set(token.id, {
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
      state.invalidate();
  });
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
    down.current = { x: n.clientX, y: n.clientY, button: n.button, timer: null };
    if (n.button === 0) {
      useUi.getState().select([token.id], n.shiftKey ? "toggle" : "replace");
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

  const lying = token.prone || token.dead;
  return (
    <group ref={root} name={`token:${token.id}`} userData={{ tokenId: token.id }}>
      <group
        ref={body}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onContextMenu={onContext}
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
              dispose={null}
            />
          </group>
        ) : null}
        {mode === "model" && mini ? (
          <group
            userData={{ part: "mini" }}
            position-y={BASE_H + token.offsetY}
            rotation-z={lying ? (80 * Math.PI) / 180 : 0}
            scale={mini.scale * token.scale}
          >
            <primitive object={mini.root} position={mini.offset} dispose={null} />
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
                dispose={null}
              />
            </group>
            <group
              ref={standeeGroup}
              userData={{ part: "standee" }}
              rotation-x={lying ? -Math.PI / 2 : 0}
              position-y={lying ? BASE_H + 0.05 : 0}
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
        top={Math.max(topY, 0.3)}
        radius={R}
        opacity={baseOpacity}
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
        <mesh position-y={-elevation / 2} material={mat}>
          <cylinderGeometry args={[0.05, 0.05, elevation, 8]} />
        </mesh>
      ) : null}
      <mesh position-y={-elevation + 0.03} rotation-x={Math.PI / 2} material={mat}>
        <torusGeometry args={[radius, 0.05, 8, 64]} />
      </mesh>
      <Billboard position={[radius + 0.6, -elevation + 0.6, 0]}>
        <Text
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
  radius,
  opacity,
  hidden,
}: {
  token: TokenView;
  viewer: Viewer;
  top: number;
  radius: number;
  opacity: number;
  hidden: boolean;
}) {
  const colorBlind = useSettings((s) => s.colorBlind);
  const group = useRef<Group>(null);
  const anchor = useRef<Group>(null);
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

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    // Lift the plate along the camera's screen-up: above the token at any pitch, never over its face top-down.
    if (anchor.current) {
      const up = screenUp.setFromMatrixColumn(state.camera.matrixWorld, 1);
      anchor.current.position.set(0, top, 0).addScaledVector(up, radius + 0.9);
    }
    // Overlays always read on top of other tokens and the map (troika re-derives materials, so reapply).
    g.traverse((o) => {
      const m = (o as Mesh).material as Material | undefined;
      if (m?.depthTest) {
        m.depthTest = false;
        o.renderOrder = 30;
      }
    });
    const d = state.camera.position.distanceTo(g.getWorldPosition(tmp));
    g.scale.setScalar(Math.min(3.2, Math.max(0.55, d / 42)));
    const fade = 1 - Math.min(1, Math.max(0, (d - 260) / 80));
    g.visible = fade > 0.02;
    const now = performance.now();
    const gv = showBar ? ghost.current.update(Math.max(0, frac), now) : 0;
    if (showBar) {
      setHpBar(
        bar,
        { frac: Math.max(0, frac), temp: Math.max(0, temp), ghost: gv, opacity: fade * opacity },
        colorBlind,
      );
      hpBarState.set(token.id, { frac: Math.max(0, frac), temp: Math.max(0, temp), ghost: gv });
    } else hpBarState.delete(token.id);
    // The damage ghost holds and drains over ~1 s: keep drawing until it has caught up.
    if (showBar && Math.abs(gv - Math.max(0, frac)) > 1e-4) state.invalidate();
  });
  useEffect(() => () => void hpBarState.delete(token.id), [token.id]);

  return (
    <group ref={anchor}>
      <Billboard>
        <group ref={group}>
          <Text
            font={CAPS_FONT}
            fontSize={0.52}
            letterSpacing={0.08}
            color={C.bone100}
            outlineWidth={0.045}
            outlineColor={C.ink950}
            anchorY="bottom"
            position={[0, 0.28, 0]}
            fillOpacity={opacity}
            raycast={() => null}
          >
            {token.name}
          </Text>
          {hidden ? (
            <sprite position={[0, 1.25, 0]} scale={[0.62, 0.62, 0.62]} raycast={() => null}>
              <spriteMaterial map={hiddenBadgeTexture()} depthTest={false} transparent />
            </sprite>
          ) : null}
          {showBar ? (
            <mesh material={bar as ShaderMaterial} renderOrder={20} raycast={() => null}>
              <planeGeometry args={[3.2, 0.32]} />
            </mesh>
          ) : null}
          {showNumbers && nums ? (
            <Text
              font={CAPS_FONT}
              fontSize={0.36}
              color={C.bone100}
              outlineWidth={0.04}
              outlineColor={C.ink950}
              anchorX="left"
              anchorY="middle"
              position={[1.75, 0, 0]}
              raycast={() => null}
            >
              {`${nums.hp} / ${nums.hpMax}${nums.hpTemp ? `  +${nums.hpTemp}` : ""}`}
            </Text>
          ) : null}
          {descriptor ? (
            <Text
              font={CAPS_FONT}
              fontSize={0.4}
              color={C.brass300}
              outlineWidth={0.04}
              outlineColor={C.ink950}
              anchorY="top"
              position={[0, -0.05, 0]}
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
