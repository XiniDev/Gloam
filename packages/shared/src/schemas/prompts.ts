/**
 * The AI conversion prompts (SPEC Appendix F): the no-account workflow — copy the prompt, paste it into an assistant
 * with a photo, PDF or text of the source, paste the JSON reply back. Each carries a `{{…_SCHEMA_JSON}}` marker that
 * **Copy AI prompt** replaces with the pretty-printed schema served at `/api/v1/schemas/<kind>.json` (F.1), so the text
 * on the clipboard is complete and never contains a marker.
 */

export const CHARACTER_SCHEMA_MARKER = "{{CHARACTER_SCHEMA_JSON}}";

/** Appendix F.3's prompt, word for word. */
export const CHARACTER_AI_PROMPT = `You are converting a tabletop RPG character sheet into JSON for the Gloam virtual tabletop.
Output ONLY one JSON object that validates against the JSON Schema below — no prose, no fences.

Rules:
1. Use only information present in the sheet I provide (text, photo or PDF). Never invent
   values. If something is unknown, omit it.
2. Put standard fifth-edition fields in "core". Put everything that doesn't fit — homebrew
   stats, custom resources, unusual sections — in "custom" blocks, choosing the closest type:
   text, number, counter (value/max), checklist, table, keyValue.
3. Distances in feet (1.5 m = 5 ft). Ability scores are the scores, not modifiers.
4. Attack and damage formulas use dice notation; you may use @str @dex @con @int @wis @cha
   @prof references. Tag damage types in brackets, e.g. "1d8 + @str [slashing]".
5. Keep names of spells, features and items exactly as written.
6. List anything you were unsure about in "importNotes".

JSON Schema:
${CHARACTER_SCHEMA_MARKER}

The sheet:
`;

/** A prompt with its schema in place of the marker (pretty-printed). */
export function fillPrompt(template: string, marker: string, schema: unknown): string {
  const json = typeof schema === "string" ? schema : JSON.stringify(schema, null, 2);
  return template.split(marker).join(json);
}

/**
 * A reply as an assistant tends to send it: the JSON object, perhaps inside a code fence or with a line before it.
 * The first `{` to the last `}`; null when there's no object.
 */
export function jsonFromReply(text: string): string | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  return a >= 0 && b > a ? text.slice(a, b + 1) : null;
}
