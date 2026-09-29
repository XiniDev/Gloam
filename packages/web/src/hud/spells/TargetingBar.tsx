import { areaAtSlot, castArea, SPELL_LEVEL_NAMES, targetingKind } from "@gloam/shared/rules";
import { useMemo, useRef } from "react";
import { aimOf, barriersOfView } from "../../board/cast/TargetingLayer.tsx";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useTargeting } from "../../state/targeting.ts";
import { Button } from "../../ui/Button.tsx";
import { Toggle } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { insetMeasures, useCover, useHudInsets, useIsPhone, useMeasuredInset } from "../insets.ts";
import { commitCast, useConcentrationAsk } from "./casting.ts";

/**
 * The targeting bar (SPEC §8.13 Casting flow 2): while a spell is aimed on the board, what's being cast and what's
 * asked — "Click where it goes" with its range and whether it can go there, or "2 / 3 targets" — how to turn it
 * ([ and ], the wheel), Include myself (§17.2) where the area's origin is its caster, its other forms (Darkness on an
 * object), Cast now (fewer targets than it takes) and Cancel (Esc). And the question a second concentration spell asks.
 */
export function TargetingBar() {
  const t = useTargeting((s) => s.t);
  const tokens = useEntities((s) => boardData(s).tokens);
  const walls = useEntities((s) => boardData(s).walls);
  const coverage = useTable((s) => s.houseRules.areaCoverage) === "centre" ? "centre" : "touches";
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const phone = useIsPhone();
  const hudLeft = useHudInsets((s) => s.left);
  const hudRight = useHudInsets((s) => s.right);
  const ref = useRef<HTMLDivElement>(null);
  useMeasuredInset("bottom", ref, insetMeasures.bottom, t !== null);
  useCover("targeting", ref, t !== null);
  const barriers = useMemo(() => barriersOfView(walls.values()), [walls]);
  const aim = useMemo(
    () => (t ? aimOf(t, tokens, barriers, coverage, dm) : null),
    [t, tokens, barriers, coverage, dm],
  );
  const ask = useConcentrationAsk((s) => s.ask);
  if (!t) return <ConcentrationAsk />;
  const spell = t.spell;
  const kind = targetingKind(spell);
  const level = spell.level === 0 ? "cantrip" : `${SPELL_LEVEL_NAMES[t.level]} level`;
  const alt = t.alt !== undefined ? spell.areaAlternatives?.[t.alt] : undefined;
  const area = castArea(spell, t.alt);
  const scaled = area ? areaAtSlot(area, spell.level, t.level) : null;
  const self = spell.range.kind === "self";
  // Include myself matters where the area starts at its caster: a cone, line or cube from them, an emanation.
  const fromCaster = scaled && (scaled.shape === "emanation" || (self && scaled.shape !== "sphere"));
  const picks = t.picks.length;
  const hint =
    kind === "creatures"
      ? `Click ${t.max === 1 ? "the creature" : "each creature"} it's aimed at${t.repeat ? " (again for another)" : ""} — ${picks} / ${t.max}`
      : scaled?.shape === "emanation"
        ? "It surrounds its caster — Cast to confirm"
        : scaled?.shape === "wall"
          ? "Click to lay the wall's points — Enter to finish"
          : `Click where it goes${scaled && scaled.shape !== "sphere" && scaled.shape !== "cylinder" ? " — [ and ] or the wheel to turn it" : ""}`;
  return (
    <>
      {/* Centred in the board's clear width — between the toolbar and the dock or its open page (the sheet it was
          cast from stays open beside it), never under them (as the action bar, critic P8 r2 B1). */}
      <div
        className="pointer-events-none absolute bottom-4 z-40 flex justify-center"
        style={phone ? { left: 12, right: 12 } : { left: hudLeft, right: hudRight }}
      >
        <div
          ref={ref}
          data-testid="targeting-bar"
          className={`panel pointer-events-auto flex w-[min(720px,100%)] items-center gap-3 border-brass/60 px-3 py-2 ${phone ? "flex-col items-stretch" : ""}`}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="display truncate text-18 leading-tight text-bone">
              {spell.name} <span className="text-14 text-fog">· {level}</span>
            </span>
            <span className="text-13 text-muted" data-testid="targeting-hint">
              {hint}
            </span>
            {kind === "creatures" && t.refusal ? (
              <span className="text-13 text-ember" data-testid="targeting-why">
                {t.refusal}
              </span>
            ) : aim && !aim.ok && aim.why ? (
              <span className="text-13 text-ember" data-testid="targeting-why">
                {aim.why}
              </span>
            ) : kind === "area" && aim ? (
              <span className="text-13 text-muted" data-testid="targeting-count">
                {aim.inside.length} {aim.inside.length === 1 ? "creature" : "creatures"} inside
                {aim.blocked.length ? ` · ${aim.blocked.length} cut off by a wall` : ""}
              </span>
            ) : null}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {fromCaster ? (
              <Toggle
                inline
                compact
                label="Include myself"
                checked={t.includeSelf}
                onChange={(includeSelf) => useTargeting.getState().set({ includeSelf })}
              />
            ) : null}
            {spell.areaAlternatives?.length ? (
              <Button
                size="S"
                variant="ghost"
                onClick={() => {
                  const n = spell.areaAlternatives?.length ?? 0;
                  const next = t.alt === undefined ? 0 : t.alt + 1 < n ? t.alt + 1 : undefined;
                  useTargeting.getState().set({ alt: next });
                }}
              >
                {alt ? "Its first form" : (spell.areaAlternatives[0]?.label.split(":")[0] ?? "Another form")}
              </Button>
            ) : null}
            {kind === "creatures" && picks > 0 && picks < t.max ? (
              <Button size="S" variant="primary" loading={t.busy} onClick={() => void commitCast(t)}>
                Cast now
              </Button>
            ) : null}
            {kind === "area" &&
            (scaled?.shape === "emanation" || (scaled?.shape === "wall" && t.points.length >= 2)) ? (
              <Button
                size="S"
                variant="primary"
                loading={t.busy}
                disabled={aim ? !aim.ok && !dm : true}
                onClick={() => void commitCast(t)}
              >
                Cast
              </Button>
            ) : null}
            <Button size="S" variant="ghost" onClick={() => useTargeting.getState().stop()}>
              Cancel
            </Button>
          </span>
        </div>
      </div>
      {ask ? <ConcentrationAsk /> : null}
    </>
  );
}

/** "Thorin is concentrating on Bless: end it?" — the cast goes when it's answered yes (§8.13 Concentration). */
function ConcentrationAsk() {
  const ask = useConcentrationAsk((s) => s.ask);
  return (
    <Dialog
      open={ask !== null}
      onClose={() => useConcentrationAsk.getState().set(null)}
      title="End concentration?"
      description={
        ask
          ? `${ask.name} is concentrating on ${ask.spell}. Casting this ends it, and whatever it holds up.`
          : undefined
      }
      width={420}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => useConcentrationAsk.getState().set(null)}>
            Keep {ask?.spell ?? "it"}
          </Button>
          <Button variant="primary" onClick={() => void ask?.send()}>
            End it and cast
          </Button>
        </div>
      }
    />
  );
}
