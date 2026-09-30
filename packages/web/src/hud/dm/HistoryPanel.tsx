import type { HistoryListEntry, HistoryListResult, HistoryRestorePlan } from "@gloam/shared/protocol";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { request, tableEvents } from "../../net/table.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { LoadFailed, LoadGate } from "../../ui/Loadable.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { toast } from "../../ui/Toast.tsx";

/** What a command type is about, for the Type filter (its family: the part before the dot). */
const FAMILIES: { value: string; label: string }[] = [
  { value: "", label: "Anything" },
  { value: "token", label: "Tokens" },
  { value: "move", label: "Moves" },
  { value: "hp", label: "HP and conditions" },
  { value: "fog", label: "Fog" },
  { value: "wall", label: "Walls and doors" },
  { value: "actor", label: "Sheets" },
  { value: "spell", label: "Spells and effects" },
  { value: "combat", label: "Combat" },
  { value: "scene", label: "Scenes" },
];

const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(at).toLocaleDateString();
};

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

/**
 * DM panel → History (SPEC §8.14, §14.4; AC-UNDO-03/04): the table's changes, newest first — who, what, on which scene,
 * when — filtered by person, kind and scene. Each has Revert (one click: it's undone at once, as a new entry that can
 * itself be undone; when someone changed the same things since, a confirmation says what it overrides) and Restore to
 * here (every later change reverted, after a confirmation listing them). Dice, joins, approvals and the like aren't
 * listed as revertible: they're facts.
 */
export function HistoryPanel() {
  const [filter, setFilter] = useState<{ userId: string; family: string; sceneId: string }>({
    userId: "",
    family: "",
    sceneId: "",
  });
  const [data, setData] = useState<HistoryListResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    entry: HistoryListEntry;
    plan: HistoryRestorePlan;
    mode: "revert" | "restore";
  } | null>(null);
  const load = useCallback(
    (before?: number) =>
      request<HistoryListResult>("history.list", {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.family ? { family: filter.family } : {}),
        ...(filter.sceneId ? { sceneId: filter.sceneId } : {}),
        ...(before ? { before } : {}),
        limit: 50,
      })
        .then((r) => {
          setFailed(null);
          setData((d) => (before && d ? { ...r, entries: [...d.entries, ...r.entries] } : r));
        })
        .catch((e: Error) => setFailed(e.message)),
    [filter],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Kept current as the table changes (every committed command says so).
  useEffect(
    () =>
      tableEvents.on("message", (m) => {
        if (m.type === "history.changed") void load();
      }),
    [load],
  );

  const revert = async (e: HistoryListEntry) => {
    const plan = await request<HistoryRestorePlan>("history.revert", { id: e.id, dryRun: true });
    if (plan.conflicts.length) {
      setConfirm({ entry: e, plan, mode: "revert" });
      return;
    }
    const r = await request<{ summary: string }>("history.revert", { id: e.id });
    toast.success("Reverted", r.summary);
  };
  const restore = async (e: HistoryListEntry) => {
    const plan = await request<HistoryRestorePlan>("history.restore", { id: e.id, dryRun: true });
    setConfirm({ entry: e, plan, mode: "restore" });
  };
  const go = async () => {
    if (!confirm) return;
    const { entry, mode } = confirm;
    setConfirm(null);
    if (mode === "revert") {
      const r = await request<{ summary: string }>("history.revert", { id: entry.id, force: true });
      toast.success("Reverted", r.summary);
    } else {
      const r = await request<{ reverted: number }>("history.restore", { id: entry.id });
      toast.success("Restored", `${r.reverted} ${r.reverted === 1 ? "change" : "changes"} reverted.`);
    }
  };

  const sel = (
    label: string,
    value: string,
    options: { value: string; label: string }[],
    on: (v: string) => void,
  ) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="caps text-12 text-fog">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(ev) => on(ev.target.value)}
        className="h-9 min-h-[var(--touch-min)] w-full rounded-[var(--radius-control)] border border-line bg-ink-900 px-2 text-14 text-bone focus:border-brass focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-ink-900">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" data-testid="history-panel">
      <div className="flex gap-2">
        {sel(
          "Person",
          filter.userId,
          [
            { value: "", label: "Anyone" },
            ...(data?.people ?? []).map((p) => ({ value: p.id, label: p.name })),
          ],
          (v) => setFilter((f) => ({ ...f, userId: v })),
        )}
        {sel("Kind", filter.family, FAMILIES, (v) => setFilter((f) => ({ ...f, family: v })))}
        {sel(
          "Scene",
          filter.sceneId,
          [
            { value: "", label: "Any scene" },
            ...(data?.scenes ?? []).map((s) => ({ value: s.id, label: s.name })),
          ],
          (v) => setFilter((f) => ({ ...f, sceneId: v })),
        )}
      </div>
      {/* Before the first page: loading, or why it failed (Try again); a later page's failure says so above the list. */}
      {!data ? (
        <LoadGate
          load={{ status: failed ? "error" : "loading", error: failed, retry: () => void load() }}
          what="the history"
        >
          {() => null}
        </LoadGate>
      ) : failed ? (
        <LoadFailed what="the latest history" error={failed} retry={() => void load()} compact />
      ) : null}
      {data && !data.entries.length ? (
        <EmptyState
          art="scroll"
          title="Nothing has changed at this table yet — or nothing matches those filters."
        />
      ) : null}
      {data?.entries.length ? (
        <ol
          className="flex min-h-0 flex-1 flex-col divide-y divide-line/60 overflow-y-auto rounded-[var(--radius-control)] border border-line"
          aria-label="History"
        >
          {(data?.entries ?? []).map((e) => (
            <li
              key={e.id}
              className="flex items-center gap-2 px-3 py-2"
              data-testid="history-row"
              data-entry={e.id}
              data-type={e.type}
              data-undone={e.undoneAt !== null}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={`text-14 ${e.undoneAt !== null ? "text-fog line-through" : "text-bone"}`}>
                  {e.summary}
                </span>
                <span className="truncate text-12 text-muted">
                  {e.userName}
                  {e.actingAs ? <span className="text-brass"> as {e.actingAs}</span> : null}
                  {e.sceneName ? ` · ${e.sceneName}` : ""} · {ago(e.at)}
                  {e.undoneAt !== null ? ` · undone${e.undoneByName ? ` by ${e.undoneByName}` : ""}` : ""}
                </span>
              </span>
              {e.undoable && e.undoneAt === null ? (
                <>
                  <Button
                    size="S"
                    variant="ghost"
                    icon={<RotateCcw size={14} />}
                    onClick={() => act(revert(e), "Couldn't revert it")}
                  >
                    Revert
                  </Button>
                  <Menu
                    label={`More for “${e.summary}”`}
                    items={[
                      { label: "Restore to here…", onSelect: () => act(restore(e), "Couldn't restore") },
                    ]}
                  />
                </>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {data?.more ? (
        <Button
          size="S"
          variant="secondary"
          className="self-center"
          onClick={() => void load(data.entries.at(-1)?.id)}
        >
          Older
        </Button>
      ) : null}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.mode === "restore" ? "Restore to here?" : "Revert over later changes?"}
        description={
          confirm?.mode === "restore"
            ? `Every change after “${confirm.entry.summary}” is reverted, newest first:`
            : confirm
              ? `“${confirm.entry.summary}” — these later changes touched the same things; reverting sets them back anyway:`
              : undefined
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => act(go(), "Couldn't do it")}>
              {confirm?.mode === "restore"
                ? `Revert ${confirm.plan.changes.length} ${confirm.plan.changes.length === 1 ? "change" : "changes"}`
                : "Revert anyway"}
            </Button>
          </div>
        }
      >
        <ul className="flex flex-col gap-1 text-14" data-testid="history-confirm">
          {(confirm?.mode === "restore" ? confirm.plan.changes : (confirm?.plan.conflicts ?? [])).map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-bone">{c.summary}</span>
              <span className="text-12 text-muted">
                {c.userName} · {ago(c.at)}
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
