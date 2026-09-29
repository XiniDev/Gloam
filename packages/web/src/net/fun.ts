import type { EmoteId, EmoteMessage, HandoutView, LogEntryView } from "@gloam/shared/protocol";
import { create } from "zustand";
import { audio } from "../audio/engine.ts";
import { playOnBoard } from "../board/boardSound.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { provideTestHook } from "../test/hooks.ts";
import { request, tableEvents, useTable } from "./table.ts";

/** How long an emote shows (SPEC §8.18: 2.5 s), and how long it stays in the feed. */
export const EMOTE_MS = 2500;
const FEED_MS = 8000;

export interface LiveEmote extends EmoteMessage {
  key: number;
  /** When it arrived here (this page's clock). */
  shownAt: number;
}

interface FunStore {
  /** Emotes showing now (over tokens and portraits) and in the feed. */
  emotes: LiveEmote[];
  /** This person's handouts and notes (a DM: all of them), newest first. */
  handouts: HandoutView[];
  /** A handout or note just given to this person: the parchment unfurls (until they put it away). */
  reveal: HandoutView | null;
  /** The campaign log as this person may read it, oldest first. */
  log: LogEntryView[];
  logLoaded: boolean;
  /** Handouts and notes given since the Journal was last looked at. */
  unread: number;
  set(p: Partial<FunStore>): void;
}

export const useFun = create<FunStore>((set) => ({
  emotes: [],
  handouts: [],
  reveal: null,
  log: [],
  logLoaded: false,
  unread: 0,
  set: (p) => set(p),
}));

let seq = 0;

function onEmote(m: EmoteMessage): void {
  const e: LiveEmote = { ...m, key: ++seq, shownAt: performance.now() };
  useFun.getState().set({ emotes: [...useFun.getState().emotes, e].slice(-20) });
  // The pop (SPEC §31: a tiny rising bloop), from the token when this page sees it, else from the top of the screen.
  const t = m.tokenId ? boardData(useEntities.getState()).tokens.get(m.tokenId) : undefined;
  if (t) playOnBoard("emotePop", { x: t.pos.x, y: t.pos.y, z: t.elevation });
  else audio.play("emotePop");
  setTimeout(
    () => useFun.getState().set({ emotes: useFun.getState().emotes.filter((x) => x.key !== e.key) }),
    FEED_MS,
  );
}

function upsert(list: HandoutView[], h: HandoutView): HandoutView[] {
  return [h, ...list.filter((x) => x.id !== h.id)].sort((a, b) => b.createdAt - a.createdAt);
}

function onMessage(type: string, payload: unknown): void {
  const s = useFun.getState();
  switch (type) {
    case "emote":
      onEmote(payload as EmoteMessage);
      return;
    // Given to this person just now: it unfurls, with a paper sound, and joins their list.
    case "handout":
    case "note": {
      const h = payload as HandoutView;
      s.set({ handouts: upsert(s.handouts, h), reveal: h, unread: s.unread + 1 });
      audio.play("handoutReveal");
      return;
    }
    case "handout.update": {
      const h = payload as HandoutView;
      if (s.handouts.some((x) => x.id === h.id)) s.set({ handouts: upsert(s.handouts, h) });
      return;
    }
    // A DM's list (drafts, edits, who has what).
    case "handout.changed": {
      const h = payload as HandoutView & { deleted?: boolean };
      s.set({ handouts: h.deleted ? s.handouts.filter((x) => x.id !== h.id) : upsert(s.handouts, h) });
      return;
    }
    case "handout.gone": {
      const id = (payload as { id: string }).id;
      s.set({
        handouts: s.handouts.filter((x) => x.id !== id),
        reveal: s.reveal?.id === id ? null : s.reveal,
      });
      return;
    }
    case "log.entry": {
      const e = payload as LogEntryView;
      if (!s.log.some((x) => x.id === e.id)) s.set({ log: [...s.log, e] });
      return;
    }
  }
}

let loadedFor = "";
async function load(): Promise<void> {
  const t = useTable.getState();
  const k = t.room && t.me ? `${t.room.roomId}|${t.room.sessionId}` : "";
  if (!k || k === loadedFor) return;
  loadedFor = k;
  try {
    const [handouts, log] = await Promise.all([
      request<HandoutView[]>("handout.list", {}),
      request<LogEntryView[]>("log.list", {}),
    ]);
    useFun.getState().set({ handouts, log, logLoaded: true });
  } catch {
    loadedFor = "";
  }
}

/** Starts following emotes, handouts and the log (once per page); lists fetched for each room session. */
export function watchFun(): () => void {
  if (__GLOAM_TEST__) {
    provideTestHook("emotes", () => useFun.getState().emotes.map(({ key: _k, shownAt: _s, ...e }) => e));
    provideTestHook("handouts", () => useFun.getState().handouts);
    provideTestHook("campaignLog", () => useFun.getState().log);
  }
  const offMsg = tableEvents.on("message", ({ type, payload }) => onMessage(type, payload));
  const offConn = useTable.subscribe(() => void load());
  void load();
  return () => {
    offMsg();
    offConn();
    loadedFor = "";
    useFun.getState().set({ emotes: [], handouts: [], reveal: null, log: [], logLoaded: false, unread: 0 });
  };
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────

export const sendEmote = (emote: EmoteId) => request("emote.send", { emote });
export const sendPhrase = (phrase: string) => request("emote.send", { phrase });
export async function savePhrases(phrases: string[]): Promise<void> {
  const r = await request<{ phrases: string[] }>("profile.phrases", { phrases });
  const me = useTable.getState().me;
  if (me) useTable.getState().set({ me: { ...me, phrases: r.phrases } });
}
export const toggleHand = () => request<{ raised: boolean }>("hand.toggle", {});
export const addLogEntry = (text: string) => request("log.add", { text });

export const createHandout = (p: { title: string; bodyMd: string; imageAssetId: string | null }) =>
  request<{ handoutId: string }>("handout.create", p);
export const updateHandout = (p: {
  handoutId: string;
  title?: string;
  bodyMd?: string;
  imageAssetId?: string | null;
}) => request("handout.update", p);
export const deleteHandout = (handoutId: string) => request("handout.delete", { handoutId });
export const showHandout = (handoutId: string, to: "all" | string[]) =>
  request("handout.show", { handoutId, to });
export const sendNote = (userId: string, text: string) => request("note.secret", { userId, text });

/** The log as Markdown (SPEC §8.18 Export): a heading per session, each entry a line with its time. */
export function logMarkdown(campaign: string, entries: LogEntryView[]): string {
  const out = [`# ${campaign} — campaign log`, ""];
  let session = -1;
  for (const e of entries) {
    if (e.sessionNo !== session) {
      if (session !== -1) out.push("");
      session = e.sessionNo;
      out.push(session ? `## Session ${session}` : "## Before the first session", "");
    }
    const when = new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " ");
    const who = e.author ? ` — ${e.author}` : "";
    // Manual text keeps its own lines, indented under its bullet.
    const text = e.text.replace(/\r?\n/g, "\n  ");
    out.push(`- *${when}*${who}: ${text}`);
  }
  return `${out.join("\n")}\n`;
}
