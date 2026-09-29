/**
 * Test hooks (SPEC §23.7): present ONLY in `vite build --mode test` builds (the `__GLOAM_TEST__` constant folds
 * to false in production, so this module's side effects are removed; a build-output grep checks it).
 */
export interface SoundLogEntry {
  name: string;
  played: boolean;
  at: number;
  /** The extra gain it played at (dice: v^1.5 from the contact's impulse). */
  gain?: number;
  /** A board sound's stereo pan (−1…1, before the engine's ×0.8) and distance from the camera target (AC-AUD-05). */
  pan?: number;
  distanceFt?: number;
}

interface GloamTestApi {
  sounds: SoundLogEntry[];
  loadedAt: number;
  ready(): boolean;
  state(): unknown;
  [k: string]: unknown;
}

declare global {
  interface Window {
    __gloam?: GloamTestApi;
  }
}

const providers: Record<string, (...args: unknown[]) => unknown> = {};

export function installTestHooks(): void {
  if (!__GLOAM_TEST__) return;
  window.__gloam = {
    sounds: [],
    loadedAt: performance.now(),
    ready: () => document.readyState === "complete",
    state: () => providers.state?.(),
  };
}

/** Registers a named test accessor (e.g. the board's visible token ids in Phase 2). */
export function provideTestHook<A extends unknown[]>(name: string, fn: (...args: A) => unknown): void {
  if (!__GLOAM_TEST__ || !window.__gloam) return;
  providers[name] = fn as (...args: unknown[]) => unknown;
  window.__gloam[name] = fn;
}

export function logSound(
  name: string,
  played: boolean,
  opts: { gain?: number; pan?: number; distanceFt?: number } = {},
): void {
  if (!__GLOAM_TEST__) return;
  window.__gloam?.sounds.push({
    name,
    played,
    at: Date.now(),
    ...(opts.gain !== undefined ? { gain: opts.gain } : {}),
    ...(opts.pan !== undefined ? { pan: opts.pan } : {}),
    ...(opts.distanceFt !== undefined ? { distanceFt: opts.distanceFt } : {}),
  });
}
