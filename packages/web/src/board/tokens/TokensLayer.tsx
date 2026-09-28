import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useReducer } from "react";
import { useBoardCovers, useHudObstacles } from "../../hud/insets.ts";
import { useTable } from "../../net/table.ts";
import { boardData, useBoard, useEntities } from "../../state/entities.ts";
import { useViewAs } from "../../state/viewAs.ts";
import { boardApi } from "../boardApi.ts";
import { setTokenPositionLookup } from "../CameraRig.tsx";
import { again } from "../frames.ts";
import { ghostTokens, onGhosts } from "../move/anims.ts";
import { layoutOverlays } from "./declutter.ts";
import { HpFxLayer } from "./hpFx.tsx";
import { TokenObject } from "./TokenObject.tsx";

/**
 * Base heights apart (ft): above the depth buffer's resolution out to ~280 ft (near plane 0.5 ft, 24 bits: z² / (0.5 ·
 * 2²⁴)), beyond which a token is a few pixels; eight levels stay under a tenth of a foot, too little to see.
 */
const STACK_FT = 0.01;
const STACK_LEVELS = 8;

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

  // Where bases overlap, a fixed order on top: each token lifted a hair by its rank — larger creatures lower, so one
  // sharing a big creature's space sits on it — instead of coplanar faces fighting as the camera moves.
  const stack = useMemo(() => {
    const ids = [...tokens.values()].sort((a, b) => b.sizeFt - a.sizeFt || (a.id < b.id ? -1 : 1));
    return new Map(ids.map((t, i) => [t.id, (i % STACK_LEVELS) * STACK_FT]));
  }, [tokens]);

  useEffect(() => {
    setTokenPositionLookup((id) => boardData(useEntities.getState()).tokens.get(id)?.pos ?? null);
  }, []);

  // The HUD moving over the board (the dock opening, a card arriving) makes plates move: a frame to lay them out.
  useEffect(() => {
    const offA = useHudObstacles.subscribe(() => again());
    const offB = useBoardCovers.subscribe(() => again());
    return () => {
      offA();
      offB();
    };
  }, []);

  // After every overlay has placed itself this frame: decide which ones have room on screen (declutter.ts).
  useFrame((state) => {
    const covered = [
      ...Object.values(useHudObstacles.getState().rects),
      ...Object.values(useBoardCovers.getState().rects),
    ].map((r) => ({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }));
    if (layoutOverlays(state.camera, state.size.width, state.size.height, covered)) again();
  });

  return (
    <>
      {/* HP feedback (AC-HP-11): the floating numbers, outside the tokens (never picked, never measured with them). */}
      <HpFxLayer />
      <group
        name="tokens"
        ref={(g) => {
          boardApi.tokens = g;
        }}
      >
        {[...tokens.values()]
          .filter((t) => !as || as.has(t.id))
          .map((t) => (
            <TokenObject key={t.id} token={t} viewer={viewer} lift={stack.get(t.id) ?? 0} />
          ))}
        {[...ghosts.values()]
          .filter((g) => !tokens.has(g.id))
          .map((g) => (
            <TokenObject key={`ghost:${g.id}`} token={g} viewer={viewer} />
          ))}
      </group>
    </>
  );
}
