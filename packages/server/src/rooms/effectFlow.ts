/**
 * Persistent effects over time (SPEC §8.13 Persistent effects; AC-SPL-08): what each fires as creatures move and turns
 * pass, and what the clock does to them. A creature starting or ending its turn inside one, entering it (walking in, or
 * the effect moved or drifting onto it), or moving within it (per 5 ft: Spike Growth) sets off the effect's trigger —
 * a resolution card for the DM (`cast.trigger`), once per creature per turn for each trigger. At the start of its
 * caster's turn an effect whose rounds are up ends (its concentration with it), and one that drifts (Cloudkill) moves
 * 10 ft away from its caster — each as a command of its own, the DM's to undo.
 */
import { type AreaShape as Area, contains, footprint, resolveArea } from "@gloam/shared/aoe";
import type { P } from "@gloam/shared/geometry";
import { durationExpired } from "@gloam/shared/rules";
import type { AreaShape, EffectEntity, TokenEntity } from "@gloam/shared/schemas";
import type { CommandActor, CommandBus } from "../engine/commandBus.ts";
import { type CombatTurn, combatOn, dataOf } from "../engine/commands/combat.ts";
import { SYSTEM_ACTOR } from "../engine/commands/party.ts";
import { bodyOf, effectAt } from "../engine/commands/spells.ts";
import type { CampaignModel } from "../engine/model.ts";
import { roomCtx } from "./roomContext.ts";

export interface EffectHost {
  model(): CampaignModel;
  bus(): CommandBus;
  /** A DM at the table to act as (the drift, the end of an effect), or the system. */
  dmActor(): CommandActor;
  toDms(type: string, payload: unknown): void;
}

/** The area of an effect now (an emanation where its creature stands). */
function areaOf(model: CampaignModel, e: EffectEntity): Area | null {
  return resolveArea(e.shape, (id) => {
    const t = model.get("token", id);
    return t ? bodyOf(t) : null;
  });
}

/** Whether a creature's base is in an area (any part of it, as for a spell's area, §17.3). */
function inside(a: Area, t: TokenEntity): boolean {
  return baseIn(footprint(a), t.pos, t.sizeFt / 2);
}

/**
 * Whether a creature's base standing at `p` is in a footprint: any part of it (§17.3) — but a wall's own space only
 * with its centre in it (a creature beside a wall drawn on a grid line isn't in the wall, SRD Wall of Fire p. 172:
 * "the other side of the wall deals no damage").
 */
function baseIn(f: ReturnType<typeof footprint>, p: P, r: number): boolean {
  if (f.kind === "circle") return Math.hypot(p.x - f.c.x, p.y - f.c.y) < f.r + r;
  if (f.kind === "strip") return contains(f, p);
  return contains(f, p) || sampleRim(p, r).some((q) => contains(f, q));
}

/** Whether a step from p to q crosses a wall's line (walking through a 1-ft wall between two samples). */
function crossesStrip(f: ReturnType<typeof footprint>, p: P, q: P): boolean {
  if (f.kind !== "strip") return false;
  const pts = f.closed && f.points.length > 2 ? [...f.points, f.points[0] as P] : f.points;
  const o = (u: P, v: P, w: P) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as P;
    const b = pts[i] as P;
    if (o(a, b, p) * o(a, b, q) < 0 && o(p, q, a) * o(p, q, b) < 0) return true;
  }
  return false;
}

/**
 * Whether a creature is within `reach` ft of a wall's damaging side (SRD Wall of Fire: "within 10 feet of that side").
 * The side is the left of each drawn segment (facing from its start to its end, y down: left is (dy, −dx)) — "right"
 * the other; a creature counts from its space's nearest edge.
 */
function onDamagingSide(w: Extract<AreaShape, { kind: "wall" }>, t: TokenEntity, reach: number): boolean {
  const side = w.damagingSide ?? "left";
  const n = w.points.length;
  const r = t.sizeFt / 2;
  for (let i = 0; i + 1 < n + (w.closed ? 1 : 0); i++) {
    const a = w.points[i] as P;
    const b = w.points[(i + 1) % n] as P;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const u = ((t.pos.x - a.x) * dx + (t.pos.y - a.y) * dy) / (len * len);
    if (u < -r / len || u > 1 + r / len) continue;
    // Signed distance off the line: + on the left.
    const s = ((t.pos.x - a.x) * dy - (t.pos.y - a.y) * dx) / len;
    const off = side === "right" ? -s : s;
    if (side === "both" ? Math.abs(s) - r <= reach : off > -r && off - r <= reach) return true;
  }
  return false;
}

const sampleRim = (c: P, r: number): P[] =>
  Array.from({ length: 8 }, (_, k) => ({
    x: c.x + Math.cos((k / 8) * 2 * Math.PI) * r * 0.9,
    y: c.y + Math.sin((k / 8) * 2 * Math.PI) * r * 0.9,
  }));

export class EffectFlow {
  private readonly host: EffectHost;
  /** Triggers already fired this turn: "effect|creature|when" (enter and per-5-ft fire once a turn each). */
  private readonly firedThisTurn = new Set<string>();
  /** Feet moved inside each effect this turn, per creature (per 5 ft: the stretches not yet counted). */
  private readonly movedInside = new Map<string, number>();

  constructor(host: EffectHost) {
    this.host = host;
  }

  private fire(
    e: EffectEntity,
    when: "enter" | "startTurn" | "endTurn" | "per5ft" | "moveInto",
    ids: string[],
    times = 1,
  ) {
    if (!e.triggers.some((t) => t.when === when)) return;
    // "A creature makes this save only once per turn" (Spirit Guardians, Moonbeam, Cloudkill): whichever trigger — in
    // combat; out of it there are no turns, and each time counts.
    const turns = this.inCombat(e.sceneId);
    const tokenIds =
      e.props.oncePerTurn && turns
        ? ids.filter((id) => {
            const key = `${e.id}|${id}|once`;
            if (this.firedThisTurn.has(key)) return false;
            this.firedThisTurn.add(key);
            return true;
          })
        : ids;
    if (!tokenIds.length) return;
    try {
      this.host.bus().execute("cast.trigger", { effectId: e.id, when, tokenIds, times }, SYSTEM_ACTOR);
    } catch (err) {
      roomCtx().log.error({ err, effect: e.id, when }, "effect trigger failed");
    }
  }

  // ── turns ─────────────────────────────────────────────────────────────────────────────────────────────

  /** A turn ended and the next began (not going back): end-of-turn triggers, what ran out, drifts, start-of-turn. */
  turn(e: CombatTurn): void {
    if (e.back) return;
    const model = this.host.model();
    // The turn that ended: its end-of-turn triggers, still counted in it (once a turn) — then a fresh turn.
    if (e.from) {
      const t = model.get("token", e.from);
      if (t) for (const fx of model.inScene("effect", t.sceneId)) this.inside(fx, t, "endTurn");
    }
    this.firedThisTurn.clear();
    this.movedInside.clear();
    if (!e.to) return;
    const c = combatOn(model, e.sceneId);
    const d = c ? dataOf(c) : null;
    const first = d?.combatants[0]?.tokenId ?? e.to;
    const now = { round: e.round, turnOf: e.to, when: "start" as const };
    for (const fx of [...model.inScene("effect", e.sceneId)]) {
      // Its rounds are up (§8.13 duration): at the start of its caster's turn, it ends — and the concentration on it.
      const ex = fx.expires;
      if (!("never" in ex)) {
        const turnOf = d?.combatants.some((x) => x.tokenId === ex.turnOf) ? ex.turnOf : first;
        if (durationExpired({ ...ex, turnOf }, now)) {
          this.end(fx, "its time is up");
          continue;
        }
      }
      // A drift at the start of its caster's turn (Cloudkill: 10 ft away from the caster).
      if (fx.movement?.drift && fx.source.casterTokenId === e.to) this.drift(fx);
    }
    const t = model.get("token", e.to);
    if (t) for (const fx of model.inScene("effect", t.sceneId)) this.inside(fx, t, "startTurn");
  }

  /** A creature inside an effect at a moment of its turn: the trigger for that moment. */
  private inside(fx: EffectEntity, t: TokenEntity, when: "startTurn" | "endTurn"): void {
    const trig = fx.triggers.find((x) => x.when === when);
    if (!trig) return;
    if (fx.props.exempt?.includes(t.id)) return;
    const a = areaOf(this.host.model(), fx);
    if (!a) return;
    // In it — or, for a wall's trigger that reaches out of its damaging side (Wall of Fire's 10 ft), on that side.
    const hit =
      inside(a, t) ||
      (trig.sideFt !== undefined && fx.shape.kind === "wall" && onDamagingSide(fx.shape, t, trig.sideFt));
    if (hit) this.fire(fx, when, [t.id]);
  }

  private end(fx: EffectEntity, why: string): void {
    try {
      this.host.bus().execute("effect.remove", { effectId: fx.id }, this.host.dmActor());
      this.host.toDms("toast", { kind: "info", message: `${fx.name} ended: ${why}.` });
    } catch (err) {
      roomCtx().log.error({ err, effect: fx.id }, "ending an effect failed");
    }
  }

  private drift(fx: EffectEntity): void {
    const model = this.host.model();
    const at = effectAt(fx);
    const caster = fx.source.casterTokenId ? model.get("token", fx.source.casterTokenId) : undefined;
    const drift = fx.movement?.drift;
    if (!at || !drift) return;
    let dx = 0;
    let dy = 0;
    if (drift.direction === "awayFromCaster" && caster) {
      const vx = at.x - caster.pos.x;
      const vy = at.y - caster.pos.y;
      const len = Math.hypot(vx, vy);
      // Standing on its caster: it drifts the way the caster faces (any way is "away").
      if (len < 1e-6) {
        const a = ((caster.rotationDeg + 90) * Math.PI) / 180;
        dx = Math.cos(a) * drift.ft;
        dy = Math.sin(a) * drift.ft;
      } else {
        dx = (vx / len) * drift.ft;
        dy = (vy / len) * drift.ft;
      }
    } else return; // "chosen": its caster moves it (Incendiary Cloud) — a drag, not a drift.
    try {
      this.host
        .bus()
        .execute("effect.move", { effectId: fx.id, to: { x: at.x + dx, y: at.y + dy } }, this.host.dmActor());
      this.host.toDms("toast", { kind: "info", message: `${fx.name} drifts ${drift.ft} ft.` });
    } catch (err) {
      roomCtx().log.error({ err, effect: fx.id }, "an effect's drift failed");
    }
  }

  // ── movement ──────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A creature moved along `path`: the effects it walked into (enter), and the feet it covered inside those that hurt
   * per 5 ft (Spike Growth). Emanations that went with it (Spirit Guardians) take in the creatures they now reach.
   */
  moved(tokenId: string, path: P[]): void {
    const model = this.host.model();
    const t = model.get("token", tokenId);
    if (!t || path.length < 2) return;
    for (const fx of model.inScene("effect", t.sceneId)) {
      if (fx.props.exempt?.includes(t.id)) continue;
      const a = areaOf(model, fx);
      if (!a) continue;
      const f = footprint(a);
      // Any part of its base (a wall: its centre in the wall's space, or stepping through it).
      const at = (p: P) => baseIn(f, p, t.sizeFt / 2);
      // Walked the path in 1-ft steps: where it came in, and how far it went inside.
      let was = at(path[0] as P);
      let entered = false;
      let feet = 0;
      for (let i = 1; i < path.length; i++) {
        const p = path[i - 1] as P;
        const q = path[i] as P;
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        const n = Math.max(1, Math.ceil(len));
        let prev = p;
        for (let k = 1; k <= n; k++) {
          const s = { x: p.x + ((q.x - p.x) * k) / n, y: p.y + ((q.y - p.y) * k) / n };
          const now = at(s);
          if ((now && !was) || (!was && crossesStrip(f, prev, s))) entered = true;
          if (now) feet += len / n;
          was = now;
          prev = s;
        }
      }
      // (Its own emanation goes with it: that isn't walking into it — the spirits reaching others is below.)
      const own = fx.shape.kind === "emanation" && fx.shape.sourceTokenId === t.id;
      if (entered && !own) this.once(fx, "enter", t.id);
      if (feet > 0 && fx.triggers.some((x) => x.when === "per5ft")) {
        const key = `${fx.id}|${t.id}`;
        const total = (this.movedInside.get(key) ?? 0) + feet;
        const stretches = Math.floor(total / 5);
        this.movedInside.set(key, total - stretches * 5);
        if (stretches > 0) this.fire(fx, "per5ft", [t.id], stretches);
      }
    }
    // A light or darkness it carries (an emanation from it) meets whatever light or darkness it walked into.
    for (const fx of model.inScene("effect", t.sceneId))
      if (
        fx.shape.kind === "emanation" &&
        fx.shape.sourceTokenId === t.id &&
        (fx.props.light || fx.props.magicalDarkness)
      )
        try {
          this.host.bus().execute("effect.recheck", { effectId: fx.id }, SYSTEM_ACTOR);
        } catch (err) {
          roomCtx().log.error({ err, effect: fx.id }, "an effect's light check failed");
        }
    // Its own emanations came along: whoever they reached on the way that they didn't reach where it set out — every
    // creature it passed, not only those by where it stopped (SRD p. 164: "whenever the Emanation enters a creature's
    // space"). The path in 1-ft steps.
    const start = path[0] as P;
    const steps: P[] = [];
    for (let i = 1; i < path.length; i++) {
      const p = path[i - 1] as P;
      const q = path[i] as P;
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y)));
      for (let k = 1; k <= n; k++)
        steps.push({ x: p.x + ((q.x - p.x) * k) / n, y: p.y + ((q.y - p.y) * k) / n });
    }
    for (const fx of model.inScene("effect", t.sceneId)) {
      if (fx.shape.kind !== "emanation" || fx.shape.sourceTokenId !== t.id) continue;
      const r = fx.shape.distance + t.sizeFt / 2;
      const took = model
        .inScene("token", t.sceneId)
        .filter((o) => o.id !== t.id && !fx.props.exempt?.includes(o.id))
        .filter((o) => {
          const rr = r + o.sizeFt / 2;
          const reaches = (s: P) => Math.hypot(o.pos.x - s.x, o.pos.y - s.y) < rr;
          return !reaches(start) && steps.some(reaches);
        })
        .map((o) => o.id);
      for (const id of took) this.once(fx, "enter", id);
    }
  }

  /**
   * An effect moved. An object rolled into a creature (Flaming Sphere — the move stopped at it): that creature's
   * `moveInto` save. An area moved onto creatures (Moonbeam, a Cloudkill's drift): each it now covers that it didn't —
   * "when the spell's area moves into its space".
   */
  effectMoved(effectId: string, before: AreaShape, rammed?: string): void {
    const model = this.host.model();
    const fx = model.get("effect", effectId);
    if (!fx) return;
    if (rammed) this.fire(fx, "moveInto", [rammed]);
    if (!fx.triggers.some((x) => x.when === "enter")) return;
    const now = areaOf(model, fx);
    const was = resolveArea(before, (id) => {
      const t = model.get("token", id);
      return t ? bodyOf(t) : null;
    });
    if (!now) return;
    for (const t of model.inScene("token", fx.sceneId)) {
      if (fx.props.exempt?.includes(t.id)) continue;
      if (inside(now, t) && !(was && inside(was, t))) this.once(fx, "enter", t.id);
    }
  }

  /** Enter fires once a turn for a creature (SRD "the first time … on a turn") — in combat; out of it, each time. */
  private once(fx: EffectEntity, when: "enter", tokenId: string): void {
    const key = `${fx.id}|${tokenId}|${when}`;
    if (this.inCombat(fx.sceneId)) {
      if (this.firedThisTurn.has(key)) return;
      this.firedThisTurn.add(key);
    }
    this.fire(fx, when, [tokenId]);
  }

  /** Whether a combat is running on the scene (its turns are what "once a turn" counts). */
  private inCombat(sceneId: string): boolean {
    const c = combatOn(this.host.model(), sceneId);
    return Boolean(c && dataOf(c).begun);
  }
}
