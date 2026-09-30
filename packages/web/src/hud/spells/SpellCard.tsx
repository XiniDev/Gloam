import {
  areaAtSlot,
  areaText,
  castingTimeText,
  componentsText,
  durationText,
  levelSchool,
  rangeText,
  scaledFormula,
} from "@gloam/shared/rules";
import type { Spell } from "@gloam/shared/schemas";
import type { ReactNode } from "react";
import { DocMarkdown } from "../../ui/DocMarkdown.tsx";
import { Filigree } from "../../ui/ornaments.tsx";
import { SrdLine } from "../../ui/SrdLine.tsx";

/**
 * The colour of a spell's header band (SPEC §28 "coloured by school or damage type"): its damage's (the first part's,
 * or the one it's cast with), healing's, else the spell colour (arcane).
 */
export function bandColor(spell: Pick<Spell, "damage" | "healing">): string {
  const t = spell.damage?.[0]?.type;
  if (t) return `var(--dmg-${t})`;
  if (spell.healing) return "var(--dmg-healing)";
  return "var(--arcane-400)";
}

const ABILITY: Record<string, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

/**
 * A spell's card (SPEC §8.13 Spell card): a parchment card — its name, level and school, casting time, range,
 * components, duration (a Concentration badge, a Ritual tag), what it does in a structured strip (area, save, attack,
 * damage or healing, at this slot when one is chosen, with what each slot above adds), its text, the higher-level or
 * cantrip-upgrade paragraph, its classes, and for SRD spells the attribution line.
 */
export function SpellCard({
  spell,
  slot,
  casterLevel = 1,
  footer,
  compact = false,
}: {
  spell: Spell;
  /** The slot it would be cast at (its damage and area at that slot). */
  slot?: number | null;
  casterLevel?: number;
  footer?: ReactNode;
  /** Without its long text (a preview beside a list). */
  compact?: boolean;
}) {
  const level = slot ?? spell.level;
  const area = spell.area ? areaAtSlot(spell.area, spell.level, level) : null;
  const dmg = spell.damage?.map((d) => ({
    formula: scaledFormula(d.formula, d.scaling, spell.level, level, casterLevel),
    type: d.typeOptions ? d.typeOptions.join(" or ") : d.type,
    per: d.scaling?.mode === "slot" ? d.scaling.perLevel : null,
  }));
  const heal = spell.healing
    ? scaledFormula(spell.healing.formula, spell.healing.scaling, spell.level, level, casterLevel)
    : null;
  const srd = spell.source.pack.startsWith("srd");
  const band = bandColor(spell);
  return (
    <article
      className="parchment relative flex flex-col gap-2.5 overflow-hidden p-4 text-paper-ink"
      data-testid="spell-card"
      data-spell={spell.id}
      data-band={band}
      aria-label={spell.name}
    >
      {/* Its header band, in the colour of what it does (a school's or its damage's), under the corner filigree. */}
      <header
        className="-mx-4 -mt-4 flex flex-col gap-0.5 px-4 pb-2.5 pt-4"
        style={{
          background: `linear-gradient(180deg, color-mix(in srgb, ${band} 34%, transparent), color-mix(in srgb, ${band} 14%, transparent))`,
          borderBottom: `2px solid color-mix(in srgb, ${band} 62%, var(--parchment-ink))`,
        }}
        data-testid="spell-band"
      >
        <div className="flex items-start gap-2">
          <h3 className="display min-w-0 flex-1 text-22 leading-tight">{spell.name}</h3>
          {spell.duration.concentration ? (
            <Badge title="Concentration: it ends if the caster's concentration does">C</Badge>
          ) : null}
          {spell.ritual ? <Badge title="Ritual: cast in 10 more minutes without a slot">R</Badge> : null}
        </div>
        <p className="text-14 italic text-paper-muted">{levelSchool(spell)}</p>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-13">
        <Row label="Casting time">{castingTimeText(spell.castingTime)}</Row>
        <Row label="Range">{rangeText(spell.range)}</Row>
        <Row label="Components">{componentsText(spell.components)}</Row>
        <Row label="Duration">{durationText(spell.duration)}</Row>
      </dl>
      {area || spell.save || spell.attack || dmg?.length || heal ? (
        <ul
          className="flex flex-wrap gap-x-4 gap-y-1 border-y border-parchment-edge/60 py-1.5 text-13"
          data-testid="spell-strip"
        >
          {area ? <Strip label="Area">{areaText(area)}</Strip> : null}
          {spell.attack ? (
            <Strip label="Attack">{`${spell.attack.kind === "melee" ? "Melee" : "Ranged"} spell attack`}</Strip>
          ) : null}
          {spell.save ? (
            <Strip label="Save">
              {`${ABILITY[spell.save.ability]}${spell.save.onSuccess === "half" ? ", half on a success" : spell.save.onSuccess === "none" ? ", none on a success" : ""}`}
            </Strip>
          ) : null}
          {dmg?.map((d) => (
            <Strip key={`${d.formula}${d.type}`} label="Damage">
              {`${d.formula} ${d.type}`}
              {d.per && spell.level > 0 ? (
                <span className="text-paper-muted">
                  {" "}
                  (+{d.per} a slot above {spell.level})
                </span>
              ) : null}
            </Strip>
          ))}
          {heal ? (
            <Strip label="Healing">{heal.replace("@spellmod", "your spellcasting modifier")}</Strip>
          ) : null}
        </ul>
      ) : null}
      {compact ? null : (
        <div className="spell-text flex flex-col gap-2 text-14 leading-relaxed [&_p]:m-0 [&_table]:text-13 [&_td]:pr-3 [&_th]:pr-3 [&_th]:text-left">
          <DocMarkdown>{spell.text}</DocMarkdown>
          {spell.higherLevels ? (
            <p>
              <strong className="italic">Using a Higher-Level Spell Slot.</strong> {spell.higherLevels}
            </p>
          ) : null}
          {spell.cantripUpgrade ? (
            <p>
              <strong className="italic">Cantrip Upgrade.</strong> {spell.cantripUpgrade}
            </p>
          ) : null}
        </div>
      )}
      {spell.classes.length ? (
        <p className="text-13 text-paper-muted">
          {spell.classes.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(", ")}
        </p>
      ) : null}
      {srd ? (
        <SrdLine page={spell.source.page} className="text-paper-muted" />
      ) : (
        <p className="text-12 italic text-paper-muted">Homebrew</p>
      )}
      {footer}
      <Filigree />
    </article>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-bold">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Strip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li>
      <span className="caps text-12 text-paper-muted">{label}</span>{" "}
      <span className="font-bold">{children}</span>
    </li>
  );
}

function Badge({ children, title }: { children: ReactNode; title: string }) {
  return (
    <span
      title={title}
      role="img"
      aria-label={title}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-chip)] border border-paper-ink/40 font-bold text-13"
    >
      {children}
    </span>
  );
}
