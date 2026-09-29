import { randomInt } from "node:crypto";
import {
  AMBIENCE_PRESETS,
  AudioAmbience,
  AudioMusic,
  AudioPlaylist,
  CampaignAudio,
  GloamError,
  type MusicState,
} from "@gloam/shared/protocol";
import { can } from "@gloam/shared/rules";
import type { z } from "zod";
import { newId } from "../../ids.ts";
import type { CommandCtx, CommandDef, Plan } from "../commandBus.ts";
import type { Op } from "../ops.ts";

/** `audio.sync`: the campaign's audio, to everyone at the table after each change (SPEC §25.3). */
export const AUDIO_SYNC = "audio.sync";

/** The campaign's audio as stored (defaults filled in). */
export function campaignAudio(ctx: Pick<CommandCtx, "model">): CampaignAudio {
  return CampaignAudio.parse(ctx.model.campaign.settings.audio ?? {});
}

function authorize(ctx: CommandCtx): void {
  if (!can(ctx.actor.role, "audio.control")) throw new GloamError("FORBIDDEN");
}

/**
 * A plan that writes the audio and tells every client — or nothing, when nothing changed. Each part (the music, the
 * ambience, the playlists, the tracks' volumes) is its own op, so undoing a playlist's edit puts back the playlists
 * and never the playback (AC-UNDO-05).
 */
function write(ctx: CommandCtx, next: CampaignAudio, summary: string): Plan<{ changed: boolean }> {
  const c = ctx.model.campaign;
  const stored = c.settings.audio;
  const prev = campaignAudio(ctx);
  const ops: Op[] = [];
  for (const part of ["music", "ambience", "playlists", "trackVolumes"] as const)
    if (JSON.stringify(prev[part]) !== JSON.stringify(next[part]))
      ops.push({
        k: "set",
        e: "campaign",
        id: c.id,
        path: ["settings", "audio", part],
        value: next[part],
        prev: prev[part],
      });
  if (!ops.length) return { ops: [], summary, result: { changed: false } };
  // The first time: the audio as a whole (its defaults), then the parts over it.
  if (!stored)
    ops.unshift({ k: "set", e: "campaign", id: c.id, path: ["settings", "audio"], value: prev, prev: null });
  return {
    ops,
    summary,
    result: { changed: true },
    events: [{ name: AUDIO_SYNC, payload: next, to: { all: true } }],
  };
}

/** A track the table can play: an approved audio asset of this campaign, not deleted. */
function playable(ctx: CommandCtx, trackId: string): boolean {
  const a = ctx.model.get("asset", trackId);
  if (!a || a.deletedAt !== null || a.status !== "approved" || a.campaignId !== ctx.model.campaign.id)
    return false;
  return ctx.app.assets.file(a.fileId)?.kind === "audio";
}

/** 0…n−1, shuffled from a seed (Fisher–Yates on mulberry32) — or in order. */
function orderFor(n: number, shuffle: boolean, seed: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  if (!shuffle) return order;
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return order;
}

/** Starts playing from the top: position 0 now. */
const fromTop = (m: MusicState, now: number): MusicState => ({
  ...m,
  startedAtServerMs: now,
  paused: false,
  pausedAtMs: 0,
});

/** A position in a playlist's order: its track, from the top. */
function atIndex(m: MusicState, trackIds: string[], index: number, now: number): MusicState {
  const trackId = trackIds[m.order[index] as number] ?? null;
  return fromTop({ ...m, kind: trackId ? "track" : "none", trackId, preset: null, index }, now);
}

/** Moves on from what's playing: the playlist's next track (round again when looping), or the track again. */
function advance(ctx: CommandCtx, m: MusicState, playlists: CampaignAudio["playlists"]): MusicState {
  if (m.kind !== "track") return m;
  const list = m.playlistId ? playlists.find((p) => p.id === m.playlistId) : undefined;
  // A lone track loops or stops; one whose playlist was deleted stops at its end.
  if (!list) return m.loop && !m.playlistId ? fromTop(m, ctx.now) : stopped(m);
  const next = m.index + 1;
  if (next < m.order.length) return atIndex(m, list.trackIds, next, ctx.now);
  if (!m.loop) return stopped(m);
  // Round again: a shuffled playlist is shuffled afresh (its last track not first again, where there's a choice).
  let order = m.order;
  if (m.shuffle) {
    const seed = randomInt(2 ** 31);
    order = orderFor(list.trackIds.length, true, seed);
    if (order.length > 1 && order[0] === m.order.at(-1)) order.push(order.shift() as number);
  }
  return atIndex({ ...m, order }, list.trackIds, 0, ctx.now);
}

const stopped = (m: MusicState): MusicState => ({
  ...m,
  kind: "none",
  trackId: null,
  preset: null,
  paused: false,
  pausedAtMs: 0,
  playlistId: null,
  order: [],
  index: 0,
});

/**
 * `audio.music` (DM; SPEC §8.17 Music): play a preset, a track or a playlist; pause, resume, stop, next, previous;
 * volume, loop, shuffle, a track's own volume. The server keeps the timeline (`startedAtServerMs` on its clock);
 * every client plays to it. Not undoable (AC-UNDO-05): playback isn't a change to the campaign anyone takes back.
 */
export const audioMusic: CommandDef<z.infer<typeof AudioMusic>, { changed: boolean }> = {
  type: "audio.music",
  schema: AudioMusic,
  undoable: false,
  authorize(ctx, p) {
    // The track's end is the server's own to report.
    if (p.action === "ended") {
      if (ctx.actor.userId !== "system") throw new GloamError("FORBIDDEN");
      return;
    }
    authorize(ctx);
  },
  plan(ctx, p) {
    const audio = campaignAudio(ctx);
    const m = audio.music;
    const now = ctx.now;
    let next: MusicState = m;
    let summary = "Changed the music";
    switch (p.action) {
      case "playPreset":
        next = fromTop(
          {
            ...stopped(m),
            kind: "preset",
            preset: p.preset,
            seed: randomInt(2 ** 31),
          },
          now,
        );
        summary = `Played the ${p.preset} music`;
        break;
      case "playTrack":
        if (!playable(ctx, p.trackId)) throw new GloamError("NOT_FOUND", "That track isn't in the library.");
        next = fromTop({ ...stopped(m), kind: "track", trackId: p.trackId }, now);
        summary = "Played a track";
        break;
      case "playPlaylist": {
        const list = audio.playlists.find((x) => x.id === p.playlistId);
        if (!list) throw new GloamError("NOT_FOUND", "That playlist is gone.");
        const tracks = list.trackIds.filter((t) => playable(ctx, t));
        if (!tracks.length) throw new GloamError("INVALID", "That playlist has no tracks to play.");
        const at = Math.min(p.at ?? 0, list.trackIds.length - 1);
        let order = orderFor(list.trackIds.length, m.shuffle, randomInt(2 ** 31)).filter((i) =>
          playable(ctx, list.trackIds[i] as string),
        );
        // The chosen track first; the rest after it (in order, or shuffled).
        if (order.includes(at)) order = m.shuffle ? [at, ...order.filter((i) => i !== at)] : order;
        const index = m.shuffle ? 0 : Math.max(0, order.indexOf(at));
        next = atIndex({ ...stopped(m), playlistId: list.id, order }, list.trackIds, index, now);
        summary = `Played the playlist ${list.name}`;
        break;
      }
      case "pause":
        if (m.kind === "none" || m.paused) return { ops: [], summary, result: { changed: false } };
        next = { ...m, paused: true, pausedAtMs: Math.max(0, now - m.startedAtServerMs) };
        summary = "Paused the music";
        break;
      case "resume":
        if (m.kind === "none" || !m.paused) return { ops: [], summary, result: { changed: false } };
        next = { ...m, paused: false, startedAtServerMs: now - m.pausedAtMs };
        summary = "Resumed the music";
        break;
      case "stop":
        next = stopped(m);
        summary = "Stopped the music";
        break;
      case "next":
        next = advance(ctx, m, audio.playlists);
        summary = "Skipped to the next track";
        break;
      case "ended":
        // A stale timer (the music changed since) does nothing.
        if (p.rev !== m.rev || m.paused) return { ops: [], summary, result: { changed: false } };
        next = advance(ctx, m, audio.playlists);
        summary = "The track ended";
        break;
      case "previous": {
        if (m.kind !== "track") return { ops: [], summary, result: { changed: false } };
        const pos = m.paused ? m.pausedAtMs : now - m.startedAtServerMs;
        const list = m.playlistId ? audio.playlists.find((x) => x.id === m.playlistId) : undefined;
        // Well into a track (or with nothing before it), back to its start; near its start, the one before.
        if (pos > 3000 || !list || (m.index === 0 && !m.loop)) next = fromTop(m, now);
        else {
          const i = m.index === 0 ? m.order.length - 1 : m.index - 1;
          next = atIndex(m, list.trackIds, i, now);
        }
        summary = "Went back a track";
        break;
      }
      case "volume":
        next = { ...m, volume: p.volume };
        summary = "Changed the music's volume";
        break;
      case "loop":
        next = { ...m, loop: p.loop };
        summary = p.loop ? "Music loops" : "Music plays once";
        break;
      case "shuffle": {
        next = { ...m, shuffle: p.shuffle };
        // Playing a playlist: what's playing stays; the rest are reordered (or put back in order).
        if (m.kind === "track" && m.playlistId) {
          const cur = m.order[m.index] as number;
          const rest = orderFor(m.order.length, p.shuffle, randomInt(2 ** 31)).filter((i) => i !== cur);
          next = { ...next, order: [cur, ...rest], index: 0 };
        }
        summary = p.shuffle ? "Shuffled the playlist" : "Playlist in order";
        break;
      }
      case "trackVolume": {
        if (!playable(ctx, p.trackId)) throw new GloamError("NOT_FOUND", "That track isn't in the library.");
        const plan = write(
          ctx,
          { ...audio, trackVolumes: { ...audio.trackVolumes, [p.trackId]: p.volume } },
          "Changed a track's volume",
        );
        return plan;
      }
    }
    return write(ctx, { ...audio, music: { ...next, rev: m.rev + 1 } }, summary);
  },
};

/**
 * `audio.ambience` (DM; SPEC §8.17 Ambience): a preset's mix, or layers set one by one (the mix no longer the
 * preset's). Every client synthesizes it; random events share the ambience's seed. Not undoable, like the music.
 */
export const audioAmbience: CommandDef<z.infer<typeof AudioAmbience>, { changed: boolean }> = {
  type: "audio.ambience",
  schema: AudioAmbience,
  undoable: false,
  authorize,
  plan(ctx, p) {
    const audio = campaignAudio(ctx);
    const a = audio.ambience;
    let next = a;
    if (p.preset !== undefined)
      next =
        p.preset === null
          ? { levels: {}, preset: null, seed: a.seed }
          : { levels: { ...AMBIENCE_PRESETS[p.preset] }, preset: p.preset, seed: randomInt(2 ** 31) };
    if (p.levels) next = { ...next, levels: { ...next.levels, ...p.levels }, preset: p.preset ?? null };
    // Silent layers are left out.
    next = {
      ...next,
      levels: Object.fromEntries(Object.entries(next.levels).filter(([, v]) => (v ?? 0) > 0)),
    };
    const what = next.preset ? `the ${next.preset} ambience` : "the ambience";
    return write(ctx, { ...audio, ambience: next }, `Set ${what}`);
  },
};

/** `audio.playlist` (DM): playlists made, renamed, filled and deleted. Undoable, like any other edit. */
export const audioPlaylist: CommandDef<
  z.infer<typeof AudioPlaylist>,
  { playlistId?: string; changed: boolean }
> = {
  type: "audio.playlist",
  schema: AudioPlaylist,
  undoable: true,
  authorize,
  plan(ctx, p) {
    const audio = campaignAudio(ctx);
    const lists = audio.playlists;
    const find = (id: string) => {
      const l = lists.find((x) => x.id === id);
      if (!l) throw new GloamError("NOT_FOUND", "That playlist is gone.");
      return l;
    };
    switch (p.action) {
      case "create": {
        if (lists.length >= 50)
          throw new GloamError("INVALID", "That's as many playlists as a campaign keeps.");
        const id = newId("pls");
        const plan = write(
          ctx,
          { ...audio, playlists: [...lists, { id, name: p.name, trackIds: [] }] },
          `Made the playlist ${p.name}`,
        );
        return { ...plan, result: { playlistId: id, changed: true } };
      }
      case "rename": {
        find(p.playlistId);
        return write(
          ctx,
          { ...audio, playlists: lists.map((l) => (l.id === p.playlistId ? { ...l, name: p.name } : l)) },
          `Renamed a playlist to ${p.name}`,
        );
      }
      case "delete": {
        const l = find(p.playlistId);
        // Playing it: the track playing plays out, and the music stops there (playback isn't this edit's to undo).
        return write(
          ctx,
          { ...audio, playlists: lists.filter((x) => x.id !== l.id) },
          `Deleted the playlist ${l.name}`,
        );
      }
      case "setTracks": {
        const l = find(p.playlistId);
        for (const t of p.trackIds)
          if (!playable(ctx, t)) throw new GloamError("NOT_FOUND", "A track isn't in the library.");
        return write(
          ctx,
          { ...audio, playlists: lists.map((x) => (x.id === l.id ? { ...x, trackIds: p.trackIds } : x)) },
          `Changed the playlist ${l.name}`,
        );
      }
    }
  },
};

export const AUDIO_COMMANDS = [audioMusic, audioAmbience, audioPlaylist] as CommandDef<never, unknown>[];
