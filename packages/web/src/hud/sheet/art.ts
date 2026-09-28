/**
 * Character art (SPEC §8.10 Character art): a picture put on a character — its portrait, or its token art (drawn as a
 * standee or a coin, its tokens here take that look). A player's new picture waits for the DM's approval (§21.1);
 * what it was made for is remembered on this device and done the moment it's approved, even after a reload.
 */
import type { ActorView } from "@gloam/shared/protocol";
import { useSheets } from "../../net/sheets.ts";
import { request, useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { type AssetItem, useLibrary } from "../../state/library.ts";
import { toast } from "../../ui/Toast.tsx";
import { editSheet } from "./sheetActions.ts";

export type ArtUse = "portrait" | "token" | "standee" | "coin";

const WORD: Record<ArtUse, string> = {
  portrait: "portrait",
  token: "token",
  standee: "standee",
  coin: "coin",
};

/** Puts the picture on the character. False when the sheet refused it (a lock sends it to the DM instead). */
export async function applyArt(actor: ActorView, assetId: string, as: ArtUse): Promise<boolean> {
  const ok = await editSheet(actor, [
    { path: ["core", as === "portrait" ? "portraitAssetId" : "tokenAssetId"], after: assetId },
  ]);
  if (!ok || as === "portrait" || as === "token") return ok;
  for (const t of boardData(useEntities.getState()).tokens.values())
    if (t.actorId === actor.id)
      void request("token.update", { tokenId: t.id, appearance: { mode: as } }).catch(() => {});
  return true;
}

interface Waiting {
  userId: string;
  assetId: string;
  actorId: string;
  as: ArtUse;
}
const KEY = "gloam.pendingArt";
let waiting: Waiting[] | null = null;

function list(): Waiting[] {
  if (waiting) return waiting;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    waiting = Array.isArray(raw) ? (raw as Waiting[]).filter((w) => w && typeof w.assetId === "string") : [];
  } catch {
    waiting = [];
  }
  return waiting;
}
function keep(next: Waiting[]): void {
  waiting = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows: remembered for this page only.
  }
}

/** Remembers what a picture waiting for approval is for. */
export function awaitApproval(actorId: string, assetId: string, as: ArtUse): void {
  const userId = useTable.getState().me?.userId;
  if (!userId) return;
  keep([...list().filter((w) => w.assetId !== assetId), { userId, assetId, actorId, as }]);
}

/** A picture's fate: whenever it's decided, it's done or dropped. */
function settle(): void {
  const me = useTable.getState().me?.userId;
  const mine = list().filter((w) => w.userId === me);
  if (!mine.length) return;
  const assets = useLibrary.getState().assets;
  const actors = useSheets.getState().actors;
  const done = new Set<string>();
  for (const w of mine) {
    const a: AssetItem | undefined = assets.get(w.assetId);
    if (!a) continue;
    if (a.status === "approved" && !a.deleted) {
      const actor = actors.get(w.actorId);
      if (!actor) continue;
      done.add(w.assetId);
      void applyArt(actor, w.assetId, w.as).then(
        (ok) =>
          ok && toast.success(`The DM approved your ${WORD[w.as]}`, `It's on ${actor.sheet.core.name} now.`),
      );
    } else if (a.status === "rejected" || a.deleted) {
      done.add(w.assetId);
      toast.warning(`The DM didn't approve your ${WORD[w.as]}`);
    }
  }
  if (done.size) keep(list().filter((w) => !done.has(w.assetId)));
}

/** Starts applying approved pictures (once per page): as the news arrives, and on each connection. */
export function watchPendingArt(): () => void {
  const offLib = useLibrary.subscribe(settle);
  const offSheets = useSheets.subscribe((s, prev) => {
    if (s.actors !== prev.actors) settle();
  });
  let room: unknown = null;
  const offTable = useTable.subscribe((t) => {
    if (t.room === room) return;
    room = t.room;
    const me = t.me?.userId;
    // Decided while this page was away: the statuses come with the uploads list.
    if (t.room && list().some((w) => w.userId === me))
      void request<AssetItem[]>("asset.list", {}).then(
        (items) => useLibrary.getState().upsert(items),
        () => {},
      );
  });
  return () => {
    offLib();
    offSheets();
    offTable();
  };
}
