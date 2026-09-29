import type { TokenView } from "@gloam/shared/state";
import { boardData, useEntities } from "../../state/entities.ts";

/** A character's token on the scene now (a spell or an attack from its sheet is aimed from it), or null. */
export function casterTokenOf(actorId: string): TokenView | null {
  for (const t of boardData(useEntities.getState()).tokens.values()) if (t.actorId === actorId) return t;
  return null;
}

/** The same, kept up to date for a component. */
export function useCasterToken(actorId: string): TokenView | null {
  return useEntities((s) => {
    for (const t of boardData(s).tokens.values()) if (t.actorId === actorId) return t;
    return null;
  });
}
