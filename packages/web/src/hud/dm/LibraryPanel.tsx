import { Box, Music, Plus, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { request } from "../../net/table.ts";
import type { UploadPurpose } from "../../net/upload.ts";
import { ASSET_DRAG_TYPE, type AssetDragPayload, type AssetItem, useLibrary } from "../../state/library.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented, Select } from "../../ui/controls.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { toast } from "../../ui/Toast.tsx";
import { useAssetImage } from "../useAssetImage.ts";
import { toastUndo } from "./ScenesPanel.tsx";
import { UploadZone } from "./UploadZone.tsx";

type Tab = "minis" | "tokens" | "maps" | "audio" | "handouts";
const TAB_PURPOSES: Record<Tab, AssetItem["purpose"][]> = {
  minis: ["mini"],
  tokens: ["token", "portrait", "art"],
  maps: ["map"],
  audio: ["audio"],
  handouts: ["handout"],
};
const TAB_UPLOAD: Record<Tab, UploadPurpose> = {
  minis: "mini",
  tokens: "token",
  maps: "map",
  audio: "audio",
  handouts: "handout",
};
const TAB_HINT: Record<Tab, string> = {
  minis: "Drop a .glb mini here. It's grounded, centred and scaled to its size automatically.",
  tokens: "Drop token or portrait art here (PNG, JPEG, WebP, GIF, AVIF).",
  maps: "Drop a map image or a .glb 3D map here.",
  audio: "Drop music or ambience here (MP3, OGG, WAV, M4A, FLAC).",
  handouts: "Drop a handout image here.",
};

async function act(what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    toast.danger(`Couldn't ${what}`, (e as Error).message);
  }
}

function Thumbnail({ a }: { a: AssetItem }) {
  const src = useAssetImage(a.cls === "image" ? a.id : null, 256);
  return (
    <span className="grid aspect-square w-full place-items-center overflow-hidden rounded-chip bg-ink-900 text-brass">
      {src ? (
        <img src={src} alt="" className="h-full w-full object-contain" draggable={false} />
      ) : a.cls === "model" ? (
        <Box size={26} aria-hidden />
      ) : (
        <Music size={26} aria-hidden />
      )}
    </span>
  );
}

function Card({ a }: { a: AssetItem }) {
  const [renaming, setRenaming] = useState(false);
  const [tagging, setTagging] = useState(false);
  const statusChip =
    a.status === "pending" ? (
      <span className="caps rounded-chip border border-[var(--brass-600)] px-1 text-12 text-accent">
        pending
      </span>
    ) : a.status === "rejected" ? (
      <span className="caps rounded-chip border border-[var(--blood-500)] px-1 text-12 text-[var(--blood-500)]">
        rejected
      </span>
    ) : null;
  return (
    <li
      className="group relative flex flex-col gap-1.5 rounded-[var(--radius-panel)] border border-line p-2 hover:border-[var(--brass-600)]"
      draggable={!a.deleted && a.status !== "rejected"}
      data-asset={a.name}
      onDragStart={(e) => {
        e.dataTransfer.setData(
          ASSET_DRAG_TYPE,
          JSON.stringify({
            id: a.id,
            purpose: a.purpose,
            cls: a.cls,
            name: a.name,
          } satisfies AssetDragPayload),
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <Thumbnail a={a} />
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: rename was just requested
              autoFocus
              aria-label="Name"
              defaultValue={a.name}
              maxLength={80}
              className="h-7 w-full rounded-chip border border-brass bg-ink-900 px-1.5 text-13 text-bone"
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenaming(false);
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              onBlur={(e) => {
                setRenaming(false);
                const name = e.target.value.trim();
                if (name && name !== a.name)
                  void act("rename", () => request("asset.update", { assetId: a.id, name }));
              }}
            />
          ) : (
            <p className="truncate text-13 font-bold text-bone" title={a.name}>
              {a.name}
            </p>
          )}
          <p className="truncate text-12 text-fog">
            {a.uploaderName} · used {a.usage ?? 0}×
          </p>
        </div>
        <Menu
          label={`More for ${a.name}`}
          items={
            a.deleted
              ? [
                  {
                    label: "Restore",
                    icon: <Undo2 size={15} />,
                    onSelect: () => void act("restore", () => request("asset.restore", { assetIds: [a.id] })),
                  },
                ]
              : [
                  { label: "Rename", onSelect: () => setRenaming(true) },
                  { label: "Add a tag", icon: <Plus size={15} />, onSelect: () => setTagging(true) },
                  {
                    label: "Delete",
                    icon: <Trash2 size={15} />,
                    danger: true,
                    onSelect: () =>
                      void act("delete", async () => {
                        await request("asset.delete", { assetIds: [a.id] });
                        toastUndo(`Deleted ${a.name} from the Library`, () =>
                          request("asset.restore", { assetIds: [a.id] }),
                        );
                      }),
                  },
                ]
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {statusChip}
        {a.tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-0.5 rounded-chip bg-raised px-1.5 text-12 text-muted"
          >
            {t}
            {!a.deleted ? (
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                className="text-faint hover:text-bone"
                onClick={() =>
                  void act("remove the tag", () =>
                    request("asset.update", { assetId: a.id, tags: a.tags.filter((x) => x !== t) }),
                  )
                }
              >
                <X size={11} />
              </button>
            ) : null}
          </span>
        ))}
        {tagging ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: tagging was just requested
            autoFocus
            aria-label="New tag"
            maxLength={32}
            placeholder="tag"
            className="h-6 w-20 rounded-chip border border-brass bg-ink-900 px-1 text-12 text-bone"
            onKeyDown={(e) => {
              if (e.key === "Escape") setTagging(false);
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => {
              setTagging(false);
              const t = e.target.value.trim().toLowerCase();
              if (t && !a.tags.includes(t))
                void act("add the tag", () =>
                  request("asset.update", { assetId: a.id, tags: [...a.tags, t] }),
                );
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * The Library (SPEC §8.16, AC-AST-06): tabs, search, filters by tag, uploader and status, editable names and tags,
 * drag onto the board to place a token (or start a scene from a map), soft delete with Undo and a trash view.
 */
export function LibraryPanel() {
  const all = useLibrary((s) => s.assets);
  const [tab, setTab] = useState<Tab>("tokens");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [uploader, setUploader] = useState("");
  const [status, setStatus] = useState<"" | AssetItem["status"]>("");
  const [trash, setTrash] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    void request<AssetItem[]>("asset.list", { tab: "all" }).then(
      (l) => useLibrary.getState().upsert(l),
      () => {},
    );
    void request<AssetItem[]>("asset.list", { tab: "all", trash: true }).then(
      (l) => useLibrary.getState().upsert(l),
      () => {},
    );
  }, []);

  const inTab = useMemo(
    () => [...all.values()].filter((a) => TAB_PURPOSES[tab].includes(a.purpose) && a.deleted === trash),
    [all, tab, trash],
  );
  const tags = [...new Set(inTab.flatMap((a) => a.tags))].sort();
  const uploaders = [...new Map(inTab.map((a) => [a.uploaderId, a.uploaderName])).entries()];
  const needle = q.trim().toLowerCase();
  const shown = inTab
    .filter(
      (a) =>
        (!tag || a.tags.includes(tag)) &&
        (!uploader || a.uploaderId === uploader) &&
        (!status || a.status === status),
    )
    .filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.tags.some((t) => t.includes(needle)))
    .sort((x, y) => y.createdAt - x.createdAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 px-3 py-3">
        <Segmented<Tab>
          label="Library section"
          size="S"
          value={tab}
          onChange={(t) => {
            setTab(t);
            setTag("");
          }}
          options={[
            { value: "minis", label: "Minis" },
            { value: "tokens", label: "Tokens" },
            { value: "maps", label: "Maps" },
            { value: "audio", label: "Audio" },
            { value: "handouts", label: "Handouts" },
          ]}
        />
        <div className="flex gap-2">
          <input
            type="search"
            aria-label="Search the Library"
            placeholder="Search names and tags"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-14 text-bone placeholder:text-faint focus:border-brass"
          />
          <Button
            size="S"
            variant={uploading ? "secondary" : "primary"}
            onClick={() => setUploading((u) => !u)}
          >
            {uploading ? "Close" : "Upload"}
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Select
            label="Tag"
            value={tag}
            onChange={setTag}
            options={[{ value: "", label: "Any" }, ...tags.map((t) => ({ value: t, label: t }))]}
          />
          <Select
            label="Uploaded by"
            value={uploader}
            onChange={setUploader}
            options={[
              { value: "", label: "Anyone" },
              ...uploaders.map(([id, name]) => ({ value: id, label: name })),
            ]}
          />
          <Select<"" | AssetItem["status"]>
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: "Any" },
              { value: "approved", label: "Approved" },
              { value: "pending", label: "Pending" },
              { value: "rejected", label: "Rejected" },
            ]}
          />
        </div>
        <label className="flex items-center gap-2 text-13 text-muted">
          <input
            type="checkbox"
            checked={trash}
            onChange={(e) => setTrash(e.target.checked)}
            className="accent-[var(--brass-400)]"
          />
          Show deleted items
        </label>
        {uploading ? (
          <UploadZone purpose={TAB_UPLOAD[tab]} hint={TAB_HINT[tab]} onUploaded={() => setUploading(false)} />
        ) : null}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          art="scroll"
          title={
            trash
              ? "Nothing deleted here."
              : needle || tag || uploader || status
                ? "Nothing matches those filters."
                : "Nothing here yet — upload something, then drag it onto the board."
          }
        />
      ) : (
        <ul
          className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto px-3 pb-3"
          aria-label="Library items"
        >
          {shown.map((a) => (
            <Card key={a.id} a={a} />
          ))}
        </ul>
      )}
    </div>
  );
}
