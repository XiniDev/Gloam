import type { P } from "../geometry/index.ts";
import type { Side } from "./creatures.ts";

/**
 * Opportunity-attack warnings (SPEC §8.6, §34.6; AC-MOV-15): a hint on a planned path wherever it leaves the reach of
 * a hostile creature the mover can see — "within reach" measured from the edge of one base to the edge of the other
 * (reach 5 ft by default, or the creature's own). A creature that can't take reactions (Incapacitated) threatens no
 * one; a mover that has taken the Disengage action provokes none.
 */

export interface Threat {
  id: string;
  name: string;
  pos: P;
  sizeFt: number;
  reachFt: number;
  disposition: Side;
  incapacitated: boolean;
}

/** Whether `other` is hostile to a mover on side `mover` (the party and its friends against the hostiles). */
export function hostileTo(mover: Side, other: Side): boolean {
  const friendly = (s: Side) => s === "party" || s === "friendly";
  return (friendly(mover) && other === "hostile") || (mover === "hostile" && friendly(other));
}

export interface OpportunityMark {
  /** Where the path leaves the threat's reach. */
  at: P;
  byId: string;
  byName: string;
}

const within = (p: P, moverR: number, t: Threat) =>
  Math.hypot(p.x - t.pos.x, p.y - t.pos.y) - moverR - t.sizeFt / 2 <= t.reachFt + 1e-6;

/** Where along a path the mover leaves each hostile's reach (once per threat per departure). */
export function opportunityMarks(
  path: readonly P[],
  mover: { sizeFt: number; disposition: Side; disengaged: boolean },
  threats: readonly Threat[],
): OpportunityMark[] {
  if (mover.disengaged || path.length < 2) return [];
  const r = mover.sizeFt / 2;
  const out: OpportunityMark[] = [];
  for (const t of threats) {
    if (t.incapacitated || !hostileTo(mover.disposition, t.disposition)) continue;
    let inside = within(path[0] as P, r, t);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as P;
      const b = path[i] as P;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(len / 0.5));
      let prev = a;
      for (let s = 1; s <= steps; s++) {
        const q = { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps };
        const now = within(q, r, t);
        if (inside && !now) {
          // Bisect between the last point inside and the first outside for the exit.
          let lo = prev;
          let hi = q;
          for (let k = 0; k < 20; k++) {
            const m = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
            if (within(m, r, t)) lo = m;
            else hi = m;
          }
          out.push({ at: hi, byId: t.id, byName: t.name });
        }
        inside = now;
        prev = q;
      }
    }
  }
  return out;
}
