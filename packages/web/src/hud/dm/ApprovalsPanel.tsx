import { Suspense, useEffect, useState } from "react";
import { assetUrl } from "../../net/assets.ts";
import { request } from "../../net/table.ts";
import { type AssetItem, useLibrary } from "../../state/library.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { lazyPage } from "../../ui/lazyPage.ts";
import { toast } from "../../ui/Toast.tsx";
import { useAssetImage } from "../useAssetImage.ts";

const ModelPreview = lazyPage(() => import("./ModelPreview.tsx"));

const PURPOSE: Record<AssetItem["purpose"], string> = {
  map: "Map",
  mini: "3D mini",
  token: "Token art",
  portrait: "Portrait",
  art: "Character drawing",
  handout: "Handout",
  audio: "Audio",
};

function kb(bytes: number): string {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Pending({ a, open, onOpen }: { a: AssetItem; open: boolean; onOpen: () => void }) {
  const img = useAssetImage(a.cls === "image" ? a.id : null, 512);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    try {
      await request("asset.review", { assetIds: [a.id], decision });
    } catch (e) {
      toast.danger("Couldn't do that", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const stats = [
    PURPOSE[a.purpose],
    kb(a.bytes),
    a.width && a.height ? `${a.width} × ${a.height} px` : null,
    a.glb ? `${a.glb.triangles.toLocaleString("en")} triangles` : null,
    a.glb ? `${a.glb.textures} texture${a.glb.textures === 1 ? "" : "s"}` : null,
    a.glb?.animations.length ? `animations: ${a.glb.animations.join(", ")}` : null,
  ].filter(Boolean);
  return (
    <li
      className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-line p-3"
      data-pending={a.name}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-14 font-bold text-bone">{a.name}</p>
        <span className="shrink-0 text-12 text-fog">from {a.uploaderName}</span>
      </div>
      {a.cls === "image" ? (
        img ? (
          <img
            src={img}
            alt={`Upload preview: ${a.name}`}
            className="max-h-56 w-full rounded-[4px] bg-ink-950 object-contain"
          />
        ) : null
      ) : a.cls === "model" ? (
        open ? (
          <Suspense fallback={<div className="h-48 rounded-[var(--radius-control)] bg-ink-950" />}>
            <ModelPreview assetId={a.id} />
          </Suspense>
        ) : (
          <Button size="S" variant="secondary" onClick={onOpen}>
            Show 3D preview
          </Button>
        )
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: user-uploaded music has no captions
        <audio controls preload="none" src={assetUrl(a.id, "orig")} className="w-full" />
      )}
      <p className="text-12 text-muted">{stats.join(" · ")}</p>
      <div className="flex gap-2">
        <Button
          size="S"
          variant="primary"
          loading={busy === "approve"}
          onClick={() => void decide("approve")}
        >
          Approve
        </Button>
        <Button size="S" variant="danger" loading={busy === "reject"} onClick={() => void decide("reject")}>
          Reject
        </Button>
      </div>
    </li>
  );
}

/** The Approvals inbox (SPEC §8.16): players' uploads wait here; approving is not undoable (AC-UNDO-05). */
export function ApprovalsPanel() {
  const all = useLibrary((s) => s.assets);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void request<AssetItem[]>("asset.list", { status: "pending" }).then(
      (l) => useLibrary.getState().upsert(l),
      () => {},
    );
  }, []);
  const pending = [...all.values()]
    .filter((a) => a.status === "pending" && !a.deleted)
    .sort((x, y) => x.createdAt - y.createdAt);
  return pending.length === 0 ? (
    <EmptyState art="door" title="Nothing waiting. Players' uploads appear here for you to approve." />
  ) : (
    <ul
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      aria-label="Uploads waiting for approval"
    >
      {pending.map((a) => (
        <Pending key={a.id} a={a} open={open === a.id} onOpen={() => setOpen(a.id)} />
      ))}
    </ul>
  );
}
