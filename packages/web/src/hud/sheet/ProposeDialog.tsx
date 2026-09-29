import { useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { sendProposal, usePropose } from "./sheetActions.ts";

const show = (v: unknown) => (v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * "Propose change" (SPEC §8.10 Ownership and locks): an edit to a field the DM has locked goes to the DM instead —
 * what would change, and a note — and lands only if they approve it.
 */
export function ProposeDialog() {
  const pending = usePropose((s) => s.pending);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    usePropose.getState().set({ pending: null });
    setNote("");
  };
  return (
    <Dialog
      open={pending !== null}
      onClose={close}
      variant="parchment"
      title="Propose this change"
      description="The DM has locked this part of the sheet. They'll see what you'd change and can approve it."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Leave it
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (!pending) return;
              setBusy(true);
              const ok = await sendProposal(pending.actor, pending.changes, note.trim());
              setBusy(false);
              if (ok) close();
            }}
          >
            Propose to the DM
          </Button>
        </div>
      }
    >
      {pending?.fields.length ? (
        <ul className="mb-3 flex flex-col gap-1 text-14" data-testid="propose-fields">
          {pending.fields.map((f) => (
            <li key={f.label} className="flex flex-wrap items-baseline gap-2">
              <span className="text-14 text-paper-muted">{f.label}</span>
              <span className="tabular line-through opacity-70">{show(f.before)}</span>
              <span aria-hidden>→</span>
              <span className="tabular font-bold">{show(f.after)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <label className="flex flex-col gap-1 text-14">
        <span className="caps text-12 text-paper-muted">A note for the DM (optional)</span>
        <textarea
          data-autofocus
          value={note}
          maxLength={500}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Level 4 — Ability Score Improvement"
          className="rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-2 py-1.5 text-14 text-paper-ink focus:border-brass-deep focus:shadow-[var(--ring-focus)] focus:outline-none"
        />
      </label>
    </Dialog>
  );
}
