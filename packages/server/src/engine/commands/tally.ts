import type { CombatData } from "@gloam/shared/rules";
import type { CommandCtx } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { setPathOp } from "../plan.ts";

/** HP one command took from each creature, and who dropped to 0 (in order). */
export interface Hurt {
  taken: Map<string, number>;
  downed: string[];
}

/**
 * The combat summary's tally (AC-CMB-07): the HP each combatant lost, what the creature whose turn it was dealt, and
 * who dropped to 0 — for damage applied while a combat runs on the scene. Written path by path, so an undo of the
 * damage takes its tally back and never clashes with the turn's own bookkeeping.
 */
export function tallyOps(ctx: CommandCtx, hurt: Hurt): Op[] {
  const scene = ctx.model.activeScene;
  const combat = scene ? ctx.model.inScene("combat", scene.id).find((c) => c.active) : undefined;
  if (!combat) return [];
  const d = combat.data as Partial<CombatData>;
  const combatants = new Set((d.combatants ?? []).map((e) => e.tokenId));
  const tally = d.tally ?? { dealt: {}, taken: {}, downed: [] };
  const ops: (Op | null)[] = [];
  let dealt = 0;
  for (const [id, hp] of hurt.taken) {
    if (!combatants.has(id) || hp <= 0) continue;
    ops.push(setPathOp("combat", combat, ["data", "tally", "taken", id], (tally.taken[id] ?? 0) + hp));
    dealt += hp;
  }
  // Dealt by the creature whose turn it is (damage in its turn is its doing, as far as the table can tell).
  const active = d.begun ? d.combatants?.[combat.turnIndex]?.tokenId : undefined;
  if (active && dealt > 0)
    ops.push(
      setPathOp("combat", combat, ["data", "tally", "dealt", active], (tally.dealt[active] ?? 0) + dealt),
    );
  const down = hurt.downed.filter((id) => combatants.has(id) && !tally.downed.includes(id));
  if (down.length)
    ops.push(setPathOp("combat", combat, ["data", "tally", "downed"], [...tally.downed, ...down]));
  return ops.filter((o): o is Op => o !== null);
}
