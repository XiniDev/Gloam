# R4 — Sound research

Phase 0 research task R4 (SPEC §32). Scope: SPEC §8.9 (dice sound), §8.17 (audio and music), §25 (audio engine),
§27.1 (art direction: "wooden, papery and metallic, never app-like") and §31 (sound event table).
Written 2026-09-27. Only this file was written. Nothing was installed, nothing in the repo was edited, nothing was committed.

**How the numbers were produced.** Every ZzFX array below was rendered through the real `ZZFX.buildSamples` from the
`zzfx@1.3.2` npm tarball, at 48 kHz, using `.call({ sampleRate: 48000, volume: 1 })`. Every Web Audio ("WA") graph was
rendered with a small offline mock (scratchpad only, not committed). The mock uses the Web Audio spec's BiquadFilterNode
formulas, Q semantics, ConvolverNode normalisation and envelope semantics, plus the Noisehack noise generators. Levels were
then measured:

- **peak**: sample peak, linear and dBFS, at the channel input.
- **LUFS-M**: BS.1770 K-weighted momentary loudness, maximum over 400 ms windows (48 kHz coefficients).
- **HPF250 Δ**: loudness lost when the sound is played through a 4th-order 250 Hz high-pass. This stands in for a
  phone or laptop speaker.

The mock uses naive (aliasing) oscillators and fixed noise segments, so expect ±1.5 dB in a browser. §6.7 gives the
runtime calibration that makes the table values exact.

---

## 0. Findings that change or sharpen the SPEC

Record these in `docs/DECISIONS.md`. Items marked ✱ agree with R3's `docs/research/stack.md` deviation 45.

1. ✱ **`zzfxG` does not exist in zzfx 1.3.2.** SPEC §25.2 says "`zzfxG(...params)`". The npm module exports only `zzfx`,
   `ZZFX` and `ZZFXSound`. The generator is `ZZFX.buildSamples(...)`.
2. ✱ **Importing zzfx creates an `AudioContext` at module evaluation** (`audioContext: new AudioContext`,
   `ZzFX.js:62`). This throws `ReferenceError` in Vitest/Node and Web Workers. In a browser it opens a second context.
   Before a gesture that context is created "suspended" (Chrome autoplay policy). Vendor `buildSamples` (details in §1.5).
3. **`buildSamples` bakes `ZZFX.volume = 0.3` into the samples** (`volume *= this.volume`, `ZzFX.js:165`).
   `playSamples` then applies the same 0.3 a second time. Every array in this document assumes a scale of 1. Upstream
   `master` removed the baked scale on 2026-09-03 (commit `a209de1`). That is not in 1.3.2.
4. **ZzFX's `filter` parameter is not in Hz.** The biquad uses `w = 2π·|filter|·2/fs`, so the real cutoff is
   **2 × |filter| Hz**, with a fixed resonance Q = 2 (+6.3 dB peak). Positive values give a high-pass, negative values a
   low-pass. The designer UI labels it "(Hz)". This was verified numerically: `filter: -1000` peaks at 1.87 kHz and is
   +6.0 dB at 2 kHz.
5. **Web Audio's `DynamicsCompressorNode` adds automatic make-up gain.** The spec computes `(1 / curve(1.0))^0.6`.
   With the §6.2 settings that is about +4 dB on everything below threshold. The node also adds a fixed 6 ms pre-delay.
   Add a measured trim after it (§6.2).
6. **Karplus–Strong cannot be a `DelayNode` feedback loop for Tavern's register.** In a cycle the spec clamps `delayTime`
   to at least one render quantum (128 frames). That caps the pitch at 375 Hz at 48 kHz, and the arpeggios reach E5,
   659 Hz. Render KS offline into cached `AudioBuffer`s (§4.5). Tuning was verified to within 0.2 cents.
7. **Low-frequency events vanish on phone and laptop speakers.** Before the fix, thumps and drums lost 17–24 LU through
   the 250 Hz high-pass. Every sub-heavy recipe below now carries a tanh "exciter" harmonic layer, which brings the loss
   to 7–14 LU. Keep that rule for new recipes.
8. **The Tavern hearth preset needs a seventh ambience layer, "murmur"** (crowd). §8.17 names it as part of the preset,
   but AC-AUD-03 counts six layers. Add `murmur` as a seventh slider rather than hiding it inside `fire`.
9. **Uploaded tracks need loudness normalisation** before they crossfade with generative presets. A commercially mastered
   file (about −8 to −10 LUFS) would jump 10–12 LU against the presets (about −20 LUFS). Measure integrated LUFS once
   at upload in the DM's browser (§6.3).
10. **Anything that must stay in sync must not use a free-running `OscillatorNode` LFO.** Its phase cannot match a late
    joiner's. Compute modulation from musical time τ, or start an LFO from a phase-shifted `PeriodicWave` (§4.3).

---

## 1. ZzFX 1.3.2 — verified facts

### 1.1 Provenance

| Item | Value |
|---|---|
| Tarball | `https://registry.npmjs.org/zzfx/-/zzfx-1.3.2.tgz` |
| SHA-1 | `e3cee96e5405b05cfd641727e291804a5082220d`, which matches the registry `dist.shasum` |
| Published | 2025-09-17 13:48:34 UTC (`_npmOperationalInternal.tmp`) |
| Licence | MIT (`package.json`, and the header of `ZzFX.js`) |
| `main` | `ZzFX.js` (ES module with `export`). There is no `exports`, `module` or `types` field. |
| Files | `ZzFX.js`, `ZzFXMicro.js`, `ZzFXMicro.min.js`, `wav.js`, `index.html` (designer), `README.md`, `LICENSE`, icons |
| Matching GitHub source | `ZzFX.js` is identical, after CRLF normalisation, to commit `c41a2f907e89e1afd74f2b169d61f3c6a87c47a8` (2025-09-17 13:48:00 Z, "added square wave shape with duty cycle"): <https://github.com/KilledByAPixel/ZzFX/blob/c41a2f907e89e1afd74f2b169d61f3c6a87c47a8/ZzFX.js> |
| Drift warning | GitHub `master` (`a209de1`, 2026-09-03) still says "v1.3.2" in its header, but the code differs: the volume is no longer baked, `gainNode` is exposed, and the square wave is written differently. The repo tags are `v2.x` and do not match npm versions. **Pin to the npm tarball, not to GitHub master.** |

### 1.2 Exports (`ZzFX.js`)

| Export | What it is |
|---|---|
| `zzfx(...params)` | Calls `ZZFX.play`, which builds the samples and plays them immediately on ZZFX's own context. **Do not use it in Gloam**, because it bypasses the channel gains. |
| `ZZFX.volume` | `0.3`. This is a master scale, and it is **also baked into `buildSamples`**. |
| `ZZFX.sampleRate` | `44100` |
| `ZZFX.audioContext` | `new AudioContext`, created **at import time** |
| `ZZFX.play(...params)` | `playSamples([buildSamples(...params)])` |
| `ZZFX.playSamples(channels, volumeScale=1, rate=1, pan=0, loop=false)` | Creates a buffer and a `BufferSource`, then `StereoPannerNode → GainNode(volume·volumeScale) → destination`. |
| `ZZFX.buildSamples(...params)` | Returns a mono `number[]` at `this.sampleRate`, scaled by `this.volume`. |
| `ZZFX.getNote(semitoneOffset=0, root=440)` | `root · 2^(n/12)` |
| `class ZZFXSound(params)` | Takes `randomness` out of `params[1]`, sets it to 0, and caches the samples. `play(volume, pitch, randomnessScale, pan, loop)` varies `playbackRate` by ±randomness. |

`zzfxG`, `zzfxP`, `zzfxX`, `zzfxR` and `zzfxV` are **not** exported. `zzfxV` (volume) and `zzfxX` (AudioContext) appear only
as non-exported `const`s in `ZzFXMicro.js`, which the README header labels v1.3.1 and the file itself labels v1.3.2.
`zzfxG`, `zzfxP` and `zzfxR` were names from older ZzFX versions and exist nowhere in 1.3.2.

### 1.3 Parameter order and defaults (1.3.2)

Source: `ZzFX.js` lines 101–124 (the signature) and 126–222 (the DSP). Units come from the designer's `BuildSetting`
help strings (`index.html` lines 261–281). The column "verified behaviour" was measured by rendering.

| # | Name | Default | Unit | Verified behaviour |
|---|---|---|---|---|
| 0 | `volume` | 1 | scale | Multiplied by `this.volume` (0.3), so the default peak is 0.3. |
| 1 | `randomness` | 0.05 | fraction | Frequency × U(1−r, 1+r) through `Math.random()`, so it is **not deterministic**. Use 0 and vary `playbackRate` instead. |
| 2 | `frequency` | 220 | Hz | Exact for sine, triangle, saw and square. `tan` (shape 3) sounds at **2×**. |
| 3 | `attack` | 0 | s | 0 is replaced by 9 samples (anti-pop). |
| 4 | `sustain` | 0 | s | Held at `sustainVolume`. |
| 5 | `release` | 0.1 | s | Linear fall from `sustainVolume` to 0. |
| 6 | `shape` | 0 | enum | 0 sine, 1 triangle, 2 saw, 3 tan (clipped), 4 noise `sin(t³)` (chaotic, broadband after a few ms), 5 square with duty = `shapeCurve/2`. |
| 7 | `shapeCurve` | 1 | exp | `sign(s)·|s|^curve`: below 1 is squarer (more odd harmonics), above 1 is pointier. For shape 5 it is the duty cycle (0–2). |
| 8 | `slide` | 0 | ×500 Hz/s | Measured: `slide=1` gives +495 Hz/s. Frequency **can go negative** (the phase runs backwards). |
| 9 | `deltaSlide` | 0 | ×500 Hz/s² | Measured: `deltaSlide=1` over 1 s moves 400 Hz to 640 Hz (predicted 650). |
| 10 | `pitchJump` | 0 | Hz, additive | Applied once at `pitchJumpTime`. With `repeatTime` it **accumulates** each repeat, giving a linear Hz staircase, not musical intervals. |
| 11 | `pitchJumpTime` | 0 | s | Measured: `pitchJump=200@0.25` moves 390 Hz to 590 Hz. |
| 12 | `repeatTime` | 0 | s | Every period resets frequency and slide and re-arms pitchJump. It also sets the tremolo rate. |
| 13 | `noise` | 0 | fraction | Phase jitter `t += f·(1 + noise·sin(i⁵))`. Deterministic, and roughens tones into "texture". |
| 14 | `modulation` | 0 | Hz | `f·cos(2π·mod·t)`: **full-depth FM** (instantaneous frequency sweeps ±f). Not a subtle vibrato. |
| 15 | `bitCrush` | 0 | ×100 samples | Sample-and-hold every `bitCrush·100` samples, so it depends on the sample rate. |
| 16 | `delay` | 0 | s | A recursive echo with ½ feedback. Output is `s/2 + echo/2`. Adds `delay` to the length. |
| 17 | `sustainVolume` | 1 | level | ADSR sustain level. |
| 18 | `decay` | 0 | s | Falls from 1 to `sustainVolume` after the attack. |
| 19 | `tremolo` | 0 | depth 0–1 | `1 − tr + tr·sin(2π i/repeatTime)`. **Needs `repeatTime`**, which also resets pitch. |
| 20 | `filter` | 0 | "Hz" | **Cutoff = 2·|filter| Hz, Q = 2 resonant biquad. +: HPF, −: LPF** (finding 4). |

- **Length** = `attack + decay + sustain + release + delay` seconds. Verified: 150.0 ms for 10 + 50 + 20 + 30 + 40 ms.
- **Sample rate** defaults to 44 100 Hz, but every time constant scales by `this.sampleRate`. Build at the context's rate
  (usually 48 000) through `.call`.
- With `randomness = 0`, the output is bit-identical run to run, including shape 4 and `noise`. Verified.

### 1.4 Other ZzFX traps

- The header says "20 controllable parameters". There are 21 (`filter` was added).
- `ZZFXSound` pulls `randomness` out of index 1 **by mutating the caller's array** (`zzfxSound[1] = 0`). Do not share
  recipe arrays with it.
- `Math.sin(i**5)` for large `i` goes through the engine's `sin` argument reduction. Results can differ between V8 and
  JavaScriptCore in the last bits. That is harmless for SFX, but never use ZzFX output for anything that must be synced.

### 1.5 Recommended integration

Vendor `buildSamples` verbatim into `packages/web/src/audio/zzfx.ts`, keeping the MIT header and citing the 1.3.2
tarball SHA-1. Make one change only: replace `volume *= this.volume` with nothing, so the master scale is 1.
Add a Vitest parity test against the pinned npm package: stub `globalThis.AudioContext` before a dynamic import, then
compare with `ZZFX.buildSamples.call({ sampleRate, volume: 1 }, …p)`. Keep `zzfx` as a **devDependency** for that test.

```ts
// packages/web/src/audio/sfx.ts (sketch)
import { buildSamples } from "./zzfx"; // vendored 1.3.2, master scale 1
type Layer = { at: number; params: number[] };           // at = ms offset inside the recipe
export function renderZzfx(ctx: BaseAudioContext, layers: Layer[]): AudioBuffer {
  const parts = layers.map(l => ({ off: Math.round(l.at / 1000 * ctx.sampleRate), s: buildSamples(l.params, ctx.sampleRate) }));
  const len = Math.max(...parts.map(p => p.off + p.s.length));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate), ch = buf.getChannelData(0);
  for (const p of parts) for (let i = 0; i < p.s.length; i++) ch[p.off + i] += p.s[i];
  return buf; // cache once per recipe at startup (or lazily on first use)
}
```

---

## 2. Event recipes (SPEC §31)

### 2.0 Conventions

**Level plan.** "Peak" is the sample peak at the channel input with the channel at unity. The mix hierarchy (§6.3) is:

| Class | Peak | LUFS-M |
|---|---|---|
| Hero effects | −6 to −8 dBFS | about −18 to −20 |
| Standard effects | −9 to −14 dBFS | about −22 to −27 |
| UI notifications | −10 to −12 dBFS | about −24 to −28 |
| UI ticks | −16 to −23 dBFS | −30 or lower |
| Dice | ≤ −10 dBFS per clack | scaled by impulse |

**Per-play variation.** Unless a row says otherwise, apply playback-rate (or frequency) × U(0.96, 1.04), which is the
SPEC's ±4%. For frequent sounds also apply gain × U(−1, +1) dB. Exceptions:

- Musical multi-layer recipes take **one factor per event**, not one per layer.
- Condition blips use ±1%, because their pitch carries meaning.
- "Your turn" uses ±1.5%, so it stays recognisable.

Details are in §6.4.

**WA notation.**

- `noise(c)`: an `AudioBufferSourceNode` looping the shared 10-s buffer of colour `c` (white, pink or brown; §3.1),
  started at a random offset so simultaneous events decorrelate.
- `sine`, `saw`, `sq`, `tri(f)`: an `OscillatorNode`. `f0 → f1 /T exp` means `exponentialRampToValueAtTime(f1, t+T)`.
- `BPF(f, Q)`: a band-pass `BiquadFilterNode` with **linear** Q.
- `LPF(f, q dB)` and `HPF(f, q dB)`: Q **in dB**, as the Web Audio spec requires. Use `−3` for a Butterworth-flat
  response. `0 dB` is RBJ Q = 1. The default `Q = 1` means +1 dB, which is slightly peaky.
- `env(A, P, τ)`: a `GainNode` doing `setValueAtTime(0,t)`, then `linearRampToValueAtTime(P, t+A)`, then
  `setTargetAtTime(0, t+A, τ)`. It reaches −60 dB at A + 6.9τ.
- `env(A, P, H, R)`: a linear attack to P, a hold of H, then a linear release over R.
- `exc(x, d, fc)`: an **exciter** for small speakers. The low layer `x` goes to a `WaveShaperNode` with curve
  `y = tanh(d·x)/tanh(d)` (2048 points, `oversample: '2x'`), then HPF(fc, −3) twice (4th order). The result is summed with
  `x` at the stated gain. Feed it the low layer **before** the output gain, at its envelope level (P ≈ 1).
- `out ×k`: the final `GainNode`. k was measured so the peak lands on the table value (§6.7 re-calibrates it at runtime).
- `@t`: start offset. Stop every source at the stated length plus 20 ms, and disconnect it on `ended`.
- Signal path after `out`: `StereoPanner(pan) → distance gain → channel gain` for board sounds (§6.5).
  UI sounds skip pan and distance.

**Why "satisfying" at all.** Several sources converge on the same principles:

- Contact-driven sound that tracks the physics you see (van den Doel et al., SIGGRAPH 2001).
- Variation plus layering against the repetition that makes listeners tune out (Jacobsen, A Sound Effect; Zúmer 2017).
- Earcon structure: timbre, register and rhythm as families, pitch contour and rhythm for members, attention through
  onset and novelty rather than loudness, notes ≥ 30 ms (Brewster, Wright & Edwards 1995, pp. 1–2).
- For fantasy sounds: magic "is more convincing if rooted in reality" (Fliniaux, A Sound Effect, 2019).
- The "juice" idea: small, immediate feedback details make interaction feel alive (Jonasson & Purho, *Juice it or lose it*).

Full citations are in §8.

---

### 2.1 Dice (channel: Dice)

Group sources: van den Doel, Kry & Pai 2001 (sound synthesised from simulated contact forces); Farnell, *Designing
Sound*, practicals "Bouncing" and "Rolling"; Jacobsen (repetition); Brewster (rhythm and accents); Dixon et al. 2014
(win sounds).

#### Die hits tray (per contact) — WA — 17–80 ms — peak 0.32 (−10 dBFS) at v = 1, scaled by v^1.5

*Why it satisfies.* Every visible bounce makes a click whose loudness **and brightness** follow the impact, so the audio
"proves" the physics. That is the premise of FoleyAutomatic, which drives synthesis from contact forces. Randomising the
filter centre on every contact avoids the machine-gun effect of identical clicks.

```
v  = impulse → [0,1] (below)
f  = U(1800, 3200) · (0.85 + 0.3·v) · mat.fMul        // harder hits are brighter
A: noise(white) → BPF(f, mat.Q) → env(0.5 ms, 1, τ = mat.τ)
B: same source  → BPF(620 Hz, 2.5) → env(0.5 ms, mat.body, τ = 1.4·mat.τ)     // the wooden tray's knock
C: mat.ring (sine partials, below)
(A + B + C) → out ×(mat.k · v^1.5) → pan(die screen x) → Dice      // HUD layer: no distance attenuation
stop at 80 ms
```

| Material (skin) | fMul | Q | τ | body | ring | k (measured) |
|---|---|---|---|---|---|---|
| resin (default) | 1.00 | 3.5 | 3.5 ms | 0.5 | — | 1.30 |
| gemstone | 1.30 | 5 | 3.5 ms | 0.5 | sine 3800 Hz env(1 ms, .20, τ 8 ms) | 0.89 |
| metal | 1.00 | 3.5 | 3.5 ms | 0.5 | sine 2500 env(1 ms, .35, τ 15 ms) + sine 6890 (2.756 × 2500, bar mode 2) env(1 ms, .12, τ 6 ms) | 0.57 |
| bone | 0.70 | 2.5 | 5 ms | 0.6 | — | 1.48 |
| obsidian | 1.15 | 4.5 | 3.5 ms | 0.5 | sine 4200 env(1 ms, .15, τ 7 ms) | 1.07 |
| **die–die** contact | ×1.25 | as skin | 2.5 ms | none | as skin | peak 0.25 (k ≈ 1.06, resin) |

The metal ring lasts about 60 ms to −35 dB, as §31 asks, and its 6890 Hz partial makes it read as metal rather than a
beep.

**Impulse mapping.** Rapier (JS) reports contact **forces** per step. The docs page confirms
`ActiveEvents.CONTACT_FORCE_EVENTS`, `setContactForceEventThreshold`, `drainContactForceEvents` and
`drainCollisionEvents((h1, h2, started) => …)`. The accessor `totalForceMagnitude()` comes from the rapier.js typings and
is **not shown on the docs page**, so R3/S3 should verify it.

- Impulse J = F · (1/120 s).
- Self-calibrate from each die's mass: `J_ref = m · √(2 · 981 · 10) · (1 + 0.3)`, which is a 10 cm drop at restitution
  0.3 in world units (cm).
- Set `J_max = J_ref` and `J_min = J_ref / 20`.
- `v = clamp(ln(J/J_min) / ln(J_max/J_min), 0, 1)`.
- Refine J_min and J_max from S3 logs: the 5th and 99th percentile of onset impulses.

**Onset rules.** These matter because resting dice report force on every step.

- Trigger on a collision `started` event, taking that step's force.
- Also re-trigger during contact when the force jumps more than 3× over the previous step (edge catches while sliding).
- Keep at least 25 ms between clacks for the same die.
- Ignore v < 0.05.
- Cap at 16 simultaneous clack voices and steal the quietest.
- Distinguish tray colliders (floor and walls) from die colliders to choose the die–die variant.

#### Die rolls/slides — WA — continuous — peak ≤ 0.06 (−24 dBFS)

*Why.* A quiet continuous friction bed fills the gaps between discrete clacks, so a tumble sounds like one object moving
rather than a string of clicks. Farnell models rolling as continuous excitation modulated by rotation ("Rolling"
practical).

```
noise(brown) → HPF(80, −3) → LPF(700, −3) → gain g(t) → out ×0.08 → Dice        (one shared voice per throw)
ω_i = 2·acos(min(1, |q_t · q_{t−1}|)) / Δt     // angular speed from the recorded quaternions (§18.4 records pose, not ω)
s   = Σ_i∈floor-contact min(1, ω_i / 20 rad/s);  g target = min(1, s/2)
g.setTargetAtTime(target, t, 0.03);  stop 150 ms after the last die sleeps
```

"Floor contact" means the die's centre is below 1.2 × its resting height. The measured LUFS-M at full speed is −38.5.

#### Dice settle — ZzFX — 30 ms — peak 0.10 (−20 dBFS)

*Why.* One small tick marks closure: the "done" beat that tells you to read the number. The silence after it lets the
result land. Brewster allows notes down to 0.03 s for one- or two-note earcons.

```js
[.107, 0, 1400, 0, 0, .026, 1, 1, -4, 0, 0, 0, 0, .15, 0, 0, 0, .3, .004, 0, 0]
```

Triangle at 1.4 kHz with a slight downward slide (−60 Hz), a phase-noise roughness of 0.15 (wood, not a beep), and a
4 ms decay to 0.3 followed by a 26 ms release. Play it once per die as it sleeps, at least 40 ms apart, with the last die
+1 dB.

#### Natural 20 — ZzFX (layered) — 1.23 s — peak 0.42 (−7.5 dBFS), LUFS-M −18.2

*Why.* A rising arpeggio reads as reward. Brewster: accent the first note and lengthen the last. The inharmonic partial
(2.756× is the second free–free bar mode) makes it a struck-metal chime in the brass palette. Win sounds measurably raise
arousal and make wins feel more frequent (Dixon et al. 2014). Nat 20s are only 5% of d20 rolls, so this is the right
place for a hero sound. Keep it short and never loop it.

```js
// one cached buffer: mix layers at offsets (ms); apply ONE ±4 % rate factor to the whole event
[{at:0,   p:[.41, 0, 1046.5, .002, .03, .45, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, .07, .5, .03, 0, 0]},   // C6
 {at:0,   p:[.09, 0, 2884.154, .001, 0, .12, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .02, 0, 0]},  //   partial ×2.756
 {at:65,  p:[.328, 0, 1318.51, .002, .03, .45, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, .07, .5, .03, 0, 0]}, // E6
 {at:65,  p:[.074, 0, 3633.8136, .001, 0, .12, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .02, 0, 0]},
 {at:130, p:[.349, 0, 1567.98, .002, .03, .45, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, .07, .5, .03, 0, 0]}, // G6
 {at:130, p:[.074, 0, 4321.3529, .001, 0, .12, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .02, 0, 0]},
 {at:195, p:[.41, 0, 2093, .002, .03, .9, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, .07, .5, .03, 0, 0]},      // C7, longest
 {at:195, p:[.09, 0, 5768.308, .001, 0, .2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .02, 0, 0]},
 {at:180, p:[.074, 0, 2000, .04, .15, .55, 4, 1, 0, 0, 0, 0, .035, 0, 0, 0, 0, 1, 0, .8, 3500]}]    // sparkle tail
```

The notes are sines with a 70 ms recursive echo (`delay`) for shimmer. The sparkle is noise high-passed at **7 kHz**
(`filter` 3500 × 2) with 29 Hz tremolo (`repeatTime` 0.035). The arpeggio is **four separate notes**, not
`pitchJump`/`repeatTime`: ZzFX jumps are linear in Hz, so C–E–G–C cannot be made exactly.

#### Natural 1 — ZzFX (2 layers) — 600 ms — peak 0.30 (−10.5 dBFS), LUFS-M −23.3

*Why.* A falling contour reads as failure, and a comic "deflate" softens the sting. Keep it quieter and shorter than the
nat 20 so the fumble isn't punishing.

```js
[{at:0, p:[.113, 0, 196, .02, .18, .4, 2, 1, -.2, -.5, 0, 0, 0, .1, 0, 0, 0, 1, 0, 0, -450]},
 {at:0, p:[.079, 0, 198, .02, .18, .4, 2, 1, -.2, -.5, 0, 0, 0, .1, 0, 0, 0, 1, 0, 0, -450]}]  // +17.6 c detune = brassy
```

Measured pitch: 190 Hz at 0–50 ms, 160 Hz at 250 ms, 100 Hz at 540 ms. The accelerating droop comes from `deltaSlide`.
The saw is low-passed at 900 Hz (`filter −450`, resonant).

---

### 2.2 Turns and the lobby (channel: UI)

Group sources: Brewster et al. 1995 (earcon families; attention through onset and pitch rather than intensity; narrow
intensity range); Farnell ("Creaking" practical: stick-slip friction exciting wood resonances); Russell (free–free bar
modes).

#### Your turn — WA — 1.6 s — peak 0.25 (−12 dBFS), LUFS-M −23.8; rate variation ±1.5%

*Why.* It must be noticed without being alarming. Brewster recommends getting attention through a new sound, rapid onset
and pitch rather than loudness. A struck bell with an inharmonic partial and a striker click reads as an object, not a
notification. Sync it with the brass-ring sweep (§27.5).

```
sine 660 → env(3 ms, 1.0, τ 260 ms)            // −40 dB at ≈1.2 s
sine 990 → env(3 ms, 0.6, τ 200 ms)            // the fifth
sine 1819 (660·2.756) → env(3 ms, 0.2, τ 50 ms) // metallic strike partial
noise(white) → HPF(2000, −3) → env(0.5 ms, 0.3, τ 1.5 ms)   // striker click
sum → out ×0.151 → UI;  reverb send 0.25 (§6.1 SFX reverb)
```

Also duck the Music channel by 4 dB for 1.5 s (§6.6).

#### Turn passes (others) — ZzFX — 41 ms — peak 0.08 (−22 dBFS)

*Why.* Other players' turns are frequent and low priority. A quiet atonal wooden tick keeps awareness without competing.
It should be the quietest UI sound.

```js
[.085, 0, 740, 0, 0, .035, 1, 1, -3, 0, 0, 0, 0, .3, 0, 0, 0, .25, .006, 0, 0]
```

#### Knock (lobby) — WA — 400 ms — peak 0.30 (−10.5 dBFS), LUFS-M −28.0, HPF250 Δ −9.0

*Why.* A two-knock rhythm is recognised instantly (rhythm is the strongest earcon differentiator) and it is diegetic: the
doorway metaphor. The DM must notice it, so it is the loudest UI sound.

```
knock(k, g) @t:   f = 140k → 100k /40 ms exp;   every P below × g
  low  = sine f → env(1 ms, 1, τ 25 ms);   low + exc(low, 4, 200 Hz)×1.0
  sine 2f → env(1 ms, .25, τ 25 ms)
  noise(white) → BPF(1200k, 1.5) → env(0.3 ms, .5, τ 3 ms)        // knuckle click
  noise(white) → BPF(250k, 4) → env(1 ms, .8, τ 30 ms)            // door-panel modes (Farnell's door
  noise(white) → BPF(395k, 4) → env(1 ms, .6, τ 30 ms)            //  formants 250 / 395 Hz)
knock(1, 1) @0 + knock(0.97, 0.8) @180 ms → out ×0.282 → UI
```

Duck music as for "Your turn".

#### Admitted — WA — 900 ms — peak 0.25 (−12 dBFS), LUFS-M −26.1

*Why.* A creak and a latch close the doorway metaphor with a physical "you're in". The creak follows Farnell's
stick-slip model: friction pulses at a force-dependent rate excite the door body's formants. Farnell's SuperCollider port
lists formants at 62.5, 125, 250, 395, 560 and 790 Hz with Q 1, 1, 2, 2, 3 and 3.

```
creak(D=0.6 s, seed):
  rate(t) = 24-point curve: 38 → 90 Hz (at 55 % of D) → 55 Hz, each point × (1 ± 15 %) from seeded PRNG
  saw rate(t) → [BPF 250 Q2 ×1, BPF 395 Q2 ×.8, BPF 560 Q3 ×.6, BPF 790 Q3 ×.4] (parallel, summed)
  noise(pink) → BPF(900 → 1600 (55 %) → 1200 Hz exp, Q 12) ×0.5        // the squeal
  sum → env(A 60 ms, P 1, H D−210 ms, R 150 ms)
latch @620 ms: noise(white) → BPF(3000, 5) → env(0.2 ms, .6, τ 1.5 ms) at +0 and +25 ms; sine 110 → env(1 ms, .5, τ 30 ms) at +25 ms
creak + latch → out ×0.165 → UI
```

---

### 2.3 Tokens, movement and doors (channel: Effects)

Group sources: Zúmer 2017 (variations, and randomised pitch, volume and pan); Jacobsen (odd samples break pattern
masking; repetition breeds fatigue); Farnell (footsteps modelled from ground-reaction force, heel then ball; stick-slip
door creak).

#### Token pick up / put down — ZzFX — 47 / 63 ms — peak 0.07 / 0.10

*Why.* It gives tactile confirmation of direct manipulation. The pick-up rises and is lighter; the put-down falls and is
firmer, so the pair brackets the drag like handling a real mini on felt. The low, muffled, phase-noisy timbre keeps it
from sounding like a UI click.

```js
[.074, 0, 260, .002, 0, .035, 0, 1, 2, 0, 0, 0, 0, 1.2, 0, 0, 0, .35, .01, 0, -700]   // pick up: +47 Hz lift, LPF 1.4 kHz
[.094, 0, 170, .001, 0, .05, 0, .5, -1.5, 0, 0, 0, 0, 1.2, 0, 0, 0, .35, .012, 0, -700] // put down: squarer (curve .5) for small speakers
```

#### Footsteps (every 5 ft) — ZzFX — 94 ms — peak 0.10 (−20 dBFS), HPF250 Δ −11.8

*Why.* Footsteps are the most repeated sound, so they must be quiet, low and varied. Alternating feet adds gait, which
Farnell derives from heel-then-ball ground-reaction force. Immediate identical repeats are what listeners notice first.

```js
[.097, 0, 105, .004, 0, .07, 0, .4, -.6, 0, 0, 0, 0, 2, 0, 0, 0, .45, .02, 0, -450]
```

- Per step: rate × U(0.92, 1.08), a wider range than the default because §31 asks for "random pitch".
- Alternate feet: odd steps × 0.94.
- Gain ± 2 dB.
- Pan and distance follow the token's current position along the path.
- Cap all footsteps to 8 per second.

The sine uses `shapeCurve .4`, which is near-square and adds harmonics at 315 and 525 Hz so it survives laptop speakers.
Without that the 250 Hz high-pass loss was 20 LU.

#### Door open / close — WA — 700 / 350 ms — peak 0.30 / 0.35

*Why.* It is diegetic confirmation for everyone that a wall state changed. Creak versus thud lets people tell open from
closed without looking.

```
open:  creak(D = 0.7 s, seed = door id) → out ×0.196 → pan/dist → Effects                  (LUFS-M −24.3)
close: f = 110 → 60 Hz /100 ms exp; low = sine f → env(2 ms, 1, τ 70 ms); low + exc(low, 4, 200)×1.2
       + sine 2f → env(2 ms, .3, τ 70 ms)
       + noise(brown) → LPF(400, −3) → env(2 ms, 1.2, τ 50 ms)
       + latch (as Admitted) ×0.4 @60 ms
       → out ×0.234 → pan/dist → Effects                                                   (LUFS-M −26.8, Δ −11.1)
```

Seed the creak's jitter with the door id: each door gets its own consistent "voice", but it differs between doors.

#### Locked door rattle — WA — 250 ms — peak 0.20 (−14 dBFS)

*Why.* An irregular triple metallic rattle says "tried, blocked". Its rhythm differs from knocks, and it sits below the
open sound in level.

```
click(t, g, k): noise(white) → BPF(3000k, 6) → env(0.3 ms, g, τ 4 ms)  +  → BPF(4700k, 8) → env(0.3 ms, .6g, τ 4 ms)
click(0, 1, 1) + click(70 ms, .8, 1.06) + click(125 ms, .9, .95)
+ sine 140 → env(1 ms, .5, τ 25 ms) + sine 280 → env(1 ms, .15, τ 25 ms)      // latch bolt against the frame
→ out ×0.272 → pan/dist → Effects
```

---

### 2.4 Combat, HP and conditions

Group sources: Zúmer (layering: impact, body, tail); Jacobsen; Brewster (earcon families for conditions); Chowning 1973
(percussive envelopes). The HPF250 measurements are this document's own.

#### Melee hit — ZzFX (3 layers) — 172 ms — peak 0.40 (−8 dBFS), Δ −9.3 — Effects

*Why.* Punch comes from layering a noisy contact transient, a low body thump for weight and a harmonic of the thump for
small speakers. Each layer does one job.

```js
[{at:0, p:[.17, 0, 600, 0, 0, .07, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .35, .012, 0, -1400]},   // transient: noise, LPF 2.8 kHz
 {at:0, p:[.213, 0, 95, .002, .02, .12, 0, .5, -.6, 0, 0, 0, 0, .4, 0, 0, 0, .6, .03, 0, -600]}, // thump 95 → 44 Hz, squarish
 {at:0, p:[.074, 0, 190, .002, 0, .08, 0, 1, -1.2, 0, 0, 0, 0, .4, 0, 0, 0, .6, .02, 0, 0]}]  // 2nd harmonic
```

#### Damage taken — ZzFX — 170 ms — peak 0.30 (−10.5 dBFS) — Effects

*Why.* A crunch with a falling pitch reads as loss. When it follows a hit on the same target, delay it 40 ms and lower
it 3 dB so both sounds are heard.

```js
[.971, 0, 360, 0, .03, .12, 2, 1, -2.2, 0, 0, 0, 0, 2.5, 0, .25, 0, .5, .02, 0, -1600]
// saw 360 → 173 Hz, heavy phase noise 2.5, bitCrush .25 (hold 25 samples ≈ 1.9 kHz grit), LPF 3.2 kHz
```

#### Heal — ZzFX (3 layers) — 710 ms — peak 0.20 (−14 dBFS), LUFS-M −23.5 — Effects

*Why.* A rising, soft, tonal sound means restoration. The slow 60 ms attack keeps it gentle, and an octave shimmer plus
sparkle gives the "warm glow".

```js
[{at:0,   p:[.237, 0, 440, .06, .12, .35, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, .08, .8, .05, 0, 0]},   // 450 → 700 Hz (measured)
 {at:0,   p:[.071, 0, 880, .08, .1, .35, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, .08, .8, .05, 0, 0]},    // parallel octave
 {at:100, p:[.024, 0, 2000, .06, .15, .4, 4, 1, 0, 0, 0, 0, .04, 0, 0, 0, 0, 1, 0, .8, 3500]}]  // sparkle, HPF 7 kHz
```

#### Down (0 HP) — WA — 1.8 s + reverb — peak 0.50 (−6 dBFS), LUFS-M −19.7, Δ −12.5 — Effects

*Why.* It is the heaviest non-spell sound. A long sub drop plus reverb gives gravity. The exciter keeps it audible on a
laptop.

```
f = 90 → 40 Hz /350 ms exp
low = sine f → env(5 ms, 1, τ 250 ms);   low + exc(low, 4, 180)×1.4
+ sine 2f → env(5 ms, .3, τ 250 ms)
+ noise(brown) → LPF(300, −3) → env(5 ms, 1.5, τ 80 ms)
→ out ×0.315 → pan/dist → Effects;   reverb send 0.35 (SFX reverb, 1.8 s)
```

#### Death save success / fail — WA — 450 / 600 ms — peak 0.30 (−10.5 dBFS) — UI

*Why.* A heartbeat means "still alive" and matches a success. A hollow knock means emptiness and matches a failure. The
two rhythms differ (two notes versus one), so each can be recognised without seeing the tracker.

```
thump(t, f0, f1, τ, g): f = f0 → f1 /60 ms exp; low = sine f → env(3 ms, g, τ); low + exc(low,4,180)×1.4
                        + sine 2f → env(3 ms, .3g, τ) + noise(brown) → LPF(200,−3) → env(3 ms, .8g, τ 40 ms)
success: thump(0, 75, 55, 70 ms, 1) + thump(150 ms, 90, 65, 50 ms, .75) → out ×0.256          (LUFS-M −25.6, Δ −13.6)
fail:    tube = noise(white) → BPF(220, 12) → env(1 ms, 1, τ 110 ms)
         tube + BPF(500, 10) → env(1 ms, .6, τ 110 ms) + exc(4·tube, 3, 250)×.5
         + sine 220 → env(1 ms, .3, τ 60 ms) + noise(white) → BPF(1500, 2) → env(0.3 ms, .3, τ 2 ms)
         → out ×0.843                                                                          (LUFS-M −26.2, Δ −6.9)
```

#### Condition applied (one per badge category) — ZzFX (2 layers each) — 60–220 ms — peak 0.10 (−20 dBFS) — UI; variation ±1%

*Why.* Brewster: give a family one shared timbre (here a sine plus a 2.756× glass partial), then separate the members by
**pitch contour and rhythm**. Listeners are poor at absolute pitch, so a pitch-only code would fail. The pitches come from
C-major pentatonic, so simultaneous badges never clash. They are at least 2 semitones apart, which ±1% variation cannot
blur. They stay within Brewster's 150 Hz–5 kHz earcon range.

| Category (§27.2 colour) | Pitch | Contour/rhythm | Main layer | Glass layer (×2.756) |
|---|---|---|---|---|
| vital `#B43A36` | C5 523 | two-step **fall** a minor third (to 440 Hz @60 ms) | `[.089, 0, 523.25, .002, .05, .12, 0, 1, 0, 0, -83.25, .06, 0, 0, 0, 0, 0, .6, .02, 0, 0]` | `[.016, 0, 1442.077, .001, 0, .05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .01, 0, 0]` |
| incapacity `#C8643B` | D5 587 | **droop** (−90 Hz slide) | `[.088, 0, 587.33, .002, .04, .12, 0, 1, -1.2, 0, 0, 0, 0, 0, 0, 0, 0, .6, .02, 0, 0]` | `[.016, 0, 1618.6815, .001, 0, .05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .01, 0, 0]` |
| body `#A67C3D` | E5 659 | short, woody (triangle, phase noise) | `[.105, 0, 659.26, .001, .02, .09, 1, 1, 0, 0, 0, 0, 0, .2, 0, 0, 0, .5, .01, 0, 0]` | `[.019, 0, 1816.9206, .001, 0, .05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .01, 0, 0]` |
| affliction `#5E9A4E` | G5 784 | **queasy** 40 Hz tremolo + phase noise | `[.096, 0, 783.99, .002, .06, .1, 0, 1, 0, 0, 0, 0, .025, .6, 0, 0, 0, .7, .02, .5, 0]` | `[.017, 0, 2160.6764, .001, 0, .05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .01, 0, 0]` |
| tactical `#56657A` | A5 880 | **single dry tick** (shortest) | `[.105, 0, 880, .001, 0, .05, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .008, 0, 0]` | `[.019, 0, 2425.28, .001, 0, .05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .01, 0, 0]` |
| senses `#4E7BC4` | C6 1047 | **echo** (50 ms `delay`) | `[.151, 0, 1046.5, .002, .02, .08, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, .05, .6, .015, 0, 0]` | `[.027, 0, 2884.154, .001, 0, .05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .01, 0, 0]` |
| mind `#8E5CC8` | D6 1175 | **wobble** (12 Hz tremolo) | `[.122, 0, 1174.66, .002, .1, .1, 0, 1, 0, 0, 0, 0, .083, 0, 0, 0, 0, .7, .02, .6, 0]` | `[.022, 0, 3237.363, .001, 0, .05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .01, 0, 0]` |
| boon `#3F9C78` | E6 1319 | two-step **rise** a fourth (to A6 1760 @50 ms) | `[.089, 0, 1318.51, .002, .05, .14, 0, 1, 0, 0, 441.49, .05, 0, 0, 0, 0, 0, .6, .02, 0, 0]` | `[.016, 0, 3633.8136, .001, 0, .05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .01, 0, 0]` |

The contours were verified by zero-crossing: vital 520 → 440 Hz, boon 1311 → 1757 Hz, incapacity 567 → 488 Hz.
If several conditions arrive in one command, play them **serially 100 ms apart**, which is Brewster's gap for compound
earcons, rather than stacking them.

---

### 2.5 Spells (channel: Effects; pan and distance at the area origin)

Group sources: Fliniaux, A Sound Effect 2019 (magic rooted in real sounds); Farnell practicals ("Fire", "Electricity",
"Thunder", "Bubbles"); Catford 2001 (vowel formants); Chowning 1973.

#### Spell cast (generic) — WA — 550 ms — peak 0.28 (−11 dBFS), LUFS-M −25.2

*Why.* A rising band-passed whoosh reads as energy gathering. It is neutral enough to precede any element, and the
damage-type sound follows on impact.

```
noise(pink) → BPF(300 → 3000 Hz /450 ms exp, Q 1.8) → env(A 150, P 1, H 50, R 300 ms) → out ×1.364
```

#### Fire — WA — 1.4 s — peak 0.50 (−6 dBFS), LUFS-M −18.8

*Why.* Farnell splits fire into lapping (low roar), crackling (sparse short resonant bursts) and hissing (high noise with
rare loud bursts). All three together read as fire.

```
roar:  noise(brown) → LPF(300 → 1800 (250 ms) → 600 Hz (1.2 s) exp, 1 dB) → env(A 250 ms, P 1, H 100 ms, τ 350 ms)
hiss:  noise(white) → HPF(2000, −3) → env(150 ms, .15, τ 300 ms)
crackle ×16: t = 1.0 s · U^1.6 (front-loaded); noise(white) → BPF(U(1500, 5000), 3) → env(0.5 ms, U(.3, 1)·.9, τ 6 ms)
→ out ×0.739
```

Farnell's SuperCollider port uses Dust at 1 Hz, 20–30 ms percussive crackles and a resonant filter of Q 20. The brighter
1.5–5 kHz, Q 3 crackle band here is a refinement for a short effect.

#### Cold — ZzFX (8 blips × 2 layers + frost) — 484 ms — peak 0.30 (−10.5 dBFS)

*Why.* Brittle, high, fast-decaying tinkles read as ice and glass. The irregular cluster timing avoids a "sequencer" feel.

```js
// pattern: blip at (ms, f, g) = main [0.263·g, 0, f, 0, 0, .07, 0, 1, 0,0,0,0,0,0,0,0,0, .35, .004, 0, 0]
//                              + partial [0.066·g, 0, f·2.756, 0, 0, .03, 0, 1, 0,0,0,0,0,0,0,0,0, .3, .003, 0, 0]
// with (ms, f, g) = (0,3520,1) (40,2637.02,.8) (85,4186.01,.7) (120,3135.96,.75) (175,4698.63,.55) (240,3951.07,.5) (320,2637.02,.4) (410,3520,.3)
[{at:0,p:[.263,0,3520,0,0,.07,0,1,0,0,0,0,0,0,0,0,0,.35,.004,0,0]},  {at:0,p:[.066,0,9701.12,0,0,.03,0,1,0,0,0,0,0,0,0,0,0,.3,.003,0,0]},
 {at:40,p:[.211,0,2637.02,0,0,.07,0,1,0,0,0,0,0,0,0,0,0,.35,.004,0,0]},{at:40,p:[.053,0,7267.6271,0,0,.03,0,1,0,0,0,0,0,0,0,0,0,.3,.003,0,0]},
 {at:85,p:[.184,0,4186.01,0,0,.07,0,1,0,0,0,0,0,0,0,0,0,.35,.004,0,0]},{at:85,p:[.046,0,11536.6436,0,0,.03,0,1,0,0,0,0,0,0,0,0,0,.3,.003,0,0]},
 {at:120,p:[.198,0,3135.96,0,0,.07,0,1,0,0,0,0,0,0,0,0,0,.35,.004,0,0]},{at:120,p:[.049,0,8642.7058,0,0,.03,0,1,0,0,0,0,0,0,0,0,0,.3,.003,0,0]},
 {at:175,p:[.145,0,4698.63,0,0,.07,0,1,0,0,0,0,0,0,0,0,0,.35,.004,0,0]},{at:175,p:[.036,0,12949.4243,0,0,.03,0,1,0,0,0,0,0,0,0,0,0,.3,.003,0,0]},
 {at:240,p:[.132,0,3951.07,0,0,.07,0,1,0,0,0,0,0,0,0,0,0,.35,.004,0,0]},{at:240,p:[.033,0,10889.1489,0,0,.03,0,1,0,0,0,0,0,0,0,0,0,.3,.003,0,0]},
 {at:320,p:[.105,0,2637.02,0,0,.07,0,1,0,0,0,0,0,0,0,0,0,.35,.004,0,0]},{at:320,p:[.026,0,7267.6271,0,0,.03,0,1,0,0,0,0,0,0,0,0,0,.3,.003,0,0]},
 {at:410,p:[.079,0,3520,0,0,.07,0,1,0,0,0,0,0,0,0,0,0,.35,.004,0,0]},  {at:410,p:[.02,0,9701.12,0,0,.03,0,1,0,0,0,0,0,0,0,0,0,.3,.003,0,0]},
 {at:0,p:[.032,0,1000,.03,.1,.3,4,1,0,0,0,0,0,0,0,0,0,1,0,0,2500]}]   // frost hiss, HPF 5 kHz
```

The pitches are E7, G7, A7, B7, C8 and D8 (2.6–4.7 kHz). Pre-render **three variants** with the (offset, pitch) pairs
permuted by a fixed seed, and rotate through them without repeating the last one.

#### Lightning — WA — 900 ms — peak 0.50 (−6 dBFS), LUFS-M −25.0

*Why.* A sharp broadband crack followed by a flickering electrical buzz. Farnell's "Electricity" practical builds on
mains-hum harmonics and arcing. The second crack sells branching. It is crack-dominated, so its loudness is lower than its
peak suggests. That is fine, because the crack is the information.

```
crack(t, g): noise(white) → HPF(1000, −3) → env(0.5 ms, g, τ 8 ms)
crack(0, 1) + crack(90 ms, .6)
buzz: (saw 60 + saw 120.5 ×.5) → HPF(150, −3) → LPF(3500, −3) × gate(t) → env(A 5 ms, P .6, H 150 ms, τ 250 ms)
      gate = seeded step curve: segments of 15–40 ms, value 0 (30 %) or U(.4, 1)
→ out ×0.447
```

#### Thunder — WA — 3.2 s — peak 0.42 (−7.5 dBFS), LUFS-M −19.8, Δ −10.7

*Why.* Several delayed, overlapping low bursts read as "rolling" thunder: sound from different parts of the channel
arrives at different times. That is the standard physical account. The contents of Farnell's "Thunder" practical were
not read. The sub sine gives weight, and the exciter keeps the roll audible on small speakers.

```
rum = noise(brown) → LPF(220 → 90 Hz /3 s exp, −3) × [env(30 ms, 1, τ .6 s) + env(80 ms, .7, τ .5 s)@350 ms + env(150 ms, .5, τ .8 s)@900 ms]
rum + exc(2·rum, 3, 150)×1.0
+ sine (60 → 42 Hz /1.5 s exp) → env(20 ms, .8, τ .8 s) + sine 2f → env(20 ms, .25, τ .8 s)
+ noise(white) → HPF(1500, −3) → env(1 ms, .4, τ 25 ms)          // the close crack; omit for "distant"
→ out ×0.291
```

#### Acid / poison — WA — 700 / 850 ms — peak 0.20 / 0.30

*Why.* Acid is a corrosive hiss, high and fizzy. Poison is a sickly low bubbling; Farnell's "Bubbles" practical uses
bubbles whose pitch rises as they form. Two variants of one event, chosen by damage type.

```
acid:   noise(white) → HPF(3000, −3) → BPF(6000, .7) → env(A 30, P 1, H 350, R 300 ms) × flutter
        flutter = seeded step curve every 25 ms, U(.5, 1)                         → out ×0.216   (LUFS-M −22.9)
poison: 12 bubbles @U(0, 700 ms): sine f0 → 1.6·f0 /d exp, f0 = U(180, 420) Hz, d = U(30, 60) ms, env(2 ms, U(.4, 1), τ d/3)
        + noise(brown) → LPF(500, −3) → env(A 50, P .3, H 500, R 200 ms)          → out ×0.276   (LUFS-M −24.1)
```

#### Necrotic — WA — 1.35 s — peak 0.30 (−10.5 dBFS), LUFS-M −23.5

*Why.* Detuned low saws with a tritone above the root produce unease. A swell-and-fade reads as life draining away.

```
saw 55·2^(−14/1200) + saw 55 + saw 55·2^(11/1200) + saw 77.78 (tritone) ×.6
→ LPF(180 → 700 (400 ms) → 150 Hz (1.3 s) exp, 6 dB) → env(A 400, P 1, H 200, R 700 ms) → out ×0.084
```

#### Radiant — WA — 1.35 s — peak 0.20 (−14 dBFS), LUFS-M −23.2

*Why.* An "ah" choir is the culturally coded holy or radiant sound. §31 suggests stacked sines, but pure sines through
formant filters carry no vowel, and sines alone sound like an organ or UI tone. So the choir is saws through /ɑ/ formants
(F1 750, F2 940 Hz, Catford 2001), plus a quiet sine shimmer that keeps the suggested fifths.

```
for f in [220, 329.63, 440, 659.26] (A3 E4 A4 E5 — fifths/octaves), for d in [−7, +7] cents:
    saw f·2^((d + 5·sin(2π·5.5 Hz·t))/1200) ×.5            // vibrato 5.5 Hz ±5 c via detune LFO
→ [BPF(750, 5) + BPF(940, 6) ×.8]  + sine 1318.51 ×.15 + sine 1760 ×.1
→ env(A 250, P 1, H 250, R 800 ms) → out ×0.231
```

#### Force — WA — 750 ms — peak 0.25 (−12 dBFS), LUFS-M −22.5, Δ −10.8

*Why.* A steady harmonic hum reads as a field, and a thump on arrival reads as impact.

```
hum: (sine 110 + 220 ×.5 + 330 ×.3 + 440 ×.15) → env(A 80, P 1, H 200, R 250 ms)
thump @300 ms: f = 85 → 45 Hz /120 ms exp; th = sine f → env(2 ms, 1, τ 90 ms); th×1.2 + exc(th, 4, 200)×1.2
               + sine 2f → env(2 ms, .36, τ 90 ms) + noise(brown) → LPF(350, −3) → env(2 ms, 1, τ 40 ms)
→ out ×0.117
```

#### Psychic — WA — 750 ms — peak 0.14 (−17 dBFS), LUFS-M −23.1

*Why.* A pitch warble that speeds up reads as mental distortion. It is purely tonal, with no noise, so it is distinct
from every physical element.

```
sine 700 · 2^(60·sin(φ₁)/1200), φ₁ rate 9 → 14 Hz over 700 ms     (±60 c vibrato, accelerating)
+ sine 1050 · 2^(40·sin(2π·7 Hz·t)/1200) ×.5                          (beats against the first)
→ env(A 100, P 1, H 350, R 300 ms) → out ×0.093
```

In Web Audio, use `OscillatorNode.detune` driven by an LFO oscillator through a gain of 60, with the LFO's `frequency`
ramped from 9 to 14.

---

### 2.6 Table flavour

Group sources: Brewster (short, rhythmically distinct earcons; spatial position helps separate simultaneous earcons);
Farnell ("Bubbles"); Russell (membrane modes).

#### Emote pop — ZzFX — 81 ms — peak 0.12 (−18 dBFS) — UI, panned to the token or portrait

*Why.* A tiny rising "bloop" (a bubble resonance) is cute and non-intrusive, and the 1.5 s rate limit keeps it from
becoming noise.

```js
[.125, 0, 380, .001, 0, .07, 0, 1, 10, 0, 0, 0, 0, 0, 0, 0, 0, .6, .01, 0, 0]    // 425 → 725 Hz (measured)
```

#### Ping — WA — 900 ms — peak 0.14 (−17 dBFS) — UI, panned and distance-attenuated

*Why.* Decaying echoes localise in stereo and imply "look here". The metallic partial keeps it in the brass palette
rather than a sonar "app" beep.

```
dry = sine 880 → env(2 ms, 1, τ 120 ms) + sine 2425 (880·2.756) → env(2 ms, .15, τ 30 ms)
dry + [Delay 180 ms → LPF(3000) → ×0.35 feedback loop] → out ×0.123
```

The loop delay of 180 ms is far above the 128-frame cycle minimum. DM Spotlight pings use the same sound +3 dB.

#### Hand raised — ZzFX — 1.07 s — peak 0.16 (−16 dBFS) — UI, DM only, once

*Why.* A single soft bell for the DM. It must not interrupt someone speaking on Discord, so it is soft and has no
rhythm.

```js
[{at:0, p:[.24, 0, 783.99, .003, .03, .9, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, .09, .45, .05, 0, 0]},
 {at:0, p:[.048, 0, 2160.6764, .001, 0, .25, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .4, .02, 0, 0]}]
```

#### Handout reveal — WA — 750 ms — peak 0.25 (−12 dBFS), LUFS-M −29.2 — UI

*Why.* A paper swish plus fine rustle reads as parchment unfurling. This is the "papery" of §27.1. Time the three
swishes to the unfurl animation.

```
swish(t, A, R, g): noise(pink) → BPF(1200 → 2400 (t+A) → 1500 Hz (t+A+R) exp, Q .9) → env(A, g, R)@t
swish(0, 80, 180, 1) + swish(150, 60, 150, .8) + swish(300, 80, 250, .6)
rustle ×40 @U(0, 600 ms): noise(white) → HPF(2500, −3) → env(0.2 ms, U(.2, .8)·(1 − t/0.8 s)·.6, τ 1 ms)
→ out ×0.465
```

#### Initiative start — WA — 1.4 s + reverb — peak 0.50 (−6 dBFS), LUFS-M −20.0, Δ −11.4 — Effects

*Why.* A war-drum double hit announces the switch into combat mode. It is the most cinematic "system" moment. The
circular-membrane modes (1, 1.593, 2.135, 2.295 × f; Russell) make it a drum rather than a sine thump. Accent the second
hit ("da-DUM").

```
hit(t, g): f = 95 → 68 Hz /60 ms exp
  low = sine f → env(1.5 ms, g, τ 220 ms);  low + exc(low, 5, 200)×1.5
  + sine 111.5 → env(1.5 ms, .5g, τ 120 ms) + sine 149.5 → env(1.5 ms, .35g, τ 80 ms) + sine 160.7 → env(1.5 ms, .25g, τ 70 ms)
  + noise(white) → BPF(900, 1.2) → env(0.5 ms, .5g, τ 12 ms)        // skin slap (small-speaker cue)
  + noise(white) → LPF(1500, −3) → env(0.5 ms, .6g, τ 25 ms)        // beater
hit(0, .8) + hit(380 ms, 1) → out ×0.30 → Effects;  reverb send 0.3
```

#### Scene travel — WA — 1.2 s — peak 0.25 (−12 dBFS), LUFS-M −23.5 — UI

*Why.* A downward whoosh matches the fade through black (the §27.5 "cinematic" 1200 ms) and marks a transition.

```
noise(pink) → BPF(1800 → 250 Hz /1.1 s exp, Q 1.2) → env(A 350, P 1, H 100, R 700 ms)
+ sine 55 → env(A 400, P .3, R 700 ms) + sine 110 → env(A 400, P .15, R 700 ms)
→ out ×0.464
```

#### Error / not allowed — ZzFX (2 clunks) — 158 ms — peak 0.12 (−18 dBFS) — UI

*Why.* A muted descending "uh-uh" of two wooden clunks is negative but not alarming. Avoid buzzers, which are the most
"app-like" sound there is.

```js
[{at:0,  p:[.124, 0, 220, .001, 0, .06, 1, .6, -1, 0, 0, 0, 0, 1, 0, 0, 0, .4, .012, 0, -700]},
 {at:75, p:[.105, 0, 175, .001, 0, .07, 1, .6, -1, 0, 0, 0, 0, 1, 0, 0, 0, .4, .012, 0, -650]}]
```

---

### 2.7 Measured summary (mock render at 48 kHz; channel at unity)

| Event | Kind | Ch | Length | Peak (dBFS) | LUFS-M | HPF250 Δ | Centroid |
|---|---|---|---|---|---|---|---|
| Die hits tray (resin / gem / metal / bone / obsidian, v = 1) | WA | Dice | 28 / 51 / 80 / 45 / 44 ms (active) | −9.9 | −35.9 / −33.1 / −30.9 / −34.5 / −33.9 | 0 | 2.5–4.2 kHz |
| Die hits die | WA | Dice | 17 ms | −12.0 | −38.7 | 0 | 4.2 kHz |
| Die rolls/slides (full) | WA | Dice | continuous | −24.4 | −38.5 | −5.3 | 258 Hz |
| Dice settle | ZzFX | Dice | 30 ms | −20.0 | −44.9 | 0 | 1.4 kHz |
| Natural 20 | ZzFX | Dice | 1227 ms | −7.5 | −18.2 | 0 | 2.8 kHz |
| Natural 1 | ZzFX | Dice | 600 ms | −10.5 | −23.3 | −3.1 | 396 Hz |
| Your turn | WA | UI | 1600 ms | −12.0 | −23.8 | −0.1 | 733 Hz |
| Turn passes | ZzFX | UI | 41 ms | −21.9 | −47.3 | −0.1 | 738 Hz |
| Knock | WA | UI | 400 ms | −10.5 | −28.0 | −9.0 | 148 Hz |
| Admitted | WA | UI | 900 ms | −12.0 | −26.1 | −4.3 | 289 Hz |
| Token pick up / put down | ZzFX | Eff | 47 / 63 ms | −23.1 / −20.0 | −43.7 / −40.3 | −4.5 / −10.6 | 302 / 175 Hz |
| Footstep | ZzFX | Eff | 94 ms | −20.0 | −37.1 | −11.8 | 122 Hz |
| Door open / close | WA | Eff | 700 / 350 ms | −10.5 / −9.1 | −24.3 / −26.8 | −4.3 / −11.1 | 295 / 105 Hz |
| Locked door rattle | WA | Eff | 250 ms | −14.0 | −35.6 | −8.0 | 649 Hz |
| Melee hit | ZzFX | Eff | 172 ms | −8.0 | −26.8 | −9.3 | 117 Hz |
| Damage taken | ZzFX | Eff | 170 ms | −10.5 | −27.3 | −8.2 | 225 Hz |
| Heal | ZzFX | Eff | 710 ms | −14.0 | −23.5 | −0.4 | 790 Hz |
| Down (0 HP), dry | WA | Eff | 1800 ms | −6.0 | −19.7 | −12.5 | 93 Hz |
| Death save success / fail | WA | UI | 450 / 600 ms | −10.5 | −25.6 / −26.2 | −13.6 / −6.9 | 92 / 274 Hz |
| Condition (8 categories) | ZzFX | UI | 61–222 ms | −20.0 | −31.7 … −41.6 | ≤ −0.6 | 0.5–1.6 kHz |
| Spell cast (generic) | WA | Eff | 550 ms | −11.1 | −25.2 | −0.3 | 1.1 kHz |
| Fire | WA | Eff | 1400 ms | −6.0 | −18.8 | −2.1 | 1.5 kHz |
| Cold | ZzFX | Eff | 484 ms | −10.5 | −24.2 | 0 | 5.3 kHz |
| Lightning | WA | Eff | 900 ms | −6.0 | −25.0 | −0.9 | 2.3 kHz |
| Thunder | WA | Eff | 3200 ms | −7.5 | −19.8 | −10.7 | 104 Hz |
| Acid / poison | WA | Eff | 700 / 850 ms | −14.0 / −10.5 | −22.9 / −24.1 | 0 / −2.2 | 8.3 kHz / 334 Hz |
| Necrotic | WA | Eff | 1350 ms | −10.5 | −23.5 | −6.0 | 189 Hz |
| Radiant | WA | Eff | 1350 ms | −14.0 | −23.2 | −0.1 | 952 Hz |
| Force | WA | Eff | 750 ms | −12.0 | −22.5 | −10.8 | 140 Hz |
| Psychic | WA | Eff | 750 ms | −17.1 | −23.1 | −0.1 | 770 Hz |
| Emote pop | ZzFX | UI | 81 ms | −18.4 | −35.9 | −0.8 | 562 Hz |
| Ping | WA | UI | 900 ms | −17.1 | −27.8 | −0.1 | 886 Hz |
| Hand raised | ZzFX | UI | 1073 ms | −15.9 | −30.0 | −0.1 | 849 Hz |
| Handout reveal | WA | UI | 750 ms | −12.0 | −29.2 | 0 | 4.9 kHz |
| Initiative start, dry | WA | Eff | 1400 ms | −6.0 | −20.0 | −11.4 | 108 Hz |
| Scene travel | WA | UI | 1200 ms | −12.0 | −23.5 | −8.0 | 140 Hz |
| Error / not allowed | ZzFX | UI | 158 ms | −18.4 | −36.1 | −8.5 | 193 Hz |

**Small-speaker rule:** no information-carrying sound may lose more than 14 LU through the HPF250 check. Before the
exciter layers, thumps lost 17–24 LU.

---

## 3. Ambience (SPEC §25.4)

Group sources: Farnell practicals ("Rain", "Wind", "Fire", "Running water", "Insects", "Bubbles"); Noisehack (noise
generation); Ding et al. 2017 (the speech modulation spectrum peaks near 5 Hz, which sets the murmur's AM rate).

### 3.1 Shared sources

- **Noise buffers.** Three mono 10-s `AudioBuffer`s (white, pink, brown), generated once at startup with a fixed seed.
  - Pink uses Paul Kellet's refined filter as published by Noisehack:
    `b0 = .99886b0 + w·.0555179; b1 = .99332b1 + w·.0750759; b2 = .969b2 + w·.153852; b3 = .8665b3 + w·.3104856;
    b4 = .55b4 + w·.5329522; b5 = −.7616b5 − w·.016898`, `out = (b0+…+b5 + b6 + w·.5362)·.11`, `b6 = w·.115926`.
  - Brown: `last = (last + .02w)/1.02; out = 3.5·last`.
  - Each layer plays its own `AudioBufferSourceNode` (`loop = true`) at a random start offset.
- **Event loops.** Droplets, crackles, bubbles and insect envelopes are **pre-rendered into loop buffers** whose lengths
  are co-prime with 10 s and with each other: 7.3 s, 9.1 s, 8.3 s and 13.7 s. That avoids scheduling thousands of nodes,
  and the combined pattern does not realign for minutes.
- **Level law.** Layer gain = `normGain × level²`, where level is the slider value 0–1. `normGain` puts level 1.0 at
  about **−24 LUFS** integrated at the Ambience channel input (measured, §3.3).

### 3.2 Layers

| Layer | Graph |
|---|---|
| **Rain** | Bed: `noise(pink) → HPF(400, −3) → LPF(9000, −3) → gain (1 + 0.15·sin(2π·0.07 Hz·t))` (gusts). Droplets: a 7.3-s loop buffer holding Poisson events at 30/s. Each is `white 4 ms → BPF(U(2.5, 7) kHz, Q 3) × env(0.1 ms, U(.2, 1)², τ 0.5 ms)`, mixed at ×3 against the bed. |
| **Wind** | `lfo(t) = 0.6·sin(2π·0.05t) + 0.4·sin(2π·0.13t + 1)` (periods 20 s and 7.7 s, so their pattern repeats every 100 s). `noise(brown) → BPF(fc = 350·2^(1.5·lfo) Hz (125–990 Hz), Q 3)` plus a whistle `BPF(4·fc, Q 10) ×0.15`; gain `0.55 + 0.45·(lfo+1)/2`. Drive `frequency` from a `ConstantSourceNode` and the two LFO oscillators through gains, or from a `setValueCurveAtTime` recomputed every 2 s. |
| **Fire crackle** | Roar: `noise(brown) → LPF(900, −3) × random AM` (steps every 80 ms, U(.8, 1.2), smoothed τ 40 ms). Crackles: a 9.1-s loop at Poisson 5/s, each `white → BPF(U(1.5, 6) kHz, Q 2) × env(0.3 ms, U(.3, 1)², τ U(1, 6) ms)`, ×3. Hiss: `noise(white) → HPF(2000, −3) × U^4` steps every 120 ms, ×0.05. The ^4 follows Farnell's "rare loud bursts". |
| **Flowing water** | `noise(pink) → BPF(1095 Hz, Q 0.78)`. Its −3 dB band is about 600–2000 Hz, as §25.4 specifies. AM `0.8 + 0.12·sin(2π·0.3t) + 0.08·sin(2π·0.47t + 2)`. Bubbles: an 8.3-s loop at Poisson 25/s of `sine f0 → 1.5·f0 /25 ms exp` (f0 = U(500, 1500)), `env(1 ms, U(.1, .5), τ 8 ms)`, ×0.5. |
| **Cave drips** | 3 fixed "drip spots" with periods 1.9, 2.7 and 3.4 s (±8% jitter per drip) at pitches 1450, 1870 and 2310 Hz (inside §25.4's 1.2–2.4 kHz). Each drip is a rising "plink" `sine f → 1.6f /20 ms exp`, `env(0.5 ms, U(.6, 1), τ 25 ms)`, dry ×0.5, wet ×0.7 into a **3.5 s generated-IR `ConvolverNode`** (§4.4). Real caves have a few steady drippers rather than uniform random drops. |
| **Night insects** | 4 crickets, each an `OscillatorNode` sine at 4500, 4800, 4200 or 5100 Hz, times a looping **AM envelope buffer** fed into `gain.gain`. A chirp is 3 pulses 34 ms apart, each `env(A 2, H 12, R 6 ms)`. Chirp periods are 0.70, 0.61, 0.83 and 0.97 s; gains 1, .7, .8 and .5; pans −0.5, +0.3, −0.1 and +0.6. Farnell's field-cricket model uses a 4.5 kHz band, 17 ms pulses and a 0.7 s repeat (1.43 Hz). |
| **Murmur** (new, finding 8) | 4 "voices", each `noise(pink) → [BPF(450 + 150v, 1.2) + BPF(1400 + 200v, 2) ×.5]` times a syllabic envelope: random steps every 120–260 ms (≈4–5 Hz, the speech modulation peak), 25% near-silent, smoothed through LPF 8 Hz. Sum, then LPF 2.5 kHz so it stays unintelligible. |

### 3.3 Normalisation (measured, 12 s renders, BS.1770 integrated with gating)

| Layer | Raw LUFS | normGain (level 1 → −24 LUFS) | Peak at level 1 |
|---|---|---|---|
| rain | −16.7 | 0.434 | 0.48 |
| wind | −26.7 | 1.37 | 0.31 |
| fire | −16.2 | 0.41 | 0.57 |
| water | −22.0 | 0.796 | 0.32 |
| drips (with reverb) | −22.4 | 0.833 | 0.49 |
| insects | −8.0 | 0.158 | 0.44 |
| murmur | −21.9 | 0.788 | 0.33 |

### 3.4 Presets (level per slider; gain = normGain · level²)

| Preset | rain | wind | fire | water | drips | insects | murmur | ≈ Sum (pre-channel) |
|---|---|---|---|---|---|---|---|---|
| **Crypt** | 0 | 0.6 | 0 | 0 | 0.8 | 0 | 0 | −26.7 LUFS |
| **Forest night** | 0 | 0.5 | 0 | 0.4 | 0 | 0.8 | 0 | −27.2 |
| **Storm** | 0.9 | 0.8 | 0 | 0 | 0 | 0 | 0 | −23.7 |
| **Tavern hearth** | 0 | 0.3 | 0.8 | 0 | 0 | 0 | 0.7 | −25.9 |
| **Cave** | 0 | 0.4 | 0 | 0.5 | 0.9 | 0 | 0 | −25.3 |

For Crypt, set the wind centre one octave lower: fc × 0.5, so 62–495 Hz, a draught under a door. The Storm preset may
fire **distant thunder** every 20–60 s: the §2.5 recipe without the crack, through LPF 400 Hz at −12 dB. The DM's mix is
broadcast. For random ambience events like that to be heard at the same moment by everyone, derive them from the same
counter-based PRNG as music (§4.2): `hash(ambienceSeed, layer, floor(serverTime / 1 s))`. Otherwise one player hears
thunder that the others don't.

---

## 4. Generative music (SPEC §25.5)

### 4.1 Architecture

```
voices ─► presetBus(A|B) ─┬─────────────────────────────► musicLimiter ─► Music channel gain ─► master
                          └─► reverb send ─► Convolver(IR per preset) ─┘
musicLimiter = DynamicsCompressor(threshold −6 dB, knee 0, ratio 20, attack 0.002, release 0.15)   // spec: 6 ms look-ahead pre-delay
```

- **Two buses (A and B) for crossfades.** Preset↔preset and preset↔track crossfades use equal-power curves over 2 s:
  `setValueCurveAtTime` with cos and sin over 64 points. Keep the outgoing scheduler alive until its fade ends.
- **Target loudness per preset: −20 LUFS integrated at the bus.** The per-layer peaks below are **estimates, not
  measured**. Calibrate each preset in `/dev/sounds` with a 60 s offline render and the §6.7 meter.
- **Performance tier Low:** halve the reverb IR length. Partitioned convolution of a 4.5 s stereo IR is fine on desktops,
  but its CPU cost on low-end phones was **not verified**.

### 4.2 Determinism: identical notes on every client

- **Inputs:** `{ preset, seed (uint32 from the server, crypto.randomInt), startedAtServerMs }`.
- **Counter-based hashing, not a stream.** Every random decision is a pure function of its coordinates:

```ts
const lowbias32 = (x: number) => { x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15;
                                   x = Math.imul(x, 0x846ca68b); x ^= x >>> 16; return x >>> 0; };  // Wellons 2018
const hash32 = (...k: number[]) => k.reduce((h, v) => lowbias32(((h ^ (v >>> 0)) + 0x9e3779b9) >>> 0), 0x243f6a88);
const rngFor = (...k: number[]) => mulberry32u(hash32(...k)); // uint32-returning mulberry32 (see the note after §4.4's code)
// e.g. rngFor(seed, PRESET_ID, LAYER_ID, barIndex) → a small stream for that bar only
```

- **Integer-only decisions.** Use `r() % n` and `r() % 100 < pct`. **Never** use `Math.random`, `Math.sin`,
  `Math.pow`, `Math.exp` or `Math.log` in a decision. IEEE `+ − × ÷` and `Math.imul` are exactly reproducible across
  engines. Transcendental functions are not guaranteed to be. Frequencies may use `2 ** (n/12)`, because an ulp
  difference is inaudible. Add an ESLint `no-restricted-properties` rule for `packages/web/src/audio/music/gen/**`.
- **Random access.** `gen(preset, seed, layer, bar)` must not depend on having generated earlier bars. Where a rule needs
  history (no repeated progression, a Markov chord walk), limit it to a bounded look-back: one phrase, or iteration from
  the start of the section.
- **Verified with a reference sketch of the Tavern generator** (scratchpad):
  - Generating 480 bars (10 min) forward and in reverse gives byte-identical event lists.
  - 480/480 bars are distinct, and 0 of the 473 8-bar windows repeat.
  - It costs about 0.8 µs per bar in Node 22.

### 4.3 Timeline, look-ahead scheduler, late join and resume

**Clock mapping.** Use `ctx.getOutputTimestamp()` (Chrome 57, Firefox 70, Safari 14.1, per MDN BCD 8.1.3). It pairs the
audio frame being heard now (`contextTime`) with its `performance.now()` time (`performanceTime`). That accounts for
output latency, including Bluetooth when the UA reports it, which `currentTime` does not.

```ts
function tick() {                                        // every 25 ms from a Worker clock (below)
  const ts = ctx.getOutputTimestamp();
  if (!ts.performanceTime) return fallbackTick();        // not rendering yet: use currentTime + baseLatency + outputLatency
  const serverNowHeard = ts.performanceTime + clockOffsetMs;        // §13.8 offset (slewed, see below)
  const tauNow = (serverNowHeard - state.startedAtServerMs) / 1000; // musical seconds audible right now
  const toCtx = (tau: number) => ts.contextTime + (tau - tauNow);   // audio-clock time at which τ is heard
  const horizon = tauNow + (document.hidden ? 1.2 : 0.1);          // SPEC look-ahead 100 ms; longer when hidden
  for (const L of layers) while (L.nextBar * L.barSec < horizon) {
    for (const e of gen(preset, seed, L.id, L.nextBar)) {
      const tau = L.nextBar * L.barSec + e.t * L.barSec + e.jitterMs / 1000;
      if (tau >= L.scheduledUntil) schedule(e, Math.max(toCtx(tau), ctx.currentTime));
    }
    L.scheduledUntil = (++L.nextBar) * L.barSec;
  }
}
```

- **Worker clock.** Tone.js defaults to a Web Worker ticker (`clockSource: "worker"`, `lookAhead: 0.1`), because
  main-thread timers stall. Use a **bundled** worker (`new Worker(new URL('./clock.worker.ts', import.meta.url))`), not a
  blob. CSP allows both, but a bundled file keeps `blob:` optional.
- **Background tabs.** Chrome exempts pages that "made noise in the past 30 seconds" from intensive throttling (Chrome 88
  article). Worker timers are not covered by that article. The 1.2 s hidden-tab horizon keeps playback gapless even at
  1 Hz timer rates. On pause or stop, fade the bus over 50–300 ms and `stop()` every scheduled source (keep them in a set).
- **Clock-offset updates** (a re-sync every 60 s, §13.8): **slew, don't jump**. Move the working offset toward the
  measured one by at most 2 ms per second. That is a 0.2% tempo wobble and inaudible. Never reschedule notes already
  queued.
- **Late joiners and resume.**
  1. For each layer, start `nextBar = floor((tauNow − lookback)/barSec)`, where `lookback` is the longest event duration
     in the preset (drone pads 30 s, bells 8 s, otherwise 4 s).
  2. Events that started before `tauNow`:
     - **Sustained voices** (pads, drones, bell tails): start them now and set every envelope to its analytic value at
       the elapsed time, `P·(t−t0)/A` in the attack or `P·e^{−(t−t0−A)/τ}` in the decay, then continue the remaining
       automation.
     - **Buffer voices** (KS plucks, drums): `source.start(now, elapsed)` if elapsed < 50 ms, otherwise skip.
  3. The 2 s bus fade-in masks the join.
- **LFOs that must match across clients.** Compute them from τ. Either use `setValueCurveAtTime` chunks per 4 s slot, or
  start the LFO as an `OscillatorNode` with `PeriodicWave(real=[0, sin φ], imag=[0, cos φ], {disableNormalization: true})`,
  where `φ = 2π·f_LFO·τ_start`. That gives `sin(2πft + φ)`.
- **Pause.** The server shifts `startedAtServerMs` by the paused duration, so τ resumes where it stopped. Because the
  generator is pure, nothing else is needed.

### 4.4 Generated-impulse reverb

Build it deterministically in JS at startup. No `OfflineAudioContext` is needed.

```ts
function genIR(ctx: BaseAudioContext, rt60: number, seed: number, preDelay = 0.015, fStart = 9000, fEnd = 1800, er = 6) {
  const sr = ctx.sampleRate, len = Math.round((rt60 + preDelay) * sr), buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {                     // independent noise per channel → wide, decorrelated tail
    const d = buf.getChannelData(c), r = mulberry32(seed * 7919 + c * 104729), p0 = Math.round(preDelay * sr);
    let lp = 0;
    for (let i = p0; i < len; i++) {
      const t = (i - p0) / sr, fc = fStart * (fEnd / fStart) ** Math.min(1, t / rt60);   // HF decays faster (damping)
      lp += (1 - Math.exp(-2 * Math.PI * fc / sr)) * ((r() / 2 ** 31 - 1) - lp);          // one-pole LP on white noise
      d[i] = lp * Math.exp(-6.907755 * t / rt60);                                          // −60 dB at rt60
    }
    for (let j = 0; j < er; j++) d[p0 + Math.round((0.005 + (r() / 2 ** 32) * 0.055) * sr)] += (0.6 - 0.4 * j / er) * (r() & 1 ? 1 : -1);
  }
  return buf; // ConvolverNode { normalize: true }, buffer = genIR(...)
}
```

All generator code in §4 uses the **uint32-returning** mulberry32 variant: it ends `return (t ^ (t >>> 14)) >>> 0`
without the final `/ 4294967296`. That makes `r() % n` exact for integer decisions. Divide by 2³² when a float is needed,
as in the `/2**31 − 1` and `/2**32` above. If §18.4's dice code keeps the float variant, give the two functions
different names so they are not confused.

**Buffer length must equal about RT60.** The spec's normalisation divides by the RMS over the whole buffer, so the wet
energy grows with buffer length whatever the decay. Measured wet energy relative to dry, with normalize = true:

| RT60 | Wet vs dry |
|---|---|
| 1.1 s | −11.5 dB |
| 1.8 s | −9.4 dB |
| 3.5 s | −6.5 dB |
| 4.5 s | −5.4 dB |

Set the sends with that in mind.

| Use | RT60 | Character |
|---|---|---|
| SFX reverb (effects and UI sends) | 1.8 s | stone hall |
| Dungeon drone | 4.5 s | crypt |
| Tavern | 1.1 s | wooden room |
| Battle | 1.8 s | hall |
| Wonder | 3.5 s | cathedral |
| Cave drips (ambience) | 3.5 s | cave |

### 4.5 Karplus–Strong (Tavern plucks and bass)

This follows Karplus & Strong 1983 and Jaffe & Smith 1983, as summarised in J. O. Smith's *Physical Audio Signal
Processing*. Render **offline in JS** into an `AudioBuffer` per (MIDI note, velocity bucket) and cache it (finding 6).

```ts
function ksPluck(sr: number, f0: number, { t60 = 1.2, bright = 0.5, pick = 0.13, seed = 1 } = {}) {
  const P = sr / f0;                           // loop delay in samples
  const N = Math.floor(P - 0.5 - 1e-6);        // integer line; the 2-point average adds 0.5 sample
  const d = P - 0.5 - N;                       // fractional remainder in (0, 1]
  const C = (1 - d) / (1 + d);                 // Jaffe–Smith first-order allpass tuning coefficient
  const rho = 0.001 ** (1 / (f0 * t60));       // per-period loss so the fundamental falls 60 dB in t60
  // excitation: seeded white noise → one-pole LP (bright ∈ (0,1]; lower = darker/softer pluck)
  //             → pick-position comb x[n] − x[n − round(pick·N)] → remove DC → fill the N-sample line
  // loop per sample: out = line[i]; avg = 0.5·(line[i] + prev); ap = C·avg + x1 − C·y1; line[i] = rho·ap; i = (i+1) % N
  // render t60 + 50 ms, normalise the peak to 1, store; play via AudioBufferSourceNode → gain(vel) → pan → presetBus
}
```

Verified in Node at 48 kHz, estimating pitch by autocorrelation:

| Note | Measured | Error |
|---|---|---|
| G2 | 98.00 Hz | 0.0 c |
| G3 | 196.00 Hz | 0.0 c |
| D4 | 293.69 Hz | +0.2 c |
| B4 | 493.88 Hz | 0.0 c |
| E5 | 659.27 Hz | 0.0 c |
| G5 | 783.98 Hz | 0.0 c |

Parameters:

- Pluck: `bright` 0.55, `pick` 0.13, `t60 = 1.4 · (196/f)^0.4` s (1.4 s at G3, ≈0.8 s at E5).
- Bass: `bright` 0.25, `t60` 1.8 s.
- Cost: a 1.2 s note is 58 k samples. The whole Tavern pitch set (about 16 notes × 3 velocity buckets) is about 11 MB of
  Float32. Render lazily on first use, or use 2 velocity buckets.

### 4.6 Preset: Dungeon drone — D Aeolian, free time

- **Pitch set:** D E F G A B♭ C.
- **Grid:** "slot" = 4 s; "section" = 12 slots (48 s).

**Harmony.** Triads on i (Dm), iv (Gm), v (Am), VI (B♭) and VII (C).

- Each chord lasts {4, 5, 6} slots (16–24 s), chosen by `hash(seed, H, section, k)`.
- The next chord follows a Markov walk:

| From → | i | iv | v | VI | VII |
|---|---|---|---|---|---|
| i | 35 | 20 | 10 | 25 | 10 |
| iv | 50 | — | 25 | 25 | — |
| v | 60 | — | — | 40 | — |
| VI | 40 | 30 | — | — | 30 |
| VII | 50 | — | — | 50 | — |

- Every section **starts on i** (sections 0 mod 3) or on a hashed pick of {i, VI, iv}. The walk iterates only inside the
  section (at most 12 steps), which keeps it random-access.
- The last chord is truncated at the boundary.

**Layers.** The level column is an estimate.

| Layer | Synthesis | Level |
|---|---|---|
| Pad A (low) | Chord in root position: root oct 2, fifth oct 2, root oct 3 (Dm = D2 73.42, A2 110, D3 146.83). Each note is 2 saws at −7 and +7 cents → `LPF(cut_A(τ), 4 dB)`, where `cut_A = 280·2^(1.7·(0.5 + 0.5·sin(2πτ/47 s)))` (280–910 Hz). Envelope per chord: linear 6 s attack starting 3 s before the chord, 6 s release starting 3 s before it ends (a centred crossfade). | 6 saws × 0.05, about −20 dBFS peak |
| Pad B (upper) | Third, fifth and octave in oct 3–4 (F3, A3, D4), saws ±5 c → `LPF(600–2600 Hz, sin period 61 s, phase offset hash(seed) mod 360°)`. Same envelope. | × 0.03, about −26 dBFS |
| Sub pulse | Per section: first pulse at `hash % 4` s, then gaps from {6, 7, 8, 9, 10} s. Pulses are **only placed in [0, 42) s of each section**, which guarantees a gap of at least 6 s across section boundaries without any look-back. Voice: `sine root` (in 55–82 Hz) `→ env(30 ms, 1, τ 1.1 s) + exc(4, 180)×1.2 + noise(brown) → LPF(150) → env(5 ms, .6, τ 150 ms)`. | about −18 dBFS |
| Distant bell | 70% chance per section at offset U(4, 40) s. Pitch is the chord root or fifth in oct 4. Additive bell with partials relative to the nominal f (Hibbert: hum 2 octaves below the nominal, prime 1 octave below, tierce a minor third above the prime, quint a fifth above the prime): 0.25f (g .5, τ 3.5 s), 0.5f (.6, 3 s), 0.5946f (.45, 2.2 s), 0.7492f (.25, 1.8 s), 1.0f (1, 2 s), plus upper partials 1.5f (.3, 0.8 s) and 2.0f (.2, 0.6 s). The upper ratios are typical values, **not verified**. Attack 2 ms → LPF 2500 Hz (distance) → dry 0.4, reverb send 0.6. | about −24 dBFS |

**Why it doesn't loop.** The filter LFOs use prime periods (47 s and 61 s), so the combined sweep repeats only after
47 min. On top of that, chords are Markov-walked per section and pulses and bells are hashed per section. **Reverb:**
RT60 4.5 s; send 0.35 for the pads.

### 4.7 Preset: Tavern — G major pentatonic, 96 BPM, 6/8

- **Tempo.** The dotted quarter is 96 BPM, so an eighth is 0.20833 s and a bar is 1.25 s. That is a moderate jig.
- **Harmony.** 4-bar phrases, one chord per bar, with roots from G major:
  - P1 `I–IV–I–V`
  - P2 `I–vi–IV–V`
  - P3 `vi–IV–I–V`
  - P4 `I–V–vi–IV`
  - P5 `IV–I–V–I`

  The progression for each phrase is `hash(seed, H, phrase) % 5`. If it equals the previous phrase's pick, use the next
  hashed alternative. That is a one-phrase look-back.
- **Pentatonic arpeggio "ladders"** (the pluck plays only G A B D E): I = G B D, IV = E G A (sounds C6/9 over the bass),
  V = D A B, vi = E G B. Stack each set across G3–E5 into a 7–8 note ladder.

| Layer | Pattern | Synthesis |
|---|---|---|
| **Arpeggio** (KS pluck) | 6 eighths per bar using ladder-index patterns `[0,1,2,3,2,1]`, `[0,2,1,3,2,4]`, `[0,1,2,1,3,2]`, `[0,2,4,3,1,2]`, `[2,1,0,1,2,3]`. Choose with `(bar + hash(seed, A, floor(bar/5))) % 5`, which gives a **5-bar cycle** with a hashed rotation per cycle. Rest 15% per eighth; grace note one step above, a sixteenth early, 10%; velocity 60–89 → gain (vel/127)²·0.9. | KS, bright .55, pick .13; peak about −14 dBFS; reverb send .18 |
| **Melody** (KS, an octave up, brighter at .7) | **7-bar cycle**: fragments only in bars 0–3 of each cycle. Each eighth plays with 55% probability. Pitch = the pentatonic degree nearest `chord + hash % 5`, and the fragment's last note is held (let ring). | peak about −16 dBFS; send .2 |
| **Hand drum** (frame drum) | 6/8 patterns `x.gs.g`, `xggs.g` and `x.gsgg` in a **3-bar cycle**; fill `xgssgs` on the last bar of every 8. Humanise with `hash % 17 − 8` ms and velocity. | **x** (low): `sine 105→78 Hz /50 ms exp → env(1 ms, 1, τ 160 ms)` + modes 167 Hz (1.593×, τ 90 ms, .45) and 224 Hz (2.135×, τ 60 ms, .3) + `noise(white)→LPF 1000→env(τ 20 ms, .5)` + `exc(4, 200)×1.2`. **s** (slap): `noise(white)→BPF(1800, 1.2)→env(.5 ms, .8, τ 35 ms)` + `sine 220 → env(τ 50 ms, .3)`. **g** (ghost): `noise(white)→BPF(2500, 2)→env(τ 15 ms, .35)`. Peak about −14 dBFS; send .08 |
| **Bass** (KS dark) | Chord root on eighth 0 (G2 98, C3 130.8, D3 146.8, E2 82.4); fifth on eighth 3 with 70% probability. | bright .25, t60 1.8 s; peak about −14 dBFS; dry only |

**Why it doesn't loop.**

- The cycles (harmony 4, arpeggio 5, melody 7, drum 3, fill 8) have LCM 840 bars = 17.5 min.
- The progression choice is hashed per phrase with no immediate repeat.
- Rests, graces and humanisation are hashed per bar.
- The reference sketch found no repeated 8-bar window in 10 min.

**Reverb:** RT60 1.1 s.

### 4.8 Preset: Battle — E Phrygian, 110 BPM, 4/4

- **Tempo.** A 16th is 0.13636 s and a bar is 2.1818 s.
- **Scale degrees** (0 = E): semitones `[0, 1, 3, 5, 7, 8, 10]`. The ♭2 (F) carries the tension.
- **Harmony.** 2 bars per chord, 8-bar phrases:
  - P1 `i–♭II–i–♭VII` (E, F, E, D)
  - P2 `i–♭VI–♭VII–i` (E, C, D, E)
  - P3 `i–iv–♭II–i` (E, Am, F, E)
  - P4 `♭VI–♭VII–i–i`

  Choose them hashed per phrase with no immediate repeat.

| Layer | Pattern | Synthesis |
|---|---|---|
| **Ostinato** (filtered square) | 16 steps per bar. Cells use scale degrees relative to the chord root (7 = octave; transpose diatonically): C1 `0 0 7 0 · 0 0 1 0 · 0 0 7 0 · 0 1 0 2`; C2 `0 7 0 0 · 1 0 0 7 · 0 0 2 0 · 1 0 0 −1`; C3 `0 0 1 0 · 0 0 2 1 · 0 0 1 0 · 4 3 2 1`. Cell = `C[(bar + hash(seed, O, phrase)) % 3]`, a **3-bar cycle**. Per step: 8% rest, 10% neighbour-degree substitution. Accents on steps 0, 3, 6, 8, 11 and 14 (3-3-2 groupings) take velocity 1.0; the rest 0.65. Register E2–E3. | `sq f → LPF(Q 6 dB)`. The cutoff envelope per note is `2400 → 450 Hz /90 ms exp`, times a slow factor `1 + 0.3·sin(2πτ/(17 bars))`. Amplitude `env(2 ms, 0.12·vel, τ 110 ms)`; stop at 150 ms. Peak about −14 dBFS; send .15 |
| **Low toms** | 16-step patterns: A `L..L..M.L..L..MM`, B `L...M.L.L..M..L.`, C `L.M.L.M.L..LM.L.`, in a **7-bar sequence** `A B A A C B A`. Fill `L.M.LM.MLLMMLMLM` on the last bar of each phrase. Add a big hit (the §2.6 initiative drum at ×0.7) on bar 0 of each phrase. 10% hashed ghost notes (M at 0.3). | Low: `sine 92→62 Hz /70 ms exp → env(1 ms, 1, τ 200 ms)` + modes ×1.593 (τ 100 ms, .4) and ×2.135 (τ 70 ms, .25) + `noise(white)→LPF 1200→env(τ 20 ms, .5)` + `exc(4, 200)×1.3`. Mid: the same × 1.45. Peak about −12 dBFS; send .25 |
| **String swell** | Every 8 bars, starting at bar 4 of each phrase so it crests into the phrase turn. Chord of that bar: root oct 3, plus root, third and fifth in oct 4–5. The inversion rotates each swell (3-swell cycle). | Each note is 3 saws at −9, 0 and +9 c → `LPF(1800 → 2600 Hz over the attack, −3 dB)`. `env(A 2.2 s linear, H 2.2 s, R 2.5 s)`. Vibrato 5 Hz ±6 c on `detune`, faded in after 0.8 s. 0.03 per saw; peak about −18 dBFS; send .35 |

**Why it doesn't loop.** The cycles (8 / 3 / 7) have LCM 168 bars = 6.1 min, and the progression is hashed per phrase
with no repeat, plus the per-step substitutions. **Reverb:** RT60 1.8 s.

### 4.9 Preset: Wonder — A Lydian, 72 BPM, 4/4

- **Tempo.** A beat is 0.8333 s and a bar is 3.333 s.
- **Scale:** A B C♯ D♯ E F♯ G♯. The ♯4 (D♯) is the Lydian colour, heard most in the major **II** chord (B D♯ F♯).
- **Harmony.** 2 bars per chord, 8-bar phrases:
  - `I–II–I–II`
  - `I–II–vi–iii`
  - `I–iii–II–I`
  - `vi–II–I–V`

  Choose them hashed per phrase with no immediate repeat.

| Layer | Pattern | Synthesis |
|---|---|---|
| **Airy pad** (sine stack) | Per chord: root oct 3, fifth oct 3, third oct 4, root oct 4. On I, add D♯5 (♯11) at 0.3. | Each note: sines f, 2f (.35) and 3f (.12), duplicated at ±4 c; 0.04 per sine. `env` attack 2.5 s, release 3 s, centred crossfade. Slow amplitude sway `1 + 0.1·sin(2πτ/(5 bars))`. Peak about −20 dBFS; send .3 |
| **Glassy bell motifs** | **7-bar cycle**: bars 1, 3, 4 and 6 of each cycle carry a motif with 80% probability (hashed). Pool (degrees, 0 = A): `[4,5,6]`, `[2,3,4,6]`, `[0,1,2,4]`, `[6,4,3,1]`, `[3,4,6,7]`. Rhythm on eighths from `[0,1,2]`, `[0,2,3,4]` or `[0,1,3,4,6]`. Place the motif in A5–E7 so its first note is a chord tone. | FM (Chowning): carrier f, modulator 3.5·f, index `I(t) = 4·amp(t)` (the index follows the amplitude, so the spectrum simplifies as it decays, as in Chowning's bell). Amplitude `env(3 ms, 1, τ 1.2 s)`. The 1:3.5 "glass" ratio is a design choice, **not a verified reference value**. Chowning's own bell is c:m 1:1.4 with I = 10 over 15 s. Echo: a `DelayNode` of 0.625 s (a dotted eighth) with 0.35 feedback through LPF 4 kHz. Peak about −18 dBFS; send .5 |
| **High shimmer** | Continuous, plus "twinkles" at 20% per eighth (hashed), panned with `hash % 121 − 60` → ±0.6. | `noise(white) → BPF(8000, 2) × (0.5 + 0.5·sin(2πτ/(11 bars))) × 0.02`. Twinkle: `sine U(3, 6) kHz (hashed) → env(1 ms, .15, τ 60 ms)`. About −30 dBFS; send .6 |

**Why it doesn't loop.** The cycles (8 / 7 / 11) have LCM 616 bars = 34 min, with hashed motif and phrase choices on
top. **Reverb:** RT60 3.5 s.

### 4.10 Tests that prove AC-AUD-06

1. **Purity.** For each preset, generating bars 0…N forward and in reverse order gives identical events (as done for
   Tavern).
2. **No audible loops.** Over 10 min, no repeated 8-bar window of events, and at least 95% distinct bars. The Tavern
   sketch scored 480/480 distinct bars and 0 repeated windows.
3. **Sync.** Two Playwright pages with different injected clock offsets and output latencies must compute the same
   **server time** for each event, to within 5 ms. Assert on the scheduler log in test builds (§23.7).
4. **Crossfade.** Preset→track and track→preset crossfades keep the bus loudness within ±2 LU, which requires the track
   normalisation in §6.3.

---

## 5. CC0 music packs a DM could import (none bundled)

For each entry below I opened the page and found the licence field or text. The FMA album pages read "The songs in this
album are licensed under: CC0 1.0 Universal. Please check individual tracks for their respective licensing info," so
the DM should still glance at each track page. I spot-checked one track.

| # | Pack | Author | URL | Licence confirmation | Suits |
|---|---|---|---|---|---|
| 1 | **Music Jingles** (85 files) | Kenney | <https://kenney.nl/assets/music-jingles> | The same page states "Creative Commons CC0" | Stingers: victory, discovery, level-up moments |
| 2 | **Medieval series** (17 items: The Old Tower Inn, King's Feast, Market Day, Minstrel Dance, Battle, Exploration, Victory Theme, Defeat Theme, Harvest Season, Rejoicing, The Bard's Tale, plus chiptune versions and "Fantasy: Lament for a Warrior's Soul" and "Rising Moon") | RandomMind | Collection: <https://opengameart.org/content/cc0-audio-uploader-randommind> | The "License(s)" field reads **CC0** on each item page I checked: medieval-battle, -exploration, -market-day, -victory-theme, -harvest-season, -minstrel-dance, -rejoicing, -defeat-theme, -the-old-tower-inn, -kings-feast. The lament and rising-moon items were **not individually checked**. | Tavern, town, travel, feasts, battle and outcome stingers |
| 3 | **Town Theme RPG** and **Battle Theme A** | cynicmusic | <https://opengameart.org/content/town-theme-rpg>, <https://opengameart.org/content/battle-theme-a> | "License(s): CC0" on both pages | Peaceful village (harp and recorders); orchestral combat |
| 4 | **Dungeon Ambience** | yd | <https://opengameart.org/content/dungeon-ambience> | "License(s): CC0" | Dark dungeon exploration |
| 5 | **Forgotten tomb ambience** (page spelling "Forgoten") | kindland | <https://opengameart.org/content/forgoten-tomb-ambience> | "License(s): CC0" | Crypts and tombs; the author recommends a low level |
| 6 | **Cave Theme** | Brandon75689 (submitted by HaelDB) | <https://opengameart.org/content/cave-theme> | Dual licensed **OGA-BY 3.0 and CC0**. CC0 may be chosen. | Caves, eerie underground |
| 7 | **Tale on the Late** (16 tracks) and **It's time for adventure !** (14 tracks) | Komiku | <https://freemusicarchive.org/music/Komiku/Tale_on_the_Late>, <https://freemusicarchive.org/music/Komiku/Its_time_for_adventure_> | Album pages: "CC0 1.0 Universal". Track "Village, 2018" links `publicdomain/zero/1.0` | Light-hearted travel and adventure; villages |
| 8 | **WITCHY BATTY SPOOKY HALLOWEEN IN SEPTEMBER** (13 tracks) | Loyalty Freak Music | <https://freemusicarchive.org/music/Loyalty_Freak_Music/WITCHY_BATTY_SPOOKY_HALLOWEEN_IN_SEPTEMBER_> | Album page: CC0 link (`publicdomain/zero`) | Comedic or spooky one-shots, haunted houses |
| 9 | **Lullabies For The End Of The World** (5 tracks) | HoliznaCC0 | <https://freemusicarchive.org/music/holiznacc0/lullabies-for-the-end-of-the-world> | Album page: CC0 link (`publicdomain/zero`) | Melancholy, aftermath, quiet sorrow |

Excluded after checking:

- **FreePD.com.** It now shows only a closure notice (2008–2025).
- **"Fantasy Music and Drum Loops Pack"** (NorthFantasyMusic, OpenGameArt). It is **CC-BY 4.0**, not CC0, although a
  search summary claimed otherwise.

The importer should store the licence URL in the asset's metadata and show it in About & Credits. Files must be
MP3, OGG, WAV, M4A or FLAC and at most 50 MB (§8.16).

---

## 6. Mixing and loudness

### 6.1 Graph

```
event ─► [pan ─► distance] ─► channel gain (Dice | Effects | UI) ─┬──────────────► masterGain
                                                                   └─► sfxReverbSend ─► Convolver(1.8 s) ─► masterGain
music buses ─► musicLimiter ─► Music gain ─► masterGain;   ambience layers ─► Ambience gain ─► masterGain
masterGain ─► masterComp ─► trim (measured) ─► limiter ─► destination
```

Reverb sends are taken **post-channel-fader**, so muting a channel also mutes its reverb input. A tail up to 1.8 s may
ring out.

**Slider law** (applies to the settings popover): `gain = s === 0 ? 0 : 10^(−48·(1 − s)/20)`. That gives s = 0.9375 →
−3 dB, 0.875 → −6 dB, 0.75 → −12 dB, 0.5 → −24 dB. A linear slider feels dead in its top half.

| Channel | Default | Slider |
|---|---|---|
| Master | −3 dB | 0.94 |
| Dice | 0 dB | 1.0 |
| Effects | 0 dB | 1.0 |
| UI | −3 dB | 0.94 |
| Music | −6 dB | 0.875 |
| Ambience | −6 dB | 0.875 |

### 6.2 Master compressor

| Stage | Settings |
|---|---|
| `masterComp` | threshold **−10 dB**, knee **6 dB**, ratio **3**, attack **0.005 s**, release **0.25 s** (spec defaults are −24 / 30 / 12 / 0.003 / 0.25) |
| `trim` | GainNode = 1 / measured make-up (≈ −4 dB) |
| `limiter` | DynamicsCompressor threshold −1.5 dB, knee 0, ratio 20, attack 0.001, release 0.1 |

- **Make-up gain.** The spec adds `(1/curve(1.0))^0.6`. With a hard-knee approximation, `curve(0 dBFS) = −10 + 10/3 =
  −6.7 dB`, so the make-up is ≈ +4.0 dB. The knee shape is UA-defined, so **measure** it once at startup: render a
  −30 dBFS 1 kHz sine for 0.5 s through an identical compressor in an `OfflineAudioContext`, and set
  `trim = input RMS / output RMS`. Everything below threshold then passes at unity, and the level plan holds.
- **Limiter.** It is a safety stage against overlapping hero sounds. The spec's internal 6 ms pre-delay acts as
  look-ahead. The target is ASWG-R001's maximum true peak of −1 dBTP. The two stages add about 12 ms of latency, which
  is acceptable for SFX.

### 6.3 Loudness plan

Output = pre-channel level + default channel gain + master −3 dB.

| Class | Pre-channel | Output (defaults) |
|---|---|---|
| Hero effects (nat 20, fire, thunder, down, initiative) | LUFS-M −18 … −20; peak −6 … −7.5 | −21 … −23 LUFS-M; peak ≤ −9 dBFS |
| Standard effects (spells, hits, heal, doors) | −22 … −27 | −25 … −30 |
| Dice clack (max) | peak −10 dBFS | peak −13 dBFS |
| UI notifications (your turn, knock, admitted, death saves) | −24 … −28 | −30 … −34 |
| UI ticks (turn pass, settle, condition, emote, error, hand) | peaks −16 … −23 | peaks −22 … −29 dBFS |
| Music (preset or normalised track) | −20 LUFS integrated | ≈ −29 LUFS |
| Ambience preset | −24 … −27 | ≈ −33 … −36 |

- **Result:** effects sit on top; music and UI notifications form the middle band; ambience is the bed; ticks sit at the
  floor. For context, ASWG-R001 v1.10 (p. 6) recommends −24 ±2 LKFS for home consoles and −18 ±2 for portable
  devices, measured over at least 30 min of play. This plan puts busy combat in the mid −20s LUFS. That is an estimate
  from the per-class numbers above, **not an end-to-end measurement**. Measure a 30-min session in the Phase 11 E2E
  run.
- **Uploaded tracks.** When the DM uploads, decode once in the DM's browser (`decodeAudioData`), compute BS.1770
  integrated loudness, store `loudnessLufs` in the asset metadata, and play at `gain = 10^((−20 − L)/20)`, capped at
  +6 dB. Multiply that by the DM's per-track volume.

### 6.4 Per-play variation

- **Default:** `rate = 1 + 0.04·(2u − 1)` (±4%, ±68 cents) on `AudioBufferSourceNode.playbackRate`. For WA graphs,
  multiply every oscillator and filter frequency by the same factor. Duration changes by 1/rate, which is fine.
  `u = Math.random()`; SFX variation does not need to match across clients.
- **Exceptions:**
  - Condition blips: ±1% (pitch carries the category).
  - Your turn: ±1.5% (a learned identity).
  - Multi-layer musical recipes (nat 20, heal, cold): one factor per event.
  - Footsteps: ±8% plus alternating feet (§2.3).
  - Music: none.
- **Gain variation** of ±1 dB on dice, footsteps and tokens.
- Never play the same pre-rendered variant twice in a row (cold's three variants).

### 6.5 Stereo pan and distance

- **Pan:** `pan = clamp(0.8·(2·sx/W − 1), −0.8, 0.8)`. `sx` is the source's projected screen x in CSS px, `W` is the
  viewport width, and off-screen sources clamp to ±0.8. `StereoPannerNode` is equal-power per the spec. Update pan at
  each footstep for moving tokens.
- **Distance:** `g = 1/(1 + d/60)`, where d is the horizontal distance in feet from the camera orbit target to the
  source.

| d (ft) | g | dB |
|---|---|---|
| 0 | 1 | 0 |
| 30 | 0.67 | −3.5 |
| 60 | 0.5 | −6.0 |
| 120 | 0.33 | −9.5 |
| 300 | 0.17 | −15.6 |

Apply it as a `GainNode` rather than `PannerNode`. The Web Audio "inverse" model clamps distances below `refDistance`, so
it is not the same curve.
- UI sounds and HUD dice are **not** distance-attenuated. Dice are panned by the die's position in the HUD tray.

### 6.6 Voice management and ducking

| Channel | Voice cap | Priority |
|---|---|---|
| Dice | 16 | steal the quietest |
| Effects | 12 | hero sounds preempt standard ones |
| UI | 6 | — |

Per-sound rate limits:

- Footsteps: 8/s total.
- Clacks: 25 ms per die.
- Emote: 1.5 s (as the FUN rate limit).
- Ping: 250 ms per sender.

**Ducking.** "Your turn" and "Knock" duck the Music bus by −4 dB: `setTargetAtTime(0.63, t, 0.05)`, hold 1.2 s, then
`setTargetAtTime(1, t+1.2, 0.3)`. This follows Brewster's point that attention should come from the cue's novelty and
clarity, not from its own loudness.

### 6.7 Runtime calibration (in `/dev/sounds`)

For each recipe, render once in an `OfflineAudioContext` at the device rate. Measure the sample peak and the BS.1770
momentary loudness (48 kHz K-weighting coefficients:
stage 1 `b = [1.53512486, −2.69169619, 1.19839281]`, `a = [1, −1.69065929, 0.73248077]`;
stage 2 `b = [1, −2, 1]`, `a = [1, −1.99004745, 0.99007225]`). Store `outGain = targetPeak / measuredPeak` per recipe.
This removes the ±1.5 dB mock-versus-browser uncertainty and the noise-segment variance, and it is also the evidence
table for the visual critic.

---

## 7. What could not be verified

- **Browser rendering.** All levels come from a mock of the spec's formulas with naive oscillators, not from Chrome,
  Firefox or Safari. Web Audio oscillators are band-limited, so saw and square peaks can differ by about 1 dB.
  Section 6.7 closes this gap.
- **Rapier accessor names.** The docs page shows the flags, the thresholds and both drain calls, but not
  `totalForceMagnitude()` or `maxForceMagnitude()`. Confirm them in spike S3.
- **FMA per-track licences.** The album pages say to check individual tracks. I checked one track (Komiku, "Village,
  2018"), not all of them. Two RandomMind items ("Lament for a Warrior's Soul", "Rising Moon") were not individually
  opened.
- **Worker timer throttling in hidden tabs.** Chrome's article covers only main-thread timers. The 1.2 s hidden-tab
  horizon is a mitigation, not a measured guarantee.
- **Compressor knee.** It is UA-defined, so the ≈ +4 dB make-up is an approximation. Measure it (§6.2).
- **Low-end phone CPU** for 3.5–4.5 s convolution plus about 40 music voices: not measured.
- **Farnell's book** was not read directly. I used its table of contents (aspress.co.uk) and the Wikibooks
  SuperCollider ports of the Fire, Rain, Creaking door and Insects chapters. The contents of the Thunder and Wind
  chapters were not consulted.
- **Other references.**
  - The FM "glass" ratio 1:3.5 and the bell's upper partials (1.5f, 2f) are design choices, not sourced values.
  - I did not re-check the page numbers for Karplus & Strong 1983 and Jaffe & Smith 1983 (standard citations below).
  - The *Juice it or lose it* talk was not watched. Only its existence and topic were confirmed.
  - The Material Design sound guidelines are rendered by JavaScript, and their text could not be retrieved, so they are
    not relied on.

---

## 8. Sources

| Ref | Source | Used for |
|---|---|---|
| ZzFX npm | `zzfx@1.3.2` tarball <https://registry.npmjs.org/zzfx/-/zzfx-1.3.2.tgz>: `ZzFX.js` lines 46–258, `ZzFXMicro.js`, `index.html` lines 255–282 (parameter help), `package.json`, `README.md` | §1 |
| ZzFX git | KilledByAPixel/ZzFX commits `c41a2f9` (= 1.3.2), `136ef32`, `a209de1` (master drift): <https://github.com/KilledByAPixel/ZzFX/commits/master/ZzFX.js> | §1.1 |
| Web Audio | W3C Web Audio API 1.1, <https://www.w3.org/TR/webaudio-1.1/>: DelayNode `delayTime` (cycle clamp), DynamicsCompressorNode attributes, processing and make-up gain, BiquadFilterNode `Q`, ConvolverNode `calculateNormalizationScale`, BaseAudioContext `getOutputTimestamp`/`outputLatency`, StereoPannerNode (equal-power), render quantum 128 | §0, §2.0, §4, §6 |
| MDN BCD | `@mdn/browser-compat-data` 8.1.3 (`api.AudioContext.outputLatency`, `getOutputTimestamp`, `baseLatency`) | §4.3 |
| Wilson | Chris Wilson, "A Tale of Two Clocks", <https://web.dev/articles/audio-scheduling> (25 ms interval, 100 ms look-ahead) | §4.3 |
| Tone.js | `Tone/core/clock/Ticker.ts`, `Tone/core/context/Context.ts` (worker clock, `lookAhead: 0.1`), <https://github.com/Tonejs/Tone.js>; Reverb docs <https://tonejs.github.io/docs/15.1.22/classes/Reverb.html> (decaying-noise IR) | §4.3, §4.4 |
| Chrome timers | <https://developer.chrome.com/blog/timer-throttling-in-chrome-88> (audio-playing pages get minimal throttling) | §4.3 |
| Chrome autoplay | <https://developer.chrome.com/blog/autoplay> (AudioContext suspended before a gesture) | §0 |
| Farnell | Andy Farnell, *Designing Sound*, MIT Press (practicals list: <https://aspress.co.uk/ds/table_of_contents.html>); Wikibooks "Designing Sound in SuperCollider": /Fire, /Rain, /Creaking_door, /Insects, <https://en.wikibooks.org/wiki/Designing_Sound_in_SuperCollider> | §2, §3 |
| FoleyAutomatic | K. van den Doel, P. Kry, D. Pai, "FoleyAutomatic: Physically-based Sound Effects for Interactive Simulation and Animation", SIGGRAPH 2001, pp. 537–544, <https://dl.acm.org/doi/10.1145/383259.383322> | §2.1 |
| Brewster | S. Brewster, P. Wright, A. Edwards, "Experimentally Derived Guidelines for the Creation of Earcons", BCS HCI'95 adjunct proceedings pp. 155–159, <https://www.dcs.gla.ac.uk/~stephen/papers/HCI95.pdf> (pp. 1–3 of the PDF) | §2 |
| Juice | M. Jonasson and P. Purho, "Juice it or lose it", <https://www.youtube.com/watch?v=Fy0aCDmgnxg> | §2.0 |
| Dixon | M. Dixon et al., "The Impact of Sound in Modern Multiline Video Slot Machine Play", J. Gambling Studies (2014), <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4225056/> | §2.1 |
| Jacobsen | B. Jacobsen, "How to maintain immersion (+ reduce repetition & listening fatigue) in game audio", A Sound Effect, <https://www.asoundeffect.com/game-audio-immersion/> | §2 |
| Zúmer | J. Zúmer, "An Introduction to Game Audio" (2017), <https://javierzumer.com/blog/2017/8/9/an-introduction-to-game-audio> | §2 |
| Fliniaux | V. Fliniaux interview, A Sound Effect (13 Nov 2019), <https://www.asoundeffect.com/magic-sound-effects-library/> | §2.5 |
| Chowning | J. Chowning, "The Synthesis of Complex Audio Spectra by Means of Frequency Modulation", JAES 21(7) 1973, <https://ccrma.stanford.edu/sites/default/files/user/jc/fm_synthesis_paper.pdf> (bell: c 200, m 280, I 10, 15 s; drum: 0.2 s, I 2) | §2.4, §4.9 |
| Russell (membrane) | D. A. Russell, "Vibrational Modes of a Circular Membrane", <https://www.acs.psu.edu/drussell/demos/membranecircle/circle.html> (1, 1.593, 2.135, 2.295, 2.917, 3.598) | §2.6, §4.7, §4.8 |
| Russell (bar) | D. A. Russell, "Flexural vibrations of a bar", <https://www.acs.psu.edu/drussell/Demos/Flexural-Bar/flexural.html> (free–free Al bar 233 / 644 / 1266 Hz → 2.76×). The theoretical 2.7565 = (7.8532/4.7300)² comes from the free–free beam eigenvalues. | §2 |
| Hibbert | W. Hibbert, "Basic principles of bell tuning", <https://www.hibberts.co.uk/basic-principles-of-bell-tuning/> (hum −2400 c, prime −1200 c, tierce −900 c, quint −500 c relative to nominal) | §4.6 |
| Catford | J. C. Catford, *A Practical Introduction to Phonetics*, 2nd ed., OUP 2001, p. 154, via <https://en.wikipedia.org/wiki/Formant> (/ɑ/ F1 750, F2 940 Hz) | §2.5 |
| KS | J. O. Smith, *Physical Audio Signal Processing*, "Karplus-Strong Algorithm", <https://ccrma.stanford.edu/~jos/pasp/Karplus_Strong_Algorithm.html>; K. Karplus and A. Strong, "Digital Synthesis of Plucked-String and Drum Timbres", Computer Music Journal 7(2), 1983; D. Jaffe and J. O. Smith, "Extensions of the Karplus-Strong Plucked-String Algorithm", CMJ 7(2), 1983 | §4.5 |
| Parviainen | T. Parviainen, "JavaScript Systems Music" (28 Jul 2016), <https://teropa.info/blog/2016/07/28/javascript-systems-music.html> (Eno *Music for Airports* loops of 17.7–22.1 s, "incommensurable") | §4 |
| Noisehack | Z. Denton, "How to Generate Noise with the Web Audio API", <https://noisehack.com/generate-noise-web-audio-api/> | §3.1 |
| Ding | N. Ding, A. Patel et al., "Temporal modulations in speech and music", Neurosci. Biobehav. Rev. 81 (2017) 181–187, <https://pubmed.ncbi.nlm.nih.gov/28212857/> (speech ≈5 Hz, music ≈2 Hz) | §3.2 |
| ASWG | Sony ASWG-R001 v1.10 (Aug 2013), p. 6, <http://gameaudiopodcast.com/ASWG-R001.pdf> | §6.3 |
| Wellons | C. Wellons, "Prospecting for Hash Functions" (2018), <https://nullprogram.com/blog/2018/07/31/> (`lowbias32`) | §4.2 |
| Rapier | "Advanced collision-detection" (JS), <https://rapier.rs/docs/user_guides/javascript/advanced_collision_detection_js/> | §2.1 |
| Packs | Pages listed in §5 (accessed 2026-09-27); FreePD closure <https://freepd.com/> | §5 |
| R3 | `docs/research/stack.md` §2.12 and deviation 45 (same zzfx findings, reached independently) | §0, §1.5 |
