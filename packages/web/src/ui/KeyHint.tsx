/** SPEC §28 KeyHint: small engraved keycaps for a shortcut like "Ctrl+K". */
export function KeyHint({ keys }: { keys: string }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const parts = keys.split("+").map((k) => (k === "Mod" ? (isMac ? "⌘" : "Ctrl") : k));
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((p, i) => (
        <kbd
          key={`${p}-${i}`}
          className="min-w-[18px] rounded-chip border border-ink-600 border-b-2 bg-ink-850 px-1 text-center font-caps text-12 leading-4 tracking-[0.06em] text-fog"
        >
          {p}
        </kbd>
      ))}
    </span>
  );
}

/**
 * A button's shortcut as keycaps after its label (never "(W)" in the text), out of its accessible name — the button
 * carries `aria-keyshortcuts` for that — and gone on touch, where there's no key to press (critic P12 r1 m9).
 */
export function ShortcutHint({ keys }: { keys: string }) {
  return (
    <span aria-hidden className="ml-1.5 inline-flex pointer-coarse:hidden">
      <KeyHint keys={keys} />
    </span>
  );
}
