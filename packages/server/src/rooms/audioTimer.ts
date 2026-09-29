import type { CommandBus } from "../engine/commandBus.ts";
import { campaignAudio } from "../engine/commands/audio.ts";
import { SYSTEM_ACTOR } from "../engine/commands/party.ts";
import type { CampaignModel } from "../engine/model.ts";

/**
 * The music's clock on the server (SPEC §25.3): when a track playing will end — its length as the DM's browser
 * measured it — the server moves on (the playlist's next track, the track again, or silence), as `audio.music`
 * "ended" with the state's revision (a timer outrun by a change does nothing). Clients never decide it: the table
 * keeps playing through a DM who has stepped away.
 */
export class AudioTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly host: {
    model(): CampaignModel;
    bus(): CommandBus;
    /** A track's length (ms), once known. */
    durationOf(assetId: string): number | null;
    onError(err: unknown): void;
  };

  constructor(host: AudioTimer["host"]) {
    this.host = host;
  }

  /** The music changed (or a track's length became known): time what's playing now. */
  changed(): void {
    this.stop();
    const m = campaignAudio({ model: this.host.model() }).music;
    if (m.kind !== "track" || m.paused || !m.trackId) return;
    const length = this.host.durationOf(m.trackId);
    if (!length) return;
    const left = length - (Date.now() - m.startedAtServerMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.host.bus().execute("audio.music", { action: "ended", rev: m.rev }, SYSTEM_ACTOR);
      } catch (err) {
        this.host.onError(err);
      }
    }, Math.max(0, left) + 120);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
