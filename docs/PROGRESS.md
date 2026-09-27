# Progress log

Append after every work block: what was done, what's next, blockers, and the output of
`pnpm features:status`.

## 2026-09-27 — Phase 0 started

- Read docs/SPEC.md in full.
- Environment: host has Node 22.18.0 (not 24); pnpm 12.6.0 via corepack (needed a cache fix, see
  DECISIONS); no cloudflared installed; Windows 11, 16 logical CPUs. Portable Node 24.21.0 downloaded to
  `%LOCALAPPDATA%\gloam-tools` for cross-version verification (not on PATH, system untouched).
- All §9 package versions exist on npm exactly as pinned (react-router: 7.18.4, the latest 7.x).
- Scaffolded the monorepo, installed dependencies (454 packages). Native modules (better-sqlite3 N-API
  prebuilds, sharp, argon2) load on Node 22 and 24 with `allowBuilds` as in §9.4.
- `tools/extract-features.mjs` → docs/FEATURES.json: 224 acceptance criteria.
