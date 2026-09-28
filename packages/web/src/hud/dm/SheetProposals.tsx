import type { ProposalView } from "@gloam/shared/protocol";
import { useMemo, useState } from "react";
import { decideProposal, useSheets } from "../../net/sheets.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { toast } from "../../ui/Toast.tsx";

/** A sheet value as a line of text: numbers and words as they are, lists and objects briefly. */
function valueText(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "none" : `${v.length} entr${v.length === 1 ? "y" : "ies"}`;
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

function Proposal({ p }: { p: ProposalView }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "deny");
    try {
      await decideProposal(p.id, approve, note.trim());
      toast.success(approve ? `${p.actorName}'s sheet updated` : "Change declined", p.userName);
    } catch (e) {
      toast.danger("Couldn't do that", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li
      className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-line p-3"
      data-proposal={p.id}
      data-testid="proposal"
    >
      <div className="flex items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={() => useUi.getState().set({ dock: "sheet", sheetActor: p.actorId })}
          className="truncate text-14 font-bold text-bone underline-offset-2 hover:underline"
        >
          {p.actorName}
        </button>
        <span className="shrink-0 text-12 text-fog">from {p.userName}</span>
      </div>
      {p.note ? <p className="text-14 italic text-muted">“{p.note}”</p> : null}
      <table className="w-full text-13" aria-label="The changes">
        <tbody>
          {p.changes.map((c) => (
            <tr key={c.path.join("/")} className="border-t border-line/60 align-baseline">
              <th scope="row" className="w-[45%] py-1 pr-2 text-left font-normal text-muted">
                {c.label}
              </th>
              <td className="py-1 text-left">
                <span className="tabular text-fog line-through decoration-fog/60">{valueText(c.before)}</span>
                <span className="px-1.5 text-fog" aria-hidden>
                  →
                </span>
                <span className="tabular font-bold text-bone">{valueText(c.after)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.fits ? null : (
        <p className="text-12 text-danger-text" role="note">
          The sheet has changed since — these changes no longer fit it. Decline, and ask for them again.
        </p>
      )}
      <input
        aria-label={`A note to ${p.userName}`}
        value={note}
        maxLength={500}
        placeholder="A note back (optional)"
        onChange={(e) => setNote(e.target.value)}
        className="h-9 rounded-[var(--radius-control)] border border-line bg-ink-950/60 px-2 text-14 text-bone placeholder:text-fog focus:border-accent focus:outline-none"
      />
      <div className="flex gap-2">
        <Button
          size="S"
          variant="primary"
          loading={busy === "approve"}
          disabled={!p.fits}
          onClick={() => void decide(true)}
        >
          Approve
        </Button>
        <Button size="S" variant="danger" loading={busy === "deny"} onClick={() => void decide(false)}>
          Decline
        </Button>
      </div>
    </li>
  );
}

/** Players' proposed sheet changes waiting for the DM (SPEC §8.10 locks, AC-SHEET-05): what each would change. */
export function SheetProposals() {
  const all = useSheets((s) => s.proposals);
  const pending = useMemo(
    () => [...all.values()].filter((p) => p.status === "pending").sort((a, b) => a.createdAt - b.createdAt),
    [all],
  );
  if (!pending.length) return null;
  return (
    <section aria-label="Sheet changes waiting for approval" className="flex flex-col gap-2">
      <h3 className="caps text-12 text-muted">Sheet changes</h3>
      <ul className="flex flex-col gap-2">
        {pending.map((p) => (
          <Proposal key={p.id} p={p} />
        ))}
      </ul>
    </section>
  );
}
