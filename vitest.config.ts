import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "packages/shared",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "server",
          root: "packages/server",
          include: ["src/**/*.test.ts"],
          environment: "node",
          pool: "forks",
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Wraps WebSocket before any test imports the Colyseus SDK (network inspection, AC-SCN-03/TOK-08).
          setupFiles: ["src/test/ws-recorder.ts"],
        },
      },
      {
        test: {
          name: "content",
          root: "packages/content",
          include: ["scripts/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "mcp",
          root: "packages/mcp",
          include: ["src/**/*.test.ts"],
          environment: "node",
          pool: "forks",
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "web",
          root: "packages/web",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "tools",
          root: "tools",
          include: ["**/*.test.mjs"],
          environment: "node",
        },
      },
    ],
  },
});
