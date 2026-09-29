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
  const f = footprint(a);
  const r = t.sizeFt / 2;
  if (f.kind === "circle") return Math.hypot(t.pos.x - f.c.x, t.pos.y - f.c.y) < f.r + r;
  return contains(f, t.pos) || sampleRim(t.pos, r).some((p) => contains(f, p));
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
    when: "enter" | "startTurn" | "endTurn" | "per5ft",
    tokenIds: string[],
    times = 1,
  ) {
    if (!tokenIds.length || !e.triggers.some((t) => t.when === when)) return;
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
    this.firedThisTurn.clear();
    this.movedInside.clear();
    if (e.from) {
      const t = model.get("token", e.from);
      if (t) for (const fx of model.inScene("effect", t.sceneId)) this.inside(fx, t, "endTurn");
    }
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
    if (!fx.triggers.some((x) => x.when === when)) return;
    if (fx.props.exempt?.includes(t.id)) return;
    const a = areaOf(this.host.model(), fx);
    if (!a || !inside(a, t)) return;
    this.fire(fx, when, [t.id]);
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
      const at = (p: P) =>
        f.kind === "circle" ? Math.hypot(p.x - f.c.x, p.y - f.c.y) < f.r + t.sizeFt / 2 : contains(f, p);
      // Walked the path in 1-ft steps: where it came in, and how far it went inside.
      let was = at(path[0] as P);
      let entered = false;
      let feet = 0;
      for (let i = 1; i < path.length; i++) {
        const p = path[i - 1] as P;
        const q = path[i] as P;
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        const n = Math.max(1, Math.ceil(len));
        for (let k = 1; k <= n; k++) {
          const s = { x: p.x + ((q.x - p.x) * k) / n, y: p.y + ((q.y - p.y) * k) / n };
          const now = at(s);
          if (now && !was) entered = true;
          if (now) feet += len / n;
          was = now;
        }
      }
      if (entered && fx.shape.kind !== "emanation") this.once(fx, "enter", t.id);
      if (feet > 0 && fx.triggers.some((x) => x.when === "per5ft")) {
        const key = `${fx.id}|${t.id}`;
        const total = (this.movedInside.get(key) ?? 0) + feet;
        const stretches = Math.floor(total / 5);
        this.movedInside.set(key, total - stretches * 5);
        if (stretches > 0) this.fire(fx, "per5ft", [t.id], stretches);
      }
    }
    // Its own emanations came along: whoever they now reach that they didn't before.
    const start = path[0] as P;
    for (const fx of model.inScene("effect", t.sceneId)) {
      if (fx.shape.kind !== "emanation" || fx.shape.sourceTokenId !== t.id) continue;
      const r = fx.shape.distance + t.sizeFt / 2;
      const took = model
        .inScene("token", t.sceneId)
        .filter((o) => o.id !== t.id && !fx.props.exempt?.includes(o.id))
        .filter((o) => {
          const rr = r + o.sizeFt / 2;
          return (
            Math.hypot(o.pos.x - t.pos.x, o.pos.y - t.pos.y) < rr &&
            Math.hypot(o.pos.x - start.x, o.pos.y - start.y) >= rr
          );
        })
        .map((o) => o.id);
      for (const id of took) this.once(fx, "enter", id);
    }
  }

  /** An effect moved onto creatures (Moonbeam, Flaming Sphere, a drift): each it now covers that it didn't. */
  effectMoved(effectId: string, before: AreaShape): void {
    const model = this.host.model();
    const fx = model.get("effect", effectId);
    if (!fx?.triggers.some((x) => x.when === "enter")) return;
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

  /** Enter fires once a turn for a creature (SRD "the first time … on a turn"). */
  private once(fx: EffectEntity, when: "enter", tokenId: string): void {
    const key = `${fx.id}|${tokenId}|${when}`;
    if (this.firedThisTurn.has(key)) return;
    this.firedThisTurn.add(key);
    this.fire(fx, when, [tokenId]);
  }
}
