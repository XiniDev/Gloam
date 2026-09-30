import { VenetianMask } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusIcon } from "../../icons/status.tsx";
import { actAs, useActAs } from "../../net/actAs.ts";
import { requestDeathSaves } from "../../net/health.ts";
import { useSheets } from "../../net/sheets.ts";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { RestDialog } from "../health/RestDialog.tsx";
import { CharacterRow } from "../PartyPanel.tsx";
import { act } from "./tokenDm.tsx";

/**
 * DM panel → Party (SPEC §8.19): the characters at a glance — HP, conditions, passive scores — with the DM's controls
 * for each: grant or take back Heroic Inspiration, ask a dying one for its death save, and Act as (take its controls on
 * its player's behalf, AC-DMP-03); short and long rests for the party.
 */
export function PartySection() {
  const actors = useSheets((s) => s.actors);
  const presence = useTable((s) => s.presence);
  const tokens = useBoard((d) => d.tokens);
  const acting = useActAs((s) => s.mine);
  const [resting, setResting] = useState<"short" | "long" | null>(null);
  const characters = useMemo(
    () =>
      [...actors.values()]
        .filter((a) => a.kind === "character")
        .sort((x, y) => x.sheet.core.name.localeCompare(y.sheet.core.name)),
    [actors],
  );
  if (!characters.length)
    return (
      <EmptyState
        art="door"
        title="No characters yet. When your players make theirs, they're here — HP, conditions, passives at a glance."
      />
    );
  return (
    <div className="flex flex-col" data-testid="party-section">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="caps flex-1 text-12 text-brass">Rests</span>
        <Button size="S" variant="secondary" onClick={() => setResting("short")}>
          Short rest…
        </Button>
        <Button size="S" variant="secondary" onClick={() => setResting("long")}>
          Long rest…
        </Button>
      </div>
      <RestDialog kind={resting} characters={characters} onClose={() => setResting(null)} />
      <ul className="px-2 py-2">
        {characters.map((a) => {
          const who = presence.find((p) => p.userId === a.ownerUserId);
          const c = a.sheet.core;
          const on = c.inspiration;
          // Dying as its tokens show it (the death-saves marker, not stable, not dead) — a token to ask through.
          const dyingTokens = [...tokens.values()].filter(
            (t) =>
              t.actorId === a.id &&
              t.markers.includes("deathsaves") &&
              !t.markers.includes("stable") &&
              !t.dead,
          );
          const dying = dyingTokens.length > 0;
          const mine = dyingTokens.map((t) => t.id);
          const isActing = acting?.actorId === a.id;
          return (
            <CharacterRow
              key={a.id}
              a={a}
              color={who?.color ?? ""}
              player={who?.name ?? null}
              actions={
                <>
                  <IconButton
                    label={
                      on ? `Take back ${c.name}'s Heroic Inspiration` : `Give ${c.name} Heroic Inspiration`
                    }
                    active={on}
                    onClick={() =>
                      act(
                        request("actor.change", {
                          actorId: a.id,
                          changes: [{ path: ["core", "inspiration"], after: !on }],
                        }),
                        "Couldn't change it",
                      )
                    }
                  >
                    <StatusIcon id="inspiration" size={18} label="" />
                  </IconButton>
                  <IconButton
                    label={isActing ? `Stop acting as ${c.name}` : `Act as ${c.name}`}
                    active={isActing}
                    onClick={() => act(actAs(isActing ? null : a.id), "Couldn't take its controls")}
                  >
                    <VenetianMask size={17} />
                  </IconButton>
                  {dying && mine.length ? (
                    <Button
                      size="S"
                      variant="secondary"
                      onClick={() => act(requestDeathSaves(mine), "Couldn't ask for it")}
                    >
                      Death save
                    </Button>
                  ) : null}
                </>
              }
            />
          );
        })}
      </ul>
    </div>
  );
}
