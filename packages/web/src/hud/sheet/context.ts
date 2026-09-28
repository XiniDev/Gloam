import type { ActorView } from "@gloam/shared/protocol";
import { type DerivedSheet, deriveSheet, editableAt } from "@gloam/shared/rules";
import type { DerivedKey, Sheet } from "@gloam/shared/schemas";
import { useMemo } from "react";
import type { SheetChangeIn, SheetPath } from "../../net/sheets.ts";
import { useTable } from "../../net/table.ts";
import { editSheet, isDmRole, mayEdit } from "./sheetActions.ts";

/** What every part of a sheet works from. */
export interface SheetCtx {
  actor: ActorView;
  sheet: Sheet;
  derived: DerivedSheet;
  dm: boolean;
  /** This person edits this sheet (theirs, or a DM); others read it. */
  canEdit: boolean;
  /** An edit to this path goes straight in (not locked for this person); a locked one becomes a proposal. */
  free(path: SheetPath): boolean;
  edit(changes: SheetChangeIn[]): Promise<boolean>;
  set(path: SheetPath, after: unknown): Promise<boolean>;
}

/** Sets a derived value by hand, or (undefined) back to the worked-out one (§8.10 overrides, AC-SHEET-02). */
export function overrideDerived(ctx: SheetCtx, key: DerivedKey, value: number | undefined): void {
  void ctx.set(["core", "overrides", key], value);
}

export function useSheetCtx(actor: ActorView): SheetCtx {
  const role = useTable((s) => s.me?.role);
  const dm = isDmRole(role);
  return useMemo(() => {
    const canEdit = mayEdit(actor);
    const edit = (changes: SheetChangeIn[]) => editSheet(actor, changes);
    return {
      actor,
      sheet: actor.sheet,
      derived: deriveSheet(actor.sheet.core),
      dm,
      canEdit,
      free: (path: SheetPath) => canEdit && editableAt(actor.lockLevel, path, actor.sheet, dm),
      edit,
      set: (path: SheetPath, after: unknown) => edit([{ path, after }]),
    };
  }, [actor, dm]);
}
