import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * A key-screens folder made ready for a run: created, and emptied of the last run's captures — a step that fails now
 * must not leave the last run's good picture standing in for it, nor a `_failed-` capture from a run since fixed
 * (critic P9 r1 #30). Where two tests share a folder, `keep` spares the other's captures.
 */
export function freshShotsDir(dir: string, keep: (file: string) => boolean = () => false): void {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith(".png") && !keep(f)) unlinkSync(join(dir, f));
}
