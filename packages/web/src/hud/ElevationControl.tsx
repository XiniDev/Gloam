import { ChevronDown, ChevronUp } from "lucide-react";
import { canRaise, heightLabel, showsElevation } from "../board/tokens/elevation.ts";
import { request, useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";
import { toast } from "../ui/Toast.tsx";

/**
 * The elevation stepper (SPEC §8.5 flying; AC-TOK-07): the selected flyer's height with −/+ in 5-ft steps, a pill at
 * the action bar at the bottom centre (§29.3) rather than beside the token or on the right edge, where it covered name
 * plates and the token's own height label. Alt+wheel over the token does the same. Shown with the Select tool (the
 * other tools have their own bottom panels).
 */
export function ElevationControl() {
  const selected = useUi((s) => (s.selection.length === 1 ? s.selection[0] : undefined));
  const tool = useUi((s) => s.tool);
  const token = useBoard((d) => (selected ? d.tokens.get(selected) : undefined));
  const me = useTable((s) => s.me);
  if (!token || !me || (tool !== "select" && tool !== "pan")) return null;
  const dm = me.role === "dm" || me.role === "admin";
  if (!canRaise(token, { userId: me.userId, dm }) || !showsElevation(token)) return null;
  const step = (delta: number) =>
    void request("token.elevation", { tokenId: token.id, delta }).catch((e) =>
      toast.danger("Couldn't change its height", (e as Error).message),
    );
  return (
    <section
      aria-label={`Elevation of ${token.name}`}
      data-testid="elevation-stepper"
      className="flex items-center gap-1 py-1 pr-1 pl-3"
    >
      <span className="caps pr-1 text-12 text-fog" aria-hidden>
        Height
      </span>
      <IconButton label="Lower 5 ft" shortcut="Alt+wheel" onClick={() => step(-5)}>
        <ChevronDown size={16} />
      </IconButton>
      <span
        className="tabular min-w-[4.5ch] text-center text-13 font-bold text-bone"
        data-testid="elevation-value"
      >
        {heightLabel(token.elevation)}
      </span>
      <IconButton label="Raise 5 ft" shortcut="Alt+wheel" onClick={() => step(5)}>
        <ChevronUp size={16} />
      </IconButton>
    </section>
  );
}
