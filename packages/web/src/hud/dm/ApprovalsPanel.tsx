import type { KnockCard } from "@gloam/shared/protocol";
import { Suspense, useEffect, useMemo, useState } from "react";
import { assetUrl } from "../../net/assets.ts";
import { pendingProposals, useSheets } from "../../net/sheets.ts";
import { decideHomebrew, useSpells } from "../../net/spells.ts";
import { request, useTable } from "../../net/table.ts";
import { type AssetItem, useLibrary } from "../../state/library.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { lazyPage } from "../../ui/lazyPage.ts";
import { toast } from "../../ui/Toast.tsx";
import { IDENTITY_TEXT, waited } from "../KnockCards.tsx";
import { useAssetImage } from "../useAssetImage.ts";
import { SheetProposals } from "./SheetProposals.tsx";

export { useApprovalsCount } from "./approvalsCount.ts";

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
            className="max-h-56 w-full rounded-chip bg-ink-950 object-contain"
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

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

/** A knock at the door (§8.2), as on its card: who, how they're known, how long they've waited. */
function Knock({ k, admin }: { k: KnockCard; admin: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const decide = (decision: "admitPlayer" | "admitSpectator" | "deny" | "ban") =>
    act(request("lobby.decide", { sessionId: k.sessionId, decision }), "Couldn't do that");
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5" data-testid="approval-knock">
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: k.color }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-14 font-bold text-bone">{k.name} is knocking</span>
        <span className="tabular text-12 text-muted">{waited(k.knockedAt, now)}</span>
      </span>
      <span className="text-12 text-muted">
        <span className={k.identity === "unverified" ? "text-[var(--ember-400)]" : ""}>
          {IDENTITY_TEXT[k.identity]}
        </span>
        {" · "}
        {k.deviceLabel}
      </span>
      <span className="flex flex-wrap gap-1.5">
        <Button size="S" variant="primary" onClick={() => decide("admitPlayer")}>
          Admit
        </Button>
        <Button size="S" variant="secondary" onClick={() => decide("admitSpectator")}>
          As spectator
        </Button>
        <Button size="S" variant="ghost" onClick={() => decide("deny")}>
          Deny
        </Button>
        {admin ? (
          <Button size="S" variant="danger" onClick={() => decide("ban")}>
            Ban
          </Button>
        ) : null}
      </span>
    </li>
  );
}

/**
 * The Approvals inbox (SPEC §8.16, §8.19; AC-DMP-04): knocks at the door, players' uploads, their proposed sheet
 * changes (§8.10) and proposed homebrew spells (§8.13) — each decided here; approving an upload is not undoable
 * (AC-UNDO-05).
 */
export function ApprovalsPanel() {
  const proposals = useSheets(pendingProposals);
  const knocks = useTable((s) => s.knocks);
  const admin = useTable((s) => s.me?.role === "admin");
  // (The whole list from the store, filtered here: a selector returning a new array each time re-rendered forever.)
  const allHomebrew = useSpells((s) => s.homebrew);
  const homebrew = useMemo(() => allHomebrew.filter((h) => h.status === "proposed"), [allHomebrew]);
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
  const kinds = [knocks.length, pending.length, proposals, homebrew.length].filter((n) => n > 0).length;
  return pending.length === 0 && proposals === 0 && knocks.length === 0 && homebrew.length === 0 ? (
    <EmptyState
      art="door"
      title="Nothing waiting. Knocks at the door, players' uploads, proposed sheet changes and homebrew spells appear here for you to decide."
    />
  ) : (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-clip px-3 py-3"
      data-testid="approvals-panel"
    >
      {knocks.length ? (
        <section className="flex flex-col gap-2" aria-label="At the door">
          <h3 className="caps text-12 text-muted">At the door</h3>
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {knocks.map((k) => (
              <Knock key={k.sessionId} k={k} admin={admin} />
            ))}
          </ul>
        </section>
      ) : null}
      <SheetProposals />
      {homebrew.length ? (
        <section className="flex flex-col gap-2" aria-label="Proposed spells">
          <h3 className="caps text-12 text-muted">Proposed spells</h3>
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {homebrew.map((h) => (
              <li key={h.id} className="flex items-center gap-2 px-3 py-2" data-testid="approval-homebrew">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-14 text-bone">{h.spell.name}</span>
                  <span className="truncate text-12 text-muted">
                    {h.spell.level === 0 ? "Cantrip" : `Level ${h.spell.level}`}
                    {h.createdByName ? ` · from ${h.createdByName}` : ""}
                  </span>
                </span>
                <Button
                  size="S"
                  variant="ghost"
                  onClick={() => useUi.getState().set({ dmSection: "spells" })}
                >
                  Open
                </Button>
                <Button
                  size="S"
                  variant="ghost"
                  onClick={() => act(decideHomebrew(h.id, false), "Couldn't reject it")}
                >
                  Reject
                </Button>
                <Button
                  size="S"
                  variant="primary"
                  onClick={() => act(decideHomebrew(h.id, true), "Couldn't approve it")}
                >
                  Approve
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {pending.length ? (
        <section className="flex flex-col gap-2">
          {kinds > 1 ? <h3 className="caps text-12 text-muted">Uploads</h3> : null}
          <ul className="flex flex-col gap-2" aria-label="Uploads waiting for approval">
            {pending.map((a) => (
              <Pending key={a.id} a={a} open={open === a.id} onOpen={() => setOpen(a.id)} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
