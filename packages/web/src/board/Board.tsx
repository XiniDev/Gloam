import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PCFShadowMap } from "three";
import { DiceOverlay } from "../dice/DiceOverlay.tsx";
import { useIntro } from "../hud/Intro.tsx";
import { openSheetFor } from "../hud/sheet/open.ts";
import { request, send, useTable } from "../net/table.ts";
import { boardData, useBoard, useEntities } from "../state/entities.ts";
import { ASSET_DRAG_TYPE, type AssetDragPayload } from "../state/library.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { toast } from "../ui/Toast.tsx";
import { boardApi } from "./boardApi.ts";
import { CameraRig, cameraRig } from "./CameraRig.tsx";
import { targetDown, targetKey, targetMove, targetWheel } from "./cast/input.ts";
import { TargetingLayer } from "./cast/TargetingLayer.tsx";
import { C } from "./colors.ts";
import { DustMotes } from "./DustMotes.tsx";
import { boardDiag } from "./diag.ts";
import { preloadBoardFonts } from "./fonts.ts";
import {
  scheduleAmbientFrame,
  setFrameDelta,
  takePacedFrame,
  takeRequested,
  wake,
  wantsNextFrame,
} from "./frames.ts";
import { Lighting } from "./Lighting.tsx";
import { DoorsLayer } from "./map/DoorsLayer.tsx";
import { MapAlignGizmo } from "./map/MapAlignGizmo.tsx";
import { MapLayer } from "./map/MapLayer.tsx";
import { Walls3DLayer } from "./map/Walls3D.tsx";
import { WallsLayer } from "./map/WallsLayer.tsx";
import { ZonesLayer } from "./map/ZonesLayer.tsx";
import { clickFloor, hoverBoard, leaveBoard, moveKey } from "./move/input.ts";
import { MoveLayer } from "./move/MoveLayer.tsx";
import { RangeOverlay } from "./move/RangeOverlay.tsx";
import { PingLayer } from "./PingLayer.tsx";
import { PostFX, postfx } from "./PostFX.tsx";
import { frameStarted, measureTask } from "./perf.ts";
import { anchorShaders, pinPrograms, primeLights } from "./programs.ts";
import { setMaxAnisotropy } from "./resources.ts";
import { boundsFromJson } from "./scene.ts";
import { TableSurface } from "./TableSurface.tsx";
import { TestProbe } from "./TestProbe.tsx";
import { chooseTier, probeDevice, TIERS, TierGovernor, useTier } from "./tiers.ts";
import { MiniLightsLayer } from "./tokens/MiniLightsLayer.tsx";
import { TokensLayer } from "./tokens/TokensLayer.tsx";
import {
  closePolygon as closeFogPolygon,
  fogDown,
  fogEscape,
  fogMove,
  fogUp,
  useFogTool,
} from "./tools/fog.ts";
import { FogToolLayer, LightToolLayer } from "./tools/LightFogMarks.tsx";
import { lightsDown, lightsKey, lightsMove, lightsUp } from "./tools/lights.ts";
import { MeasureLayer } from "./tools/MeasureLayer.tsx";
import {
  clearMeasure,
  finish as finishMeasure,
  measureDown,
  measureMove,
  measureUp,
} from "./tools/measure.ts";
import { WallToolLayer } from "./tools/WallToolLayer.tsx";
import { useWallTool, wallsDoubleClick, wallsDown, wallsKey, wallsMove, wallsUp } from "./tools/walls.ts";
import { ZoneToolLayer } from "./tools/ZoneToolLayer.tsx";
import { zonesDoubleClick, zonesDown, zonesKey, zonesMove, zonesUp } from "./tools/zones.ts";
import { setVfxBounds } from "./vfx/bounds.ts";
import { EffectHandles } from "./vfx/EffectHandles.tsx";
import { EffectsLayer } from "./vfx/EffectsLayer.tsx";
import { VfxLayer } from "./vfx/VfxLayer.tsx";
import { fogUniforms } from "./vision/fogMaterial.ts";
import { SensedLayer } from "./vision/SensedLayer.tsx";
import { VisionLayer } from "./vision/VisionLayer.tsx";
import { useWarmup } from "./warmup/state.ts";
import { Warmup } from "./warmup/Warmup.tsx";

preloadBoardFonts();

/** Reads the device on the first frame, then adapts the tier from frame times (SPEC §8.4). */
function TierSetup() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const governor = useMemo(() => new TierGovernor(), []);
  const advance = useThree((s) => s.advance);
  // The travel freeze-frame: render one frame now (the full pipeline, post-processing included) and copy it in the
  // same task, while the drawing buffer still holds it.
  useEffect(() => {
    boardApi.snapshot = () => {
      try {
        advance(performance.now(), true);
        const src = gl.domElement;
        const c = document.createElement("canvas");
        c.width = src.width;
        c.height = src.height;
        c.getContext("2d")?.drawImage(src, 0, 0);
        return c;
      } catch {
        return null;
      }
    };
    return () => {
      boardApi.snapshot = () => null;
    };
  }, [gl, advance]);
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
  const continuing = useRef(false);
  useFrame((state, dt) => {
    frameStarted();
    // What the last frame compiled stays compiled (and its custom shaders' ids stay the same, programs.ts).
    if (pinPrograms(gl) > 0)
      anchorShaders(gl, state.scene, state.camera, state.scene, postfx.chain?.composer.inputBuffer ?? null);
    const now = performance.now();
    boardApi.frames++;
    // The first-load intro waits for this before fading the board up (SPEC §27.7).
    if (boardDiag.firstFrameAt === null) boardDiag.firstFrameAt = now;
    // On-demand frames: a frame measures rendering cost only if the previous one asked for it straight away (a
    // continuous run) — however long it took. A frame after an idle pause, or one paced for ambient motion, doesn't.
    // (This hook runs first each frame, so `takeRequested` sees what the previous frame's animations asked for.)
    const paced = takePacedFrame();
    const continuous = continuing.current || takeRequested();
    setFrameDelta(dt, continuous || paced);
    // The shader warm-up's frames are slow on purpose: the governor judges frames from when it's done.
    if (!paced && continuous && useWarmup.getState().phase === "done") governor.tick(dt);
    continuing.current = wantsNextFrame(now);
    if (continuing.current) state.invalidate();
    else scheduleAmbientFrame();
  }, -1);
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
  const prep = useEntities((s) => s.prep !== null);
  const tierName = useTier((s) => s.name);
  const tierChosen = useTier((s) => s.device !== null);
  const introOver = useIntro((s) => s.phase === "done");
  const warmed = useWarmup((s) => s.phase === "done");
  // (Decided at mount: the intro, while it plays, covers the board itself.)
  const [remounted] = useState(() => useIntro.getState().phase === "done");
  const hiddenForWarmup = remounted && introOver && !warmed;
  const tier = TIERS[tierName];
  const boundsJson = scene?.boundsJson;
  const bounds = useMemo(() => boundsFromJson(boundsJson), [boundsJson]);
  // The spell effects fade out at the map's edge (vfx/bounds.ts).
  useEffect(() => setVfxBounds(bounds), [bounds]);
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const [box, setBox] = useState<Box | null>(null);
  const press = useRef<{ x: number; y: number; empty: boolean; box: boolean } | null>(null);
  /** Grab-the-table pan: the table point under the pointer when the drag began stays under it. */
  const pan = useRef<{ pointerId: number; grab: { x: number; y: number } } | null>(null);
  const clipboard = useRef<string[]>([]);
  /** The pointer a Walls-tool press is using. */
  const walling = useRef<number | null>(null);
  /** The pointer a Zones-tool press is using. */
  const zoning = useRef<number | null>(null);
  const wallBox = useWallTool((s) => s.box);
  const tool = useUi((s) => s.tool);

  // Anything the board shows may have changed: draw for a moment (on-demand rendering, see frames.ts).
  useEffect(() => {
    const offs = [
      useEntities.subscribe(() => wake()),
      useUi.subscribe(() => wake()),
      useSettings.subscribe(() => wake()),
      // The tier, not its fps readout (that updates twice a second while frames run and would never let go).
      useTier.subscribe((s, prev) => {
        if (s.name !== prev.name || s.pinned !== prev.pinned) wake();
      }),
      useTable.subscribe(() => wake()),
    ];
    const onInput = () => wake();
    window.addEventListener("keydown", onInput);
    window.addEventListener("resize", onInput);
    return () => {
      for (const off of offs) off();
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("resize", onInput);
    };
  }, []);

  // Board keyboard: Esc clears; DM: Delete removes, Ctrl/Cmd+C/V copies and pastes at the cursor.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const ui = useUi.getState();
      // Aiming a spell: Esc cancels, Enter casts, [ and ] turn the template.
      if (ui.tool === "target" && targetKey(e)) {
        e.preventDefault();
        return;
      }
      // The Walls tool's keys (Esc/Enter finish, Backspace removes the last segment or the selection, Delete).
      if (ui.tool === "walls" && dm && wallsKey(e)) {
        e.preventDefault();
        return;
      }
      if (ui.tool === "zones" && dm && zonesKey(e)) {
        e.preventDefault();
        return;
      }
      if (ui.tool === "lights" && dm && lightsKey(e)) {
        e.preventDefault();
        return;
      }
      // Fog: Enter closes a polygon, Esc drops what's being drawn, [ and ] size the brush.
      if (ui.tool === "fog" && dm) {
        if (e.key === "Enter") closeFogPolygon();
        else if (e.key === "Escape" && !fogEscape()) ui.set({ tool: "select" });
        else if (e.key === "[" || e.key === "]") {
          const r = useFogTool.getState().radius;
          useFogTool.setState({ radius: Math.max(1, Math.min(20, r + (e.key === "]" ? 1 : -1))) });
          wake();
        } else if (e.key !== "Escape") return;
        e.preventDefault();
        return;
      }
      // Measuring: Enter finishes a ruler, Esc clears.
      if (ui.tool === "measure" && (e.key === "Enter" || e.key === "Escape")) {
        if (e.key === "Enter") finishMeasure();
        else if (!clearMeasure()) ui.set({ tool: "select" });
        e.preventDefault();
        return;
      }
      // Planning a move: Enter goes, Esc drops the waypoints and then the plan (before deselecting).
      if (moveKey(e)) {
        e.preventDefault();
        return;
      }
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => measureTask(() => pointerDown(e));
  const pointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Token presses stop propagation inside the canvas; anything reaching here without a token hit is the table.
    // Tokens set `hover` on pointer-over, so a press with a hovered token is a token press, not the table.
    wake();
    const tool = useUi.getState().tool;
    const panTool = tool === "pan";
    // Tools that draw or place with a left press (a press on empty table doesn't pan there).
    const drawing =
      tool === "measure" ||
      tool === "target" ||
      tool === "ping" ||
      tool === "walls" ||
      tool === "zones" ||
      tool === "fog" ||
      tool === "lights";
    // Did a token take this press? (Its handler runs first; see boardApi.claimedPointer.)
    const claimed = boardApi.claimedPointer === e.pointerId;
    boardApi.claimedPointer = null; // valid for this press only (a mouse's pointer id never changes)
    const onToken = !panTool && !cameraRig.spaceHeld && claimed;
    // Pan: middle-drag, Space+drag with any tool, the Pan tool, or a left-drag on empty table (mouse and pen;
    // one-finger touch pans through the camera controls with the other gestures).
    const panStart =
      e.pointerType !== "touch" &&
      (e.button === 1 ||
        (e.button === 0 &&
          (cameraRig.spaceHeld || panTool || (!onToken && !drawing && !(dm && e.shiftKey) && !e.altKey))));
    if (panStart) {
      const grab = boardApi.groundAt(e.clientX, e.clientY);
      if (grab) {
        pan.current = { pointerId: e.pointerId, grab };
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    }
    if (e.button !== 0) return;
    // Ping (SPEC §8.18): Alt+click, or a click with the Ping tool; the DM's Alt+Shift+click is the Spotlight.
    if ((e.altKey && !e.shiftKey && !onToken) || (tool === "ping" && !cameraRig.spaceHeld)) {
      const p = boardApi.groundAt(e.clientX, e.clientY);
      if (p) send("ping.send", { x: p.x, y: p.y });
      return;
    }
    if (dm && e.altKey && e.shiftKey) {
      const p = boardApi.groundAt(e.clientX, e.clientY);
      // Said only once the server has sent it: a refused one (at most one a second) says so instead.
      if (p)
        void request("camera.spotlight", { x: p.x, y: p.y })
          .then(() => toast.info("Spotlight", "Players who allow it are looking here."))
          .catch((err) =>
            toast.warning(
              "Spotlight",
              (err as { code?: string }).code === "RATE_LIMITED"
                ? "One spotlight a second — try again in a moment."
                : (err as Error).message,
            ),
          );
      return;
    }
    if (tool === "measure" && !cameraRig.spaceHeld) {
      measureDown(e.clientX, e.clientY);
      return;
    }
    // Aiming a spell: a click on the floor casts it there (a creature's own press picks it — TokenObject).
    if (tool === "target" && !cameraRig.spaceHeld && !onToken) {
      targetDown(e.clientX, e.clientY);
      return;
    }
    if (tool === "walls" && dm && !cameraRig.spaceHeld) {
      const n = e.nativeEvent;
      if (wallsDown(n)) {
        walling.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (tool === "zones" && dm && !cameraRig.spaceHeld) {
      if (zonesDown(e.nativeEvent)) {
        zoning.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    if ((tool === "fog" || tool === "lights") && dm && !cameraRig.spaceHeld) {
      if (tool === "fog" ? fogDown(e.nativeEvent) : lightsDown(e.nativeEvent)) {
        zoning.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    const boxSelect = dm && e.shiftKey && !onToken && !panTool && !cameraRig.spaceHeld;
    press.current = { x: e.clientX, y: e.clientY, empty: !onToken && !panTool, box: boxSelect };
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
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => measureTask(() => pointerMove(e));
  const pointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    wake(400);
    const drag = pan.current;
    if (drag && drag.pointerId === e.pointerId) {
      const now = boardApi.groundAt(e.clientX, e.clientY);
      if (now) cameraRig.panBy(drag.grab.x - now.x, drag.grab.y - now.y);
    }
    boardApi.cursor = boardApi.groundAt(e.clientX, e.clientY);
    const p = press.current;
    if (p?.box) setBox({ x0: p.x, y0: p.y, x1: e.clientX, y1: e.clientY });
    if (useUi.getState().tool === "measure") measureMove(e.clientX, e.clientY);
    if (useUi.getState().tool === "target" && !drag) targetMove(e.clientX, e.clientY);
    if (useUi.getState().tool === "walls" && dm && !drag) wallsMove(e.nativeEvent);
    if (useUi.getState().tool === "zones" && dm && !drag) zonesMove(e.nativeEvent);
    if (useUi.getState().tool === "fog" && dm && !drag) fogMove(e.nativeEvent);
    if (useUi.getState().tool === "lights" && dm && !drag) lightsMove(e.nativeEvent);
    // Hovering (nothing held): click-to-move previews a move for the selected token — over the table itself, not
    // over something laid on it (a label, a stepper, a pill).
    if (!p && !drag && e.buttons === 0) {
      if ((e.target as HTMLElement).tagName === "CANVAS")
        hoverBoard(e.clientX, e.clientY, useUi.getState().hover !== null);
      else leaveBoard();
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => measureTask(() => pointerUp(e));
  const pointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointerId === e.pointerId) pan.current = null;
    if (walling.current === e.pointerId) {
      walling.current = null;
      wallsUp();
    }
    if (zoning.current === e.pointerId) {
      zoning.current = null;
      const t = useUi.getState().tool;
      if (t === "fog") fogUp();
      else if (t === "lights") lightsUp();
      else zonesUp();
    }
    if (useUi.getState().tool === "measure") measureUp();
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
    // A click (not a pan) on empty table: with click-to-move, the selected token goes there (Ctrl/Cmd+click adds
    // a waypoint); otherwise it clears the selection.
    if (p.empty && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4 && !e.shiftKey) {
      if (clickFloor(e.clientX, e.clientY, e.ctrlKey || e.metaKey)) return;
      useUi.getState().select([]);
    }
  };

  return (
    <div
      className="absolute inset-0 bg-bg"
      data-testid="board"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={leaveBoard}
      onDoubleClick={(e) => {
        const t = useUi.getState().tool;
        if (t === "measure") finishMeasure();
        else if (t === "walls" && dm) wallsDoubleClick(e.nativeEvent);
        else if (t === "zones" && dm) zonesDoubleClick();
        else if (t === "fog" && dm && useFogTool.getState().shape === "polygon") closeFogPolygon();
        // Double-clicking a token opens its sheet (§8.5 Interaction).
        else if (t === "select") {
          const { hover } = useUi.getState();
          if (hover) openSheetFor(hover);
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={onDragOver}
      onWheel={(e) => {
        // Aiming a cone, a line or a cube: the wheel turns it (the camera's own wheel is off meanwhile).
        if (useUi.getState().tool === "target") targetWheel(e.deltaY);
        wake();
      }}
      onDrop={(e) => void onDrop(e)}
      style={{ cursor: tool === "pan" ? "grab" : undefined }}
    >
      <Canvas
        dpr={Math.min(window.devicePixelRatio || 1, tier.dpr)}
        shadows={tier.shadowMap ? { type: PCFShadowMap } : false}
        gl={{
          antialias: false,
          powerPreference: "high-performance",
          preserveDrawingBuffer: __GLOAM_TEST__,
          alpha: false,
        }}
        camera={{ fov: 40, near: 0.5, far: 4000, position: [30, 60, 90] }}
        frameloop="demand"
        style={{
          background: C.ink950,
          // Mounted again after the intro (back from the Admin console): hidden until the shader warm-up is done,
          // then faded in — the intro's candle covers only the first load (§24.7).
          opacity: hiddenForWarmup ? 0 : 1,
          transition: "opacity var(--dur-scene) var(--ease-out)",
        }}
        onCreated={({ gl }) => {
          gl.setClearColor(C.ink950);
          // The fog composite's fixed noise goes up with the renderer, not with a scene's first frame (§24.7: nothing
          // uploads or compiles mid-game).
          gl.initTexture(fogUniforms.gNoise.value);
        }}
      >
        <color attach="background" args={[C.ink950]} />
        <TierSetup />
        <CameraRig bounds={bounds} sceneId={scene?.id ?? "none"} />
        {/*
          Nothing draws until the device is read and the tier chosen (one effect after mount): a first frame at the
          default tier compiled a chain and shaders the chosen tier then threw away (§24.7).
        */}
        {tierChosen ? (
          <>
            {/*
              In dynamic fog the light levels are the fog composite's (§15.7: bright in full colour, dim at 55 %,
              darkness by sense): the rig lights at full for form and shading, as image maps are unlit (§24.3) — scaling
              it by the scene's darkness as well darkened torchlit ground twice. Off and painted keep the ambient's mood.
            */}
            <Contained>
              <Lighting
                bounds={bounds}
                ambient={scene?.fogMode === "dynamic" && !prep ? "bright" : (scene?.ambient ?? "bright")}
                tier={tier}
              />
            </Contained>
            <Contained>
              <TableSurface bounds={bounds} empty={!scene} />
            </Contained>
            <Contained>
              <DustMotes bounds={bounds} count={tier.dust} />
            </Contained>
            {/* Vision and light targets for the fog composite (drawn before the board each frame). */}
            <Contained>
              <VisionLayer bounds={bounds} />
            </Contained>
            <Contained>{scene ? <MapLayer scene={scene} bounds={bounds} /> : null}</Contained>
            <Contained>
              <Walls3DLayer />
            </Contained>
            <Contained>
              <TokensLayer />
              <MiniLightsLayer />
            </Contained>
            <Contained>
              <ZonesLayer />
            </Contained>
            {/* Lasting spell areas (§8.13) and casts' VFX (§24.5). */}
            <Contained>
              <EffectsLayer />
              <EffectHandles />
              <VfxLayer />
            </Contained>
            <Contained>
              <MoveLayer />
              <RangeOverlay />
              <TargetingLayer />
            </Contained>
            <Contained>
              <PingLayer />
            </Contained>
            <Contained>
              <MeasureLayer />
            </Contained>
            <Contained>
              <WallsLayer />
            </Contained>
            <Contained>
              <WallToolLayer />
            </Contained>
            <Contained>
              <ZoneToolLayer />
            </Contained>
            <Contained>
              <LightToolLayer />
            </Contained>
            <Contained>
              <FogToolLayer />
            </Contained>
            <Contained>
              <SensedLayer />
            </Contained>
            <Contained>
              <DoorsLayer />
            </Contained>
            <Contained>
              <MapAlignGizmo />
            </Contained>
            <ShadowSync enabled={tier.shadowMap > 0} />
            <Contained>
              <PostFX tier={tier} />
              {/* The 3D dice: their own scene over the board's, while there are dice to show (§8.9). */}
              <DiceOverlay tier={tier} />
            </Contained>
          </>
        ) : null}
        {tierChosen ? <Warmup bounds={bounds} /> : null}
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
      {wallBox ? (
        <div
          data-testid="wall-box"
          className="pointer-events-none fixed border border-accent bg-[var(--selection-fill)]"
          style={{
            left: Math.min(wallBox.x0, wallBox.x1),
            top: Math.min(wallBox.y0, wallBox.y1),
            width: Math.abs(wallBox.x1 - wallBox.x0),
            height: Math.abs(wallBox.y1 - wallBox.y0),
          }}
        />
      ) : null}
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

/**
 * A board layer in its own Suspense boundary: whatever in it suspends (a font, a texture) waits in its place. A
 * suspension reaching the canvas's root would be handed up to the page, hiding the whole board (display: none),
 * stopping the frame loop and cleaning up the camera rig's layout effects (its controls then read as absent).
 */
function Contained({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

/**
 * Keeps the renderer's shadow map in step with the tier (Low turns shadow maps off, AC-BRD-03). Always PCF: three
 * r18x removed PCFSoftShadowMap (it warns and falls back); Ultra's softer edge is the key light's `shadow.radius`
 * (Lighting), so every shadowed tier shares one set of shader programs.
 */
function ShadowSync({ enabled }: { enabled: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    gl.shadowMap.enabled = enabled;
    gl.shadowMap.type = PCFShadowMap;
    gl.shadowMap.needsUpdate = true;
    scene.traverse((o) => {
      const m = (o as { material?: { needsUpdate: boolean } | { needsUpdate: boolean }[] }).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true;
    });
    // The key light casts now (or no longer): the next shadow pass sees that (programs.ts primeLights).
    primeLights(gl, camera, scene);
  }, [enabled, gl, scene, camera]);
  return null;
}
