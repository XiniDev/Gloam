import type { AnchorHTMLAttributes } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown written at the table — a DM's handout, a homebrew spell a player proposed — as a document shows it (SPEC
 * §22.6): its links open in a new tab and tell the page nothing of this one (noopener noreferrer), and aren't followed
 * as endorsements (nofollow). A plain link let a player's spell text take the DM's tab to a page of its choosing
 * (security review L2). (react-markdown drops javascript: and data: links itself.)
 */
export function DocMarkdown({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{ a: DocLink }}>
      {children}
    </Markdown>
  );
}

function DocLink({ node: _node, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noopener noreferrer nofollow" />;
}
