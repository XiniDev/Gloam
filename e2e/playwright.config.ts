import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end journeys (SPEC §36): each test spawns its own Gloam server (NODE_ENV=test, temp data dir, fake
 * cloudflared) serving the test-mode web build (packages/web/dist-test). Several browser contexts per test play
 * Admin/DM and players at once.
 */
export default defineConfig({
  testDir: "./journeys",
  outputDir: "../artifacts/e2e/results",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "../artifacts/e2e/report.json" }]],
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
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
