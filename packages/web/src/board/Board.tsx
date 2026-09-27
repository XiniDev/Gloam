import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PCFShadowMap, PCFSoftShadowMap } from "three";
import { request, useTable } from "../net/table.ts";
import { boardData, useBoard, useEntities } from "../state/entities.ts";
import { ASSET_DRAG_TYPE, type AssetDragPayload } from "../state/library.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { toast } from "../ui/Toast.tsx";
import { boardApi } from "./boardApi.ts";
import { CameraRig, cameraRig } from "./CameraRig.tsx";
import { C } from "./colors.ts";
import { boardDiag } from "./diag.ts";
import { setupText } from "./fonts.ts";
import { Lighting } from "./Lighting.tsx";
import { MapAlignGizmo } from "./map/MapAlignGizmo.tsx";
import { MapLayer } from "./map/MapLayer.tsx";
import { WallsLayer } from "./map/WallsLayer.tsx";
import { PostFX } from "./PostFX.tsx";
import { setMaxAnisotropy } from "./resources.ts";
import { boundsFromJson } from "./scene.ts";
import { TableSurface } from "./TableSurface.tsx";
import { TestProbe } from "./TestProbe.tsx";
import { chooseTier, probeDevice, TIERS, TierGovernor, useTier } from "./tiers.ts";
import { TokensLayer } from "./tokens/TokensLayer.tsx";

setupText();

/** Reads the device on the first frame, then adapts the tier from frame times (SPEC §8.4). */
function TierSetup() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const governor = useMemo(() => new TierGovernor(), []);
  const pin = useSettings((s) => s.tier);
  useEffect(() => {
    setMaxAnisotropy(gl.capabilities.getMaxAnisotropy());
  }, [gl]);
  // The device is probed once; a pin (or un-pin) in settings re-applies at once (AC-BRD-03).
  const device = useMemo(() => probeDevice(gl.getContext()), [gl]);
  useEffect(() => {
    if (pin) chooseTier(device);
  }, [device, pin]);
  useEffect(() => {
    boardApi.camera = camera;
    boardApi.element = gl.domElement;
  }, [camera, gl]);
  useFrame((_s, dt) => {
    // The first-load intro waits for this before fading the board up (SPEC §27.7).
    if (boardDiag.firstFrameAt === null) boardDiag.firstFrameAt = performance.now();
    governor.tick(dt);
  });
  return null;
}

/** Box selection rectangle in screen pixels (DM Shift+drag on empty board). */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The board (SPEC §8.4, §24.1): one R3F canvas, mounted once for the table route. 1 unit = 1 ft; the map lies on the
 * XZ plane at y = 0. Shows the DM's prep scene when one is open, else the live scene; without a scene the empty oak
 * table waits under the lamp.
 */
export default function Board() {
  const scene = useBoard((d) => d.scene);
  const tierName = useTier((s) => s.name);
  const tier = TIERS[tierName];
  const boundsJson = scene?.boundsJson;
  const bounds = useMemo(() => boundsFromJson(boundsJson), [boundsJson]);
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const [box, setBox] = useState<Box | null>(null);
  const press = useRef<{ x: number; y: number; empty: boolean; box: boolean } | null>(null);
  const clipboard = useRef<string[]>([]);
  const tool = useUi((s) => s.tool);

  // Board keyboard: Esc clears; DM: Delete removes, Ctrl/Cmd+C/V copies and pastes at the cursor.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const ui = useUi.getState();
      if (e.key === "Escape") {
        ui.set({ radial: null });
        if (ui.selection.length) ui.select([]);
        return;
      }
      if (!dm) return;
      const mod = e.ctrlKey || e.metaKey;
      try {
        if ((e.key === "Delete" || e.key === "Backspace") && ui.selection.length) {
          e.preventDefault();
          await request("token.delete", { tokenIds: ui.selection });
          toast.info(
            `Deleted ${ui.selection.length === 1 ? "a token" : `${ui.selection.length} tokens`}`,
            "Ctrl+Z brings it back.",
          );
          ui.select([]);
        } else if (mod && e.code === "KeyC" && ui.selection.length) {
          clipboard.current = [...ui.selection];
        } else if (mod && e.code === "KeyV" && clipboard.current.length) {
          e.preventDefault();
          const at = boardApi.cursor;
          const live = boardData(useEntities.getState()).tokens;
          const ids = clipboard.current.filter((id) => live.has(id));
          if (!ids.length) return;
          const res = await request<{ tokenIds: string[] }>(
            "token.duplicate",
            at ? { tokenIds: ids, at } : { tokenIds: ids },
          );
          ui.select(res.tokenIds);
        }
      } catch (err) {
        toast.danger("Couldn't do that", (err as Error).message);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dm]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Token presses stop propagation inside the canvas; anything reaching here without a token hit is the table.
    // Tokens set `hover` on pointer-over, so a press with a hovered token is a token press, not the table.
    const pan = useUi.getState().tool === "pan";
    const onToken = !pan && useUi.getState().hover !== null;
    if (e.button !== 0) return;
    if (dm && e.altKey && e.shiftKey) {
      const p = boardApi.groundAt(e.clientX, e.clientY);
      if (p) {
        void request("camera.spotlight", { x: p.x, y: p.y }).catch(() => {});
        toast.info("Spotlight", "Players who allow it are looking here.");
      }
      return;
    }
    const boxSelect = dm && e.shiftKey && !onToken && !pan;
    press.current = { x: e.clientX, y: e.clientY, empty: !onToken && !pan, box: boxSelect };
    if (boxSelect) {
      const c = cameraRig.controls;
      if (c) c.enabled = false;
      setBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
    }
  };
  // Library → board (SPEC §8.5 Creation, AC-AST-06): art and minis become tokens where they land; a map starts a
  // new scene with it.
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!dm || !e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    boardApi.cursor = boardApi.groundAt(e.clientX, e.clientY);
  };
  const onDrop = async (e: ReactDragEvent<HTMLDivElement>) => {
    const raw = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (!dm || !raw) return;
    e.preventDefault();
    let a: AssetDragPayload;
    try {
      a = JSON.parse(raw) as AssetDragPayload;
    } catch {
      return;
    }
    if (a.purpose === "map") {
      useUi.getState().set({ sceneWizard: { assetId: a.id } });
      return;
    }
    if (a.cls === "audio" || a.purpose === "handout") {
      toast.info("That one doesn't go on the board", "Drop maps, minis or token art here.");
      return;
    }
    const sceneId = boardData(useEntities.getState()).scene?.id;
    if (!sceneId) {
      toast.info("No scene yet", "Create a scene first, then drop tokens onto it.");
      return;
    }
    const at = boardApi.groundAt(e.clientX, e.clientY);
    if (!at) return;
    try {
      const r = await request<{ tokenId: string }>("token.create", {
        sceneId,
        name: a.name.slice(0, 80) || "Unit",
        pos: at,
        link: "unlinked",
        appearance: {
          mode: a.cls === "model" ? "model" : "auto",
          assetId: a.id,
          scale: 1,
          offsetY: 0,
          rotationOffsetDeg: 0,
        },
      });
      useUi.getState().select([r.tokenId]);
    } catch (err) {
      toast.danger("Couldn't place it", (err as Error).message);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    boardApi.cursor = boardApi.groundAt(e.clientX, e.clientY);
    const p = press.current;
    if (p?.box) setBox({ x0: p.x, y0: p.y, x1: e.clientX, y1: e.clientY });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.box) {
      const c = cameraRig.controls;
      if (c) c.enabled = true;
      setBox(null);
      const [minX, maxX] = [Math.min(p.x, e.clientX), Math.max(p.x, e.clientX)];
      const [minY, maxY] = [Math.min(p.y, e.clientY), Math.max(p.y, e.clientY)];
      if (maxX - minX < 4 && maxY - minY < 4) return;
      const inside: string[] = [];
      for (const t of boardData(useEntities.getState()).tokens.values()) {
        const s = boardApi.project(t.pos.x, t.pos.y, t.elevation);
        if (s && s.sx >= minX && s.sx <= maxX && s.sy >= minY && s.sy <= maxY) inside.push(t.id);
      }
      useUi.getState().select([...new Set([...useUi.getState().selection, ...inside])]);
      return;
    }
    // A click (not a pan) on empty table clears the selection.
    if (p.empty && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4 && !e.shiftKey)
      useUi.getState().select([]);
  };

  return (
    <div
      className="absolute inset-0 bg-bg"
      data-testid="board"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={onDragOver}
      onDrop={(e) => void onDrop(e)}
      style={{ cursor: tool === "pan" ? "grab" : undefined }}
    >
      <Canvas
        dpr={Math.min(window.devicePixelRatio || 1, tier.dpr)}
        shadows={tier.shadowMap ? { type: tier.softShadows ? PCFSoftShadowMap : PCFShadowMap } : false}
        gl={{
          antialias: false,
          powerPreference: "high-performance",
          preserveDrawingBuffer: __GLOAM_TEST__,
          alpha: false,
        }}
        camera={{ fov: 40, near: 0.5, far: 4000, position: [30, 60, 90] }}
        style={{ background: C.ink950 }}
        onCreated={({ gl }) => gl.setClearColor(C.ink950)}
      >
        <color attach="background" args={[C.ink950]} />
        <TierSetup />
        <CameraRig bounds={bounds} sceneId={scene?.id ?? "none"} />
        <Lighting bounds={bounds} ambient={scene?.ambient ?? "bright"} tier={tier} />
        <TableSurface bounds={bounds} />
        {scene ? <MapLayer scene={scene} bounds={bounds} /> : null}
        <TokensLayer />
        <WallsLayer />
        <MapAlignGizmo />
        <ShadowSync enabled={tier.shadowMap > 0} soft={tier.softShadows} />
        <PostFX tier={tier} />
        {__GLOAM_TEST__ ? <TestProbe /> : null}
      </Canvas>
      {/* The subtle vignette of the post chain, done in CSS so it costs nothing on any tier (SPEC §24.6). */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at 50% 45%, transparent 55%, var(--vignette-edge) 100%)",
        }}
        aria-hidden
      />
      {box ? (
        <div
          className="pointer-events-none fixed border border-accent bg-[var(--selection-fill)]"
          style={{
            left: Math.min(box.x0, box.x1),
            top: Math.min(box.y0, box.y1),
            width: Math.abs(box.x1 - box.x0),
            height: Math.abs(box.y1 - box.y0),
          }}
        />
      ) : null}
    </div>
  );
}

/** Keeps the renderer's shadow map in step with the tier (Low turns shadow maps off, AC-BRD-03). */
function ShadowSync({ enabled, soft }: { enabled: boolean; soft: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    gl.shadowMap.enabled = enabled;
    gl.shadowMap.type = soft ? PCFSoftShadowMap : PCFShadowMap;
    gl.shadowMap.needsUpdate = true;
    scene.traverse((o) => {
      const m = (o as { material?: { needsUpdate: boolean } | { needsUpdate: boolean }[] }).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true;
    });
  }, [enabled, soft, gl, scene]);
  return null;
}
