import type { HandoutView } from "@gloam/shared/protocol";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { WaxSeal } from "../../ui/ornaments.tsx";
import { useAssetImage } from "../useAssetImage.ts";

/**
 * A handout as it's read (SPEC §8.18, §27.2): parchment with a deckled top edge, its title in the display face, its
 * picture and its Markdown text (rendered without raw HTML). A secret note is sealed "for you".
 */
export function HandoutCard({ h, compact = false }: { h: HandoutView; compact?: boolean }) {
  const src = useAssetImage(h.imageAssetId, compact ? 512 : 1024);
  const note = h.kind === "note";
  return (
    <article
      className={`parchment deckle relative flex flex-col gap-3 ${compact ? "p-4" : "px-7 pb-7 pt-8"}`}
      aria-label={note ? "A secret note" : h.title}
      data-testid="handout-card"
    >
      <header className="flex items-start gap-3">
        <h3 className={`min-w-0 flex-1 font-display leading-tight ${compact ? "text-18" : "text-24"}`}>
          {note ? "Only you notice…" : h.title}
        </h3>
        {note ? <WaxSeal label="You" size={compact ? 26 : 34} /> : null}
      </header>
      {src ? (
        <img
          src={src}
          alt=""
          className="max-h-[42vh] w-full rounded-[var(--radius-control)] object-contain shadow-[0_2px_10px_var(--paper-shadow)]"
        />
      ) : null}
      {h.bodyMd ? (
        <div className="doc-md text-15 leading-relaxed">
          <Markdown remarkPlugins={[remarkGfm]}>{h.bodyMd}</Markdown>
        </div>
      ) : null}
    </article>
  );
}
