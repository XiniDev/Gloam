import type { Page } from "@playwright/test";

/**
 * A desktop browser's autoplay policy for Web Audio, which headless Chromium doesn't apply (every AudioContext runs
 * there, whatever `--autoplay-policy` says): a context made before the page's first user activation is held
 * suspended, and `resume()` does nothing until the page has had one — sticky activation, as Chrome decides it, from
 * a real (trusted) press, key or touch. (`navigator.userActivation` can't be the judge here: Playwright evaluates
 * its scripts as if from a gesture.) What the app does about it — the enable-sound chip, unlocking on the first
 * gesture (AC-AUD-04) — is then what's tested.
 */
export async function withAutoplayPolicy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Real = window.AudioContext;
    // (A browser without Web Audio — Playwright's WebKit on Windows — has nothing to hold.)
    if (!Real) return;
    let activated = false;
    const contexts = new Set<AudioContext>();
    for (const type of ["pointerdown", "pointerup", "keydown", "touchend", "click"])
      window.addEventListener(
        type,
        (e) => {
          if (e.isTrusted) activated = true;
        },
        { capture: true },
      );
    class Gated extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.add(this);
        // Held suspended, however it starts (a context autostarts a moment after it's made).
        const hold = () => {
          if (!activated && this.state === "running") void Real.prototype.suspend.call(this);
        };
        this.addEventListener("statechange", hold);
        hold();
      }
      override resume(): Promise<void> {
        if (!activated) return new Promise<void>(() => {});
        return Real.prototype.resume.call(this);
      }
    }
    window.AudioContext = Gated;
  });
}
