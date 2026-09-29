import { z } from "zod";

/**
 * Music and ambience (SPEC §8.17, §25.3–25.5): the DM's playback state, held by the server and sent to every client
 * as `audio.sync`, which plays it in step with the server's clock.
 */

/** The ambience layers (SPEC §8.17: six, and the murmur of a room full of people for the tavern's hearth). */
export const AMBIENCE_LAYERS = ["rain", "wind", "fire", "water", "drips", "insects", "murmur"] as const;
export type AmbienceLayer = (typeof AMBIENCE_LAYERS)[number];

/** The DM's ambience presets and their mixes (docs/research/sound.md §3.4). */
export const AMBIENCE_PRESETS = {
  crypt: { wind: 0.6, drips: 0.8 },
  forestNight: { wind: 0.5, water: 0.4, insects: 0.8 },
  storm: { rain: 0.9, wind: 0.8 },
  tavernHearth: { wind: 0.3, fire: 0.8, murmur: 0.7 },
  cave: { wind: 0.4, water: 0.5, drips: 0.9 },
} as const satisfies Record<string, Partial<Record<AmbienceLayer, number>>>;
export type AmbiencePreset = keyof typeof AMBIENCE_PRESETS;
export const AMBIENCE_PRESET_IDS = Object.keys(AMBIENCE_PRESETS) as AmbiencePreset[];

/** The four generative music presets (SPEC §25.5). */
export const MUSIC_PRESETS = ["dungeon", "tavern", "battle", "wonder"] as const;
export type MusicPreset = (typeof MUSIC_PRESETS)[number];

const Level = z.number().min(0).max(1);
const Id = z.string().min(1).max(64);

export const AmbienceLevels = z.partialRecord(z.enum(AMBIENCE_LAYERS), Level);
export type AmbienceLevels = z.infer<typeof AmbienceLevels>;

/** The ambience: each layer's level, the preset the mix came from, and the seed its random events share. */
export const AmbienceState = z.object({
  levels: AmbienceLevels,
  /** The preset the mix came from (null once the DM moves a slider away from it). */
  preset: z.enum(AMBIENCE_PRESET_IDS as [AmbiencePreset, ...AmbiencePreset[]]).nullable(),
  /** Shared by every client: random events (a storm's distant thunder) fall at the same moments for everyone. */
  seed: z.number().int().min(0),
});
export type AmbienceState = z.infer<typeof AmbienceState>;

/** What's playing (SPEC §25.3). */
export const MusicState = z.object({
  kind: z.enum(["none", "track", "preset"]),
  /** The track (an audio asset reference) or preset playing. */
  trackId: Id.nullable(),
  preset: z.enum(MUSIC_PRESETS).nullable(),
  /** Its seed (a preset's notes; the same on every client). */
  seed: z.number().int().min(0),
  /** When its position 0 was, on the server's clock (resuming moves it on by the pause). */
  startedAtServerMs: z.number(),
  paused: z.boolean(),
  /** Where it was paused (ms into it). */
  pausedAtMs: z.number().min(0),
  /** The music's volume (0–1), before each track's own. */
  volume: Level,
  /** The playlist it's playing through, and where in its order. */
  playlistId: Id.nullable(),
  index: z.number().int().min(0),
  /** The order the playlist's tracks play in (shuffled or as listed), as indices into it. */
  order: z.array(z.number().int().min(0)).max(200),
  loop: z.boolean(),
  shuffle: z.boolean(),
  /** Bumped by every change: a client crossfades when it changes and the track or preset did. */
  rev: z.number().int().min(0),
});
export type MusicState = z.infer<typeof MusicState>;

export const Playlist = z.object({ id: Id, name: z.string().min(1).max(60), trackIds: z.array(Id).max(200) });
export type Playlist = z.infer<typeof Playlist>;

export const DEFAULT_MUSIC: MusicState = {
  kind: "none",
  trackId: null,
  preset: null,
  seed: 0,
  startedAtServerMs: 0,
  paused: false,
  pausedAtMs: 0,
  volume: 0.8,
  playlistId: null,
  index: 0,
  order: [],
  loop: true,
  shuffle: false,
  rev: 0,
};

export const DEFAULT_AMBIENCE: AmbienceState = { levels: {}, preset: null, seed: 0 };

/**
 * A campaign's audio (kept in its settings, so snapshots, exports and restores carry it): what's playing, the
 * ambience, the playlists and each track's own volume. It is also what every client gets as `audio.sync`.
 */
export const CampaignAudio = z.object({
  music: MusicState.default(DEFAULT_MUSIC),
  ambience: AmbienceState.default(DEFAULT_AMBIENCE),
  playlists: z.array(Playlist).max(50).default([]),
  trackVolumes: z.record(Id, Level).default({}),
});
export type CampaignAudio = z.infer<typeof CampaignAudio>;
export type AudioSync = CampaignAudio;
export const DEFAULT_CAMPAIGN_AUDIO: CampaignAudio = CampaignAudio.parse({});

/** `audio.music` (DM): the player's controls. */
export const AudioMusic = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("playPreset"), preset: z.enum(MUSIC_PRESETS) }),
  z.strictObject({ action: z.literal("playTrack"), trackId: Id }),
  z.strictObject({
    action: z.literal("playPlaylist"),
    playlistId: Id,
    /** Which of its tracks to start on (as listed); the first by default. */
    at: z.number().int().min(0).max(999).optional(),
  }),
  z.strictObject({ action: z.literal("pause") }),
  z.strictObject({ action: z.literal("resume") }),
  z.strictObject({ action: z.literal("stop") }),
  z.strictObject({ action: z.literal("next") }),
  z.strictObject({ action: z.literal("previous") }),
  z.strictObject({ action: z.literal("volume"), volume: Level }),
  z.strictObject({ action: z.literal("loop"), loop: z.boolean() }),
  z.strictObject({ action: z.literal("shuffle"), shuffle: z.boolean() }),
  z.strictObject({ action: z.literal("trackVolume"), trackId: Id, volume: Level }),
  /** The server's own: the track it was timing came to its end. */
  z.strictObject({ action: z.literal("ended"), rev: z.number().int().min(0) }),
]);
export type AudioMusic = z.infer<typeof AudioMusic>;

/** `audio.ambience` (DM): a preset's mix, or layers' levels changed. */
export const AudioAmbience = z.strictObject({
  preset: z
    .enum(AMBIENCE_PRESET_IDS as [AmbiencePreset, ...AmbiencePreset[]])
    .nullable()
    .optional(),
  levels: AmbienceLevels.optional(),
});
export type AudioAmbience = z.infer<typeof AudioAmbience>;

/** `audio.playlist` (DM): playlists made, renamed, filled and deleted. */
export const AudioPlaylist = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), name: z.string().trim().min(1).max(60) }),
  z.strictObject({ action: z.literal("rename"), playlistId: Id, name: z.string().trim().min(1).max(60) }),
  z.strictObject({ action: z.literal("delete"), playlistId: Id }),
  z.strictObject({ action: z.literal("setTracks"), playlistId: Id, trackIds: z.array(Id).max(200) }),
]);
export type AudioPlaylist = z.infer<typeof AudioPlaylist>;

/** A track's position (ms) at a server time. */
export function musicPositionMs(m: MusicState, serverNow: number): number {
  if (m.kind === "none") return 0;
  return m.paused ? m.pausedAtMs : Math.max(0, serverNow - m.startedAtServerMs);
}
