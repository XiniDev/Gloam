import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end journeys (SPEC §36): each test spawns its own Gloam server (NODE_ENV=test, temp data dir, fake
 * cloudflared) serving the test-mode web build (packages/web/dist-test). Several browser contexts per test play
 * Admin/DM and players at once.
 */
export default defineConfig({
  testDir: "./journeys",
  // One folder per part of the full run: each Playwright run empties its output folder, and the timing part would
  // otherwise delete the main part's failure traces and screenshots.
  outputDir: `../artifacts/e2e/results${process.env.E2E_PART ? `-${process.env.E2E_PART}` : ""}`,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // One at a time by default: two WebGL journeys side by side starve each other's GPU on a gaming PC with its own
  // programs open — a lost WebGL context, frame-timed checks missed by a second (the full run of 2026-10-01; each passed
  // alone). E2E_WORKERS raises it on a host with room to spare. No retries either way: a failure is a failure.
  workers: Number(process.env.E2E_WORKERS) > 0 ? Number(process.env.E2E_WORKERS) : 1,
  retries: 0,
  reporter: [
    ["list"],
    [
      "json",
      { outputFile: `../artifacts/e2e/report${process.env.E2E_PART ? `-${process.env.E2E_PART}` : ""}.json` },
    ],
  ],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      // Software GL (as on machines without GPU acceleration) and the real autoplay policy: audio unlocks only
      // after a user gesture, exactly as for players.
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  projects: [
    { name: "chromium", grepInvert: /@timing/, use: { browserName: "chromium" } },
    // Latency and animation-timing journeys (≤ 1 s admissions, 400/600 ms camera tweens, 200 ms token crossfades,
    // 2 s scene travel, 500 ms light and fog changes, 200 ms door → vision) run one at a time: software GL shares one
    // CPU, and a neighbour decoding a 16 384² map would be measured instead.
    // `pnpm test:e2e` runs this project after the main one (tools/e2e.mjs).
    { name: "timing", grep: /@timing/, workers: 1, use: { browserName: "chromium" } },
  ],
});
