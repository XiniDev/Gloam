import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Fonts are never inlined as data: URIs — the CSP's font-src is 'self' only (R3 deviation 40).
const assetsInlineLimit = (file: string): boolean | undefined =>
  /\.(woff2?|ttf|otf)$/.test(file) ? false : undefined;

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // `/static/…` for the app's hashed files; `/assets/…` is reserved for uploaded assets (SPEC §21.6).
  build: {
    assetsDir: "static",
    assetsInlineLimit,
    sourcemap: false,
    chunkSizeWarningLimit: 5000,
    target: "es2022",
  },
  worker: { format: "es" },
  optimizeDeps: { include: ["@dimforge/rapier3d-deterministic-compat"] },
  define: {
    __GLOAM_TEST__: JSON.stringify(mode === "test"),
  },
  server: { fs: { allow: ["../.."] } },
}));
