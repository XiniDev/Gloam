/**
 * Validation problems in plain words (SPEC §8.10 Import: "readable errors"): what's wrong with a value and what it
 * is, from a zod issue and the document it came from — "must be 30 or less (it's 34)", not "Too big: expected
 * number to be <=30".
 */
interface IssueLike {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  inclusive?: boolean;
  expected?: string;
  keys?: readonly string[];
  values?: readonly unknown[];
  origin?: string;
  format?: string;
}

const valueAt = (doc: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>(
    (o, k) => (o !== null && typeof o === "object" ? (o as Record<PropertyKey, unknown>)[k] : undefined),
    doc,
  );

const show = (v: unknown): string => {
  if (typeof v === "string") return `"${v.length > 30 ? `${v.slice(0, 29)}…` : v}"`;
  if (v === undefined) return "missing";
  const s = JSON.stringify(v);
  return s.length > 30 ? `${s.slice(0, 29)}…` : s;
};

export function issueText(issue: IssueLike, doc: unknown): string {
  const v = valueAt(doc, issue.path);
  const its = v === undefined ? "" : ` (it's ${show(v)})`;
  switch (issue.code) {
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") return `is too long: ${max} characters at most${its}`;
      if (issue.origin === "array") return `has too many entries: ${max} at most`;
      return `must be ${issue.inclusive === false ? `less than ${max}` : `${max} or less`}${its}`;
    }
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.origin === "string") return min <= 1 ? "can't be empty" : `needs ${min} characters at least`;
      if (issue.origin === "array") return `needs ${min} entries at least`;
      return `must be ${issue.inclusive === false ? `more than ${min}` : `${min} or more`}${its}`;
    }
    case "invalid_type":
      return v === undefined ? "is missing" : `should be ${article(issue.expected ?? "value")}${its}`;
    case "invalid_value":
      return `isn't one Gloam knows${its}${issue.values?.length && issue.values.length <= 8 ? ` — one of ${issue.values.map(show).join(", ")}` : ""}`;
    case "unrecognized_keys":
      return `has ${issue.keys?.length === 1 ? "a field" : "fields"} Gloam doesn't know: ${(issue.keys ?? []).join(", ")}`;
    case "invalid_format":
      return `isn't a valid ${issue.format ?? "value"}${its}`;
    case "not_multiple_of":
      return `must be a whole number${its}`;
    case "invalid_union":
      return `isn't any of the shapes allowed here${its}`;
    default:
      return issue.message;
  }
}

function article(t: string): string {
  const word = t === "int" ? "whole number" : t;
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}
