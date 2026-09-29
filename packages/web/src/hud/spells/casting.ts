/**
 * Casting, from the client's side (SPEC §8.13 Casting flow): the cast sent from what's on the board (the template's
 * point and facing, the creatures picked), a second concentration spell confirmed first ("End concentration on Bless?"),
 * and a narrative or self spell sent at once. Every cast is the server's `spell.cast`; the board, the card and the
 * log follow from what it sends back.
 */
import { areaAtSlot, attackRangeFt, castArea, targetingKind } from "@gloam/shared/rules";
import type { Spell } from "@gloam/shared/schemas";
import { create } from "zustand";
import { castSpell, startAttack } from "../../net/spells.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { type Targeting, useTargeting } from "../../state/targeting.ts";
import { toast } from "../../ui/Toast.tsx";

/** A cast waiting on "End concentration on …?" (the dialog asks; yes sends it again with the end confirmed). */
export const useConcentrationAsk = create<{
  ask: { name: string; spell: string; send: () => Promise<void> } | null;
  set(a: { name: string; spell: string; send: () => Promise<void> } | null): void;
}>((set) => ({ ask: null, set: (ask) => set({ ask }) }));

/** The payload a targeting sends, with or without ending the concentration already held. */
export function castPayload(t: Targeting, endConcentration: boolean) {
  const kind = targetingKind(t.spell);
  const caster = boardData(useEntities.getState()).tokens.get(t.casterTokenId);
  const at = t.at ?? caster?.pos ?? { x: 0, y: 0 };
  const area = castArea(t.spell, t.alt);
  // Cast on an object put down there (Light on a stone): its point.
  if (t.point)
    return {
      casterTokenId: t.casterTokenId,
      spellId: t.spell.id,
      mode: t.mode,
      ...(t.slot ? { slot: t.slot } : {}),
      ...(t.mode !== "slot" ? { level: t.level } : {}),
      placement: { origin: { x: at.x, y: at.y, z: 0 }, dirDeg: 0 },
      endConcentration,
    };
  return {
    casterTokenId: t.casterTokenId,
    spellId: t.spell.id,
    mode: t.mode,
    ...(t.slot ? { slot: t.slot } : {}),
    ...(t.mode !== "slot" ? { level: t.level } : {}),
    ...(kind === "area" && area
      ? {
          placement: {
            origin: { x: at.x, y: at.y, z: 0 },
            dirDeg: t.dirDeg,
            ...(t.alt !== undefined ? { alt: t.alt } : {}),
            ...(area.shape === "wall" && t.points.length >= 2 ? { points: t.points, closed: t.ring } : {}),
          },
        }
      : {}),
    ...(kind === "creatures" ? { targets: t.picks } : {}),
    includeSelf: t.includeSelf,
    ...(t.damageType ? { damageType: t.damageType as never } : {}),
    ...(t.spare?.length ? { spare: t.spare } : {}),
    endConcentration,
  };
}

/**
 * Sends the cast. A concentration spell cast while concentrating asks first (the server refuses it until told to end
 * the other); anything else refused says why.
 */
export async function commitCast(t: Targeting, endConcentration = false): Promise<boolean> {
  useTargeting.getState().set({ busy: true });
  try {
    // A sheet's attack goes through the same card (AC-SPL-12).
    if (t.attack) await startAttack(t.casterTokenId, t.attack.index, t.picks);
    else await castSpell(castPayload(t, endConcentration));
    useTargeting.getState().stop();
    return true;
  } catch (e) {
    const err = e as Error & { code?: string; detail?: { concentrating?: string | null } };
    useTargeting.getState().set({ busy: false });
    if (err.code === "CONFLICT" && err.detail && "concentrating" in err.detail) {
      const caster = boardData(useEntities.getState()).tokens.get(t.casterTokenId);
      useConcentrationAsk.getState().set({
        name: caster?.name ?? "The caster",
        spell: err.detail.concentrating ?? "a spell",
        send: async () => {
          useConcentrationAsk.getState().set(null);
          await commitCast(t, true);
        },
      });
      return false;
    }
    // Still aiming: the reason goes in the bar, where the aim is (critic P9 r2 B2), not in a toast over the board.
    const now = useTargeting.getState().t;
    if (now && now.casterTokenId === t.casterTokenId && now.spell.id === t.spell.id) {
      useTargeting.getState().set({ refusal: err.message });
      return false;
    }
    toast.warning(`Couldn't cast ${t.spell.name}`, err.message);
    return false;
  }
}

/** A sheet's attack as the board aims it: a creature (or more, for more swings) to click, then the card. */
export function beginAttack(casterTokenId: string, index: number, name: string, rangeText?: string): void {
  const ft = attackRangeFt(rangeText);
  const spell: Spell = {
    id: `attack-${index}`,
    name,
    level: 0,
    school: "evocation",
    classes: [],
    castingTime: { amount: 1, unit: "action" },
    ritual: false,
    range: { kind: "ranged", ft: Math.max(5, ft) },
    components: { v: false, s: false, m: false },
    duration: { kind: "instantaneous", concentration: false },
    text: "",
    targeting: { kind: "creatures", count: 1 },
    vfx: "force",
    source: { pack: "sheet" },
  };
  useTargeting.getState().start({
    spell,
    casterTokenId,
    level: 0,
    mode: "slot",
    max: 1,
    repeat: false,
    attack: { index },
  });
}

/** Starts a cast: a self or narrative one goes at once; an area or targeted one hands over to the board. */
export async function beginCast(
  spell: Spell,
  casterTokenId: string,
  opts: {
    slot?: { level: number; kind: "slot" | "pact" };
    level: number;
    mode: "slot" | "ritual" | "free";
    damageType?: string;
    narrative?: boolean;
    alt?: number;
    max: number;
    repeat: boolean;
    /** A spell cast on an object (Light): on something the caster carries, or an object put down within reach. */
    onto?: "carried" | "point";
  },
): Promise<void> {
  const base = {
    spell,
    casterTokenId,
    slot: opts.slot,
    level: opts.level,
    mode: opts.mode,
    damageType: opts.damageType,
    alt: opts.alt,
    max: opts.max,
    repeat: opts.repeat,
  };
  const kind = targetingKind(spell);
  // On an object put down within reach: aimed on the board as a point.
  if (!opts.narrative && opts.onto === "point") {
    useTargeting.getState().start({ ...base, point: true });
    return;
  }
  // On something the caster carries: the caster holds it.
  if (!opts.narrative && opts.onto === "carried") {
    const c = boardData(useEntities.getState()).tokens.get(casterTokenId);
    try {
      await castSpell({
        casterTokenId,
        spellId: spell.id,
        mode: opts.mode,
        ...(opts.slot ? { slot: opts.slot } : {}),
        ...(opts.mode !== "slot" ? { level: opts.level } : {}),
        placement: {
          origin: { x: c?.pos.x ?? 0, y: c?.pos.y ?? 0, z: 0 },
          dirDeg: 0,
          attachTo: casterTokenId,
        },
      });
    } catch (e) {
      toast.warning(`Couldn't cast ${spell.name}`, (e as Error).message);
    }
    return;
  }
  if (opts.narrative || kind === "self" || kind === "point") {
    const t: Targeting = {
      ...base,
      at: null,
      dirDeg: 0,
      turned: false,
      picks: kind === "self" ? [casterTokenId] : [],
      includeSelf: false,
      points: [],
      ring: false,
      busy: false,
    };
    try {
      await castSpell({ ...castPayload(t, false), narrative: Boolean(opts.narrative || kind === "point") });
    } catch (e) {
      const err = e as Error & { code?: string; detail?: { concentrating?: string | null } };
      if (err.code === "CONFLICT" && err.detail && "concentrating" in err.detail) {
        useConcentrationAsk.getState().set({
          name: boardData(useEntities.getState()).tokens.get(casterTokenId)?.name ?? "The caster",
          spell: err.detail.concentrating ?? "a spell",
          send: async () => {
            useConcentrationAsk.getState().set(null);
            await castSpell({
              ...castPayload(t, true),
              narrative: Boolean(opts.narrative || kind === "point"),
            }).catch((x: Error) => toast.warning(`Couldn't cast ${spell.name}`, x.message));
          },
        });
        return;
      }
      toast.warning(`Couldn't cast ${spell.name}`, err.message);
    }
    return;
  }
  useTargeting.getState().start(base);
  // An emanation stands on its caster: nothing to aim, only what it takes to confirm.
  const cast = castArea(spell);
  const area = cast ? areaAtSlot(cast, spell.level, opts.level) : null;
  if (area?.shape === "emanation") {
    const c = boardData(useEntities.getState()).tokens.get(casterTokenId);
    if (c) useTargeting.getState().set({ at: { ...c.pos } });
  }
}
