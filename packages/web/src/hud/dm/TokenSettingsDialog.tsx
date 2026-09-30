import type { TokenView } from "@gloam/shared/state";
import { useEffect, useId, useState } from "react";
import { useSheets } from "../../net/sheets.ts";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented, Select, Toggle } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast, useToasts } from "../../ui/Toast.tsx";
import { act, overridesOf, revealOf, updateToken } from "./tokenDm.tsx";

const FIELD =
  "h-9 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-line bg-ink-950 px-2 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none";

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0"
      aria-label={title}
    >
      <h3 className="caps text-12 text-brass">{title}</h3>
      {children}
    </section>
  );
}

/** A number that takes effect when it's left or Enter is pressed (one command, not one per keystroke). */
function FeetField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: number | undefined;
  onCommit: (v: number | null) => void;
  placeholder: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const t = draft.trim();
    const n = t === "" ? null : Math.round(Number(t) / 5) * 5;
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 1000)) {
      setDraft(value === undefined ? "" : String(value));
      return;
    }
    if ((n ?? undefined) !== value) onCommit(n);
  };
  return (
    <label htmlFor={id} className="flex items-center justify-between gap-4">
      <span className="text-14 text-bone">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          id={id}
          inputMode="numeric"
          className={`${FIELD} tabular w-20 text-right`}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, "").slice(0, 4))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <span className="text-13 text-muted">ft</span>
      </span>
    </label>
  );
}

function Body({ t }: { t: TokenView }) {
  const o = overridesOf(t);
  const reveal = revealOf(t);
  const presence = useTable((s) => s.presence);
  const players = presence.filter((p) => p.role === "player");
  const actor = useSheets((s) => (t.actorId ? s.actors.get(t.actorId) : undefined));
  const npcDefault = useTable((s) => s.houseRules?.npcHpDisplay ?? "bar");
  const [note, setNote] = useState(t.dm?.secretNote ?? "");
  useEffect(() => setNote(t.dm?.secretNote ?? ""), [t.dm?.secretNote]);
  const [bonusFt, setBonusFt] = useState(o.bonusMove?.ft ?? 10);
  const [bonusUntil, setBonusUntil] = useState<"turn" | "rounds" | "removed">(o.bonusMove?.until ?? "turn");
  const [bonusRounds, setBonusRounds] = useState(o.bonusMove?.rounds ?? 2);
  const set = (overrides: Record<string, unknown>) => updateToken(t.id, { overrides });
  const flag = (key: string, v: boolean) => set({ [key]: v });
  const shared = o.shareVisionWith ?? [];
  const setLink = async (link: "linked" | "unlinked", overwrite = false) => {
    try {
      await request("token.setLink", { tokenId: t.id, link, overwrite });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "CONFLICT" && link === "linked" && !overwrite) {
        useToasts.getState().push({
          kind: "warning",
          title: "Its numbers differ from the sheet's",
          body: err.message,
          actions: [
            {
              label: "Replace with the sheet's",
              variant: "primary",
              onClick: () => void setLink("linked", true),
            },
          ],
        });
      } else toast.danger("Couldn't change the link", err.message);
    }
  };
  const linked = t.dm?.link === "linked";
  return (
    <div className="flex flex-col gap-4" data-testid="token-settings" data-token={t.id}>
      <Group title="Movement">
        <FeetField
          label="Speed override"
          value={o.speedOverride}
          placeholder="its own"
          onCommit={(v) => set({ speedOverride: v })}
        />
        <div className="flex flex-col gap-2">
          <span className="text-14 text-bone">Bonus movement</span>
          {o.bonusMove ? (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2">
              <span className="text-14 text-bone">
                +{o.bonusMove.ft} ft{" "}
                <span className="text-muted">
                  {o.bonusMove.until === "turn"
                    ? "this turn"
                    : o.bonusMove.until === "rounds"
                      ? `for ${o.bonusMove.rounds ?? 1} rounds`
                      : "until removed"}
                </span>
              </span>
              <Button size="S" variant="ghost" onClick={() => set({ bonusMove: null })}>
                Remove
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Bonus feet"
                inputMode="numeric"
                className={`${FIELD} tabular w-16 text-right`}
                value={bonusFt}
                onChange={(e) =>
                  setBonusFt(Math.min(1000, Number(e.target.value.replace(/[^\d]/g, "") || 0)))
                }
              />
              <span className="text-13 text-muted">ft</span>
              <Segmented
                label="Bonus movement lasts"
                size="S"
                value={bonusUntil}
                onChange={setBonusUntil}
                options={[
                  { value: "turn", label: "This turn" },
                  { value: "rounds", label: "Rounds" },
                  { value: "removed", label: "Until removed" },
                ]}
              />
              {bonusUntil === "rounds" ? (
                <input
                  aria-label="For how many rounds"
                  inputMode="numeric"
                  className={`${FIELD} tabular w-14 text-right`}
                  value={bonusRounds}
                  onChange={(e) =>
                    setBonusRounds(
                      Math.max(1, Math.min(100, Number(e.target.value.replace(/[^\d]/g, "") || 1))),
                    )
                  }
                />
              ) : null}
              <Button
                size="S"
                variant="secondary"
                disabled={bonusFt <= 0}
                onClick={() =>
                  set({
                    bonusMove: {
                      ft: Math.round(bonusFt / 5) * 5,
                      until: bonusUntil,
                      ...(bonusUntil === "rounds" ? { rounds: bonusRounds } : {}),
                    },
                  })
                }
              >
                Give it
              </Button>
            </div>
          )}
        </div>
        <Toggle
          checked={o.freeMovement === true}
          onChange={(v) => flag("freeMovement", v)}
          label="Free movement"
          description="Moves in combat without waiting for its turn or spending its movement."
        />
        <Toggle
          checked={o.lockMovement === true}
          onChange={(v) => flag("lockMovement", v)}
          label="Lock movement"
          description="Its players can't move it."
        />
        <Toggle
          checked={o.ignoreConditionSpeed === true}
          onChange={(v) => flag("ignoreConditionSpeed", v)}
          label="Ignore conditions' speed"
          description="Grappled, Restrained and the like don't slow it."
        />
        <Toggle
          checked={o.countAsMovement === true}
          onChange={(v) => flag("countAsMovement", v)}
          label="Count my moves"
          description="Your drags spend its movement, as its player's would."
        />
      </Group>

      <Group title="Who sees it">
        <Toggle
          checked={t.dm?.dmHidden === true}
          onChange={(v) => updateToken(t.id, { hidden: v })}
          label="Hidden"
          description="Only you see it, whatever the players can see."
        />
        <div className="flex flex-col gap-2">
          <span className="text-14 text-bone">Reveal</span>
          <Segmented
            label="Reveal"
            size="S"
            value={reveal === "vision" ? "vision" : reveal === "all" ? "all" : "chosen"}
            onChange={(v) =>
              updateToken(t.id, {
                revealTo:
                  v === "vision" ? "vision" : v === "all" ? "all" : players.map((p) => p.userId).slice(0, 1),
              })
            }
            options={[
              { value: "vision", label: "By sight" },
              { value: "all", label: "Always, to all" },
              { value: "chosen", label: "Always, to some" },
            ]}
          />
          {Array.isArray(reveal) ? (
            <PlayerChecks
              label="Always shown to"
              players={players}
              chosen={reveal}
              onChange={(ids) => updateToken(t.id, { revealTo: ids.length ? ids : "vision" })}
            />
          ) : null}
        </div>
        {players.length ? (
          <PlayerChecks
            label="Shares its sight with"
            players={players}
            chosen={shared}
            onChange={(ids) => updateToken(t.id, { shareVisionWith: ids })}
          />
        ) : null}
        <Select
          label="Players see its HP as"
          value={(t.hpDisplay || npcDefault) as "exact" | "bar" | "descriptor" | "hidden"}
          onChange={(v) => updateToken(t.id, { hpDisplay: v })}
          options={[
            { value: "exact", label: "Exact numbers" },
            { value: "bar", label: "A bar" },
            { value: "descriptor", label: "Healthy · Hurt · Bloodied…" },
            { value: "hidden", label: "Nothing" },
          ]}
        />
      </Group>

      {t.actorId ? (
        <Group title="Its sheet">
          <div className="flex items-center justify-between gap-3">
            <span className="text-14 text-bone">
              {linked ? "Linked — shows the sheet's HP and conditions." : "Unlinked — keeps its own numbers."}
            </span>
            <Button size="S" variant="secondary" onClick={() => void setLink(linked ? "unlinked" : "linked")}>
              {linked ? "Unlink" : "Link to sheet"}
            </Button>
          </div>
          {actor ? (
            <Select
              label="Sheet lock (what its player may change)"
              value={actor.lockLevel}
              onChange={(v) =>
                act(request("actor.setLock", { actorId: actor.id, level: v }), "Couldn't lock it")
              }
              options={[
                { value: "unlocked", label: "Anything" },
                { value: "core", label: "Not its core numbers" },
                { value: "full", label: "Nothing — they propose changes" },
              ]}
            />
          ) : null}
        </Group>
      ) : null}

      <Group title="Your note">
        <textarea
          aria-label="DM note"
          placeholder="Only you see this — what it carries, what it knows, what it wants"
          rows={3}
          maxLength={20_000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== (t.dm?.secretNote ?? ""))
              updateToken(t.id, { dmNote: note }, "Couldn't save the note");
          }}
          className="min-h-[76px] resize-y rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 py-2 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
        />
      </Group>
    </div>
  );
}

function PlayerChecks({
  label,
  players,
  chosen,
  onChange,
}: {
  label: string;
  players: { userId: string; name: string; color: string }[];
  chosen: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-14 text-bone">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {players.map((p) => {
          const on = chosen.includes(p.userId);
          return (
            <label
              key={p.userId}
              className={`flex h-8 min-h-[var(--touch-min)] cursor-pointer items-center gap-1.5 rounded-[var(--radius-chip)] border px-2.5 text-13 ${
                on ? "border-brass bg-raised text-bone" : "border-line text-muted hover:text-bone"
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={on}
                onChange={() => onChange(on ? chosen.filter((x) => x !== p.userId) : [...chosen, p.userId])}
              />
              <span className="h-2 w-2 rounded-full" style={{ background: p.color }} aria-hidden />
              {p.name}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const closeSettings = () => useUi.getState().set({ tokenSettings: null });

/**
 * A token's DM settings (SPEC §8.19 Per-token overrides; AC-DMP-02): its speed, bonus, free or locked movement,
 * conditions' speed ignored, the DM's moves counted; hidden, how it's revealed, whose sight it shares, how its HP
 * shows; linked or not and its sheet's lock; the DM's note. Each change is its own undoable command, at once.
 */
export function TokenSettingsDialog() {
  const id = useUi((s) => s.tokenSettings);
  const t = useBoard((d) => (id ? d.tokens.get(id) : undefined));
  // The token gone (deleted, another scene): the dialog with it.
  useEffect(() => {
    if (id && !t) closeSettings();
  }, [id, t]);
  return (
    <Dialog
      open={Boolean(id && t)}
      onClose={closeSettings}
      title={t ? `${t.name} — DM settings` : ""}
      width={480}
    >
      {t ? <Body t={t} /> : null}
    </Dialog>
  );
}
