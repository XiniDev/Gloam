import { ClipboardCopy, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { post } from "../../net/http.ts";
import { Button } from "../../ui/Button.tsx";
import { copyText } from "../../ui/clipboard.ts";
import { Segmented } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";

/** What the server says an import did, or would do (engine/commands/content.ts ImportReport). */
interface ImportReport {
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: { index: number; name: string | null; errors: string[] }[];
  conflicts: { index: number; id: string; name: string; with: "srd" | "homebrew" }[];
  imported: string[];
  overwritten: string[];
  renamed: { from: string; to: string }[];
  skipped: string[];
}

/** The AI prompt of Appendix F.2, the schema marker filled in (the clipboard never carries a marker). */
const PROMPT = `Convert the spells I give you into a JSON array for the Gloam virtual tabletop.
Output ONLY the JSON array — no prose, no code fences.

Rules:
1. One object per spell, validating against the JSON Schema below. Unknown fields are not allowed.
2. "id" is the kebab-case of the name. Cantrips have level 0.
3. Use only information present in my text. Never invent numbers. Omit optional fields you
   can't determine.
4. Areas: sphere (radius), cylinder (radius, height), cone (length), cube (size), line
   (length, width; default width 5), emanation (distance), wall (length, height,
   thickness, optional ring diameter, opaque, blocksMove, damagingSide). All distances in
   feet (convert metres: 1.5 m = 5 ft).
5. Damage: dice notation like "8d6", type from: acid, bludgeoning, cold, fire, force,
   lightning, necrotic, piercing, poison, psychic, radiant, slashing, thunder. Upcasting →
   scaling {"mode":"slot","perLevel":"1d6"}; cantrip scaling → {"mode":"cantrip","atLevels":{…}}.
6. Saves: ability str|dex|con|int|wis|cha; onSuccess half|none|special.
7. Choose "vfx" from: fire, cold, lightning, thunder, acid, poison, necrotic, radiant,
   force, psychic, healing, arcane.
8. Set "source": {"pack":"homebrew"}.

JSON Schema:
{{SPELL_SCHEMA_JSON}}

My spells:
`;

/**
 * Import spells (SPEC §8.13 Import, Appendix F; AC-SPL-11): paste or upload JSON (a list of spells in the published
 * schema, or one spell), a dry run first — what's valid, what isn't and why, what clashes with the SRD's or the
 * campaign's own — then the import, each clash skipped, overwritten (another homebrew spell only) or renamed. "Copy AI
 * prompt" puts Appendix F.2's prompt, with the schema written into it, on the clipboard.
 */
export function ImportSpellsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [strategy, setStrategy] = useState<"skip" | "overwrite" | "rename">("skip");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setReport(null);
    setParseError(null);
  }, [open]);
  const spells = (): unknown[] | null => {
    try {
      const v = JSON.parse(text) as unknown;
      setParseError(null);
      return Array.isArray(v) ? v : [v];
    } catch (e) {
      setParseError(`That isn't JSON: ${(e as Error).message}`);
      return null;
    }
  };
  const run = async (dryRun: boolean) => {
    const list = spells();
    if (!list) return;
    setBusy(true);
    try {
      const r = await post<ImportReport>("/api/v1/content/spells:import", { spells: list, dryRun, strategy });
      setReport(r);
      if (!dryRun) {
        const n = r.imported.length + r.overwritten.length;
        toast.success(
          `Imported ${n} spell${n === 1 ? "" : "s"}`,
          r.skipped.length ? `${r.skipped.length} skipped` : undefined,
        );
        if (!r.invalid.length) onClose();
      }
    } catch (e) {
      toast.danger("Couldn't import", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copyPrompt = async () => {
    try {
      // The published schema, as served (a plain JSON document, not the API's { data } envelope).
      const res = await fetch("/api/v1/schemas/spell.json", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`The schema didn't load (${res.status}).`);
      const schema = (await res.json()) as unknown;
      await copyText(PROMPT.replace("{{SPELL_SCHEMA_JSON}}", JSON.stringify(schema, null, 2)));
      toast.success(
        "AI prompt copied",
        "Paste it with your spells into an AI chat, then paste its answer here.",
      );
    } catch (e) {
      toast.danger("Couldn't copy the prompt", (e as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import spells"
      description="Paste or upload JSON in the published spell schema. A dry run shows what would happen first."
      width={760}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            icon={<ClipboardCopy size={15} />}
            onClick={() => void copyPrompt()}
            className="mr-auto"
          >
            Copy AI prompt
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" loading={busy} disabled={!text.trim()} onClick={() => void run(true)}>
            Dry run
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!report || report.valid === 0}
            onClick={() => void run(false)}
          >
            Import
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3" data-testid="import-spells">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex min-h-[var(--touch-min)] cursor-pointer items-center gap-1.5 rounded-[var(--radius-control)] border border-line px-3 text-13 font-bold text-bone hover:border-line-strong">
            <Upload size={14} aria-hidden />
            Upload a .json file
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 4 * 1024 * 1024) {
                  toast.warning("That file is too large", "An import is at most 4 MB.");
                  return;
                }
                setText(await f.text());
                setReport(null);
              }}
            />
          </label>
          <span className="text-12 text-muted">or paste below</span>
        </div>
        <textarea
          aria-label="Spells as JSON"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setReport(null);
          }}
          rows={10}
          placeholder='[{ "id": "poison-ball", "name": "Poison Ball", "level": 3, … }]'
          className="mono w-full rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 py-2 text-12 text-bone placeholder:text-faint focus:border-brass focus:outline-none"
        />
        {parseError ? <p className="text-13 text-[var(--ember-400)]">{parseError}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <span className="caps text-12 text-fog">Clashes</span>
          <Segmented
            label="When a spell's id is taken"
            size="S"
            value={strategy}
            onChange={(v) => {
              setStrategy(v);
              setReport(null);
            }}
            options={[
              { value: "skip", label: "Skip" },
              { value: "overwrite", label: "Overwrite" },
              { value: "rename", label: "Rename" },
            ]}
          />
          <span className="text-12 text-muted">
            SRD spells are never overwritten: a clash with one is renamed.
          </span>
        </div>
        {report ? <Report r={report} /> : null}
      </div>
    </Dialog>
  );
}

function Report({ r }: { r: ImportReport }) {
  return (
    <section
      className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line p-3 text-13"
      data-testid="import-report"
    >
      <p className="text-bone">
        {r.dryRun ? "A dry run: nothing changed. " : ""}
        <span className="font-bold">{r.valid}</span> of {r.total} valid ·{" "}
        {r.dryRun ? "would import" : "imported"} <span className="font-bold">{r.imported.length}</span>
        {r.overwritten.length ? ` · overwrite ${r.overwritten.length}` : ""}
        {r.renamed.length ? ` · rename ${r.renamed.length}` : ""}
        {r.skipped.length ? ` · skip ${r.skipped.length}` : ""}
      </p>
      {r.conflicts.length ? (
        <div>
          <h4 className="caps text-12 text-fog">Clashes</h4>
          <ul className="list-inside list-disc text-muted">
            {r.conflicts.map((c) => (
              <li key={`${c.index}-${c.id}`}>
                {c.name} (“{c.id}”) — {c.with === "srd" ? "an SRD spell" : "a homebrew spell"}
                {r.renamed.find((x) => x.from === c.id)
                  ? ` → “${r.renamed.find((x) => x.from === c.id)?.to}”`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.invalid.length ? (
        <div>
          <h4 className="caps text-12 text-[var(--ember-400)]">Invalid ({r.invalid.length})</h4>
          <ul className="flex flex-col gap-1">
            {r.invalid.map((x) => (
              <li key={x.index} className="text-muted">
                <span className="text-bone">
                  #{x.index + 1}
                  {x.name ? ` ${x.name}` : ""}
                </span>
                : {x.errors.join("; ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
