import { create } from "zustand";

/**
 * The creatures this client holds only because they're shown to it outright (revealTo, §15.4 rule 1) — nothing of its
 * own perceives them. The server says which (`vision.shown`); the board draws each standing in the dark: its body
 * greyed by the fog composite, its ring, plate and bar dimmed (critic P12 r1 M3).
 */
export const useShownOnly = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));

export function onShownOnly(m: { tokenIds: string[] }): void {
  useShownOnly.setState({ ids: new Set(m.tokenIds) });
}
