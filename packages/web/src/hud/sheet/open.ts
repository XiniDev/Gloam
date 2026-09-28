import { useSheets } from "../../net/sheets.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";

/** The character sheet behind a token, if this person may read it. */
export function sheetOfToken(tokenId: string): string | null {
  const actorId = boardData(useEntities.getState()).tokens.get(tokenId)?.actorId;
  return actorId && useSheets.getState().actors.has(actorId) ? actorId : null;
}

/** Opens a token's sheet in the dock (SPEC §8.5: double-click, or the radial menu's Sheet). False when there's none. */
export function openSheetFor(tokenId: string): boolean {
  const actorId = sheetOfToken(tokenId);
  if (!actorId) return false;
  useUi.getState().set({ dock: "sheet", sheetActor: actorId });
  return true;
}
