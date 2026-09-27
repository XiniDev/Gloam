import { TransformControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type ComponentRef, useRef } from "react";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { toast } from "../../ui/Toast.tsx";
import { cameraRig } from "../CameraRig.tsx";
import { transformOf, useMapAlign } from "./mapAlign.ts";

type TransformControlsImpl = ComponentRef<typeof TransformControls>;

/**
 * The 3D map alignment gizmo (SPEC §8.3; AC-SCN-04): move (X/Y/Z), rotate about Y only, uniform scale. The camera
 * stops listening while a handle is hovered or dragged; letting go saves the placement with `scene.calibrate`.
 */
export function MapAlignGizmo() {
  const scene = useBoard((d) => d.scene);
  const mapTool = useUi((s) => s.mapTool);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const object = useMapAlign((s) => s.object);
  const mode = useMapAlign((s) => s.mode);
  const ref = useRef<TransformControlsImpl>(null);
  const blocking = useRef(false);
  const prevScale = useRef(1);

  // Hovering a handle must not start a camera pan underneath it.
  useFrame(() => {
    // `axis` (the hovered handle) and `dragging` are runtime fields three-stdlib's typings mark private.
    const tc = ref.current as unknown as { axis: string | null; dragging: boolean } | null;
    const want = !!tc && (tc.axis !== null || tc.dragging);
    if (want === blocking.current) return;
    blocking.current = want;
    const c = cameraRig.controls;
    if (c) c.enabled = !want;
  });

  if (!dm || !scene || scene.mapKind !== "model" || mapTool !== scene.id || !object) return null;
  return (
    <TransformControls
      ref={ref}
      object={object}
      mode={mode}
      space="world"
      showX={mode !== "rotate"}
      showZ={mode !== "rotate"}
      size={0.9}
      onMouseDown={() => {
        prevScale.current = object.scale.x;
      }}
      onObjectChange={() => {
        // Only rotation about Y, only uniform scale (whichever axis handle was used).
        object.rotation.x = 0;
        object.rotation.z = 0;
        if (mode === "scale") {
          const p = prevScale.current;
          const s = [object.scale.x, object.scale.y, object.scale.z].reduce((a, b) =>
            Math.abs(b - p) > Math.abs(a - p) ? b : a,
          );
          object.scale.setScalar(Math.max(0.001, s));
        }
        useMapAlign.getState().set({ live: transformOf(object) });
      }}
      onMouseUp={() => {
        const transform = transformOf(object);
        useMapAlign.getState().set({ live: null });
        void request("scene.calibrate", { sceneId: scene.id, transform }).catch((e) =>
          toast.danger("Couldn't move the map", (e as Error).message),
        );
      }}
    />
  );
}
