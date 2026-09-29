/**
 * A creature's or person's initials — one rule for its coin on the board, its portraits in the HUD and its seal in
 * lists (critic P8 r2 I1: the tracker's "G" beside the board's "GO" was two names for one creature): the first letters
 * of its first and last words ("Mira Vell" MV, "Goblin 2" G2), or a one-word name's first two letters ("Goblin" GO).
 */
export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}` : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

/**
 * The initials for a small portrait (under 28 px, critic P8 r2 B5): one letter — unless its second is the number that
 * tells a creature from its namesakes ("Goblin 2": G2), which stays.
 */
export function shortInitialsOf(name: string): string {
  const full = initialsOf(name);
  return /\d/.test(full.slice(1)) ? full : full.slice(0, 1);
}
