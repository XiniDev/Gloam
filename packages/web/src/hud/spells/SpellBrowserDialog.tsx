import type { Spell } from "@gloam/shared/schemas";
import type { ReactNode } from "react";
import { Dialog } from "../../ui/Dialog.tsx";
import { SpellBrowser } from "./SpellBrowser.tsx";

/** The spell browser in a dialog (from a sheet: add a spell to it; from the DM panel: read, cast, duplicate). */
export function SpellBrowserDialog({
  open,
  onClose,
  title = "Spells",
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  actions?: (s: Spell) => ReactNode;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={960}>
      {/* As far from the dialog's foot as from its sides, clear of its corner filigree (critic P9 r2). */}
      <div className="flex h-[min(70dvh,720px)] min-h-0 flex-col pb-4">
        {open ? <SpellBrowser {...(actions ? { actions } : {})} /> : null}
      </div>
    </Dialog>
  );
}
