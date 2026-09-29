import { ABILITIES, CONDITION_IDS, DAMAGE_TYPES, SPELL_SCHOOLS, VFX_PRESETS } from "@gloam/shared";
import { checkFormula } from "@gloam/shared/dice";
import { issueText, type Spell, SpellSchema } from "@gloam/shared/schemas";
import { Check as CheckIcon, CircleAlert, Minus, Plus } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { saveHomebrew, useSpells } from "../../net/spells.ts";
import { useTable } from "../../net/table.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented, Toggle } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";
import { useIsPhone } from "../insets.ts";
import { SpellCard } from "./SpellCard.tsx";

/** The draft: the spell's input shape, loosely typed while it's being written (the schema checks it). */
type Draft = Record<string, unknown>;

/** The VFX preset a spell's effect implies (§8.13: "chosen from the damage type"): healing's, its first damage's. */
function impliedVfx(d: Draft): string | null {
  if (d.healing) return "healing";
  const t = (d.damage as { type?: unknown }[] | undefined)?.[0]?.type;
  return typeof t === "string" && (VFX_PRESETS as readonly string[]).includes(t) ? t : null;
}

const CLASSES = ["bard", "cleric", "druid", "paladin", "ranger", "sorcerer", "warlock", "wizard"];
const SHAPES = ["sphere", "cylinder", "cone", "cube", "line", "emanation", "wall"] as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const kebab = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const BLANK: Draft = {
  id: "",
  name: "",
  level: 1,
  school: "evocation",
  classes: [],
  castingTime: { amount: 1, unit: "action" },
  ritual: false,
  range: { kind: "ranged", ft: 60 },
  components: { v: true, s: true, m: false },
  duration: { kind: "instantaneous", concentration: false },
  text: "",
  targeting: { kind: "creatures", count: 1 },
  vfx: "arcane",
  source: { pack: "homebrew" },
};

/** Reads a path of the draft. */
function at(d: Draft, path: (string | number)[]): unknown {
  let cur: unknown = d;
  for (const k of path)
    cur = cur && typeof cur === "object" ? (cur as Record<string | number, unknown>)[k] : undefined;
  return cur;
}
/** The draft with a path set (undefined removes it). */
function put(d: Draft, path: (string | number)[], v: unknown): Draft {
  const copy = (x: unknown) =>
    Array.isArray(x) ? [...x] : x && typeof x === "object" ? { ...(x as object) } : {};
  const root = copy(d) as Record<string | number, unknown>;
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as string | number;
    const next = copy(cur[k]) as Record<string | number, unknown>;
    cur[k] = next;
    cur = next;
  }
  const last = path[path.length - 1] as string | number;
  if (v === undefined) {
    if (Array.isArray(cur)) (cur as unknown[]).splice(last as number, 1);
    else delete cur[last];
  } else cur[last] = v;
  return root as Draft;
}

/** Every formula in the draft checked against the dice grammar (§18.1). */
function formulaErrors(d: Draft): string[] {
  const out: string[] = [];
  const check = (where: string, f: unknown) => {
    if (typeof f !== "string" || !f.trim()) return;
    const e = checkFormula(f);
    if (e) out.push(`${where}: ${e.message}`);
  };
  ((d.damage as Draft[] | undefined) ?? []).forEach((x, i) => {
    check(`Damage ${i + 1}`, x.formula);
    check(`Damage ${i + 1} per slot`, at(x, ["scaling", "perLevel"]));
  });
  check("Healing", at(d, ["healing", "formula"]));
  check("Healing per slot", at(d, ["healing", "scaling", "perLevel"]));
  for (const [i, t] of ((at(d, ["effect", "triggers"]) as Draft[] | undefined) ?? []).entries())
    check(`Trigger ${i + 1} damage`, at(t, ["damage", "formula"]));
  return out;
}

/**
 * The homebrew builder (SPEC §8.13; AC-SPL-10): every field of the spell schema (§33.3, Appendix F.2) — its name and
 * id, level, school, classes, casting time, range, components, duration, text, targeting and area, attack or save,
 * damage and healing with their scaling, conditions, a lasting effect (its properties, triggers, what it's attached
 * to, how it moves), its light and obscurement, its VFX — beside a live card of it and what the schema says is wrong,
 * as it's typed. The DM saves it into the campaign; a player proposes it (the DM approves it). A spell opened from the
 * list comes in as a template ("Poison Ball" from Fireball).
 */
export function HomebrewBuilder({
  open,
  initial,
  replaces,
  onClose,
}: {
  open: boolean;
  initial: Spell | null;
  /** The homebrew spell this edits (its content id). */
  replaces?: string;
  onClose: () => void;
}) {
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const [d, setD] = useState<Draft>(BLANK);
  const [idTouched, setIdTouched] = useState(false);
  // The VFX follows the damage type until it's chosen by hand (an override: §8.13 "can be overridden per spell").
  const [vfxChosen, setVfxChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The DM's own (an NPC's signature spell): no player sees it or casts it.
  const was = useSpells((s) => (replaces ? s.homebrew.find((h) => h.id === replaces) : undefined));
  const [dmOnly, setDmOnly] = useState(false);
  useEffect(() => {
    if (open) setDmOnly(was?.status === "private");
  }, [open, was?.status]);
  useEffect(() => {
    if (!open) return;
    if (initial) {
      const { provenance: _p, ...rest } = initial as Spell & { provenance?: unknown };
      setD({ ...rest, source: { pack: "homebrew" } } as unknown as Draft);
      setIdTouched(true);
      const implied = impliedVfx(rest as unknown as Draft);
      setVfxChosen(implied !== null && implied !== initial.vfx);
    } else {
      setD(BLANK);
      setIdTouched(false);
      setVfxChosen(false);
    }
  }, [open, initial]);
  const set = (path: (string | number)[], v: unknown) =>
    setD((x) => {
      let next = put(x, path, v);
      if (path[0] === "name" && !idTouched) next = put(next, ["id"], kebab(String(v)));
      if ((path[0] === "damage" || path[0] === "healing") && !vfxChosen) {
        const implied = impliedVfx(next);
        if (implied) next = put(next, ["vfx"], implied);
      }
      return next;
    });
  const parsed = useMemo(() => SpellSchema.safeParse(d), [d]);
  const errors = useMemo(() => {
    const out = parsed.success
      ? []
      : parsed.error.issues
          .slice(0, 20)
          .map((i) => `${i.path.join(".") || "The spell"} ${issueText(i as never, d)}`);
    return [...out, ...formulaErrors(d)];
  }, [parsed, d]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await saveHomebrew(
        d as never,
        replaces,
        dm && was?.status !== "proposed" ? dmOnly : undefined,
      );
      toast.success(
        r.status === "proposed" ? `${String(d.name)} sent to the DM` : `${String(d.name)} saved`,
        r.status === "proposed"
          ? "It's in use once they approve it."
          : r.status === "private"
            ? "Yours alone: no player sees it."
            : "It's in the spell list now.",
      );
      onClose();
    } catch (e) {
      toast.danger("Couldn't save it", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const level = Number(d.level ?? 0);
  const hasArea = Boolean(d.area);
  const hasEffect = Boolean(d.effect);
  const phone = useIsPhone();
  // A phone has no room for the card beside the form: a Preview switch shows it instead (critic P9 r1 #16).
  const [view, setView] = useState<"edit" | "preview">("edit");
  useEffect(() => {
    if (open) setView("edit");
  }, [open]);
  const problems = useRef<HTMLUListElement>(null);
  const showProblems = () => {
    if (phone) setView("preview");
    requestAnimationFrame(() => problems.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        replaces
          ? `Edit ${String(d.name || "the spell")}`
          : initial
            ? "Homebrew from a template"
            : "New spell"
      }
      description={
        phone
          ? "Every field of the spell schema; Preview shows the card the table will see."
          : "Every field of the spell schema; the card beside it is what the table will see."
      }
      width={1100}
      footer={
        <div className="flex items-center justify-end gap-2">
          {/* Whether it's valid, with its icon; its problems a press away (critic P9 r1 #16). */}
          {errors.length ? (
            <button
              type="button"
              onClick={showProblems}
              data-testid="builder-status"
              className="mr-auto inline-flex min-h-[var(--touch-min)] items-center gap-1.5 text-13 font-bold text-[var(--ember-400)] underline decoration-dotted underline-offset-2"
            >
              <CircleAlert size={15} aria-hidden />
              {errors.length} {errors.length === 1 ? "problem" : "problems"}
            </button>
          ) : (
            <span
              className="mr-auto inline-flex items-center gap-1.5 text-13 font-bold text-[var(--hp-high)]"
              data-testid="builder-status"
            >
              <CheckIcon size={15} aria-hidden />
              Valid
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={errors.length > 0} onClick={() => void save()}>
            {dm ? "Save spell" : "Propose to the DM"}
          </Button>
        </div>
      }
    >
      {phone ? (
        <div className="mb-3">
          <Segmented
            label="Form or preview"
            fill
            value={view}
            onChange={setView}
            options={[
              { value: "edit", label: "Edit" },
              { value: "preview", label: "Preview" },
            ]}
          />
        </div>
      ) : null}
      <div
        className="grid gap-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
        data-testid="homebrew-builder"
      >
        <div className={`flex flex-col gap-5 ${phone && view === "preview" ? "hidden" : ""}`}>
          <Group title="Basics">
            <Row>
              <Txt label="Name" value={d.name} onChange={(v) => set(["name"], v)} wide />
              <Txt
                label="Id"
                value={d.id}
                onChange={(v) => {
                  setIdTouched(true);
                  set(["id"], v);
                }}
              />
            </Row>
            <Row>
              <Sel
                label="Level"
                value={String(level)}
                options={Array.from({ length: 10 }, (_, i) => ({
                  value: String(i),
                  label: i === 0 ? "Cantrip" : `Level ${i}`,
                }))}
                onChange={(v) => set(["level"], Number(v))}
              />
              <Sel
                label="School"
                value={String(d.school)}
                options={SPELL_SCHOOLS.map((s) => ({ value: s, label: cap(s) }))}
                onChange={(v) => set(["school"], v)}
              />
              <Sel
                label="VFX"
                value={String(d.vfx)}
                options={VFX_PRESETS.map((v) => ({
                  value: v,
                  label:
                    !vfxChosen && v === d.vfx && impliedVfx(d) === v ? `${cap(v)} (its damage's)` : cap(v),
                }))}
                onChange={(v) => {
                  setVfxChosen(true);
                  set(["vfx"], v);
                }}
              />
            </Row>
            <Chips
              label="Classes"
              options={CLASSES}
              value={(d.classes as string[]) ?? []}
              onChange={(v) => set(["classes"], v)}
            />
            <Check label="Ritual" checked={Boolean(d.ritual)} onChange={(v) => set(["ritual"], v)} />
            {dm && was?.status !== "proposed" ? (
              <Toggle
                checked={dmOnly}
                onChange={setDmOnly}
                label="DM only"
                description="Only you see it and cast it (an NPC's own spell); the players never do."
              />
            ) : null}
          </Group>
          <Group title="Casting">
            <Row>
              <Num
                label="Casting time"
                value={at(d, ["castingTime", "amount"])}
                onChange={(v) => set(["castingTime", "amount"], v)}
                min={1}
              />
              <Sel
                label="Unit"
                value={String(at(d, ["castingTime", "unit"]))}
                options={["action", "bonus", "reaction", "minute", "hour"].map((u) => ({
                  value: u,
                  label: cap(u === "bonus" ? "bonus action" : u),
                }))}
                onChange={(v) => set(["castingTime", "unit"], v)}
              />
              {at(d, ["castingTime", "unit"]) === "reaction" ? (
                <Txt
                  label="Trigger"
                  value={at(d, ["castingTime", "reactionTrigger"])}
                  onChange={(v) => set(["castingTime", "reactionTrigger"], v || undefined)}
                  wide
                />
              ) : null}
            </Row>
            <Row>
              <Sel
                label="Range"
                value={String(at(d, ["range", "kind"]))}
                options={["self", "touch", "ranged", "sight", "unlimited", "special"].map((k) => ({
                  value: k,
                  label: cap(k),
                }))}
                onChange={(v) =>
                  set(
                    ["range"],
                    v === "ranged" ? { kind: v, ft: Number(at(d, ["range", "ft"]) ?? 60) } : { kind: v },
                  )
                }
              />
              {at(d, ["range", "kind"]) === "ranged" ? (
                <Num
                  label="Feet"
                  value={at(d, ["range", "ft"])}
                  onChange={(v) => set(["range", "ft"], v)}
                  min={0}
                />
              ) : null}
            </Row>
            <Row>
              <Check
                label="Verbal"
                checked={Boolean(at(d, ["components", "v"]))}
                onChange={(v) => set(["components", "v"], v)}
              />
              <Check
                label="Somatic"
                checked={Boolean(at(d, ["components", "s"]))}
                onChange={(v) => set(["components", "s"], v)}
              />
              <Check
                label="Material"
                checked={Boolean(at(d, ["components", "m"]))}
                onChange={(v) => set(["components", "m"], v)}
              />
            </Row>
            {at(d, ["components", "m"]) ? (
              <Row>
                <Txt
                  label="Material"
                  value={at(d, ["components", "material"])}
                  onChange={(v) => set(["components", "material"], v || undefined)}
                  wide
                />
                <Num
                  label="Cost (GP)"
                  value={at(d, ["components", "costGp"])}
                  onChange={(v) => set(["components", "costGp"], v)}
                  min={0}
                  optional
                />
                <Check
                  label="Consumed"
                  checked={Boolean(at(d, ["components", "consumed"]))}
                  onChange={(v) => set(["components", "consumed"], v || undefined)}
                />
              </Row>
            ) : null}
            <Row>
              <Sel
                label="Duration"
                value={String(at(d, ["duration", "kind"]))}
                options={["instantaneous", "timed", "until-dispelled", "special"].map((k) => ({
                  value: k,
                  label: cap(k.replace("-", " ")),
                }))}
                onChange={(v) =>
                  set(["duration"], {
                    kind: v,
                    concentration: Boolean(at(d, ["duration", "concentration"])),
                    ...(v === "timed" ? { amount: 1, unit: "minute" } : {}),
                  })
                }
              />
              {at(d, ["duration", "kind"]) === "timed" ? (
                <>
                  <Num
                    label="Amount"
                    value={at(d, ["duration", "amount"])}
                    onChange={(v) => set(["duration", "amount"], v)}
                    min={1}
                  />
                  <Sel
                    label="Unit"
                    value={String(at(d, ["duration", "unit"]) ?? "minute")}
                    options={["round", "minute", "hour", "day"].map((u) => ({ value: u, label: cap(u) }))}
                    onChange={(v) => set(["duration", "unit"], v)}
                  />
                </>
              ) : null}
              <Check
                label="Concentration"
                checked={Boolean(at(d, ["duration", "concentration"]))}
                onChange={(v) => set(["duration", "concentration"], v)}
              />
            </Row>
          </Group>
          <Group title="Text">
            <Area label="Description (Markdown)" value={d.text} onChange={(v) => set(["text"], v)} rows={5} />
            {level > 0 ? (
              <Area
                label="Using a higher-level slot"
                value={d.higherLevels}
                onChange={(v) => set(["higherLevels"], v || undefined)}
                rows={2}
              />
            ) : (
              <Area
                label="Cantrip upgrade"
                value={d.cantripUpgrade}
                onChange={(v) => set(["cantripUpgrade"], v || undefined)}
                rows={2}
              />
            )}
          </Group>
          <Group title="Targeting and area">
            <Row>
              <Sel
                label="Targets"
                value={String(at(d, ["targeting", "kind"]) ?? "creatures")}
                options={["area", "creatures", "self", "point", "object"].map((k) => ({
                  value: k,
                  label: cap(k),
                }))}
                onChange={(v) => set(["targeting", "kind"], v)}
              />
              <Num
                label="How many"
                value={at(d, ["targeting", "count"])}
                onChange={(v) => set(["targeting", "count"], v)}
                min={1}
                optional
              />
              <Num
                label="+ per slot"
                value={at(d, ["targeting", "countPerSlot"])}
                onChange={(v) => set(["targeting", "countPerSlot"], v)}
                min={0}
                optional
              />
            </Row>
            <Check
              label="It has an area"
              checked={hasArea}
              onChange={(on) => set(["area"], on ? { shape: "sphere", radius: 20 } : undefined)}
            />
            {hasArea ? <AreaFields d={d} set={set} /> : null}
          </Group>
          <Group title="Attack, save, damage">
            <Row>
              <Sel
                label="Attack"
                value={String(at(d, ["attack", "kind"]) ?? "none")}
                options={[
                  { value: "none", label: "None" },
                  { value: "melee", label: "Melee spell attack" },
                  { value: "ranged", label: "Ranged spell attack" },
                ]}
                onChange={(v) => set(["attack"], v === "none" ? undefined : { kind: v })}
              />
              <Sel
                label="Save"
                value={String(at(d, ["save", "ability"]) ?? "none")}
                options={[
                  { value: "none", label: "None" },
                  ...ABILITIES.map((a) => ({ value: a, label: a.toUpperCase() })),
                ]}
                onChange={(v) =>
                  set(
                    ["save"],
                    v === "none"
                      ? undefined
                      : { ability: v, onSuccess: String(at(d, ["save", "onSuccess"]) ?? "half") },
                  )
                }
              />
              {d.save ? (
                <Sel
                  label="On a success"
                  value={String(at(d, ["save", "onSuccess"]))}
                  options={[
                    { value: "half", label: "Half" },
                    { value: "none", label: "None" },
                    { value: "special", label: "As the text says" },
                  ]}
                  onChange={(v) => set(["save", "onSuccess"], v)}
                />
              ) : null}
            </Row>
            <DamageRows d={d} set={set} level={level} />
            <Row>
              <Txt
                label="Healing"
                value={at(d, ["healing", "formula"])}
                placeholder="e.g. 2d8 + @spellmod"
                onChange={(v) =>
                  set(["healing"], v ? { ...((d.healing as Draft) ?? {}), formula: v } : undefined)
                }
                mono
                wide
              />
              {d.healing && level > 0 ? (
                <Txt
                  label="+ per slot"
                  value={at(d, ["healing", "scaling", "perLevel"])}
                  placeholder="e.g. 2d8"
                  onChange={(v) => set(["healing", "scaling"], v ? { mode: "slot", perLevel: v } : undefined)}
                  mono
                />
              ) : null}
            </Row>
            <ConditionRows d={d} set={set} />
          </Group>
          <Group title="What it leaves">
            <Row>
              <Sel
                label="Obscures"
                value={String(d.obscurement ?? "none")}
                options={[
                  { value: "none", label: "Nothing" },
                  { value: "light", label: "Lightly" },
                  { value: "heavy", label: "Heavily" },
                  { value: "magicalDarkness", label: "Magical darkness" },
                ]}
                onChange={(v) => set(["obscurement"], v === "none" ? undefined : v)}
              />
              <Num
                label="Bright light (ft)"
                value={at(d, ["light", "bright"])}
                onChange={(v) =>
                  set(
                    ["light"],
                    v === undefined && at(d, ["light", "dim"]) === undefined
                      ? undefined
                      : { ...((d.light as Draft) ?? { dim: 0 }), bright: v ?? 0 },
                  )
                }
                min={0}
                optional
              />
              <Num
                label="+ dim (ft)"
                value={at(d, ["light", "dim"])}
                onChange={(v) =>
                  set(
                    ["light"],
                    v === undefined && at(d, ["light", "bright"]) === undefined
                      ? undefined
                      : { ...((d.light as Draft) ?? { bright: 0 }), dim: v ?? 0 },
                  )
                }
                min={0}
                optional
              />
            </Row>
            <Check
              label="A lasting effect on the board"
              checked={hasEffect}
              onChange={(on) =>
                set(["effect"], on ? { props: {}, triggers: [], attach: "point" } : undefined)
              }
            />
            {hasEffect ? <EffectFields d={d} set={set} /> : null}
          </Group>
        </div>
        <aside
          className={`flex min-w-0 flex-col gap-3 md:sticky md:top-0 md:self-start ${phone && view === "edit" ? "hidden" : ""}`}
        >
          {parsed.success ? (
            <SpellCard spell={parsed.data} />
          ) : (
            <div className="parchment p-4 text-14 italic text-paper-muted">
              The card appears once the spell is valid.
            </div>
          )}
          {errors.length ? (
            <ul
              ref={problems}
              className="flex flex-col gap-1 rounded-[var(--radius-control)] border border-[var(--ember-400)]/50 p-3 text-13 text-[var(--ember-400)]"
              data-testid="builder-errors"
            >
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
        </aside>
      </div>
    </Dialog>
  );
}

type Set = (path: (string | number)[], v: unknown) => void;

function AreaFields({ d, set }: { d: Draft; set: Set }) {
  const shape = String(at(d, ["area", "shape"]));
  const dims: Record<string, [string, string][]> = {
    sphere: [["radius", "Radius (ft)"]],
    cylinder: [
      ["radius", "Radius (ft)"],
      ["height", "Height (ft)"],
    ],
    cone: [["length", "Length (ft)"]],
    cube: [["size", "Side (ft)"]],
    line: [
      ["length", "Length (ft)"],
      ["width", "Width (ft)"],
    ],
    emanation: [["distance", "Distance (ft)"]],
    wall: [
      ["length", "Length (ft)"],
      ["height", "Height (ft)"],
      ["thickness", "Thickness (ft)"],
      ["ring", "Ring across (ft)"],
    ],
  };
  const defaults: Record<string, Draft> = {
    sphere: { radius: 20 },
    cylinder: { radius: 10, height: 20 },
    cone: { length: 15 },
    cube: { size: 15 },
    line: { length: 60, width: 5 },
    emanation: { distance: 10 },
    wall: { length: 60, height: 20, thickness: 1, opaque: false, blocksMove: false },
  };
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line/70 p-2.5">
      <Row>
        <Sel
          label="Shape"
          value={shape}
          options={SHAPES.map((s) => ({ value: s, label: cap(s) }))}
          onChange={(v) => set(["area"], { shape: v, ...defaults[v] })}
        />
        {(dims[shape] ?? []).map(([k, label]) => (
          <Num
            key={k}
            label={label}
            value={at(d, ["area", k])}
            onChange={(v) => set(["area", k], v)}
            min={0}
            optional={k === "ring"}
          />
        ))}
        <Num
          label="+ ft per slot"
          value={at(d, ["area", "scaling", "perSlot"])}
          onChange={(v) => set(["area", "scaling"], v === undefined ? undefined : { perSlot: v })}
          min={0}
          optional
        />
      </Row>
      {shape === "wall" ? (
        <Row>
          <Check
            label="Opaque"
            checked={Boolean(at(d, ["area", "opaque"]))}
            onChange={(v) => set(["area", "opaque"], v)}
          />
          <Check
            label="Blocks movement"
            checked={Boolean(at(d, ["area", "blocksMove"]))}
            onChange={(v) => set(["area", "blocksMove"], v)}
          />
          <Sel
            label="Damaging side"
            value={String(at(d, ["area", "damagingSide"]) ?? "none")}
            options={[
              { value: "none", label: "None" },
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
              { value: "both", label: "Both" },
            ]}
            onChange={(v) => set(["area", "damagingSide"], v === "none" ? undefined : v)}
          />
        </Row>
      ) : null}
    </div>
  );
}

function DamageRows({ d, set, level }: { d: Draft; set: Set; level: number }) {
  const rows = ((d.damage as Draft[] | undefined) ?? []) as Draft[];
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line/70 p-2.5"
          data-testid="damage-row"
        >
          <Row>
            <Txt
              label={`Damage ${i + 1}`}
              value={r.formula}
              placeholder="e.g. 8d6"
              onChange={(v) => set(["damage", i, "formula"], v)}
              mono
              wide
            />
            <Sel
              label="Type"
              value={String(r.type ?? "fire")}
              options={DAMAGE_TYPES.map((t) => ({ value: t, label: cap(t) }))}
              onChange={(v) => set(["damage", i, "type"], v)}
            />
            <IconButton
              label={`Remove damage ${i + 1}`}
              onClick={() => set(["damage"], rows.length === 1 ? undefined : rows.filter((_, j) => j !== i))}
            >
              <Minus size={15} />
            </IconButton>
          </Row>
          {level > 0 ? (
            <Txt
              label="+ per slot above"
              value={at(r, ["scaling", "perLevel"])}
              placeholder="e.g. 1d6"
              onChange={(v) => set(["damage", i, "scaling"], v ? { mode: "slot", perLevel: v } : undefined)}
              mono
            />
          ) : (
            <Row>
              {(["5", "11", "17"] as const).map((lvl) => (
                <Txt
                  key={lvl}
                  label={`At level ${lvl}`}
                  value={at(r, ["scaling", "atLevels", lvl])}
                  placeholder="e.g. 2d10"
                  onChange={(v) => {
                    const cur = (at(r, ["scaling", "atLevels"]) as Draft | undefined) ?? {};
                    const next = { ...cur, [lvl]: v || undefined };
                    const clean = Object.fromEntries(Object.entries(next).filter(([, x]) => x));
                    set(
                      ["damage", i, "scaling"],
                      Object.keys(clean).length ? { mode: "cantrip", atLevels: clean } : undefined,
                    );
                  }}
                  mono
                />
              ))}
            </Row>
          )}
        </div>
      ))}
      <Button
        size="S"
        variant="ghost"
        icon={<Plus size={14} />}
        onClick={() => set(["damage"], [...rows, { formula: "1d6", type: "fire" }])}
      >
        Add damage
      </Button>
    </div>
  );
}

function ConditionRows({ d, set }: { d: Draft; set: Set }) {
  const rows = ((d.conditions as Draft[] | undefined) ?? []) as Draft[];
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <Row key={i}>
          <Sel
            label={`Condition ${i + 1}`}
            value={String(r.id ?? "restrained")}
            options={CONDITION_IDS.map((c) => ({ value: c, label: cap(c) }))}
            onChange={(v) => set(["conditions", i, "id"], v)}
          />
          <Check
            label="On a failed save"
            checked={r.onFailedSave !== false}
            onChange={(v) => set(["conditions", i, "onFailedSave"], v)}
          />
          <Num
            label="Rounds"
            value={at(r, ["duration", "rounds"])}
            onChange={(v) => set(["conditions", i, "duration"], v === undefined ? undefined : { rounds: v })}
            min={1}
            optional
          />
          <IconButton
            label={`Remove condition ${i + 1}`}
            onClick={() =>
              set(["conditions"], rows.length === 1 ? undefined : rows.filter((_, j) => j !== i))
            }
          >
            <Minus size={15} />
          </IconButton>
        </Row>
      ))}
      <Button
        size="S"
        variant="ghost"
        icon={<Plus size={14} />}
        onClick={() => set(["conditions"], [...rows, { id: "restrained", onFailedSave: true }])}
      >
        Add a condition
      </Button>
    </div>
  );
}

function EffectFields({ d, set }: { d: Draft; set: Set }) {
  const props = (at(d, ["effect", "props"]) as Draft) ?? {};
  const triggers = ((at(d, ["effect", "triggers"]) as Draft[] | undefined) ?? []) as Draft[];
  const flag = (k: string, label: string) => (
    <Check
      label={label}
      checked={Boolean(props[k])}
      onChange={(v) => set(["effect", "props", k], v || undefined)}
    />
  );
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-control)] border border-line/70 p-2.5">
      <Row>
        <Sel
          label="Attached to"
          value={String(at(d, ["effect", "attach"]) ?? "point")}
          options={[
            { value: "point", label: "Where it's placed" },
            { value: "caster", label: "The caster (moves with them)" },
            { value: "object", label: "An object" },
            { value: "target", label: "Each creature it affects" },
          ]}
          onChange={(v) => set(["effect", "attach"], v)}
        />
        <Sel
          label="Obscures"
          value={String(props.obscurement ?? "none")}
          options={[
            { value: "none", label: "Nothing" },
            { value: "light", label: "Lightly" },
            { value: "heavy", label: "Heavily" },
          ]}
          onChange={(v) => set(["effect", "props", "obscurement"], v === "none" ? undefined : v)}
        />
      </Row>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {flag("difficult", "Difficult terrain")}
        {flag("magicalDarkness", "Magical darkness")}
        {flag("opaque", "Blocks sight")}
        {flag("silence", "Silence")}
        {flag("outline", "Outlines creatures")}
        {flag("speedHalved", "Halves Speed")}
        {flag("seeInvisible", "Sees the Invisible")}
      </div>
      <Row>
        <Num
          label="Its bright light (ft)"
          value={at(props, ["light", "bright"])}
          onChange={(v) =>
            set(
              ["effect", "props", "light"],
              v === undefined
                ? undefined
                : {
                    ...((props.light as Draft) ?? { dim: 0, magical: true, pierceDarkness: false }),
                    bright: v,
                  },
            )
          }
          min={0}
          optional
        />
        <Num
          label="+ dim (ft)"
          value={at(props, ["light", "dim"])}
          onChange={(v) =>
            set(
              ["effect", "props", "light"],
              v === undefined
                ? undefined
                : {
                    ...((props.light as Draft) ?? { bright: 0, magical: true, pierceDarkness: false }),
                    dim: v,
                  },
            )
          }
          min={0}
          optional
        />
      </Row>
      <Row>
        <Sel
          label="Moved by"
          value={String(at(d, ["effect", "movement", "by"]) ?? "none")}
          options={[
            { value: "none", label: "It stays" },
            { value: "caster", label: "Its caster" },
            { value: "dm", label: "The DM" },
          ]}
          onChange={(v) => set(["effect", "movement"], v === "none" ? undefined : { by: v })}
        />
        {at(d, ["effect", "movement"]) ? (
          <>
            <Num
              label="Up to (ft)"
              value={at(d, ["effect", "movement", "maxFt"])}
              onChange={(v) => set(["effect", "movement", "maxFt"], v)}
              min={0}
              optional
            />
            <Num
              label="Drifts (ft)"
              value={at(d, ["effect", "movement", "drift", "ft"])}
              onChange={(v) =>
                set(
                  ["effect", "movement", "drift"],
                  v === undefined ? undefined : { ft: v, direction: "awayFromCaster" },
                )
              }
              min={0}
              optional
            />
          </>
        ) : null}
      </Row>
      {triggers.map((t, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-[var(--radius-control)] bg-raised/50 p-2"
          data-testid="trigger-row"
        >
          <Row>
            <Sel
              label={`Trigger ${i + 1}`}
              value={String(t.when ?? "enter")}
              options={[
                { value: "enter", label: "Entering it" },
                { value: "startTurn", label: "Starting a turn in it" },
                { value: "endTurn", label: "Ending a turn in it" },
                { value: "per5ft", label: "Each 5 ft moved in it" },
              ]}
              onChange={(v) => set(["effect", "triggers", i, "when"], v)}
            />
            <Sel
              label="Save"
              value={String(at(t, ["save", "ability"]) ?? "none")}
              options={[
                { value: "none", label: "None" },
                ...ABILITIES.map((a) => ({ value: a, label: a.toUpperCase() })),
              ]}
              onChange={(v) =>
                set(
                  ["effect", "triggers", i, "save"],
                  v === "none" ? undefined : { ability: v, onSuccess: "half" },
                )
              }
            />
            <IconButton
              label={`Remove trigger ${i + 1}`}
              onClick={() =>
                set(
                  ["effect", "triggers"],
                  triggers.filter((_, j) => j !== i),
                )
              }
            >
              <Minus size={15} />
            </IconButton>
          </Row>
          <Row>
            <Txt
              label="Damage"
              value={at(t, ["damage", "formula"])}
              placeholder="e.g. 2d10"
              onChange={(v) =>
                set(
                  ["effect", "triggers", i, "damage"],
                  v ? { formula: v, type: String(at(t, ["damage", "type"]) ?? "fire") } : undefined,
                )
              }
              mono
            />
            {t.damage ? (
              <Sel
                label="Type"
                value={String(at(t, ["damage", "type"]) ?? "fire")}
                options={DAMAGE_TYPES.map((x) => ({ value: x, label: cap(x) }))}
                onChange={(v) => set(["effect", "triggers", i, "damage", "type"], v)}
              />
            ) : null}
            <Sel
              label="Condition"
              value={String(t.condition ?? "none")}
              options={[
                { value: "none", label: "None" },
                ...CONDITION_IDS.map((c) => ({ value: c, label: cap(c) })),
              ]}
              onChange={(v) => set(["effect", "triggers", i, "condition"], v === "none" ? undefined : v)}
            />
          </Row>
          <Txt
            label="Note"
            value={t.note}
            onChange={(v) => set(["effect", "triggers", i, "note"], v || undefined)}
            wide
          />
        </div>
      ))}
      <Button
        size="S"
        variant="ghost"
        icon={<Plus size={14} />}
        onClick={() => set(["effect", "triggers"], [...triggers, { when: "enter" }])}
      >
        Add a trigger
      </Button>
    </div>
  );
}

// ── small fields (a dense form: 32-px rows, labels above) ──────────────────────────────────────────────────

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="display mb-1.5 w-full border-b border-line pb-1 text-16 text-bone">{title}</legend>
      {children}
    </fieldset>
  );
}
function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-2.5">{children}</div>;
}
const inputCls =
  "h-9 min-h-[var(--touch-min)] w-full rounded-[var(--radius-control)] border border-line bg-ink-900 px-2.5 text-14 text-bone placeholder:text-faint focus:border-brass focus:outline-none";
function Txt({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
  wide = false,
}: {
  label: string;
  value: unknown;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={`flex flex-col gap-1 ${wide ? "min-w-[12rem] flex-1" : "w-36"}`}>
      <span className="caps text-12 text-fog">{label}</span>
      <input
        id={id}
        value={typeof value === "string" ? value : ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} ${mono ? "mono" : ""}`}
      />
    </label>
  );
}
function Num({
  label,
  value,
  onChange,
  min,
  optional = false,
}: {
  label: string;
  value: unknown;
  onChange: (v: number | undefined) => void;
  min?: number;
  optional?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex w-28 flex-col gap-1">
      <span className="caps text-12 text-fog">{label}</span>
      <input
        id={id}
        inputMode="numeric"
        value={typeof value === "number" ? String(value) : ""}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d.]/g, "");
          if (!raw) onChange(optional ? undefined : (min ?? 0));
          else onChange(Math.max(min ?? 0, Number(raw)));
        }}
        className={`tabular ${inputCls}`}
      />
    </label>
  );
}
function Sel({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-w-[8rem] flex-col gap-1">
      <span className="caps text-12 text-fog">{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-ink-900">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="relative inline-flex h-9 items-center gap-1.5 text-14 text-bone before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--brass-400)]"
      />
      {label}
    </label>
  );
}
function Area({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: unknown;
  onChange: (v: string) => void;
  rows: number;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="caps text-12 text-fog">{label}</span>
      <textarea
        id={id}
        rows={rows}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[var(--radius-control)] border border-line bg-ink-900 px-2.5 py-2 text-14 text-bone focus:border-brass focus:outline-none"
      />
    </label>
  );
}
function Chips({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="caps text-12 text-fog">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const on = value.includes(o);
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
              className={`h-7 min-h-[var(--touch-min)] rounded-[var(--radius-chip)] border px-2 text-12 font-bold ${on ? "border-brass text-brass-bright" : "border-line text-muted"}`}
            >
              {cap(o)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A spell as a homebrew one's starting point (§8.13 "Poison Ball" from Fireball): a fresh id, "(copy)", homebrew. */
export function duplicateOf(s: Spell, homebrew: { spell: Spell }[]): Spell {
  const taken = new Set(homebrew.map((h) => h.spell.id));
  let id = `${s.id}-copy`;
  for (let n = 2; taken.has(id); n++) id = `${s.id}-copy-${n}`;
  return { ...s, id, name: `${s.name} (copy)`, source: { pack: "homebrew" } };
}
