# Decisions and deviations

One line per decision: date · decision · reason · alternatives rejected.

- 2026-09-27 · Support Node `>=22.18` (engines) and verify on Node 24.21 LTS as well; `.nvmrc` stays `24` · The host PC has Node 22.18.0, which already runs TypeScript natively (type stripping unflagged since 22.18.0); the spec's `>=24.11` would make `pnpm install` warn on the machine that actually runs the table. Tests run on both 22.18 (host) and a portable 24.21 (spec target). `@types/node@22` keeps the type checker honest about APIs that don't exist on 22 · Rejected: upgrading the host's system Node in place (changes the machine outside the repo); `>=24.11` (false claim of incompatibility).
- 2026-09-27 · pnpm 12.6.0 under corepack: Node 22.18 bundles corepack 0.33, which leaves a broken cache for pnpm 12 (native-exe layout) and fails with `Cannot find module …pnpm.cjs`. Fix: run `npx corepack@latest pnpm --version` once (or `npm i -g corepack@latest`); Node 24.21 bundles corepack 0.36, which works. Documented in HOSTING.md · Rejected: downgrading to pnpm 11 (spec pins 12 and its `allowBuilds` config).
- 2026-09-27 · react-router pinned to 7.18.4 · Spec says "latest 7.x"; 8.4.0 is now latest, but 7.x is what the spec asks for.
- 2026-09-27 · `pnpm start`/`pnpm dev` pass `--production`/`--dev` to `packages/server/src/main.ts`, which sets `NODE_ENV` before importing the server · `NODE_ENV=production node …` in a package script doesn't work under cmd.exe on Windows; an entry file is cross-platform without adding `cross-env`.
- 2026-09-27 · Type-checking uses `tsc -b` with composite projects that emit declarations only into `node_modules/.cache/tsc` · TS build mode requires composite projects to emit; the cache dir is gitignored and nothing ships from it.
