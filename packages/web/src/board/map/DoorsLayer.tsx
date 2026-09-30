import type { WallView } from "@gloam/shared/state";
import { type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { type Sprite, Vector3 } from "three";
import { stringSeed } from "../../audio/synth.ts";
import { request, useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { knownAt, useFog } from "../../state/fog.ts";
import { prefersReducedMotion } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { useDmView } from "../../state/viewAs.ts";
import { toast } from "../../ui/Toast.tsx";
import { boardApi } from "../boardApi.ts";
import { playOnBoard } from "../boardSound.ts";
import { again, wake } from "../frames.ts";
import { doorIconTexture } from "../tokens/glyphs.ts";
import { isSpecimen } from "../warmup/specimens.ts";
import { useDrawn } from "../warmup/state.ts";

/** A door's middle on the table (where its sounds come from). */
const mid = (w: WallView) => ({ x: (w.ax + w.bx) / 2, y: (w.ay + w.by) / 2 });

/**
 * Door handles (SPEC §8.7 Doors; AC-WAL-03): a handle icon at the middle of every door this viewer knows — shut,
 * open or locked. Clicking one works the door (players: within 5 ft of a token they control; the server decides);
 * Shift+click locks or unlocks it (DMs). A locked door rattles and its lock shakes. Door changes play their sound
 * for everyone who can see the door.
 */
export function DoorsLayer() {
  const walls = useDrawn("walls");
  const dm = useDmView();
  const me = useTable((s) => s.me?.userId ?? null);
  // A player sees a door's handle only where they know the ground on either side of it (not out of the unknown).
  useFog((s) => s.version);
  // (The shader warm-up's doors show their handles to anyone: their sprites' programs are compiled then.)
  const doors = [...walls.values()].filter(
    (w) => isDoor(w, dm) && (dm || isSpecimen(w.id) || doorKnown(w, me)),
  );
  useDoorSounds();
  return (
    <group name="doors">
      {doors.map((w) => (
        <DoorHandle key={w.id} wall={w} dm={dm} />
      ))}
    </group>
  );
}

function doorKnown(w: WallView, me: string | null): boolean {
  const mx = (w.ax + w.bx) / 2;
  const my = (w.ay + w.by) / 2;
  const L = Math.hypot(w.bx - w.ax, w.by - w.ay) || 1;
  const nx = -(w.by - w.ay) / L;
  const ny = (w.bx - w.ax) / L;
  return knownAt(mx + nx, my + ny, me) || knownAt(mx - nx, my - ny, me);
}

const isDoor = (w: WallView, dm: boolean) =>
  (dm ? (w.dmKind ?? w.kind) : w.kind) === "door" || (dm && w.dmKind === "secret");

const HANDLE_FT = 1.1;
/** The press area never smaller on screen than a button (28 px; 44 px for touch)... */
const minHitPx = () =>
  typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches ? 44 : 28;
/** ...while the handle drawn in it can be smaller when zoomed out, so it never outgrows the tokens round it. */
const MIN_GLYPH_PX = 20;
const here = new Vector3();
const right = new Vector3();
const beside = new Vector3();

function DoorHandle({ wall, dm }: { wall: WallView; dm: boolean }) {
  const state = ((dm ? wall.dmDoor || wall.door : wall.door) || "closed") as "closed" | "open" | "locked";
  const sprite = useRef<Sprite>(null);
  const hit = useRef<Sprite>(null);
  const shake = useRef(0);
  const x = (wall.ax + wall.bx) / 2;
  const y = (wall.ay + wall.by) / 2;
  const onDown = async (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return;
    // With the Walls tool a press here edits the door's wall (the board takes it).
    if (useUi.getState().tool === "walls") return;
    e.stopPropagation();
    boardApi.claimedPointer = e.nativeEvent.pointerId;
    const action = dm && e.nativeEvent.shiftKey ? (state === "locked" ? "unlock" : "lock") : "toggle";
    try {
      await request("door.toggle", { wallId: wall.id, action });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "BLOCKED") {
        // Locked: rattle, and the lock shakes — and says so in words, for anyone who hears nothing or (with reduced
        // motion) sees no shake (AC-A11Y-05).
        playOnBoard("lockRattle", mid(wall));
        shake.current = performance.now();
        wake(600);
        toast.info("The door is locked");
      } else toast.info("Can't reach that door", (err as Error).message);
    }
  };
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useFrame(() => {
    const s = sprite.current;
    if (!s) return;
    // The shake: a quick horizontal wobble over 400 ms.
    const t = performance.now() - shake.current;
    // (Never with reduced motion: the rattle's sound says it — AC-A11Y-02.)
    s.position.x = t < 400 && !prefersReducedMotion() ? Math.sin(t / 22) * 0.18 * (1 - t / 400) : 0;
    if (t < 400) again();
    // Never smaller on screen than a button (28 px; 44 px for touch), however far the camera is.
    here.set(x, 0.9, y).project(camera);
    right
      .set(1, 0, 0)
      .applyQuaternion(camera.quaternion)
      .add(beside.set(x, 0.9, y))
      .project(camera);
    const ppf = (Math.hypot(right.x - here.x, right.y - here.y) * size.width) / 2;
    const k = ppf > 0 ? Math.max(HANDLE_FT, MIN_GLYPH_PX / ppf) : HANDLE_FT;
    if (Math.abs(s.scale.x - k) > 1e-3) s.scale.setScalar(k);
    const h = hit.current;
    const kh = ppf > 0 ? Math.max(HANDLE_FT, minHitPx() / ppf) : HANDLE_FT;
    if (h && Math.abs(h.scale.x - kh) > 1e-3) h.scale.setScalar(kh);
  });
  return (
    <group position={[x, 0.9, y]} userData={{ part: "doorHandle", wallId: wall.id, doorState: state }}>
      <sprite
        ref={hit}
        scale={[HANDLE_FT, HANDLE_FT, HANDLE_FT]}
        onPointerDown={onDown}
        onPointerOver={() => {
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "";
        }}
      >
        {/* The press area: drawn nowhere (not even into depth), picked by the pointer. */}
        <spriteMaterial transparent opacity={0} depthTest={false} depthWrite={false} colorWrite={false} />
      </sprite>
      <sprite ref={sprite} scale={[HANDLE_FT, HANDLE_FT, HANDLE_FT]} renderOrder={25} raycast={() => null}>
        <spriteMaterial map={doorIconTexture(state)} depthTest={false} transparent />
      </sprite>
    </group>
  );
}

/** Door open/close sounds: when a door this viewer knows changes state. */
/**
 * The door state a viewer hears: the truth for DMs (secret and hidden doors), what players see for players — a
 * revealed secret door is a wall one moment and an open door the next, so a wall counts as shut.
 */
const doorSound = (w: WallView) => w.dmDoor || w.door || (w.kind === "wall" ? "closed" : "");

function useDoorSounds() {
  useEffect(() => {
    let prev = boardData(useEntities.getState()).walls;
    return useEntities.subscribe((s) => {
      const walls = boardData(s).walls;
      if (walls === prev) return;
      for (const [id, w] of walls) {
        const before = prev.get(id);
        const now = doorSound(w);
        const was = before && doorSound(before);
        if (!now || !was || now === was) continue;
        // Each door its own creak: seeded by its id.
        if (now === "open") playOnBoard("doorOpen", mid(w), { seed: stringSeed(id) });
        else if (was === "open") playOnBoard("doorClose", mid(w));
      }
      prev = walls;
    });
  }, []);
}
