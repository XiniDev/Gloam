import { Footprints } from "lucide-react";
import { useEffect } from "react";
import { rangeInputs } from "../board/move/drag.ts";
import { requestRange } from "../board/move/rangeHost.ts";
import { useTable } from "../net/table.ts";
import { boardData, useBoard, useEntities } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";

/**
 * The movement range overlay's toggle (SPEC §8.6, Appendix H: G, or this button): beside the selected creature's
 * controls whenever the viewer may move it.
 */
export function RangeToggle() {
  const selected = useUi((s) => (s.selection.length === 1 ? s.selection[0] : undefined));
  const tool = useUi((s) => s.tool);
  const on = useUi((s) => s.rangeOverlay);
  const token = useBoard((d) => (selected ? d.tokens.get(selected) : undefined));
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const mine = Boolean(token?.own && me && (dm || token.ownerIds.includes(me.userId)));
  // A creature the viewer may move is selected: the worker gets its world and builds its corner nodes in idle time,
  // so the first G doesn't wait for them (§16.6 "under 30 ms"; the first field costs several times that).
  const tokenId = mine ? token?.id : undefined;
  useEffect(() => {
    if (!tokenId) return;
    const warm = () => {
      // (Not while the overlay is up: its own request may be out, and the newest request supersedes the others.)
      if (useUi.getState().rangeOverlay) return;
      const t = boardData(useEntities.getState()).tokens.get(tokenId);
      const inputs = t ? rangeInputs(t) : null;
      if (t && inputs) void requestRange(inputs.world, t.pos, { rc: inputs.rc, budget: 5 }).catch(() => {});
    };
    const idle = (globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const id = idle ? idle(warm, { timeout: 1000 }) : window.setTimeout(warm, 200);
    return () => {
      const cancel = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(id);
      else window.clearTimeout(id);
    };
  }, [tokenId]);
  if (!token?.own || !me || !mine || (tool !== "select" && tool !== "pan")) return null;
  return (
    <div className="panel pointer-events-auto flex items-center p-1" data-testid="range-toggle">
      <IconButton
        label="Movement range"
        shortcut="G"
        active={on}
        onClick={() => useUi.getState().set({ rangeOverlay: !on })}
      >
        <Footprints size={18} />
      </IconButton>
    </div>
  );
}
