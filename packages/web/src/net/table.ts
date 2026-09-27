import { Callbacks, type Room } from "@colyseus/sdk";
import type { KnockCard } from "@gloam/shared/protocol";
import { CampaignSettings, DEFAULT_HOUSE_RULES, HouseRules } from "@gloam/shared/schemas";
import type { PrepPatch, PrepSnapshot } from "@gloam/shared/state";
import { Table, type TableState } from "@gloam/shared/state";
import { create } from "zustand";
import { startMoveAnim } from "../board/move/anims.ts";
import { clearRemotePreview, onRemotePreview } from "../board/move/remote.ts";
import { useEntities } from "../state/entities.ts";
import { type AssetItem, type AssetRender, type SceneListItem, useLibrary } from "../state/library.ts";
import { useUi } from "../state/ui.ts";
import { provideTestHook } from "../test/hooks.ts";
import { preloadAssets } from "./assets.ts";
import { colyseus, leaveRoom, rejectionMessage } from "./colyseus.ts";
import { resetSync, syncLive } from "./sync.ts";
import { type UploadPurpose, uploadAsset } from "./upload.ts";

export interface PresenceView {
  userId: string;
  name: string;
  color: string;
  role: string;
  online: boolean;
  handRaised: boolean;
  spectator: boolean;
}

export type Connection = "connecting" | "open" | "dropped" | "closed";

interface TableStore {
  room: Room<unknown, TableState> | null;
  connection: Connection;
  me: { userId: string; role: "admin" | "dm" | "player" | "spectator"; name: string; color: string } | null;
  campaignId: string | null;
  campaignName: string;
  units: "ft" | "m";
  /** The campaign's house rules (SPEC §19.6) — the movement preview needs the squeeze factor, for one. */
  houseRules: HouseRules;
  /** Campaign settings that aren't rules (auto-facing, idle animations…). */
  campaignSettings: CampaignSettings;
  sessionNo: number;
  presence: PresenceView[];
  knocks: KnockCard[];
  set(p: Partial<TableStore>): void;
}

/** Live table connection state (SPEC §23.2 `entities`/`session` subset for Phase 1). */
export const useTable = create<TableStore>((set) => ({
  room: null,
  connection: "connecting",
  me: null,
  campaignId: null,
  campaignName: "",
  units: "ft",
  houseRules: DEFAULT_HOUSE_RULES,
  campaignSettings: CampaignSettings.parse({}),
  sessionNo: 0,
  presence: [],
  knocks: [],
  set: (p) => set(p),
}));

/** The synced house-rules JSON, validated (defaults for anything missing or malformed). */
function parseHouseRules(json: string): HouseRules {
  try {
    const r = HouseRules.safeParse(JSON.parse(json || "{}"));
    return r.success ? r.data : DEFAULT_HOUSE_RULES;
  } catch {
    return DEFAULT_HOUSE_RULES;
  }
}

function parseCampaignSettings(json: string): CampaignSettings {
  try {
    const r = CampaignSettings.safeParse(JSON.parse(json || "{}"));
    return r.success ? r.data : CampaignSettings.parse({});
  } catch {
    return CampaignSettings.parse({});
  }
}

/** One-shot table events the UI reacts to (navigation, toasts, knock cards). */
export interface TableEventMap {
  kicked: { message: string };
  banned: { message: string };
  closing: Record<string, never>;
  knock: KnockCard;
  "knock.resolved": { sessionId: string; decision: string };
  toast: { kind: string; message: string };
  "hand.raised": { userId: string; name: string };
  left: { code: number };
  message: { type: string; payload: unknown };
  "asset.pending": AssetItem;
  spotlight: { x: number; y: number; by: string };
}
type EventName = keyof TableEventMap;
type Listener<K extends EventName> = (payload: TableEventMap[K]) => void;

/**
 * Table events with a replay buffer: the connection starts before the table screen mounts (during the waiting
 * room's dissolve, AC-AUTH-03), so an event emitted while nobody listens is kept and delivered to the first
 * listener of its type. Bounded, so an unobserved type can't grow without limit.
 */
class TableEventBus {
  private listeners = new Map<EventName, Set<Listener<EventName>>>();
  private pending: { type: EventName; payload: unknown }[] = [];

  on<K extends EventName>(type: K, fn: Listener<K>): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn as Listener<EventName>);
    this.listeners.set(type, set);
    const replay = this.pending.filter((e) => e.type === type);
    this.pending = this.pending.filter((e) => e.type !== type);
    for (const e of replay) fn(e.payload as TableEventMap[K]);
    return () => set.delete(fn as Listener<EventName>);
  }

  emit<K extends EventName>(type: K, payload: TableEventMap[K]): void {
    const set = this.listeners.get(type);
    if (set?.size) for (const fn of [...set]) fn(payload);
    else {
      this.pending.push({ type, payload });
      if (this.pending.length > 100) this.pending.shift();
    }
  }

  reset(): void {
    this.pending = [];
  }
}
export const tableEvents = new TableEventBus();

let current: { campaignId: string; joining: Promise<Room<unknown, TableState>> } | null = null;

/**
 * Joins the table room with the shared `Table` schema (SPEC §13.6), mirrors presence and campaign fields into the
 * store and forwards one-shot messages to `tableEvents` — all wired at join time, so nothing sent on join (the
 * `welcome`, pending knocks) is dropped. Idempotent per campaign: the waiting room starts the connection during
 * its dissolve and the table screen picks up the same one. Reconnection: the SDK retries within the server's
 * 60-s window; the UI shows the reconnecting banner meanwhile.
 */
export function connectTable(campaignId: string): Promise<Room<unknown, TableState>> {
  if (current?.campaignId === campaignId) return current.joining;
  disconnectTable();
  const joining = join(campaignId);
  const entry = { campaignId, joining };
  current = entry;
  // A failed join must not be reused by the next caller.
  joining.catch(() => {
    if (current === entry) current = null;
  });
  return joining;
}

/** Leaves the table room (if any) and clears the table state. */
export function disconnectTable(): void {
  const prev = current;
  current = null;
  tableEvents.reset();
  if (prev) void prev.joining.then((room) => leaveRoom(room)).catch(() => {});
  useTable.getState().set({ room: null, me: null, presence: [], knocks: [], connection: "connecting" });
  resetSync();
}

async function join(campaignId: string): Promise<Room<unknown, TableState>> {
  useTable.getState().set({ connection: "connecting", campaignId });
  resetSync();
  const room = (await colyseus().joinById(campaignId, {}, Table)) as unknown as Room<unknown, TableState>;
  // Board data: one store write per server patch (SPEC §13.6).
  room.onStateChange((state) => {
    syncLive(state as TableState);
    // Everyone travelled to the scene this DM was preparing: the server dropped the prep subscription (§13.7).
    const prep = useEntities.getState().prep;
    if (prep && prep.scene?.id === (state as TableState).scene?.id) {
      useEntities.getState().setPrep(null);
      useUi.getState().set({ prepSceneId: null });
    }
  });
  syncLive(room.state);
  room.onMessage("prep.patch", (p: PrepPatch) => useEntities.getState().applyPrepPatch(p));
  room.onMessage("scene.list", (list: SceneListItem[]) => useLibrary.getState().setScenes(list));
  room.onMessage("asset.changed", (m: { asset: AssetItem }) => useLibrary.getState().upsert([m.asset]));
  // Players: an approved asset's render view changed (e.g. a mini's overrides) — every board redraws it.
  room.onMessage("asset.render", (m: { asset: AssetRender }) =>
    useLibrary.getState().upsertRenders([m.asset]),
  );
  room.onMessage("asset.pending", (m: { asset: AssetItem }) => {
    useLibrary.getState().upsert([m.asset]);
    tableEvents.emit("asset.pending", m.asset);
  });
  room.onMessage("scene.preload", (m: { assetIds: string[] }) => preloadAssets(m.assetIds));
  room.onMessage("camera.spotlight", (m: { x: number; y: number; by: string }) =>
    tableEvents.emit("spotlight", m),
  );
  const cb = Callbacks.get<TableState>(room as never);
  const presence = new Map<string, PresenceView>();
  const push = () =>
    useTable
      .getState()
      .set({ presence: [...presence.values()].sort((a, b) => a.name.localeCompare(b.name)) });
  cb.onAdd("presence", (p, key) => {
    const snap = () => {
      presence.set(key as string, {
        userId: p.userId,
        name: p.name,
        color: p.color,
        role: p.role,
        online: p.online,
        handRaised: p.handRaised,
        spectator: p.spectator,
      });
      push();
    };
    snap();
    cb.onChange(p, snap);
  });
  cb.onRemove("presence", (_p, key) => {
    presence.delete(key as string);
    push();
  });
  const syncCampaign = () =>
    useTable.getState().set({
      campaignName: room.state.campaignName,
      units: (room.state.units as "ft" | "m") || "ft",
      houseRules: parseHouseRules(room.state.houseRulesJson),
      campaignSettings: parseCampaignSettings(room.state.settingsJson),
      sessionNo: room.state.sessionNo,
    });
  cb.listen("campaignName", syncCampaign);
  cb.listen("units", syncCampaign);
  cb.listen("houseRulesJson", syncCampaign);
  cb.listen("settingsJson", syncCampaign);
  cb.listen("sessionNo", syncCampaign);

  room.onMessage(
    "welcome",
    (w: { userId: string; role: "admin" | "dm" | "player" | "spectator"; name: string; color: string }) => {
      useTable
        .getState()
        .set({ me: { userId: w.userId, role: w.role, name: w.name, color: w.color }, connection: "open" });
    },
  );
  room.onMessage("knocks", (list: KnockCard[]) => useTable.getState().set({ knocks: list }));
  room.onMessage("knock", (k: KnockCard) => {
    const cur = useTable.getState().knocks.filter((x) => x.sessionId !== k.sessionId);
    useTable.getState().set({ knocks: [...cur, k] });
    tableEvents.emit("knock", k);
  });
  room.onMessage("knock.resolved", (r: { sessionId: string; decision: string }) => {
    useTable
      .getState()
      .set({ knocks: useTable.getState().knocks.filter((x) => x.sessionId !== r.sessionId) });
    tableEvents.emit("knock.resolved", r);
  });
  room.onMessage("kicked", (m: { message: string }) => tableEvents.emit("kicked", m));
  room.onMessage("banned", (m: { message: string }) => tableEvents.emit("banned", m));
  room.onMessage("table.closing", () => tableEvents.emit("closing", {}));
  room.onMessage("toast", (t: { kind: string; message: string }) => tableEvents.emit("toast", t));
  // Movement (SPEC §8.6): committed moves glide along their path; others' drags show as ghosts.
  room.onMessage("token.moved", (m: { id: string; path: { x: number; y: number }[]; durationMs: number }) => {
    clearRemotePreview(m.id);
    startMoveAnim(m.id, m.path, m.durationMs);
  });
  room.onMessage(
    "move.preview",
    (m: { tokenId: string; points: { x: number; y: number }[]; cost: number; color: string; by: string }) =>
      onRemotePreview(m),
  );
  room.onMessage("hand.raised", (p: { userId: string; name: string }) => tableEvents.emit("hand.raised", p));
  room.onMessage("*", (type, payload) => tableEvents.emit("message", { type: String(type), payload }));
  room.onDrop(() => useTable.getState().set({ connection: "dropped" }));
  room.onReconnect(() => useTable.getState().set({ connection: "open" }));
  room.onLeave((code) => {
    if (current?.campaignId === campaignId) current = null;
    useTable.getState().set({ connection: "closed", room: null });
    tableEvents.emit("left", { code });
  });
  useTable.getState().set({ room });
  // Test builds only (SPEC §23.7): journeys drive commands through the same room and permissions as the UI.
  provideTestHook("request", (type: string, payload: unknown) => request(type, payload));
  provideTestHook("me", () => useTable.getState().me);
  provideTestHook("connection", () => useTable.getState().connection);
  // Uploads through the real client path (CSRF, progress, server pipeline) with bytes handed in by the test.
  provideTestHook("upload", async (b64: string, name: string, purpose: UploadPurpose) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return uploadAsset(new File([bytes], name), purpose);
  });
  return room;
}

/** Typed request with friendly errors (SPEC §23.3). */
export async function request<T = unknown>(type: string, payload: unknown = {}): Promise<T> {
  const room = useTable.getState().room;
  if (!room) throw new Error("Not connected to the table.");
  try {
    return (await room.request(type, payload, { timeout: 8000 })) as T;
  } catch (err) {
    const r = rejectionMessage(err);
    throw Object.assign(new Error(r.message), { code: r.code });
  }
}

/** Fire-and-forget message (drag previews, pings): dropped silently when not connected. */
export function send(type: string, payload: unknown): void {
  const room = useTable.getState().room;
  if (room && useTable.getState().connection === "open") room.send(type, payload);
}

/**
 * Resolves once the table connection for `campaignId` is joined and its `welcome` has arrived (the table screen can
 * render without a loader), or after `timeoutMs` either way — the table screen handles a slow or failed join.
 */
export async function tableReady(campaignId: string, timeoutMs: number): Promise<void> {
  const joined = connectTable(campaignId).then(
    () =>
      new Promise<void>((resolve) => {
        if (useTable.getState().me) return resolve();
        const off = useTable.subscribe((s) => {
          if (s.me) {
            off();
            resolve();
          }
        });
      }),
  );
  await Promise.race([joined.catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))]);
}

/**
 * DM prep view (SPEC §13.7): subscribe to a non-active scene and load its snapshot; `null` returns to the live scene.
 * Opening the active scene simply shows it live (the server answers null).
 */
export async function openPrep(sceneId: string | null): Promise<void> {
  const ui = useUi.getState();
  if (!sceneId) {
    if (ui.prepSceneId) await request("prep.close", {}).catch(() => {});
    useEntities.getState().setPrep(null);
    ui.set({ prepSceneId: null, selection: [] });
    return;
  }
  const snap = await request<PrepSnapshot | null>("prep.open", { sceneId });
  useEntities.getState().setPrep(snap);
  ui.set({ prepSceneId: snap ? sceneId : null, selection: [] });
}

/** Keeps the scene list fresh for the DM panel. */
export async function refreshScenes(): Promise<void> {
  useLibrary.getState().setScenes(await request<SceneListItem[]>("scene.list", {}));
}
