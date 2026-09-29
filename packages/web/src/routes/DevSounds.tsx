import { Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SOUND_GROUPS } from "../audio/catalogue.ts";
import { audio, CHANNELS, type Channel, useAudioStatus } from "../audio/engine.ts";
import { measureRecipe, PLAN_PEAK_DB } from "../audio/measure.ts";
import { RECIPES, type SfxName } from "../audio/recipes.ts";
import { CHANNEL_LABEL, Volume } from "../hud/SettingsPopover.tsx";
import { provideTestHook } from "../test/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Divider } from "../ui/ornaments.tsx";
import { SoundChip } from "../ui/SoundChip.tsx";

type Level = { peakDb: number; lufsM: number };

const fmt = (db: number) => (Number.isFinite(db) ? db.toFixed(1) : "—");

/** Every event's channel, for the chips (a board sound's channel is its recipe's). */
function channelOf(name: SfxName): Channel {
  return RECIPES[name].channel;
}

/** The tumble of a throw, heard alone: a friction bed rising and dying away over 1.2 s. */
function playTumble(): void {
  const r = audio.rumble();
  if (!r) return;
  const t0 = performance.now();
  const step = () => {
    const u = (performance.now() - t0) / 1200;
    if (u >= 1) {
      r.stop();
      return;
    }
    r.set(Math.sin(Math.PI * u) * 0.9);
    requestAnimationFrame(step);
  };
  step();
}

/**
 * The sound audition page (`/dev/sounds`; SPEC §31, AC-AUD-01): every built-in sound, each synthesized as it plays —
 * no audio files — on its channel, through the same mixer as the table (the six channels with their volumes and
 * mutes). "Measure all" renders each offline at unity and lists its peak and loudness against the level plan
 * (docs/research/sound.md §2.7): the evidence that every event sounds, and where it sits in the mix.
 */
export default function DevSounds() {
  const state = useAudioStatus((s) => s.state);
  const [levels, setLevels] = useState<Partial<Record<SfxName, Level>>>({});
  const [measuring, setMeasuring] = useState(false);

  const measureAll = useCallback(async () => {
    setMeasuring(true);
    const out: Partial<Record<SfxName, Level>> = {};
    for (const g of SOUND_GROUPS)
      for (const s of g.sounds) {
        out[s.name] = await measureRecipe(s.name);
        setLevels({ ...out });
      }
    setMeasuring(false);
    return out;
  }, []);

  useEffect(() => {
    audio.ensure();
    provideTestHook("measureSounds", async () => {
      const out = await measureAll();
      return SOUND_GROUPS.flatMap((g) =>
        g.sounds.map((s) => ({
          name: s.name,
          channel: channelOf(s.name),
          ...(out[s.name] as Level),
          plan: PLAN_PEAK_DB[s.name] ?? null,
        })),
      );
    });
    provideTestHook("soundNames", () => SOUND_GROUPS.flatMap((g) => g.sounds.map((s) => s.name)));
    provideTestHook("playSound", (name: SfxName) => audio.play(name));
    provideTestHook("meter", (c: Channel) => audio.meter(c));
    // Plays a sound and returns the loudest its channel and the master reached while it sounded (live, after the
    // faders): how the journeys hear the routing, the volumes and the mutes.
    provideTestHook(
      "peakWhile",
      (name: SfxName, ms: number) =>
        new Promise<{ played: boolean; channel: number; master: number }>((resolve) => {
          const c = channelOf(name);
          const played = audio.play(name, { rate: 1 });
          let channel = 0;
          let master = 0;
          const t0 = performance.now();
          const id = setInterval(() => {
            channel = Math.max(channel, audio.meter(c));
            master = Math.max(master, audio.meter("master"));
            if (performance.now() - t0 >= ms) {
              clearInterval(id);
              resolve({ played, channel, master });
            }
          }, 10);
        }),
    );
    provideTestHook("audioState", () => useAudioStatus.getState().state);
  }, [measureAll]);

  return (
    <main className="min-h-[100dvh] bg-bg px-4 py-6 text-bone sm:px-8" data-testid="dev-sounds">
      <header className="mx-auto flex max-w-[1080px] flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-28 text-bone">Sound board</h1>
          <p className="mt-1 max-w-[62ch] text-14 text-muted">
            Every sound Gloam makes, synthesized in your browser as it plays — no audio files. Each plays on
            its channel through the table's mixer.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {state === "locked" ? <SoundChip /> : null}
          <Button variant="secondary" size="M" loading={measuring} onClick={() => void measureAll()}>
            Measure all
          </Button>
        </div>
      </header>
      <Divider className="mx-auto my-5 max-w-[1080px]" />
      <div className="mx-auto grid max-w-[1080px] gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="panel h-fit p-4 lg:sticky lg:top-6" aria-label="Mixer">
          <h2 className="caps mb-3 text-12 text-brass">Mixer</h2>
          <div className="flex flex-col gap-2">
            {CHANNELS.map((c) => (
              <Volume key={c} c={c} />
            ))}
          </div>
          <p className="mt-3 text-12 text-muted">This device only, as in the table's settings.</p>
        </aside>
        <div className="flex min-w-0 flex-col gap-6">
          {SOUND_GROUPS.map((g) => (
            <section key={g.title} className="panel overflow-hidden" aria-label={g.title}>
              <h2 className="caps border-b border-[var(--line-soft)] px-4 py-2.5 text-12 text-brass">
                {g.title}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] table-fixed text-13">
                  {/* One set of columns for every group, so they line up down the page. */}
                  <colgroup>
                    <col />
                    <col className="w-[120px]" />
                    <col className="w-[96px]" />
                    <col className="w-[120px]" />
                    <col className="w-[72px]" />
                    <col className="w-[56px]" />
                  </colgroup>
                  <thead>
                    <tr className="caps text-left text-11 text-fog">
                      <th className="py-2 pl-4 font-normal">Sound</th>
                      <th className="font-normal">Channel</th>
                      <th className="text-right font-normal">Peak dBFS</th>
                      <th className="text-right font-normal">Loudness LUFS</th>
                      <th className="pr-4 text-right font-normal">Plan</th>
                      <th>
                        <span className="sr-only">Play</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.title === "Dice" ? (
                      <tr
                        className="border-t border-[var(--line-soft)]"
                        data-testid="sound-row"
                        data-sound="diceRumble"
                      >
                        <td className="py-1.5 pl-4 text-bone">Dice tumbling</td>
                        <td>
                          <ChannelChip c="dice" />
                        </td>
                        <td className="text-right text-muted">continuous</td>
                        <td />
                        <td className="pr-4 text-right tabular-nums text-muted">−24.4</td>
                        <td className="pr-3 text-right">
                          <PlayButton label="Dice tumbling" onPlay={playTumble} />
                        </td>
                      </tr>
                    ) : null}
                    {g.sounds.map((s) => {
                      const l = levels[s.name];
                      const plan = PLAN_PEAK_DB[s.name];
                      const off = l && plan !== undefined ? Math.abs(l.peakDb - plan) : 0;
                      return (
                        <tr
                          key={s.name}
                          className="border-t border-[var(--line-soft)]"
                          data-testid="sound-row"
                          data-sound={s.name}
                        >
                          <td className="py-1.5 pl-4 text-bone">{s.label}</td>
                          <td>
                            <ChannelChip c={channelOf(s.name)} />
                          </td>
                          <td
                            className={`text-right tabular-nums ${off > 3 ? "text-danger-text" : "text-bone"}`}
                          >
                            {l ? fmt(l.peakDb) : ""}
                          </td>
                          <td className="text-right tabular-nums text-muted">{l ? fmt(l.lufsM) : ""}</td>
                          <td className="pr-4 text-right tabular-nums text-muted">
                            {plan !== undefined ? fmt(plan) : "—"}
                          </td>
                          <td className="pr-3 text-right">
                            <PlayButton label={s.label} onPlay={() => audio.play(s.name)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

function ChannelChip({ c }: { c: Channel }) {
  return (
    <span className="rounded-[var(--radius-chip)] border border-[var(--line-soft)] px-1.5 py-0.5 text-12 text-muted">
      {CHANNEL_LABEL[c]}
    </span>
  );
}

function PlayButton({ label, onPlay }: { label: string; onPlay: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Play ${label}`}
      onClick={() => {
        void audio.resume().then(onPlay);
      }}
      className="hit inline-grid h-8 w-8 place-items-center rounded-[var(--radius-control)] text-brass hover:bg-raised hover:text-brass-bright"
    >
      <Play size={15} aria-hidden />
    </button>
  );
}
