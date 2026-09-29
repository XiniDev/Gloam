import { type AudioSync, DEFAULT_CAMPAIGN_AUDIO, type MusicState } from "@gloam/shared/protocol";
import { assetUrl } from "../../net/assets.ts";
import { clockOffset, localNow, serverNow } from "../../net/clock.ts";
import { audio } from "../engine.ts";
import { genIR } from "../synth.ts";
import { drift, genBar, type NoteEvent, PRESETS } from "./gen.ts";
import { playVoice, type Started, shimmer } from "./voices.ts";

/**
 * The table's music (SPEC §8.17, §25.3, §25.5): what `audio.sync` says is playing, played in step with the server's
 * clock — an uploaded track on an audio element, or a generative preset from its seed — crossfading over 2 s whenever
 * it changes (preset to preset, preset to track, track to track). Every client works out the same position from
 * `startedAtServerMs` and the clock offset: a track's drift is checked every 2 s and nudged (rate 0.97/1.03 past
 * 50 ms, a seek past 500 ms); a preset schedules its notes on the audio clock mapped to the server's.
 */

const FADE = 2;

interface Source {
  key: string;
  bus: GainNode;
  /** The state moved on without changing what plays (pause, resume, a restart, volumes). */
  update(m: MusicState, a: AudioSync): void;
  stop(at: number): void;
  /** Test builds: how far it is from the server's timeline now (ms; tracks), or its schedule (presets). */
  probe(): Record<string, unknown>;
}

/** What a state plays, as an identity: a change of it crossfades. */
function keyOf(m: MusicState): string {
  if (m.kind === "preset") return `p:${m.preset}:${m.seed}`;
  if (m.kind === "track") return `t:${m.trackId}:${m.playlistId ?? ""}:${m.index}`;
  return "";
}

/** An equal-power fade of a bus's gain to 0 or 1 over `sec` from now (sound.md §4.1). */
function fade(ctx: AudioContext, g: AudioParam, to: 0 | 1, sec: number, at = ctx.currentTime): void {
  const from = g.value;
  const n = 64;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    // From wherever it is now, along a quarter sine.
    curve[i] =
      to === 1 ? from + (1 - from) * Math.sin((u * Math.PI) / 2) : from * Math.cos((u * Math.PI) / 2);
  }
  g.cancelScheduledValues(at);
  g.setValueCurveAtTime(curve, at, sec);
}

// ── An uploaded track ─────────────────────────────────────────────────────────────────────────────────────

class TrackSource implements Source {
  readonly key: string;
  readonly bus: GainNode;
  private readonly el: HTMLAudioElement;
  private readonly level: GainNode;
  private readonly node: MediaElementAudioSourceNode;
  private m: MusicState;
  private timer: ReturnType<typeof setInterval>;
  private nudging = false;
  private lastDrift = 0;

  private readonly ctx: AudioContext;
  private readonly loudness: (id: string) => number | undefined;

  constructor(ctx: AudioContext, m: MusicState, a: AudioSync, loudness: (id: string) => number | undefined) {
    this.ctx = ctx;
    this.loudness = loudness;
    this.key = keyOf(m);
    this.m = m;
    this.el = new Audio(assetUrl(m.trackId as string, "orig"));
    this.el.preload = "auto";
    this.node = ctx.createMediaElementSource(this.el);
    this.level = ctx.createGain();
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.node
      .connect(this.level)
      .connect(this.bus)
      .connect(audio.input("music") as GainNode);
    this.update(m, a);
    this.timer = setInterval(() => this.correct(), 2000);
  }

  /** Where it should be now (ms into the track). */
  private expected(): number {
    return this.m.paused ? this.m.pausedAtMs : serverNow() - this.m.startedAtServerMs;
  }

  update(m: MusicState, a: AudioSync): void {
    this.m = m;
    // The track's own volume, and its loudness evened out to −20 LUFS (at most +6 dB).
    const lufs = this.loudness(m.trackId as string);
    const norm = lufs === undefined ? 1 : Math.min(2, 10 ** ((-20 - lufs) / 20));
    this.level.gain.setTargetAtTime(
      m.volume * (a.trackVolumes[m.trackId as string] ?? 1) * norm,
      this.ctx.currentTime,
      0.05,
    );
    if (m.paused) {
      fade(this.ctx, this.bus.gain, 0, 0.3);
      setTimeout(() => {
        if (this.m.paused) this.el.pause();
      }, 320);
      return;
    }
    this.seek();
    void this.el.play().catch(() => {});
  }

  private seek(): void {
    const go = () => {
      const d = Number.isFinite(this.el.duration) ? this.el.duration : Number.POSITIVE_INFINITY;
      this.el.currentTime = Math.max(0, Math.min(this.expected() / 1000, d - 0.05));
    };
    if (this.el.readyState >= 1) go();
    else this.el.addEventListener("loadedmetadata", go, { once: true });
  }

  /** Every 2 s: nudged back into step past 50 ms, sought past 500 ms (sound.md §4.3). */
  private correct(): void {
    if (this.m.paused || this.el.paused || this.el.readyState < 2) return;
    const drift = this.el.currentTime * 1000 - this.expected();
    this.lastDrift = drift;
    if (Math.abs(drift) > 500) {
      this.seek();
      this.el.playbackRate = 1;
      this.nudging = false;
    } else if (Math.abs(drift) > 50 || (this.nudging && Math.abs(drift) > 20)) {
      this.el.playbackRate = drift > 0 ? 0.97 : 1.03;
      this.nudging = true;
    } else if (this.nudging) {
      this.el.playbackRate = 1;
      this.nudging = false;
    }
  }

  stop(at: number): void {
    clearInterval(this.timer);
    setTimeout(
      () => {
        this.el.pause();
        this.el.removeAttribute("src");
        this.el.load();
        this.node.disconnect();
        this.bus.disconnect();
      },
      Math.max(0, (at - this.ctx.currentTime) * 1000) + 50,
    );
  }

  probe() {
    return {
      kind: "track",
      trackId: this.m.trackId,
      positionMs: this.el.currentTime * 1000,
      expectedMs: this.expected(),
      driftMs: this.el.readyState >= 2 ? this.el.currentTime * 1000 - this.expected() : null,
      lastCorrection: this.lastDrift,
      rate: this.el.playbackRate,
      playing: !this.el.paused,
    };
  }
}

// ── A generative preset ──────────────────────────────────────────────────────────────────────────────────

interface Scheduled {
  layer: number;
  bar: number;
  /** When it's due on the server's clock (ms), and when this client will be heard playing it. */
  dueServerMs: number;
  heardServerMs: number;
  late: boolean;
}

/** The look-ahead scheduler (sound.md §4.3): every 25 ms, the next 100 ms (1.2 s in a hidden tab) of every layer. */
class PresetSource implements Source {
  readonly key: string;
  readonly bus: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private m: MusicState;
  private next = new Map<number, number>();
  private live = new Set<Started>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private shimmerVoice: Started | null = null;
  readonly log: Scheduled[] = [];

  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, m: MusicState) {
    this.ctx = ctx;
    this.key = keyOf(m);
    this.m = m;
    const def = PRESETS[m.preset as NonNullable<MusicState["preset"]>];
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.normalize = true;
    reverb.buffer = genIR(ctx, def.rt60, m.seed % 100_000);
    this.dry.connect(this.limiter);
    this.wet.connect(reverb).connect(this.limiter);
    this.limiter.connect(this.bus).connect(audio.input("music") as GainNode);
    this.update(m);
  }

  /** The server's time at which the audio frame now leaving the speakers was due, and that frame's ctx time. */
  private clock(): { serverHeard: number; ctxTime: number } {
    const ts = this.ctx.getOutputTimestamp?.();
    const offset = clockOffset() ?? 0;
    if (ts?.performanceTime && ts.contextTime !== undefined)
      return { serverHeard: performance.timeOrigin + ts.performanceTime + offset, ctxTime: ts.contextTime };
    const latency = (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0);
    return { serverHeard: localNow() + offset, ctxTime: this.ctx.currentTime + latency };
  }

  update(m: MusicState): void {
    const restarted = m.startedAtServerMs !== this.m.startedAtServerMs || m.paused !== this.m.paused;
    this.m = m;
    if (m.paused) {
      fade(this.ctx, this.bus.gain, 0, 0.3);
      this.halt(this.ctx.currentTime + 0.35);
      return;
    }
    if (restarted || !this.timer) this.begin();
  }

  /** From where the timeline is now: each layer back by its look-back (sustained notes come in part-way). */
  private begin(): void {
    this.halt(this.ctx.currentTime + 0.05);
    const def = PRESETS[this.m.preset as NonNullable<MusicState["preset"]>];
    const { serverHeard } = this.clock();
    const tauNow = (serverHeard - this.m.startedAtServerMs) / 1000;
    for (const l of def.layers)
      this.next.set(l.id, Math.max(0, Math.floor(tauNow / def.barSec) - l.lookback));
    if (this.m.preset === "wonder") {
      const out = { dry: this.dry, wet: this.wet, drift: (t: number) => this.driftAt(t) };
      this.shimmerVoice = shimmer(this.ctx, audio, out, this.ctx.currentTime);
    }
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }

  private driftAt(ctxTime: number): Record<string, number> {
    const { serverHeard, ctxTime: now } = this.clock();
    const tau = (serverHeard + (ctxTime - now) * 1000 - this.m.startedAtServerMs) / 1000;
    return drift(this.m.preset as NonNullable<MusicState["preset"]>, this.m.seed, tau);
  }

  private tick(): void {
    const preset = this.m.preset as NonNullable<MusicState["preset"]>;
    const def = PRESETS[preset];
    const { serverHeard, ctxTime } = this.clock();
    const tauNow = (serverHeard - this.m.startedAtServerMs) / 1000;
    const toCtx = (tau: number) => ctxTime + (tau - tauNow);
    // Ahead of what the context is rendering now (which is ahead of what's heard by the output latency).
    const horizon = tauNow + (this.ctx.currentTime - ctxTime) + (document.hidden ? 1.2 : 0.1);
    const out = { dry: this.dry, wet: this.wet, drift: (t: number) => this.driftAt(t) };
    for (const l of def.layers) {
      let bar = this.next.get(l.id) ?? 0;
      while (bar * def.barSec < horizon) {
        for (const e of genBar(preset, this.m.seed, l, bar)) this.play(l.id, bar, e, def.barSec, toCtx, out);
        bar++;
      }
      this.next.set(l.id, bar);
    }
  }

  private play(
    layer: number,
    bar: number,
    e: NoteEvent,
    barSec: number,
    toCtx: (tau: number) => number,
    out: Parameters<typeof playVoice>[2],
  ): void {
    const tau = bar * barSec + e.t;
    const when = toCtx(tau);
    const v = playVoice(this.ctx, audio, out, e, when);
    if (v) {
      this.live.add(v);
      setTimeout(() => this.live.delete(v), Math.max(0, (when - this.ctx.currentTime + e.dur + 1) * 1000));
    }
    if (__GLOAM_TEST__) {
      const { serverHeard, ctxTime } = this.clock();
      this.log.push({
        layer,
        bar,
        dueServerMs: this.m.startedAtServerMs + tau * 1000,
        heardServerMs: serverHeard + (Math.max(when, this.ctx.currentTime) - ctxTime) * 1000,
        late: when < this.ctx.currentTime,
      });
      if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    }
  }

  private halt(at: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const v of this.live) v.stop(at);
    this.live.clear();
    this.shimmerVoice?.stop(at);
    this.shimmerVoice = null;
  }

  stop(at: number): void {
    this.halt(at);
    setTimeout(() => this.bus.disconnect(), Math.max(0, (at - this.ctx.currentTime) * 1000) + 100);
  }

  probe() {
    return { kind: "preset", preset: this.m.preset, seed: this.m.seed, scheduled: this.log.slice(-200) };
  }
}

// ── The player ───────────────────────────────────────────────────────────────────────────────────────────

class MusicPlayer {
  private state: AudioSync = DEFAULT_CAMPAIGN_AUDIO;
  private current: Source | null = null;
  private loudness = new Map<string, number>();

  /** A track's measured loudness (from its asset record). */
  setLoudness(trackId: string, lufs: number | undefined): void {
    if (lufs !== undefined) this.loudness.set(trackId, lufs);
  }

  apply(next: AudioSync): void {
    this.state = next;
    this.play();
  }

  /** Plays what the state says (again once audio unlocks, or once the clock is known). */
  play(): void {
    const ctx = audio.ensure();
    if (!ctx || ctx.state !== "running" || clockOffset() === null) return;
    const m = this.state.music;
    const key = keyOf(m);
    if (this.current && this.current.key === key) {
      this.current.update(m, this.state);
      if (!m.paused) fade(ctx, this.current.bus.gain, 1, 0.3);
      return;
    }
    // Something else: the old one fades out over 2 s as the new one fades in.
    const old = this.current;
    if (old) {
      fade(ctx, old.bus.gain, 0, FADE);
      old.stop(ctx.currentTime + FADE + 0.05);
    }
    this.current = null;
    if (!key) return;
    const src =
      m.kind === "preset"
        ? new PresetSource(ctx, m)
        : new TrackSource(ctx, m, this.state, (id) => this.loudness.get(id));
    if (!m.paused) fade(ctx, src.bus.gain, 1, FADE);
    this.current = src;
  }

  probe(): Record<string, unknown> | null {
    return this.current?.probe() ?? null;
  }
}

export const music = new MusicPlayer();
