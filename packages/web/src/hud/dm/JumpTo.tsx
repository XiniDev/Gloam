import { CornerDownLeft } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { actAs, useActAs } from "../../net/actAs.ts";
import { useSheets } from "../../net/sheets.ts";
import { openPrep, request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useLibrary } from "../../state/library.ts";
import { type DmSection, type Tool, useUi } from "../../state/ui.ts";
import { Dialog } from "../../ui/Dialog.tsx";
import { openQuickUnit } from "../LeftToolbar.tsx";
import { SECTIONS } from "./sections.ts";
import { act, focusToken } from "./tokenDm.tsx";

interface Entry {
  id: string;
  label: string;
  /** What kind of thing it is ("Section", "Tool", "Token"…), shown at the row's end. */
  kind: string;
  hint?: string;
  words: string;
  run(): void;
}

const section = (id: DmSection) => useUi.getState().set({ dock: "dm", dmSection: id, jumpTo: false });
const tool = (t: Tool) => useUi.getState().set({ tool: t, jumpTo: false, dock: null });

/**
 * How well `query` matches `text`: every query word must start a word of the text or appear in it; earlier and
 * word-start matches score higher. Null for no match.
 */
export function matchScore(text: string, query: string): number | null {
  const hay = text.toLowerCase();
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let score = 0;
  for (const w of words) {
    const at = hay.indexOf(w);
    if (at < 0) return null;
    const start = at === 0 || /[\s·&(-]/.test(hay[at - 1] ?? "");
    score += (start ? 10 : 3) + Math.max(0, 5 - at / 10);
  }
  return score;
}

/**
 * Jump to… (SPEC §8.19; AC-DMP-01): Ctrl/Cmd+K opens a search over every DM panel section and the DM's commands —
 * the board's tools, Quick unit, combat, dice, undo and redo, the creatures on the scene, the other scenes (in prep),
 * Act as each character — typed, arrowed through, Enter to go.
 */
export function JumpTo() {
  const open = useUi((s) => s.jumpTo);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const tokens = useBoard((d) => d.tokens);
  const actors = useSheets((s) => s.actors);
  const scenes = useLibrary((s) => s.scenes);
  const liveScene = useBoard((d) => d.scene?.id);
  const acting = useActAs((s) => s.mine);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  // The shortcut: DMs only, anywhere at the table (a field keeps its own Ctrl+K elsewhere, not here).
  useEffect(() => {
    if (!dm) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUi.getState().set({ jumpTo: !useUi.getState().jumpTo });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dm]);
  useEffect(() => {
    if (!open) return;
    setQ("");
    setAt(0);
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = SECTIONS.map((s) => ({
      id: `section:${s.id}`,
      label: s.label,
      kind: "Section",
      hint: s.holds,
      words: `${s.label} ${s.keywords} ${s.holds}`,
      run: () => section(s.id),
    }));
    const cmd = (id: string, label: string, words: string, run: () => void, hint?: string) =>
      out.push({
        id: `cmd:${id}`,
        label,
        kind: "Command",
        words: `${label} ${words}`,
        run,
        ...(hint ? { hint } : {}),
      });
    cmd("quick-unit", "Quick unit", "add creature npc monster token", () => {
      useUi.getState().set({ jumpTo: false });
      openQuickUnit();
    });
    cmd(
      "quick-start",
      "Quick start combat",
      "fight initiative encounter begin",
      () => {
        useUi.getState().set({ jumpTo: false });
        act(request("combat.quickStart", {}), "Couldn't start combat");
      },
      "Ctrl+Shift+C",
    );
    cmd("start-combat", "Start combat…", "fight initiative encounter choose", () => section("combat"));
    cmd(
      "dice",
      "Roll dice",
      "tray d20 roll",
      () => useUi.getState().set({ diceTray: true, jumpTo: false }),
      "D",
    );
    cmd(
      "undo",
      "Undo",
      "back revert",
      () => {
        useUi.getState().set({ jumpTo: false });
        act(request("history.undo", {}), "Nothing to undo");
      },
      "Ctrl+Z",
    );
    cmd(
      "redo",
      "Redo",
      "again",
      () => {
        useUi.getState().set({ jumpTo: false });
        act(request("history.redo", {}), "Nothing to redo");
      },
      "Ctrl+Y",
    );
    const tools: [Tool, string, string, string][] = [
      ["walls", "Draw walls", "doors windows rooms", "W"],
      ["zones", "Draw zones", "water difficult hazard", "Z"],
      ["lights", "Place lights", "torch lantern", "I"],
      ["fog", "Fog tools", "reveal hide paint", "B"],
      ["measure", "Measure", "ruler distance", "M"],
    ];
    for (const [t, label, words, key] of tools)
      out.push({
        id: `tool:${t}`,
        label,
        kind: "Tool",
        hint: key,
        words: `${label} ${words}`,
        run: () => tool(t),
      });
    for (const t of tokens.values())
      out.push({
        id: `token:${t.id}`,
        label: t.name,
        kind: "Token",
        hint: `${t.disposition.charAt(0).toUpperCase()}${t.disposition.slice(1)}${t.dm?.dmHidden ? " · hidden" : ""}`,
        words: `${t.name} token creature ${t.disposition}`,
        run: () => {
          useUi.getState().set({ jumpTo: false });
          focusToken(t);
        },
      });
    for (const s of scenes)
      if (s.id !== liveScene && !s.archived && !s.deleted)
        out.push({
          id: `scene:${s.id}`,
          label: s.name,
          kind: "Scene",
          hint: "open in prep",
          words: `${s.name} scene map prep`,
          run: () => {
            useUi.getState().set({ jumpTo: false });
            act(openPrep(s.id), "Couldn't open it");
          },
        });
    for (const a of actors.values())
      if (a.kind === "character") {
        const on = acting?.actorId === a.id;
        out.push({
          id: `act:${a.id}`,
          label: on ? `Stop acting as ${a.sheet.core.name}` : `Act as ${a.sheet.core.name}`,
          kind: "Character",
          words: `act as play control ${a.sheet.core.name}`,
          run: () => {
            useUi.getState().set({ jumpTo: false });
            act(actAs(on ? null : a.id), "Couldn't take its controls");
          },
        });
      }
    return out;
  }, [tokens, actors, scenes, liveScene, acting]);

  const shown = useMemo(() => {
    if (!q.trim()) return entries.filter((e) => e.kind === "Section" || e.kind === "Command");
    return entries
      .map((e) => ({ e, s: matchScore(e.words, q) }))
      .filter((x): x is { e: Entry; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s || a.e.label.localeCompare(b.e.label))
      .slice(0, 40)
      .map((x) => x.e);
  }, [entries, q]);
  const cur = Math.min(at, Math.max(0, shown.length - 1));

  if (!dm) return null;
  return (
    <Dialog open={open} onClose={() => useUi.getState().set({ jumpTo: false })} title="Jump to" width={520}>
      <div className="flex flex-col gap-2" data-testid="jump-to">
        <input
          ref={input}
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown[cur] ? `${listId}-${cur}` : undefined}
          aria-label="Section or command"
          placeholder="A section, a command, a creature, a scene…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              shown[cur]?.run();
            }
          }}
          className="h-11 w-full rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 text-16 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Matches"
          className="flex max-h-[50vh] flex-col overflow-y-auto"
        >
          {shown.length ? (
            shown.map((e, i) => (
              <div
                key={e.id}
                tabIndex={-1}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === cur}
                onMouseMove={() => setAt(i)}
                onClick={() => e.run()}
                className={`flex min-h-[var(--touch-min)] cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 ${
                  i === cur ? "bg-raised" : ""
                }`}
                data-testid="jump-option"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`truncate text-14 ${i === cur ? "text-brass-bright" : "text-bone"}`}>
                    {e.label}
                  </span>
                  {e.hint ? <span className="truncate text-12 text-muted">{e.hint}</span> : null}
                </span>
                <span className="caps shrink-0 text-12 text-fog">{e.kind}</span>
                {i === cur ? <CornerDownLeft size={14} className="shrink-0 text-muted" aria-hidden /> : null}
              </div>
            ))
          ) : (
            <p className="px-3 py-4 text-14 text-muted">Nothing by that name.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
