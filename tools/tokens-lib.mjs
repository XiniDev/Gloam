// Design-token rules (SPEC §27, AC-DS-01): UI colours, type sizes, spacing, radii and motion come from the tokens.
// Raw hex/functional colours may appear only in the token file (styles/tokens.css) and in board shader code
// (board/**), which takes its values from packages/shared/src/constants.ts. Everywhere else (the DOM UI):
//  - no raw colours, no inline font-family;
//  - radii: rounded-chip / -control / -panel / -full (or a var(--radius-*)), never rounded-[Npx];
//  - type sizes: the scale (text-12 … text-64), never text-[Npx|rem];
//  - motion: var(--dur-*) durations, never duration-[Nms] or a raw "Nms" in a class;
//  - spacing: arbitrary padding/margin/gap values must sit on the 4-px grid.
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const FUNC_COLOR = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g;
const FONT_FAMILY = /font-family\s*:/g;
const RAW_RADIUS = /\brounded(?:-[trblse]{1,2})?-\[\d+(?:\.\d+)?px\]/g;
const RAW_TEXT = /\btext-\[\d+(?:\.\d+)?(?:px|rem|em)\]/g;
/** The type scale (tokens.css @theme): a `text-<n>` off it generates no CSS at all, silently. */
const TYPE_SCALE = new Set([12, 13, 14, 16, 18, 22, 28, 36, 48, 64]);
const SCALE_TEXT = /(?<![\w-])(?:[a-z0-9-]+:)*text-(\d+)(?![\w-])/g;
const RAW_DURATION = /\b(?:duration|delay)-\[\d+m?s\]/g;
const RAW_SPACING =
  /\b(?:-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y))-\[(\d+(?:\.\d+)?)px\]/g;

/** Problems in one file's text; `rel` is its path under packages/web/src. */
export function scan(text, rel) {
  const problems = [];
  const css = rel.endsWith(".css");
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    for (const m of line.matchAll(HEX)) problems.push(`${at}: raw colour ${m[0]} (use a token)`);
    for (const m of line.matchAll(FUNC_COLOR)) problems.push(`${at}: raw colour ${m[0]}…) (use a token)`);
    if (!css && FONT_FAMILY.test(line)) problems.push(`${at}: inline font-family (use a token)`);
    FONT_FAMILY.lastIndex = 0;
    for (const m of line.matchAll(RAW_RADIUS))
      problems.push(`${at}: raw radius ${m[0]} (use rounded-chip / -control / -panel / -full)`);
    for (const m of line.matchAll(RAW_TEXT))
      problems.push(`${at}: raw type size ${m[0]} (use the text-12 … text-64 scale)`);
    if (!css)
      for (const m of line.matchAll(SCALE_TEXT))
        if (!TYPE_SCALE.has(Number(m[1])))
          problems.push(
            `${at}: text-${m[1]} isn't on the type scale (12 13 14 16 18 22 28 36 48 64) — it does nothing`,
          );
    for (const m of line.matchAll(RAW_DURATION))
      problems.push(`${at}: raw duration ${m[0]} (use var(--dur-*))`);
    for (const m of line.matchAll(RAW_SPACING))
      if (Number(m[1]) % 4 !== 0)
        problems.push(`${at}: off-grid spacing ${m[0]} (spacing is on the 4-px grid)`);
  });
  return problems;
}

/** Files exempt from the rules: the token file itself and the 3D board (shader constants). */
export function exempt(rel) {
  const r = rel.replaceAll("\\", "/");
  return r === "styles/tokens.css" || r.startsWith("board/");
}
