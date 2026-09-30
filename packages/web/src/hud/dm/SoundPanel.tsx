import {
  AMBIENCE_LAYERS,
  AMBIENCE_PRESET_IDS,
  type AmbienceLayer,
  type AmbiencePreset,
  MUSIC_PRESETS,
  type MusicPreset,
  musicPositionMs,
} from "@gloam/shared/protocol";
import {
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  Trash2,
  Volume1,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { audio } from "../../audio/engine.ts";
import {
  measureTrack,
  musicAction,
  playlistAction,
  playPlaylist,
  playPreset,
  playTrack,
  setAmbienceLevel,
  setAmbiencePreset,
  setLoop,
  setMusicVolume,
  setShuffle,
  setTrackVolume,
  useAudioSync,
  withSound,
} from "../../net/audio.ts";
import { serverNow } from "../../net/clock.ts";
import { request } from "../../net/table.ts";
import { type AssetItem, useLibrary } from "../../state/library.ts";
import { prefersReducedMotion } from "../../state/settings.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Slider } from "../../ui/controls.tsx";
import { SECTION_HEADING } from "../../ui/labels.ts";
import { Menu } from "../../ui/Menu.tsx";
import { toast } from "../../ui/Toast.tsx";
import { UploadZone } from "./UploadZone.tsx";

const PRESET_LABEL: Record<MusicPreset, { name: string; mood: string }> = {
  dungeon: { name: "Dungeon drone", mood: "A slow minor pad, low pulses, a distant bell" },
  tavern: { name: "Tavern", mood: "Plucked tunes over a hand drum" },
  battle: { name: "Battle", mood: "A driving ostinato and low drums" },
  wonder: { name: "Wonder", mood: "A bright pad and glassy bells" },
};
const AMBIENCE_PRESET_LABEL: Record<AmbiencePreset, string> = {
  crypt: "Crypt",
  forestNight: "Forest night",
  storm: "Storm",
  tavernHearth: "Tavern hearth",
  cave: "Cave",
};
const LAYER_LABEL: Record<AmbienceLayer, string> = {
  rain: "Rain",
  wind: "Wind",
  fire: "Fire",
  water: "Water",
  drips: "Cave drips",
  insects: "Insects",
  murmur: "Murmur",
};

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A slider that sends as it moves, at most a few times a second, and its last value when it stops. */
function useThrottled(send: (v: number) => void, ms = 250): (v: number) => void {
  const last = useRef(0);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (v: number) => {
    pending.current = v;
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      send(v);
      pending.current = null;
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      if (pending.current !== null) send(pending.current);
      pending.current = null;
    }, wait);
  };
}

function Heading({ children }: { children: string }) {
  return <h3 className={SECTION_HEADING}>{children}</h3>;
}

/** What's playing, where it is, and the transport. */
function NowPlaying({ tracks }: { tracks: Map<string, AssetItem> }) {
  const a = useAudioSync((s) => s.state);
  const m = a.music;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const track = m.trackId ? tracks.get(m.trackId) : undefined;
  const list = m.playlistId ? a.playlists.find((p) => p.id === m.playlistId) : undefined;
  const title =
    m.kind === "preset" && m.preset
      ? PRESET_LABEL[m.preset].name
      : m.kind === "track"
        ? (track?.name ?? "A track")
        : "Nothing playing";
  const sub =
    m.kind === "preset"
      ? "Generative · plays on"
      : m.kind === "track"
        ? `${list ? `${list.name} · ${m.index + 1} of ${m.order.length} · ` : ""}${clock(musicPositionMs(m, serverNow()))}${track?.durationMs ? ` / ${clock(track.durationMs)}` : ""}`
        : "Pick a preset, a track or a playlist";
  const volume = useThrottled((v) => act(setMusicVolume(v), "Couldn't change the volume"));
  const playing = m.kind !== "none";
  return (
    <section
      className="panel flex scroll-mt-4 flex-col gap-2.5 p-3"
      aria-label="Now playing"
      data-testid="now-playing"
    >
      <div className="min-w-0">
        <p className="truncate font-display text-18 text-bone">{title}</p>
        <p className="tabular truncate text-13 text-muted">{sub}</p>
      </div>
      <div className="flex items-center gap-1">
        <IconButton
          label="Previous"
          disabled={m.kind !== "track"}
          onClick={() => act(musicAction("previous"), "Couldn't go back")}
        >
          <SkipBack size={16} />
        </IconButton>
        <IconButton
          label={m.paused || !playing ? "Play" : "Pause"}
          disabled={!playing}
          onClick={() =>
            act(
              withSound(() => musicAction(m.paused ? "resume" : "pause")),
              "Couldn't pause",
            )
          }
        >
          {m.paused || !playing ? <Play size={16} /> : <Pause size={16} />}
        </IconButton>
        <IconButton
          label="Next"
          disabled={m.kind !== "track"}
          onClick={() => act(musicAction("next"), "Couldn't skip")}
        >
          <SkipForward size={16} />
        </IconButton>
        <IconButton
          label="Stop"
          disabled={!playing}
          onClick={() => act(musicAction("stop"), "Couldn't stop")}
        >
          <Square size={14} />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <IconButton
          label={m.loop ? "Loop on" : "Loop off"}
          active={m.loop}
          onClick={() => act(setLoop(!m.loop), "Couldn't change looping")}
        >
          <Repeat size={15} />
        </IconButton>
        <IconButton
          label={m.shuffle ? "Shuffle on" : "Shuffle off"}
          active={m.shuffle}
          onClick={() => act(setShuffle(!m.shuffle), "Couldn't change shuffle")}
        >
          <Shuffle size={15} />
        </IconButton>
      </div>
      <Slider label="Music volume" value={m.volume} onChange={volume} labelled />
    </section>
  );
}

/** Each preset's mark: a brass line drawn like its music moves (a slow swell, a skipping tune, a hammering figure,
 * rising sparkles). */
const MOTIF: Record<MusicPreset, string> = {
  dungeon: "M1 9c4 0 5-5 9-5s5 7 9 7 5-5 9-5 5 3 9 3",
  tavern: "M1 11c2-5 4-5 6 0M9 11c2-6 4-6 6 0M17 11c2-5 4-5 6 0M25 11c2-7 4-7 6 0M33 11c2-5 4-5 6 0",
  battle: "M1 12 5 3l4 9 4-9 4 9 4-9 4 9 4-9 4 9 4-9 3 6",
  wonder: "M2 13c6-2 10-6 14-10M16 3v4M14 5h4M24 12c4-1 7-4 9-7M33 5v3M31.5 6.5h3M8 5.5h.01M28 11h.01",
};

function Motif({ p, on }: { p: MusicPreset; on: boolean }) {
  return (
    <svg
      width="40"
      height="16"
      viewBox="0 0 40 16"
      fill="none"
      stroke={on ? "var(--brass-300)" : "var(--brass-600)"}
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={MOTIF[p]} />
    </svg>
  );
}

/** What's playing, moving: four level bars from the music itself (held still with reduced motion). */
function LevelBars() {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const still = prefersReducedMotion();
  useEffect(() => {
    if (still) return;
    let raf = 0;
    const step = () => {
      const b = audio.musicBands(4);
      bars.current.forEach((el, i) => {
        if (el) el.style.transform = `scaleY(${Math.max(0.15, Math.min(1, (b?.[i] ?? 0) * 1.6))})`;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [still]);
  return (
    <span className="flex h-3.5 items-end gap-1" role="img" aria-label="Playing" data-testid="level-bars">
      {[0.55, 0.9, 0.7, 0.4].map((h, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="block h-full w-[3px] origin-bottom rounded-chip bg-brass-bright"
          style={{ transform: `scaleY(${still ? h : 0.15})` }}
        />
      ))}
    </span>
  );
}

/** The four generative presets. */
function Presets() {
  const m = useAudioSync((s) => s.state.music);
  return (
    <section className="flex flex-col gap-2" aria-label="Generative music">
      <Heading>Generative music</Heading>
      <div className="grid grid-cols-2 gap-2">
        {MUSIC_PRESETS.map((p) => {
          const on = m.kind === "preset" && m.preset === p;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              onClick={() =>
                act(
                  withSound(() => playPreset(p)),
                  "Couldn't play that",
                )
              }
              className={`flex min-h-[64px] flex-col items-start gap-0.5 rounded-[var(--radius-control)] border px-3 py-2 text-left transition-colors duration-[var(--dur-fast)] ${on ? "border-brass bg-raised" : "border-line hover:border-brass-deep hover:bg-raised"}`}
            >
              {/* Its mark on a row of its own, the level bars at the far end while it plays; the name under them. */}
              <span className="flex w-full items-center justify-between gap-2">
                <Motif p={p} on={on} />
                {on ? <LevelBars /> : null}
              </span>
              <span className={`text-14 font-bold ${on ? "text-brass-bright" : "text-bone"}`}>
                {PRESET_LABEL[p].name}
              </span>
              <span className="text-12 leading-snug text-muted">{PRESET_LABEL[p].mood}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function TrackRow({
  t,
  playlists,
}: {
  t: AssetItem;
  playlists: { id: string; name: string; trackIds: string[] }[];
}) {
  const a = useAudioSync((s) => s.state);
  const playing = a.music.kind === "track" && a.music.trackId === t.id;
  const vol = useThrottled((v) => act(setTrackVolume(t.id, v), "Couldn't change its volume"));
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2" data-testid="track-row" data-track={t.id}>
      <div className="flex items-center gap-2">
        <IconButton
          label={`Play ${t.name}`}
          active={playing}
          onClick={() =>
            act(
              withSound(() => playTrack(t.id)),
              "Couldn't play that",
            )
          }
        >
          <Play size={15} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-14 ${playing ? "text-brass-bright" : "text-bone"}`}>{t.name}</p>
          <p className="tabular text-12 text-muted">
            {t.durationMs ? clock(t.durationMs) : "length after its first play"}
          </p>
        </div>
        {playlists.length ? (
          <Menu
            label={`Add ${t.name} to a playlist`}
            items={playlists.map((p) => ({
              label: p.name,
              onSelect: () =>
                act(
                  playlistAction({ action: "setTracks", playlistId: p.id, trackIds: [...p.trackIds, t.id] }),
                  "Couldn't add it",
                ),
            }))}
          />
        ) : null}
      </div>
      <div className="grid grid-cols-[16px_1fr_36px] items-center gap-2 pl-11">
        <Volume1 size={14} className="text-fog" aria-hidden />
        <Slider label={`${t.name} volume`} value={a.trackVolumes[t.id] ?? 1} onChange={vol} bubble={false} />
        <span className="tabular text-right text-12 text-muted">
          {Math.round((a.trackVolumes[t.id] ?? 1) * 100)}%
        </span>
      </div>
    </li>
  );
}

function Playlists({ tracks }: { tracks: Map<string, AssetItem> }) {
  const a = useAudioSync((s) => s.state);
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const create = () => {
    const n = name.trim();
    if (!n) return;
    act(
      playlistAction({ action: "create", name: n }).then((r) => {
        setName("");
        if (r.playlistId) setOpen(r.playlistId);
      }),
      "Couldn't make the playlist",
    );
  };
  return (
    <section className="flex flex-col gap-2" aria-label="Playlists">
      <Heading>Playlists</Heading>
      {a.playlists.length ? (
        <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
          {a.playlists.map((p) => {
            const on = a.music.playlistId === p.id && a.music.kind === "track";
            return (
              <li key={p.id} data-testid="playlist-row">
                <div className="flex items-center gap-2 px-3 py-2">
                  <IconButton
                    label={`Play ${p.name}`}
                    active={on}
                    disabled={!p.trackIds.length}
                    onClick={() =>
                      act(
                        withSound(() => playPlaylist(p.id)),
                        "Couldn't play it",
                      )
                    }
                  >
                    <Play size={15} />
                  </IconButton>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={open === p.id}
                    onClick={() => setOpen(open === p.id ? null : p.id)}
                  >
                    <span className={`block truncate text-14 ${on ? "text-brass-bright" : "text-bone"}`}>
                      {p.name}
                    </span>
                    <span className="block text-12 text-muted">
                      {p.trackIds.length} {p.trackIds.length === 1 ? "track" : "tracks"}
                    </span>
                  </button>
                  <IconButton
                    label={`Delete ${p.name}`}
                    tone="danger"
                    onClick={() =>
                      act(playlistAction({ action: "delete", playlistId: p.id }), "Couldn't delete it")
                    }
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
                {open === p.id ? (
                  <ol className="flex flex-col gap-0.5 pb-2 pl-12 pr-3">
                    {p.trackIds.length ? (
                      p.trackIds.map((id, i) => (
                        <li key={`${id}-${i}`} className="flex items-center gap-2 text-13">
                          <span className="tabular w-4 text-right text-fog">{i + 1}</span>
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left text-bone hover:text-brass-bright"
                            onClick={() =>
                              act(
                                withSound(() => playPlaylist(p.id, i)),
                                "Couldn't play it",
                              )
                            }
                          >
                            {tracks.get(id)?.name ?? "A missing track"}
                          </button>
                          <IconButton
                            label="Take it out"
                            onClick={() =>
                              act(
                                playlistAction({
                                  action: "setTracks",
                                  playlistId: p.id,
                                  trackIds: p.trackIds.filter((_, k) => k !== i),
                                }),
                                "Couldn't take it out",
                              )
                            }
                          >
                            <X size={14} />
                          </IconButton>
                        </li>
                      ))
                    ) : (
                      <li className="text-13 text-muted">Add tracks from the list above.</li>
                    )}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input
          aria-label="New playlist's name"
          placeholder="New playlist"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-10 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-ink-950 px-3 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
        />
        <Button type="submit" variant="secondary" size="M" disabled={!name.trim()}>
          Make
        </Button>
      </form>
    </section>
  );
}

function AmbienceMixer() {
  const amb = useAudioSync((s) => s.state.ambience);
  return (
    <section className="flex flex-col gap-2" aria-label="Ambience">
      <Heading>Ambience</Heading>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ambience presets">
        {AMBIENCE_PRESET_IDS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={amb.preset === p}
            onClick={() =>
              act(
                withSound(() => setAmbiencePreset(p)),
                "Couldn't set the ambience",
              )
            }
            className={`h-8 rounded-[var(--radius-chip)] border px-3 text-13 font-bold ${amb.preset === p ? "border-brass bg-raised text-brass-bright" : "border-line text-muted hover:border-brass-deep hover:text-bone"}`}
          >
            {AMBIENCE_PRESET_LABEL[p]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => act(setAmbiencePreset(null), "Couldn't silence the ambience")}
          className="h-8 rounded-[var(--radius-chip)] border border-line px-3 text-13 font-bold text-muted hover:text-bone"
        >
          Silence
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {AMBIENCE_LAYERS.map((layer) => (
          <LayerSlider key={layer} layer={layer} level={amb.levels[layer] ?? 0} />
        ))}
      </div>
    </section>
  );
}

/** A layer's slider: the DM's own hand while it moves (the server's echo catches up), the table's level otherwise. */
function LayerSlider({ layer, level }: { layer: AmbienceLayer; level: number }) {
  const [edit, setEdit] = useState<{ v: number; until: number } | null>(null);
  useEffect(() => {
    if (!edit) return;
    const id = setTimeout(() => setEdit(null), Math.max(0, edit.until - Date.now()));
    return () => clearTimeout(id);
  }, [edit]);
  const send = useThrottled((v) =>
    act(
      withSound(() => setAmbienceLevel(layer, v)),
      "Couldn't change the ambience",
    ),
  );
  return (
    <div className="grid grid-cols-[92px_1fr_36px] items-center gap-2">
      <span className="text-13 text-muted">{LAYER_LABEL[layer]}</span>
      <Slider
        label={`${LAYER_LABEL[layer]} level`}
        value={edit ? edit.v : level}
        bubble={false}
        onChange={(v) => {
          setEdit({ v, until: Date.now() + 800 });
          send(v);
        }}
      />
      <span className="tabular text-right text-12 text-muted">
        {Math.round((edit ? edit.v : level) * 100)}%
      </span>
    </div>
  );
}

/**
 * DM panel → Sound (SPEC §8.17, §8.19): the music player — generative presets, uploaded tracks with their own
 * volumes, playlists (play, loop, shuffle, next, previous, stop, a 2-s crossfade between whatever plays) — and the
 * ambience mixer (presets and seven layers). Everything here plays for the whole table, in step.
 */
export function SoundPanel() {
  const assets = useLibrary((s) => s.assets);
  const playlists = useAudioSync((s) => s.state.playlists);
  useEffect(() => {
    void request<AssetItem[]>("asset.list", { tab: "audio" })
      .then((items) => useLibrary.getState().upsert(items))
      .catch(() => {});
  }, []);
  const tracks = new Map(
    [...assets.values()]
      .filter((a) => a.cls === "audio" && !a.deleted && a.status === "approved")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => [a.id, a]),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" data-testid="sound-panel">
      <NowPlaying tracks={tracks} />
      <Presets />
      <section className="flex flex-col gap-2" aria-label="Tracks">
        <Heading>Tracks</Heading>
        {tracks.size ? (
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {[...tracks.values()].map((t) => (
              <TrackRow key={t.id} t={t} playlists={playlists} />
            ))}
          </ul>
        ) : null}
        <UploadZone
          purpose="audio"
          hint="MP3, OGG, WAV, M4A or FLAC · up to 50 MB"
          onUploaded={(a) => {
            useLibrary.getState().upsert([a]);
            // Its length and loudness, measured here once (the server keeps them for every client).
            void measureTrack(a.id);
          }}
        />
      </section>
      <Playlists tracks={tracks} />
      <AmbienceMixer />
    </div>
  );
}
