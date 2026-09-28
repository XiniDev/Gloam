import { useTable } from "../net/table.ts";
import { useSettings } from "../state/settings.ts";

/** The units this viewer reads distances in: their own setting, or the campaign's (SPEC §8.6, AC-MOV-12). */
export function useUnits(): "ft" | "m" {
  const campaign = useTable((s) => s.units);
  const pref = useSettings((s) => s.units);
  return pref === "campaign" ? campaign : pref;
}
