import { areaAtSlot, castArea, SPELL_LEVEL_NAMES } from "@gloam/shared/rules";
import { useEffect, useMemo, useRef } from "react";
import { boardApi } from "../../board/boardApi.ts";
import { cameraRig } from "../../board/CameraRig.tsx";
import { aimOf, barriersOfView } from "../../board/cast/TargetingLayer.tsx";
import { sceneBounds } from "../../board/scene.ts";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { aimKind, designates, useTargeting } from "../../state/targeting.ts";
import { Button } from "../../ui/Button.tsx";
import { Toggle } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { coarsePointer } from "../../ui/pointer.ts";
import { insetMeasures, useCover, useHudInsets, useIsPhone, useMeasuredInset } from "../insets.ts";
import { aimFrame, aimReach } from "./aimFrame.ts";
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
  // Right of the roll feed, as the tool option bars (critic P9 r2 #12: at 1024 the bar covered the feed's header).
  const hudLeft = useHudInsets((s) => s.left + s.feed);
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
  // A phone frames what the spell can reach as the aim begins (critic P9 r1 #18: the whole scene letterboxed left its
  // creatures too small to tap) — once per aim; the view is theirs to move after.
  const aimKey = t ? `${t.casterTokenId}:${t.spell.id}:${t.level}` : null;
  useEffect(() => {
    if (!phone || !aimKey) return;
    const cur = useTargeting.getState().t;
    const d = boardData(useEntities.getState());
    if (!cur || !d.scene) return;
    const area = aimFrame(cur.casterTokenId, aimReach(cur.spell), d.tokens.values(), sceneBounds(d.scene));
    if (area) cameraRig.frame(area);
  }, [phone, aimKey]);
  if (!t) return <ConcentrationAsk />;
  const spell = t.spell;
  const kind = aimKind(t);
  const level = spell.level === 0 ? "cantrip" : `${SPELL_LEVEL_NAMES[t.level]} level`;
  const alt = t.alt !== undefined ? spell.areaAlternatives?.[t.alt] : undefined;
  const area = castArea(spell, t.alt);
  const scaled = area ? areaAtSlot(area, spell.level, t.level) : null;
  const self = spell.range.kind === "self";
  // Include myself matters where the area starts at its caster: a cone, line or cube from them, an emanation.
  const fromCaster = scaled && (scaled.shape === "emanation" || (self && scaled.shape !== "sphere"));
  const picks = t.picks.length;
  // On a touch screen it's a tap (and there's no Esc).
  const touch = coarsePointer();
  const Click = touch ? "Tap" : "Click";
  const hint =
    kind === "creatures"
      ? `${Click} ${t.max === 1 ? "the creature" : "each creature"} it's aimed at${t.repeat ? " (again for another)" : ""}`
      : t.point
        ? `${Click} where the object lies — within reach`
        : scaled?.shape === "emanation"
          ? designates(t)
            ? `It surrounds its caster — ${Click.toLowerCase()} creatures to spare them${t.spare?.length ? ` (${t.spare.length} spared)` : ""}, then Cast`
            : "It surrounds its caster — Cast to confirm"
          : scaled?.shape === "wall"
            ? `${Click} to lay the wall's points${touch ? " — Cast to finish" : " — Enter to finish"}`
            : `${Click} where it goes${scaled && scaled.shape !== "sphere" && scaled.shape !== "cylinder" && !touch ? " — [ and ] or the wheel to turn it" : ""}`;
  // Picks as a count you can read at a glance (Magic Missile's darts: critic P9 r1 #9).
  const unit = t.repeat
    ? /missile/i.test(spell.name)
      ? "darts"
      : /ray/i.test(spell.name)
        ? "rays"
        : "picks"
    : t.max === 1
      ? "target"
      : "targets";
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
          {kind === "creatures" && !ask ? (
            <span className="flex shrink-0 flex-col items-center px-1" data-testid="targeting-picks">
              <span className="display tabular text-22 leading-none text-bone">
                {picks} / {t.max}
              </span>
              <span className="caps text-12 text-fog">{unit}</span>
            </span>
          ) : null}
          {ask ? (
            <InlineAsk />
          ) : (
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="display truncate text-18 leading-tight text-bone">
                {spell.name} <span className="text-14 text-fog">· {level}</span>
              </span>
              <span className="text-13 text-muted" data-testid="targeting-hint">
                {hint}
              </span>
              {t.refusal ? (
                <span className="text-13 text-ember" data-testid="targeting-why">
                  {t.refusal}
                </span>
              ) : aim && !aim.ok && aim.why ? (
                <span className="text-13 text-ember" data-testid="targeting-why">
                  {aim.why}
                </span>
              ) : kind === "area" && aim && !t.point ? (
                <span className="text-13 text-muted" data-testid="targeting-count">
                  {aim.inside.length} {aim.inside.length === 1 ? "creature" : "creatures"} inside
                  {aim.blocked.length ? ` · ${aim.blocked.length} cut off by a wall` : ""}
                </span>
              ) : null}
            </span>
          )}
          {ask ? null : (
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
                  {alt
                    ? "Its first form"
                    : (spell.areaAlternatives[0]?.label.split(":")[0] ?? "Another form")}
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
          )}
        </div>
      </div>
      <PickCounts />
    </>
  );
}

/** What ending it takes away: "— the Web on the board goes too" (its effects standing), or nothing. */
function heldWords(spell: string): string {
  const held = [...boardData(useEntities.getState()).effects.values()].filter((e) => e.name === spell);
  return held.length ? ` — the ${spell} on the board goes too` : "";
}

/**
 * The concentration question inside the targeting bar, where the cast is being aimed (critic P9 r1 #21: a modal over
 * the board hid what it was about): what it ends and what goes with it; Keep, or End it and cast.
 */
function InlineAsk() {
  const ask = useConcentrationAsk((s) => s.ask);
  // A phone stacks it: the question across the bar, its two answers side by side under it, each half the width
  // (critic P9 r2 #13: beside the buttons the text was squeezed into three lines).
  const phone = useIsPhone();
  if (!ask) return null;
  return (
    <div
      role="group"
      aria-label="End concentration?"
      data-testid="concentration-ask"
      className={
        phone
          ? "flex min-w-0 flex-1 flex-col gap-2"
          : "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2"
      }
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`display leading-tight text-bone ${phone ? "text-16" : "text-18"}`}>
          End concentration on {ask.spell}?
        </span>
        <span className="text-13 text-muted">
          {ask.name} is concentrating on {ask.spell}: casting this ends it{heldWords(ask.spell)}.
        </span>
      </span>
      <span className={phone ? "grid grid-cols-2 gap-2" : "flex items-center gap-2"}>
        <Button size="S" variant="ghost" onClick={() => useConcentrationAsk.getState().set(null)}>
          Keep {ask.spell}
        </Button>
        <Button size="S" variant="primary" onClick={() => void ask.send()}>
          End it and cast
        </Button>
      </span>
    </div>
  );
}

/**
 * How many times each creature is picked (Magic Missile's darts at one goblin: ×2), as a badge by it on the board —
 * a DOM overlay following the view.
 */
function PickCounts() {
  const t = useTargeting((s) => s.t);
  const counts = new Map<string, number>();
  for (const id of t?.picks ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  const many = [...counts].filter(([, n]) => n > 1);
  const refs = useRef(new Map<string, HTMLSpanElement>());
  useEffect(() => {
    if (!many.length) return;
    let raf = 0;
    const loop = () => {
      const tokens = boardData(useEntities.getState()).tokens;
      for (const [id, el] of refs.current) {
        const tok = tokens.get(id);
        // By its upper right, off its face.
        const p = tok
          ? boardApi.project(
              tok.pos.x + tok.sizeFt * 0.45,
              tok.pos.y - tok.sizeFt * 0.45,
              (tok.elevation ?? 0) + 0.2,
            )
          : null;
        if (!p) {
          el.style.display = "none";
          continue;
        }
        el.style.display = "";
        el.style.left = `${Math.round(p.sx)}px`;
        el.style.top = `${Math.round(p.sy)}px`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
  if (!many.length) return null;
  return (
    <>
      {many.map(([id, n]) => (
        <span
          key={id}
          ref={(el) => {
            if (el) refs.current.set(id, el);
            else refs.current.delete(id);
          }}
          data-testid="pick-count"
          data-token={id}
          className="pointer-events-none fixed z-40 -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-chip)] border border-brass bg-ink-900 px-1.5 text-13 font-bold text-brass-bright shadow-[var(--shadow-float)]"
        >
          ×{n}
        </span>
      ))}
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
          ? `${ask.name} is concentrating on ${ask.spell}: casting this ends it${heldWords(ask.spell)}.`
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
