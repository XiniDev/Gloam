import { CONDITION_IDS, DAMAGE_TYPES, SIZES } from "@gloam/shared";
import { Plus, X } from "lucide-react";
import { overrideDerived, type SheetCtx } from "../context.ts";
import {
  DerivedValue,
  LockMark,
  NumberField,
  Pips,
  Rollable,
  SectionTitle,
  TextField,
} from "../primitives.tsx";

/** Overview (§8.10 UI): who the character is, their hit dice, death saves, movement, senses and defences. */
export function OverviewTab({ ctx }: { ctx: SheetCtx }) {
  const c = ctx.sheet.core;
  const ro = !ctx.canEdit;
  return (
    <div className="flex flex-col text-14 text-paper-ink">
      <SectionTitle>Who</SectionTitle>
      <div className="grid grid-cols-[6rem_1fr] items-center gap-x-2 gap-y-1">
        {(
          [
            ["species", "Species"],
            ["background", "Background"],
            ["alignment", "Alignment"],
          ] as const
        ).map(([key, label]) => (
          <Row key={key} label={label} locked={!ctx.free(["core", key])} ctx={ctx}>
            <TextField
              label={label}
              value={c[key] ?? ""}
              disabled={ro}
              onCommit={(v) => void ctx.set(["core", key], v.trim() ? v.trim() : undefined)}
            />
          </Row>
        ))}
        <Row label="XP" locked={!ctx.free(["core", "xp"])} ctx={ctx}>
          <NumberField
            label="Experience points"
            value={c.xp}
            min={0}
            max={10_000_000}
            width="8rem"
            // Boxed and lined up like the text fields above it (left, regular weight), not a centred stat.
            className="justify-self-start !border-parchment-edge/60 !bg-parchment/60 !px-2 !text-left !font-normal"
            disabled={ro}
            onCommit={(v) => void ctx.set(["core", "xp"], v)}
          />
        </Row>
      </div>

      <SectionTitle
        action={
          ro ? null : (
            <AddButton
              label="Add a class"
              onClick={() => void ctx.set(["core", "classes"], [...c.classes, { name: "Fighter", level: 1 }])}
            />
          )
        }
      >
        <span className="group/row inline-flex items-center gap-1">
          Classes · level
          <DerivedValue
            value={ctx.derived.values.level}
            auto={ctx.derived.auto.level}
            overridden={ctx.derived.overridden.has("level")}
            onOverride={(v) => overrideDerived(ctx, "level", v)}
            onRevert={() => overrideDerived(ctx, "level", undefined)}
            label="Character level"
            disabled={ro}
          />
        </span>
      </SectionTitle>
      {c.classes.length === 0 ? <p className="text-13 italic text-paper-muted">No class yet.</p> : null}
      {c.classes.map((k, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <TextField
            label={`Class ${i + 1}`}
            value={k.name}
            disabled={ro}
            onCommit={(v) => v.trim() && void ctx.set(["core", "classes", i, "name"], v.trim())}
          />
          <TextField
            label={`Subclass ${i + 1}`}
            placeholder="subclass"
            value={k.subclass ?? ""}
            disabled={ro}
            onCommit={(v) => void ctx.set(["core", "classes", i, "subclass"], v.trim() || undefined)}
          />
          <NumberField
            label={`Level of class ${i + 1}`}
            value={k.level}
            min={1}
            max={20}
            disabled={ro}
            onCommit={(v) => void ctx.set(["core", "classes", i, "level"], v)}
          />
          {ro ? null : (
            <RemoveButton
              label={`Remove ${k.name}`}
              onClick={() =>
                void ctx.set(
                  ["core", "classes"],
                  c.classes.filter((_, j) => j !== i),
                )
              }
            />
          )}
        </div>
      ))}

      <SectionTitle
        action={
          ro ? null : (
            <AddButton
              label="Add hit dice"
              onClick={() =>
                void ctx.set(["core", "hitDice"], [...c.hitDice, { die: "d8", total: 1, used: 0 }])
              }
            />
          )
        }
      >
        Hit dice
      </SectionTitle>
      {c.hitDice.map((h, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <Rollable
            actor={ctx.actor}
            formula={`1${h.die} + @con`}
            label={`Hit die (${h.die})`}
            className="tabular font-bold"
          >
            {h.die}
          </Rollable>
          <Pips
            label={`${h.die} hit dice spent`}
            total={h.total}
            filled={h.used}
            disabled={ro}
            onSet={(n) => void ctx.set(["core", "hitDice", i, "used"], n)}
          />
          <span className="text-paper-muted">of</span>
          <NumberField
            label={`${h.die} hit dice`}
            value={h.total}
            min={0}
            max={99}
            disabled={ro}
            onCommit={(v) => void ctx.set(["core", "hitDice", i, "total"], v)}
          />
          {ro ? null : (
            <RemoveButton
              label={`Remove ${h.die} hit dice`}
              onClick={() =>
                void ctx.set(
                  ["core", "hitDice"],
                  c.hitDice.filter((_, j) => j !== i),
                )
              }
            />
          )}
        </div>
      ))}

      <SectionTitle>Death saves</SectionTitle>
      <div className="flex flex-wrap items-center gap-3" data-testid="death-saves">
        <Rollable
          actor={ctx.actor}
          formula="1d20"
          label="Death save"
          className="caps text-12"
          test={{ kind: "save" }}
        >
          Roll
        </Rollable>
        <span className="inline-flex items-center gap-1">
          <span className="text-13 text-paper-muted">Successes</span>
          <Pips
            label="Death save successes"
            tone="ink"
            total={3}
            filled={c.deathSaves.successes}
            disabled={ro}
            onSet={(n) => void ctx.set(["core", "deathSaves", "successes"], n)}
          />
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="text-13 text-paper-muted">Failures</span>
          <Pips
            label="Death save failures"
            total={3}
            filled={c.deathSaves.failures}
            disabled={ro}
            onSet={(n) => void ctx.set(["core", "deathSaves", "failures"], n)}
          />
        </span>
      </div>

      <SectionTitle>Movement and size</SectionTitle>
      <div className="grid grid-cols-3 gap-x-2 gap-y-1">
        {(["walk", "fly", "swim", "climb", "burrow"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className="w-12 text-13 capitalize text-paper-muted">{k}</span>
            <NumberField
              label={`${k} speed`}
              value={c.speeds[k]}
              min={0}
              max={1000}
              disabled={ro}
              onCommit={(v) => void ctx.set(["core", "speeds", k], v)}
            />
          </span>
        ))}
        <label className="flex min-h-[var(--touch-min)] items-center gap-1.5 text-13">
          <input
            type="checkbox"
            checked={c.speeds.hover}
            disabled={ro}
            onChange={(e) => void ctx.set(["core", "speeds", "hover"], e.target.checked)}
            className="accent-[var(--wax-500)]"
          />
          hover
        </label>
      </div>
      <label className="mt-1 flex items-center gap-2">
        <span className="w-12 text-13 text-paper-muted">Size</span>
        <select
          aria-label="Size"
          value={c.size}
          disabled={ro}
          onChange={(e) => void ctx.set(["core", "size"], e.target.value)}
          className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-2 text-14 capitalize text-paper-ink"
        >
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <LockMark show={ctx.canEdit && !ctx.free(["core", "size"])} />
      </label>

      <SectionTitle>Senses</SectionTitle>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {(["darkvision", "blindsight", "tremorsense", "truesight"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className="w-24 text-13 capitalize text-paper-muted">{k}</span>
            <NumberField
              label={k}
              value={c.senses[k]}
              min={0}
              max={1000}
              disabled={ro}
              onCommit={(v) => void ctx.set(["core", "senses", k], v)}
            />
          </span>
        ))}
      </div>

      <SectionTitle>Defences</SectionTitle>
      {(
        [
          ["resistances", "Resistant", DAMAGE_TYPES],
          ["immunities", "Immune", DAMAGE_TYPES],
          ["vulnerabilities", "Vulnerable", DAMAGE_TYPES],
          ["conditionImmunities", "Can't be", CONDITION_IDS],
        ] as const
      ).map(([key, label, options]) => (
        <TagList
          key={key}
          label={label}
          values={c[key] as string[]}
          options={options as readonly string[]}
          disabled={ro}
          onChange={(next) => void ctx.set(["core", key], next)}
        />
      ))}

      <SectionTitle>Exhaustion and concentration</SectionTitle>
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1">
          <span className="text-13 text-paper-muted">Exhaustion</span>
          <Pips
            label="Exhaustion level"
            total={6}
            filled={c.exhaustion}
            disabled={ro}
            onSet={(n) => void ctx.set(["core", "exhaustion"], n)}
          />
        </span>
        <span className="inline-flex min-w-0 flex-1 items-center gap-1">
          <span className="text-13 text-paper-muted">Concentrating on</span>
          <TextField
            label="Concentrating on"
            value={c.concentration ?? ""}
            placeholder="nothing"
            disabled={ro}
            onCommit={(v) => void ctx.set(["core", "concentration"], v.trim() || undefined)}
          />
        </span>
      </div>

      <SectionTitle>Languages and proficiencies</SectionTitle>
      <TextField
        label="Languages"
        value={c.languages.join(", ")}
        placeholder="Common, Dwarvish"
        disabled={ro}
        onCommit={(v) => void ctx.set(["core", "languages"], splitList(v))}
      />
      <div className="mt-1">
        <TextField
          label="Other proficiencies"
          value={c.proficiencies.join(", ")}
          placeholder="Smith's tools, light armour"
          disabled={ro}
          onCommit={(v) => void ctx.set(["core", "proficiencies"], splitList(v))}
        />
      </div>
    </div>
  );
}

const splitList = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 50);

function Row({
  label,
  locked,
  ctx,
  children,
}: {
  label: string;
  locked: boolean;
  ctx: SheetCtx;
  children: React.ReactNode;
}) {
  return (
    <>
      <span className="inline-flex items-center gap-1 text-13 text-paper-muted">
        {label}
        <LockMark show={ctx.canEdit && locked} />
      </span>
      {children}
    </>
  );
}

function TagList({
  label,
  values,
  options,
  disabled,
  onChange,
}: {
  label: string;
  values: string[];
  options: readonly string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 py-0.5">
      <span className="w-20 text-13 text-paper-muted">{label}</span>
      {values.length === 0 && disabled ? <span className="text-13 text-paper-muted">—</span> : null}
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex h-6 items-center gap-1 rounded-chip bg-parchment-deep px-1.5 text-13 capitalize"
        >
          {v}
          {disabled ? null : (
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="text-paper-muted hover:text-wax"
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {disabled ? null : (
        <select
          aria-label={`${label}: add`}
          value=""
          onChange={(e) => e.target.value && onChange([...values, e.target.value])}
          className="h-6 min-h-[var(--touch-min)] rounded-chip border border-dashed border-paper-muted bg-transparent px-1 text-13 text-paper-muted"
        >
          <option value="">+</option>
          {options
            .filter((o) => !values.includes(o))
            .map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
        </select>
      )}
    </div>
  );
}

export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-6 min-h-[var(--touch-min)] w-6 min-w-[var(--touch-min)] place-items-center rounded-chip text-paper-muted hover:bg-parchment-deep hover:text-wax"
    >
      <Plus size={15} />
    </button>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 min-h-[var(--touch-min)] w-7 min-w-[var(--touch-min)] shrink-0 place-items-center rounded-chip text-paper-muted hover:bg-parchment-deep hover:text-wax"
    >
      <X size={14} />
    </button>
  );
}
