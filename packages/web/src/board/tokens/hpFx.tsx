import type { HpFx } from "@gloam/shared/protocol";
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { audio } from "../../audio/engine.ts";
import { hpFx } from "../../net/health.ts";
import { again } from "../frames.ts";

/**
 * HP feedback on the board (SPEC §8.11 Feedback; AC-HP-11), for everyone who can see the token (the server sends
 * `hp.fx` to them alone): a short shake and a red flash on a hit, a warm glow on healing (TokenObject plays them from
 * `tokenFx`), the fall when it goes down or dies (TokenObject animates the lie-down), and the matching sounds. The
 * floating numbers are the HUD's (hud/HpNumbers.tsx): crisp at any zoom, rising above the plate.
 */

/** How far each token has fallen (0 standing … 1 lying; diagnostics for the tests). */
export const lieOf = new Map<string, number>();

/** What a token is playing now (TokenObject reads it each frame): the kind and when it began. */
export const tokenFx = new Map<string, { kind: "hit" | "heal"; at: number }>();
/** Every shake / flash / glow started (tests: which token, which kind). */
export const fxPlayed: { tokenId: string; kind: "hit" | "heal" }[] = [];

/** Starts each HP change's shake / flash / glow and its sound. */
export function HpFxLayer() {
  const scene = useThree((s) => s.scene);
  useEffect(
    () =>
      hpFx.on((f: HpFx) => {
        const now = performance.now();
        const kind =
          f.kind === "damage" && f.amount > 0 ? "hit" : f.kind === "heal" && f.amount > 0 ? "heal" : null;
        // Only a token this client has on its board plays (the server sends to its viewers alone anyway).
        if (kind && scene.getObjectByName(`token:${f.tokenId}`)) {
          tokenFx.set(f.tokenId, { kind, at: now });
          if (__GLOAM_TEST__) fxPlayed.push({ tokenId: f.tokenId, kind });
        }
        // The sounds — a hit, a heal, a fall (the heaviest) — for a token on this client's board.
        if (scene.getObjectByName(`token:${f.tokenId}`)) {
          if (f.dead || f.down) void audio.play("down");
          else if (f.kind === "damage" && f.amount > 0) void audio.play("damage");
          else if (f.kind === "heal" && f.amount > 0) void audio.play("heal");
        }
        again();
      }),
    [scene],
  );
  return null;
}
