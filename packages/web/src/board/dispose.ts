/**
 * Deferred material disposal. three.js frees a shader program as soon as no material uses it, so a scene change —
 * old floor, tokens and overlays unmounting just before the new ones mount — would free and then recompile the very
 * same programs (≈ 0.9 s of a first frame under software GL, and a visible hitch on real GPUs too). Releasing
 * outgoing materials a moment later lets the incoming ones pick up the live programs first.
 */
const PROGRAM_GRACE_MS = 5000;

export function disposeLater(...items: ({ dispose(): void } | null | undefined)[]): void {
  const live = items.filter((i): i is { dispose(): void } => Boolean(i));
  if (!live.length) return;
  setTimeout(() => {
    for (const i of live) i.dispose();
  }, PROGRAM_GRACE_MS);
}
