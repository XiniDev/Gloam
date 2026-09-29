import { type AudioSync, DEFAULT_CAMPAIGN_AUDIO } from "@gloam/shared/protocol";
import { create } from "zustand";

/**
 * The campaign's audio as the server last sent it (SPEC §8.17): what's playing, the ambience, the playlists. Set by
 * the table connection itself the moment `audio.sync` arrives — the first one comes as the room is joined, before
 * the table screen and its sound have mounted — and followed by the players (net/audio.ts).
 */
export const useAudioSync = create<{ state: AudioSync; set(s: AudioSync): void }>((set) => ({
  state: DEFAULT_CAMPAIGN_AUDIO,
  set: (state) => set({ state }),
}));
