import { NotebookPen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { request, tableEvents } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Select } from "../../ui/controls.tsx";
import { LoadGate, type LoadStatus } from "../../ui/Loadable.tsx";
import { SECTION_HEADING } from "../../ui/labels.ts";
import { act, focusToken } from "./tokenDm.tsx";

/**
 * DM panel → Handouts & Notes, the notes (SPEC §8.19): the DM's notes on this scene and on its creatures — never sent
 * to a player (AC-DMP-05). The scene's are asked for and kept in step (another DM's edit, an undo); a creature's live
 * in its DM settings.
 */
export function NotesSection() {
  const scene = useBoard((d) => d.scene);
  const tokens = useBoard((d) => d.tokens);
  const [notes, setNotes] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState("");
  const sceneId = scene?.id;
  // The notes as last heard (the field follows a change made elsewhere unless it's being edited).
  const heard = useRef<string | null>(null);
  heard.current = notes;
  // The notes' fetch (its loading and failed states; Try again asks again).
  const [fetched, setFetched] = useState<{ status: LoadStatus; error: string | null }>({
    status: "loading",
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt (Try again) asks again
  useEffect(() => {
    if (!sceneId) return;
    let alive = true;
    setFetched({ status: "loading", error: null });
    void request<{ sceneId: string; notes: string }>("scene.notes", { sceneId }).then(
      (r) => {
        if (!alive) return;
        setNotes(r.notes);
        setDraft(r.notes);
        setFetched({ status: "ready", error: null });
      },
      (e: Error) => {
        if (alive) setFetched({ status: "error", error: e.message || null });
      },
    );
    const off = tableEvents.on("message", ({ type, payload }) => {
      if (type !== "scene.notes") return;
      const n = payload as { sceneId: string; notes: string };
      if (n.sceneId !== sceneId) return;
      // Another hand changed them (a co-DM, an undo): the field follows unless it's mid-edit.
      const was = heard.current;
      setNotes(n.notes);
      setDraft((d) => (d === was ? n.notes : d));
    });
    return () => {
      alive = false;
      off();
    };
  }, [sceneId, attempt]);
  if (!scene) return null;
  const noted = [...tokens.values()]
    .filter((t) => t.dm?.secretNote)
    .sort((a, b) => a.name.localeCompare(b.name));
  const others = [...tokens.values()]
    .filter((t) => !t.dm?.secretNote)
    .sort((a, b) => a.name.localeCompare(b.name));
  const save = () => {
    if (notes === null || draft === notes) return;
    act(request("scene.update", { sceneId: scene.id, dmNotes: draft }), "Couldn't save the notes");
  };
  return (
    <section
      className="flex flex-col gap-3 border-t border-line p-4"
      aria-label="DM notes"
      data-testid="dm-notes"
    >
      <h3 className={`flex items-center gap-2 ${SECTION_HEADING}`}>
        <NotebookPen size={14} aria-hidden /> Your notes · only you see them
      </h3>
      <div className="flex flex-col gap-1.5">
        <span className="text-14 text-bone">On {scene.name}</span>
        {fetched.status !== "ready" ? (
          <LoadGate load={{ ...fetched, retry: () => setAttempt((n) => n + 1) }} what="the notes">
            {() => null}
          </LoadGate>
        ) : (
          <textarea
            aria-label={`Notes on ${scene.name}`}
            placeholder="What waits here, what the players don't know yet, what you mustn't forget"
            rows={4}
            maxLength={20_000}
            value={draft}
            disabled={notes === null}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            className="min-h-[96px] resize-y rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 py-2 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
          />
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-14 text-bone">On creatures</span>
        {noted.length ? (
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {noted.map((t) => (
              <li key={t.id} className="flex items-start gap-2 px-3 py-2" data-testid="token-note">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col text-left"
                  onClick={() => focusToken(t)}
                >
                  <span className="truncate text-14 font-bold text-bone">{t.name}</span>
                  <span className="line-clamp-2 whitespace-pre-wrap text-13 text-muted">
                    {t.dm?.secretNote}
                  </span>
                </button>
                <Button
                  size="S"
                  variant="ghost"
                  onClick={() => useUi.getState().set({ tokenSettings: t.id })}
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-13 text-muted">No creature has a note yet.</p>
        )}
        {others.length ? (
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Select
                label="Add a note to"
                value={pick}
                onChange={setPick}
                options={[
                  { value: "", label: "Choose a creature…" },
                  ...others.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            </div>
            <Button
              size="S"
              variant="secondary"
              disabled={!pick}
              onClick={() => {
                useUi.getState().set({ tokenSettings: pick });
                setPick("");
              }}
            >
              Write
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
