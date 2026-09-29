import type { EffectView } from "@gloam/shared/state";
import { Eye, EyeOff, X } from "lucide-react";
import { removeEffect, updateEffect } from "../../net/spells.ts";
import { useBoard } from "../../state/entities.ts";
import { IconButton } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { toast } from "../../ui/Toast.tsx";

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

/** What an effect does, in words (§8.13 Persistent effects: its properties). */
function doesText(e: EffectView): string {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(e.propsJson) as Record<string, unknown>;
  } catch {
    // a props document that doesn't parse: nothing to say
  }
  const out: string[] = [];
  if (p.magicalDarkness) out.push("magical darkness");
  else if (p.obscurement === "heavy") out.push("heavily obscured");
  else if (p.obscurement === "light") out.push("lightly obscured");
  if (p.difficult) out.push("difficult terrain");
  if (p.speedHalved) out.push("Speed halved");
  if (p.silence) out.push("silence");
  if (p.opaque) out.push("blocks sight");
  if (p.light) out.push("light");
  if (p.outline) out.push("outlines");
  if (p.seeInvisible) out.push("sees the Invisible");
  if (p.senses) out.push("senses");
  return out.join(", ");
}

/**
 * DM panel → Effects (SPEC §8.13 Persistent effects): the effects on the scene — each with what it does, how many
 * rounds it has left (in combat), who sees it — hidden from the players or shown, and ended (its caster's concentration
 * with it). Moving one is a drag on the board.
 */
export function EffectsPanel() {
  const effects = useBoard((d) => d.effects);
  const list = [...effects.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4" data-testid="effects-panel">
      {list.length ? (
        <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
          {list.map((e) => (
            <li
              key={e.id}
              className="flex items-center gap-2 px-3 py-2"
              data-testid="effect-row"
              data-effect={e.id}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-14 text-bone">
                  {e.name}
                  {e.dmHidden ? <span className="caps ml-1.5 text-12 text-fog">hidden</span> : null}
                </span>
                <span className="truncate text-12 text-muted">
                  {doesText(e) || "no board effect"}
                  {e.roundsLeft >= 0
                    ? ` · ${e.roundsLeft} ${e.roundsLeft === 1 ? "round" : "rounds"} left`
                    : ""}
                </span>
              </span>
              <IconButton
                label={e.dmHidden ? `Show ${e.name} to the players` : `Hide ${e.name} from the players`}
                onClick={() =>
                  act(
                    updateEffect(e.id, { visibility: e.dmHidden ? "everyone" : "dm" }),
                    "Couldn't change it",
                  )
                }
              >
                {e.dmHidden ? <Eye size={15} /> : <EyeOff size={15} />}
              </IconButton>
              <IconButton
                label={`End ${e.name}`}
                tone="danger"
                onClick={() => act(removeEffect(e.id), "Couldn't end it")}
              >
                <X size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          art="candle"
          title="No lasting effects on this scene. A spell that leaves one (Fog Cloud, Moonbeam, Web…) lists it here."
        />
      )}
    </div>
  );
}
