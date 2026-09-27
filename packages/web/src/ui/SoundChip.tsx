import { Volume2, VolumeX } from "lucide-react";
import { audio, useAudioStatus } from "../audio/engine.ts";
import { useSettings } from "../state/settings.ts";

/**
 * The global mute toggle; when the browser is still blocking audio it becomes the "Tap to enable sound" chip
 * (SPEC §8.17 Audio unlock, AC-AUD-04).
 */
export function SoundChip() {
  const state = useAudioStatus((s) => s.state);
  const muted = useSettings((s) => s.muted);
  const update = useSettings((s) => s.update);
  if (state === "locked") {
    return (
      <button
        type="button"
        onClick={() => void audio.resume()}
        className="hit flex items-center gap-1.5 rounded-[var(--radius-chip)] border border-brass-deep bg-raised px-2.5 text-13 font-bold text-brass-bright animate-[soft-pulse_2.4s_ease-in-out_infinite]"
      >
        <VolumeX size={15} aria-hidden />
        Tap to enable sound
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={muted ? "Unmute sound" : "Mute sound"}
      aria-pressed={muted}
      onClick={() => {
        void audio.resume();
        update({ muted: !muted });
      }}
      className="hit grid place-items-center rounded-[var(--radius-control)] text-muted hover:bg-raised hover:text-bone"
    >
      {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
    </button>
  );
}
