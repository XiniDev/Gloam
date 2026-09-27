import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.ts";

/**
 * `pnpm shots` (SPEC §4 Screenshots): the key screens at 1440×900, 1024×768 and 390×844 into
 * artifacts/screens/<phase>/<viewport>/, for review by eye and by the visual-critic subagent. Same server, fixtures
 * and guards as the journeys (a CSP violation or console error still fails a run).
 */
export default defineConfig({
  ...base,
  testDir: "./shots",
  testMatch: /.*\.shots\.ts$/,
  outputDir: "../artifacts/shots/results",
  timeout: 1_500_000,
  workers: 1,
  // A step that can't find its control fails fast (and is noted) instead of waiting out the whole run.
  use: { ...base.use, actionTimeout: 20_000 },
  reporter: [["list"]],
  projects: [
    {
      name: "1440x900",
      use: { ...devices["Desktop Chrome"], browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "1024x768",
      use: { ...devices["Desktop Chrome"], browserName: "chromium", viewport: { width: 1024, height: 768 } },
    },
    {
      name: "390x844",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
