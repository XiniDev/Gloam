import type { ActorView } from "@gloam/shared/protocol";
import { diffSheet, fieldLabel, pathLabel } from "@gloam/shared/rules";
import {
  CHARACTER_AI_PROMPT,
  CHARACTER_SCHEMA_MARKER,
  fillPrompt,
  jsonFromReply,
  Sheet,
} from "@gloam/shared/schemas";
import { Copy, FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { request } from "../../net/table.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { copyText } from "../../ui/clipboard.ts";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";
import { mayEdit } from "./sheetActions.ts";

type Issue = { path: (string | number)[]; message: string };
type Checked = { ok: true; sheet: Sheet } | { ok: false; issues: Issue[] } | null;

const short = (v: unknown) => {
  const s = v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

/**
 * Import (SPEC §8.10 Import / export, AC-SHEET-06/07): a sheet as JSON — pasted or from a file — checked against the
 * published schema, shown as a preview (and, over an existing character, a diff) before anything changes; refused
 * with readable paths when it isn't one. "Import with AI…" explains the no-account workflow and copies Appendix F.3's
 * prompt with the schema served by this table in it; the assistant's reply is pasted back here.
 */
export function ImportDialog({
  mode,
  actor,
  onClose,
}: {
  mode: "json" | "ai" | null;
  actor: ActorView | null;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<Checked>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const close = () => {
    setText("");
    setChecked(null);
    onClose();
  };
  const check = (raw: string) => {
    setText(raw);
    if (!raw.trim()) return setChecked(null);
    const json = mode === "ai" ? jsonFromReply(raw) : raw;
    let doc: unknown;
    try {
      doc = JSON.parse(json ?? "");
    } catch {
      return setChecked({
        ok: false,
        issues: [{ path: [], message: "That isn't JSON — paste the whole object." }],
      });
    }
    const r = Sheet.safeParse(doc);
    if (r.success) setChecked({ ok: true, sheet: r.data });
    else
      setChecked({
        ok: false,
        issues: r.error.issues
          .slice(0, 20)
          .map((i) => ({ path: i.path as (string | number)[], message: i.message })),
      });
  };
  const copyPrompt = async () => {
    try {
      const res = await fetch("/api/v1/schemas/character.json");
      const schema = await res.text();
      const ok = await copyText(
        fillPrompt(CHARACTER_AI_PROMPT, CHARACTER_SCHEMA_MARKER, JSON.stringify(JSON.parse(schema), null, 2)),
      );
      if (ok)
        toast.success("Prompt copied", "Paste it into your assistant with a photo or PDF of the sheet.");
      else toast.warning("Couldn't copy", "Your browser blocked the clipboard.");
    } catch (e) {
      toast.danger("Couldn't fetch the schema", (e as Error).message);
    }
  };
  const target = actor && mayEdit(actor) ? actor : null;
  const diff = checked?.ok && target ? diffSheet(target.sheet, checked.sheet) : [];
  const apply = async (asNew: boolean) => {
    if (!checked?.ok) return;
    setBusy(true);
    try {
      if (asNew) {
        const { actorId } = await request<{ actorId: string }>("actor.create", { sheet: checked.sheet });
        useUi.getState().set({ sheetActor: actorId });
        toast.success(`${checked.sheet.core.name} imported`);
      } else if (target) {
        await request("actor.replace", { actorId: target.id, sheet: checked.sheet });
        toast.success(`${target.sheet.core.name}'s sheet replaced`);
      }
      close();
    } catch (e) {
      toast.danger("Couldn't import it", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={mode !== null}
      onClose={close}
      title={mode === "ai" ? "Import with AI" : "Import a sheet"}
      description={
        mode === "ai"
          ? "No account needed: copy the prompt, paste it into Claude with a photo or PDF of any character sheet, and paste the JSON it answers with below."
          : "Paste a Gloam character JSON, or choose a file. Nothing changes until you confirm."
      }
      width={600}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {target && checked?.ok ? (
            <Button variant="secondary" loading={busy} onClick={() => void apply(false)}>
              Replace {target.sheet.core.name}'s sheet
            </Button>
          ) : null}
          <Button variant="primary" loading={busy} disabled={!checked?.ok} onClick={() => void apply(true)}>
            Create a new character
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3" data-testid="import-dialog">
        {mode === "ai" ? (
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-14 text-muted">
            <li>
              <Button
                variant="secondary"
                size="S"
                icon={<Copy size={15} />}
                onClick={() => void copyPrompt()}
              >
                Copy AI prompt
              </Button>
            </li>
            <li>Paste it into your assistant, with a photo, PDF or text of the sheet.</li>
            <li>Paste its reply here.</li>
          </ol>
        ) : (
          <div>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) check(await f.text());
                e.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              size="S"
              icon={<FileUp size={15} />}
              onClick={() => file.current?.click()}
            >
              Choose a file…
            </Button>
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="caps text-12 text-fog">{mode === "ai" ? "The assistant's reply" : "JSON"}</span>
          <textarea
            data-testid="import-text"
            value={text}
            onChange={(e) => check(e.target.value)}
            rows={7}
            spellCheck={false}
            className="mono rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 py-2 text-13 text-bone focus:border-brass focus:outline-none"
            placeholder='{ "core": { "name": "…" } }'
          />
        </label>
        {checked && !checked.ok ? (
          <div
            role="alert"
            data-testid="import-errors"
            className="rounded-[var(--radius-control)] border border-[var(--danger-text)]/50 p-2"
          >
            <p className="text-13 font-bold text-danger-text">That isn't a sheet Gloam can read:</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-13 text-muted">
              {checked.issues.map((i) => (
                <li key={`${i.path.join(".")}:${i.message}`}>
                  {i.path.length ? (
                    <>
                      <span className="text-bone">{fieldLabel(i.path)}</span>{" "}
                      <span className="mono text-12 text-fog">({pathLabel(i.path)})</span>
                    </>
                  ) : (
                    <span className="text-bone">The text</span>
                  )}{" "}
                  — {i.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {checked?.ok ? (
          <div className="parchment p-3 text-14" data-testid="import-preview">
            <p className="display text-18">{checked.sheet.core.name}</p>
            <p className="text-13 text-paper-muted">
              {[
                checked.sheet.core.species,
                checked.sheet.core.classes.map((c) => `${c.name} ${c.level}`).join(" / "),
                `HP ${checked.sheet.core.hp.max}`,
                `AC ${checked.sheet.core.ac.value}`,
                `${checked.sheet.custom.length} custom block${checked.sheet.custom.length === 1 ? "" : "s"}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {checked.sheet.importNotes?.length ? (
              <div className="mt-2">
                <p className="caps text-12 text-paper-muted">The assistant wasn't sure about</p>
                <ul className="list-disc pl-5 text-13">
                  {checked.sheet.importNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {target ? (
              <div className="mt-2" data-testid="import-diff">
                <p className="caps text-12 text-paper-muted">
                  Against {target.sheet.core.name}'s sheet:{" "}
                  {diff.length ? `${diff.length} change${diff.length === 1 ? "" : "s"}` : "no changes"}
                </p>
                <ul className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto text-13">
                  {diff.slice(0, 80).map((c) => (
                    <li key={pathLabel(c.path)} className="flex flex-wrap gap-1.5" title={pathLabel(c.path)}>
                      <span className="text-paper-muted">{fieldLabel(c.path, checked.sheet)}</span>
                      <span className="line-through opacity-70">{short(c.before)}</span>
                      <span aria-hidden>→</span>
                      <span className="font-bold">{short(c.after)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
