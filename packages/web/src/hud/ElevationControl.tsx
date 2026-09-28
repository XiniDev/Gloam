import { ChevronDown, ChevronUp } from "lucide-react";
import { canRaise, showsElevation } from "../board/tokens/elevation.ts";
import { request, useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";
import { toast } from "../ui/Toast.tsx";
import { useHudInsets } from "./insets.ts";

/**
 * The elevation stepper (SPEC §8.5 flying; AC-TOK-07): ▲/▼ in 5-ft steps with the selected flyer's height, at the
 * right edge of the board area — a fixed place in the HUD rather than a bubble beside the token, where it covered
 * whatever stood next to it. Alt+wheel over the token does the same.
 */
export function ElevationControl() {
  const selected = useUi((s) => (s.selection.length === 1 ? s.selection[0] : undefined));
  const token = useBoard((d) => (selected ? d.tokens.get(selected) : undefined));
  const me = useTable((s) => s.me);
  const right = useHudInsets((s) => s.right);
  if (!token || !me) return null;
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
      className="panel pointer-events-auto absolute top-1/2 z-30 flex -translate-y-1/2 flex-col items-center gap-0.5 p-1"
      style={{ right }}
    >
      <IconButton label="Raise 5 ft (Alt+wheel)" onClick={() => step(5)}>
        <ChevronUp size={16} />
      </IconButton>
      <span className="tabular px-1 text-12 font-bold text-bone" data-testid="elevation-value">
        {token.elevation > 0 ? "+" : ""}
        {Math.round(token.elevation)} ft
      </span>
      <IconButton label="Lower 5 ft (Alt+wheel)" onClick={() => step(-5)}>
        <ChevronDown size={16} />
      </IconButton>
    </section>
  );
}
