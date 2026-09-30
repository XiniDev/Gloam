import type { HpFx } from "@gloam/shared/protocol";
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { hpFx } from "../../net/health.ts";
import { playOnBoard } from "../boardSound.ts";
import { again } from "../frames.ts";

/** Damage types that land as a blow (SPEC §31 "Melee hit"). */
const PHYSICAL = new Set<string>(["bludgeoning", "piercing", "slashing"]);

/**
 * HP feedback on the board (SPEC §8.11 Feedback; AC-HP-11), for everyone who can see the token (the server sends
 * `hp.fx` to them alone): a short shake and a red flash on a hit, a warm glow on healing (TokenObject plays them from
 * `tokenFx`), the fall when it goes down or dies (TokenObject animates the lie-down), and the matching sounds. The
 * floating numbers are the HUD's (hud/HpNumbers.tsx): crisp at any zoom, rising above the plate.
 */

/** How far each token has fallen (0 standing … 1 lying; diagnostics for the tests). */
export const lieOf = new Map<string, number>();

/** What a token is playing now (TokenObject reads it each frame): the kind and when it began. */
/**
 * Each token's running shake / flash / glow: its kind, when it started, and how far it has played (ms of drawn time —
 * each frame counts at most 1/30 s, so a slow machine still draws every part of it instead of skipping to the end).
 */
export const tokenFx = new Map<string, { kind: "hit" | "heal"; at: number; played: number }>();
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
          tokenFx.set(f.tokenId, { kind, at: now, played: 0 });
          if (__GLOAM_TEST__) fxPlayed.push({ tokenId: f.tokenId, kind });
        }
        // The sounds — a hit, a heal, a fall (the heaviest) — for a token on this client's board.
        const at = scene.getObjectByName(`token:${f.tokenId}`)?.position;
        if (at) {
          const where = { x: at.x, y: at.z, z: at.y };
          if (f.dead || f.down) playOnBoard("down", where);
          else if (f.kind === "damage" && f.amount > 0) {
            // A blow (bludgeoning, piercing, slashing): the hit, then the crunch 40 ms after and 3 dB under it.
            const blow = PHYSICAL.has(f.parts?.[0]?.type ?? "untyped");
            if (blow) playOnBoard("meleeHit", where);
            playOnBoard("damage", where, blow ? { delay: 0.04, gain: 0.71 } : {});
          } else if (f.kind === "heal" && f.amount > 0) playOnBoard("heal", where);
        }
        again();
      }),
    [scene],
  );
  return null;
}
