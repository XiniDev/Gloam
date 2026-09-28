import type { SheetCtx } from "../context.ts";
import { SectionTitle, TextField } from "../primitives.tsx";

/** Notes (§8.10): the character's own page — play-state, so changeable under a core lock. */
export function NotesTab({ ctx }: { ctx: SheetCtx }) {
  return (
    <div className="flex flex-col text-14 text-paper-ink">
      <SectionTitle>Notes</SectionTitle>
      <TextField
        label="Notes"
        value={ctx.sheet.core.notes}
        multiline
        disabled={!ctx.canEdit}
        placeholder="Debts, grudges, the name of the ferryman…"
        onCommit={(v) => void ctx.set(["core", "notes"], v)}
        className="min-h-64"
      />
    </div>
  );
}
