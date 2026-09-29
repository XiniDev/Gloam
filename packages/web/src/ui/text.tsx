import type { ReactNode } from "react";

/**
 * Text whose hyphenated words never break at their hyphen ("Fire-scarred Ogre" wrapping as "Fire-" / "scarred";
 * critic P7 r2 #17): each such word kept on one line. (Not U+2011: the faces don't all carry it, and a fallback
 * face's hyphen reads as a different character.) Anything but a string passes through untouched.
 */
export function keepHyphenated(text: ReactNode): ReactNode {
  if (typeof text !== "string" || !text.includes("-")) return text;
  return text.split(/(\S*\w-\w\S*)/).map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string, in order
      <span key={i} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
