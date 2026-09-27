import type { WallView } from "@gloam/shared/state";
import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { Sprite } from "three";
import { audio } from "../../audio/engine.ts";
import { request, useTable } from "../../net/table.ts";
import { boardData, useBoard, useEntities } from "../../state/entities.ts";
import { toast } from "../../ui/Toast.tsx";
import { boardApi } from "../boardApi.ts";
import { again, wake } from "../frames.ts";
import { doorIconTexture } from "../tokens/glyphs.ts";

/**
 * Door handles (SPEC §8.7 Doors; AC-WAL-03): a handle icon at the middle of every door this viewer knows — shut,
 * open or locked. Clicking one works the door (players: within 5 ft of a token they control; the server decides);
 * Shift+click locks or unlocks it (DMs). A locked door rattles and its lock shakes. Door changes play their sound
 * for everyone who can see the door.
 */
export function DoorsLayer() {
  const walls = useBoard((d) => d.walls);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const doors = [...walls.values()].filter((w) => isDoor(w, dm));
  useDoorSounds();
  return (
    <group name="doors">
      {doors.map((w) => (
        <DoorHandle key={w.id} wall={w} dm={dm} />
      ))}
    </group>
  );
}

const isDoor = (w: WallView, dm: boolean) =>
  (dm ? (w.dmKind ?? w.kind) : w.kind) === "door" || (dm && w.dmKind === "secret");

function DoorHandle({ wall, dm }: { wall: WallView; dm: boolean }) {
  const state = (wall.door || "closed") as "closed" | "open" | "locked";
  const sprite = useRef<Sprite>(null);
  const shake = useRef(0);
  const x = (wall.ax + wall.bx) / 2;
  const y = (wall.ay + wall.by) / 2;
  const onDown = async (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return;
    e.stopPropagation();
    boardApi.claimedPointer = e.nativeEvent.pointerId;
    const action = dm && e.nativeEvent.shiftKey ? (state === "locked" ? "unlock" : "lock") : "toggle";
    try {
      await request("door.toggle", { wallId: wall.id, action });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "BLOCKED") {
        // Locked: rattle, and the lock shakes.
        audio.play("lockRattle");
        shake.current = performance.now();
        wake(600);
      } else toast.info("Can't reach that door", (err as Error).message);
    }
  };
  // The shake: a quick horizontal wobble over 400 ms.
  const onFrame = () => {
    const s = sprite.current;
    if (!s) return;
    const t = performance.now() - shake.current;
    s.position.x = t < 400 ? Math.sin(t / 22) * 0.18 * (1 - t / 400) : 0;
    if (t < 400) again();
  };
  return (
    <group position={[x, 0.9, y]} userData={{ part: "doorHandle", wallId: wall.id, doorState: state }}>
      <sprite
        ref={sprite}
        scale={[1.1, 1.1, 1.1]}
        renderOrder={25}
        onPointerDown={onDown}
        onBeforeRender={onFrame}
        onPointerOver={() => {
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "";
        }}
      >
        <spriteMaterial map={doorIconTexture(state)} depthTest={false} transparent />
      </sprite>
    </group>
  );
}

/** Door open/close sounds: when a door this viewer knows changes state. */
function useDoorSounds() {
  useEffect(() => {
    let prev = boardData(useEntities.getState()).walls;
    return useEntities.subscribe((s) => {
      const walls = boardData(s).walls;
      if (walls === prev) return;
      for (const [id, w] of walls) {
        const before = prev.get(id);
        if (!before || before.door === w.door || !w.door || !before.door) continue;
        if (w.door === "open") audio.play("doorOpen");
        else if (before.door === "open") audio.play("doorClose");
      }
      prev = walls;
    });
  }, []);
}
