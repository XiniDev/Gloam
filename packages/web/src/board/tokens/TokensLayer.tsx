import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useReducer } from "react";
import { useTable } from "../../net/table.ts";
import { boardData, useBoard, useEntities } from "../../state/entities.ts";
import { useViewAs } from "../../state/viewAs.ts";
import { boardApi } from "../boardApi.ts";
import { setTokenPositionLookup } from "../CameraRig.tsx";
import { again } from "../frames.ts";
import { ghostTokens, onGhosts } from "../move/anims.ts";
import { layoutOverlays } from "./declutter.ts";
import { TokenObject } from "./TokenObject.tsx";

/** Every token the viewer may see (SPEC §24.1 TokensLayer). */
export function TokensLayer() {
  const tokens = useBoard((d) => d.tokens);
  // Creatures seen leaving (or crossing) this viewer's view mid-move, drawn until they fade (move/anims.ts).
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onGhosts(redraw), []);
  const ghosts = ghostTokens();
  // Viewing as a player: exactly the tokens that player holds.
  const asData = useViewAs((s) => (s.userId ? s.data : null));
  const as = useMemo(() => (asData ? new Set(asData.tokens) : null), [asData]);
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
    <group
      name="tokens"
      ref={(g) => {
        boardApi.tokens = g;
      }}
    >
      {[...tokens.values()]
        .filter((t) => !as || as.has(t.id))
        .map((t) => (
          <TokenObject key={t.id} token={t} viewer={viewer} />
        ))}
      {[...ghosts.values()]
        .filter((g) => !tokens.has(g.id))
        .map((g) => (
          <TokenObject key={`ghost:${g.id}`} token={g} viewer={viewer} />
        ))}
    </group>
  );
}
