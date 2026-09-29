/**
 * Spells, attacks and effects on the client (SPEC §8.13): the campaign's spells — the SRD pack, fetched once when first
 * needed (the browser caches it: it never changes under a running server), and the campaign's homebrew from the room —
 * the resolution cards this person has (each the server's view of it for them: the DM's whole card, the caster's
 * parts), a cast's VFX for the board, the public line a cast leaves, and the actions (each a server command).
 */
import type { CastView, SpellCastIn } from "@gloam/shared/protocol";
import type { Spell, SpellInput } from "@gloam/shared/schemas";
import { create } from "zustand";
import { provideTestHook } from "../test/hooks.ts";
import { toast } from "../ui/Toast.tsx";
import { get } from "./http.ts";
import { request, tableEvents } from "./table.ts";

/** A homebrew spell as the room lists it: its content id, whether it's in use or waiting on the DM, who made it. */
export interface HomebrewSpell {
  id: string;
  /** In use; the DM's own (no player sees it); a player's proposal; turned down. */
  status: "active" | "private" | "proposed" | "rejected";
  createdBy: string;
  createdByName: string;
  spell: Spell;
}

/** A cast's VFX (the board plays it where it happens, for whoever can see it). */
export interface CastFxMessage {
  castId: string | null;
  preset: Spell["vfx"];
  from: { x: number; y: number; z: number } | null;
  shape: unknown;
  to: { x: number; y: number; z: number }[];
  kind: "burst" | "projectile" | "instant";
}

interface SpellsStore {
  /** The SRD pack (null until loaded). */
  srd: Spell[] | null;
  loading: boolean;
  failed: string | null;
  homebrew: HomebrewSpell[];
  /** Open resolution cards this person has, by id. */
  casts: Map<string, CastView>;
  /** Cards a player hid (the DM's stay theirs to close), with what they asked of them then: one asking more is back. */
  hiddenCasts: Map<string, string[]>;
  set(p: Partial<Omit<SpellsStore, "set">>): void;
}

export const useSpells = create<SpellsStore>((set) => ({
  srd: null,
  loading: false,
  failed: null,
  homebrew: [],
  casts: new Map(),
  hiddenCasts: new Map(),
  set: (p) => set(p),
}));

let loadingPack: Promise<Spell[]> | null = null;

/** The SRD pack, loaded once (later calls share the first). */
export function loadSrdSpells(): Promise<Spell[]> {
  const have = useSpells.getState().srd;
  if (have) return Promise.resolve(have);
  if (loadingPack) return loadingPack;
  useSpells.getState().set({ loading: true, failed: null });
  loadingPack = get<{ spells: Spell[] }>("/api/table/content/spells")
    .then((r) => {
      useSpells.getState().set({ srd: r.spells, loading: false });
      return r.spells;
    })
    .catch((e: Error) => {
      loadingPack = null;
      useSpells.getState().set({ loading: false, failed: e.message });
      throw e;
    });
  return loadingPack;
}

/** Every spell the table can cast: the SRD's and the homebrew in use (a player's own proposals marked as such). */
export function allSpells(s: Pick<SpellsStore, "srd" | "homebrew">): Spell[] {
  // In use: the table's, and the DM's own (only a DM is ever sent those).
  const brew = s.homebrew.filter((h) => h.status === "active" || h.status === "private").map((h) => h.spell);
  return [...(s.srd ?? []), ...brew];
}

/** A spell by id (SRD slug or homebrew slug). */
export function spellOf(id: string): Spell | undefined {
  const s = useSpells.getState();
  return s.srd?.find((x) => x.id === id) ?? s.homebrew.find((h) => h.spell.id === id)?.spell;
}

// ── casting ──────────────────────────────────────────────────────────────────────────────────────────────

export const castSpell = (p: SpellCastIn) =>
  request<{ castId: string | null; effectId: string | null; given: string[] }>("spell.cast", p);
export const startAttack = (tokenId: string, attack: number, targets: string[]) =>
  request<{ castId: string }>("attack.start", { tokenId, attack, targets });

// ── the card ─────────────────────────────────────────────────────────────────────────────────────────────

export const castTarget = (castId: string, targetId: string, include: boolean) =>
  request("cast.target", { castId, targetId, include });
export const castSet = (
  castId: string,
  targetId: string,
  p: {
    saveSuccess?: boolean | null;
    hit?: boolean | null;
    outcome?: "full" | "half" | "none";
    ignore?: { resist?: boolean; vuln?: boolean; immune?: boolean };
    conditions?: string[];
    crit?: boolean;
    final?: number | null;
  },
) => request("cast.set", { castId, targetId, ...p });
export const castRevealDc = (castId: string, reveal: boolean) => request("cast.revealDc", { castId, reveal });
export const castApply = (castId: string, targets?: string[]) =>
  request<{ applied: number }>("cast.apply", { castId, ...(targets ? { targets } : {}) });
export const castSkip = (castId: string, targetId: string) => request("cast.skip", { castId, targetId });
export const castCancel = (castId: string) => request("cast.cancel", { castId });
export const castClose = (castId: string) => request("cast.close", { castId });
/** A roll on the card: an attack at a row, or the damage (the card's, or a row's) — or a number entered. */
export const castRoll = (
  castId: string,
  what: "attack" | "damage",
  opts: { targetId?: string; entered?: number; dice?: number[]; adv?: "none" | "adv" | "dis" } = {},
) => request<{ total: number }>("cast.roll", { castId, what, ...opts });
/** The DM rolls every NPC's save at once. */
export const castNpcSaves = (castId: string) => request<{ rolled: number }>("cast.npcSaves", { castId });

// ── effects ──────────────────────────────────────────────────────────────────────────────────────────────

export const moveEffect = (effectId: string, to: { x: number; y: number }, dirDeg?: number) =>
  request("effect.move", { effectId, to, ...(dirDeg !== undefined ? { dirDeg } : {}) });
export const removeEffect = (effectId: string) => request("effect.remove", { effectId });
/** An effect's action again at a point in it (Call Lightning's next bolt). */
export const actEffect = (effectId: string, at: { x: number; y: number }) =>
  request<{ castId: string | null }>("effect.act", { effectId, at: { x: at.x, y: at.y } });
export const updateEffect = (
  effectId: string,
  p: {
    visibility?: "everyone" | "dm";
    size?: number;
    props?: {
      difficult?: boolean;
      obscurement?: "light" | "heavy" | null;
      magicalDarkness?: boolean;
      silence?: boolean;
    };
  },
) => request("effect.update", { effectId, ...p });

// ── homebrew ─────────────────────────────────────────────────────────────────────────────────────────────

/** The DM saves a homebrew spell (in use at once); a player proposes one (the DM approves it). */
export const saveHomebrew = (spell: SpellInput, replaces?: string, dmOnly?: boolean) =>
  request<{ id: string; status: HomebrewSpell["status"] }>("content.spell.save", {
    spell,
    ...(replaces ? { replaces } : {}),
    ...(dmOnly !== undefined ? { private: dmOnly } : {}),
  });
export const decideHomebrew = (id: string, approve: boolean) =>
  request("content.spell.decide", { id, approve });
export const deleteHomebrew = (id: string) => request("content.spell.delete", { id });

// ── what the room sends ──────────────────────────────────────────────────────────────────────────────────

/** A cast's VFX (the board's VFX layer listens). */
export const castFx = {
  listeners: new Set<(f: CastFxMessage) => void>(),
  log: [] as (CastFxMessage & { at: number })[],
  on(f: (m: CastFxMessage) => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  },
  fire(m: CastFxMessage): void {
    if (__GLOAM_TEST__) {
      this.log.push({ ...m, at: performance.now() });
      if (this.log.length > 100) this.log.shift();
    }
    for (const l of this.listeners) l(m);
  },
};

/** Lines casts left (tests: what everyone was told). */
const lines: { text: string; castId: string | null; at: number }[] = [];

function onMessage(type: string, payload: unknown): void {
  const s = useSpells.getState();
  switch (type) {
    case "cast.view": {
      const v = payload as CastView;
      const next = new Map(s.casts);
      if (v.status === "open") next.set(v.id, v);
      else next.delete(v.id);
      // A closed card's hiding goes with it.
      if (v.status !== "open" && s.hiddenCasts.has(v.id)) {
        const hidden = new Map(s.hiddenCasts);
        hidden.delete(v.id);
        s.set({ casts: next, hiddenCasts: hidden });
      } else s.set({ casts: next });
      return;
    }
    case "cast.views": {
      s.set({
        casts: new Map((payload as CastView[]).filter((v) => v.status === "open").map((v) => [v.id, v])),
      });
      return;
    }
    case "cast.fx":
      castFx.fire(payload as CastFxMessage);
      return;
    case "cast.line": {
      const l = payload as { text: string; castId: string | null; card?: boolean };
      lines.push({ text: l.text, castId: l.castId, at: Date.now() });
      if (lines.length > 50) lines.shift();
      // Its card says it to whoever has one (critic P9 r1 #5: a toast over the board besides the card).
      if (!l.card) toast.info(l.text);
      return;
    }
    case "content.spells":
      s.set({ homebrew: payload as HomebrewSpell[] });
      return;
    case "content.spells.patch": {
      // Only what changed (the whole list came on joining).
      const p = payload as { upsert: HomebrewSpell[]; remove: string[] };
      const gone = new Set([...p.remove, ...p.upsert.map((x) => x.id)]);
      s.set({
        homebrew: [...s.homebrew.filter((x) => !gone.has(x.id)), ...p.upsert].sort((a, b) =>
          a.spell.name.localeCompare(b.spell.name),
        ),
      });
      return;
    }
  }
}

/** Starts watching (once per page). */
export function watchSpells(): () => void {
  if (__GLOAM_TEST__) {
    provideTestHook("casts", () => [...useSpells.getState().casts.values()]);
    provideTestHook("castLines", () => lines.slice());
    provideTestHook("castFx", () => castFx.log.slice());
    provideTestHook("homebrew", () => useSpells.getState().homebrew);
  }
  return tableEvents.on("message", ({ type, payload }) => onMessage(type, payload));
}
