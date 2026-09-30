import type { LogEntryView } from "@gloam/shared/protocol";
import { Download, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { addLogEntry, logMarkdown, useFun } from "../../net/fun.ts";
import { useTable } from "../../net/table.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { toast } from "../../ui/Toast.tsx";
import { HandoutCard } from "./HandoutCard.tsx";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (at: number) =>
  new Date(at).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });

/** The kinds of entry, as the log names them beside the time. */
const KIND: Record<string, string> = {
  "session.open": "Session",
  "session.close": "Session",
  scene: "Travel",
  "combat.summary": "Combat",
  death: "Death",
  stable: "Stable",
  level: "Level",
  handout: "Handout",
  manual: "Note",
};

function Log() {
  const log = useFun((s) => s.log);
  const loaded = useFun((s) => s.logLoaded);
  const me = useTable((s) => s.me);
  const campaign = useTable((s) => s.campaignName);
  const [q, setQ] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? log.filter((e) => e.text.toLowerCase().includes(needle) || e.author?.toLowerCase().includes(needle))
      : log;
  }, [log, q]);
  // Grouped by session, newest session first; within one, in the order it happened.
  const groups = useMemo(() => {
    const m = new Map<number, LogEntryView[]>();
    for (const e of shown) m.set(e.sessionNo, [...(m.get(e.sessionNo) ?? []), e]);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [shown]);
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await addLogEntry(t);
      setText("");
    } catch (e) {
      toast.danger("Couldn't add it", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportMd = () => {
    const blob = new Blob([logMarkdown(campaign || "Campaign", log)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(campaign || "campaign")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}-log.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const canWrite = me && me.role !== "spectator";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="campaign-log">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <label className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fog"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Search the log"
            placeholder="Search the log"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 min-h-[var(--touch-min)] w-full rounded-[var(--radius-control)] border border-line bg-ink-950 pl-8 pr-2 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
          />
        </label>
        <Button
          variant="ghost"
          size="S"
          onClick={exportMd}
          disabled={!log.length}
          icon={<Download size={14} aria-hidden />}
        >
          Markdown
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
        {!loaded ? null : groups.length ? (
          // The log itself is a document (§27.1): the sessions on a parchment sheet, the search and the pen on ink.
          <div className="parchment flex flex-col gap-4 px-4 py-3" data-testid="log-sheet">
            {groups.map(([session, entries]) => (
              <section
                key={session}
                aria-label={session ? `Session ${session}` : "Before the first session"}
                data-testid="log-session"
              >
                <h3 className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-parchment-edge/70 pb-1">
                  <span className="font-display text-18 text-paper-ink">
                    {session ? `Session ${session}` : "Before the first session"}
                  </span>
                  <span className="text-12 text-paper-muted">
                    {day((entries[0] as LogEntryView).createdAt)}
                  </span>
                </h3>
                <ol className="flex flex-col gap-2.5">
                  {entries.map((e) => (
                    // When and what kind on a line of their own, the entry under them at the sheet's full width (in
                    // columns the text had a sliver and broke every other line — critic P11 r2 N8).
                    <li
                      key={e.id}
                      className="flex flex-col gap-0.5"
                      data-testid="log-entry"
                      data-kind={e.kind}
                    >
                      <span className="flex items-baseline gap-2 text-12">
                        <span className="tabular whitespace-nowrap text-paper-muted">
                          {time(e.createdAt)}
                        </span>
                        <span className="caps text-wax">{KIND[e.kind] ?? ""}</span>
                      </span>
                      <span className="text-14 leading-[var(--leading-body)] text-paper-ink [text-wrap:pretty]">
                        {e.kind === "manual" ? (
                          <>
                            <span className="font-bold">{e.author ?? "Someone"}</span>{" "}
                            <span className="whitespace-pre-wrap">{e.text}</span>
                          </>
                        ) : (
                          e.text
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              q
                ? "Nothing in the log matches that."
                : "Nothing written yet: sessions, travel, fights and what you write here gather in the log."
            }
          />
        )}
      </div>
      {canWrite ? (
        <form
          className="flex flex-col gap-2 border-t border-line px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <textarea
            aria-label="A line for the log"
            placeholder="A recap, a clue, a vow — for the log"
            maxLength={4000}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void add();
            }}
            className="min-h-[60px] resize-y rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 py-2 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
          />
          <Button
            type="submit"
            variant="secondary"
            size="S"
            className="self-end"
            loading={busy}
            disabled={!text.trim()}
          >
            Add to the log
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function Handouts() {
  const handouts = useFun((s) => s.handouts);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const mine = dm
    ? handouts.filter((h) => h.recipients === "all" || (h.recipients?.length ?? 0) > 0)
    : handouts;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="handouts-list">
      {mine.length ? (
        mine.map((h) => <HandoutCard key={h.id} h={h} compact />)
      ) : (
        <EmptyState title="No handouts yet: when the DM shows you a map, a letter or a riddle, it stays here." />
      )}
    </div>
  );
}

/**
 * The dock's Journal (SPEC §8.18): the campaign log, and this person's handouts and notes, under the same tabs as the
 * DM panel's.
 */
export function JournalPanel() {
  const [tab, setTab] = useState<"log" | "handouts">("log");
  const count = useFun((s) => s.handouts.length);
  // Looked at: nothing waiting any more.
  useEffect(() => useFun.getState().set({ unread: 0 }), []);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 pb-0 pt-3">
        <h2 className="pb-2 text-18 text-bone">Journal</h2>
      </header>
      <Tabs
        label="Journal pages"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "log", label: "Log" },
          {
            id: "handouts",
            label: (
              <>
                Handouts
                {count ? <span className="tabular text-13 text-muted">{count}</span> : null}
              </>
            ),
          },
        ]}
      />
      <div
        role="tabpanel"
        aria-label={tab === "log" ? "Log" : "Handouts"}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === "log" ? <Log /> : <Handouts />}
      </div>
    </div>
  );
}
