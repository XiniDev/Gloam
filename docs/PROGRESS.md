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

## 2026-09-27 — Phase 0 complete; P1 server done

- Research R1–R5 done (docs/research/*.md). R1 corrections and R5 protocol traps logged in DECISIONS.md;
  R3's 52 deviations applied where they touch built code (CORS reflection off, Express bypass on /matchmake
  guarded in onAuth + beforeUpgrade, `authSessionId`, no @colyseus/tools, FK-off migrations, helmet config…).
- Spikes S1–S6 all passed; findings in docs/research/stack.md § "Spike findings (builder)"; spike code deleted.
- SRD 5.2.1 pack built by `pnpm content:build` (R2): 339 spells 27/57/57/42/34/38/31/20/17/16, conditions,
  light sources, MANIFEST, ATTRIBUTION; reproducible; 15 content tests. Server loads and asserts it at startup.
- P1 server: auth/lobby/table rooms, command bus + history + undo, snapshots/backups, tunnel manager, all with
  integration tests (host/auth/persistence/security suites). Found and fixed: Colyseus ignores instance-level
  onAuth (moved to static, campaign id from matchmaking URL); fog undo keys broke on ":" in layer names;
  Windows data-dir ACL only applied to new folders.
- Next: P1 web screens (setup, admin Table/Settings, join, waiting room, closed, table shell) + Playwright
  E2E for the UI halves of HOST-02/03/04/05/06/09 and AUTH-02/03; PER-03 needs scene activation (P2).

```
PASSING 20/224 · DISPUTED 0 · FAILING 204
```
