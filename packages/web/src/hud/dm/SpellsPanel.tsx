import type { Spell } from "@gloam/shared/schemas";
import { BookOpen, FileJson, Plus } from "lucide-react";
import { useState } from "react";
import { decideHomebrew, deleteHomebrew, type HomebrewSpell, useSpells } from "../../net/spells.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { toast } from "../../ui/Toast.tsx";
import { HomebrewBuilder } from "../spells/HomebrewBuilder.tsx";
import { ImportSpellsDialog } from "../spells/ImportSpellsDialog.tsx";
import { SpellBrowserDialog } from "../spells/SpellBrowserDialog.tsx";

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

/**
 * DM panel → Spells (SPEC §8.13 Content, Homebrew builder, Import): the spell browser; the campaign's homebrew — in
 * use, and the players' proposals to approve or reject (AC-SPL-10) — each opened in the builder to change; a new spell
 * from scratch or any spell duplicated as a template ("Poison Ball" from Fireball); and Import spells (paste or upload
 * JSON, a dry run, then skip / overwrite / rename; AC-SPL-11).
 */
export function SpellsPanel() {
  const homebrew = useSpells((s) => s.homebrew);
  const [browsing, setBrowsing] = useState(false);
  const [editing, setEditing] = useState<{ spell: Spell | null; replaces?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const proposed = homebrew.filter((h) => h.status === "proposed");
  const active = homebrew.filter((h) => h.status === "active");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="spells-panel">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<BookOpen size={15} />} onClick={() => setBrowsing(true)}>
          Browse spells
        </Button>
        <Button variant="secondary" icon={<Plus size={15} />} onClick={() => setEditing({ spell: null })}>
          New spell
        </Button>
        <Button variant="ghost" icon={<FileJson size={15} />} onClick={() => setImporting(true)}>
          Import…
        </Button>
      </div>
      {proposed.length ? (
        <section className="flex flex-col gap-1.5" aria-label="Proposed spells">
          <h3 className="caps text-12 text-brass">Proposed by players</h3>
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {proposed.map((h) => (
              <Row key={h.id} h={h} onOpen={() => setEditing({ spell: h.spell, replaces: h.id })}>
                <Button
                  size="S"
                  variant="ghost"
                  onClick={() => act(decideHomebrew(h.id, false), "Couldn't reject it")}
                >
                  Reject
                </Button>
                <Button
                  size="S"
                  variant="primary"
                  onClick={() => act(decideHomebrew(h.id, true), "Couldn't approve it")}
                >
                  Approve
                </Button>
              </Row>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="flex flex-col gap-1.5" aria-label="Homebrew spells">
        <h3 className="caps text-12 text-fog">Homebrew</h3>
        {active.length ? (
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {active.map((h) => (
              <Row key={h.id} h={h} onOpen={() => setEditing({ spell: h.spell, replaces: h.id })}>
                <Button
                  size="S"
                  variant="ghost"
                  onClick={() => act(deleteHomebrew(h.id), "Couldn't remove it")}
                >
                  Remove
                </Button>
              </Row>
            ))}
          </ul>
        ) : (
          <EmptyState
            art="die"
            title="No homebrew spells yet. Make one, duplicate an SRD spell as a template, or import a list."
          />
        )}
      </section>
      <SpellBrowserDialog
        open={browsing}
        onClose={() => setBrowsing(false)}
        actions={(s) => (
          <button
            type="button"
            onClick={() => {
              setBrowsing(false);
              setEditing({ spell: duplicateOf(s, homebrew) });
            }}
            className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-paper-ink/35 px-3 text-13 font-semibold text-paper-ink hover:border-paper-ink/60 hover:bg-parchment-deep"
          >
            Duplicate as homebrew
          </button>
        )}
      />
      <HomebrewBuilder
        open={editing !== null}
        initial={editing?.spell ?? null}
        {...(editing?.replaces ? { replaces: editing.replaces } : {})}
        onClose={() => setEditing(null)}
      />
      <ImportSpellsDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

function Row({ h, onOpen, children }: { h: HomebrewSpell; onOpen: () => void; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 px-3 py-1.5" data-testid="homebrew-row" data-spell={h.spell.id}>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-14 text-bone hover:underline"
      >
        {h.spell.name}
        <span className="ml-1.5 text-12 text-muted">
          {h.spell.level === 0 ? "cantrip" : `level ${h.spell.level}`} · {h.createdByName}
        </span>
      </button>
      {children}
      <IconButton label={`Open ${h.spell.name}`} onClick={onOpen}>
        <BookOpen size={15} />
      </IconButton>
    </li>
  );
}

/** A spell as a homebrew template: a new id and name ("Fireball (copy)"), homebrew source, the rest as it is. */
export function duplicateOf(s: Spell, homebrew: HomebrewSpell[]): Spell {
  const taken = new Set(homebrew.map((h) => h.spell.id));
  let id = `${s.id}-copy`;
  for (let n = 2; taken.has(id); n++) id = `${s.id}-copy-${n}`;
  return { ...s, id, name: `${s.name} (copy)`, source: { pack: "homebrew" } };
}
