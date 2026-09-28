import { ImagePlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { request } from "../../net/table.ts";
import { type AssetItem, useLibrary } from "../../state/library.ts";
import { toast } from "../../ui/Toast.tsx";
import { UploadZone } from "../dm/UploadZone.tsx";
import { useAssetImage } from "../useAssetImage.ts";

/**
 * Choosing an image for a sheet (a portrait, token art, an image block): the pictures this person may use — a
 * player's own uploads, a DM's whole library — or a new upload. A player's upload waits for the DM's approval before
 * it can be used (SPEC §21.1); it's listed, marked, and not yet choosable.
 */
export function AssetPicker({
  value,
  onChange,
  label,
  purpose,
}: {
  value: string | undefined;
  onChange: (assetId: string | undefined) => void;
  label: string;
  purpose: "portrait" | "token" | "art";
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AssetItem[] | null>(null);
  const current = useAssetImage(value, 96);
  // An upload's approval (or rejection) arrives while the picker is open: the library store has the news.
  const live = useLibrary((s) => s.assets);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void request<AssetItem[]>("asset.list", {})
      .then((list) => {
        if (!cancelled)
          setItems(list.filter((a) => a.cls === "image" && !a.deleted && a.status !== "rejected"));
      })
      .catch((e) => toast.danger("Couldn't load your images", (e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [open]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${label}: ${value ? "change" : "choose"}`}
          onClick={() => setOpen((o) => !o)}
          className="grid h-16 w-16 place-items-center overflow-hidden rounded-[var(--radius-control)] border border-dashed border-paper-muted bg-parchment-deep/50 text-paper-muted hover:border-wax hover:text-wax"
        >
          {current ? (
            <img src={current} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus size={20} />
          )}
        </button>
        <span className="text-13 text-paper-muted">{label}</span>
        {value ? (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => onChange(undefined)}
            className="text-paper-muted hover:text-wax"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="panel flex flex-col gap-2 p-2" data-testid="asset-picker">
          {items === null ? <p className="text-13 text-muted">Loading…</p> : null}
          {items?.length === 0 ? <p className="text-13 text-muted">No images yet — upload one.</p> : null}
          <div className="grid grid-cols-4 gap-1.5">
            {items
              ?.map((a) => live.get(a.id) ?? a)
              .filter((a) => !a.deleted && a.status !== "rejected")
              .map((a) => (
                <PickerItem
                  key={a.id}
                  item={a}
                  chosen={a.id === value}
                  onPick={() => {
                    onChange(a.id);
                    setOpen(false);
                  }}
                />
              ))}
          </div>
          <UploadZone
            purpose={purpose}
            hint="PNG, JPEG or WebP — drop it here or pick a file"
            accept="image/png,image/jpeg,image/webp"
            onUploaded={(a) => {
              setItems((list) => [a, ...(list ?? [])]);
              if (a.status === "approved") {
                onChange(a.id);
                setOpen(false);
              } else toast.info("Sent to the DM", "It can be used once they approve it.");
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function PickerItem({ item, chosen, onPick }: { item: AssetItem; chosen: boolean; onPick: () => void }) {
  const src = useAssetImage(item.id, 96);
  const waiting = item.status !== "approved";
  return (
    <button
      type="button"
      disabled={waiting}
      title={waiting ? `${item.name} — waiting for the DM` : item.name}
      aria-label={waiting ? `${item.name} (waiting for approval)` : item.name}
      aria-pressed={chosen}
      onClick={onPick}
      className={`relative aspect-square overflow-hidden rounded-chip border ${chosen ? "border-brass" : "border-line"} bg-ink-900 disabled:opacity-50`}
    >
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : null}
      {waiting ? (
        <span className="caps absolute inset-x-0 bottom-0 bg-ink-950/80 text-12 text-muted">waiting</span>
      ) : null}
    </button>
  );
}
