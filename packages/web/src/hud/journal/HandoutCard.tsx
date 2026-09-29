import type { HandoutView } from "@gloam/shared/protocol";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Filigree, WaxSeal } from "../../ui/ornaments.tsx";
import { useAssetImage } from "../useAssetImage.ts";

/**
 * A handout as it's read (SPEC §8.18, §27.2): parchment with a deckled top edge, its title in the display face, its
 * picture and its Markdown text (rendered without raw HTML). A secret note is sealed "for you". Shown large (a reveal),
 * it carries its eyebrow — who it's from — on the paper, and filigree in its corners.
 */
export function HandoutCard({
  h,
  compact = false,
  eyebrow,
}: {
  h: HandoutView;
  compact?: boolean;
  eyebrow?: string;
}) {
  const src = useAssetImage(h.imageAssetId, compact ? 512 : 1024);
  const note = h.kind === "note";
  return (
    <article
      className={`parchment deckle relative flex flex-col gap-3 ${compact ? "p-4" : "px-8 pb-8 pt-10"}`}
      aria-label={note ? "A secret note" : h.title}
      data-testid="handout-card"
    >
      {compact ? null : <Filigree tone="ink" />}
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {eyebrow ? <p className="caps text-12 text-paper-muted">{eyebrow}</p> : null}
          <h3 className={`font-display leading-tight ${compact ? "text-18" : "text-28"}`}>
            {note ? "Only you notice…" : h.title}
          </h3>
        </div>
        {note ? <WaxSeal label="Sealed for you" mark="star" size={compact ? 26 : 36} /> : null}
      </header>
      {src ? (
        <img
          src={src}
          alt=""
          className="max-h-[42vh] w-full rounded-[var(--radius-control)] object-contain shadow-[0_2px_10px_var(--paper-shadow)]"
        />
      ) : null}
      {h.bodyMd ? (
        <div className={`doc-md leading-relaxed ${compact ? "text-14" : "text-16"}`}>
          <Markdown remarkPlugins={[remarkGfm]}>{h.bodyMd}</Markdown>
        </div>
      ) : null}
    </article>
  );
}
