import { useFrame } from "@react-three/fiber";
import { useEffect } from "react";
import { useTable } from "../../net/table.ts";
import { boardData, useBoard, useEntities } from "../../state/entities.ts";
import { setTokenPositionLookup } from "../CameraRig.tsx";
import { again } from "../frames.ts";
import { layoutOverlays } from "./declutter.ts";
import { TokenObject } from "./TokenObject.tsx";

/** Every token the viewer may see (SPEC §24.1 TokensLayer). */
export function TokensLayer() {
  const tokens = useBoard((d) => d.tokens);
  const me = useTable((s) => s.me);
  const viewer = { userId: me?.userId ?? "", dm: me?.role === "dm" || me?.role === "admin" };

  useEffect(() => {
    setTokenPositionLookup((id) => boardData(useEntities.getState()).tokens.get(id)?.pos ?? null);
  }, []);

  // After every overlay has placed itself this frame: decide which ones have room on screen (declutter.ts).
  useFrame((state) => {
    if (layoutOverlays(state.camera, state.size.width, state.size.height)) again();
  });

  return (
    <group name="tokens">
      {[...tokens.values()].map((t) => (
        <TokenObject key={t.id} token={t} viewer={viewer} />
      ))}
    </group>
  );
}
