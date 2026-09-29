import type { CastView } from "@gloam/shared/protocol";

/**
 * What a card asks of its reader now (rolls they may make that aren't made): hidden, a card stays hidden until it asks
 * something new — a save routed to them, another attack.
 */
export function asksOf(c: CastView): string[] {
  if (!c.can.roll) return [];
  const out: string[] = [];
  const rows = c.targets.filter((t) => t.state === "in");
  if (c.attack) for (const t of rows) if (t.attack?.total === undefined) out.push(`a:${t.key}`);
  for (const t of rows) if (t.save?.pending) out.push(`s:${t.key}`);
  if (c.damage?.per === "cast" && !c.damage.roll) out.push("d");
  if (c.damage?.per === "target")
    for (const t of rows) if (!t.roll && (!c.attack || t.attack?.hit)) out.push(`d:${t.key}`);
  return out;
}

/** Is a card hidden by its reader (and asking nothing new of them since)? */
export function castHidden(c: CastView, hidden: Map<string, string[]>): boolean {
  const then = hidden.get(c.id);
  return then !== undefined && asksOf(c).every((k) => then.includes(k));
}
