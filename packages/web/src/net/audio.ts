import {
  type AmbienceLayer,
  type AmbiencePreset,
  type AudioSync,
  DEFAULT_CAMPAIGN_AUDIO,
  type MusicPreset,
} from "@gloam/shared/protocol";
import { ambience } from "../audio/ambience.ts";
import { audio, useAudioStatus } from "../audio/engine.ts";
import { integratedLufs } from "../audio/measure.ts";
import { music } from "../audio/music/player.ts";
import { useAudioSync } from "../state/audioSync.ts";
import { useLibrary } from "../state/library.ts";
import { provideTestHook } from "../test/hooks.ts";
import { assetUrl } from "./assets.ts";
import { clockOffset } from "./clock.ts";
import { api } from "./http.ts";
import { request, useTable } from "./table.ts";

export { useAudioSync };

/** Tracks' loudness and length, as their asset records have them (fetched once per track). */
const known = new Map<string, { durationMs?: number; loudnessLufs?: number }>();

async function trackInfo(trackId: string): Promise<void> {
  if (known.has(trackId)) return;
  known.set(trackId, {});
  try {
    const a = await api<{ durationMs?: number; loudnessLufs?: number }>("GET", `/api/assets/${trackId}`);
    known.set(trackId, a);
    music.setLoudness(trackId, a.loudnessLufs);
    // A track nobody has measured yet: a DM's browser measures it (its length times the server's next track).
    if (a.durationMs === undefined) void measureTrack(trackId);
  } catch {
    known.delete(trackId);
  }
}

/**
 * A DM's browser measures a track (SPEC §21.5, sound.md §6.3): decoded once at 48 kHz, its length and BS.1770
 * integrated loudness sent to the server, which keeps the first measurement. Players' browsers never do (they
 * couldn't save it).
 */
export async function measureTrack(
  trackId: string,
): Promise<{ durationMs: number; loudnessLufs: number } | null> {
  const role = useTable.getState().me?.role;
  if (role !== "dm" && role !== "admin") return null;
  try {
    const bytes = await (
      await fetch(assetUrl(trackId, "orig"), { credentials: "same-origin" })
    ).arrayBuffer();
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const buf = await ctx.decodeAudioData(bytes);
    const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    const m = {
      durationMs: Math.round(buf.duration * 1000),
      loudnessLufs: integratedLufs(channels, buf.sampleRate),
    };
    const lufs = Number.isFinite(m.loudnessLufs) ? Math.max(-70, Math.min(3, m.loudnessLufs)) : -70;
    await api("PATCH", `/api/assets/${trackId}/audio`, { ...m, loudnessLufs: lufs });
    known.set(trackId, { durationMs: m.durationMs, loudnessLufs: lufs });
    music.setLoudness(trackId, lufs);
    // The library shows its length from now on.
    const item = useLibrary.getState().assets.get(trackId);
    if (item) useLibrary.getState().upsert([{ ...item, durationMs: m.durationMs, loudnessLufs: lufs }]);
    return { durationMs: m.durationMs, loudnessLufs: lufs };
  } catch {
    return null;
  }
}

function apply(s: AudioSync): void {
  if (s.music.kind === "track" && s.music.trackId) void trackInfo(s.music.trackId);
  music.apply(s);
  ambience.apply(s.ambience);
}

/** Starts following the table's audio (once per page). */
export function watchAudio(): () => void {
  if (__GLOAM_TEST__) {
    provideTestHook("audioSync", () => useAudioSync.getState().state);
    provideTestHook("musicProbe", () => music.probe());
    provideTestHook("ambienceProbe", () => ambience.snapshot());
    provideTestHook("meter", (c: Parameters<typeof audio.meter>[0]) => audio.meter(c));
    // The loudest a channel reaches over a while (ms), sampled every 10 ms: silence, or sound, through its fader.
    provideTestHook(
      "meterOver",
      (c: Parameters<typeof audio.meter>[0], ms: number) =>
        new Promise<{ min: number; max: number }>((resolve) => {
          let min = Number.POSITIVE_INFINITY;
          let max = 0;
          const t0 = performance.now();
          const id = setInterval(() => {
            const v = audio.meter(c);
            min = Math.min(min, v);
            max = Math.max(max, v);
            if (performance.now() - t0 >= ms) {
              clearInterval(id);
              resolve({ min, max });
            }
          }, 10);
        }),
    );
  }
  // What the connection has now (it may have arrived before this screen), and every change after.
  apply(useAudioSync.getState().state);
  const offMsg = useAudioSync.subscribe((s, prev) => {
    if (s.state !== prev.state) apply(s.state);
  });
  // Sound unlocked, or the clock first known: start what should already be playing.
  const offStatus = useAudioStatus.subscribe((s, prev) => {
    if (s.state === "running" && prev.state !== "running") {
      music.play();
      ambience.mix();
    }
  });
  const waitClock = setInterval(() => {
    if (clockOffset() !== null) {
      clearInterval(waitClock);
      music.play();
    }
  }, 100);
  return () => {
    offMsg();
    offStatus();
    clearInterval(waitClock);
    music.apply(DEFAULT_CAMPAIGN_AUDIO);
    ambience.apply(DEFAULT_CAMPAIGN_AUDIO.ambience);
    useAudioSync.getState().set(DEFAULT_CAMPAIGN_AUDIO);
  };
}

// ── The DM's controls ──────────────────────────────────────────────────────────────────────────────────────

export const playPreset = (preset: MusicPreset) => request("audio.music", { action: "playPreset", preset });
export const playTrack = (trackId: string) => request("audio.music", { action: "playTrack", trackId });
export const playPlaylist = (playlistId: string, at?: number) =>
  request("audio.music", { action: "playPlaylist", playlistId, ...(at !== undefined ? { at } : {}) });
export const musicAction = (action: "pause" | "resume" | "stop" | "next" | "previous") =>
  request("audio.music", { action });
export const setMusicVolume = (volume: number) => request("audio.music", { action: "volume", volume });
export const setLoop = (loop: boolean) => request("audio.music", { action: "loop", loop });
export const setShuffle = (shuffle: boolean) => request("audio.music", { action: "shuffle", shuffle });
export const setTrackVolume = (trackId: string, volume: number) =>
  request("audio.music", { action: "trackVolume", trackId, volume });
export const setAmbiencePreset = (preset: AmbiencePreset | null) => request("audio.ambience", { preset });
export const setAmbienceLevel = (layer: AmbienceLayer, level: number) =>
  request("audio.ambience", { levels: { [layer]: level } });
export const playlistAction = (p: Record<string, unknown>) =>
  request<{ playlistId?: string }>("audio.playlist", p);

/** Re-plays once the page is allowed to (a DM pressing Play is a gesture: the context resumes with it). */
export async function withSound<T>(fn: () => Promise<T>): Promise<T> {
  void audio.resume();
  return fn();
}
