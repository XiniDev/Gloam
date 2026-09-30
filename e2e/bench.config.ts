import { defineConfig, devices } from "@playwright/test";

/** The GPU flags for headed Chromium on the host: its own GPU through ANGLE, frames not capped to the display. */
function gpuArgs(): string[] {
  const angle = process.platform === "win32" ? "d3d11" : process.platform === "darwin" ? "metal" : "vulkan";
  return [
    `--use-angle=${angle}`,
    "--ignore-gpu-blocklist",
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
  ];
}

/**
 * The client benchmarks (SPEC §37; AC-PERF-01/04/05, AC-RSP-05): headed Chromium on the host's GPU — headless WebGL
 * is software-rendered and measures the CPU's rasteriser, not the board. One test at a time (they measure the
 * machine). Run by `pnpm bench` (tools/bench-client.mjs), which builds the test bundle first.
 */
export default defineConfig({
  testDir: "./bench",
  outputDir: "../artifacts/bench/results",
  timeout: 600_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    headless: false,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: gpuArgs() },
  },
  projects: [{ name: "gpu", use: { browserName: "chromium" } }],
});
