import { DEFAULT_HOUSE_RULES, type HouseRules } from "@gloam/shared/schemas";
import { request, useTable } from "../../net/table.ts";
import { Select, Slider, Toggle } from "../../ui/controls.tsx";
import { act } from "./tokenDm.tsx";

type Choice<K extends keyof HouseRules> = { value: HouseRules[K] & string; label: string }[];

/** One rule: its name, what it decides, its choices (the default marked). */
function Rule<K extends keyof HouseRules>({
  k,
  label,
  what,
  options,
}: {
  k: K;
  label: string;
  what: string;
  options: Choice<K>;
}) {
  const rules = useTable((s) => s.houseRules);
  const def = DEFAULT_HOUSE_RULES[k];
  return (
    <div className="flex flex-col gap-1" data-rule={k}>
      <Select
        label={label}
        value={rules[k] as string}
        onChange={(v) => setRule(k, v as HouseRules[K])}
        options={options.map((o) => ({
          value: o.value,
          label: o.value === def ? `${o.label} (default)` : o.label,
        }))}
      />
      <p className="text-12 text-muted">{what}</p>
    </div>
  );
}

function setRule<K extends keyof HouseRules>(k: K, v: HouseRules[K]): void {
  act(request("campaign.update", { houseRules: { [k]: v } }), "Couldn't change the rule");
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4" aria-label={title}>
      <h3 className="caps border-b border-line pb-1 text-12 text-brass">{title}</h3>
      {children}
    </section>
  );
}

/**
 * DM panel → House rules (SPEC §19.6): the campaign's rule choices, defaults first — each takes effect at once (and is
 * undoable, like any change), for everyone at the table.
 */
export function HouseRulesPanel() {
  const rules = useTable((s) => s.houseRules);
  const pack = useTable((s) => s.rulesPack);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4" data-testid="house-rules">
      <Group title="Rules">
        <div className="flex flex-col gap-1">
          <span className="caps text-12 text-fog">Rules pack</span>
          <span className="text-14 text-bone">{pack === "srd-5.1" ? "SRD 5.1" : "SRD 5.2.1"}</span>
          <p className="text-12 text-muted">
            The rules this campaign plays by (set when the campaign is made).
          </p>
        </div>
        <Rule
          k="automation"
          label="Automation"
          what="How much Gloam does for you: Assist suggests and you confirm; Auto applies; Manual only rolls."
          options={[
            { value: "assist", label: "Assist" },
            { value: "manual", label: "Manual" },
            { value: "auto", label: "Auto" },
          ]}
        />
      </Group>
      <Group title="Movement">
        <Rule
          k="overlongMoves"
          label="Overlong moves"
          what="A move longer than what's left: stopped at its reach, or refused."
          options={[
            { value: "clamp", label: "Clamp to max reach" },
            { value: "reject", label: "Reject" },
          ]}
        />
        <Rule
          k="moveReset"
          label="Move reset"
          what="Whether a creature may take back its moves during its own turn."
          options={[
            { value: "always", label: "Always during its own turn" },
            { value: "untilAction", label: "Until it uses an action" },
            { value: "never", label: "Never" },
          ]}
        />
        <Rule
          k="creatureSpaces"
          label="Enforce creature spaces"
          what="Whether a move may end in another creature's space."
          options={[
            { value: "combat", label: "In combat" },
            { value: "always", label: "Always" },
            { value: "never", label: "Never" },
          ]}
        />
        <Rule
          k="explorationMovement"
          label="Exploration movement"
          what="Outside combat: move anywhere in one go, or at most the creature's Speed per move."
          options={[
            { value: "free", label: "Free" },
            { value: "limited", label: "Limited to speed per move" },
          ]}
        />
        <div className="flex flex-col gap-1" data-rule="squeeze">
          <Slider
            label={`Squeeze factor · ${rules.squeeze.toFixed(2)}`}
            min={0.3}
            max={0.5}
            step={0.05}
            value={rules.squeeze}
            format={(v) => v.toFixed(2)}
            onChange={(v) => setRule("squeeze", Math.round(v * 100) / 100)}
          />
          <p className="text-12 text-muted">
            How narrow a gap a creature squeezes through, as a share of its space (0.4 by default).
          </p>
        </div>
      </Group>
      <Group title="Spells and damage">
        <Rule
          k="areaCoverage"
          label="Area coverage"
          what="Which squares an area covers: any it touches, or those whose centre is inside."
          options={[
            { value: "touches", label: "Touches" },
            { value: "centre", label: "Centre inside" },
          ]}
        />
        <Rule
          k="criticalDamage"
          label="Critical damage"
          what="A critical hit's damage dice: rolled twice, or the maximum plus a roll."
          options={[
            { value: "doubleDice", label: "Double dice" },
            { value: "maxPlusRoll", label: "Max dice + roll" },
          ]}
        />
        <Rule
          k="playerDamage"
          label="Player-applied damage"
          what="Damage a player applies: checked by you first, or at once."
          options={[
            { value: "viaDm", label: "Via DM confirmation" },
            { value: "direct", label: "Direct" },
          ]}
        />
      </Group>
      <Group title="Combat">
        <Rule
          k="defaultInitiative"
          label="Default initiative"
          what="What Quick start does to find initiative."
          options={[
            { value: "playersRoll", label: "Players roll, DM rolls NPCs" },
            { value: "rollAll", label: "Roll for everyone" },
            { value: "fixed", label: "Fixed initiative" },
            { value: "skip", label: "Skip rolls" },
          ]}
        />
        <Rule
          k="initiativeTies"
          label="Initiative ties"
          what="Who goes first on a tie."
          options={[
            { value: "dexThenPcs", label: "Dex mod, then PCs first" },
            { value: "dmDecides", label: "DM decides each time" },
          ]}
        />
        <Rule
          k="hiddenCombatants"
          label="Hidden combatants"
          what="What players' trackers show of creatures they don't perceive."
          options={[
            { value: "hidden", label: "Hidden" },
            { value: "unknown", label: 'Shown as "Unknown"' },
          ]}
        />
        <Rule
          k="npcAtZero"
          label="NPC at 0 HP"
          what="What an NPC at 0 HP becomes (the choice made for you under Auto)."
          options={[
            { value: "dead", label: "Dead" },
            { value: "unconscious", label: "Unconscious" },
            { value: "keep", label: "Keep at 0" },
          ]}
        />
      </Group>
      <Group title="Health, sight and sheets">
        <Rule
          k="deathSavesVisibleTo"
          label="Death saves seen by"
          what="Who sees a dying character's death saving throws."
          options={[
            { value: "everyone", label: "Everyone" },
            { value: "ownerAndDm", label: "Its player and the DM" },
          ]}
        />
        <Toggle
          checked={rules.bloodied}
          onChange={(v) => setRule("bloodied", v)}
          label="Bloodied marker"
          description="A mark on a creature at half its HP or less."
        />
        <Toggle
          checked={rules.partyVision}
          onChange={(v) => setRule("partyVision", v)}
          label="Party vision"
          description="Every player sees what any party member sees."
        />
        <Rule
          k="sheetLockDefault"
          label="Sheet lock for new characters"
          what="What a player may change on their own sheet, unless you set it per character."
          options={[
            { value: "unlocked", label: "Unlocked" },
            { value: "core", label: "Core locked" },
            { value: "full", label: "Fully locked" },
          ]}
        />
        <Rule
          k="npcHpDisplay"
          label="NPC HP display"
          what="How players see a new NPC's HP (each token can differ)."
          options={[
            { value: "bar", label: "Bar" },
            { value: "exact", label: "Exact" },
            { value: "descriptor", label: "Descriptor" },
            { value: "hidden", label: "Hidden" },
          ]}
        />
      </Group>
    </div>
  );
}
