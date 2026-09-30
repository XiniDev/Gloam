import { Fragment } from "react";

/**
 * Text that may break only where a path, URL or command has its joints — after a slash, a backslash or a URL's `?`,
 * `&`, `=` — never mid-word ("D:/Gith|ub", "no|de", critic RSP-01 r1). Pair it with `[overflow-wrap:anywhere]`: a
 * single piece longer than the line still breaks rather than running out of its box.
 */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[/?&=])/);
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
