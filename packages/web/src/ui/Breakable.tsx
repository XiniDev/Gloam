import { Fragment } from "react";

/**
 * Text that may break only where a path, URL or command has its joints — after a slash, a backslash or a URL's `?`,
 * `&`, `=` — never mid-word ("D:/Gith|ub", "no|de", critic RSP-01 r1). Pair it with `[overflow-wrap:anywhere]`: a
 * single piece longer than the line still breaks rather than running out of its box.
 */
export function Breakable({ text }: { text: string }) {
  const parts = breakPoints(text);
  return (
    <>
      {parts.map((p, i) => (
        // (The pieces of a fixed string, in order: their places are their keys.)
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Where a path or URL may break: after each slash, `?`, `&` or `=` — but never inside "//", and a scheme or a drive
 * ("https://", "D:/") keeps to what follows it (critic RSP-01 r2: "at D:/" left alone at a line's end).
 */
export function breakPoints(text: string): string[] {
  const parts: string[] = [];
  for (const p of text.split(/(?<=[/?&=])/)) {
    const prev = parts[parts.length - 1];
    if (prev !== undefined && (p === "/" || /^[a-z][a-z0-9+.-]*:\/*$/i.test(prev)))
      parts[parts.length - 1] = prev + p;
    else parts.push(p);
  }
  return parts;
}

/**
 * Prose with URLs in it (the SRD attribution, a source's licence): the words as they are, each URL breakable only at its
 * joints (critic RSP-01 r2: ".../licenses/b|y/4.0" at 360 px). A sentence's full stop after a URL isn't part of it.
 */
export function WithBreakableUrls({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]*[^\s.,;:!?)])/);
  return (
    <>
      {parts.map((p, i) =>
        // (The pieces of a fixed string, in order: their places are their keys.)
        i % 2 === 1 ? <Breakable key={i} text={p} /> : <Fragment key={i}>{p}</Fragment>,
      )}
    </>
  );
}
