import {
  defaultSlot,
  repeatTargets,
  type SlotOption,
  SPELL_LEVEL_NAMES,
  slotOptions,
  targetCount,
  targetingKind,
} from "@gloam/shared/rules";
import type { Spell, Spellcasting } from "@gloam/shared/schemas";
import { useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import { Button } from "../../ui/Button.tsx";
import { Segmented, Toggle } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";
import { beginCast } from "./casting.ts";
import { SpellCard } from "./SpellCard.tsx";

type SC = z.infer<typeof Spellcasting>;

/** What opens the cast dialog: the spell, its caster's token (when it's on the board), its slots, its level. */
export interface CastRequest {
  spell: Spell;
  casterTokenId: string | null;
  casterName: string;
  spellcasting: SC | null;
  casterLevel: number;
}

const slotLabel = (o: SlotOption) =>
  `${o.kind === "pact" ? "Pact · " : ""}${SPELL_LEVEL_NAMES[o.level]} (${o.left} left)`;

/**
 * Casting a spell (SPEC §8.13 Casting flow 1): the slot — the lowest left by default, each higher one with what it adds
 * on the card (upcast dice, more targets, a bigger area) — or a ritual (its own level, no slot) or a free cast; a
 * damage type where the spell lets the caster choose; and "narrative" to post the card without aiming. Then the board
 * takes over (an area to place, creatures to click), or a self spell goes at once.
 */
export function CastDialog({ req, onClose }: { req: CastRequest | null; onClose: () => void }) {
  const spell = req?.spell ?? null;
  const options = useMemo(() => (spell ? slotOptions(spell, req?.spellcasting ?? null) : []), [spell, req]);
  const [slot, setSlot] = useState<SlotOption | null>(null);
  const [mode, setMode] = useState<"slot" | "ritual" | "free">("slot");
  const [narrative, setNarrative] = useState(false);
  const [damageType, setDamageType] = useState<string | undefined>(undefined);
  const [onto, setOnto] = useState<"carried" | "point">("carried");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!spell) return;
    const d = defaultSlot(options);
    setSlot(d);
    setMode(spell.level === 0 || d ? "slot" : spell.ritual ? "ritual" : "free");
    setNarrative(false);
    setOnto("carried");
    setDamageType(spell.damage?.[0]?.typeOptions?.[0]);
  }, [spell, options]);
  if (!req || !spell) return <Dialog open={false} onClose={onClose} title="" />;
  const level = spell.level === 0 ? 0 : mode === "slot" ? (slot?.level ?? spell.level) : spell.level;
  const kind = targetingKind(spell);
  const onBoard = Boolean(req.casterTokenId);
  // Cast on an object with no area of its own (Light): what it's put on.
  const onObject = spell.effect?.attach === "object" && !spell.area;
  const canSlot = spell.level === 0 || options.length > 0;
  const needsSlot = spell.level > 0 && mode === "slot" && !slot;
  const go = async () => {
    if (!req.casterTokenId) {
      toast.warning(
        "Not on the board",
        `Place ${req.casterName} on the scene to cast — or cast it as narrative.`,
      );
      return;
    }
    setBusy(true);
    try {
      await beginCast(spell, req.casterTokenId, {
        ...(mode === "slot" && slot && spell.level > 0
          ? { slot: { level: slot.level, kind: slot.kind } }
          : {}),
        level,
        mode: spell.level === 0 ? "slot" : mode,
        ...(damageType ? { damageType } : {}),
        narrative,
        max: targetCount(spell, level, req.casterLevel),
        repeat: repeatTargets(spell),
        ...(onObject ? { onto } : {}),
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const action =
    onObject && !narrative && onto === "point"
      ? "Place on the board"
      : narrative || kind === "self" || kind === "point"
        ? "Cast"
        : kind === "area"
          ? "Place on the board"
          : `Choose ${targetCount(spell, level, req.casterLevel) === 1 ? "the target" : "targets"}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Cast ${spell.name}`}
      description={`${req.casterName}${spell.level ? "" : " · a cantrip, no slot"}`}
      width={560}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={needsSlot || (!onBoard && !narrative)}
            onClick={() => void go()}
          >
            {action}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="cast-dialog">
        {spell.level > 0 ? (
          <section className="flex flex-col gap-1.5">
            <span className="caps text-12 text-fog">Slot</span>
            {canSlot ? (
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Spell slot">
                {options.map((o) => {
                  const on = mode === "slot" && slot?.level === o.level && slot.kind === o.kind;
                  return (
                    <button
                      key={`${o.kind}${o.level}`}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => {
                        setMode("slot");
                        setSlot(o);
                      }}
                      className={`min-h-[var(--touch-min)] rounded-[var(--radius-control)] border px-3 py-1.5 text-13 font-bold ${
                        on
                          ? "border-brass bg-[var(--glow-brass)] text-brass-bright"
                          : "border-line text-bone hover:border-line-strong"
                      }`}
                    >
                      {slotLabel(o)}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-13 text-muted">No slot of level {spell.level} or higher is left.</p>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {spell.ritual ? (
                <Toggle
                  inline
                  compact
                  label="As a ritual (no slot, 10 minutes longer)"
                  checked={mode === "ritual"}
                  onChange={(on) => setMode(on ? "ritual" : canSlot ? "slot" : "free")}
                />
              ) : null}
              <Toggle
                inline
                compact
                label="Without a slot"
                checked={mode === "free"}
                onChange={(on) => setMode(on ? "free" : canSlot ? "slot" : spell.ritual ? "ritual" : "free")}
              />
            </div>
          </section>
        ) : null}
        {spell.damage?.[0]?.typeOptions ? (
          <section className="flex flex-col gap-1.5">
            <span className="caps text-12 text-fog">Damage type</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Damage type">
              {spell.damage[0].typeOptions.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={damageType === t}
                  onClick={() => setDamageType(t)}
                  className={`min-h-[var(--touch-min)] rounded-[var(--radius-control)] border px-3 py-1.5 text-13 font-bold ${
                    damageType === t
                      ? "border-brass bg-[var(--glow-brass)] text-brass-bright"
                      : "border-line text-bone"
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {onObject && !narrative ? (
          <section className="flex flex-col gap-1.5">
            <span className="caps text-12 text-fog">Cast on</span>
            <Segmented
              label="Cast on"
              value={onto}
              onChange={setOnto}
              options={[
                { value: "carried", label: `Something ${req.casterName} carries` },
                { value: "point", label: "An object within reach" },
              ]}
            />
          </section>
        ) : null}
        <Toggle
          label="Narrative only"
          description="Post the spell's card to the table without aiming it (the slot is still spent)."
          checked={narrative}
          onChange={setNarrative}
        />
        {!onBoard && !narrative ? (
          <p className="text-13 text-ember">
            {req.casterName} isn't on this scene: place them to aim it, or cast it as narrative.
          </p>
        ) : null}
        <SpellCard spell={spell} slot={level} casterLevel={req.casterLevel} compact />
      </div>
    </Dialog>
  );
}
