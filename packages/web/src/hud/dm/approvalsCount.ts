import { pendingProposals, useSheets } from "../../net/sheets.ts";
import { useSpells } from "../../net/spells.ts";
import { useTable } from "../../net/table.ts";
import { pendingCount, useLibrary } from "../../state/library.ts";

/**
 * Everything waiting for the DM's decision (AC-DMP-04), live: knocks at the door, uploads, proposed sheet changes and
 * proposed homebrew spells. The rail's and the dock's badge.
 */
export function useApprovalsCount(): number {
  const knocks = useTable((s) => s.knocks.length);
  const uploads = useLibrary(pendingCount);
  const sheets = useSheets(pendingProposals);
  const homebrew = useSpells((s) => s.homebrew.filter((h) => h.status === "proposed").length);
  return knocks + uploads + sheets + homebrew;
}
