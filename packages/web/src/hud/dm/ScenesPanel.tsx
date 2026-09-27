import {
  Archive,
  Box,
  Copy,
  DownloadCloud,
  Eye,
  GripVertical,
  Map as MapIcon,
  Ruler,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { openPrep, refreshScenes, request } from "../../net/table.ts";
import { type SceneListItem, useLibrary } from "../../state/library.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { toast, useToasts } from "../../ui/Toast.tsx";
import { useAssetImage } from "../useAssetImage.ts";
import { CalibrationDialog } from "./CalibrationDialog.tsx";

const KIND_LABEL: Record<SceneListItem["mapKind"], string> = {
  image: "Image map",
  model: "3D map",
  procedural: "Procedural floor",
  blank: "Blank table",
};

async function act(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    toast.danger(`Couldn't ${what}`, (e as Error).message);
  }
}

function Thumb({ s }: { s: SceneListItem }) {
  const src = useAssetImage(s.mapKind === "image" ? s.mapAssetId : null, 256);
  if (src)
    return (
      <img src={src} alt="" className="h-11 w-16 shrink-0 rounded-chip border border-line object-cover" />
    );
  return (
    <span className="grid h-11 w-16 shrink-0 place-items-center rounded-chip border border-line bg-ink-900 text-brass">
      {s.mapKind === "model" ? <Box size={18} /> : <MapIcon size={18} />}
    </span>
  );
}

/**
 * Scenes (SPEC §8.3 DM scene tools): list with thumbnails and drag-to-reorder, New scene wizard, open in prep view,
 * activate for players, preload, duplicate, recalibrate / align, archive, delete (soft, undoable).
 */
export function ScenesPanel() {
  const scenes = useLibrary((s) => s.scenes);
  const prepId = useUi((s) => s.prepSceneId);
  const [calibrating, setCalibrating] = useState<SceneListItem | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    void refreshScenes().catch(() => {});
  }, []);

  const live = scenes.filter((s) => !s.archived && !s.deleted).sort((a, b) => a.sort - b.sort);
  const archived = scenes.filter((s) => s.archived && !s.deleted);
  const deleted = scenes.filter((s) => s.deleted);

  const reorder = (from: string, to: string) => {
    if (from === to) return;
    const ids = live.map((s) => s.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(to), 0, from);
    void act("reorder scenes", () => request("scene.reorder", { order: ids }));
  };

  const remove = (s: SceneListItem) =>
    act("delete the scene", async () => {
      if (prepId === s.id) await openPrep(null);
      await request("scene.delete", { sceneId: s.id });
      toastUndo(`Deleted ${s.name}`, () => request("scene.restore", { sceneId: s.id }));
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <p className="text-13 text-muted">
          {prepId ? "Preparing a scene only DMs can see." : "Players see the live scene."}
        </p>
        <Button size="S" variant="primary" onClick={() => useUi.getState().set({ sceneWizard: true })}>
          New scene
        </Button>
      </div>
      {live.length === 0 ? (
        <EmptyState
          art="map"
          title="No scenes yet. Start with a map image, a 3D map, or a procedural floor."
          action={
            <Button variant="primary" onClick={() => useUi.getState().set({ sceneWizard: true })}>
              Create the first scene
            </Button>
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Scenes">
          {live.map((s, i) => (
            <li
              key={s.id}
              draggable
              onDragStart={(e) => {
                setDragId(s.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragId) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) reorder(dragId, s.id);
                setDragId(null);
              }}
              onDragEnd={() => setDragId(null)}
              onKeyDown={(e) => {
                // Keyboard reordering: Alt+↑ / Alt+↓ on a focused row.
                if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                const j = e.key === "ArrowUp" ? i - 1 : i + 1;
                const other = live[j];
                if (!other) return;
                e.preventDefault();
                const ids = live.map((x) => x.id);
                ids.splice(i, 1);
                ids.splice(j, 0, s.id);
                void act("reorder scenes", () => request("scene.reorder", { order: ids }));
              }}
              data-scene={s.name}
              className={`group mb-1.5 rounded-[var(--radius-panel)] border px-2 py-2 transition-colors duration-[var(--dur-fast)] ${
                prepId === s.id
                  ? "border-[var(--brass-600)] bg-[var(--glow-brass-soft)]"
                  : "border-transparent hover:border-line hover:bg-raised"
              } ${dragId === s.id ? "opacity-50" : ""}`}
            >
              <div className="flex items-center gap-2.5">
                <span className="cursor-grab text-faint" aria-hidden title="Drag to reorder (or Alt+↑/↓)">
                  <GripVertical size={15} />
                </span>
                <Thumb s={s} />
                <div className="min-w-0 flex-1">
                  {renaming === s.id ? (
                    <input
                      // biome-ignore lint/a11y/noAutofocus: rename was just requested
                      autoFocus
                      aria-label="Scene name"
                      defaultValue={s.name}
                      maxLength={80}
                      className="h-8 w-full rounded-chip border border-brass bg-ink-900 px-2 text-14 text-bone"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setRenaming(null);
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        setRenaming(null);
                        if (name && name !== s.name)
                          void act("rename the scene", () =>
                            request("scene.update", { sceneId: s.id, name }),
                          );
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="block max-w-full truncate text-left text-14 font-bold text-bone"
                      title="Rename"
                      onDoubleClick={() => setRenaming(s.id)}
                      onClick={() => void act("open the scene", () => openPrep(s.active ? null : s.id))}
                    >
                      {s.name}
                    </button>
                  )}
                  {/* The state badge sits under the title with the details, so a narrow panel keeps the name. */}
                  <p className="flex min-w-0 items-center gap-1.5 text-12 text-fog">
                    {s.active ? (
                      <span className="caps shrink-0 rounded-chip bg-accent px-1.5 py-px text-12 text-ink-950">
                        Live
                      </span>
                    ) : prepId === s.id ? (
                      <span className="caps shrink-0 rounded-chip border border-[var(--brass-600)] px-1.5 py-px text-12 text-accent">
                        Prep
                      </span>
                    ) : null}
                    <span className="truncate">
                      {KIND_LABEL[s.mapKind]} · {s.tokenCount} token{s.tokenCount === 1 ? "" : "s"}
                    </span>
                  </p>
                </div>
                <Menu
                  label={`More for ${s.name}`}
                  items={[
                    ...(s.mapKind === "image"
                      ? [
                          {
                            label: "Recalibrate map",
                            icon: <Ruler size={15} />,
                            onSelect: () => setCalibrating(s),
                          },
                        ]
                      : []),
                    ...(s.mapKind === "model"
                      ? [
                          {
                            label: "Align 3D map",
                            icon: <Box size={15} />,
                            onSelect: () =>
                              void act("open the map tools", async () => {
                                if (!s.active) await openPrep(s.id);
                                useUi.getState().set({ mapTool: s.id });
                              }),
                          },
                        ]
                      : []),
                    {
                      label: "Preload for players",
                      icon: <DownloadCloud size={15} />,
                      onSelect: () =>
                        void act("preload", async () => {
                          const r = await request<{ count: number }>("scene.preload", { sceneId: s.id });
                          toast.info(
                            "Preloading",
                            `Everyone's browser is fetching ${r.count} file${r.count === 1 ? "" : "s"} for ${s.name}. Curious players could peek.`,
                          );
                        }),
                    },
                    {
                      label: "Duplicate",
                      icon: <Copy size={15} />,
                      onSelect: () =>
                        void act("duplicate", () => request("scene.duplicate", { sceneId: s.id })),
                    },
                    {
                      label: "Rename",
                      onSelect: () => setRenaming(s.id),
                    },
                    {
                      label: "Archive",
                      icon: <Archive size={15} />,
                      disabled: s.active,
                      hint: s.active ? "Activate another scene first" : undefined,
                      onSelect: () => void act("archive", () => request("scene.archive", { sceneId: s.id })),
                    },
                    {
                      label: "Delete",
                      icon: <Trash2 size={15} />,
                      danger: true,
                      disabled: s.active,
                      hint: s.active ? "Activate another scene first" : undefined,
                      onSelect: () => void remove(s),
                    },
                  ]}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-2 pl-7">
                {!s.active ? (
                  <>
                    <Button
                      size="S"
                      variant={prepId === s.id ? "secondary" : "ghost"}
                      icon={<Eye size={14} />}
                      onClick={() =>
                        void act("open the scene", () => openPrep(prepId === s.id ? null : s.id))
                      }
                    >
                      {prepId === s.id ? "Back to live" : "Open (only DMs)"}
                    </Button>
                    <Button
                      size="S"
                      variant="primary"
                      onClick={() =>
                        void act("activate the scene", async () => {
                          await request("scene.activate", { sceneId: s.id });
                          toast.success(`Travelling to ${s.name}`, "Everyone is moving to this scene.");
                        })
                      }
                    >
                      Activate for players
                    </Button>
                  </>
                ) : (
                  <span className="text-12 text-muted">Everyone is here.</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {archived.length ? (
        <details className="border-t border-line px-4 py-2">
          <summary className="caps cursor-pointer text-12 text-fog">Archived ({archived.length})</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {archived.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-14 text-muted">
                <span className="truncate">{s.name}</span>
                <Button
                  size="S"
                  variant="ghost"
                  onClick={() => void act("unarchive", () => request("scene.unarchive", { sceneId: s.id }))}
                >
                  Unarchive
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {deleted.length ? (
        <details className="border-t border-line px-4 py-2">
          <summary className="caps cursor-pointer text-12 text-fog">
            Recently deleted ({deleted.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {deleted.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-14 text-muted">
                <span className="truncate">{s.name}</span>
                <Button
                  size="S"
                  variant="ghost"
                  icon={<Undo2 size={14} />}
                  onClick={() => void act("restore", () => request("scene.restore", { sceneId: s.id }))}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {calibrating ? <CalibrationDialog scene={calibrating} onClose={() => setCalibrating(null)} /> : null}
    </div>
  );
}

/** A toast whose Undo runs the exact inverse (not the DM's latest action, which may be something else). */
export function toastUndo(title: string, undo: () => Promise<unknown>): void {
  useToasts.getState().push({
    kind: "info",
    title,
    body: "You can put it back.",
    actions: [
      {
        label: "Undo",
        onClick: () => void undo().catch((e) => toast.danger("Couldn't undo", (e as Error).message)),
      },
    ],
  });
}
