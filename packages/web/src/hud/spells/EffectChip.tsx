import { controlsToken } from "@gloam/shared/rules";
import { X } from "lucide-react";
import { useRef } from "react";
import { boardApi } from "../../board/boardApi.ts";
import { handleOf } from "../../board/vfx/EffectHandles.tsx";
import { removeEffect } from "../../net/spells.ts";
import { useTable } from "../../net/table.ts";
import { useEffectUi } from "../../state/effectUi.ts";
import { useBoard } from "../../state/entities.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { toast } from "../../ui/Toast.tsx";
import { useBesideLabel } from "../placement.ts";

/**
 * A picked effect's chip (SPEC §8.13 Persistent effects): its name and rounds left, how it moves (drag its handle —
 * as far as its caster may; it drifts; it goes with its creature), and what can be done: strike again (Call
 * Lightning's next bolt), end it (its caster, the DM). Beside its handle, clear of the board's plates and the HUD.
 */
export function EffectChip() {
  const selected = useEffectUi((s) => s.selected);
  const strike = useEffectUi((s) => s.strike);
  const e = useBoard((d) => (selected ? d.effects.get(selected) : undefined));
  const tokens = useBoard((d) => d.tokens);
  const me = useTable((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  const dm = me?.role === "dm" || me?.role === "admin";
  const h = e
    ? handleOf(e, dm, (id) => {
        const t = tokens.get(id);
        return Boolean(t && me && controlsToken(me.role, me.userId, t));
      })
    : null;
  useBesideLabel(ref, () => {
    if (!h) return null;
    const c = boardApi.project(h.mark.x, h.mark.y, 0.14);
    return c ? { cx: c.sx, cy: c.sy, r: 18 } : null;
  });
  if (!e || !h) return null;
  const how = h.movable
    ? `Drag its handle to move it${h.maxFt !== null ? ` — up to ${h.maxFt} ft${dm ? " for its caster" : ""}` : ""}.`
    : h.drifts
      ? "It drifts 10 ft at the start of its caster's turns."
      : null;
  return (
    <div
      ref={ref}
      className="panel pointer-events-auto fixed z-40 flex w-[min(300px,calc(100vw-24px))] flex-col gap-2 px-3 py-2.5"
      style={{ left: -9999, top: -9999 }}
      data-testid="effect-chip"
      data-effect={e.id}
      role="dialog"
      aria-label={e.name}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="display text-16 leading-tight text-bone">{e.name}</span>
          {e.roundsLeft >= 0 ? (
            <span className="text-12 text-muted">
              {e.roundsLeft} {e.roundsLeft === 1 ? "round" : "rounds"} left
            </span>
          ) : null}
        </div>
        <IconButton label="Close" onClick={() => useEffectUi.getState().set({ selected: null })}>
          <X size={15} />
        </IconButton>
      </div>
      {how ? <p className="text-13 text-muted">{how}</p> : null}
      {strike?.effectId === e.id ? (
        <p className="text-13 text-bone" data-testid="strike-hint">
          Click a point under it to strike · Esc to stop
        </p>
      ) : null}
      {h.strike !== null || h.endable ? (
        <div className="flex flex-wrap gap-2">
          {h.strike !== null ? (
            <Button
              size="S"
              variant="primary"
              aria-pressed={strike?.effectId === e.id}
              onClick={() =>
                useEffectUi.getState().set({
                  strike:
                    strike?.effectId === e.id ? null : { effectId: e.id, radius: h.strike ?? 5, at: null },
                })
              }
            >
              Strike again
            </Button>
          ) : null}
          {h.endable ? (
            <Button
              size="S"
              variant="danger"
              onClick={() => {
                useEffectUi.getState().set({ selected: null, strike: null });
                void removeEffect(e.id).catch((err: Error) =>
                  toast.danger(`Couldn't end ${e.name}`, err.message),
                );
              }}
            >
              End {e.name}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
