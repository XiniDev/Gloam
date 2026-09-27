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

## 2026-09-27 — paused by Xini (resume notes)

- Committed: bfac96f (P0 complete, P1 server). Uncommitted WIP: P1 web screens (setup, admin Table/Settings,
  join, waiting room, closed, table shell, audio engine, UI kit), e2e harness (e2e/fixtures, journeys p1-*),
  P2 server start (engine/plan.ts, engine/commands/scene.ts, shared/protocol/commands.ts — not yet registered).
- P1 E2E run: HOST-02 and HOST-06 journeys pass. Failures found:
  1. HOST-03 test selector: URL text also appears in a toast → use getByRole("link").
  2. Join flow: the code auto-submits on the 10th character (onComplete) AND the test clicks "Knock on the
     door"; the button is gone by then, so the click times out. Fix knockAsNew (don't click after auto-submit)
     and debounce the double submit in Join.tsx.
- Next on resume: fix the above, rerun `node tools/e2e.mjs`, mark HOST-02/03/04/05/06/09 + AUTH-02/03 with
  evidence, run `pnpm check`, commit P1 web, then continue P2 (scene/token commands, projector + views, asset
  pipeline, R3F board).

## 2026-09-27 — P1 complete (web + E2E); P2 started

- P1 web: setup, Admin Table/Settings, join (code → identity), waiting room, closed screen, table shell, audio
  engine (ZzFX + Web Audio graph), UI kit. Playwright harness (spawned server per test, fake cloudflared, software
  GL, real autoplay policy) with 9 journeys for HOST-02/03/04/05/06/09 and AUTH-01/02/03/04 — all pass.
- The stricter guard and in-page latency measurement found and fixed real problems: a 2.3 s main-thread stall per
  screen change on software GL (shader backdrops moved to an OffscreenCanvas worker), a 1.4 s startup stall
  (noise texture now a static asset), a CSP eval violation on every page (zod jitless), double `room.leave()`,
  a mis-placed candle flame, and a serial admit path (the table now connects during the dissolve).
  Measured: identity → waiting room 132 ms; admit → table 513 ms.
- P1 is 27/28: AC-PER-03 needs scene activation (P2) for its "snapshot on activation" clause.
- P2 groundwork (compiles, not yet registered): scene and token command definitions, plan helpers,
  shared protocol schemas for them.
- Next: register scene/token commands; state projector + per-client views; prep view; asset pipeline; R3F board.

```
PASSING 28/224 · DISPUTED 0 · FAILING 196
```

## 2026-09-27 — P2 in progress: server done, board + HUD being built

- Committed: P2 server core (scenes, tokens, state projector, per-client views, prep view) and the asset pipeline
  (uploads, processor child, serving, library). 35/224 passing (P1 28/28; AST-01/02/03/04/05/07; PER-03).
- Board (uncommitted, renders cleanly under software GL): table environment, image/GLB/procedural maps, camera
  rig (presets, Spotlight, memory), performance tiers + governor, post-FX, tokens (model/standee/coin/auto,
  bases, overlays, HP ghost bar, selection, hidden badge).
- HUD (uncommitted, typechecks): left toolbar, dock (Party, DM: Scenes / Library / Approvals), new-scene wizard
  with calibration, radial menu, Quick Unit, settings popover (volumes, graphics pin, UI size, motion, colour-blind,
  DM camera opt-out), prep banner, scene travel transition (old scene held while fading to black), parchment
  loading bar, first-load intro with staggered HUD, Library → board drag and drop, Pan tool.
- Dev server: `pnpm dev` now runs on 4747 for live watching. It watches only server/shared sources; `--watch`
  on the whole import graph restart-looped because Vite writes temporary modules. Tests keep to random ports.
- Next: 3D map alignment + Generate walls (SCN-04), DM walls overlay, then P2 E2E journeys and marking ACs.
